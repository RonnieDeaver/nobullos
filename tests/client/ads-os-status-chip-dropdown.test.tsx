/* test-registration
{
  "name": "Ads OS AdsStatusChip interactive dropdown — click opens the menu in all four states (verified ✓ / mismatch ✗ / unreachable / unchecked); platform chip, account name, and description text render correctly; Escape and click-outside close the menu (Task #4954)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4954: the Paused/Off chip is now interactive — a regression (dropdown not opening, missing account name, wrong content) would only be caught manually. Pins the open/close lifecycle and all four content states. jsdom-only, no DB, no network.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-os-status-chip-dropdown-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * AdsStatusChip interactive dropdown (Task #4954).
 *
 * The chip is interactive by default: clicking it opens a dropdown that shows
 * the platform chip, account name, and a plain-English description.
 *
 *   State 1 – verified ✓:    check.matches === true
 *   State 2 – mismatch ✗:    check.matches === false
 *   State 3 – unreachable:   check.error set, no matches
 *   State 4 – unchecked:     check === null
 *
 * Close behaviour:
 *   • pressing Escape dismisses the menu
 *   • a mousedown outside the wrapper dismisses the menu
 *
 * jsdom globals are installed by the --import setup file; CSS imports are
 * stubbed. No fetch, no DB, no server.
 */

import { strict as assert } from "node:assert";
import type { StatusCheck } from "../../client/src/pages/adsOs/lib/types";

const dom = (globalThis as any).window;

// The component has no server calls, so a throwing fetch is a regression
// tripwire against accidental network calls creeping in via the import graph.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch in ads-os-status-chip-dropdown test");
};

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AdsStatusChip } = await import(
  "../../client/src/pages/adsOs/components/StatusChip"
);

const doc = (globalThis as any).document as Document;

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Mount / unmount helpers ──────────────────────────────────────────────────

let root: any = null;

async function mount(props: Record<string, unknown>): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AdsStatusChip as any, props));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
  // Clear any lingering content so selectors from earlier renders don't leak.
  doc.getElementById("root")!.innerHTML = "";
}

async function clickButton(): Promise<void> {
  const btn = doc.querySelector(".cp-status") as HTMLElement | null;
  assert.ok(btn, ".cp-status button must be in the DOM before clicking");
  await act(async () => {
    btn!.dispatchEvent(
      new dom.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

function menu(): Element | null {
  return doc.querySelector(".cp-status-menu");
}

// ── State 1: verified ✓ ─────────────────────────────────────────────────────
console.log("\nState 1: verified ✓");
{
  const check: StatusCheck = {
    expected: "paused",
    matches: true,
    enabled_campaigns: 0,
    enabled_campaign_names: [],
    checked_at: "2026-08-07T10:05:00.000Z",
  };

  await mount({
    status: "paused",
    check,
    product: "gads",
    accountName: "Acme Law — Google Ads",
  });

  ok(menu() === null, "state 1: menu is closed before any click");
  ok(
    doc.querySelector(".cp-status.paused.verified") !== null,
    "state 1: interactive Paused chip exposes the neutral verified state",
  );

  await clickButton();
  ok(menu() !== null, "state 1: click opens the dropdown (.cp-status-menu)");

  // Repeated clicks toggle the same trigger, rather than leaving its menu stuck open.
  await clickButton();
  ok(menu() === null, "state 1: second click toggles the dropdown closed");

  await clickButton();
  const m = menu();
  ok(m !== null, "state 1: third click reopens the dropdown after toggle close");

  // Platform chip
  ok(
    m!.querySelector(".cmb-tag.g") !== null,
    "state 1: GAds platform chip (.cmb-tag.g) renders in the menu",
  );
  ok(
    m!.querySelector(".cmb-tag.l") === null,
    "state 1: no LSA chip for a gads account",
  );

  // Account name
  const acct = m!.querySelector(".cp-status-menu-acct");
  ok(acct !== null, "state 1: account name element (.cp-status-menu-acct) renders");
  ok(
    acct!.textContent === "Acme Law — Google Ads",
    "state 1: account name text matches the prop",
  );

  // Description text
  const desc = m!.querySelector(".cp-status-menu-desc");
  ok(desc !== null, "state 1: description paragraph (.cp-status-menu-desc) renders");
  ok(
    desc!.textContent?.includes("Verified") === true,
    "state 1: description mentions verification (✓ Verified)",
  );
  ok(
    desc!.textContent?.includes("no Google Ads campaigns can serve") === true,
    "state 1: description is product-scoped (Google Ads)",
  );

  // Close via Escape
  await act(async () => {
    doc.dispatchEvent(
      new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  ok(menu() === null, "state 1: Escape key closes the dropdown");

  await unmount();
}

// ── State 2: mismatch ✗ ─────────────────────────────────────────────────────
console.log("\nState 2: mismatch ✗");
{
  const check: StatusCheck = {
    expected: "off",
    matches: false,
    enabled_campaigns: 2,
    enabled_campaign_names: ["Summer 2026", "Brand — Exact"],
    checked_at: "2026-08-07T10:05:00.000Z",
  };

  await mount({
    status: "off",
    check,
    product: "lsa",
    accountName: "Beta Plumbing LSA",
  });
  ok(
    doc.querySelector(".cp-status.off.mismatch") !== null,
    "state 2: interactive Off chip exposes the orange mismatch state",
  );

  await clickButton();
  const m = menu();
  ok(m !== null, "state 2: click opens the dropdown for a mismatch chip");

  // Platform chip (LSA)
  ok(
    m!.querySelector(".cmb-tag.l") !== null,
    "state 2: LSA platform chip (.cmb-tag.l) renders in the menu",
  );
  ok(
    m!.querySelector(".cmb-tag.g") === null,
    "state 2: no GAds chip for an LSA account",
  );

  // Account name
  const acct = m!.querySelector(".cp-status-menu-acct");
  ok(acct !== null, "state 2: account name element renders for mismatch state");
  ok(
    acct!.textContent === "Beta Plumbing LSA",
    "state 2: account name text matches the prop",
  );

  // Description text
  const desc = m!.querySelector(".cp-status-menu-desc");
  ok(desc !== null, "state 2: description paragraph renders for mismatch state");
  ok(
    desc!.textContent?.includes("MISMATCH") === true,
    "state 2: description includes MISMATCH keyword",
  );
  ok(
    desc!.textContent?.includes("2 LSA campaign") === true,
    "state 2: description counts the mismatch campaigns and uses product-scoped wording",
  );
  ok(
    desc!.textContent?.includes("\u201cSummer 2026\u201d") === true,
    "state 2: description names the offending campaigns (curly quotes)",
  );

  // Close via click outside
  const outside = doc.getElementById("outside")!;
  await act(async () => {
    outside.dispatchEvent(
      new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });
  ok(menu() === null, "state 2: mousedown outside the wrapper closes the dropdown");

  await unmount();
}

// ── State 3: unreachable ─────────────────────────────────────────────────────
console.log("\nState 3: unreachable");
{
  const check: StatusCheck = {
    expected: "paused",
    error: "PERMISSION_DENIED: CID not under MCC",
    checked_at: "2026-08-07T10:05:00.000Z",
  };

  await mount({
    status: "paused",
    check,
    product: "gads",
    accountName: "Gamma HVAC",
  });
  ok(
    doc.querySelector(".cp-status.verified, .cp-status.mismatch") === null,
    "state 3: unreachable interactive chip has no verdict styling",
  );

  await clickButton();
  const m = menu();
  ok(m !== null, "state 3: click opens the dropdown for an unreachable chip");

  // Platform chip present
  ok(
    m!.querySelector(".cmb-tag.g") !== null,
    "state 3: GAds platform chip renders in the menu",
  );

  // Account name
  ok(
    m!.querySelector(".cp-status-menu-acct")?.textContent === "Gamma HVAC",
    "state 3: account name renders for unreachable state",
  );

  // Description text explains the unreachable state
  const desc = m!.querySelector(".cp-status-menu-desc");
  ok(desc !== null, "state 3: description paragraph renders");
  ok(
    desc!.textContent?.includes("couldn't reach this account") === true,
    "state 3: description explains the missing mark for unreachable accounts",
  );

  await unmount();
}

// ── State 4: unchecked (null check) ─────────────────────────────────────────
console.log("\nState 4: unchecked");
{
  await mount({
    status: "off",
    check: null,
    product: "lsa",
    accountName: "Delta Dental LSA",
  });
  ok(
    doc.querySelector(".cp-status.verified, .cp-status.mismatch") === null,
    "state 4: unchecked interactive chip has no verdict styling",
  );

  await clickButton();
  const m = menu();
  ok(m !== null, "state 4: click opens the dropdown for an unchecked chip");

  // Platform chip present (LSA)
  ok(
    m!.querySelector(".cmb-tag.l") !== null,
    "state 4: LSA platform chip renders in the menu",
  );

  // Account name
  ok(
    m!.querySelector(".cp-status-menu-acct")?.textContent === "Delta Dental LSA",
    "state 4: account name renders for unchecked state",
  );

  // Description text says "Not verified yet"
  const desc = m!.querySelector(".cp-status-menu-desc");
  ok(desc !== null, "state 4: description paragraph renders");
  ok(
    desc!.textContent?.includes("Not verified yet") === true,
    "state 4: description says the check hasn't run yet",
  );
  ok(
    desc!.textContent?.includes("~6am ET") === true,
    "state 4: description mentions the NBM cron schedule (~6am ET)",
  );

  // Close via Escape
  await act(async () => {
    doc.dispatchEvent(
      new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  ok(menu() === null, "state 4: Escape key closes the dropdown for unchecked state");

  await unmount();
}

// ── accountName prop absent: no .cp-status-menu-acct element ────────────────
console.log("\nNo accountName prop");
{
  await mount({
    status: "paused",
    check: null,
    product: "gads",
    // no accountName
  });

  await clickButton();
  const m = menu();
  ok(m !== null, "no-accountName: dropdown still opens");
  ok(
    m!.querySelector(".cp-status-menu-acct") === null,
    "no-accountName: .cp-status-menu-acct is absent when the prop is not supplied",
  );

  await unmount();
}

console.log(`\nads-os-status-chip-dropdown: ${passed} assertion(s) passed.`);
