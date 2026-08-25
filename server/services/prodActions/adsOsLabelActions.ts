// @db-pool-intent: none
/**
 * Prod-action domain module — Task #4964: Ads OS monitor-label repair.
 *
 * Ten enrolled Google Ads accounts run active campaigns with ZERO
 * NBM_GADS_MONITOR_CAMPAIGN labels, so every label-scoped Ads OS surface
 * (combined dashboard, hygiene, pacing, traffic quality) silently renders
 * $0.00 for them. This action is the owner-approved repair: one press
 * ensures the monitor label exists in each ZERO-label account and applies
 * it to all active non-LSA campaigns there.
 *
 * Hard rules:
 *  - MANUAL LEVER: applying labels writes to client Google Ads accounts.
 *    The press is a deliberate individual operator decision — Apply-all
 *    skips it (audited synthetic not-needed) and it is never scheduled.
 *  - Partially-labeled accounts are INTENTIONAL scoping and are never
 *    touched: the shared classifier (labelCoverage.ts) only ever yields
 *    "zero" targets, and each target is re-classified FRESH inside its own
 *    drain chunk right before the write.
 *  - Idempotent: after a successful press, re-detection finds no zero-label
 *    accounts → not-needed. A timed-out mutate that actually landed drops
 *    the account from the next press's target set the same way.
 *  - Per-account failure isolation: one account's API failure records an
 *    audit tally and the drain moves on.
 */

import { type ProdAction, type ProdActionDomain } from "./kernel";
import {
  startBackgroundDrain,
  isDrainRunning,
  getDrainState,
  formatDrainProgress,
  type DrainState,
} from "../prodActionBackgroundDrain";
import {
  classifyEnrolledLabelCoverage,
  type AccountLabelCoverage,
} from "../adsOs/labelCoverage";
import { AdsOsCredsMissing } from "../adsOs/googleAdsClient";
import { KI_CAMPAIGN_LABEL } from "../adsOs/config";

const ACTION_ID = "apply_ads_os_monitor_labels";

// ── Injectable seams (tests stub the vendor + cache side effects) ──────────
export interface AdsOsLabelActionDeps {
  classify: () => Promise<AccountLabelCoverage[]>;
  ensureLabel: (cid: string, labelName: string) => Promise<string>;
  applyLabel: (
    cid: string,
    labelResourceName: string,
    campaignIds: string[],
  ) => Promise<unknown>;
  invalidateDashboardCache: () => void;
}

const defaultDeps: AdsOsLabelActionDeps = {
  classify: () => classifyEnrolledLabelCoverage(),
  ensureLabel: async (cid, labelName) => {
    const { ensureCampaignLabel } = await import("../googleAdsLabelMutate");
    return ensureCampaignLabel(cid, labelName);
  },
  applyLabel: async (cid, labelResourceName, campaignIds) => {
    const { applyLabelToCampaigns } = await import("../googleAdsLabelMutate");
    return applyLabelToCampaigns(cid, labelResourceName, campaignIds);
  },
  invalidateDashboardCache: () => {
    void import("../adsOs/combinedDashboardService").then((m) =>
      m.invalidateCombinedDashboardCache(),
    );
  },
};

let deps: AdsOsLabelActionDeps = { ...defaultDeps };

export function __setAdsOsLabelActionDepsForTest(
  overrides: Partial<AdsOsLabelActionDeps>,
): void {
  deps = { ...deps, ...overrides };
}
export function __resetAdsOsLabelActionDepsForTest(): void {
  deps = { ...defaultDeps };
}

// Status classification is 2 GAQL queries per enrolled account — too heavy to
// run on every CEO-panel poll. Cache the readout briefly; a press always
// re-classifies fresh inside the drain.
const STATUS_TTL_MS = 10 * 60 * 1000;
let _statusCache: { at: number; zero: AccountLabelCoverage[]; unknown: number } | null = null;

export function __resetAdsOsLabelStatusCacheForTest(): void {
  _statusCache = null;
}

async function zeroLabelReadout(): Promise<{ zero: AccountLabelCoverage[]; unknown: number }> {
  if (_statusCache && Date.now() - _statusCache.at < STATUS_TTL_MS) {
    return _statusCache;
  }
  const all = await deps.classify();
  const readout = {
    at: Date.now(),
    zero: all.filter((a) => a.coverage === "zero"),
    unknown: all.filter((a) => a.coverage === "unknown").length,
  };
  _statusCache = readout;
  return readout;
}

// Per-run audit trail (surfaced verbatim in the prod_action_runs detail via
// formatSummary — the operator reads exactly what was labeled where).
interface RunLogEntry {
  cid: string;
  name: string;
  labeled: string[]; // campaign ids labeled this run
  error?: string;
}
let _runQueue: AccountLabelCoverage[] = [];
let _runLog: RunLogEntry[] = [];

function summarize(state: DrainState): string {
  const parts = _runLog.map((e) =>
    e.error
      ? `${e.name} (${e.cid}): FAILED — ${e.error}`
      : `${e.name} (${e.cid}): labeled ${e.labeled.length} campaign(s) [${e.labeled.join(", ")}]`,
  );
  return (
    `Applied ${KI_CAMPAIGN_LABEL} in ${_runLog.filter((e) => !e.error).length} ` +
    `of ${state.totalAtStart} zero-label account(s). ` +
    (parts.length ? parts.join("; ") : formatDrainProgress(state))
  );
}

export const applyAdsOsMonitorLabelsAction: ProdAction = {
  id: ACTION_ID,
  title: "Apply Ads OS monitor labels to zero-label accounts",
  description:
    `Enrolled Google Ads accounts whose ACTIVE non-LSA campaigns carry zero ` +
    `${KI_CAMPAIGN_LABEL} labels render $0.00 across every Ads OS surface. ` +
    `This lever creates the label in each such account (if absent) and applies ` +
    `it to all active non-LSA campaigns. Partially-labeled accounts are ` +
    `intentional scoping and are never modified.`,
  change:
    "Writes to client Google Ads accounts: creates the monitor label where absent " +
    "and attaches it to active non-LSA campaigns in zero-label accounts only; " +
    "invalidates the combined-dashboard cache when the run finishes.",
  convergence: { kind: "converging" },
  // Deliberate individual press only: Apply-all records a synthetic
  // not-needed and never fires this (writes to client vendor accounts).
  manualLever: true,

  async status() {
    // Manual-lever convention (pinned by tests/prod-actions-routes.test.ts):
    // levers NEVER report "pending" — that state feeds the needs-attention
    // badge and the self-heal lane, and firing this action must stay a
    // deliberate operator decision. The backlog readout rides in `detail`;
    // the button lives in the panel's Manual levers section regardless.
    if (isDrainRunning(ACTION_ID)) {
      const s = getDrainState(ACTION_ID)!;
      return { state: "not-needed", working: true, detail: formatDrainProgress(s) };
    }
    let readout;
    try {
      readout = await zeroLabelReadout();
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) {
        return {
          state: "blocked",
          detail: "Google Ads credentials incomplete — connect the env trio first.",
          integration: "google-ads",
        } as const;
      }
      return { state: "error", detail: `Label-coverage readout failed: ${err?.message ?? err}` };
    }
    const unknownNote = readout.unknown
      ? ` (${readout.unknown} account(s) unreadable right now — excluded, never assumed zero)`
      : "";
    if (readout.zero.length === 0) {
      return {
        state: "not-needed",
        detail: `Every readable enrolled account has monitor labels${unknownNote}.`,
      };
    }
    // Backlog exists — still "not-needed" (lever convention, see above); the
    // detail names the accounts so the operator can decide to press.
    return {
      state: "not-needed",
      detail:
        `${readout.zero.length} enrolled account(s) with active campaigns and ZERO ` +
        `${KI_CAMPAIGN_LABEL} labels: ` +
        readout.zero.map((a) => `${a.descriptive_name} (${a.customer_id})`).join(", ") +
        unknownNote +
        " Press this lever to label them.",
    };
  },

  async apply(actorId) {
    const outcome = await startBackgroundDrain(
      {
        actionId: ACTION_ID,
        actionTitle: "Apply Ads OS monitor labels",
        attributionLabel: "prod-action:apply-ads-os-monitor-labels",
        unit: "account(s)",
        countPending: async () => {
          const all = await deps.classify();
          _runQueue = all.filter((a) => a.coverage === "zero");
          _runLog = [];
          _statusCache = null;
          return _runQueue.length;
        },
        runChunk: async () => {
          const acct = _runQueue.shift();
          if (!acct) return { processed: 0 };
          const key = `${acct.descriptive_name} (${acct.customer_id})`;
          try {
            // Re-guard inside the chunk: only ever write when the FRESH
            // classification (from countPending moments ago) says zero AND
            // there are campaigns to label. Partial accounts can never reach
            // here — the filter above only admits coverage === "zero".
            if (acct.coverage !== "zero" || acct.activeCampaignIds.length === 0) {
              return { processed: 1, perKey: { [`${key} — skipped`]: 1 } };
            }
            const labelRes = await deps.ensureLabel(acct.customer_id, KI_CAMPAIGN_LABEL);
            await deps.applyLabel(acct.customer_id, labelRes, acct.activeCampaignIds);
            _runLog.push({
              cid: acct.customer_id,
              name: acct.descriptive_name,
              labeled: acct.activeCampaignIds,
            });
            console.log(
              `[adsOsLabels] labeled ${acct.activeCampaignIds.length} campaign(s) in ` +
                `${key}: ${acct.activeCampaignIds.join(", ")}`,
            );
            return {
              processed: 1,
              perKey: { [key]: acct.activeCampaignIds.length },
            };
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            _runLog.push({
              cid: acct.customer_id,
              name: acct.descriptive_name,
              labeled: [],
              error: msg,
            });
            console.warn(`[adsOsLabels] FAILED for ${key}: ${msg}`);
            return { processed: 1, perKey: { [`${key} — FAILED`]: 1 } };
          } finally {
            if (_runQueue.length === 0) {
              // Last account attempted: drop the stale $0 builds so the fixed
              // accounts show real numbers on the next dashboard read.
              _statusCache = null;
              try {
                deps.invalidateDashboardCache();
              } catch {
                /* cache invalidation is best-effort — TTL is the backstop */
              }
            }
          }
        },
        formatSummary: summarize,
      },
      actorId ?? null,
    );

    if (outcome.state === "nothing-to-do") {
      return {
        state: "not-needed",
        detail: "No zero-label enrolled accounts — nothing to relabel.",
      };
    }
    return { state: "applied", detail: outcome.detail };
  },
};

export const adsOsLabelDomain: ProdActionDomain = {
  name: "adsOsLabels",
  actions: [applyAdsOsMonitorLabelsAction],
};
