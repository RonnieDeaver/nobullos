/**
 * Audit engine — orchestrates context build, checks, scoring, report assembly
 * (port of backend/app/audit/engine.py).
 */

import { AUDIT_CACHE_TTL_SECONDS, DEFAULT_LOOKBACK_DAYS } from "../config";
import { mccEnabledAccounts } from "../enrollment";
import { KeyedLocks } from "../singleflight";
import { putAuditScoreWithHistory } from "../store";
import { ALL_CHECKS } from "./checks";
import { impactLevel, impactWeight } from "./configLoader";
import {
  Status,
  compactNextSteps,
  type AuditReport,
  type CheckResult,
} from "./models";
import { buildContext } from "./context";
import { applyCaps, bandFor, buildCategories, evaluateCaps, overallScore } from "./scoring";
import { buildNextSteps } from "./summary";

export async function runAudit(customerId: string, lookbackDays?: number | null): Promise<AuditReport> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || DEFAULT_LOOKBACK_DAYS;

  let accountName = cid;
  let currency: string | null = null;
  try {
    const acct = (await mccEnabledAccounts()).get(cid);
    if (acct) {
      accountName = acct.name;
      currency = acct.currency;
    }
  } catch {
    // Account-name lookup is cosmetic — an MCC listing failure must not block the audit.
  }

  const ctx = await buildContext(cid, accountName, currency, lookback);

  // Run every check; an exception in one check must not sink the whole audit.
  const results: CheckResult[] = [];
  for (const [checkId, checkFn] of ALL_CHECKS) {
    try {
      results.push(checkFn(ctx));
    } catch (err) {
      ctx.warnings.push(`check ${checkId} errored: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        id: checkId,
        category: checkId.split("-")[0],
        name: checkId,
        status: Status.NA,
        score: null,
        weight: impactWeight(checkId),
        impact: impactLevel(checkId),
        value: "Check errored",
        evidence: [],
        recommendation: "",
      });
    }
  }

  const categories = buildCategories(results);
  const raw = overallScore(results);

  const checksById = new Map(results.map((r) => [r.id, r]));
  const [gates, cap] = evaluateCaps(checksById);
  const final = applyCaps(raw, cap);

  let [bandName, bandColor] = bandFor(final);
  const nextSteps = buildNextSteps(checksById, ctx);

  // Fully-paused account: the labeled set resolved to zero scannable
  // campaigns, so every check is N/A and the score is a meaningless 0. Report
  // "Inactive" with an explanation instead of an alarming 0/Critical.
  let scopeNote: string | null = null;
  if (ctx.scope_empty) {
    bandName = "Inactive";
    bandColor = "slate";
    scopeNote =
      "No active labeled campaigns in scope — all labeled campaigns are paused, ended, or dormant. Nothing to audit until a campaign is re-enabled.";
  }

  const report: AuditReport = {
    customer_id: cid,
    account_name: accountName,
    generated_at: new Date().toISOString(),
    lookback_days: lookback,
    raw_score: raw,
    final_score: final,
    band: bandName,
    band_color: bandColor,
    scope_note: scopeNote,
    gates_triggered: gates,
    next_steps: nextSteps,
    categories,
  };
  // Persist the score so the account dashboard can show "last audit" without
  // re-running, plus a compact next-steps snapshot for the client profile's
  // task summary.
  await putAuditScoreWithHistory(cid, {
    final_score: final,
    band: bandName,
    scope_note: scopeNote,
    generated_at: report.generated_at,
    next_steps: compactNextSteps(nextSteps),
  });
  return report;
}

// --- Simple in-memory cache (1-hour cache per account) ---
const cache = new Map<string, { at: number; report: AuditReport }>();
const locks = new KeyedLocks();

/** Return [report, fromCache]. TTL from AUDIT_CACHE_TTL_SECONDS. */
export async function runAuditCached(
  customerId: string,
  lookbackDays?: number | null,
  force = false,
): Promise<[AuditReport, boolean]> {
  const lookback = lookbackDays || DEFAULT_LOOKBACK_DAYS;
  const key = `${customerId.replace(/-/g, "").trim()}:${lookback}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): AuditReport | null => {
    const cached = cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  if (!force) {
    const report = hit();
    if (report !== null) return [report, true];
  }
  // Single-flight the (quota-costed) build: one caller builds while duplicates
  // wait, then re-check the now-warm cache instead of rebuilding.
  return locks.withLock(key, async () => {
    if (!force) {
      const report = hit();
      if (report !== null) return [report, true] as [AuditReport, boolean];
    }
    const report = await runAudit(customerId, lookback);
    // Evict expired entries so the map stays bounded across (cid, lookback) keys.
    for (const [k, v] of cache) if (Date.now() - v.at >= ttlMs) cache.delete(k);
    cache.set(key, { at: Date.now(), report });
    return [report, false] as [AuditReport, boolean];
  });
}

/** Test hook: reset the per-process report cache. */
export function __testResetAuditCache(): void {
  cache.clear();
}
