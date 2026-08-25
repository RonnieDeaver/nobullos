/* test-registration
{
  "name": "Google Ads account list completeness — no truncation discovery→storage→route→rendered combobox (Tasks #2902/#3096)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2902: the account-dropdown completeness + scheduled-sync wiring guard. The daily pull silently died on a v23 GAQL field removal and a USER_PERMISSION_DENIED misclassification; this pins the full discovery→storage→route→dropdown chain (no caps) plus the scheduler tick wiring (Task #4008: credential skips now use the env-model reasons; the stored-connection self-heal is retired), with a real-DB 120-row seed on the read.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-hygiene-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/admin/GoogleAdsHygieneAudit.tsx",
    "server/boot",
    "server/index.ts",
    "server/routes/googleAdsAudit.ts",
    "server/services/googleAdsIntegration.ts",
    "server/services/googleAdsSync.ts",
    "server/storage/googleAdsStorage.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2902 — Google Ads account list completeness.
 * Task #3096 — the layer-4 UI check now RENDERS the real searchable combobox.
 *
 * The account dropdown must show ALL non-canceled accessible accounts under
 * the MCC. This test proves there is no truncation anywhere in the chain:
 *
 *   1. Discovery (`discoverAndUpsertCustomers`) — GAQL `customer_client`
 *      query filters ONLY canceled accounts (`status != 'CANCELED'`) and has
 *      no LIMIT; `searchStream` returns the full result set (no paging cap).
 *   2. Storage (`listGoogleAdsCustomers`) — real-DB integration: seed a
 *      large synthetic cohort (bigger than any plausible UI page size) and
 *      assert every row comes back (no `.limit()` anywhere on the read).
 *   3. API shaping (`/api/admin/google-ads-audit/accounts`) — filters ONLY
 *      `isManager`, never slices/limits.
 *   4. UI (`GoogleAdsHygieneAudit.tsx` account combobox, Task #3091) —
 *      mounts the REAL page in jsdom and drives the Popover + cmdk picker:
 *      the trigger (`select-account`) renders, every account appears as an
 *      `option-account-<id>` item, typing into the CommandInput filters the
 *      visible options (by name and by ID digits), and selecting an option
 *      fires `setCustomerId` (trigger label + tabs appear) and
 *      `setActiveRunId(null)` (source-pinned in the onSelect body).
 *      Radix Popover / cmdk never mount in the raw jsdom harness, so they
 *      are shimmed via `tests/client/ads-hygiene-mock-setup.mjs`
 *      (see .agents/memory/radix-portal-jsdom-tests.md).
 *   5. Scheduler tick wiring + env-model credential skip reasons (Task #4008).
 *
 * Layers 1/3 are source-pinned; layer 2 runs against the real dev DB;
 * layer 4 runs against the rendered DOM.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

import {
  listGoogleAdsCustomers,
  upsertGoogleAdsCustomer,
} from "../server/storage/googleAdsStorage";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const SYNTH_PREFIX = "999029020"; // task-unique synthetic customer_id prefix
const SYNTH_COUNT = 120; // larger than the live MCC (97) and any page default

function read(path: string): string {
  return readFileSync(path, "utf8");
}

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}\n    ${err?.message}`);
    });
}

// ── jsdom bootstrap (must precede the dynamic client imports in layer 4) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/ads-hygiene" },
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
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || function () { return false; };
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture =
  (dom.window.HTMLElement.prototype as any).setPointerCapture || function () {};
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CEO_USER = {
  id: "ceo-3096",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const UI_ACCOUNTS = [
  { customerId: "1111111111", descriptiveName: "Alpha Law Group", status: "ENABLED", nobullClientId: null },
  { customerId: "2222222222", descriptiveName: "Bravo Injury Firm", status: "ENABLED", nobullClientId: null },
  { customerId: "3333333333", descriptiveName: "Charlie Defense LLC", status: "ENABLED", nobullClientId: null },
];

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function visibleAccountOptionIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid^="option-account-"]'),
  ).map((el) => (el as HTMLElement).getAttribute("data-testid")!.replace("option-account-", ""));
}

async function main() {
  const integration = read("server/services/googleAdsIntegration.ts");
  const auditRoute = read("server/routes/googleAdsAudit.ts");
  const storageSrc = read("server/storage/googleAdsStorage.ts");
  const hygieneUi = read("client/src/pages/admin/GoogleAdsHygieneAudit.tsx");

  // ---- 1. Discovery query completeness --------------------------------
  await check(
    "discovery GAQL filters only CANCELED accounts and has no LIMIT",
    () => {
      const start = integration.indexOf("FROM customer_client");
      assert.ok(start > 0, "customer_client discovery query present");
      const q = integration.slice(start - 600, start + 200);
      assert.match(q, /customer_client\.status != 'CANCELED'/);
      assert.doesNotMatch(q, /\bLIMIT\b/i, "discovery query must not LIMIT");
    },
  );

  await check(
    "discovery uses searchStream (full result set, no page-size cap)",
    () => {
      assert.match(integration, /googleAds:searchStream/);
      assert.doesNotMatch(
        integration,
        /page_size|pageSize/,
        "no page-size cap anywhere in the integration",
      );
    },
  );

  // ---- 2. Storage read returns every row (real DB) ---------------------
  const like = `${SYNTH_PREFIX}%`;
  const cleanup = () =>
    db.execute(
      sql`DELETE FROM google_ads_customers WHERE customer_id LIKE ${like}`,
    );
  try {
    await cleanup(); // clear any leftovers from a prior aborted run
    for (let i = 0; i < SYNTH_COUNT; i++) {
      await upsertGoogleAdsCustomer({
        customerId: `${SYNTH_PREFIX}${String(i).padStart(3, "0")}`,
        descriptiveName: `Synthetic completeness fixture ${i}`,
        currencyCode: "USD",
        timeZone: "America/New_York",
        isManager: false,
        isTestAccount: true,
        status: "ENABLED",
      });
    }

    await check(
      `listGoogleAdsCustomers returns all ${SYNTH_COUNT} seeded accounts (no cap)`,
      async () => {
        const all = await listGoogleAdsCustomers();
        const mine = all.filter((c) => c.customerId.startsWith(SYNTH_PREFIX));
        assert.equal(mine.length, SYNTH_COUNT);
      },
    );

    await check(
      "the audit-route shaping (non-manager filter) keeps every seeded account",
      async () => {
        // Mirror of the route's only filter — proven against source below.
        const all = await listGoogleAdsCustomers();
        const shaped = all
          .filter((c) => !c.isManager)
          .filter((c) => c.customerId.startsWith(SYNTH_PREFIX));
        assert.equal(shaped.length, SYNTH_COUNT);
      },
    );
  } finally {
    await cleanup();
  }

  await check("listGoogleAdsCustomers source has no .limit()", () => {
    const start = storageSrc.indexOf("export async function listGoogleAdsCustomers");
    const body = storageSrc.slice(start, storageSrc.indexOf("}", start + 200));
    assert.ok(start > 0);
    assert.doesNotMatch(body, /\.limit\(/);
  });

  // ---- 3. Route shaping filters only isManager --------------------------
  await check(
    "accounts endpoint filters only isManager — no slice/limit",
    () => {
      const start = auditRoute.indexOf("google-ads-audit/accounts");
      const handler = auditRoute.slice(start, start + 900);
      assert.match(handler, /filter\(\(c\) => !c\.isManager\)/);
      assert.doesNotMatch(handler, /\.slice\(|\.limit\(/);
    },
  );

  // ---- 4. Rendered combobox: completeness, search filtering, selection ---
  // Source pins that stay cheap to check even before mounting:
  await check(
    "combobox source: maps filteredAccounts with no slice cap; onSelect fires setCustomerId + setActiveRunId(null)",
    () => {
      assert.ok(
        hygieneUi.includes('data-testid="select-account"'),
        "account picker trigger present",
      );
      assert.match(
        hygieneUi,
        /\{filteredAccounts\.map\(\(account\) =>/,
        "combobox iterates filteredAccounts (derived from full accounts list)",
      );
      assert.doesNotMatch(
        hygieneUi,
        /accounts\.slice\(/,
        "accounts list must never be sliced",
      );
      // Pin the onSelect body: picking an account switches the audit target
      // AND resets the active run so a stale run never renders for the new
      // account (rendered proof of setActiveRunId(null) is not observable
      // when the runs list is empty, so it is pinned here).
      const onSelect = hygieneUi.indexOf("onSelect={() => {", hygieneUi.indexOf("filteredAccounts.map"));
      assert.ok(onSelect > 0, "combobox item onSelect handler present");
      const body = hygieneUi.slice(onSelect, onSelect + 400);
      assert.match(body, /setCustomerId\(account\.customerId\)/);
      assert.match(body, /setActiveRunId\(null\)/);
    },
  );

  // Rendered DOM checks — mount the REAL page with a stubbed fetch.
  const fetchStub = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/auth/user", json: CEO_USER },
      { path: "/api/admin/google-ads-audit/accounts", json: { accounts: UI_ACCOUNTS } },
      { path: /\/api\/admin\/google-ads-audit\/[^/]+\/runs$/, json: { runs: [] } },
    ],
    defaultJson: {
      rows: [],
      runs: [],
      accounts: [],
      items: [],
      alerts: [],
      results: [],
      runAt: null,
      clickupConfigured: false,
    },
  });
  (globalThis as any).fetch = fetchStub;

  const React = (await import("react")).default ?? (await import("react"));
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { queryClient } = await import("../client/src/lib/queryClient");
  const GoogleAdsHygieneAudit = (
    await import("../client/src/pages/admin/GoogleAdsHygieneAudit")
  ).default;

  const flush = async (times = 12) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const clickLikeUser = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
      el.dispatchEvent(
        new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
      );
      el.click();
    });
    await flush(6);
  };

  // React-controlled input: set the value via the native setter, then
  // dispatch `input` so React's onChange (→ cmdk shim onValueChange) fires.
  const typeIntoInput = async (input: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush(4);
  };

  const container = document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(GoogleAdsHygieneAudit as any),
      ),
    );
  });
  await flush();

  try {
    await check("rendered: combobox trigger + one option per account", async () => {
      const trigger = $("select-account");
      assert.ok(trigger, "combobox trigger (select-account) renders");
      assert.ok(
        (trigger!.textContent || "").includes("Choose an account"),
        `trigger reads "Choose an account" before selection, got: ${trigger!.textContent}`,
      );
      await clickLikeUser(trigger!);
      const ids = visibleAccountOptionIds();
      assert.deepEqual(
        ids.sort(),
        UI_ACCOUNTS.map((a) => a.customerId).sort(),
        "every account from the API renders as an option-account-<id> item",
      );
    });

    const searchInput = document.querySelector(
      'input[placeholder^="Search"]',
    ) as HTMLInputElement | null;

    await check("rendered: typing a NAME query filters the options", async () => {
      assert.ok(searchInput, "CommandInput search box renders");
      await typeIntoInput(searchInput!, "bravo");
      assert.deepEqual(
        visibleAccountOptionIds(),
        ["2222222222"],
        "only the Bravo account remains visible for query 'bravo'",
      );
    });

    await check("rendered: typing an ID-digits query filters the options", async () => {
      await typeIntoInput(searchInput!, "33-33");
      assert.deepEqual(
        visibleAccountOptionIds(),
        ["3333333333"],
        "digit search matches the customer ID even with separators typed",
      );
    });

    await check("rendered: clearing the query restores the full list", async () => {
      await typeIntoInput(searchInput!, "");
      assert.equal(visibleAccountOptionIds().length, UI_ACCOUNTS.length);
    });

    await check("rendered: selecting an option sets the account (setCustomerId path)", async () => {
      const option = $("option-account-1111111111");
      assert.ok(option, "Alpha option renders");
      await clickLikeUser(option!);
      const trigger = $("select-account");
      assert.ok(
        (trigger!.textContent || "").includes("Alpha Law Group"),
        `trigger label shows the selected account, got: ${trigger!.textContent}`,
      );
      // customerId set → the "select an account" empty state is replaced by tabs.
      assert.equal($("text-no-account"), null, "empty-state card gone after selection");
      assert.ok($("tab-pacing"), "tabs render once an account is selected");
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  // ---- 5. Scheduled sync tick is wired (auto data pull) ------------------
  await check(
    "scheduler tick → runGoogleAdsSync → credential skips use the env-model reasons",
    () => {
      const syncSrc = read("server/services/googleAdsSync.ts");
      assert.match(syncSrc, /setInterval\(\(\) => void tick\(\)/);
      // Task #4008 — the stored-connection self-heal
      // (healMisclassifiedGoogleAdsDisconnect) is retired with the
      // connection row; credential problems now surface as the two
      // env-model skip reasons instead of "not_connected".
      assert.ok(
        !syncSrc.includes("healMisclassifiedGoogleAdsDisconnect"),
        "retired stored-connection self-heal must not reappear in the sync scheduler",
      );
      assert.ok(
        syncSrc.includes('emptySummary(true, "not_configured")') &&
          syncSrc.includes('emptySummary(true, "env_token_rejected")'),
        "credential-level skips use the env-model reasons (not_configured / env_token_rejected)",
      );
      // Task #3787: scheduler wiring lives in server/boot/ after the split.
      const indexSrc = [
        "server/index.ts",
        ...readdirSync("server/boot").filter((f) => f.endsWith(".ts")).sort()
          .map((f) => `server/boot/${f}`),
      ].map(read).join("\n");
      assert.match(indexSrc, /startGoogleAdsSyncScheduler\(\)/);
    },
  );

  if (failed > 0) throw new Error(`${failed} completeness test(s) failed`);
  console.log("google-ads-account-list-completeness: all tests passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
