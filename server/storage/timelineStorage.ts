// @db-pool-intent: ambient
//
// Task #4328 — read-only aggregation for the unified client activity
// timeline. All callers are request-scoped routes, so every getDb() here
// lands on the ambient api pool. See scripts/lint-db-pool-tenancy.ts for
// the contract.
//
// Design (Impact Review, Task #4328):
//   - Each activity type is read from its system of record, cursor-bounded
//     and LIMIT-capped, then merged in memory — never a cross-source SQL
//     UNION and never an unbounded scan:
//       email/slack/note/zoom-meeting-record → raw_communication_records
//         (twilio_* sourceTypes excluded there: SMS/calls come from their
//         own tables below, and raw records only mirror the inbound side)
//       sms     → twilio_messages ⋈ twilio_conversations (both directions)
//       call    → twilio_calls
//       meeting → scheduled_meetings (status ∉ creating/failed) plus the
//                 zoom rows from raw_communication_records
//       ticket  → sd_ticket_mapping ⋈ clickup_tasks mirror
//   - Keyset pagination on (timestamp, id) DESC. Postgres timestamps carry
//     microseconds but JS Dates only milliseconds, so each arm also selects
//     to_char(ts, 'YYYY-MM-DD HH24:MI:SS.US') as the cursor key: full
//     fidelity, lexicographic order == chronological order, and the arm
//     predicates compare (ts, id) < (cursor.ts::timestamp, cursor.id)
//     natively against the per-source indexes.
//   - Actor names resolve AFTER the merge is sliced to `limit`, so the
//     users lookup is bounded by page size, not by arm fan-out.

import { and, desc, eq, ilike, inArray, isNotNull, ne, notInArray, or, isNull, sql, type SQL } from "drizzle-orm";
import {
  clickupTasks,
  clients,
  communicationClientLinks,
  rawCommunicationRecords,
  scheduledMeetings,
  sdTicketMapping,
  twilioCalls,
  twilioConversations,
  twilioMessages,
  users,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

/** Closed set of activity types the timeline can render/filter. */
export const timelineEntryTypes = [
  "email",
  "sms",
  "call",
  "meeting",
  "ticket",
  "note",
  "slack",
] as const;
export type TimelineEntryType = (typeof timelineEntryTypes)[number];

/** Page-size rails: routes clamp into [1, TIMELINE_MAX_LIMIT]. */
export const TIMELINE_DEFAULT_LIMIT = 30;
export const TIMELINE_MAX_LIMIT = 100;

export interface TimelineEntry {
  /** Globally unique across sources: `${sourcePrefix}:${rowId}`. */
  id: string;
  type: TimelineEntryType;
  /** ISO-8601 (ms precision) — display timestamp. */
  timestamp: string;
  title: string;
  preview: string | null;
  direction: "inbound" | "outbound" | "internal" | null;
  /** Human label for who did/sent/owns it, when known. */
  actorLabel: string | null;
  /** Deep link to the source surface (app-relative unless hrefExternal). */
  href: string | null;
  hrefExternal: boolean;
  /** Small per-type extras (status, duration, subtype, …). */
  meta: Record<string, string | number | boolean | null>;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

/**
 * Decoded keyset cursor. `ts` is the to_char(…, 'YYYY-MM-DD HH24:MI:SS.US')
 * text; `cid` binds the cursor to the client it was minted for, so a cursor
 * replayed against another client is a deterministic 400 (ATS precedent).
 */
export interface TimelineCursor {
  ts: string;
  id: string;
  cid: string;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/**
 * Task #4418 — optional narrowing filters, applied as extra WHERE predicates
 * inside every arm (identically on every page, so keyset semantics hold).
 * `q` matches each arm's human-searchable text (title/preview equivalents)
 * via ILIKE; `after`/`before` bound the arm's display timestamp (inclusive).
 */
export interface TimelineFilters {
  q: string | null;
  /** Inclusive lower bound on the entry timestamp. */
  after: Date | null;
  /** Inclusive upper bound on the entry timestamp. */
  before: Date | null;
}

/** Longest accepted search term (routes 400 above this). */
export const TIMELINE_MAX_Q_LENGTH = 200;

const NO_FILTERS: TimelineFilters = { q: null, after: null, before: null };

/** ILIKE pattern for a raw user term: escape \ % _ then wrap in %…%. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Naive-UTC timestamp text (all timeline source columns store UTC). */
function utcNaive(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** Inclusive after/before predicates for one arm's timestamp column. */
function boundsPredicates(tsCol: unknown, f: TimelineFilters): SQL[] {
  const out: SQL[] = [];
  if (f.after) out.push(sql`${tsCol} >= ${utcNaive(f.after)}::timestamp`);
  if (f.before) out.push(sql`${tsCol} <= ${utcNaive(f.before)}::timestamp`);
  return out;
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null on any malformed input (routes turn that into a 400). */
export function decodeTimelineCursor(raw: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.ts !== "string" || typeof parsed.id !== "string" ||
      typeof parsed.cid !== "string" ||
      !CURSOR_TS_RE.test(parsed.ts) ||
      parsed.id.length === 0 || parsed.id.length > 200 ||
      parsed.cid.length === 0 || parsed.cid.length > 200
    ) {
      return null;
    }
    return { ts: parsed.ts, id: parsed.id, cid: parsed.cid };
  } catch {
    return null;
  }
}

/** Internal per-arm row: a rendered entry plus its exact-precision sort key. */
interface ArmRow {
  entry: Omit<TimelineEntry, "actorLabel">;
  cursorTs: string;
  rowId: string;
  /** users.id to resolve into actorLabel after slicing (if any). */
  actorUserId: string | null;
  /** Fallback label when there is no user id (e.g. SMS contact name). */
  actorFallback: string | null;
}

function cursorTsExpr(col: unknown): SQL<string> {
  return sql<string>`to_char(${col}, 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/** Keyset predicate `(ts, id) < (cursor.ts, cursor.id)` for one arm. */
function beforeCursor(tsCol: unknown, idCol: unknown, cursor: TimelineCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${tsCol}, ${idCol}) < (${cursor.ts}::timestamp, ${cursor.id})`;
}

function clip(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asDirection(value: string | null | undefined): TimelineEntry["direction"] {
  return value === "inbound" || value === "outbound" || value === "internal" ? value : null;
}

/** raw_communication_records sourceTypes serving each timeline type. */
const RAW_SOURCE_BY_TYPE: Partial<Record<TimelineEntryType, string>> = {
  email: "front_email",
  slack: "slack",
  note: "manual",
  meeting: "zoom",
};

function rawTypeFor(sourceType: string): TimelineEntryType {
  switch (sourceType) {
    case "front_email": return "email";
    case "slack": return "slack";
    case "manual": return "note";
    case "zoom": return "meeting";
    default: return "note"; // unreachable: arm filters to the four above
  }
}

// ── Per-source arms ─────────────────────────────────────────────────────────
// Every arm: WHERE client scope AND keyset predicate, ORDER BY (ts, id) DESC,
// LIMIT `limit`. All ride existing indexes except sd_ticket_mapping, which
// gains (client_uuid, created_at) in migration 20260810212827.

async function rawCommArm(
  clientId: string,
  wanted: Set<TimelineEntryType>,
  cursor: TimelineCursor | null,
  limit: number,
  filters: TimelineFilters,
): Promise<ArmRow[]> {
  return withDbAttribution("timeline:rawCommArm", async () => {
    const sourceTypes = timelineEntryTypes
      .filter((t) => wanted.has(t) && RAW_SOURCE_BY_TYPE[t])
      .map((t) => RAW_SOURCE_BY_TYPE[t] as string);
    if (sourceTypes.length === 0) return [];

    // Parity with the Comms tab (listRawCommunications): records linked to
    // this client through non-rejected communication_client_links rows count
    // as this client's records too; orphaned records stay hidden.
    const linked = await getDb()
      .select({ id: communicationClientLinks.rawCommunicationRecordId })
      .from(communicationClientLinks)
      .where(and(
        eq(communicationClientLinks.clientId, clientId),
        ne(communicationClientLinks.status, "rejected"),
      ));
    const linkedIds = linked.map((r) => r.id);

    const clientScope = linkedIds.length > 0
      ? or(
          eq(rawCommunicationRecords.clientId, clientId),
          inArray(rawCommunicationRecords.id, linkedIds),
        )
      : eq(rawCommunicationRecords.clientId, clientId);

    const rows = await getDb()
      .select({
        id: rawCommunicationRecords.id,
        sourceType: rawCommunicationRecords.sourceType,
        sourceSubtype: rawCommunicationRecords.sourceSubtype,
        title: rawCommunicationRecords.title,
        timestamp: rawCommunicationRecords.timestamp,
        direction: rawCommunicationRecords.direction,
        contentPreview: rawCommunicationRecords.contentPreview,
        externalUrl: rawCommunicationRecords.externalUrl,
        createdBy: rawCommunicationRecords.createdBy,
        cursorTs: cursorTsExpr(rawCommunicationRecords.timestamp),
      })
      .from(rawCommunicationRecords)
      .where(and(
        clientScope,
        inArray(rawCommunicationRecords.sourceType, sourceTypes),
        or(
          isNull(rawCommunicationRecords.matchStatus),
          ne(rawCommunicationRecords.matchStatus, "orphaned"),
        ),
        beforeCursor(rawCommunicationRecords.timestamp, rawCommunicationRecords.id, cursor),
        ...boundsPredicates(rawCommunicationRecords.timestamp, filters),
        ...(filters.q
          ? [or(
              ilike(rawCommunicationRecords.title, likePattern(filters.q)),
              ilike(rawCommunicationRecords.contentPreview, likePattern(filters.q)),
            )]
          : []),
      ))
      .orderBy(desc(rawCommunicationRecords.timestamp), desc(rawCommunicationRecords.id))
      .limit(limit);

    return rows.map((r) => ({
      entry: {
        id: `comm:${r.id}`,
        type: rawTypeFor(r.sourceType),
        timestamp: r.timestamp.toISOString(),
        title: r.title,
        preview: clip(r.contentPreview),
        direction: asDirection(r.direction),
        href: r.externalUrl || null,
        hrefExternal: Boolean(r.externalUrl),
        meta: {
          sourceType: r.sourceType,
          sourceSubtype: r.sourceSubtype ?? null,
        },
      },
      cursorTs: r.cursorTs,
      rowId: r.id,
      actorUserId: r.createdBy ?? null,
      actorFallback: null,
    }));
  });
}

async function smsArm(
  clientId: string,
  cursor: TimelineCursor | null,
  limit: number,
  filters: TimelineFilters,
): Promise<ArmRow[]> {
  return withDbAttribution("timeline:smsArm", async () => {
    const rows = await getDb()
      .select({
        id: twilioMessages.id,
        conversationId: twilioMessages.conversationId,
        direction: twilioMessages.direction,
        body: twilioMessages.body,
        status: twilioMessages.status,
        errorCode: twilioMessages.errorCode,
        sentByUserId: twilioMessages.sentByUserId,
        createdAt: twilioMessages.createdAt,
        contactName: twilioConversations.contactName,
        contactPhone: twilioConversations.contactPhone,
        cursorTs: cursorTsExpr(twilioMessages.createdAt),
      })
      .from(twilioMessages)
      .innerJoin(twilioConversations, eq(twilioMessages.conversationId, twilioConversations.id))
      .where(and(
        eq(twilioConversations.clientId, clientId),
        isNotNull(twilioMessages.createdAt),
        beforeCursor(twilioMessages.createdAt, twilioMessages.id, cursor),
        ...boundsPredicates(twilioMessages.createdAt, filters),
        // q matches the FULL rendered title ("SMS to/from <who>", mirroring
        // the JS derivation below) plus the body (preview).
        ...(filters.q
          ? [sql`(((CASE WHEN ${twilioMessages.direction} = 'outbound' THEN 'SMS to ' ELSE 'SMS from ' END)
              || COALESCE(NULLIF(${twilioConversations.contactName}, ''), NULLIF(${twilioConversations.contactPhone}, ''), 'contact'))
              ILIKE ${likePattern(filters.q)}
              OR ${twilioMessages.body} ILIKE ${likePattern(filters.q)})`]
          : []),
      ))
      .orderBy(desc(twilioMessages.createdAt), desc(twilioMessages.id))
      .limit(limit);

    return rows.map((r) => {
      const who = r.contactName || r.contactPhone || "contact";
      const outbound = r.direction === "outbound";
      return {
        entry: {
          id: `sms:${r.id}`,
          type: "sms" as const,
          timestamp: (r.createdAt as Date).toISOString(),
          title: outbound ? `SMS to ${who}` : `SMS from ${who}`,
          preview: clip(r.body),
          direction: asDirection(r.direction),
          // Task #4373: the Conversation Hub lives at /comms?view=clients
          // (legacy /conversations redirects there) — link the survivor.
          href: `/comms?view=clients&convId=${encodeURIComponent(r.conversationId)}`,
          hrefExternal: false,
          meta: { status: r.status, errorCode: r.errorCode ?? null },
        },
        cursorTs: r.cursorTs,
        rowId: r.id,
        actorUserId: outbound ? (r.sentByUserId ?? null) : null,
        actorFallback: outbound ? null : who,
      };
    });
  });
}

async function callArm(
  clientId: string,
  cursor: TimelineCursor | null,
  limit: number,
  filters: TimelineFilters,
): Promise<ArmRow[]> {
  return withDbAttribution("timeline:callArm", async () => {
    const rows = await getDb()
      .select({
        id: twilioCalls.id,
        direction: twilioCalls.direction,
        status: twilioCalls.status,
        duration: twilioCalls.duration,
        fromNumber: twilioCalls.fromNumber,
        toNumber: twilioCalls.toNumber,
        initiatedByUserId: twilioCalls.initiatedByUserId,
        routedToUserId: twilioCalls.routedToUserId,
        voicemailRecordingSid: twilioCalls.voicemailRecordingSid,
        voicemailTranscriptionText: twilioCalls.voicemailTranscriptionText,
        createdAt: twilioCalls.createdAt,
        cursorTs: cursorTsExpr(twilioCalls.createdAt),
      })
      .from(twilioCalls)
      .where(and(
        eq(twilioCalls.clientId, clientId),
        isNotNull(twilioCalls.createdAt),
        beforeCursor(twilioCalls.createdAt, twilioCalls.id, cursor),
        ...boundsPredicates(twilioCalls.createdAt, filters),
        // q matches the FULL rendered title ("Voicemail from …" / "Call
        // from/to <counterparty>", mirroring the JS derivation below) plus
        // the voicemail transcription (preview).
        ...(filters.q
          ? [sql`(((CASE WHEN COALESCE(${twilioCalls.voicemailRecordingSid}, '') <> '' THEN 'Voicemail from '
                    WHEN ${twilioCalls.direction} = 'inbound' THEN 'Call from ' ELSE 'Call to ' END)
              || COALESCE(CASE WHEN ${twilioCalls.direction} = 'inbound' THEN ${twilioCalls.fromNumber} ELSE ${twilioCalls.toNumber} END, ''))
              ILIKE ${likePattern(filters.q)}
              OR ${twilioCalls.voicemailTranscriptionText} ILIKE ${likePattern(filters.q)})`]
          : []),
      ))
      .orderBy(desc(twilioCalls.createdAt), desc(twilioCalls.id))
      .limit(limit);

    return rows.map((r) => {
      const inbound = r.direction === "inbound";
      const counterparty = inbound ? r.fromNumber : r.toNumber;
      const voicemail = Boolean(r.voicemailRecordingSid);
      return {
        entry: {
          id: `call:${r.id}`,
          type: "call" as const,
          timestamp: (r.createdAt as Date).toISOString(),
          title: voicemail
            ? `Voicemail from ${counterparty}`
            : inbound ? `Call from ${counterparty}` : `Call to ${counterparty}`,
          preview: clip(r.voicemailTranscriptionText),
          direction: asDirection(r.direction),
          href: `/comms?view=clients&phone=${encodeURIComponent(counterparty)}`,
          hrefExternal: false,
          meta: {
            status: r.status,
            durationSeconds: r.duration ?? null,
            voicemail,
          },
        },
        cursorTs: r.cursorTs,
        rowId: r.id,
        actorUserId: (inbound ? r.routedToUserId : r.initiatedByUserId) ?? null,
        actorFallback: inbound ? counterparty : null,
      };
    });
  });
}

async function meetingArm(
  clientId: string,
  cursor: TimelineCursor | null,
  limit: number,
  filters: TimelineFilters,
): Promise<ArmRow[]> {
  return withDbAttribution("timeline:meetingArm", async () => {
    const rows = await getDb()
      .select({
        id: scheduledMeetings.id,
        meetingTypeName: scheduledMeetings.meetingTypeName,
        bookingSource: scheduledMeetings.bookingSource,
        inviteeName: scheduledMeetings.inviteeName,
        startTimeUtc: scheduledMeetings.startTimeUtc,
        endTimeUtc: scheduledMeetings.endTimeUtc,
        status: scheduledMeetings.status,
        accountManagerUserId: scheduledMeetings.accountManagerUserId,
        cursorTs: cursorTsExpr(scheduledMeetings.startTimeUtc),
      })
      .from(scheduledMeetings)
      .where(and(
        eq(scheduledMeetings.clientId, clientId),
        // `creating` rows are transient booking scaffolding; `failed` never
        // became a meeting. Confirmed + canceled are real history.
        notInArray(scheduledMeetings.status, ["creating", "failed"]),
        beforeCursor(scheduledMeetings.startTimeUtc, scheduledMeetings.id, cursor),
        ...boundsPredicates(scheduledMeetings.startTimeUtc, filters),
        // q matches the FULL rendered title (type name or the "Meeting"
        // fallback) and preview ("With <invitee>"), mirroring the JS below.
        ...(filters.q
          ? [sql`(COALESCE(NULLIF(${scheduledMeetings.meetingTypeName}, ''), 'Meeting') ILIKE ${likePattern(filters.q)}
              OR ('With ' || ${scheduledMeetings.inviteeName}) ILIKE ${likePattern(filters.q)})`]
          : []),
      ))
      .orderBy(desc(scheduledMeetings.startTimeUtc), desc(scheduledMeetings.id))
      .limit(limit);

    return rows.map((r) => ({
      entry: {
        id: `meeting:${r.id}`,
        type: "meeting" as const,
        timestamp: r.startTimeUtc.toISOString(),
        title: r.meetingTypeName || "Meeting",
        preview: r.inviteeName ? `With ${r.inviteeName}` : null,
        direction: null,
        // The client Scheduling tab is the in-app management surface for
        // booked meetings (TAB_MAP alias added alongside this task).
        href: `/clients/${clientId}?tab=scheduling`,
        hrefExternal: false,
        meta: {
          status: r.status,
          bookingSource: r.bookingSource,
          endTimeUtc: r.endTimeUtc.toISOString(),
        },
      },
      cursorTs: r.cursorTs,
      rowId: r.id,
      actorUserId: r.accountManagerUserId ?? null,
      actorFallback: null,
    }));
  });
}

async function ticketArm(
  clientId: string,
  cursor: TimelineCursor | null,
  limit: number,
  filters: TimelineFilters,
): Promise<ArmRow[]> {
  return withDbAttribution("timeline:ticketArm", async () => {
    const rows = await getDb()
      .select({
        id: sdTicketMapping.id,
        clickupTaskId: sdTicketMapping.clickupTaskId,
        requesterUserId: sdTicketMapping.requesterUserId,
        createdAt: sdTicketMapping.createdAt,
        taskName: clickupTasks.name,
        taskStatus: clickupTasks.status,
        cursorTs: cursorTsExpr(sdTicketMapping.createdAt),
      })
      .from(sdTicketMapping)
      .leftJoin(clickupTasks, eq(sdTicketMapping.clickupTaskId, clickupTasks.id))
      .where(and(
        eq(sdTicketMapping.clientUuid, clientId),
        beforeCursor(sdTicketMapping.createdAt, sdTicketMapping.id, cursor),
        ...boundsPredicates(sdTicketMapping.createdAt, filters),
        // q matches the FULL rendered title — "Ticket: <name>" or the
        // "Service desk ticket" fallback when the left-joined mirror row is
        // missing/blank — mirroring the JS derivation below.
        ...(filters.q
          ? [sql`(CASE WHEN COALESCE(${clickupTasks.name}, '') <> '' THEN 'Ticket: ' || ${clickupTasks.name}
                  ELSE 'Service desk ticket' END) ILIKE ${likePattern(filters.q)}`]
          : []),
      ))
      .orderBy(desc(sdTicketMapping.createdAt), desc(sdTicketMapping.id))
      .limit(limit);

    return rows.map((r) => ({
      entry: {
        id: `ticket:${r.id}`,
        type: "ticket" as const,
        timestamp: r.createdAt.toISOString(),
        title: r.taskName ? `Ticket: ${r.taskName}` : "Service desk ticket",
        preview: null,
        direction: null,
        href: `/admin/service-desk/tickets/${r.clickupTaskId}`,
        hrefExternal: false,
        meta: { status: r.taskStatus ?? null },
      },
      cursorTs: r.cursorTs,
      rowId: r.id,
      actorUserId: r.requesterUserId ?? null,
      actorFallback: null,
    }));
  });
}

// ── Merge ───────────────────────────────────────────────────────────────────

export async function getClientTimeline(
  clientId: string,
  opts: {
    types?: TimelineEntryType[];
    cursor?: TimelineCursor | null;
    limit?: number;
    /** Task #4418 — optional search term + inclusive date bounds. */
    q?: string | null;
    after?: Date | null;
    before?: Date | null;
  } = {},
): Promise<TimelinePage> {
  const limit = Math.max(1, Math.min(opts.limit ?? TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT));
  const wanted = new Set<TimelineEntryType>(
    opts.types && opts.types.length > 0 ? opts.types : timelineEntryTypes,
  );
  const cursor = opts.cursor ?? null;
  const filters: TimelineFilters =
    opts.q || opts.after || opts.before
      ? { q: opts.q ?? null, after: opts.after ?? null, before: opts.before ?? null }
      : NO_FILTERS;

  const arms: Promise<ArmRow[]>[] = [rawCommArm(clientId, wanted, cursor, limit, filters)];
  if (wanted.has("sms")) arms.push(smsArm(clientId, cursor, limit, filters));
  if (wanted.has("call")) arms.push(callArm(clientId, cursor, limit, filters));
  if (wanted.has("meeting")) arms.push(meetingArm(clientId, cursor, limit, filters));
  if (wanted.has("ticket")) arms.push(ticketArm(clientId, cursor, limit, filters));

  const merged = (await Promise.all(arms)).flat();
  merged.sort((a, b) => {
    if (a.cursorTs !== b.cursorTs) return a.cursorTs > b.cursorTs ? -1 : 1;
    if (a.rowId === b.rowId) return 0;
    return a.rowId > b.rowId ? -1 : 1;
  });
  const page = merged.slice(0, limit);

  // Resolve actor labels for just this page.
  const userIds = Array.from(
    new Set(page.map((r) => r.actorUserId).filter((v): v is string => Boolean(v))),
  );
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    await withDbAttribution("timeline:actorLabels", async () => {
      const userRows = await getDb()
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const u of userRows) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        nameById.set(u.id, name || u.email || u.id);
      }
    });
  }

  const entries: TimelineEntry[] = page.map((r) => ({
    ...r.entry,
    actorLabel:
      (r.actorUserId ? nameById.get(r.actorUserId) ?? null : null) ?? r.actorFallback,
  }));

  const nextCursor =
    page.length === limit && page.length > 0
      ? encodeTimelineCursor({
          ts: page[page.length - 1].cursorTs,
          id: page[page.length - 1].rowId,
          cid: clientId,
        })
      : null;

  return { entries, nextCursor };
}

/** 404 helper for the routes: does the client exist at all? */
export async function timelineClientExists(clientId: string): Promise<boolean> {
  return withDbAttribution("timeline:clientExists", async () => {
    const rows = await getDb()
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows.length > 0;
  });
}
