// @db-pool-intent: worker
//
// Task #3712 — AM communication sampler for coaching runs.
//
// Selects each account manager's recent Zoom transcripts and outbound Front
// emails from the clients they own, and — critically — verifies the AM was
// actually the person on the call / at the keyboard before anything can be
// pinned on them:
//
//   - Zoom: the AM's users.email must appear among the recording's
//     participantsJson emails. Calls where a DIFFERENT internal user is
//     identifiable are excluded outright (they are someone else's calls,
//     not "unattributed"); calls with no identifiable internal participant
//     become unattributed context.
//   - Email: the thread/message author participant (role "author" on
//     message-grain rows, "team" on thread-grain rows) must match the AM's
//     email. Authored-by-another-internal-user rows are excluded;
//     author-unknown rows become unattributed context.
//
// Volume is capped per AM (zoom/email/unattributed caps + per-item content
// truncation) so a coaching run stays bounded regardless of book size.
// Runs inside the orchestrator's runWithWorkerDb wrapper; tests call it
// directly against seeded public tables.
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { workerDb as db } from "../db";
import { clients, rawCommunicationRecords, users } from "@shared/schema";

export const AM_COACHING_WINDOW_DAYS = 60;
export const MAX_ZOOM_SAMPLES_PER_AM = 6;
export const MAX_EMAIL_SAMPLES_PER_AM = 10;
export const MAX_UNATTRIBUTED_SAMPLES_PER_AM = 4;
/** Below this many verifiably-theirs samples an AM gets "insufficient data". */
export const MIN_ATTRIBUTED_SAMPLES = 3;
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const MAX_EMAIL_CHARS = 4_000;
/** Zoom rows with less content than this have no usable transcript. */
const MIN_TRANSCRIPT_CHARS = 200;
const ZOOM_SCAN_LIMIT = 40;
const EMAIL_SCAN_LIMIT = 80;

export interface AmSample {
  recordId: string;
  clientId: string | null;
  clientName: string | null;
  sourceType: "zoom" | "front_email";
  title: string;
  timestamp: Date;
  /** True when the AM was verifiably on the call / authored the email. */
  attributed: boolean;
  /** e.g. "zoom_participant:jane@firm.com" / "email_author:jane@firm.com". */
  attributionBasis: string | null;
  /** Truncated transcript/body used for analysis. */
  content: string;
}

export interface AmSampleSet {
  amUserId: string;
  amName: string;
  amEmail: string;
  clientCount: number;
  /** Attributed samples first, then unattributed context. */
  samples: AmSample[];
  zoomAttributedCount: number;
  emailAttributedCount: number;
  unattributedCount: number;
  attributedCount: number;
}

export interface CoachedManager {
  id: string;
  email: string;
  name: string;
  clientIds: string[];
}

interface ParticipantShape {
  name?: unknown;
  email?: unknown;
  role?: unknown;
}

function normEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

function participantEmails(participantsJson: unknown): { email: string; role: string }[] {
  if (!Array.isArray(participantsJson)) return [];
  const out: { email: string; role: string }[] = [];
  for (const raw of participantsJson) {
    const p = raw as ParticipantShape;
    const email = normEmail(p?.email);
    if (!email) continue;
    out.push({ email, role: typeof p?.role === "string" ? p.role : "" });
  }
  return out;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/**
 * Every account manager who currently owns at least one active
 * (non-archived, non-demo) client, with their book's client ids.
 * Deleted users are excluded — nobody coaches a departed AM.
 */
export async function listCoachedManagers(): Promise<CoachedManager[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      clientId: clients.id,
    })
    .from(clients)
    .innerJoin(users, eq(users.id, clients.ownerId))
    .where(
      and(
        sql`COALESCE(${clients.isArchived}, false) = false`,
        sql`COALESCE(${clients.isDemo}, false) = false`,
        sql`${users.deletedAt} IS NULL`,
      ),
    );

  const byId = new Map<string, CoachedManager>();
  for (const row of rows) {
    const email = normEmail(row.email);
    if (!email) continue; // no email → attribution is impossible; skip entirely
    let entry = byId.get(row.id);
    if (!entry) {
      const name =
        [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || email;
      entry = { id: row.id, email, name, clientIds: [] };
      byId.set(row.id, entry);
    }
    entry.clientIds.push(row.clientId);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Lowercased emails of ALL internal users (incl. soft-deleted ex-staff). */
export async function listInternalEmails(): Promise<Set<string>> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(isNotNull(users.email));
  const out = new Set<string>();
  for (const row of rows) {
    const email = normEmail(row.email);
    if (email) out.add(email);
  }
  return out;
}

/**
 * Sample one AM's recent communications with attribution verification.
 * `internalEmails` is the full staff email set used to tell "someone else's
 * call/email" (excluded) apart from "nobody identifiable" (unattributed).
 */
export async function sampleAmCommunications(
  am: { id: string; email: string; name: string },
  clientIds: string[],
  internalEmails: Set<string>,
): Promise<AmSampleSet> {
  const amEmail = normEmail(am.email);
  const base: AmSampleSet = {
    amUserId: am.id,
    amName: am.name,
    amEmail: amEmail ?? am.email,
    clientCount: clientIds.length,
    samples: [],
    zoomAttributedCount: 0,
    emailAttributedCount: 0,
    unattributedCount: 0,
    attributedCount: 0,
  };
  if (!amEmail || clientIds.length === 0) return base;

  const cutoff = new Date(Date.now() - AM_COACHING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const selection = {
    id: rawCommunicationRecords.id,
    clientId: rawCommunicationRecords.clientId,
    sourceType: rawCommunicationRecords.sourceType,
    title: rawCommunicationRecords.title,
    timestamp: rawCommunicationRecords.timestamp,
    participantsJson: rawCommunicationRecords.participantsJson,
    contentText: rawCommunicationRecords.contentText,
    clientName: clients.firmName,
  };

  const zoomRows = await db
    .select(selection)
    .from(rawCommunicationRecords)
    .leftJoin(clients, eq(clients.id, rawCommunicationRecords.clientId))
    .where(
      and(
        inArray(rawCommunicationRecords.clientId, clientIds),
        eq(rawCommunicationRecords.sourceType, "zoom"),
        gte(rawCommunicationRecords.timestamp, cutoff),
        isNotNull(rawCommunicationRecords.contentText),
        sql`length(${rawCommunicationRecords.contentText}) >= ${MIN_TRANSCRIPT_CHARS}`,
      ),
    )
    .orderBy(desc(rawCommunicationRecords.timestamp))
    .limit(ZOOM_SCAN_LIMIT);

  const emailRows = await db
    .select(selection)
    .from(rawCommunicationRecords)
    .leftJoin(clients, eq(clients.id, rawCommunicationRecords.clientId))
    .where(
      and(
        inArray(rawCommunicationRecords.clientId, clientIds),
        eq(rawCommunicationRecords.sourceType, "front_email"),
        eq(rawCommunicationRecords.direction, "outbound"),
        gte(rawCommunicationRecords.timestamp, cutoff),
        isNotNull(rawCommunicationRecords.contentText),
        sql`length(${rawCommunicationRecords.contentText}) >= 40`,
      ),
    )
    .orderBy(desc(rawCommunicationRecords.timestamp))
    .limit(EMAIL_SCAN_LIMIT);

  const attributedZoom: AmSample[] = [];
  const attributedEmail: AmSample[] = [];
  const unattributed: AmSample[] = [];

  for (const row of zoomRows) {
    const participants = participantEmails(row.participantsJson);
    const amOnCall = participants.some((p) => p.email === amEmail);
    const otherInternalOnCall = participants.some(
      (p) => p.email !== amEmail && internalEmails.has(p.email),
    );
    const sample: AmSample = {
      recordId: row.id,
      clientId: row.clientId,
      clientName: row.clientName ?? null,
      sourceType: "zoom",
      title: row.title,
      timestamp: row.timestamp,
      attributed: amOnCall,
      attributionBasis: amOnCall ? `zoom_participant:${amEmail}` : null,
      content: truncate(row.contentText ?? "", MAX_TRANSCRIPT_CHARS),
    };
    if (amOnCall) {
      if (attributedZoom.length < MAX_ZOOM_SAMPLES_PER_AM) attributedZoom.push(sample);
    } else if (!otherInternalOnCall) {
      // No identifiable internal participant — usable as unattributed context.
      unattributed.push(sample);
    }
    // else: verifiably someone else's call — never in this AM's packet.
  }

  for (const row of emailRows) {
    const participants = participantEmails(row.participantsJson);
    // Message-grain rows carry role "author"; thread-grain outbound rows
    // carry role "team" for the authoring side.
    const author = participants.find((p) => p.role === "author" || p.role === "team");
    const amAuthored = !!author && author.email === amEmail;
    const otherInternalAuthored =
      !!author && author.email !== amEmail && internalEmails.has(author.email);
    const sample: AmSample = {
      recordId: row.id,
      clientId: row.clientId,
      clientName: row.clientName ?? null,
      sourceType: "front_email",
      title: row.title,
      timestamp: row.timestamp,
      attributed: amAuthored,
      attributionBasis: amAuthored ? `email_author:${amEmail}` : null,
      content: truncate(row.contentText ?? "", MAX_EMAIL_CHARS),
    };
    if (amAuthored) {
      if (attributedEmail.length < MAX_EMAIL_SAMPLES_PER_AM) attributedEmail.push(sample);
    } else if (!otherInternalAuthored) {
      unattributed.push(sample);
    }
    // else: authored by a different staff member — excluded.
  }

  unattributed.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const unattributedKept = unattributed.slice(0, MAX_UNATTRIBUTED_SAMPLES_PER_AM);

  const samples = [...attributedZoom, ...attributedEmail, ...unattributedKept];
  return {
    ...base,
    samples,
    zoomAttributedCount: attributedZoom.length,
    emailAttributedCount: attributedEmail.length,
    unattributedCount: unattributedKept.length,
    attributedCount: attributedZoom.length + attributedEmail.length,
  };
}
