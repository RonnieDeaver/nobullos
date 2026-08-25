/* test-registration
{
  "name": "Ads OS combined dashboard member status section — AdsStatusChip renders for paused/off accounts regardless of pacing availability, absent for on accounts (Task #4878)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4878: the combined (Main) dashboard must show Paused/Off chips in the client name cell for every paused/off account, even when that account has no budget-pacing data and the client has null combined pacing_pct. A regression here silently hides every Paused/Off chip from the AM-facing overview. DB-free, network-free, fast jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/combined-pace-cell-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4878 — CombinedMemberStatusSection render.
 *
 * Mounts the exported CombinedMemberStatusSection component in jsdom and pins:
 *
 *   1. Paused member with null pacing_budget (no pacing data) → chip renders.
 *   2. Off member with a mismatched status_check → chip renders with ✗.
 *   3. On member → no chip (running is the norm).
 *   4. Mixed list (one paused, one on) → only the paused member's chip shows.
 *   5. Client with null combined pacing_pct (pacing irrelevant) → chips unaffected.
 *
 * DB-free, network-free, fetch-free. jsdom globals installed by
 * tests/client/combined-pace-cell-setup.mjs (--import).
 */

import { strict as assert } from "node:assert";

const dom = (globalThis as any).window;

// The component makes no calls; a throwing fetch is a regression tripwire.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch from CombinedMemberStatusSection test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { CombinedMemberStatusSection } = await import(
  "../../client/src/pages/adsOs/MainDashboard"
);

const doc = (globalThis as any).document;

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function baseMember(overrides: Record<string, unknown> = {}): any {
  return {
    product: "gads",
    customer_id: "1111111111",
    descriptive_name: "Acme GAds",
    city: null,
    ads_status: "on",
    spend_30d: 0,
    leads_30d: 0,
    metrics_failed: false,
    pacing_pct: null,
    pacing_budget: null, // no pacing data by default
    pacing_mtd: null,
    status_check: null,
    ...overrides,
  };
}

let root: any = null;
async function mount(members: any[]): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(CombinedMemberStatusSection as any, { members }),
    );
  });
}
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}

function chips(): HTMLElement[] {
  return Array.from(doc.querySelectorAll(".cp-status"));
}
// NOTE (Task #4949): .cmb-acct-name was removed — the account name now lives inside
// the chip's interactive dropdown (cp-status-menu) rather than inline next to the chip.
// Tests that previously checked acctNames() now verify chip count / class instead.

// ── 1. Paused member with null pacing_budget → chip renders ────────────────
console.log("case 1: paused member, no pacing data");
{
  const m = baseMember({ ads_status: "paused", customer_id: "1111111111", descriptive_name: "Alpha GAds" });
  await mount([m]);

  ok(doc.querySelector("[data-testid='cmb-status-list']") !== null,
    "cmb-status-list renders when a paused member is present");
  const c = chips();
  ok(c.length === 1, "exactly one chip for one paused member");
  ok(c[0]!.classList.contains("paused"), "chip has 'paused' class");
  ok(c[0]!.textContent?.includes("Paused") === true, "chip text includes 'Paused'");
  // No verification mark (status_check is null) — chip is bare.
  ok(!c[0]!.textContent?.includes("✓") && !c[0]!.textContent?.includes("✗"),
    "no verification mark when status_check is null");

  await unmount();
}

// ── 2. Off member with mismatched status_check → ✗ chip ───────────────────
console.log("case 2: off member with mismatch status_check");
{
  const statusCheck = {
    expected: "off",
    matches: false,
    enabled_campaigns: 2,
    enabled_campaign_names: ["Summer Campaign"],
    checked_at: new Date().toISOString(),
  };
  const m = baseMember({
    ads_status: "off",
    customer_id: "2222222222",
    descriptive_name: "Beta LSA",
    product: "lsa",
    status_check: statusCheck,
  });
  await mount([m]);

  const c = chips();
  ok(c.length === 1, "one chip for one off member");
  ok(c[0]!.classList.contains("off"), "chip has 'off' class");
  ok(c[0]!.textContent?.includes("✗") === true,
    "mismatch status_check renders ✗ mark");

  await unmount();
}

// ── 3. On member → no chip ─────────────────────────────────────────────────
console.log("case 3: on member produces no chip");
{
  await mount([baseMember({ ads_status: "on" })]);

  ok(doc.querySelector("[data-testid='cmb-status-list']") === null,
    "no cmb-status-list rendered for on-only members");
  ok(chips().length === 0, "no chips for on member");

  await unmount();
}

// ── 4. Mixed list: one paused, one on → only paused member shows ───────────
console.log("case 4: mixed paused + on list");
{
  const paused = baseMember({
    ads_status: "paused",
    customer_id: "3333333333",
    descriptive_name: "Paused Account",
  });
  const on = baseMember({
    ads_status: "on",
    customer_id: "4444444444",
    descriptive_name: "On Account",
  });
  await mount([paused, on]);

  const c = chips();
  ok(c.length === 1, "only the paused member gets a chip");

  await unmount();
}

// ── 5. Null combined pacing_pct doesn't affect chip rendering ──────────────
// The component only takes `members`; it is pacing-agnostic by design.
// Verify: even when pacing_budget is null on the member, the chip still shows.
console.log("case 5: paused member with null pacing_budget + null pacing_pct (no pacing at all)");
{
  const m = baseMember({
    ads_status: "paused",
    customer_id: "5555555555",
    descriptive_name: "Untracked Paused Account",
    pacing_budget: null,
    pacing_pct: null,
    pacing_mtd: null,
    status_check: {
      expected: "paused",
      matches: true,
      enabled_campaigns: 0,
      enabled_campaign_names: [],
      checked_at: new Date().toISOString(),
    },
  });
  await mount([m]);

  const c = chips();
  ok(c.length === 1, "chip renders even when pacing_budget and pacing_pct are null");
  ok(c[0]!.textContent?.includes("✓") === true,
    "verified status_check renders ✓ mark");

  await unmount();
}

console.log(
  `\ncombined-member-status-section: ${passed} assertion(s) passed (Task #4878).`,
);
