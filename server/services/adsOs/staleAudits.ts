/**
 * Ads OS — "Run stale audits" batch refresh (port of dashboard.py
 * run_stale_audits + the LSA equivalent).
 *
 * Runs hygiene audits for every monitored account whose persisted score is
 * missing or older than STALE_DAYS. Synchronous on purpose (work happens
 * inside the request, bounded by the route deadline); each audit persists its
 * own score, and the dashboards' live overlay shows it on the next load.
 */

import { monitoredAccounts } from "./enrollment";
import { mapPool } from "./singleflight";
import { auditScoresStore, lsaAuditScoresStore } from "./store";
import { runAuditCached } from "./audit/engine";
import { runLsaHygieneCached } from "./lsaHygieneEngine";

/** A hygiene score older than this counts as stale. */
export const STALE_DAYS = 7;

/** True if there's no score, or it's older than STALE_DAYS. */
export function isStale(generatedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!generatedAt) return true;
  const ts = Date.parse(generatedAt);
  if (!Number.isFinite(ts)) return true;
  return now - ts > STALE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * True for a persisted score written for a fully-paused account (band
 * "Inactive" — no scannable labeled campaigns). Those are treated as
 * always-fresh by the stale sweep: there is nothing to audit, so re-running
 * them just burns quota. They refresh when someone opens the report page.
 */
export function isInactiveScore(score: Record<string, any>): boolean {
  return score.band === "Inactive";
}

async function runStale(
  product: "gads" | "lsa",
  store: { get(key: string): Promise<Record<string, any> | null> },
  runOne: (cid: string) => Promise<unknown>,
): Promise<{ requested: number; ran: number }> {
  const accounts = await monitoredAccounts(product);
  const todo: string[] = [];
  for (const acct of accounts) {
    const score = (await store.get(acct.cid)) ?? {};
    if (isInactiveScore(score)) continue; // fully-paused account — always fresh
    if (isStale(score.generated_at)) todo.push(acct.cid);
  }

  let ran = 0;
  if (todo.length) {
    // Pool of 4; one bad account must not stop the rest (mapPool propagates
    // rejections, so each item catches its own).
    const results = await mapPool(todo, 4, async (cid) => {
      try {
        await runOne(cid);
        return true;
      } catch {
        return false;
      }
    });
    ran = results.filter(Boolean).length;
  }
  return { requested: todo.length, ran };
}

/** GAds: audit every monitored account whose score is missing or stale. */
export async function runStaleAudits(): Promise<{ requested: number; ran: number }> {
  return runStale("gads", auditScoresStore, (cid) => runAuditCached(cid, null, true));
}

/** LSA: hygiene for every monitored account whose score is missing or stale. */
export async function runStaleLsaAudits(): Promise<{ requested: number; ran: number }> {
  return runStale("lsa", lsaAuditScoresStore, (cid) => runLsaHygieneCached(cid, null, true));
}
