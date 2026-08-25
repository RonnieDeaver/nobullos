/* test-registration
{
  "name": "Ads OS AM Dashboard status chip — the four exact states (✓ verified / ✗ mismatch naming ≤3 campaigns +n more / unreachable bare + tooltip / not-yet-verified bare + tooltip), On renders nothing, product-scoped wording (Task #3988)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3988: the chip is the verification's ONLY surface — a wrong state renders a paused-but-spending account as fine. Pure render (react-dom/server, no jsdom/DB/network); milliseconds.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * AdsStatusChip (client/src/pages/adsOs/components/StatusChip.tsx) — the AM
 * Dashboard's Ads Status chip with the morning-verification mark (Task #3988).
 *
 * The chip has exactly four states for a Paused/Off account:
 *   1. ✓  — the claim held when last checked (grey chip, word + ✓);
 *   2. ✗  — campaigns can still serve: `mismatch` class, tooltip NAMES up to
 *           three offending campaigns (curly quotes) then "+n more";
 *   3. error — the check couldn't reach the account: BARE chip (no mark ever,
 *           a guess is worse than nothing) + a tooltip saying so;
 *   4. no entry — never verified: bare chip + "Not verified yet" tooltip
 *           (~6am ET wording — NBM's cron, not the reference's 9am).
 * And the fifth non-state: On (or blank) accounts render NO chip at all.
 *
 * Wording is product-scoped ("no LSA campaigns…" vs "no Google Ads
 * campaigns…") because one CID can host both products (Paxton Law) and the
 * check only looks at its own product's campaigns.
 *
 * Pure presentational component (no hooks) → react-dom/server static markup,
 * no jsdom. createElement (not JSX) keeps this file plain .ts.
 */

process.env.NODE_ENV = "test";

import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AdsStatusChip } from "../client/src/pages/adsOs/components/StatusChip";
import type { StatusCheck } from "../client/src/pages/adsOs/lib/types";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// The AM Dashboard renders chips with interactive={false} (chip sits inside an
// <a> launch card — nesting a <button> in an anchor is invalid HTML). All AM
// chip state assertions use this non-interactive mode.
const html = (props: {
  status: string;
  check?: StatusCheck | null;
  product: "gads" | "lsa";
}): string => renderToStaticMarkup(createElement(AdsStatusChip as any, { ...props, interactive: false } as any));

/** The title="" attribute of the rendered chip, entities decoded enough to grep. */
const titleOf = (markup: string): string => {
  const m = markup.match(/title="([^"]*)"/);
  return (m?.[1] ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
};

// ── On (and blank) render nothing ────────────────────────────────────────────
console.log("state 0: On");
ok(html({ status: "on", product: "gads" }) === "", "On account renders no chip");
ok(html({ status: "", product: "gads" }) === "", "blank status renders no chip");

// ── State 1: ✓ verified ─────────────────────────────────────────────────────
console.log("state 1: verified ✓");
{
  const check: StatusCheck = {
    expected: "paused",
    matches: true,
    enabled_campaigns: 0,
    enabled_campaign_names: [],
    checked_at: "2026-08-07T10:05:00.000Z",
  };
  const m = html({ status: "paused", check, product: "gads" });
  ok(m.includes("Paused ✓"), "paused + holds → 'Paused ✓'");
  ok(m.includes('class="cp-status paused verified"'), "verified Paused chip exposes the neutral verdict state");
  ok(titleOf(m).includes("no Google Ads campaigns"), "gads wording is product-scoped");
  ok(titleOf(m).includes("checked Aug 7"), "tooltip carries the checked date");

  const lsa = html({ status: "off", check: { ...check, expected: "off" }, product: "lsa" });
  ok(lsa.includes("Off ✓"), "off + holds → 'Off ✓'");
  ok(lsa.includes('class="cp-status off verified"'), "verified Off chip exposes the neutral verdict state");
  ok(titleOf(lsa).includes("no LSA campaigns"), "lsa wording is product-scoped");
}

// ── State 2: ✗ mismatch ─────────────────────────────────────────────────────
console.log("state 2: mismatch ✗");
{
  const check: StatusCheck = {
    expected: "paused",
    matches: false,
    enabled_campaigns: 5,
    enabled_campaign_names: ["Alpha Flight", "Beta Flight", "Gamma Flight", "Delta Flight", "Epsilon"],
    checked_at: "2026-08-07T10:05:00.000Z",
  };
  const m = html({ status: "paused", check, product: "gads" });
  ok(m.includes("Paused ✗"), "paused + serving → 'Paused ✗'");
  ok(m.includes('class="cp-status paused mismatch"'), "mismatch class drives the orange + ring styling");
  const t = titleOf(m);
  ok(t.includes("5 Google Ads campaigns can still serve"), "tooltip counts the offenders");
  ok(
    t.includes("“Alpha Flight”") && t.includes("“Gamma Flight”"),
    "tooltip NAMES offending campaigns (curly quotes)",
  );
  ok(!t.includes("Delta Flight"), "only the first three are named…");
  ok(t.includes("+2 more"), "…the rest collapse into +n more");

  const one = html({
    status: "off",
    check: { ...check, expected: "off", enabled_campaigns: 1, enabled_campaign_names: ["Solo"] },
    product: "lsa",
  });
  ok(one.includes("Off ✗"), "off + serving → 'Off ✗'");
  ok(one.includes('class="cp-status off mismatch"'), "mismatched Off chip exposes the orange verdict state");
  const t1 = titleOf(one);
  ok(t1.includes("1 LSA campaign can still serve"), "singular phrasing for one campaign");
  ok(!t1.includes("more"), "no '+n more' when everything is named");
}

// ── State 3: unreachable → bare chip + explanatory tooltip ──────────────────
console.log("state 3: unreachable");
{
  const check: StatusCheck = {
    expected: "paused",
    error: "PERMISSION_DENIED: not under MCC",
    checked_at: "2026-08-07T10:05:00.000Z",
  };
  const m = html({ status: "paused", check, product: "gads" });
  ok(m.includes(">Paused</span>"), "errored check → BARE word, never a ✓ or ✗");
  ok(!m.includes("verified") && !m.includes("mismatch"), "unreachable account gains no false verdict styling");
  ok(titleOf(m).includes("couldn't reach this account"), "tooltip explains the missing mark");
}

// ── State 4: never verified → bare chip + 'not verified yet' tooltip ────────
console.log("state 4: not verified yet");
{
  const m = html({ status: "off", check: null, product: "lsa" });
  ok(m.includes(">Off</span>"), "unchecked → bare word");
  ok(m.includes('class="cp-status off"'), "unchecked account gains no false verdict styling");
  const t = titleOf(m);
  ok(t.includes("Not verified yet"), "tooltip says the check hasn't run");
  ok(t.includes("~6am ET"), "NBM cron wording (~6am ET, not the reference's 9am)");
}

console.log(`\nads-os-am-chip-render: ${passed} assertion(s) passed.`);
