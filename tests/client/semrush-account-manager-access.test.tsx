/* test-registration
{
  "name": "SEMrush account-manager access — AM hub view, no connect/disconnect (Task #2903)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/semrush-account-manager-access-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2903 — SEMrush integration UI access for account managers.
 *
 * Account managers can visit /admin/integrations and the SEMrush console.
 * The hub shows a simplified view: SEMrush card with status badge and
 * "Open SEMrush Console" button but no connect / disconnect controls.
 * A team_lead+ user continues to reach the full hub (not the AM view).
 * A user with no elevated role still sees access-denied.
 *
 * Mounts the real IntegrationsHub against the real queryClient with a
 * stubbed globalThis.fetch. Pattern matches
 * tests/client/integrations-hub-all-status-unknown.test.tsx (Task #2830).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const AM_USER = {
  id: "am-2903",
  email: "talente@nobullmarketing.com",
  firstName: "Talent",
  lastName: "Edge",
  role: "account_manager",
};

const TEAM_LEAD_USER = {
  id: "tl-2903",
  email: "lead@nobullmarketing.com",
  firstName: "Team",
  lastName: "Lead",
  role: "team_lead",
};

const REPORTING_USER = {
  id: "rpt-2903",
  email: "rpt@nobullmarketing.com",
  firstName: "Report",
  lastName: "Viewer",
  role: "reporting",
};

const SEMRUSH_CONNECTED_STATUS = {
  front: { connected: false },
  slack: { connected: false },
  zoom: { connected: false },
  twilio: { connected: false },
  pandadoc: { connected: false },
  stripe: { connected: false },
  googleAds: { connected: false, configured: false },
  semrush: { connected: true },
};

function makeFetchHandler(
  authUser: unknown,
  allStatusJson: unknown = SEMRUSH_CONNECTED_STATUS,
): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      { path: "/api/auth/user", json: authUser },
      { path: "/api/integrations/all-status", json: allStatusJson },
      { path: "/api/semrush/status", json: { connected: true, expired: false } },
      { path: "/api/backfill-jobs", json: { rows: [] } },
    ],
    defaultJson: {},
  }) as any;
}

// Task #2907 — fetch handler for the SEMrush Operations Console page
// (/admin/integrations/semrush). Stubs every read endpoint the console
// panels hit so the full page renders for the given auth user.
// Recorded POST bodies to /api/semrush/heatmaps/backfill from the console
// (reset per case) so the test can assert the dry-run trigger actually fires
// the real request with dryRun: true — not just that the button renders.
const recordedBackfillPosts: Array<{ url: string; body: any }> = [];

function makeConsoleFetchHandler(
  authUser: unknown,
): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        method: "POST",
        // Exact match — must not swallow /backfill/coverage or /backfill/runs.
        test: (url: string) => url === "/api/semrush/heatmaps/backfill",
        respond: ({ url, init }: any) => {
          const body = init?.body ? JSON.parse(init.body) : {};
          recordedBackfillPosts.push({ url, body });
          return {
            status: 200,
            json: {
              dryRun: !!body.dryRun,
              jobId: null,
              mappings: [
                {
                  clientId: "client-1",
                  locationId: "loc-1",
                  semrushCampaignId: "camp-1",
                  semrushCampaignName: "Campaign One",
                },
              ],
              campaignsConsidered: 1,
              campaignsFetched: 1,
              campaignFetchFailures: [],
              reportDatesEnqueued: [
                { campaignId: "camp-1", reportDate: "2026-06-01", jobId: null },
              ],
              reportDatesSkipped: [],
              enqueuedJobCount: 1,
            },
          };
        },
      },
      { method: "POST", json: {} },
      { path: "/api/auth/user", json: authUser },
      { path: "/api/integrations/all-status", json: SEMRUSH_CONNECTED_STATUS },
      {
        path: "/api/semrush/console/overview",
        json: {
          connection: {
            status: "connected",
            tokenExpiresAt: null,
            tokenExpiresInMs: null,
          },
          inventory: {
            isRunning: false,
            campaignCount: 0,
            lastFetchedAt: null,
            flags: { inventorySyncEnabled: true, reportRefreshEnabled: true },
            durability: "durable",
          },
          queues: [],
          locationSync: { counts: {}, awaitingAutoRetry: 0 },
          staleLease: {
            countInWindow: 0,
            windowMs: 0,
            threshold: 0,
            durability: "in-memory",
          },
          generatedAt: new Date().toISOString(),
        },
      },
      {
        path: "/api/semrush/console/sync-state",
        json: { rows: [], perClient: [], totals: {}, outcomeTotals: {} },
      },
      { path: "/api/semrush/console/recent-jobs", json: { rows: [] } },
      {
        path: "/api/integrations/semrush/mapping-inventory",
        json: {
          items: [],
          totalCount: 0,
          shownCount: 0,
          counts: { linked: 0, stale: 0, orphanLocation: 0 },
        },
      },
      {
        path: "/api/integrations/semrush/mapping-suggestions",
        json: {
          items: [],
          totalCount: 0,
          shownCount: 0,
          counts: {},
        },
      },
      {
        path: "/api/integrations/semrush/heatmap-coverage",
        json: {
          generatedAt: new Date().toISOString(),
          summary: {
            mappings: 0,
            campaignsFetched: 0,
            campaignFetchFailures: 0,
            dateTuples: 0,
            ok: 0,
            partial: 0,
            missing: 0,
            inconclusive: 0,
          },
          perLocation: [],
          campaignFetchFailures: [],
        },
      },
      { path: "/api/semrush/status", json: { configured: true, connected: true, expired: false } },
      {
        path: "/api/semrush/inventory/status",
        json: {
          isRunning: false,
          hasPreviousInventory: false,
          campaignCount: 0,
          lastFetchedAt: null,
        },
      },
      { path: "/api/semrush/inventory/campaigns", json: { campaigns: [], fetchedAt: null } },
      { path: "/api/semrush/heatmaps/backfill/runs", json: { runs: [] } },
      { path: "/api/clients", json: [] },
    ],
    defaultJson: {},
  }) as any;
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const IntegrationsHub = (await import("../../client/src/pages/admin/IntegrationsHub")).default;
const SemrushIntegration = (await import("../../client/src/pages/admin/SemrushIntegration")).default;

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountHub(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(IntegrationsHub as any),
      ),
    );
  });
  await flush();
  return root!;
}

async function mountConsole(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(SemrushIntegration as any),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("SEMrush account-manager access (Task #2903)");

  // Case 1 — account_manager sees the AM hub view, NOT access-denied.
  activeFetchHandler = makeFetchHandler(AM_USER);
  let root = await mountHub();
  try {
    const denied = $("text-access-denied");
    assert(denied === null, "account_manager must NOT see the access-denied gate");

    const amPage = $("page-integrations-hub-am");
    assert(amPage !== null, "account_manager must see the AM hub view (page-integrations-hub-am)");

    const card = $("card-semrush-integration");
    assert(card !== null, "AM view must contain the SEMrush integration card");

    const openBtn = $("button-semrush-open-console");
    assert(openBtn !== null, "AM view must show the 'Open SEMrush Console' button");

    const connectBtn = $("button-semrush-connect");
    assert(connectBtn === null, "AM view must NOT show a connect button");

    const disconnectBtn = $("button-semrush-disconnect");
    assert(disconnectBtn === null, "AM view must NOT show a disconnect button");

    const hint = $("text-semrush-admin-only-hint");
    assert(hint !== null, "AM view must show the admin-only hint for connect/disconnect");
    assert(
      /team lead/i.test(hint!.textContent || ""),
      `hint must mention Team Lead — got "${hint!.textContent}"`,
    );

    console.log("  ✓ account_manager sees AM hub view with SEMrush card, no connect/disconnect, hint visible");
  } finally {
    await unmount(root);
  }

  // Case 2 — team_lead sees the full hub, NOT the simplified AM view.
  activeFetchHandler = makeFetchHandler(TEAM_LEAD_USER);
  root = await mountHub();
  try {
    const amPage = $("page-integrations-hub-am");
    assert(amPage === null, "team_lead must NOT see the AM hub view — they get the full hub");

    const denied = $("text-access-denied");
    assert(denied === null, "team_lead must NOT see access-denied");

    console.log("  ✓ team_lead reaches the full hub (not the AM view, not access-denied)");
  } finally {
    await unmount(root);
  }

  // Case 3 — reporting role is denied.
  activeFetchHandler = makeFetchHandler(REPORTING_USER);
  root = await mountHub();
  try {
    const denied = $("text-access-denied");
    assert(denied !== null, "reporting role must see access-denied");

    const amPage = $("page-integrations-hub-am");
    assert(amPage === null, "reporting role must NOT see the AM hub view");

    console.log("  ✓ reporting role sees access-denied (not the hub)");
  } finally {
    await unmount(root);
  }

  // -------------------------------------------------------------------------
  // Task #2907 — SEMrush Operations Console (/admin/integrations/semrush)
  // -------------------------------------------------------------------------

  // Case 4 — account_manager gets the full console: read-only panels render,
  // backfill trigger buttons are present, and no cadence/trends links leak in.
  // Pre-fill a campaign scope via the panel's supported URL params so the
  // dry-run button is enabled (it requires at least one scope selection).
  // wouter monkey-patches history.replaceState to call the GLOBAL
  // dispatchEvent, which this bare harness doesn't define — shim it.
  if (typeof (globalThis as any).dispatchEvent !== "function") {
    (globalThis as any).dispatchEvent = () => true;
  }
  dom.window.history.replaceState(
    {},
    "",
    "/admin/integrations/semrush?prefillCampaignIds=camp-1",
  );
  activeFetchHandler = makeConsoleFetchHandler(AM_USER);
  root = await mountConsole();
  try {
    assert(
      $("page-semrush-console-denied") === null,
      "account_manager must NOT see the console access-denied gate",
    );
    assert(
      $("page-semrush-console") !== null,
      "account_manager must see the SEMrush console page (page-semrush-console)",
    );

    // Read-only status panels render for AMs.
    for (const id of [
      "section-semrush-overview",
      "section-semrush-sync-state",
      "section-semrush-mapping-inventory",
      "section-semrush-mapping-suggestions",
      "section-heatmap-coverage",
      "section-semrush-backfill",
      "section-semrush-recent-jobs",
    ]) {
      assert($(id) !== null, `console panel "${id}" must render for account_manager`);
    }

    // Backfill trigger buttons exist for AMs (backend allows account_manager
    // on POST /api/semrush/heatmaps/backfill — requireAccountManager).
    assert(
      $("button-semrush-backfill-dry-run") !== null,
      "AM must see the backfill dry-run button",
    );
    assert(
      $("button-semrush-backfill-apply") !== null,
      "AM must see the backfill apply button",
    );
    assert(
      $("button-heatmap-coverage-refresh") !== null,
      "AM must see the heatmap coverage refresh button",
    );
    // The disconnected fallback must NOT show — /api/semrush/status is
    // connected, so the trigger UI (not the "connect first" notice) renders.
    assert(
      $("section-semrush-backfill-disconnected") === null,
      "backfill panel must not show the disconnected notice when SEMrush is connected",
    );

    // No cadence/trends navigation leaks into the console for AMs. The
    // cadence dashboard (/admin/semrush/cadence) is deliberately not linked
    // from console panels; if a link is ever added it must be isAdmin-gated.
    const consolePage = $("page-semrush-console")!;
    const links = Array.from(consolePage.querySelectorAll("a"));
    const leakedLinks = links.filter((a) => {
      const href = a.getAttribute("href") || "";
      return /cadence|trends/i.test(href);
    });
    assert(
      leakedLinks.length === 0,
      `console must not expose cadence/trends links to account_manager — found ${leakedLinks
        .map((a) => a.getAttribute("href"))
        .join(", ")}`,
    );

    // The dry-run trigger WORKS for an AM: clicking it fires the real
    // POST /api/semrush/heatmaps/backfill with dryRun: true and the preview
    // section renders from the response — not just a visible button.
    recordedBackfillPosts.length = 0;
    const dryRunBtn = $("button-semrush-backfill-dry-run") as HTMLButtonElement;
    assert(!dryRunBtn.disabled, "dry-run button must be enabled for account_manager");
    await act(async () => {
      dryRunBtn.click();
    });
    await flush();
    assert(
      recordedBackfillPosts.length === 1,
      `dry-run click must POST /api/semrush/heatmaps/backfill exactly once (got ${recordedBackfillPosts.length})`,
    );
    assert(
      recordedBackfillPosts[0].body.dryRun === true,
      "dry-run POST body must carry dryRun: true",
    );
    assert(
      recordedBackfillPosts[0].body.confirm === undefined,
      "dry-run POST must NOT carry confirm: true",
    );
    assert(
      $("section-semrush-backfill-preview") !== null,
      "dry-run preview section must render from the POST response",
    );
    assert(
      $("text-semrush-preview-mappings")?.textContent === "1",
      "preview must render the mapping count from the response",
    );

    console.log(
      "  ✓ account_manager sees the full console: panels render, backfill dry-run trigger fires POST dryRun:true + preview renders, no cadence/trends links",
    );
  } finally {
    await unmount(root);
  }

  // Case 5 — reporting role is denied the console.
  activeFetchHandler = makeConsoleFetchHandler(REPORTING_USER);
  root = await mountConsole();
  try {
    assert(
      $("page-semrush-console-denied") !== null,
      "reporting role must see the console access-denied gate",
    );
    assert(
      $("page-semrush-console") === null,
      "reporting role must NOT see the console content",
    );
    console.log("  ✓ reporting role is denied the SEMrush console");
  } finally {
    await unmount(root);
  }

  console.log("\nsemrush-account-manager-access: all cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
