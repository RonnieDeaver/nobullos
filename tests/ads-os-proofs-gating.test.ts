/* test-registration
{
  "name": "Ads OS System Checks (proofs) gating — real AdsOsProofs.tsx mounts in jsdom for account_manager vs ceo: non-CEO gets the designed restricted notice with ZERO /api/ads-os/proofs fetches and no nav tab / palette entry; CEO gets the tab, palette entry and the four live check cards (Task #4375)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4375 (design audit P3-7): the operator-confusion gate on the CEO-only engineering checks page. A regression re-exposing it — the nav tab or palette entry leaking back to AMs, or a non-CEO deep link mounting the 403-spraying check queries — is invisible to backend suites because the whole gate is client-render logic. jsdom, DB-free, network-free (fetch stub), ~3s.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-proofs-gating-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4375 — keep the Ads OS proofs page out of operators' way.
 *
 * /ads-os/proofs is an engineering verification surface whose APIs are
 * CEO-gated server-side (requireCeo). The client gate under test:
 *
 *   1. account_manager — the System Checks tab is absent from the module nav,
 *      the ⌘K palette has no System Checks entry, a direct deep link renders
 *      the designed "Restricted to the CEO role" notice, and — critically —
 *      NONE of the four /api/ads-os/proofs/&#42; queries fire (they would all
 *      403 and render a wall of failing checks).
 *   2. ceo — tab + palette entry present, the reframed "System checks"
 *      heading renders, and all four check queries fire through the stub.
 *
 * Mounts the REAL page (client/src/pages/AdsOsProofs.tsx → AdsOsShell →
 * CommandPalette) in jsdom. The setup file stubs @clerk/react as a signed-IN
 * loaded session so the real use-auth hook fetches /api/auth/user through the
 * fetch stub — the role read stays genuine. DB-free / network-free.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom bootstrap (must precede the dynamic client imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/ads-os/proofs" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
// The palette keeps the active row visible via scrollIntoView, which jsdom
// doesn't implement.
(dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

type AnyRec = Record<string, any>;

// ── Fetch stub: role-switchable auth user + recorded check endpoints ──
let currentUser: AnyRec = {
  id: "u-am-1",
  email: "am@example.com",
  firstName: "Avery",
  lastName: "Manager",
  role: "account_manager",
};
const proofCalls: string[] = [];

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: () => currentUser },
    {
      path: /\/api\/ads-os\/proofs\/(accounts|clickup|openai|store)$/,
      respond: ({ url }: { url: string }) => {
        proofCalls.push(url);
        return { status: 200, json: { ok: true, roundtripOk: true, count: 3 } };
      },
    },
    {
      path: "/api/ads-os/status",
      json: {
        googleAds: { configured: true },
        clickUp: { configured: true },
        openAi: { configured: true },
        slack: { configured: false },
        cron: { configured: true },
      },
    },
    // ⌘K palette directory pools (module-level session caches in dirPools.ts).
    { path: "/api/ads-os/clients", json: { clients: [] } },
    { path: "/api/ads-os/monitored-accounts", json: { accounts: [] } },
    { path: "/api/ads-os/lsa/monitored-accounts", json: { accounts: [] } },
  ],
  defaultJson: {},
});
(globalThis as any).fetch = fetchStub;

// ── Harness ──
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const AdsOsProofsPage = (await import("../client/src/pages/AdsOsProofs")).default;

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

const flush = async (times = 10) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const $t = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tabHrefs = (): string[] =>
  Array.from(document.querySelectorAll(".tabs a")).map((a) => a.getAttribute("href") ?? "");
const paletteLabels = (): string[] =>
  Array.from(document.querySelectorAll(".cmdk-item .cmdk-label")).map((e) => e.textContent ?? "");

/** Mount the real page under a FRESH QueryClient (so the auth user cached for
 *  one role never bleeds into the next case); run `fn`; always unmount. */
async function withMounted(fn: () => void | Promise<void>): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider as any,
          { client: queryClient },
          React.createElement(AdsOsProofsPage as any),
        ),
      );
    });
    await flush();
    await fn();
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
}

async function openPalette(): Promise<void> {
  const btn = $t("button-cmdk-trigger");
  assert.ok(btn, "⌘K trigger renders in the shell top bar");
  await act(async () => {
    btn!.click();
  });
  await flush();
}

// ---------------------------------------------------------------------------
console.log("AdsOsProofs gating — account_manager (non-CEO operator)");
// ---------------------------------------------------------------------------

await withMounted(async () => {
  await check("deep link renders the designed restricted notice, not the checks", () => {
    assert.ok($t("panel-proofs-restricted"), "restricted panel renders");
    assert.equal($t("list-system-checks"), null, "check cards NOT mounted");
    assert.equal(document.querySelector(".proof-json"), null, "no raw JSON blocks");
    assert.equal(
      $t("heading-system-checks")?.textContent,
      "Integration readiness",
      "page still self-identifies",
    );
    assert.ok($t("link-proofs-back"), "back-to-dashboard link renders");
  });

  await check("no /api/ads-os/proofs/* query fires for a non-CEO", () => {
    assert.deepEqual(proofCalls, [], "zero check fetches (they would all 403)");
  });

  await check("System Checks tab is absent from the module nav", () => {
    const hrefs = tabHrefs();
    assert.ok(hrefs.length >= 4, `other tabs render (got ${hrefs.join(", ")})`);
    assert.ok(!hrefs.includes("/ads-os/proofs"), "no /ads-os/proofs tab");
    assert.ok(hrefs.includes("/ads-os/am"), "AM Dashboard tab still present");
  });

  await check("⌘K palette has no System Checks entry", async () => {
    await openPalette();
    const labels = paletteLabels();
    assert.ok(labels.includes("Main Dashboard"), "palette page entries render");
    assert.ok(!labels.includes("System Checks"), "no System Checks palette entry");
  });
});

// ---------------------------------------------------------------------------
console.log("AdsOsProofs gating — ceo");
// ---------------------------------------------------------------------------

currentUser = {
  id: "u-ceo-1",
  email: "ceo@example.com",
  firstName: "Casey",
  lastName: "Owner",
  role: "ceo",
};

await withMounted(async () => {
  await check("reframed verification page renders with all four check cards", () => {
    assert.equal($t("panel-proofs-restricted"), null, "no restricted panel for the CEO");
    assert.equal(
      $t("heading-system-checks")?.textContent,
      "Integration readiness",
      "reframed heading (no Phase-0 jargon)",
    );
    assert.ok($t("list-system-checks"), "check cards mount");
    assert.equal(
      document.querySelectorAll(".proofs-cards .proof-card").length,
      4,
      "four check cards",
    );
    assert.equal(
      document.querySelectorAll(".proofs-cards .proof-chip.pass").length,
      4,
      "all four checks show Pass against the stub",
    );
  });

  await check("all four check queries fire for the CEO", () => {
    const hit = new Set(proofCalls.map((u) => u.split("/").pop()));
    assert.deepEqual(
      [...hit].sort(),
      ["accounts", "clickup", "openai", "store"],
      `4 distinct check endpoints (got: ${proofCalls.join(", ")})`,
    );
  });

  await check("System Checks tab is present for the CEO", () => {
    const hrefs = tabHrefs();
    assert.ok(hrefs.includes("/ads-os/proofs"), `tab present (got ${hrefs.join(", ")})`);
    const tab = Array.from(document.querySelectorAll(".tabs a")).find(
      (a) => a.getAttribute("href") === "/ads-os/proofs",
    );
    assert.equal(tab?.textContent, "System Checks", "tab label self-explains");
  });

  await check("⌘K palette lists System Checks for the CEO", async () => {
    await openPalette();
    const labels = paletteLabels();
    assert.ok(labels.includes("System Checks"), `palette entry present (got: ${labels.join(", ")})`);
  });
});

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll AdsOsProofs gating checks passed");
process.exit(0);
