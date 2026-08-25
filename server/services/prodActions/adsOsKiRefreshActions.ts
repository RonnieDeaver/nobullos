// @db-pool-intent: none
/**
 * Prod-action domain module — Task #4962: Refresh stale KI traffic-quality snapshots.
 *
 * Traffic-quality snapshots persisted before the GAQL multi-segment aggregation
 * fix may carry under-counted clicks/cost for search terms that spanned multiple
 * segments. Those snapshots feed the New Keywords cross-check and dashboard
 * wasted-spend figures until they expire (30 days) or are overwritten. This
 * one-press action force-re-runs the Search Term Analyzer for every enrolled
 * Google Ads account, replacing any stale snapshots immediately.
 *
 * Hard rules:
 *  - MANUAL LEVER: the analyzer makes real Google Ads GAQL requests and OpenAI
 *    review calls per account. The press is a deliberate operator decision —
 *    Apply-all skips it (audited synthetic not-needed) and it is never scheduled.
 *  - Per-account failure isolation: one account's API failure records an audit
 *    tally and the drain moves on; other accounts are unaffected.
 *  - Force-refresh semantics: `runKeywordIntelCached(..., force=true)` bypasses
 *    the 1-hour in-process cache AND single-flights through the full pipeline,
 *    ending with a fresh `saveTrafficQuality` write for the account.
 *  - Idempotent: re-pressing after a successful run simply re-runs the analyzer
 *    again (fresh snapshots are replaced with equally-fresh snapshots; harmless).
 */

import { type ProdAction, type ProdActionDomain } from "./kernel";
import {
  startBackgroundDrain,
  isDrainRunning,
  getDrainState,
  formatDrainProgress,
  type DrainState,
} from "../prodActionBackgroundDrain";
import { enrolledAccounts, type EnrolledAccount } from "../adsOs/enrollment";
import { AdsOsCredsMissing } from "../adsOs/googleAdsClient";
import { runKeywordIntelCached } from "../adsOs/keywordIntel/engine";

const ACTION_ID = "refresh_ki_traffic_quality_snapshots";
type KiRefreshResult = Awaited<ReturnType<typeof runKeywordIntelCached>>;

// ── Injectable seams (tests stub network + OpenAI side-effects) ────────────
export interface AdsOsKiRefreshActionDeps {
  listAccounts: () => Promise<EnrolledAccount[]>;
  refreshAccount: (cid: string, force: boolean) => Promise<KiRefreshResult>;
}

const defaultDeps: AdsOsKiRefreshActionDeps = {
  listAccounts: () => enrolledAccounts("gads"),
  refreshAccount: (cid, force) => runKeywordIntelCached(cid, null, force),
};

let deps: AdsOsKiRefreshActionDeps = { ...defaultDeps };

export function __setAdsOsKiRefreshActionDepsForTest(
  overrides: Partial<AdsOsKiRefreshActionDeps>,
): void {
  deps = { ...deps, ...overrides };
}
export function __resetAdsOsKiRefreshActionDepsForTest(): void {
  deps = { ...defaultDeps };
}

// Per-run state (reset in countPending so each press starts clean).
let _runQueue: EnrolledAccount[] = [];

interface RunEntry {
  cid: string;
  name: string;
  ok: boolean;
  error?: string;
}
let _runLog: RunEntry[] = [];

/**
 * A label-less account is a normal outcome from Keyword Intel, but it has not
 * produced the snapshot this manual action promised to refresh. Keep the
 * distinction visible in the per-account audit tally while allowing the drain
 * to continue through the remaining enrolled accounts.
 */
function ineligibleReportError(result: KiRefreshResult): string | null {
  if (result.report.eligible !== false) return null;
  return result.report.scope_note.trim()
    ? result.report.scope_note
    : "Keyword Intel reported this account as ineligible; no snapshot was written.";
}

function summarize(state: DrainState): string {
  const succeeded = _runLog.filter((e) => e.ok);
  const failed = _runLog.filter((e) => !e.ok);
  const parts: string[] = [];
  if (failed.length) {
    parts.push(
      `Failed: ${failed.map((e) => `${e.name} (${e.cid}) — ${e.error}`).join("; ")}`,
    );
  }
  if (succeeded.length) {
    parts.push(`Refreshed: ${succeeded.map((e) => `${e.name} (${e.cid})`).join(", ")}`);
  }
  return (
    `Re-ran Search Term Analyzer for ${succeeded.length} of ${state.totalAtStart} ` +
    `enrolled account(s). ` +
    (parts.length ? parts.join(". ") : formatDrainProgress(state))
  );
}

export const refreshKiTrafficQualitySnapshotsAction: ProdAction = {
  id: ACTION_ID,
  title: "Refresh KI traffic-quality snapshots (force re-run)",
  description:
    "Traffic-quality snapshots persisted before the GAQL multi-segment aggregation " +
    "fix may carry under-counted clicks/cost for terms that spanned multiple segments. " +
    "This lever force-re-runs the Search Term Analyzer for every enrolled Google Ads " +
    "account, replacing any stale snapshots immediately instead of waiting for them to " +
    `expire (30-day TTL) or be overwritten by organic tool usage.`,
  change:
    "Runs the full keyword-intel pipeline (Google Ads GAQL queries + OpenAI review) " +
    "for each enrolled account with force=true, writing fresh traffic-quality snapshots " +
    "to ads_os_traffic_quality. No Google Ads account data is mutated.",
  convergence: { kind: "converging" },
  // Deliberate individual press only: runs real GAQL + OpenAI calls per account.
  // Apply-all records a synthetic not-needed and never fires this.
  manualLever: true,

  async status() {
    // Manual-lever convention: levers NEVER report "pending" — the backlog
    // readout rides in `detail`; the button lives in the Manual levers section
    // regardless. The operator decides when to press.
    if (isDrainRunning(ACTION_ID)) {
      const s = getDrainState(ACTION_ID)!;
      return { state: "not-needed", working: true, detail: formatDrainProgress(s) };
    }

    let accounts: EnrolledAccount[];
    try {
      accounts = await deps.listAccounts();
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) {
        return {
          state: "blocked",
          detail: "Google Ads credentials incomplete — connect the env trio first.",
          integration: "google-ads",
        } as const;
      }
      return {
        state: "error",
        detail: `Enrollment lookup failed: ${err?.message ?? err}`,
      };
    }

    if (accounts.length === 0) {
      return {
        state: "not-needed",
        detail:
          "No enrolled Google Ads accounts found — nothing to refresh.",
      };
    }

    return {
      state: "not-needed",
      detail:
        `${accounts.length} enrolled account(s): ` +
        accounts.map((a) => `${a.name} (${a.cid})`).join(", ") +
        ". Press to force-refresh all traffic-quality snapshots " +
        "(replaces any snapshots that captured pre-fix under-counted metrics).",
    };
  },

  async apply(actorId) {
    const outcome = await startBackgroundDrain(
      {
        actionId: ACTION_ID,
        actionTitle: "Refresh KI traffic-quality snapshots",
        attributionLabel: "prod-action:refresh-ki-traffic-quality-snapshots",
        unit: "account(s)",
        countPending: async () => {
          const accounts = await deps.listAccounts();
          _runQueue = [...accounts];
          _runLog = [];
          return _runQueue.length;
        },
        runChunk: async () => {
          const acct = _runQueue.shift();
          if (!acct) return { processed: 0 };
          const key = `${acct.name} (${acct.cid})`;
          const recordFailure = (message: string) => {
            _runLog.push({
              cid: acct.cid,
              name: acct.name,
              ok: false,
              error: message,
            });
            console.warn(`[adsOsKiRefresh] FAILED for ${key}: ${message}`);
            return { processed: 1, perKey: { [`${key} — FAILED`]: 1 } };
          };
          try {
            const result = await deps.refreshAccount(acct.cid, true);
            const ineligibleError = ineligibleReportError(result);
            if (ineligibleError) return recordFailure(ineligibleError);
            _runLog.push({ cid: acct.cid, name: acct.name, ok: true });
            console.log(`[adsOsKiRefresh] refreshed snapshot for ${key}`);
            return { processed: 1, perKey: { [key]: 1 } };
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            return recordFailure(msg);
          }
        },
        formatSummary: summarize,
      },
      actorId ?? null,
    );

    if (outcome.state === "nothing-to-do") {
      return {
        state: "not-needed",
        detail: "No enrolled Google Ads accounts — nothing to refresh.",
      };
    }
    return { state: "applied", detail: outcome.detail };
  },
};

export const adsOsKiRefreshDomain: ProdActionDomain = {
  name: "adsOsKiRefresh",
  actions: [refreshKiTrafficQualitySnapshotsAction],
};
