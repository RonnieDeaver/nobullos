// @db-pool-intent: worker
//
// Task #4765 — the ONE open-ask source pipeline.
//
// Every ask/promise extraction path (per-communication enrichment AND the
// daily-judgment newAsks path) creates rows through `recordExtractedAsk`:
//   - semantic dedup across ALL ask types and all sweepable statuses
//     (open / likely_open / likely_resolved), so the judgment path can no
//     longer re-mint asks the enrichment path already tracks;
//   - DB-race safety for burst extraction (meeting + follow-up email +
//     transcript enriched near-simultaneously): a per-client transaction-
//     scoped advisory lock serializes the re-check + insert, and the
//     partial unique index `client_open_asks_active_summary_uniq`
//     (client_id, md5(lower(btrim(summary)))) WHERE sweepable) makes the
//     exact-duplicate insert physically impossible — a conflict merges into
//     the surviving row instead of throwing. The index is anchored in the
//     schema (model entry + migration 20260814211021); its staged rollout
//     completed 2026-08-14: the enable_open_ask_dedup_constraint prod
//     action deduped production's pre-existing duplicate actives and built
//     the index there, then Task #4811 re-anchored it in the schema. The
//     targetless ON CONFLICT DO NOTHING below stays safe even in a legacy
//     environment where the index is somehow still absent;
//   - defined duplicate-merge semantics: mention counts add, source record
//     ids union, concern score bumps (capped at 10), lastReferencedAt
//     advances, and a re-referenced likely_resolved row reopens.
//
// Closure (Task #4765 §hindsight):
//   - `evaluateAskClosure` judges one ask against the FULL communication
//     history since its first mention (not the judgment's recent window)
//     and returns either still-live or resolved WITH evidence (which
//     communication answered it, when).
//   - `sweepClientOpenAsks` is the batched, checkpointed groom pass: every
//     evaluated row is stamped `hindsight_checked_at` (the durable
//     checkpoint the retro-groom prod action converges on) and receives a
//     disposition: resolved-with-evidence / merged-duplicate /
//     archived-abandoned / still-live.
//   - `runOpenAskMaintenance` is the deterministic (no-AI) per-client
//     backstop that rides the existing daily-judgment worker: stranded
//     likely_resolved rows auto-confirm to `resolved` after
//     LIKELY_RESOLVED_CONFIRM_DAYS, and never-re-referenced active rows
//     decay to an audited `dismissed` after DECAY_HORIZON_DAYS — so no row
//     can sit "open" (or likely_resolved) forever.
//
// Failure containment: AI failures NEVER fabricate a closure — an evaluator
// error leaves the row active and unstamped (retryable); a matcher error
// degrades to "no match" (worst case a duplicate row that the groom or the
// unique index catches later).

import { sql, and, eq, inArray, asc, desc } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  clientOpenAsks,
  openAskSweepableStatuses,
  openAskActiveStatuses,
  rawCommunicationRecords,
  type ClientOpenAsk,
} from "@shared/schema";
import { countableCommunicationConditions } from "../storage/communicationStorage";
import { bindArrayParam } from "../utils/sqlArray";
import { storage } from "../storage";
import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";

const LOG_PREFIX = "[OpenAskPipeline]";

/** An active ask never re-referenced for this long decays to an audited terminal state. */
export const DECAY_HORIZON_DAYS = 120;
/** A likely_resolved row with no contrary reference auto-confirms to resolved after this. */
export const LIKELY_RESOLVED_CONFIRM_DAYS = 14;
/** Chronological page size for the closure evaluator's full-history walk. */
export const CLOSURE_EVAL_MAX_COMMS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExtractedAskInput {
  summary: string;
  detail?: string | null;
  type: "client_ask" | "internal_promise";
  /** 0..10-ish concern bump driver; enrichment passes model urgency (0..1). */
  urgency?: number;
  unresolvedLikelihood?: number;
  askText?: string | null;
  askCategory?: string | null;
  requestedBy?: string | null;
  confidence?: number | null;
}

export interface AskClosureEvidence {
  communicationId: string;
  answeredAt: string | null;
  quote: string;
}

export interface AskClosureVerdict {
  disposition: "resolved" | "still_live";
  evidence?: AskClosureEvidence;
}

// ─── Injectable AI collaborators (test seam — digest-style deps) ──────────

export interface OpenAskPipelineDeps {
  semanticMatch: (
    newAsk: { summary: string; detail?: string | null; type: string },
    existing: Array<Pick<ClientOpenAsk, "id" | "summary" | "detail" | "askType">>,
  ) => Promise<{ matchId: string | null; confidence: number }>;
  evaluateClosure: (
    ask: ClientOpenAsk,
    comms: Array<{ id: string; timestamp: Date; title: string | null; content: string }>,
  ) => Promise<AskClosureVerdict>;
}

const openai = createDefaultOpenAiClient();

async function defaultSemanticMatch(
  newAsk: { summary: string; detail?: string | null; type: string },
  existing: Array<Pick<ClientOpenAsk, "id" | "summary" | "detail" | "askType">>,
): Promise<{ matchId: string | null; confidence: number }> {
  if (existing.length === 0) return { matchId: null, confidence: 0 };
  try {
    const existingList = existing
      .map((a, i) => `[${i}] (${a.askType}) ${a.summary}${a.detail ? ` — ${a.detail}` : ""}`)
      .join("\n");
    const response = await openai.chat.completions.create({
      model: QUALITY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You compare a new ask/promise against existing tracked asks for the same client. Determine if the new ask is semantically the same as any existing one (same underlying request, even if worded differently or filed under a different type — a client ask and an internal promise about the same deliverable ARE the same tracked item).

Respond with JSON:
{
  "matchIndex": null or the index number of the matching existing ask,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Only match if confidence >= 0.7. Return matchIndex: null if no match.`,
        },
        {
          role: "user",
          content: `New ask (${newAsk.type}): ${newAsk.summary}\nDetail: ${newAsk.detail || "(none)"}\n\nExisting tracked asks:\n${existingList}`,
        },
      ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return { matchId: null, confidence: 0 };
    const result = JSON.parse(content);
    if (result.matchIndex !== null && result.matchIndex !== undefined && result.confidence >= 0.7) {
      const matched = existing[result.matchIndex];
      if (matched) return { matchId: matched.id, confidence: result.confidence };
    }
    return { matchId: null, confidence: result.confidence || 0 };
  } catch (err: any) {
    // Degrade to no-match — worst case a duplicate the unique index or the
    // groom catches; NEVER block ask tracking on the matcher.
    console.error(`${LOG_PREFIX} semantic match failed:`, err?.message ?? err);
    return { matchId: null, confidence: 0 };
  }
}

/**
 * The EXACT per-communication content window the closure model sees. The
 * evidence gate below validates quotes against THIS window — never the full
 * stored content — otherwise a hallucinated quote that happens to match text
 * BEYOND the cutoff (which the model never saw) would pass mechanically.
 * Keep the prompt builder and validateClosureEvidence on this one helper.
 */
export const CLOSURE_MODEL_VISIBLE_CHARS = 600;
export async function defaultEvaluateClosure(
  ask: ClientOpenAsk,
  comms: Array<{ id: string; timestamp: Date; title: string | null; content: string }>,
): Promise<AskClosureVerdict> {
  if (comms.length === 0) return { disposition: "still_live" };
  const commList = comms
    .map(
      (c) =>
        `[comm:${c.id}] ${new Date(c.timestamp).toISOString().split("T")[0]}${c.title ? ` — ${c.title}` : ""}\n${closureModelVisibleContent(c.content)}`,
    )
    .join("\n---\n");
  const response = await openai.chat.completions.create({
    model: QUALITY_MODEL,
    response_format: { type: "json_object" },
    max_completion_tokens: 1500,
    messages: [
      {
        role: "system",
        content: `You audit whether a tracked client ask / internal promise was ANSWERED or FULFILLED at any point in the communication history provided. Only report "resolved" when a specific communication contains evidence the ask was addressed (the deliverable was sent, the question answered, the commitment completed, or the client explicitly confirmed/withdrew it). Ambiguous silence is NOT resolution.

The quote you cite must ITSELF demonstrate the resolution — it must be the answer, the delivery confirmation, or the explicit client confirmation/withdrawal. A quote that merely asks, repeats, or re-raises the request is NOT evidence (someone asking the question again proves it was asked, not answered). If the only quote you can find restates the ask, the disposition is still_live.

Respond with JSON:
{
  "disposition": "resolved" | "still_live",
  "communicationId": "the comm id (from the [comm:...] marker) containing the answer, or null",
  "answeredAt": "YYYY-MM-DD or null",
  "quote": "verbatim short quote from that communication proving the resolution, or null"
}`,
      },
      {
        role: "user",
        content: `Tracked ${ask.askType === "internal_promise" ? "internal promise" : "client ask"} (first mentioned ${ask.firstMentionedAt ? new Date(ask.firstMentionedAt).toISOString().split("T")[0] : "unknown"}):\n${ask.askText || ask.summary}${ask.detail ? `\nDetail: ${ask.detail}` : ""}\n\nCommunication history since first mention:\n${commList}`,
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? "";
  return validateClosureEvidence(JSON.parse(raw), comms);
}

/**
 * Task #4776 audit hardening — the mechanical evidence gate applied to the
 * model's raw closure verdict. Exported for direct unit coverage (the
 * pipeline's injected-deps tests bypass defaultEvaluateClosure entirely).
 *
 * A "resolved" verdict is accepted ONLY when it cites an in-corpus
 * communication AND a non-empty quote that appears VERBATIM (whitespace-
 * normalized, case-insensitive) in that communication's MODEL-VISIBLE
 * window (closureModelVisibleContent — the same truncation the prompt
 * applies). Checking the full stored content instead would accept a
 * hallucinated quote that coincidentally matches text after the cutoff,
 * which the model never saw. Anything short of that is still-live — never
 * fabricate a closure.
 */
export function validateClosureEvidence(
  parsed: any,
  comms: Array<{ id: string; content: string }>,
): AskClosureVerdict {
  // Whitespace-normalized comparison so line-wrap differences never reject a
  // genuinely verbatim quote.
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const citedComm =
    parsed?.disposition === "resolved" && typeof parsed.communicationId === "string"
      ? comms.find((c) => c.id === parsed.communicationId)
      : undefined;
  const normalizedQuote = typeof parsed?.quote === "string" ? normalize(parsed.quote) : "";
  if (
    parsed?.disposition === "resolved" &&
    citedComm &&
    // A whitespace-only quote normalizes to "" and would trivially pass the
    // containment check (every string includes "") — reject it explicitly.
    normalizedQuote.length > 0 &&
    normalize(closureModelVisibleContent(citedComm.content)).includes(normalizedQuote)
  ) {
    return {
      disposition: "resolved",
      evidence: {
        communicationId: parsed.communicationId,
        answeredAt: typeof parsed.answeredAt === "string" ? parsed.answeredAt : null,
        quote: parsed.quote,
      },
    };
  }
  return { disposition: "still_live" };
}
const defaultDeps: OpenAskPipelineDeps = {
  semanticMatch: defaultSemanticMatch,
  evaluateClosure: defaultEvaluateClosure,
};

let deps: OpenAskPipelineDeps = { ...defaultDeps };

export function __setOpenAskPipelineDepsForTest(overrides: Partial<OpenAskPipelineDeps>): void {
  deps = { ...deps, ...overrides };
}

export function __resetOpenAskPipelineDepsForTest(): void {
  deps = { ...defaultDeps };
}

// ─── Shared creation path ───────────────────────────────────────────────

export async function listSweepableClientOpenAsks(clientId: string): Promise<ClientOpenAsk[]> {
  return withDbAttribution("open-asks:list-sweepable", async () => {
    return getDb()
      .select()
      .from(clientOpenAsks)
      .where(
        and(
          eq(clientOpenAsks.clientId, clientId),
          inArray(clientOpenAsks.status, [...openAskSweepableStatuses]),
        ),
      )
      .orderBy(asc(clientOpenAsks.createdAt));
  });
}

type DbExecutor = ReturnType<typeof getDb>;

/**
 * Atomic merge of a new reference into an existing ask — ONE UPDATE that
 * increments the mention counter, unions source record ids, and adjusts the
 * concern score entirely in SQL, so concurrent mergers can never lose each
 * other's writes (a read-modify-write here would drop mentions/sources under
 * burst extraction). `reopen` also flips a likely_resolved row back to open
 * (a re-referenced ask is evidently not resolved). Returns null when the row
 * left the sweepable set concurrently (e.g. just resolved) — callers fall
 * back to their insert/skip path.
 */
async function atomicMergeIntoAsk(
  executor: DbExecutor | Parameters<Parameters<DbExecutor["transaction"]>[0]>[0],
  askId: string,
  opts: {
    mentionDelta: number;
    addSourceIds: string[];
    /** additive concern bump, capped at 10 (extraction merges) */
    concernBump?: number;
    /** floor via GREATEST, capped at 10 (groom keeper absorbing a duplicate) */
    concernFloor?: number;
    reopen?: boolean;
  },
): Promise<ClientOpenAsk | null> {
  const now = new Date();
  const addIds = opts.addSourceIds.filter((s) => typeof s === "string" && s.length > 0);
  const set: Record<string, unknown> = {
    lastReferencedAt: now,
    updatedAt: now,
    mentionCount: sql`COALESCE(${clientOpenAsks.mentionCount}, 1) + ${opts.mentionDelta}`,
    sourceRecordIds:
      addIds.length > 0
        ? sql`ARRAY(SELECT DISTINCT e FROM unnest(COALESCE(${clientOpenAsks.sourceRecordIds}, ARRAY[]::text[]) || ${bindArrayParam(addIds, "text")}) AS e)`
        : clientOpenAsks.sourceRecordIds,
  };
  if (opts.concernBump !== undefined) {
    set.concernScore = sql`LEAST(10, COALESCE(${clientOpenAsks.concernScore}, 1) + ${opts.concernBump})`;
  } else if (opts.concernFloor !== undefined) {
    set.concernScore = sql`LEAST(10, GREATEST(COALESCE(${clientOpenAsks.concernScore}, 1), ${opts.concernFloor}))`;
  }
  if (opts.reopen) {
    set.status = sql`CASE WHEN ${clientOpenAsks.status} = 'likely_resolved' THEN 'open' ELSE ${clientOpenAsks.status} END`;
    set.likelyResolved = sql`CASE WHEN ${clientOpenAsks.status} = 'likely_resolved' THEN false ELSE ${clientOpenAsks.likelyResolved} END`;
    set.likelyResolvedAt = sql`CASE WHEN ${clientOpenAsks.status} = 'likely_resolved' THEN NULL ELSE ${clientOpenAsks.likelyResolvedAt} END`;
  }
  const [updated] = await executor
    .update(clientOpenAsks)
    .set(set as any)
    .where(
      and(
        eq(clientOpenAsks.id, askId),
        inArray(clientOpenAsks.status, [...openAskSweepableStatuses]),
      ),
    )
    .returning();
  return updated ?? null;
}

export interface RecordAskResult {
  outcome: "created" | "merged";
  ask: ClientOpenAsk;
}

/**
 * The ONE ask-creation path. Semantic dedup across all ask types and all
 * sweepable statuses; per-client advisory-lock + unique-index protection
 * against concurrent burst extraction of the same ask.
 */
export async function recordExtractedAsk(
  clientId: string,
  ask: ExtractedAskInput,
  source: { sourceRecordId?: string | null } = {},
): Promise<RecordAskResult> {
  const summary = (ask.summary ?? "").trim();
  if (!summary) throw new Error("recordExtractedAsk: empty summary");
  const sourceRecordId = source.sourceRecordId ?? null;

  // 1. Semantic match OUTSIDE the lock (AI latency must not hold DB locks).
  const existing = await listSweepableClientOpenAsks(clientId);
  const match = await deps.semanticMatch(
    { summary, detail: ask.detail ?? null, type: ask.type },
    existing,
  );
  if (match.matchId && existing.some((a) => a.id === match.matchId)) {
    const updated = await withDbAttribution("open-asks:record-extracted", async () =>
      atomicMergeIntoAsk(getDb(), match.matchId!, {
        mentionDelta: 1,
        addSourceIds: sourceRecordId ? [sourceRecordId] : [],
        concernBump: (ask.urgency ?? 0) * 0.5,
        reopen: true,
      }),
    );
    if (updated) {
      console.log(`${LOG_PREFIX} merged ask into ${updated.id} (mention #${updated.mentionCount})`);
      return { outcome: "merged", ask: updated };
    }
    // The matched row left the sweepable set concurrently — fall through to
    // the locked re-check + insert path.
  }

  // 2. Insert under the per-client advisory lock; a conflicting concurrent
  // insert (exact normalized summary) merges instead of duplicating.
  return withDbAttribution("open-asks:record-extracted", async () => {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${clientId}), hashtext('open_ask_create'))`,
    );
    // Lock-window re-check: a burst sibling may have just created the row.
    const [raced] = await tx
      .select()
      .from(clientOpenAsks)
      .where(
        and(
          eq(clientOpenAsks.clientId, clientId),
          inArray(clientOpenAsks.status, [...openAskSweepableStatuses]),
          sql`md5(lower(btrim(${clientOpenAsks.summary}))) = md5(lower(btrim(${summary})))`,
        ),
      )
      .limit(1);
    if (raced) {
      const updated = await atomicMergeIntoAsk(tx, raced.id, {
        mentionDelta: 1,
        addSourceIds: sourceRecordId ? [sourceRecordId] : [],
        concernBump: (ask.urgency ?? 0) * 0.5,
        reopen: true,
      });
      if (!updated) throw new Error("open-ask burst merge target vanished mid-transaction");
      console.log(`${LOG_PREFIX} burst race: merged into existing ask ${raced.id}`);
      return { outcome: "merged" as const, ask: updated };
    }
    const status =
      ask.unresolvedLikelihood !== undefined
        ? ask.unresolvedLikelihood >= 0.7
          ? "open"
          : "likely_open"
        : "open";
    const [created] = await tx
      .insert(clientOpenAsks)
      .values({
        clientId,
        askType: ask.type,
        summary,
        detail: ask.detail ?? null,
        askText: ask.askText ?? summary,
        askCategory: ask.askCategory ?? null,
        requestedBy: ask.requestedBy ?? null,
        confidence: ask.confidence ?? null,
        status,
        concernScore: ask.urgency ?? 1,
        firstMentionedAt: new Date(),
        lastReferencedAt: new Date(),
        mentionCount: 1,
        sourceRecordIds: sourceRecordId ? [sourceRecordId] : [],
        sourceRecordId: sourceRecordId ?? undefined,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // Unique-index conflict inside the lock window shouldn't happen (the
      // re-check above holds the lock) — but fall back to merge honestly.
      const [conflicted] = await tx
        .select()
        .from(clientOpenAsks)
        .where(
          and(
            eq(clientOpenAsks.clientId, clientId),
            inArray(clientOpenAsks.status, [...openAskSweepableStatuses]),
            sql`md5(lower(btrim(${clientOpenAsks.summary}))) = md5(lower(btrim(${summary})))`,
          ),
        )
        .limit(1);
      if (!conflicted) throw new Error("open-ask insert conflicted but no surviving row found");
      const updated = await atomicMergeIntoAsk(tx, conflicted.id, {
        mentionDelta: 1,
        addSourceIds: sourceRecordId ? [sourceRecordId] : [],
        concernBump: (ask.urgency ?? 0) * 0.5,
        reopen: true,
      });
      if (!updated) throw new Error("open-ask conflict merge target vanished mid-transaction");
      return { outcome: "merged" as const, ask: updated };
    }
    return { outcome: "created" as const, ask: created };
  });
  });
}

// ─── Communication history + closure evaluation ────────────────────────

/**
 * One chronological page of the client's communication history since the
 * ask's first mention. The closure evaluator walks these pages OLDEST-first
 * until it either finds cited resolution evidence or exhausts the ENTIRE
 * history — no page is ever skipped, so the sweep is genuinely
 * full-hindsight even for clients with thousands of communications.
 */
async function listCommunicationsSincePage(
  clientId: string,
  since: Date,
  offset: number,
): Promise<Array<{ id: string; timestamp: Date; title: string | null; content: string }>> {
  const rows = await withDbAttribution("open-asks:closure-comms", async () =>
    getDb()
      .select({
        id: rawCommunicationRecords.id,
        timestamp: rawCommunicationRecords.timestamp,
        title: rawCommunicationRecords.title,
        contentText: rawCommunicationRecords.contentText,
        contentPreview: rawCommunicationRecords.contentPreview,
      })
      .from(rawCommunicationRecords)
      .where(and(...countableCommunicationConditions(clientId, since)))
      // Chronological ascending with a deterministic tiebreaker so paging
      // never drops or double-counts rows with identical timestamps.
      .orderBy(asc(rawCommunicationRecords.timestamp), asc(rawCommunicationRecords.id))
      .limit(CLOSURE_EVAL_MAX_COMMS)
      .offset(offset),
  );
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp as Date,
    title: r.title ?? null,
    content: r.contentText || r.contentPreview || "(no content available)",
  }));
}

function closureNote(evidence: AskClosureEvidence): string {
  return (
    `Resolved by hindsight closure sweep (Task #4765): answered in communication ` +
    `${evidence.communicationId}${evidence.answeredAt ? ` on ${evidence.answeredAt}` : ""} — "${evidence.quote.slice(0, 400)}"`
  );
}

/**
 * Evaluate ONE ask against the full communication history since its first
 * mention and apply the verdict. Returns the disposition applied.
 * AI/apply errors propagate to the caller (which leaves the row unstamped —
 * retryable — and must never treat an error as a closure).
 */
export async function evaluateAndApplyAskClosure(
  ask: ClientOpenAsk,
  nowMs: number = Date.now(),
): Promise<"resolved" | "still_live" | "archived"> {
  const since = ask.firstMentionedAt ?? ask.createdAt ?? new Date(nowMs - 365 * DAY_MS);
  // Walk the COMPLETE history since first mention in chronological pages of
  // CLOSURE_EVAL_MAX_COMMS. The first page containing cited resolution
  // evidence wins; only after every page has been evaluated (all the way to
  // the present) may the ask be judged still-live. A row is therefore never
  // checkpointed until its full history has been considered — an evaluator
  // error on ANY page propagates and leaves the row unstamped/retryable.
  let verdict: AskClosureVerdict = { disposition: "still_live" };
  for (let offset = 0; ; offset += CLOSURE_EVAL_MAX_COMMS) {
    const page = await listCommunicationsSincePage(ask.clientId, new Date(since), offset);
    if (page.length === 0 && offset > 0) break;
    const pageVerdict = await deps.evaluateClosure(ask, page);
    if (pageVerdict.disposition === "resolved" && pageVerdict.evidence) {
      verdict = pageVerdict;
      break;
    }
    if (page.length < CLOSURE_EVAL_MAX_COMMS) break; // last page — history exhausted
  }
  if (verdict.disposition === "resolved" && verdict.evidence) {
    await storage.updateClientOpenAsk(ask.id, {
      status: "resolved",
      resolvedAt: verdict.evidence.answeredAt ? new Date(verdict.evidence.answeredAt) : new Date(nowMs),
      resolutionNote: closureNote(verdict.evidence),
      hindsightCheckedAt: new Date(nowMs),
    });
    return "resolved";
  }
  // Still live per the evaluator — apply the standing-decay horizon.
  const lastRef = ask.lastReferencedAt ? new Date(ask.lastReferencedAt).getTime() : null;
  if (lastRef !== null && nowMs - lastRef >= DECAY_HORIZON_DAYS * DAY_MS) {
    await storage.updateClientOpenAsk(ask.id, {
      status: "dismissed",
      resolvedAt: new Date(nowMs),
      resolutionNote: `Auto-archived by hindsight sweep (Task #4765): never answered and not referenced in ${DECAY_HORIZON_DAYS}+ days — abandoned backlog.`,
      hindsightCheckedAt: new Date(nowMs),
    });
    return "archived";
  }
  await storage.updateClientOpenAsk(ask.id, { hindsightCheckedAt: new Date(nowMs) });
  return "still_live";
}

// ─── Deterministic per-client maintenance (no AI) ───────────────────────

export interface OpenAskMaintenanceResult {
  autoConfirmed: number;
  decayed: number;
}

/**
 * Deterministic backstop that rides the daily-judgment worker (no new
 * always-on scheduler):
 *   1. likely_resolved rows older than LIKELY_RESOLVED_CONFIRM_DAYS with no
 *      contrary re-reference auto-confirm to `resolved` — the regression
 *      guarantee that likely_resolved can no longer strand indefinitely.
 *   2. active rows never re-referenced within DECAY_HORIZON_DAYS decay to
 *      an audited `dismissed` disposition.
 */
export async function runOpenAskMaintenance(
  clientId: string,
  nowMs: number = Date.now(),
): Promise<OpenAskMaintenanceResult> {
  return withDbAttribution("open-asks:maintenance", async () => {
    const now = new Date(nowMs);
    const confirmCutoff = new Date(nowMs - LIKELY_RESOLVED_CONFIRM_DAYS * DAY_MS);
    const decayCutoff = new Date(nowMs - DECAY_HORIZON_DAYS * DAY_MS);
    const db = getDb();

    const confirmed = await db
      .update(clientOpenAsks)
      .set({
        status: "resolved",
        resolvedAt: now,
        resolutionNote: sql`'Auto-confirmed (Task #4765): judged likely resolved on ' || COALESCE(to_char(${clientOpenAsks.likelyResolvedAt}, 'YYYY-MM-DD'), 'unknown date') || ' with no contrary reference in ${sql.raw(String(LIKELY_RESOLVED_CONFIRM_DAYS))}+ days.'`,
        updatedAt: now,
      })
      .where(
        and(
          eq(clientOpenAsks.clientId, clientId),
          eq(clientOpenAsks.status, "likely_resolved"),
          sql`COALESCE(${clientOpenAsks.likelyResolvedAt}, ${clientOpenAsks.updatedAt}) <= ${confirmCutoff}`,
        ),
      )
      .returning({ id: clientOpenAsks.id });

    const decayed = await db
      .update(clientOpenAsks)
      .set({
        status: "dismissed",
        resolvedAt: now,
        resolutionNote: `Auto-archived (Task #4765 standing decay): not referenced in ${DECAY_HORIZON_DAYS}+ days and never validated as answered.`,
        updatedAt: now,
      })
      .where(
        and(
          eq(clientOpenAsks.clientId, clientId),
          inArray(clientOpenAsks.status, [...openAskActiveStatuses]),
          sql`COALESCE(${clientOpenAsks.lastReferencedAt}, ${clientOpenAsks.createdAt}) <= ${decayCutoff}`,
        ),
      )
      .returning({ id: clientOpenAsks.id });

    if (confirmed.length > 0 || decayed.length > 0) {
      console.log(
        `${LOG_PREFIX} maintenance client=${clientId}: auto-confirmed=${confirmed.length} decayed=${decayed.length}`,
      );
    }
    return { autoConfirmed: confirmed.length, decayed: decayed.length };
  });
}

// ─── Hindsight groom sweep (batched, checkpointed) ──────────────────────

export interface SweepCounts {
  evaluated: number;
  resolved: number;
  merged: number;
  archived: number;
  stillLive: number;
  errors: number;
}

/**
 * Groom every not-yet-checkpointed sweepable ask for one client:
 * duplicate-merge (semantic, cross-type), full-hindsight closure with
 * evidence, standing decay, or a still-live stamp. Each row's disposition
 * is durable, so the sweep is resumable at any granularity; errored rows
 * stay unstamped and are retried by a later pass.
 */
export async function sweepClientOpenAsks(
  clientId: string,
  opts: { limit?: number; nowMs?: number } = {},
): Promise<SweepCounts> {
  const nowMs = opts.nowMs ?? Date.now();
  const counts: SweepCounts = { evaluated: 0, resolved: 0, merged: 0, archived: 0, stillLive: 0, errors: 0 };
  const pending = await withDbAttribution("open-asks:sweep-pending", async () =>
    getDb()
      .select()
      .from(clientOpenAsks)
      .where(
        and(
          eq(clientOpenAsks.clientId, clientId),
          inArray(clientOpenAsks.status, [...openAskSweepableStatuses]),
          sql`${clientOpenAsks.hindsightCheckedAt} IS NULL`,
        ),
      )
      .orderBy(asc(clientOpenAsks.createdAt))
      .limit(opts.limit && opts.limit > 0 ? opts.limit : 10_000),
  );
  if (pending.length === 0) return counts;

  // Duplicate keepers: already-checked sweepable rows + rows kept this run.
  let keepers = (await listSweepableClientOpenAsks(clientId)).filter(
    (a) => a.hindsightCheckedAt !== null && !pending.some((p) => p.id === a.id),
  );

  for (const ask of pending) {
    counts.evaluated += 1;
    try {
      const match = await deps.semanticMatch(
        { summary: ask.summary, detail: ask.detail, type: ask.askType },
        keepers.filter((k) => k.id !== ask.id),
      );
      if (match.matchId) {
        const keeper = keepers.find((k) => k.id === match.matchId);
        if (keeper) {
          await withDbAttribution("open-asks:sweep-merge", async () =>
            atomicMergeIntoAsk(getDb(), keeper.id, {
              mentionDelta: ask.mentionCount ?? 1,
              addSourceIds: ask.sourceRecordIds ?? [],
              concernFloor: ask.concernScore ?? 1,
            }),
          );
          await storage.updateClientOpenAsk(ask.id, {
            status: "dismissed",
            resolvedAt: new Date(nowMs),
            resolutionNote: `Merged duplicate of ${keeper.id} (Task #4765 hindsight groom).`,
            hindsightCheckedAt: new Date(nowMs),
          });
          counts.merged += 1;
          continue;
        }
      }
      const disposition = await evaluateAndApplyAskClosure(ask, nowMs);
      if (disposition === "resolved") counts.resolved += 1;
      else if (disposition === "archived") counts.archived += 1;
      else {
        counts.stillLive += 1;
        keepers = [...keepers, { ...ask, hindsightCheckedAt: new Date(nowMs) }];
      }
    } catch (err: any) {
      counts.errors += 1;
      console.error(`${LOG_PREFIX} sweep failed for ask ${ask.id}:`, err?.message ?? err);
    }
  }
  return counts;
}

// ─── Groom prod-action support ──────────────────────────────────────────

/** Rows the retro-groom still owes a disposition (converging count). */
export async function countHindsightPending(): Promise<number> {
  const result = await withDbAttribution("open-asks:count-pending", async () => getDb().execute(sql`
    SELECT COUNT(*)::int AS n
    FROM client_open_asks
    WHERE status IN ('open', 'likely_open', 'likely_resolved')
      AND hindsight_checked_at IS NULL
  `));
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

/** Distinct clients with pending rows, oldest-pending first (chunk unit). */
export async function listClientsWithHindsightPending(limit: number): Promise<string[]> {
  const result = await withDbAttribution("open-asks:list-pending-clients", async () => getDb().execute(sql`
    SELECT client_id, MIN(created_at) AS oldest
    FROM client_open_asks
    WHERE status IN ('open', 'likely_open', 'likely_resolved')
      AND hindsight_checked_at IS NULL
    GROUP BY client_id
    ORDER BY oldest ASC
    LIMIT ${limit}
  `));
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return rows.map((r: any) => r.client_id as string);
}

export function closureModelVisibleContent(content: string): string {
  return content.slice(0, CLOSURE_MODEL_VISIBLE_CHARS);
}
