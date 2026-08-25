/* test-registration
{
  "name": "Ads OS client profile projection — combined pacing reuses Main Dashboard totals, Paused/Off verdicts come from one status document read, and shared status chips render the payload",
  "regression": true,
  "smoke": true,
  "smokeReason": "The profile must reuse the Main Dashboard pacing aggregate and show the same Paused/Off verdicts as the AM board. Fully stubbed with no DB/network; milliseconds.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-cp-chip-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/adsOs/ClientProfile.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3989 — the nightly Paused/Off verification on the Client Profile.
 *
 * (1) Payload propagation (server/services/adsOs/clientProfile.ts):
 *     buildClientProfile attaches each account's status_check from the
 *     ads_os_status_checks single-document batch, keyed "{product}:{cid}"
 *     (the AM Dashboard's convention, so both surfaces show the same
 *     verdict). Paused/Off accounts get their entry (or null when the batch
 *     has none); On accounts stay null EVEN when an entry exists for their
 *     key; an empty doc (check never ran / read failed) yields all-null
 *     without crashing. The doc is read exactly ONCE per profile build —
 *     no per-account gets, no extra Ads API calls.
 *
 * (2) Chip render from the payload: the profile hands its accounts'
 *     status_check straight to the shared AdsStatusChip — the very entries
 *     produced in (1) must render ✓ / ✗-with-campaign-names / bare-with-
 *     unreachable-tooltip. (The chip's full four-state matrix is locked by
 *     ads-os-am-chip-render.test.ts; here we prove the PAYLOAD entries
 *     drive it.)
 *
 * (3) Source scan: ClientProfile.tsx renders the shared AdsStatusChip fed by
 *     a.status_check, and the old mark-less local StatusChip is gone.
 *
 * Hermetic via tests/ads-os-cp-chip-hooks.mjs (combined dashboard, ClickUp
 * directory, client log and the store are all stubbed).
 */

process.env.NODE_ENV = "test";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Fixture: one client, four accounts covering every propagation case ──────
const CID_PAUSED_BAD = "1110001111"; // gads paused, ✗ mismatch entry
const CID_OFF_OK = "2220002222"; // lsa off, ✓ entry
const CID_ON = "3330003333"; // gads on — entry EXISTS but must stay null
const CID_PAUSED_NONE = "4440004444"; // lsa paused, no entry in the batch

const member = (product: "gads" | "lsa", cid: string, ads_status: string | null) => ({
  product,
  customer_id: cid,
  descriptive_name: `Acct ${cid}`,
  city: product === "lsa" ? "Springfield" : null,
  ads_status,
  currency_code: "USD",
  spend_30d: 0,
  spend_prev: 0,
  leads_30d: 0,
  leads_prev: 0,
  cpl_30d: null,
});

const g = ((globalThis as any).__cpChip = {} as Record<string, any>);
g.resp = {
  rows: [
    {
      client: "Fixture Law",
      doer: null,
      checker: null,
      currency_code: "USD",
      has_gads: true,
      has_lsa: true,
      spend_30d: 0,
      spend_prev: 0,
      leads_30d: 0,
      leads_prev: 0,
      cpl_30d: null,
      cpl_prev: null,
      pacing_budget: 3000,
      pacing_mtd: 2100,
      pacing_expected: 1500,
      pacing_pct: 40,
      pacing_hit: false,
      alerts: {
        critical: 1,
        high: 0,
        medium: 1,
        total: 2,
        needs_attention: true,
        items: [
          {
            severity: "critical",
            title: "Fixture alert",
            detail: "Canonical combined rollup",
            product: "gads",
            customer_id: CID_PAUSED_BAD,
            account: `Acct ${CID_PAUSED_BAD}`,
            deep_link: "/ads-os/gads/alerts",
            alerts_at: "2026-08-07T10:00:00.000Z",
          },
          {
            severity: "future-severity",
            title: "Future fixture",
            detail: "Listed but not counted",
            product: "lsa",
            customer_id: CID_OFF_OK,
            account: "Springfield",
            deep_link: null,
            alerts_at: "2026-08-07T10:01:00.000Z",
          },
        ],
        items_truncated: 0,
        accounts: [
          {
            product: "gads",
            customer_id: CID_PAUSED_BAD,
            account: `Acct ${CID_PAUSED_BAD}`,
            alerts_at: "2026-08-07T10:00:00.000Z",
          },
          {
            product: "lsa",
            customer_id: CID_OFF_OK,
            account: "Springfield",
            alerts_at: "2026-08-07T10:01:00.000Z",
          },
        ],
      },
      members: [
        member("gads", CID_PAUSED_BAD, "paused"),
        member("lsa", CID_OFF_OK, "off"),
        member("gads", CID_ON, "on"),
        member("lsa", CID_PAUSED_NONE, "paused"),
      ],
    },
  ],
};

const MISMATCH = {
  expected: "paused",
  matches: false,
  enabled_campaigns: 2,
  enabled_campaign_names: ["Commercial August 2026", "Brand Always-On"],
  checked_at: "2026-08-07T10:05:00.000Z",
};
const HOLDS = {
  expected: "off",
  matches: true,
  enabled_campaigns: 0,
  enabled_campaign_names: [],
  checked_at: "2026-08-07T10:05:00.000Z",
};
g.checkDoc = {
  generated_at: "2026-08-07T10:05:00.000Z",
  checks: {
    [`gads:${CID_PAUSED_BAD}`]: MISMATCH,
    [`lsa:${CID_OFF_OK}`]: HOLDS,
    // An entry for the On account: propagation must IGNORE it (On chips render
    // nothing, and a stale verdict on a re-enabled account would mislead).
    [`gads:${CID_ON}`]: { expected: "paused", matches: true, checked_at: "2026-08-07T10:05:00.000Z" },
  },
};

// ── Modules under test (AFTER fixture — hooks registered by setup.mjs) ───────
const { buildClientProfile } = await import("../server/services/adsOs/clientProfile");
const { AdsStatusChip } = await import("../client/src/pages/adsOs/components/StatusChip");

// ── (1) Payload propagation ──────────────────────────────────────────────────
console.log("phase 1: verdict propagation into the profile payload");
const profile = await buildClientProfile("Fixture Law");
assert.ok(profile, "profile built");
const byCid = Object.fromEntries(profile!.accounts.map((a: any) => [a.customer_id, a]));
assert.deepEqual(
  profile!.alerts,
  g.resp.rows[0].alerts,
  "profile reuses the canonical live Main rollup without rebuilding it",
);
passed++;
ok((g.alertDocReads ?? 0) === 0, "profile performs no redundant per-account alert document reads");
ok(profile!.alerts.needs_attention === true, "profile exposes the shared needs-attention qualification");
ok(profile!.alerts.items_truncated === 0, "profile exposes shared item-cap metadata");
ok(
  profile!.alerts.items[1].severity === "future-severity" &&
    profile!.alerts.items[1].alerts_at === "2026-08-07T10:01:00.000Z",
  "profile contract preserves unknown severity and item freshness",
);
ok(
  profile!.alerts.accounts[1].alerts_at === "2026-08-07T10:01:00.000Z",
  "profile contract exposes per-account freshness",
);

ok(g.statusDocReads === 1, "status-check doc read exactly ONCE per profile build");
assert.deepEqual(
  profile!.pacing.combined,
  {
    budget: 3000,
    mtd: 2100,
    used_pct: 70,
    expected_pct: 50,
    pace_pct: 40,
    budget_hit: false,
  },
  "profile combined pacing reuses the combined-dashboard aggregate verbatim",
);
passed++;
console.log("  ✓ profile combined pacing reuses the combined-dashboard aggregate verbatim");
assert.deepEqual(
  byCid[CID_PAUSED_BAD].status_check,
  MISMATCH,
  "paused account carries its ✗ entry verbatim (keyed product:cid)",
);
passed++;
console.log("  ✓ paused account carries its ✗ entry verbatim (keyed product:cid)");
assert.deepEqual(byCid[CID_OFF_OK].status_check, HOLDS, "off account carries its ✓ entry");
passed++;
console.log("  ✓ off account carries its ✓ entry");
ok(byCid[CID_ON].status_check === null, "On account stays null even though the doc HAS its key");
ok(byCid[CID_PAUSED_NONE].status_check === null, "paused account absent from the batch → null (never a guess)");

// Empty doc (check never ran / read degraded): all-null, no crash.
g.checkDoc = {};
g.statusDocReads = 0;
const bare = await buildClientProfile("Fixture Law");
ok(
  bare!.accounts.every((a: any) => a.status_check === null),
  "empty status doc → every account's status_check is null",
);
ok(g.statusDocReads === 1, "empty-doc build still exactly one doc read");

// ── (2) The payload entries drive the shared chip ────────────────────────────
console.log("phase 2: chip render from the profile payload");
const render = (a: any): string =>
  renderToStaticMarkup(
    createElement(AdsStatusChip as any, { status: a.ads_status, check: a.status_check ?? null, product: a.product }),
  );
const deent = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const bad = render(byCid[CID_PAUSED_BAD]);
ok(bad.includes("Paused ✗") && bad.includes("mismatch"), "payload ✗ entry renders the mismatch chip");
ok(deent(bad).includes("“Commercial August 2026”"), "✗ tooltip names the offending campaign from the payload");
ok(render(byCid[CID_OFF_OK]).includes("Off ✓"), "payload ✓ entry renders the verified chip");
ok(render(byCid[CID_ON]) === "", "On account renders no chip");
const none = render(byCid[CID_PAUSED_NONE]);
ok(none.includes(">Paused</button>") && deent(none).includes("Not verified yet"), "no-entry account renders bare + not-verified tooltip");

// Unreachable entry propagated through the same path renders bare + tooltip.
const err = render({
  ads_status: "paused",
  product: "gads",
  status_check: { expected: "paused", error: "PERMISSION_DENIED", checked_at: "2026-08-07T10:05:00.000Z" },
});
ok(err.includes(">Paused</button>") && deent(err).includes("couldn't reach this account"), "unreachable entry renders bare + explanatory tooltip");

// ── (3) Source scan: the profile page wires the shared chip ──────────────────
console.log("phase 3: ClientProfile.tsx wiring");
const src = readFileSync(new URL("../client/src/pages/adsOs/ClientProfile.tsx", import.meta.url), "utf8");
ok(/<AdsStatusChip\s[^>]*check=\{a\.status_check/.test(src.replace(/\n\s*/g, " ")), "tools rows render AdsStatusChip fed by a.status_check");
ok(/<AdsStatusChip\s[^>]*accountName=\{a\.name\}/.test(src.replace(/\n\s*/g, " ")), "tools rows pass accountName={a.name} to AdsStatusChip");
ok(!/function StatusChip\(/.test(src), "the old mark-less local StatusChip is gone");

console.log(`\nads-os-client-profile-status-chip: ${passed} assertion(s) passed.`);
