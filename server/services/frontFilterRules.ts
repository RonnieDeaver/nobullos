// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Phase 4: Front filter rules — canonical evaluation + retroactive apply.
 *
 * Public API:
 *   - evaluateFilterRules(input)            — precedence block > dismiss > never_match
 *   - invalidateFilterRulesCache()          — call after CRUD (clears eval + list caches)
 *   - listFilterRules()                     — sorted by precedence then createdAt; SWR-cached
 *   - createFilterRule(input, userId)
 *   - updateFilterRule(id, input, userId)
 *   - deleteFilterRule(id, userId)
 *   - previewFilterRule(input)              — count rows that would be affected
 *   - applyFilterRuleRetroactively(id, uid) — enqueue background job
 *   - handleFrontFilterRuleApplyJob(job)    — work-queue handler
 *   - frontFilterRuleApplyJobs              — in-memory mirror for UI polling
 */

import type { WorkQueueJob } from "@shared/schema";
import {
  frontFilterRules,
  frontFilterRuleHits,
  frontFilterRuleTypes,
  frontFilterRuleScopes,
  FRONT_FILTER_RULE_PRECEDENCE,
  type FrontFilterRule,
  type FrontFilterRuleHit,
  type FrontFilterRuleType,
  type FrontFilterRuleScope,
} from "@shared/schema";

// Task #1270: cap stored recent-hits per rule. Older rows are trimmed on
// flush so the drill-down stays bounded even for high-volume rules.
const MAX_RECENT_HITS_PER_RULE = 200;

const CACHE_TTL_MS = 30_000;

// Task #2504: admin filter-rules list cache. The GET
// /api/integrations/front/filter-rules read runs on the request-scoped
// `api` pool. During a heavy Front reprocess / bulk-action run the pool (and
// the rules tables) are under contention, so a per-request SELECT can stall
// for seconds and the list endpoint 500s / times out (the symptom Task #2502
// papered over with a client-side retry). The list is tiny, slow-changing
// config data, so we serve it from a short-lived in-memory cache with
// stale-while-revalidate semantics: a warm read never touches the DB, and
// once an entry goes stale we refresh it in the background (single-flight)
// while still returning the last-known-good rows immediately. The endpoint
// therefore stays responsive under load instead of blocking on a contended
// connection.
const LIST_CACHE_TTL_MS = 10_000;

let cache: { rules: FrontFilterRule[]; loadedAt: number } | null = null;
let listCache: { rules: FrontFilterRule[]; loadedAt: number } | null = null;
let listRefreshInFlight: Promise<FrontFilterRule[]> | null = null;

// Clears BOTH caches. Used by CRUD (create / update / delete) so an operator
// action is reflected on the very next evaluation AND list read.
export function invalidateFilterRulesCache(): void {
  cache = null;
  listCache = null;
}

async function loadEnabledRules(): Promise<FrontFilterRule[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  const { getDb } = await import("../db"); const db = getDb();
  const { eq, asc } = await import("drizzle-orm");
  // Deterministic order: oldest first, then id. evaluateFilterRules() picks
  // by precedence (block > dismiss > never_match) and resolves ties using
  // this ordering so the same input always produces the same winning ruleId.
  const rules = await db
    .select()
    .from(frontFilterRules)
    .where(eq(frontFilterRules.enabled, true))
    .orderBy(asc(frontFilterRules.createdAt), asc(frontFilterRules.id));
  cache = { rules, loadedAt: Date.now() };
  return rules;
}

// ---------- Normalization ----------

export function normalizeRuleValue(scope: FrontFilterRuleScope, raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "";
  if (scope === "sender_email") return v.toLowerCase();
  if (scope === "domain") return v.toLowerCase().replace(/^@/, "");
  if (scope === "channel") return v.toLowerCase().replace(/^#/, "");
  return v;
}

// ---------- Evaluation ----------

export type FilterRuleEvalInput = {
  subject?: string | null;
  participants?: Array<{ email?: string | null; role?: string | null }> | null;
  /**
   * Channels the conversation arrived on. For Front this is the inbox
   * handle/address (e.g. an email like `support@firm.com` or a tag).
   * Callers should pass any handle/name they want matched.
   */
  channels?: Array<string | null | undefined> | null;
};

export type FilterRuleEvalResult = {
  matched: boolean;
  type: FrontFilterRuleType | null;
  ruleId: string | null;
  scope: FrontFilterRuleScope | null;
  value: string | null;
};

function isSenderRole(role: string | null | undefined): boolean {
  // Treat anything that's not the inbox-side as a potential sender.
  // "external" is the canonical inbound sender role; recipients are inbox
  // handles. We accept missing/unknown roles as senders too so that older
  // data without role tagging still gets matched.
  if (!role) return true;
  const r = String(role).toLowerCase();
  return r !== "recipient" && r !== "team";
}

function ruleMatches(rule: FrontFilterRule, input: FilterRuleEvalInput): boolean {
  const v = (rule.value || "").toLowerCase().trim();
  if (!v) return false;
  if (rule.scope === "sender_email") {
    const list = Array.isArray(input.participants) ? input.participants : [];
    return list.some((p) => isSenderRole(p?.role) && (p?.email || "").toLowerCase() === v);
  }
  if (rule.scope === "domain") {
    const list = Array.isArray(input.participants) ? input.participants : [];
    return list.some((p) => {
      if (!isSenderRole(p?.role)) return false;
      const e = (p?.email || "").toLowerCase();
      const at = e.lastIndexOf("@");
      return at >= 0 && e.slice(at + 1) === v;
    });
  }
  if (rule.scope === "channel") {
    // Channel scope = exact recipient-handle match. We deliberately match the
    // canonical retroactive selector (`inbox` filter on bulk-action queries
    // does `LOWER(p->>'email') = value`) so prospective evaluation, preview,
    // and retroactive apply all return the same cohort. Domain-suffix logic
    // belongs to scope=domain; conflating them here previously produced
    // preview/runtime cohort drift.
    const channels = (Array.isArray(input.channels) ? input.channels : [])
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .map((c) => c.toLowerCase().replace(/^#/, ""));
    if (channels.includes(v)) return true;
    const list = Array.isArray(input.participants) ? input.participants : [];
    return list.some((p) => {
      if ((p?.role || "").toLowerCase() !== "recipient") return false;
      const e = (p?.email || "").toLowerCase();
      return !!e && e === v;
    });
  }
  return false;
}

export async function evaluateFilterRules(
  input: FilterRuleEvalInput,
): Promise<FilterRuleEvalResult> {
  const rules = await loadEnabledRules();
  let best: FrontFilterRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, input)) continue;
    const cur = FRONT_FILTER_RULE_PRECEDENCE[rule.type as FrontFilterRuleType] ?? 0;
    const bestPrec = best
      ? FRONT_FILTER_RULE_PRECEDENCE[best.type as FrontFilterRuleType] ?? 0
      : -1;
    if (cur > bestPrec) best = rule;
  }
  if (!best) {
    return { matched: false, type: null, ruleId: null, scope: null, value: null };
  }
  return {
    matched: true,
    type: best.type as FrontFilterRuleType,
    ruleId: best.id,
    scope: best.scope as FrontFilterRuleScope,
    value: best.value,
  };
}

// ---------- CRUD ----------

export type FilterRuleCreateInput = {
  type: FrontFilterRuleType;
  scope: FrontFilterRuleScope;
  value: string;
  notes?: string | null;
  enabled?: boolean;
};

export type FilterRuleUpdateInput = Partial<{
  type: FrontFilterRuleType;
  scope: FrontFilterRuleScope;
  value: string;
  notes: string | null;
  enabled: boolean;
}>;

async function loadFilterRulesList(): Promise<FrontFilterRule[]> {
  const { getDb } = await import("../db"); const db = getDb();
  const { desc, asc } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(frontFilterRules)
    .orderBy(desc(frontFilterRules.enabled), asc(frontFilterRules.createdAt));
  listCache = { rules: rows, loadedAt: Date.now() };
  return rows;
}

// Single-flight background refresh. Triggered when a cached entry is stale;
// it must never surface to (or block) the request that triggered it, so any
// error is swallowed and the last-known-good cache is kept until a later
// refresh succeeds.
function refreshFilterRulesListInBackground(): void {
  if (listRefreshInFlight) return;
  listRefreshInFlight = loadFilterRulesList()
    .catch((err) => {
      console.warn(
        `[FrontFilterRules] background list refresh failed (serving stale):`,
        (err as Error).message,
      );
      return listCache?.rules ?? [];
    })
    .finally(() => {
      listRefreshInFlight = null;
    });
}

export async function listFilterRules(): Promise<FrontFilterRule[]> {
  if (listCache) {
    if (Date.now() - listCache.loadedAt >= LIST_CACHE_TTL_MS) {
      // Stale: kick off a single-flight background refresh but return the
      // last-known-good rows immediately so the endpoint never blocks on a
      // contended connection during a heavy reprocess / bulk action.
      refreshFilterRulesListInBackground();
    }
    return listCache.rules;
  }
  // Cold cache: block on the first load. If it throws under contention the
  // client's retry/backoff handles it; every subsequent read is served warm.
  return await loadFilterRulesList();
}

export async function getFilterRule(id: string): Promise<FrontFilterRule | null> {
  const { getDb } = await import("../db"); const db = getDb();
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(frontFilterRules)
    .where(eq(frontFilterRules.id, id))
    .limit(1);
  return row ?? null;
}

async function writeAudit(
  actionType: string,
  detail: string,
  userId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const { insertActivityLogs } = await import("../storage/activityStorage");
    await insertActivityLogs([
      {
        userId: userId || null,
        actionType,
        route: "/api/integrations/front/filter-rules",
        actionDetail: detail,
        metadata,
        sessionId: null,
        duration: null,
        timestamp: new Date(),
      },
    ]);
  } catch (err) {
    console.warn(`[FrontFilterRules] audit write failed for ${actionType}:`, (err as Error).message);
  }
}

export async function createFilterRule(
  input: FilterRuleCreateInput,
  userId: string,
): Promise<FrontFilterRule> {
  if (!frontFilterRuleTypes.includes(input.type)) throw new Error("invalid_type");
  if (!frontFilterRuleScopes.includes(input.scope)) throw new Error("invalid_scope");
  const value = normalizeRuleValue(input.scope, input.value);
  if (!value) throw new Error("invalid_value");

  const { getDb } = await import("../db"); const db = getDb();
  const [row] = await db
    .insert(frontFilterRules)
    .values({
      type: input.type,
      scope: input.scope,
      value,
      notes: input.notes ?? null,
      enabled: input.enabled ?? true,
      createdBy: userId,
    })
    .returning();
  invalidateFilterRulesCache();
  await writeAudit(
    "front_filter_rule_create",
    `Created filter rule ${row.type}/${row.scope}/${row.value}`,
    userId,
    { ruleId: row.id, type: row.type, scope: row.scope, value: row.value, notes: row.notes, enabled: row.enabled },
  );
  return row;
}

export async function updateFilterRule(
  id: string,
  input: FilterRuleUpdateInput,
  userId: string,
): Promise<FrontFilterRule> {
  const before = await getFilterRule(id);
  if (!before) throw new Error("rule_not_found");

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.type !== undefined) {
    if (!frontFilterRuleTypes.includes(input.type)) throw new Error("invalid_type");
    patch.type = input.type;
  }
  if (input.scope !== undefined) {
    if (!frontFilterRuleScopes.includes(input.scope)) throw new Error("invalid_scope");
    patch.scope = input.scope;
  }
  if (input.value !== undefined) {
    const scope = (input.scope ?? before.scope) as FrontFilterRuleScope;
    const value = normalizeRuleValue(scope, input.value);
    if (!value) throw new Error("invalid_value");
    patch.value = value;
  }
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  const { getDb } = await import("../db"); const db = getDb();
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .update(frontFilterRules)
    .set(patch)
    .where(eq(frontFilterRules.id, id))
    .returning();
  invalidateFilterRulesCache();
  await writeAudit(
    "front_filter_rule_update",
    `Updated filter rule ${row.type}/${row.scope}/${row.value}`,
    userId,
    {
      ruleId: row.id,
      before: { type: before.type, scope: before.scope, value: before.value, notes: before.notes, enabled: before.enabled },
      after: { type: row.type, scope: row.scope, value: row.value, notes: row.notes, enabled: row.enabled },
    },
  );
  return row;
}

export async function deleteFilterRule(id: string, userId: string): Promise<void> {
  const before = await getFilterRule(id);
  if (!before) throw new Error("rule_not_found");
  const { getDb } = await import("../db"); const db = getDb();
  const { eq } = await import("drizzle-orm");
  await db.delete(frontFilterRules).where(eq(frontFilterRules.id, id));
  invalidateFilterRulesCache();
  await writeAudit(
    "front_filter_rule_delete",
    `Deleted filter rule ${before.type}/${before.scope}/${before.value}`,
    userId,
    { ruleId: before.id, type: before.type, scope: before.scope, value: before.value },
  );
}

// ---------- Bulk-action mapping ----------

type BulkBridge = {
  action: "block_sender" | "block_domain" | "dismiss";
  target: { senderEmail?: string; domain?: string; reason?: string };
  // Selection mirrors BulkQuerySnapshot fields used by the canonical Phase 3
  // resolver. `inbox` does an exact recipient-handle match (LOWER(p->>'email')
  // = inbox) — the correct selector for channel-scoped rules. `search` is a
  // broad text fallback and must NOT be used for channel scope (counts would
  // be incorrect).
  selection: { senderEmail?: string; senderDomain?: string; inbox?: string; search?: string; match?: string };
};

function ruleToBulk(rule: { type: FrontFilterRuleType; scope: FrontFilterRuleScope; value: string; id?: string }): BulkBridge | null {
  const reason = `Filter rule ${rule.type}:${rule.scope}:${rule.value}${rule.id ? ` (${rule.id})` : ""}`;

  // never_match is evaluated prospectively; retroactively we soft-dismiss
  // currently-unmatched matching rows so the operator sees the queue clear.
  if (rule.type === "never_match") {
    if (rule.scope === "sender_email") {
      return { action: "dismiss", target: { reason }, selection: { senderEmail: rule.value, match: "unmatched" } };
    }
    if (rule.scope === "domain") {
      return { action: "dismiss", target: { reason }, selection: { senderDomain: rule.value, match: "unmatched" } };
    }
    // channel — exact recipient-handle match via canonical inbox selector.
    return { action: "dismiss", target: { reason }, selection: { inbox: rule.value, match: "unmatched" } };
  }

  if (rule.type === "block") {
    if (rule.scope === "sender_email") {
      return { action: "block_sender", target: { senderEmail: rule.value }, selection: { senderEmail: rule.value } };
    }
    if (rule.scope === "domain") {
      return { action: "block_domain", target: { domain: rule.value }, selection: { senderDomain: rule.value } };
    }
    // block + channel — there is no per-inbox block-list (block_sender /
    // block_domain target sender identity, not the inbox). For the
    // retroactive cohort we dismiss every currently-matching message on the
    // channel so the queue clears; the rule's prospective `block` semantics
    // are still enforced by evaluateFilterRules() at ingestion time.
    return { action: "dismiss", target: { reason }, selection: { inbox: rule.value } };
  }

  // dismiss
  if (rule.scope === "sender_email") {
    return { action: "dismiss", target: { reason }, selection: { senderEmail: rule.value } };
  }
  if (rule.scope === "domain") {
    return { action: "dismiss", target: { reason }, selection: { senderDomain: rule.value } };
  }
  // dismiss + channel — exact recipient-handle match via canonical inbox.
  return { action: "dismiss", target: { reason }, selection: { inbox: rule.value } };
}

// ---------- Preview ----------

export type PreviewFilterRuleInput =
  | { type: FrontFilterRuleType; scope: FrontFilterRuleScope; value: string }
  | { ruleId: string };

export async function previewFilterRule(input: PreviewFilterRuleInput): Promise<{
  totalSelected: number;
  eligibleCount: number;
  ineligibleCount: number;
  uniqueSender: string | null;
  uniqueDomain: string | null;
  warnings: string[];
}> {
  let type: FrontFilterRuleType;
  let scope: FrontFilterRuleScope;
  let value: string;
  if ("ruleId" in input) {
    const rule = await getFilterRule(input.ruleId);
    if (!rule) throw new Error("rule_not_found");
    type = rule.type as FrontFilterRuleType;
    scope = rule.scope as FrontFilterRuleScope;
    value = rule.value;
  } else {
    type = input.type;
    scope = input.scope;
    value = normalizeRuleValue(input.scope, input.value);
  }
  if (!value) throw new Error("invalid_value");
  const bridge = ruleToBulk({ type, scope, value });
  if (!bridge) {
    return { totalSelected: 0, eligibleCount: 0, ineligibleCount: 0, uniqueSender: null, uniqueDomain: null, warnings: [] };
  }
  const { previewBulkAction } = await import("./frontBulkActions");
  const preview = await previewBulkAction({
    action: bridge.action,
    target: bridge.target,
    selection: { mode: "query", query: bridge.selection },
  });
  return {
    totalSelected: preview.totalSelected,
    eligibleCount: preview.eligibleCount,
    ineligibleCount: preview.ineligibleCount,
    uniqueSender: preview.uniqueSender,
    uniqueDomain: preview.uniqueDomain,
    warnings: preview.warnings,
  };
}

// ---------- Retroactive apply ----------

type ApplyJobState = {
  jobId: string;
  ruleId: string;
  status: "queued" | "running" | "complete" | "partial" | "failed";
  startedAt: number;
  updatedAt: number;
  totalSelected: number;
  totalProcessed: number;
  succeeded: number;
  failed: number;
  childBulkJobId: string | null;
  finalSummary: string | null;
  startedBy: string;
};

export const frontFilterRuleApplyJobs = new Map<string, ApplyJobState>();

// Reap a terminal apply-job's in-memory mirror entry after a grace window so
// `/apply-status` can still serve it briefly post-completion. The timer is
// `.unref()`'d so this fire-and-forget cleanup never keeps the Node event
// loop alive on its own — in the long-lived server other handles hold the
// process open, but in a short-lived test/CLI process a settled apply job no
// longer leaks a 30-minute handle that would otherwise stall a clean exit.
const MIRROR_REAP_DELAY_MS = 30 * 60 * 1000;
function scheduleMirrorReap(jobId: string): void {
  const t = setTimeout(
    () => frontFilterRuleApplyJobs.delete(jobId),
    MIRROR_REAP_DELAY_MS,
  );
  if (typeof (t as any).unref === "function") (t as any).unref();
}

export async function applyFilterRuleRetroactively(
  ruleId: string,
  userId: string,
): Promise<{ jobId: string; estimatedCount: number; message: string }> {
  const rule = await getFilterRule(ruleId);
  if (!rule) throw new Error("rule_not_found");

  const bridge = ruleToBulk({ type: rule.type as FrontFilterRuleType, scope: rule.scope as FrontFilterRuleScope, value: rule.value, id: rule.id });
  if (!bridge) throw new Error("rule_not_applyable");

  // Estimate up-front so the UI/audit have an immediate count.
  let estimated = 0;
  try {
    const preview = await previewFilterRule({
      type: rule.type as FrontFilterRuleType,
      scope: rule.scope as FrontFilterRuleScope,
      value: rule.value,
    });
    estimated = preview.eligibleCount;
  } catch (err) {
    console.warn(`[FrontFilterRules] preview-before-apply failed for ${rule.id}:`, (err as Error).message);
  }

  const { submitRepairJob } = await import("./workQueueHandlers");
  const jobId = await submitRepairJob({
    queueName: "front_filter_rule_apply",
    workloadClass: "interactive_repair",
    payload: { ruleId: rule.id, userId },
    maxAttempts: 2,
    dedupeKey: `front_filter_rule_apply:${rule.id}`,
  });

  const now = Date.now();
  frontFilterRuleApplyJobs.set(jobId, {
    jobId,
    ruleId: rule.id,
    status: "queued",
    startedAt: now,
    updatedAt: now,
    totalSelected: estimated,
    totalProcessed: 0,
    succeeded: 0,
    failed: 0,
    childBulkJobId: null,
    finalSummary: null,
    startedBy: userId,
  });

  await writeAudit(
    "front_filter_rule_apply_started",
    `Started retroactive apply for rule ${rule.type}/${rule.scope}/${rule.value} — estimated ${estimated} rows`,
    userId,
    { ruleId: rule.id, jobId, estimated },
  );

  return {
    jobId,
    estimatedCount: estimated,
    message: `Filter rule apply enqueued — ~${estimated} items.`,
  };
}

export async function handleFrontFilterRuleApplyJob(
  job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  const payload = (job.payload && typeof job.payload === "object")
    ? (job.payload as { ruleId?: string; userId?: string })
    : {};
  const ruleId = typeof payload.ruleId === "string" ? payload.ruleId : "";
  const userId = typeof payload.userId === "string" ? payload.userId : "system";
  if (!ruleId) throw new Error("invalid front_filter_rule_apply payload: missing ruleId");

  const rule = await getFilterRule(ruleId);
  if (!rule) throw new Error(`rule_not_found:${ruleId}`);

  const bridge = ruleToBulk({
    type: rule.type as FrontFilterRuleType,
    scope: rule.scope as FrontFilterRuleScope,
    value: rule.value,
    id: rule.id,
  });
  if (!bridge) throw new Error(`rule_not_applyable:${ruleId}`);

  const state = frontFilterRuleApplyJobs.get(job.id) ?? {
    jobId: job.id,
    ruleId,
    status: "running" as const,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    totalSelected: 0,
    totalProcessed: 0,
    succeeded: 0,
    failed: 0,
    childBulkJobId: null,
    finalSummary: null as string | null,
    startedBy: userId,
  };
  state.status = "running";
  state.updatedAt = Date.now();
  frontFilterRuleApplyJobs.set(job.id, state);

  const { executeBulkAction } = await import("./frontBulkActions");
  const result = await executeBulkAction(
    {
      action: bridge.action,
      target: bridge.target,
      selection: { mode: "query", query: bridge.selection },
    },
    userId,
  );

  if (result.jobId === null) {
    // Synchronous bulk path — final accounting happens inline.
    const succeeded = result.succeeded;
    const failed = result.failed;
    const processed = result.totalProcessed;
    const summary = result.summary;
    state.totalSelected = processed;
    state.totalProcessed = processed;
    state.succeeded = succeeded;
    state.failed = failed;
    state.status = failed === 0 ? "complete" : succeeded > 0 ? "partial" : "failed";
    state.finalSummary = summary;
    state.updatedAt = Date.now();
    frontFilterRuleApplyJobs.set(job.id, state);

    await persistRuleApplyAccounting(ruleId, succeeded);
    await writeAudit(
      "front_filter_rule_apply_completed",
      `Apply completed for rule ${rule.type}/${rule.scope}/${rule.value} — ${succeeded} succeeded / ${failed} failed`,
      userId,
      { ruleId, jobId: job.id, childBulkJobId: null, succeeded, failed, totalProcessed: processed, summary },
    );
    await persistRuleApplyCursor(job.id, {
      ruleId,
      status: state.status,
      totalSelected: state.totalSelected,
      totalProcessed: processed,
      succeeded,
      failed,
      childBulkJobId: null,
      finalSummary: summary,
      completedAt: new Date().toISOString(),
    });

    scheduleMirrorReap(job.id);

    return {
      cursor: `filter_rule_apply:${ruleId},processed:${processed},ok:${succeeded},fail:${failed}`,
    };
  }

  // Above the synchronous cap — a child front_bulk_action job is running.
  // The parent work_queue row will return successfully, but its mirror state
  // and cursor_json must reflect "running" until the child reaches a terminal
  // state. A background watcher polls the child mirror / cursor_json and then
  // performs the final accounting (audit + affectedCount + cursor_json) so
  // operators see accurate retroactive-impact totals and lifecycle.
  state.childBulkJobId = result.jobId;
  state.totalSelected = result.estimatedCount;
  state.status = "running";
  state.finalSummary = `Delegated to bulk job ${result.jobId} (~${result.estimatedCount} items). Awaiting completion…`;
  state.updatedAt = Date.now();
  frontFilterRuleApplyJobs.set(job.id, state);

  await persistRuleApplyCursor(job.id, {
    ruleId,
    status: "running",
    totalSelected: state.totalSelected,
    totalProcessed: 0,
    succeeded: 0,
    failed: 0,
    childBulkJobId: result.jobId,
    finalSummary: state.finalSummary,
    completedAt: null,
  });

  await writeAudit(
    "front_filter_rule_apply_delegated",
    `Apply delegated to bulk job ${result.jobId} for rule ${rule.type}/${rule.scope}/${rule.value} — awaiting completion (~${result.estimatedCount} items)`,
    userId,
    { ruleId, jobId: job.id, childBulkJobId: result.jobId, estimatedCount: result.estimatedCount },
  );

  // Fire-and-forget watcher; not awaited so the work-queue handler returns
  // promptly. The watcher self-terminates on terminal state or hard timeout.
  void watchChildBulkJob({
    parentJobId: job.id,
    ruleId,
    rule: { type: rule.type, scope: rule.scope, value: rule.value },
    childBulkJobId: result.jobId,
    estimatedCount: result.estimatedCount,
    userId,
  });

  return {
    cursor: `filter_rule_apply:${ruleId},delegated:${result.jobId}`,
  };
}

async function isParentCursorTerminal(parentJobId: string): Promise<boolean> {
  try {
    const { getDb } = await import("../db");
    const { workQueue } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb()
      .select({ cursorJson: workQueue.cursorJson })
      .from(workQueue)
      .where(eq(workQueue.id, parentJobId))
      .limit(1);
    if (!row) return false;
    const persisted = parsePersistedApplyResult(row.cursorJson);
    return persisted?.status === "complete"
      || persisted?.status === "partial"
      || persisted?.status === "failed";
  } catch {
    return false;
  }
}

async function persistRuleApplyAccounting(ruleId: string, increment: number): Promise<void> {
  try {
    const { getDb } = await import("../db"); const db = getDb();
    const { eq, sql } = await import("drizzle-orm");
    await db
      .update(frontFilterRules)
      .set({
        lastAppliedAt: new Date(),
        affectedCount: sql`${frontFilterRules.affectedCount} + ${increment}`,
        updatedAt: new Date(),
      })
      .where(eq(frontFilterRules.id, ruleId));
    // Accounting only bumps affected_count / last_applied_at, which neither
    // the evaluation cache (loadEnabledRules → evaluateFilterRules reads only
    // precedence/type/scope/value/enabled) nor any other eval consumer reads.
    // Invalidating here forced a fresh enabled-rules SELECT on every ~5s
    // hit-flush during a reprocess — needless work on an already-contended
    // pool. The admin list cache (which DOES surface these fields) converges
    // on its own short TTL, so we deliberately invalidate nothing here.
  } catch (err) {
    console.warn(`[FrontFilterRules] persist apply accounting failed for ${ruleId}:`, (err as Error).message);
  }
}

async function persistRuleApplyCursor(
  parentJobId: string,
  result: {
    ruleId: string;
    status: ApplyJobState["status"];
    totalSelected: number;
    totalProcessed: number;
    succeeded: number;
    failed: number;
    childBulkJobId: string | null;
    finalSummary: string | null;
    completedAt: string | null;
  },
): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const { workQueue } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await getDb()
      .update(workQueue)
      .set({ cursorJson: { result } })
      .where(eq(workQueue.id, parentJobId));
  } catch (err) {
    console.warn(`[FrontFilterRules] persist cursor failed for parent ${parentJobId}:`, (err as Error).message);
  }
}

// Maximum time we'll wait for the child bulk job before giving up and marking
// the parent as failed. Bulk actions are bounded by their own per-item cap so
// even very large cohorts complete inside this window in practice.
const CHILD_RECONCILE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CHILD_RECONCILE_POLL_MS = 5_000;

async function watchChildBulkJob(input: {
  parentJobId: string;
  ruleId: string;
  rule: { type: string; scope: string; value: string };
  childBulkJobId: string;
  estimatedCount: number;
  userId: string;
}): Promise<void> {
  const { parentJobId, ruleId, rule, childBulkJobId, estimatedCount, userId } = input;
  const deadline = Date.now() + CHILD_RECONCILE_TIMEOUT_MS;

  // Resolve child terminal state from either the in-memory mirror (fast) or
  // the durable work_queue.cursor_json result (survives mirror reap/restart).
  const fetchChildTerminal = async (): Promise<{
    status: "complete" | "partial" | "failed";
    succeeded: number;
    failed: number;
    totalProcessed: number;
    totalSelected: number;
    summary: string | null;
  } | null> => {
    try {
      const { bulkActionJobs } = await import("./frontBulkActions");
      const mirror = bulkActionJobs.get(childBulkJobId);
      if (mirror && (mirror.status === "complete" || mirror.status === "partial" || mirror.status === "failed")) {
        return {
          status: mirror.status,
          succeeded: mirror.succeeded,
          failed: mirror.failed,
          totalProcessed: mirror.totalProcessed,
          totalSelected: mirror.totalSelected,
          summary: mirror.finalSummary,
        };
      }
    } catch {
      // mirror unavailable; fall through to durable lookup
    }
    try {
      const { getDb } = await import("../db");
      const { workQueue } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await getDb()
        .select({ cursorJson: workQueue.cursorJson, status: workQueue.status })
        .from(workQueue)
        .where(eq(workQueue.id, childBulkJobId))
        .limit(1);
      if (!row) return null;
      const cj = row.cursorJson as any;
      const r = cj?.result;
      if (r && (r.status === "complete" || r.status === "partial" || r.status === "failed")) {
        return {
          status: r.status,
          succeeded: Number(r.succeeded) || 0,
          failed: Number(r.failed) || 0,
          totalProcessed: Number(r.totalProcessed) || 0,
          totalSelected: Number(r.totalSelected) || 0,
          summary: typeof r.finalSummary === "string" ? r.finalSummary : null,
        };
      }
      // Queue row reached terminal failure without a result blob.
      if (row.status === "failed" || row.status === "dead_lettered") {
        return { status: "failed", succeeded: 0, failed: 0, totalProcessed: 0, totalSelected: 0, summary: null };
      }
    } catch (err) {
      console.warn(`[FrontFilterRules] child fetch failed for ${childBulkJobId}:`, (err as Error).message);
    }
    return null;
  };

  // Propagate in-flight child progress (succeeded/failed/totalProcessed/
  // totalSelected) into the parent mirror on each poll so the admin UI's
  // /apply-jobs/active endpoint shows real progress instead of static
  // "queued — 0/N" while a long-running bulk job streams batches.
  const propagateChildProgress = async (): Promise<void> => {
    try {
      const { bulkActionJobs } = await import("./frontBulkActions");
      const mirror = bulkActionJobs.get(childBulkJobId);
      if (!mirror) return;
      const parent = frontFilterRuleApplyJobs.get(parentJobId);
      if (!parent) return;
      // Only propagate while the child is still running; terminal updates
      // happen below via fetchChildTerminal.
      if (mirror.status !== "running" && mirror.status !== "queued") return;
      const next = {
        ...parent,
        status: "running" as const,
        totalSelected: mirror.totalSelected || parent.totalSelected,
        totalProcessed: mirror.totalProcessed,
        succeeded: mirror.succeeded,
        failed: mirror.failed,
        updatedAt: Date.now(),
      };
      // Avoid pointless writes that would just churn updatedAt.
      if (
        next.totalSelected === parent.totalSelected &&
        next.totalProcessed === parent.totalProcessed &&
        next.succeeded === parent.succeeded &&
        next.failed === parent.failed &&
        parent.status === "running"
      ) {
        return;
      }
      frontFilterRuleApplyJobs.set(parentJobId, next);
    } catch {
      // mirror unavailable; ignore
    }
  };

  while (Date.now() < deadline) {
    const terminal = await fetchChildTerminal();
    if (!terminal) {
      await propagateChildProgress();
    }
    if (terminal) {
      // Idempotency guard: another watcher (e.g. a hydration-spawned twin
      // racing the original) may have already finalized this parent. Read
      // the durable cursor before mutating anything; if it's already
      // terminal, just refresh the in-memory mirror and bail so we don't
      // double-bump per-rule affectedCount or write a duplicate audit row.
      const alreadyFinalized = await isParentCursorTerminal(parentJobId);
      if (alreadyFinalized) {
        const refreshed = await getFilterRuleApplyJobState(parentJobId).catch(() => null);
        if (refreshed) frontFilterRuleApplyJobs.set(parentJobId, refreshed);
        return;
      }

      const state = frontFilterRuleApplyJobs.get(parentJobId);
      const summary = terminal.summary
        ?? `${terminal.succeeded} succeeded, ${terminal.failed} failed of ${terminal.totalSelected} (delegated to bulk job ${childBulkJobId}).`;
      if (state) {
        state.status = terminal.status;
        state.totalSelected = terminal.totalSelected || state.totalSelected;
        state.totalProcessed = terminal.totalProcessed;
        state.succeeded = terminal.succeeded;
        state.failed = terminal.failed;
        state.finalSummary = summary;
        state.updatedAt = Date.now();
        frontFilterRuleApplyJobs.set(parentJobId, state);
      }

      await persistRuleApplyAccounting(ruleId, terminal.succeeded);
      await persistRuleApplyCursor(parentJobId, {
        ruleId,
        status: terminal.status,
        totalSelected: terminal.totalSelected,
        totalProcessed: terminal.totalProcessed,
        succeeded: terminal.succeeded,
        failed: terminal.failed,
        childBulkJobId,
        finalSummary: summary,
        completedAt: new Date().toISOString(),
      });
      await writeAudit(
        "front_filter_rule_apply_completed",
        `Apply completed for rule ${rule.type}/${rule.scope}/${rule.value} — ${terminal.succeeded} succeeded / ${terminal.failed} failed (delegated to bulk job ${childBulkJobId})`,
        userId,
        {
          ruleId,
          jobId: parentJobId,
          childBulkJobId,
          succeeded: terminal.succeeded,
          failed: terminal.failed,
          totalProcessed: terminal.totalProcessed,
          summary,
        },
      );

      scheduleMirrorReap(parentJobId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CHILD_RECONCILE_POLL_MS));
  }

  // Timed out waiting for the child — mark parent as failed so operators see
  // the stuck state instead of a perpetually "running" job.
  const state = frontFilterRuleApplyJobs.get(parentJobId);
  const failureSummary = `Timed out after ${Math.round(CHILD_RECONCILE_TIMEOUT_MS / 60_000)}m waiting for bulk job ${childBulkJobId}.`;
  if (state) {
    state.status = "failed";
    state.finalSummary = failureSummary;
    state.updatedAt = Date.now();
    frontFilterRuleApplyJobs.set(parentJobId, state);
  }
  await persistRuleApplyCursor(parentJobId, {
    ruleId,
    status: "failed",
    totalSelected: state?.totalSelected ?? estimatedCount,
    totalProcessed: state?.totalProcessed ?? 0,
    succeeded: state?.succeeded ?? 0,
    failed: state?.failed ?? 0,
    childBulkJobId,
    finalSummary: failureSummary,
    completedAt: new Date().toISOString(),
  });
  await writeAudit(
    "front_filter_rule_apply_failed",
    `Apply timed out for rule ${rule.type}/${rule.scope}/${rule.value} — ${failureSummary}`,
    userId,
    { ruleId, jobId: parentJobId, childBulkJobId, reason: "child_reconcile_timeout" },
  );
  scheduleMirrorReap(parentJobId);
}

export async function getFilterRuleApplyJobState(jobId: string): Promise<ApplyJobState | null> {
  const memory = frontFilterRuleApplyJobs.get(jobId);
  if (memory) return memory;

  // Durable fallback: rebuild state from work_queue + cursor_json so apply
  // status survives a server restart and the 30-min mirror reap.
  try {
    const { getDb } = await import("../db");
    const { workQueue } = await import("@shared/schema");
    const { and, eq } = await import("drizzle-orm");
    const [row] = await getDb()
      .select({
        id: workQueue.id,
        status: workQueue.status,
        payload: workQueue.payload,
        cursorJson: workQueue.cursorJson,
        createdAt: workQueue.createdAt,
        updatedAt: workQueue.updatedAt,
        completedAt: workQueue.completedAt,
      })
      .from(workQueue)
      .where(and(
        eq(workQueue.id, jobId),
        eq(workQueue.queueName, "front_filter_rule_apply"),
      ))
      .limit(1);
    if (!row) return null;
    const rebuilt = rebuildApplyStateFromQueueRow(row);
    if (rebuilt) {
      // Re-seed the in-memory mirror so subsequent polls are cheap and the
      // /console/overview surface has the same view as the dedicated endpoint.
      frontFilterRuleApplyJobs.set(jobId, rebuilt);
      // Match the normal-completion lifecycle: terminal entries paged into
      // memory get the same 30-min reap timer the live handler / watcher
      // schedules, so heavy historical polling can't grow the mirror
      // unbounded.
      if (
        rebuilt.status === "complete"
        || rebuilt.status === "partial"
        || rebuilt.status === "failed"
      ) {
        scheduleMirrorReap(jobId);
      }
    }
    return rebuilt;
  } catch (err) {
    console.warn(`[FrontFilterRules] durable apply-status lookup failed for ${jobId}:`, (err as Error).message);
    return null;
  }
}

type PersistedApplyResult = {
  ruleId?: string;
  status?: ApplyJobState["status"];
  totalSelected?: number;
  totalProcessed?: number;
  succeeded?: number;
  failed?: number;
  childBulkJobId?: string | null;
  finalSummary?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePersistedApplyResult(cursorJson: unknown): PersistedApplyResult | null {
  if (!isRecord(cursorJson)) return null;
  const raw = cursorJson.result;
  if (!isRecord(raw)) return null;
  const out: PersistedApplyResult = {};
  if (typeof raw.ruleId === "string") out.ruleId = raw.ruleId;
  if (
    raw.status === "queued" ||
    raw.status === "running" ||
    raw.status === "complete" ||
    raw.status === "partial" ||
    raw.status === "failed"
  ) {
    out.status = raw.status;
  }
  if (typeof raw.totalSelected === "number") out.totalSelected = raw.totalSelected;
  if (typeof raw.totalProcessed === "number") out.totalProcessed = raw.totalProcessed;
  if (typeof raw.succeeded === "number") out.succeeded = raw.succeeded;
  if (typeof raw.failed === "number") out.failed = raw.failed;
  if (typeof raw.childBulkJobId === "string") out.childBulkJobId = raw.childBulkJobId;
  else if (raw.childBulkJobId === null) out.childBulkJobId = null;
  if (typeof raw.finalSummary === "string") out.finalSummary = raw.finalSummary;
  else if (raw.finalSummary === null) out.finalSummary = null;
  return out;
}

function rebuildApplyStateFromQueueRow(row: {
  id: string;
  status: string | null;
  payload: unknown;
  cursorJson: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
}): ApplyJobState | null {
  const payload: { ruleId?: unknown; userId?: unknown } = isRecord(row.payload) ? row.payload : {};
  const persisted = parsePersistedApplyResult(row.cursorJson);

  const ruleId = persisted?.ruleId
    ?? (typeof payload.ruleId === "string" ? payload.ruleId : "");
  if (!ruleId) return null;

  const startedBy = typeof payload.userId === "string" ? payload.userId : "system";
  const startedAt = (row.createdAt ?? new Date()).getTime();
  const updatedAt = (row.completedAt ?? row.updatedAt ?? row.createdAt ?? new Date()).getTime();

  let status: ApplyJobState["status"];
  if (persisted?.status) {
    status = persisted.status;
  } else {
    switch (row.status) {
      case "completed":
        status = "complete";
        break;
      case "failed":
      case "dead_letter":
      case "dead_lettered":
        status = "failed";
        break;
      case "processing":
      case "leased":
        status = "running";
        break;
      case "cancelled":
        status = "failed";
        break;
      case "pending":
        status = "queued";
        break;
      default:
        status = "queued";
    }
  }

  return {
    jobId: row.id,
    ruleId,
    status,
    startedAt,
    updatedAt,
    totalSelected: persisted?.totalSelected ?? 0,
    totalProcessed: persisted?.totalProcessed ?? 0,
    succeeded: persisted?.succeeded ?? 0,
    failed: persisted?.failed ?? 0,
    childBulkJobId: persisted?.childBulkJobId ?? null,
    finalSummary: persisted?.finalSummary ?? null,
    startedBy,
  };
}

/**
 * Rehydrate filter-rule apply jobs from the durable work_queue on startup.
 *
 * Two responsibilities:
 *  1. Re-seed the `frontFilterRuleApplyJobs` mirror so the live-status UI
 *     can poll just-restarted jobs without returning 404.
 *  2. Resume the child-bulk-job watcher for parents that delegated to a
 *     bulk job and were interrupted mid-watch by a restart. Without this
 *     the parent's cursor_json + audit + per-rule affectedCount accounting
 *     never reaches a terminal state.
 *
 * Idempotent: rehydrating an already-mirrored job is a no-op, and the
 * watcher itself bails out the moment the child reaches a terminal state
 * so a duplicate watcher is at worst wasted polling.
 */
export async function hydrateFilterRuleApplyJobs(): Promise<{
  rehydrated: number;
  watchersResumed: number;
  orphansFailed: number;
}> {
  let rehydrated = 0;
  let watchersResumed = 0;
  let orphansFailed = 0;

  try {
    const { getDb } = await import("../db");
    const { workQueue } = await import("@shared/schema");
    const { eq, desc, and, or, gt, sql } = await import("drizzle-orm");
    // Consider any row that could plausibly need rehydration:
    //   1. Anything non-terminal on the queue (parent still in flight).
    //   2. Anything whose persisted cursor result is still "running"/"queued"
    //      regardless of queue terminal state — this is the delegated-parent
    //      case where the queue row completed but a child bulk job (and the
    //      watcher) was interrupted before terminal accounting ran. Age is
    //      irrelevant here: an orphaned watcher from a week ago still needs
    //      to be resolved.
    //   3. Recently-completed parents (last 24h by updatedAt) so the mirror
    //      has a reasonable just-finished tail for UI continuity.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        id: workQueue.id,
        status: workQueue.status,
        payload: workQueue.payload,
        cursorJson: workQueue.cursorJson,
        createdAt: workQueue.createdAt,
        updatedAt: workQueue.updatedAt,
        completedAt: workQueue.completedAt,
      })
      .from(workQueue)
      .where(and(
        eq(workQueue.queueName, "front_filter_rule_apply"),
        or(
          sql`${workQueue.status} NOT IN ('completed','failed','dead_letter','dead_lettered','cancelled')`,
          sql`${workQueue.cursorJson} -> 'result' ->> 'status' IN ('running','queued')`,
          gt(workQueue.updatedAt, cutoff),
        ),
      ))
      .orderBy(desc(workQueue.createdAt))
      .limit(200);

    for (const row of rows) {
      const rebuilt = rebuildApplyStateFromQueueRow(row);
      if (!rebuilt) continue;
      if (!frontFilterRuleApplyJobs.has(rebuilt.jobId)) {
        frontFilterRuleApplyJobs.set(rebuilt.jobId, rebuilt);
        rehydrated++;
        // Match the normal-completion lifecycle: terminal entries
        // rehydrated into memory get the same 30-min reap timer the
        // live handler / watcher schedules, so the mirror stays
        // bounded in size across long-lived processes.
        if (
          rebuilt.status === "complete"
          || rebuilt.status === "partial"
          || rebuilt.status === "failed"
        ) {
          const reapId = rebuilt.jobId;
          scheduleMirrorReap(reapId);
        }
      }

      // If a parent delegated to a child bulk job and was still running at
      // restart, resume the watcher so terminal accounting eventually runs.
      if (rebuilt.status === "running" && rebuilt.childBulkJobId) {
        const rule = await getFilterRule(rebuilt.ruleId).catch(() => null);
        if (!rule) {
          // Rule was deleted — give up on this watcher and mark the parent
          // failed so the operator sees a terminal state.
          rebuilt.status = "failed";
          rebuilt.finalSummary = `Rule ${rebuilt.ruleId} no longer exists; apply job orphaned across restart.`;
          rebuilt.updatedAt = Date.now();
          frontFilterRuleApplyJobs.set(rebuilt.jobId, rebuilt);
          await persistRuleApplyCursor(rebuilt.jobId, {
            ruleId: rebuilt.ruleId,
            status: "failed",
            totalSelected: rebuilt.totalSelected,
            totalProcessed: rebuilt.totalProcessed,
            succeeded: rebuilt.succeeded,
            failed: rebuilt.failed,
            childBulkJobId: rebuilt.childBulkJobId,
            finalSummary: rebuilt.finalSummary,
            completedAt: new Date().toISOString(),
          });
          // Match the normal-completion lifecycle: orphan-terminalized
          // entries also get the 30-min reap timer.
          const reapId = rebuilt.jobId;
          scheduleMirrorReap(reapId);
          orphansFailed++;
          continue;
        }
        void watchChildBulkJob({
          parentJobId: rebuilt.jobId,
          ruleId: rebuilt.ruleId,
          rule: { type: rule.type, scope: rule.scope, value: rule.value },
          childBulkJobId: rebuilt.childBulkJobId,
          estimatedCount: rebuilt.totalSelected,
          userId: rebuilt.startedBy,
        });
        watchersResumed++;
      }
    }
  } catch (err) {
    console.warn("[FrontFilterRules] hydration failed:", (err as Error).message);
  }

  return { rehydrated, watchersResumed, orphansFailed };
}

/**
 * Returns the most recent ApplyJobState (queued/running/terminal) per ruleId.
 * Used by the admin UI to show live progress and post-completion totals on
 * each filter-rule card without having to remember the jobId across page
 * reloads.
 *
 * Sources, in priority order:
 *   1. The in-memory mirror (`frontFilterRuleApplyJobs`) for live progress.
 *   2. The most recent `work_queue` row per ruleId for that queue, rebuilt
 *      from `cursor_json`. This durable fallback survives mirror reap (30
 *      minutes after completion) and server restarts, so a manager who
 *      refreshes hours/days later still sees the last apply's totals.
 *
 * For each ruleId the entry with the newer `updatedAt` wins, so an in-flight
 * mirror state always beats stale durable history.
 */
export async function getLatestFilterRuleApplyJobsByRule(): Promise<Record<string, ApplyJobState>> {
  const latest: Record<string, ApplyJobState> = {};

  // 1. In-memory mirror
  for (const state of frontFilterRuleApplyJobs.values()) {
    const prior = latest[state.ruleId];
    if (!prior || state.updatedAt > prior.updatedAt) {
      latest[state.ruleId] = state;
    }
  }

  // 2. Durable fallback — most recent work_queue row per ruleId for the
  //    front_filter_rule_apply queue, rebuilt from cursor_json. Uses
  //    Postgres `DISTINCT ON` so the per-rule latest guarantee holds
  //    regardless of total historical row count (no scan/limit cap).
  try {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    type DurableRow = {
      id: string;
      status: string | null;
      payload: unknown;
      cursor_json: unknown;
      created_at: Date | string | null;
      updated_at: Date | string | null;
      completed_at: Date | string | null;
    };
    const result = await getDb().execute<DurableRow>(sql`
      SELECT DISTINCT ON (payload->>'ruleId')
             id, status, payload, cursor_json,
             created_at, updated_at, completed_at
      FROM work_queue
      WHERE queue_name = 'front_filter_rule_apply'
        AND payload ? 'ruleId'
      ORDER BY payload->>'ruleId',
               COALESCE(updated_at, created_at) DESC
    `);
    const toDate = (v: Date | string | null): Date | null => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    for (const row of result.rows) {
      const rebuilt = rebuildApplyStateFromQueueRow({
        id: row.id,
        status: row.status,
        payload: row.payload,
        cursorJson: row.cursor_json,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
        completedAt: toDate(row.completed_at),
      });
      if (!rebuilt) continue;
      const prior = latest[rebuilt.ruleId];
      if (!prior || rebuilt.updatedAt > prior.updatedAt) {
        latest[rebuilt.ruleId] = rebuilt;
      }
    }
  } catch (err) {
    console.warn(
      "[FrontFilterRules] durable apply-status lookup failed:",
      (err as Error).message,
    );
  }

  return latest;
}

// ---------- Prospective rule-hit accounting ----------
//
// When a rule fires at ingestion/matching time we want to bump the per-rule
// counter and last_applied_at so operators see live activity in the UI.
// We coalesce hits in-memory and flush asynchronously to avoid an UPDATE
// per email on the hot path. Each unique ruleId gets a single pending
// aggregate row plus a small buffer of recent-hit context rows that feed the
// per-rule drill-down (Task #1270).

export type RuleHitContext = {
  source: "sync_email" | "webhook";
  syncEmailId?: string | null;
  conversationId?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  ruleType?: FrontFilterRuleType | null;
};

type PendingHitAgg = {
  count: number;
  lastSeenAt: Date;
  contexts: Array<RuleHitContext & { createdAt: Date }>;
};

// We never buffer more than this many context rows per rule per flush — the
// aggregate counter still bumps by the full count, we just drop excess
// drill-down samples to keep memory bounded under bursts.
const MAX_BUFFERED_HIT_CONTEXTS_PER_RULE = 50;

const pendingHits = new Map<string, PendingHitAgg>();
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 5_000;

async function trimRuleHits(ruleId: string): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    // Keep the most recent MAX_RECENT_HITS_PER_RULE rows for this rule and
    // delete the rest. Runs lazily after each flush — at most a handful of
    // rows per call in steady state.
    await getDb().execute(sql`
      DELETE FROM ${frontFilterRuleHits}
      WHERE id IN (
        SELECT id FROM ${frontFilterRuleHits}
        WHERE rule_id = ${ruleId}
        ORDER BY created_at DESC
        OFFSET ${MAX_RECENT_HITS_PER_RULE}
      )
    `);
  } catch (err) {
    console.warn(`[FrontFilterRules] trim hits failed for ${ruleId}:`, (err as Error).message);
  }
}

async function flushPendingHits(): Promise<void> {
  flushTimer = null;
  if (pendingHits.size === 0) return;
  const snapshot = Array.from(pendingHits.entries());
  pendingHits.clear();
  try {
    const { getDb } = await import("../db"); const db = getDb();
    const { eq, sql } = await import("drizzle-orm");
    for (const [ruleId, { count, lastSeenAt, contexts }] of snapshot) {
      try {
        await db
          .update(frontFilterRules)
          .set({
            affectedCount: sql`${frontFilterRules.affectedCount} + ${count}`,
            lastAppliedAt: lastSeenAt,
            updatedAt: new Date(),
          })
          .where(eq(frontFilterRules.id, ruleId));

        if (contexts.length > 0) {
          await db.insert(frontFilterRuleHits).values(
            contexts.map((c) => ({
              ruleId,
              source: c.source,
              syncEmailId: c.syncEmailId ?? null,
              conversationId: c.conversationId ?? null,
              senderEmail: c.senderEmail ?? null,
              subject: c.subject ?? null,
              ruleType: c.ruleType ?? null,
              createdAt: c.createdAt,
            })),
          );
          await trimRuleHits(ruleId);
        }
      } catch (err) {
        console.warn(`[FrontFilterRules] flush hit failed for rule ${ruleId}:`, (err as Error).message);
        // Re-queue so we don't drop the increment.
        const existing = pendingHits.get(ruleId);
        if (existing) {
          existing.count += count;
          if (lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = lastSeenAt;
          for (const ctx of contexts) {
            if (existing.contexts.length >= MAX_BUFFERED_HIT_CONTEXTS_PER_RULE) break;
            existing.contexts.push(ctx);
          }
        } else {
          pendingHits.set(ruleId, { count, lastSeenAt, contexts });
        }
      }
    }
    // Hit-flush only bumps affected_count / last_applied_at + appends hit
    // rows — none of which the evaluation cache reads. Invalidating here meant
    // every ~5s flush during a reprocess forced a fresh enabled-rules SELECT
    // on the contended pool for no benefit; the admin list cache converges on
    // its own short TTL, so we deliberately invalidate nothing here.
  } catch (err) {
    console.warn(`[FrontFilterRules] flush pending hits failed:`, (err as Error).message);
  }
}

/**
 * Record a prospective rule fire — increments affected_count and updates
 * last_applied_at on the rule, and (when context is supplied) buffers a
 * recent-hit row that feeds the admin UI's drill-down. Coalesced and flushed
 * asynchronously.
 */
export function recordRuleHit(
  ruleId: string | null | undefined,
  context?: RuleHitContext,
): void {
  if (!ruleId) return;
  const now = new Date();
  let agg = pendingHits.get(ruleId);
  if (!agg) {
    agg = { count: 0, lastSeenAt: now, contexts: [] };
    pendingHits.set(ruleId, agg);
  }
  agg.count += 1;
  agg.lastSeenAt = now;
  if (context && agg.contexts.length < MAX_BUFFERED_HIT_CONTEXTS_PER_RULE) {
    agg.contexts.push({ ...context, createdAt: now });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      void flushPendingHits();
    }, FLUSH_INTERVAL_MS);
  }
}

/** Force-flush any pending rule-hit increments. Exposed for tests + shutdown. */
export async function flushPendingRuleHits(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPendingHits();
}

/**
 * Task #1270: list the most recent recorded hits for a rule. Used by the
 * Integrations Hub drill-down so operators can see exactly which conversations
 * a rule is catching. Bounded by MAX_RECENT_HITS_PER_RULE on the storage
 * side; callers may pass a smaller `limit` for the UI.
 */
export async function listRecentRuleHits(
  ruleId: string,
  limit = 25,
): Promise<FrontFilterRuleHit[]> {
  const safeLimit = Math.max(1, Math.min(limit, MAX_RECENT_HITS_PER_RULE));
  // Drain any buffered hits first so the drill-down reflects very recent
  // activity (the flush interval is otherwise 5s).
  await flushPendingRuleHits();
  const { getDb } = await import("../db");
  const { eq, desc } = await import("drizzle-orm");
  return await getDb()
    .select()
    .from(frontFilterRuleHits)
    .where(eq(frontFilterRuleHits.ruleId, ruleId))
    .orderBy(desc(frontFilterRuleHits.createdAt))
    .limit(safeLimit);
}
