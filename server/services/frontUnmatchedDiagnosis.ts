// @db-pool-intent: api
//
// Task #2512 — Front unmatched-backlog diagnosis (read-only).
//
// The Front matcher is deliberately hard-match-only (Task #867): a
// conversation auto-matches a client ONLY on an exact contact-email or a
// uniquely-owned trusted domain. Everything else lands in Unmatched. The
// match rate is therefore gated almost entirely by how complete the client
// contact-email / trusted-domain data is — NOT by matcher cleverness.
//
// This module classifies every currently-unmatched `front_sync_emails` row
// into a small set of mutually-exclusive *causes* so an operator can see
// WHY the backlog is unmatched and act on the actionable share (attach a
// missing domain/email to a client, or write an operational rule).
//
// It is strictly read-only: it runs the SAME pure resolver the live
// pipeline uses (`resolveFrontHardMatch` over `getHardMatchIndexes()`) but
// never writes a row. Buckets are mutually exclusive and sum to the total
// unmatched count.

import { resolveFrontHardMatch, getHardMatchIndexes, type FrontParticipant } from "./frontHardMatch";
import { isSpamSenderEmail } from "./frontIntegration";
import { isCompanyEmail, isPublicEmailDomain, isCompanyDomain, MATCH_REASON_CODES } from "./companyIdentity";

export type UnmatchedCause =
  // The matcher WOULD match this row now (client data was added after the
  // row was last evaluated) — re-running the matcher resolves it for free.
  | "wouldMatchNow"
  // A signal exists but points at >1 client (exact email shared across
  // clients) — deliberately not auto-claimed.
  | "sharedEmail"
  // A trusted-domain signal points at >1 client.
  | "sharedDomain"
  // No client signal, but the sender looks automated/operational
  // (noreply@, notifications@, …) — best closed with an operational rule.
  | "probableOperational"
  // Only company-internal participants — nothing external to match on.
  | "companyOnly"
  // No external email participant at all.
  | "noExternalSignal"
  // No client owns this sender's email or domain yet — the actionable
  // backlog. Attaching the domain/email to a client closes these.
  | "noClientData";

export interface UnmatchedDomainSuggestion {
  domain: string;
  // Task #2633 — count of individual unmatched MESSAGES on this domain.
  messages: number;
  sampleSenders: string[];
}

export interface UnmatchedSenderSuggestion {
  senderEmail: string;
  // Task #2633 — count of individual unmatched MESSAGES from this sender.
  messages: number;
}

export interface UnmatchedDiagnosis {
  total: number;
  byCause: Record<UnmatchedCause, number>;
  /** Ranked external domains (non-public, non-company) seen on `noClientData`
   *  rows — i.e. domains an operator could attach to a client to close gaps. */
  topUnmatchedDomains: UnmatchedDomainSuggestion[];
  /** Ranked senders on `probableOperational` rows — candidates for a rule. */
  topOperationalSenders: UnmatchedSenderSuggestion[];
  /** Match-rate snapshot so the UI can show before/after lift. */
  matchRate: {
    matched: number;
    unmatched: number;
    matchable: number;
    rate: number;
  };
}

function senderParticipants(participants: FrontParticipant[]): FrontParticipant[] {
  // Treat any participant carrying an email as a candidate; the hard-match
  // resolver already drops company-internal ones. For the "operational"
  // heuristic we want the actual sending address(es).
  return participants.filter((p) => !!(p?.email && p.email.includes("@")));
}

function externalNonPublicDomains(participants: FrontParticipant[]): string[] {
  const out = new Set<string>();
  for (const p of participants) {
    const email = (p?.email || "").trim().toLowerCase();
    if (!email.includes("@") || isCompanyEmail(email)) continue;
    const domain = email.split("@")[1];
    if (!domain) continue;
    if (isPublicEmailDomain(domain) || isCompanyDomain(domain)) continue;
    out.add(domain);
  }
  return [...out];
}

/**
 * Classify a single unmatched row into exactly one cause. Pure — no IO.
 * Exported so unit tests (and the route) can exercise it directly.
 */
export function classifyUnmatchedRow(
  participants: FrontParticipant[],
  indexes: Awaited<ReturnType<typeof getHardMatchIndexes>>,
): UnmatchedCause {
  const outcome = resolveFrontHardMatch(participants, indexes);

  // 1) A row that WOULD match now is the highest-value cause — surfacing it
  //    tells the operator "just re-run the matcher".
  if (outcome.status === "matched") return "wouldMatchNow";

  // 2) Ambiguity — a real signal that we refuse to auto-claim.
  if (outcome.status === "ambiguous") {
    return outcome.method === "email_exact" ? "sharedEmail" : "sharedDomain";
  }

  // 3) no_match. Within no-match, an automated/operational sender is best
  //    closed by a rule, so it takes precedence over the generic buckets.
  const senders = senderParticipants(participants);
  if (senders.some((p) => isSpamSenderEmail(p.email))) return "probableOperational";

  // Company-only vs no-external-signal come straight from the resolver's
  // reason string (it encodes the COMPANY_FILTERED reason code).
  if (outcome.reason.includes(MATCH_REASON_CODES.COMPANY_FILTERED)) return "companyOnly";
  if (outcome.reason === "No external email participants") return "noExternalSignal";

  // Otherwise: a genuine external sender that no client owns yet.
  return "noClientData";
}

const EMPTY_BY_CAUSE = (): Record<UnmatchedCause, number> => ({
  wouldMatchNow: 0,
  sharedEmail: 0,
  sharedDomain: 0,
  probableOperational: 0,
  companyOnly: 0,
  noExternalSignal: 0,
  noClientData: 0,
});

/**
 * Diagnose the full unmatched Front backlog. Read-only. Reads every
 * unmatched `front_sync_emails` row in the `api` pool (mirrors
 * `groupUnmatchedBySender`'s access pattern) and classifies each in-memory
 * against the cached hard-match indexes.
 */
export async function diagnoseUnmatchedBacklog(
  opts: { topDomains?: number; topSenders?: number } = {},
): Promise<UnmatchedDiagnosis> {
  const topDomains = Math.max(1, Math.min(opts.topDomains ?? 25, 100));
  const topSenders = Math.max(1, Math.min(opts.topSenders ?? 25, 100));

  const { getDb, withDbAttribution } = await import("../db");
  const { frontSyncEmails } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { getFrontMessageGrainStats, getFrontMessageCountByConversation } = await import("./frontMessageGrainStats");

  const indexes = await getHardMatchIndexes();

  const byCause = EMPTY_BY_CAUSE();
  // Task #2633 — every tally below counts individual MESSAGES, not the
  // front_sync_emails conversation rows the matcher reasons over. We still
  // iterate one conversation row per backlog item (the matcher is
  // conversation-level), but each contributes its materialized message count.
  // domain -> { messages, sampleSenders }
  const domainTally = new Map<string, { messages: number; senders: Set<string> }>();
  const operationalSenderTally = new Map<string, number>();
  let total = 0;
  let grain = { matched: 0, unmatched: 0, matchable: 0, matchRate: 0 };

  await withDbAttribution("front_unmatched_diagnosis:scan", async () => {
    const db = getDb();
    // Real message count per conversationId (message grain; rollup `email_thread`
    // shells excluded, Task #2669), so each unmatched conversation contributes its
    // real per-message count and a shell-only conversation contributes zero.
    const msgCountByConv = await getFrontMessageCountByConversation(db);
    const rows = await db.select().from(frontSyncEmails)
      .where(eq(frontSyncEmails.matchStatus, "unmatched"));

    for (const row of rows) {
      const convId = row.conversationId ? String(row.conversationId) : null;
      const msgCount = convId ? (msgCountByConv.get(convId) ?? 0) : 0;
      total += msgCount;
      const participants = Array.isArray(row.participantsJson)
        ? (row.participantsJson as FrontParticipant[])
        : [];
      const cause = classifyUnmatchedRow(participants, indexes);
      byCause[cause] += msgCount;

      if (cause === "noClientData") {
        const domains = externalNonPublicDomains(participants);
        const senders = senderParticipants(participants)
          .map((p) => (p.email || "").toLowerCase())
          .filter(Boolean);
        for (const domain of domains) {
          let entry = domainTally.get(domain);
          if (!entry) {
            entry = { messages: 0, senders: new Set() };
            domainTally.set(domain, entry);
          }
          entry.messages += msgCount;
          for (const s of senders) {
            if (entry.senders.size < 5) entry.senders.add(s);
          }
        }
      } else if (cause === "probableOperational") {
        for (const p of senderParticipants(participants)) {
          const email = (p.email || "").toLowerCase();
          if (email && isSpamSenderEmail(email)) {
            operationalSenderTally.set(email, (operationalSenderTally.get(email) ?? 0) + msgCount);
          }
        }
      }
    }
  });

  const topUnmatchedDomains: UnmatchedDomainSuggestion[] = [...domainTally.entries()]
    .map(([domain, v]) => ({ domain, messages: v.messages, sampleSenders: [...v.senders] }))
    .sort((a, b) => b.messages - a.messages || a.domain.localeCompare(b.domain))
    .slice(0, topDomains);

  const topOperationalSenders: UnmatchedSenderSuggestion[] = [...operationalSenderTally.entries()]
    .map(([senderEmail, messages]) => ({ senderEmail, messages }))
    .sort((a, b) => b.messages - a.messages || a.senderEmail.localeCompare(b.senderEmail))
    .slice(0, topSenders);

  // Task #2633 — headline match rate from the canonical MESSAGE-grain helper
  // (same one the KPI strip, match-stats tile and Messages tab use) so the
  // diagnosis card agrees with the rest of the console.
  await withDbAttribution("front_unmatched_diagnosis:match_rate", async () => {
    grain = await getFrontMessageGrainStats(getDb());
  });

  return {
    total,
    byCause,
    topUnmatchedDomains,
    topOperationalSenders,
    matchRate: {
      matched: grain.matched,
      unmatched: grain.unmatched,
      matchable: grain.matchable,
      rate: grain.matchRate,
    },
  };
}
