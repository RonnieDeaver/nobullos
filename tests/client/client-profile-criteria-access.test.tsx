/* test-registration
{
  "name": "Ads OS client profile exposes criteria to authenticated non-CEO viewers while preserving forced-action gates",
  "regression": true,
  "smoke": true,
  "smokeReason": "The reported regression was a role-gated discovery control on the client profile. This deterministic DB-free jsdom mount drives the real account-manager auth hook, profile payload, criteria editor, and save request so the non-CEO path fails fast without browser or vendor cost.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/client-profile-criteria-access-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "medium"
}
test-registration */
/**
 * The criteria API is shared by every authenticated Ads OS viewer, while
 * unrelated forced actions (such as regenerating a persisted log summary)
 * remain CEO-only. Mount the real ClientProfile and CriteriaEditor as an
 * account manager to pin the user-visible boundary:
 *   1. The hero targets the profile payload's primary criteria account.
 *   2. Every GAds/LSA Tools row exposes its own Criteria action.
 *   3. The shared editor loads and saves for that primary account.
 *   4. The unrelated CEO-only regeneration control stays hidden.
 */

import { strict as assert } from "node:assert";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const PRIMARY_CID = "1111111111";
const LSA_CID = "2222222222";
const CLIENT_NAME = "Acme Law";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: `http://localhost/ads-os/client/${encodeURIComponent(CLIENT_NAME)}`,
  },
);

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window.HTMLElement.prototype as any).scrollIntoView = function () {};
(dom.window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
});
dom.window.document.oninput = null;

const ACCOUNT_MANAGER = {
  id: "account-manager-criteria-profile",
  email: "account-manager@example.com",
  firstName: "Alex",
  lastName: "Manager",
  role: "account_manager",
};

const PROFILE = {
  client: CLIENT_NAME,
  doer: null,
  checker: null,
  currency_code: "USD",
  has_gads: true,
  has_lsa: true,
  kpis: {
    spend_30d: 0,
    spend_prev: 0,
    leads_30d: 0,
    leads_prev: 0,
    cpl_30d: null,
    cpl_prev: null,
  },
  alerts: {
    critical: 0,
    high: 0,
    medium: 0,
    total: 0,
    needs_attention: false,
    items: [],
    items_truncated: 0,
    accounts: [],
  },
  accounts: [
    {
      product: "gads",
      customer_id: PRIMARY_CID,
      name: "Acme Law",
      city: null,
      ads_status: "on",
      status_check: null,
      currency: "USD",
      spend_30d: 0,
      spend_prev: 0,
      leads_30d: 0,
      leads_prev: 0,
      cpl_30d: null,
      cpl_prev: null,
    },
    {
      product: "lsa",
      customer_id: LSA_CID,
      name: "Acme Law",
      city: "Austin",
      ads_status: "on",
      status_check: null,
      currency: "USD",
      spend_30d: 0,
      spend_prev: 0,
      leads_30d: 0,
      leads_prev: 0,
      cpl_30d: null,
      cpl_prev: null,
    },
  ],
  pacing: { rows: [], combined: null },
  hygiene: [],
  quality: [],
  pyramid: [],
  log_url: "https://example.com/client-log",
  has_log: true,
  criteria_account: { customer_id: PRIMARY_CID, name: "Acme Law" },
  generated_at: "2026-08-24T12:00:00.000Z",
  from_cache: false,
};

const EMPTY_CRITERIA = {
  business_name: "Acme Law",
  website: "",
  practice_areas: [],
  service_area: "",
  services_offered: "",
  services_not_offered: "",
  competitors: "",
  extra_protected_terms: "",
  notes: "",
  schedule_days: [],
  lsa_schedule_days: [],
};

const fetched: { url: string; method: string }[] = [];
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: ({ url, method }: { url: string; method: string }) => {
    fetched.push({ url, method });
  },
  routes: [
    { path: "/api/auth/user", json: ACCOUNT_MANAGER },
    { path: "/api/ads-os/client/profile", json: PROFILE },
    {
      path: "/api/ads-os/client/performance",
      json: ({ url }: { url: string }) => {
        const params = new URL(url, "http://localhost").searchParams;
        return {
          client: CLIENT_NAME,
          currency_code: "USD",
          start: params.get("start"),
          end: params.get("end"),
          accounts: [],
          generated_at: "2026-08-24T12:00:00.000Z",
          from_cache: false,
        };
      },
    },
    {
      path: "/api/ads-os/client/log-summary",
      json: {
        state: "ok",
        entries: [],
        row_count: 0,
        window_days: 30,
        generated_at: "2026-08-24T12:00:00.000Z",
      },
    },
    {
      method: "GET",
      path: new RegExp(`/api/ads-os/clients/${PRIMARY_CID}/criteria$`),
      json: {
        criteria: EMPTY_CRITERIA,
        derived: { business_name: "Acme Law", service_area: "Austin, TX" },
        practice_area_options: [],
        practice_area_sync_available: true,
        practice_area_sync_reason: null,
      },
    },
    {
      method: "PUT",
      path: new RegExp(`/api/ads-os/clients/${PRIMARY_CID}/criteria$`),
      json: { ok: true, updated_at: "2026-08-24T12:00:00.000Z" },
    },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ClientProfile } = await import("../../client/src/pages/adsOs/ClientProfile");

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(8);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const root = createRoot(document.getElementById("root")!);

try {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ClientProfile as any, { name: CLIENT_NAME }),
      ),
    );
  });
  await flush();

  assert(byTestId("page-ads-os-client"), "the real client profile must render");
  const heroCriteria = byTestId("button-client-criteria");
  assert(heroCriteria, "an account manager must see the hero Client criteria button");

  const accountCriteriaButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '#cp-tools button[title="Edit this account\'s criteria"]',
    ),
  );
  assert.equal(
    accountCriteriaButtons.length,
    2,
    "each criteria-capable GAds/LSA Tools row must expose Criteria",
  );
  assert.equal(
    byTestId("button-regenerate-log"),
    null,
    "the unrelated CEO-only log regeneration control must remain hidden",
  );

  await click(heroCriteria!);

  assert(byTestId("modal-criteria"), "the hero action must open the shared criteria editor");
  assert.match(
    document.getElementById("ads-os-criteria-title")?.textContent ?? "",
    /Client criteria — Acme Law/,
    "the editor title must identify the primary account",
  );
  assert(
    fetched.some(
      ({ url, method }) =>
        method === "GET" && url === `/api/ads-os/clients/${PRIMARY_CID}/criteria`,
    ),
    "opening the hero action must load criteria for the profile's primary account",
  );

  const save = byTestId("button-criteria-save");
  assert(save, "the loaded shared editor must expose its save flow to the account manager");
  await click(save!);

  assert(
    fetched.some(
      ({ url, method }) =>
        method === "PUT" && url === `/api/ads-os/clients/${PRIMARY_CID}/criteria`,
    ),
    "saving from the non-CEO profile path must use the primary account criteria endpoint",
  );
  assert.equal(byTestId("modal-criteria"), null, "a successful shared save must close the editor");

  console.log(
    "client-profile-criteria-access: account manager sees hero + per-account criteria, opens/saves the primary editor, and gains no forced log regeneration control.",
  );
} finally {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}