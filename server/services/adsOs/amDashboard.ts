/**
 * AM Dashboard — one launch card per client, for an ads manager's whole book.
 *
 * Port of the reference app's am_dashboard.py (Juan Antoniazzi's "Client
 * Dashboard" prototype, Aug 2026 handoff — Task #3988). It replaces browser
 * bookmarks as the daily entry point into client accounts: each card carries a
 * direct-launch button for every Google Ads / LSA account the client owns plus
 * its Client Log, filterable by Doer (the "ads manager"), Checker, platform
 * and a name-or-CID search.
 *
 * Where the prototype ran from a hand-maintained JSON manifest, this builds
 * the roster LIVE from the ClickUp Client List the rest of Ads OS already
 * reads — so new clients and accounts appear automatically, owners never
 * drift, and offboarded clients drop out.
 *
 * The one thing ClickUp does NOT hold is the launch URL. The handoff's central
 * finding (verified across ~40 accounts): a working Google Ads deep link needs
 * an `ocid` — and an LSA link a `cid` — that is an opaque Google value with NO
 * derivable relationship to the Customer ID. URLs can only be captured by a
 * human opening the account once. Hence:
 *
 *   1. amDeeplinksSeed.ts ships the 46 URLs collected for the prototype,
 *      keyed "product:cid" — the seed.
 *   2. Any ClickUp subtask custom field whose name contains "account link" /
 *      "deep link" overrides the seed (clickUpDirectory.clickUpDeepLinks) —
 *      the handoff's recommended end state, live the moment the team adds
 *      such fields. No config change needed.
 *   3. An account with neither renders on the dashboard without a launch
 *      button (its CID and client links still show) — never a guessed URL,
 *      which would silently open the wrong account.
 *
 * Read-only everywhere: one directory read (already cached ~10 min) + two
 * store reads, no Google Ads API calls.
 */

import { AM_DEEPLINKS_SEED } from "./amDeeplinksSeed";
import {
  adsStatusFor,
  clientBlocks,
  clientRecord,
  clickUpDeepLinks,
  lsaCityFor,
  normClientName,
} from "./clickUpDirectory";
import { resolvePaidSearchRoleOverlays } from "./paidSearchRoleCutover";
import { getStatusCheckDoc, loadAlertsMap } from "./store";
import {
  normalizeClientAlertSummary,
  type ClientAlertContribution,
} from "./clientAlertRollup";
import type { StatusCheckEntry } from "./statusCheck";
import type { ClientAlertSummary, Product } from "./types";

// Task #5157 test seam: role-overlay resolver called through this indirection
// so a test can substitute a spy/fake without pulling the NoBull cutover DB in.
type RoleOverlayResolver = typeof resolvePaidSearchRoleOverlays;
let _roleOverlayResolver: RoleOverlayResolver = resolvePaidSearchRoleOverlays;
export function __setRoleOverlayResolverForTest(fn: RoleOverlayResolver | null): void {
  _roleOverlayResolver = fn ?? resolvePaidSearchRoleOverlays;
}

export interface AmAccount {
  product: Product;
  customer_id: string;
  label: string;
  ads_status: string;
  deep_link: string | null;
  status_check: StatusCheckEntry | null;
}

export interface AmClient {
  client: string;
  doer: string | null;
  checker: string | null;
  log_url: string | null;
  accounts: AmAccount[];
  alerts: ClientAlertSummary;
}

export interface AmDashboardPayload {
  clients: AmClient[];
  managers: string[];
  checkers: string[];
  clickup_ok: boolean;
  status_checked_at: string | null;
  generated_at: string;
}

let _seedLinks: Record<string, string> | null = null;

/** The shipped launch-URL seed, scheme-filtered. Same http(s)-only rule as the
 *  ClickUp capture: these become hrefs, and a future edit to the seed module
 *  must not be able to smuggle another scheme into one. */
function seedLinks(): Record<string, string> {
  if (_seedLinks) return _seedLinks;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(AM_DEEPLINKS_SEED)) {
    const url = String(v).trim();
    const lower = url.toLowerCase();
    if (lower.startsWith("https://") || lower.startsWith("http://")) out[String(k)] = url;
  }
  _seedLinks = out;
  return out;
}

/** Test hook: re-run the seed scheme filter on next read. */
export function __testResetSeedLinks(): void {
  _seedLinks = null;
}

/**
 * The whole dashboard payload, from the cached ClickUp directory.
 *
 * Clients sorted by name. ALL enrolled accounts show — including Ads Status =
 * Off (long-term paused): ads managers want the full book visible with the
 * status labelled, and each Paused/Off chip carries the morning verification's
 * ✓/✗ (status_check — see statusCheck.ts).
 *
 * Each client also carries its rolled-up account alerts (the card's ⚠ badge).
 * Both overlays are pure STORE reads — still no Google Ads API calls on this
 * route; the figures come from whatever the morning cron (or a Refresh on any
 * board) last wrote.
 */
export async function buildAmDashboard(): Promise<AmDashboardPayload> {
  const blocks = await clientBlocks();
  const cuLinks = await clickUpDeepLinks();
  const seed = seedLinks();
  // ONE read for the verdicts AND for "when did this last run" — two gets of
  // the same document can tear, and the UI presents the pair as a single claim
  // (the "not verified yet" banner beside chips that may already carry a ✓).
  const checkDoc = await getStatusCheckDoc();
  const checks: Record<string, StatusCheckEntry> = checkDoc.checks || {};
  // Every account's alerts in ONE round trip; per-account reads would be ~75
  // serial queries on the app's daily entry point.
  const alertMap = await loadAlertsMap(
    blocks.flatMap((blk) =>
      (["gads", "lsa"] as Product[]).flatMap((product) =>
        (product === "gads" ? blk.gads_cids : blk.lsa_cids).map((cid) => ({ product, cid })),
      ),
    ),
  );

  const clients: AmClient[] = [];
  const sorted = [...blocks].sort((a, b) => {
    const an = (a.name || "").toLowerCase();
    const bn = (b.name || "").toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  // Task #5157: fetch all client records in parallel (directory already cached
  // ~10 min), then batch-resolve role overlays in ONE call — not one DB read
  // per client. Keep ClickUp log_url canonical (not touched by the resolver).
  // Legacy doer/checker are preserved when the resolver returns no entry.
  const recs = await Promise.all(
    sorted.map((blk) => {
      const name = blk.name || "";
      return clientRecord(name).then((r) => r ?? { name, doer: null, checker: null, log_url: null });
    }),
  );
  const resolverInputs = sorted.map((_blk, i) => ({
    clientName: recs[i].name,
    legacyDoer: recs[i].doer,
    legacyChecker: recs[i].checker,
  }));
  const overlays = await _roleOverlayResolver(resolverInputs);

  for (let bi = 0; bi < sorted.length; bi++) {
    const blk = sorted[bi];
    const name = blk.name || "";
    const rec = recs[bi];
    const overlay = overlays.get(normClientName(rec.name));
    const doer = overlay ? overlay.doer : rec.doer;
    const checker = overlay ? overlay.checker : rec.checker;
    const accounts: AmAccount[] = [];
    const alertContributions: ClientAlertContribution[] = [];
    for (const product of ["gads", "lsa"] as Product[]) {
      for (const cid of product === "gads" ? blk.gads_cids : blk.lsa_cids) {
        const status = (await adsStatusFor(product, cid)) || "on";
        const city = product === "lsa" ? await lsaCityFor(cid) : null;
        const key = `${product}:${cid}`;
        const link = cuLinks[product]?.[cid] || seed[key] || null;
        // The prototype's label convention: LSA accounts read "LSA - City"
        // since a client can hold one per city.
        const label = product === "gads" ? "Google Ads" : city ? `LSA - ${city}` : "LSA";
        accounts.push({
          product,
          customer_id: cid,
          label,
          ads_status: status,
          deep_link: link,
          // The morning verification result for Paused/Off claims (null for On
          // accounts, or when the check hasn't run yet).
          status_check: status === "paused" || status === "off" ? (checks[key] ?? null) : null,
        });
        alertContributions.push({
          product,
          customer_id: cid,
          account: label,
          document: alertMap[`${product}:${cid.replace(/[^0-9]/g, "")}`] ?? null,
        });
      }
    }
    if (accounts.length === 0) continue;
    clients.push({
      client: name,
      doer,
      checker,
      log_url: rec.log_url,
      accounts,
      alerts: normalizeClientAlertSummary(alertContributions),
    });
  }

  // Filter options derive from the data (the prototype hardcoded a TEAM array,
  // which meant a roster change silently broke its dropdowns).
  const lowerSort = (a: string, b: string) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  };
  const managers = [...new Set(clients.map((c) => c.doer).filter((d): d is string => !!d))].sort(lowerSort);
  const checkers = [...new Set(clients.map((c) => c.checker).filter((d): d is string => !!d))].sort(lowerSort);

  return {
    clients,
    managers,
    checkers,
    clickup_ok: blocks.length > 0,
    // When the Paused/Off verification last ran. null = never — every chip is
    // bare for a reason the UI can then explain instead of looking merely broken.
    status_checked_at: checkDoc.generated_at ?? null,
    generated_at: new Date().toISOString(),
  };
}
