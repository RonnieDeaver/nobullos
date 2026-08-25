/* test-registration
{
  "name": "Ads OS alerts UI helpers — account/client attention counts, shared client alert details and generic account alert rendering, staleness, safe links, and zero-enrollment notices",
  "regression": true,
  "smoke": true,
  "smokeReason": "Ads OS alert scan semantics and shared renderers are fast, deterministic UI contracts; drift can inflate portfolio counts, hide high-CPL alerts, or make unsafe/ambiguous alert disclosures.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3685 — Ads OS alerts UI display semantics (spec §9, §13.2/§13.11).
 *
 * Locks the pure helpers and shared renderers the dashboards hang the alert
 * contract on:
 *
 *   (A) needsAttention / countNeedsAttention: "Need attention" counts ROWS
 *       with ≥1 critical or high alert — never the number of alerts, and
 *       medium-only rows are excluded (they keep a grey badge but must not
 *       inflate the tile or the "Needs attention only" filter). Shared by the
 *       GAds + LSA dashboards via lib/alerts.ts so tile/filter/row-marker
 *       can't drift apart (§14.7 is the failure this guards against).
 *
 *   (B) alertsStaleDays: records not refreshed within 48h (two missed daily
 *       cycles) dim with the ⧗ marker showing whole-day age; a missing or
 *       unparsable timestamp is "not yet checked" (null), NOT stale — the
 *       target is the frozen-after-success case, not never-run accounts.
 *
 *   (C) zeroAccountNotice: a Refresh whose recompute resolves 0 enrolled
 *       accounts for ANY product it covered surfaces that product by name
 *       (§14) — a partial combined recompute must not pass for fresh — while
 *       per-product dashboards stay scoped to their own product (per-product
 *       run summaries report the un-requested product as 0 by design).
 *
 * Hermetic: pure helpers + server-side React rendering only — no DOM, fetch,
 * database, or server.
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clientAlertCounts,
  clientNeedsAttention,
  countClientsNeedingAttention,
  needsAttention,
  countNeedsAttention,
  sortedClientAlertItems,
  zeroAccountNotice,
} from "../../client/src/pages/adsOs/lib/alerts";
import {
  AlertList,
  alertsStaleDays,
} from "../../client/src/pages/adsOs/components/AlertBadge";
import {
  ClientAlertItems,
  ClientAlertMenu,
  safeAlertDeepLink,
} from "../../client/src/pages/adsOs/components/ClientAlertMenu";
import type {
  Alert,
  ClientAlertItem,
  ClientAlertSummary,
} from "../../client/src/pages/adsOs/lib/types";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const mk = (severity: Alert["severity"], code = `c_${severity}`): Alert => ({
  code,
  severity,
  title: `T ${code}`,
  detail: "",
  product: "gads",
  campaign_id: null,
  deep_link: null,
  clickup_task: null,
});

const clientItem = (
  product: ClientAlertItem["product"],
  severity: string | null,
  title: string,
  deepLink: string | null = null,
): ClientAlertItem => ({
  severity,
  title,
  detail: `${title} detail`,
  product,
  customer_id: product === "gads" ? "111-111-1111" : "222-222-2222",
  account: product === "gads" ? "North account" : "LSA - Austin",
  deep_link: deepLink,
  alerts_at: "2026-08-22T12:00:00.000Z",
});

const clientSummary = (
  critical: number,
  high: number,
  medium: number,
  items: ClientAlertItem[],
): ClientAlertSummary => ({
  critical,
  high,
  medium,
  total: critical + high + medium,
  needs_attention: critical + high > 0,
  items,
  items_truncated: 0,
  accounts: [],
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("A) needsAttention — row qualifies on ≥1 critical/high, medium-only excluded");
{
  assert.equal(needsAttention({ alerts: [mk("critical")] }), true);
  assert.equal(needsAttention({ alerts: [mk("high")] }), true);
  assert.equal(needsAttention({ alerts: [mk("medium")] }), false);
  assert.equal(needsAttention({ alerts: [mk("medium"), mk("medium", "c2")] }), false);
  assert.equal(needsAttention({ alerts: [mk("medium"), mk("high")] }), true);
  assert.equal(needsAttention({ alerts: [] }), false);
  ok("critical/high qualify; medium-only and empty rows never do");
}

{
  // Rows, not alerts: a row with three criticals still counts once; the
  // medium-only row contributes zero even though it carries alerts.
  const rows = [
    { alerts: [mk("critical"), mk("critical", "c2"), mk("critical", "c3")] },
    { alerts: [mk("medium")] },
    { alerts: [mk("high"), mk("medium", "m2")] },
    { alerts: [] as Alert[] },
  ];
  assert.equal(countNeedsAttention(rows), 2);
  assert.equal(countNeedsAttention([]), 0);
  const alertTotal = rows.reduce((n, r) => n + r.alerts.length, 0);
  assert.equal(alertTotal, 6); // sanity: counting alerts instead would read 6 (or 4 crit/high)
  ok("tile counts qualifying ROWS (2), not alerts (6) nor critical/high alerts (4)");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("B) client rollups — count clients, exclude medium-only, tolerate legacy payloads");
{
  const critical = clientSummary(
    2,
    0,
    1,
    [
      clientItem("gads", "medium", "Medium"),
      clientItem("gads", "critical", "Critical"),
      clientItem("gads", "critical", "Critical two"),
    ],
  );
  const high = clientSummary(0, 1, 0, [clientItem("lsa", "high", "High CPL")]);
  const medium = clientSummary(0, 0, 2, [
    clientItem("gads", "medium", "Medium one"),
    clientItem("lsa", "medium", "Medium two"),
  ]);
  const empty = clientSummary(0, 0, 0, []);

  assert.equal(clientNeedsAttention(critical), true);
  assert.equal(clientNeedsAttention(high), true);
  assert.equal(clientNeedsAttention(medium), false);
  assert.equal(clientNeedsAttention(empty), false);
  assert.equal(clientNeedsAttention(undefined), false);
  assert.equal(countClientsNeedingAttention([
    { alerts: critical },
    { alerts: high },
    { alerts: medium },
    { alerts: empty },
    {},
  ]), 2);
  assert.deepEqual(clientAlertCounts(critical), {
    critical: 2,
    high: 0,
    medium: 1,
    total: 3,
    attention: 2,
  });
  assert.deepEqual(
    sortedClientAlertItems(critical).map((item) => item.severity),
    ["critical", "critical", "medium"],
  );
  ok("portfolio count is per qualifying client; medium-only/empty/missing stay out");
}

{
  const legacyItemsOnly = {
    items: [clientItem("lsa", "high", "Legacy high CPL")],
  };
  assert.equal(clientNeedsAttention(legacyItemsOnly), true);
  assert.equal(clientNeedsAttention({ needs_attention: true }), true);
  assert.equal(
    clientNeedsAttention({ critical: 0, high: 0, needs_attention: true }),
    false,
    "explicit current counts win over a contradictory stale boolean",
  );
  const legacyStatus = renderToStaticMarkup(
    React.createElement(ClientAlertMenu, {
      summary: { needs_attention: true },
      client: "Legacy Client",
      variant: "row",
      testId: "legacy-alert",
    }),
  );
  assert.match(legacyStatus, /Needs attention for Legacy Client/);
  assert.match(legacyStatus, /alert details unavailable/);
  assert.doesNotMatch(legacyStatus, /<button/);

  const absentProfile = renderToStaticMarkup(
    React.createElement(ClientAlertMenu, {
      summary: undefined,
      client: "Unknown Client",
      variant: "profile",
      testId: "unknown-alert",
    }),
  );
  assert.match(absentProfile, /Alert status unavailable/);
  assert.doesNotMatch(absentProfile, /No active alerts/);

  const explicitClear = renderToStaticMarkup(
    React.createElement(ClientAlertMenu, {
      summary: clientSummary(0, 0, 0, []),
      client: "Clear Client",
      variant: "profile",
      testId: "clear-alert",
    }),
  );
  assert.match(explicitClear, /No active alerts/);
  ok("legacy/absent states stay honest; only an explicit zero rollup renders clear");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("C) shared client details + generic account lists render high-CPL alerts");
{
  const highCpl = clientSummary(0, 2, 0, [
    clientItem("lsa", "high", "30-day CPL $350.01", "https://ads.google.com/localservices/overview?cid=test"),
    clientItem("gads", "high", "30-day CPL $425.50", "javascript:alert(1)"),
  ]);
  const details = renderToStaticMarkup(
    React.createElement(ClientAlertItems, {
      summary: highCpl,
      label: "Alerts for Fixture Law",
    }),
  );
  assert.match(details, />High</);
  assert.match(details, /Google Ads/);
  assert.match(details, /LSA/);
  assert.match(details, /North account/);
  assert.match(details, /LSA - Austin/);
  assert.match(details, /30-day CPL \$350\.01 detail/);
  assert.match(details, /https:\/\/ads\.google\.com\/localservices/);
  assert.doesNotMatch(details, /javascript:/);
  const unavailableDetails = renderToStaticMarkup(
    React.createElement(ClientAlertItems, {
      summary: clientSummary(0, 1, 0, []),
      label: "Alerts for Missing Details",
    }),
  );
  assert.match(unavailableDetails, /Alert details are unavailable/);

  for (const variant of ["profile", "card", "row"] as const) {
    const trigger = renderToStaticMarkup(
      React.createElement(ClientAlertMenu, {
        summary: highCpl,
        client: "Fixture Law",
        variant,
        testId: `alert-${variant}`,
      }),
    );
    assert.match(trigger, /aria-expanded="false"/);
    assert.match(trigger, /2 alerts need attention for Fixture Law/);
  }
  ok("one accessible renderer serves Main/profile/AM with severity, identity, detail and safe link");
}

{
  for (const product of ["gads", "lsa"] as const) {
    const alert = mk("high", "high_cpl");
    alert.product = product;
    alert.title = "30-day CPL $350.01";
    alert.detail = "30 complete days · $700.02 spend · 2 charged leads";
    alert.deep_link = "https://ads.google.com/example";
    const html = renderToStaticMarkup(
      React.createElement(AlertList, { alerts: [alert] }),
    );
    assert.match(html, /30-day CPL \$350\.01/);
    assert.match(html, /\$700\.02 spend/);
    assert.match(html, /https:\/\/ads\.google\.com\/example/);
  }
  ok("generic GAds and LSA account alert lists render high_cpl without code filtering");
}

{
  assert.equal(safeAlertDeepLink("https://ads.google.com/example"), "https://ads.google.com/example");
  assert.equal(safeAlertDeepLink("/ads-os/a/123"), "/ads-os/a/123");
  assert.equal(safeAlertDeepLink("javascript:alert(1)"), null);
  assert.equal(safeAlertDeepLink("//evil.example/path"), null);
  assert.equal(safeAlertDeepLink("http://ads.google.com/example"), null);
  ok("client alert links allow HTTPS/safe app paths and reject executable or downgrade schemes");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("D) alertsStaleDays — 48h threshold, whole-day floor, missing = not stale");
{
  const HOUR = 3_600_000;
  const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

  // Missing / unparsable timestamps: "not yet checked", never stale.
  assert.equal(alertsStaleDays(null), null);
  assert.equal(alertsStaleDays(undefined), null);
  assert.equal(alertsStaleDays(""), null);
  assert.equal(alertsStaleDays("not-a-date"), null);
  ok("null/undefined/garbage timestamps -> null (no ⧗ noise on never-run accounts)");

  // Fresh records (within two daily cycles) are not stale.
  assert.equal(alertsStaleDays(ago(0)), null);
  assert.equal(alertsStaleDays(ago(24)), null);
  assert.equal(alertsStaleDays(ago(47)), null);
  ok("0h/24h/47h old -> fresh (daily job gets a full missed cycle of grace)");

  // At/over the threshold: whole-day floor of the age.
  assert.equal(alertsStaleDays(ago(48)), 2);
  assert.equal(alertsStaleDays(ago(49)), 2);
  assert.equal(alertsStaleDays(ago(72)), 3); // §13.11: backdate 3 days -> "⧗ 3d"
  assert.equal(alertsStaleDays(ago(5 * 24 + 12)), 5);
  ok("48h/49h -> 2d, 72h -> 3d, 132h -> 5d (floor of whole days)");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("E) zeroAccountNotice — either-product visibility, scoped per dashboard");
{
  const sum = (g: number, l: number) => ({ gads_accounts: g, lsa_accounts: l });

  // Combined (Main Dashboard) refresh covers both products: EITHER product
  // resolving zero fires the notice and names the affected product(s).
  assert.equal(zeroAccountNotice(sum(3, 5), ["gads", "lsa"]), null);
  const gadsZero = zeroAccountNotice(sum(0, 5), ["gads", "lsa"]);
  assert.ok(gadsZero !== null && gadsZero.includes("Google Ads") && !gadsZero.includes("LSA"));
  const lsaZero = zeroAccountNotice(sum(3, 0), ["gads", "lsa"]);
  assert.ok(lsaZero !== null && lsaZero.includes("LSA") && !lsaZero.includes("Google Ads"));
  const bothZero = zeroAccountNotice(sum(0, 0), ["gads", "lsa"]);
  assert.ok(bothZero !== null && bothZero.includes("Google Ads and LSA"));
  ok("combined: GAds=0/LSA>0 and the inverse each fire, naming only the empty product");

  // Per-product dashboards pass only their own product: every per-product run
  // summary reports the un-requested product as 0, which must never false-alarm.
  assert.equal(zeroAccountNotice(sum(4, 0), ["gads"]), null);
  assert.equal(zeroAccountNotice(sum(0, 4), ["lsa"]), null);
  const gadsOwn = zeroAccountNotice(sum(0, 9), ["gads"]);
  assert.ok(gadsOwn !== null && gadsOwn.includes("Google Ads"));
  const lsaOwn = zeroAccountNotice(sum(9, 0), ["lsa"]);
  assert.ok(lsaOwn !== null && lsaOwn.includes("LSA") && !lsaOwn.includes("Google Ads"));
  ok("per-product: scoped to its own product — the un-requested 0 never false-alarms");
}

console.log(`\nAll Ads OS alerts UI helper checks passed (${passed} groups).`);
