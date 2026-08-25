/* test-registration
{
  "name": "Profile ?tab= deep-link routing — tab select, param preservation, invalid fallback (Task #3105)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3105: the Profile `?tab=` deep-link test guards email-link tab routing, cross-param preservation on tab switch (the ?calendar=connected OAuth round-trip), and the invalid-tab fallback. Same fast/deterministic jsdom shape as the ClientDetail tab test above — gate it so tab-routing drift on the Profile page fails fast instead of rotting.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/profile-tab-deeplink-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3105 — Profile page `?tab=` deep-link routing.
 *
 * The Profile page supports deep-linking via a `?tab=` query param (account,
 * communications, booking, notifications, meetings) — e.g. email links that
 * point a user straight at a specific tab. This test mounts the REAL
 * `Profile.tsx` inside a wouter `Route` (so the jsdom location drives the
 * initial tab) and pins:
 *
 *   1. `/profile?tab=communications` → the Communications card renders and
 *      the Account panel does NOT.
 *   2. `/profile?tab=booking`        → the Booking panel mounts (stub marker).
 *   3. `/profile?calendar=connected` → lands on Booking (OAuth round-trip
 *      landing rule), and clicking Communications rewrites the URL to include
 *      `tab=communications` WITHOUT dropping the existing `calendar=connected`
 *      query param.
 *   4. `/profile?tab=invalid`        → falls back to the Account tab.
 *
 * Heavy feature panels (BookingSettingsPanel, MyMeetingsPanel,
 * UserNotificationSettingsPanel) are stubbed to marker divs and `cmdk` is
 * shimmed by `profile-tab-deeplink-loader.mjs` (registered via `--import`).
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
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
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
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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

// ---------------------------------------------------------------------------
// Stub fetch — answers the small set of endpoints Profile hits on mount.
// ---------------------------------------------------------------------------

const testUser = {
  id: "user-3105",
  email: "profile-tabs@test.local",
  firstName: "Deep",
  lastName: "Linker",
  role: "team_member",
  profileImageUrl: null,
  timezone: "America/Chicago",
  functions: [],
  authorityLevel: "core",
};

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      path: "/api/users/me/twilio-settings",
      json: { callerIdName: "", smsSignOff: "", callRoutingPhone: "", callMode: "browser" },
    },
    {
      path: "/api/integrations/clickup/status",
      json: {
        connected: false,
        clickupEmail: null,
        clickupUsername: null,
        workspaceId: null,
        status: "disconnected",
        lastError: null,
      },
    },
  ],
  // Default: empty 200 so incidental requests don't error the page.
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
// Profile.tsx calls useTheme(), so the mount needs the real ThemeProvider
// (App-level in production). ThemeProvider itself consumes the Clerk-stubbed
// useAuth and guards matchMedia, so it mounts cleanly in the jsdom harness.
const { ThemeProvider } = await import("../../client/src/lib/theme");
const Profile = (await import("../../client/src/pages/Profile")).default;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function setLocation(path: string): void {
  dom.window.history.replaceState({}, "", path);
}

async function mountAt(): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const qc = makeClient();
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(
          ThemeProvider as any,
          null,
          React.createElement(
            Router as any,
            null,
            React.createElement(Route as any, { path: "/profile", component: Profile }),
          ),
        ),
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
  dom.window.localStorage.clear();
}

// Returns the tab value of the currently-active Radix trigger, or null.
function activeTabValue(): string | null {
  const triggers = Array.from(
    document.querySelectorAll('[data-testid^="tab-"]'),
  ) as HTMLElement[];
  assert(triggers.length > 0, "tab triggers must render once the user loads");
  const active = triggers.filter((t) => t.getAttribute("data-state") === "active");
  if (active.length !== 1) return null;
  return active[0].getAttribute("data-testid")!.replace(/^tab-/, "");
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

// Radix Tabs activate on a left-button mousedown (automatic activation mode).
async function clickTab(value: string): Promise<void> {
  const trigger = byTestId(`tab-${value}`);
  assert(!!trigger, `tab trigger 'tab-${value}' must be rendered`);
  await act(async () => {
    trigger!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await flush(5);
}

// ---------------------------------------------------------------------------
// Scenario 1: ?tab=communications → Communications card visible, Account not.
// ---------------------------------------------------------------------------

async function scenarioCommunicationsTab(): Promise<void> {
  console.log("\n— Scenario 1: /profile?tab=communications → Communications card, not Account —");
  setLocation("/profile?tab=communications");
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "communications",
      `?tab=communications must activate the Communications tab (got '${active}')`,
    );
    assert(
      !!byTestId("card-comm-settings"),
      "the Communications settings card must be visible",
    );
    // Radix keeps inactive TabsContent mounted as an empty hidden shell —
    // the meaningful check is that the Account *content* (the card) is gone
    // and the shell is marked inactive/hidden.
    const accountPanel = byTestId("tabpanel-account");
    assert(
      !byTestId("card-user-info"),
      "the Account card must NOT render when Communications is active",
    );
    assert(
      !accountPanel ||
        (accountPanel.getAttribute("data-state") === "inactive" &&
          accountPanel.hasAttribute("hidden")),
      "the Account tab panel must be inactive and hidden",
    );
    console.log("  ✓ Communications card rendered; Account card absent");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: ?tab=booking → the Booking panel mounts.
// ---------------------------------------------------------------------------

async function scenarioBookingTab(): Promise<void> {
  console.log("\n— Scenario 2: /profile?tab=booking → Booking panel renders —");
  setLocation("/profile?tab=booking");
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "booking",
      `?tab=booking must activate the Booking tab (got '${active}')`,
    );
    assert(
      !!byTestId("stub-booking-settings-panel"),
      "the Booking settings panel must mount inside the Booking tab",
    );
    console.log("  ✓ Booking panel mounted");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: ?calendar=connected lands on Booking; switching tabs rewrites
// the URL WITHOUT dropping the existing calendar param.
// ---------------------------------------------------------------------------

async function scenarioTabSwitchPreservesParams(): Promise<void> {
  console.log(
    "\n— Scenario 3: /profile?calendar=connected → Booking; tab switch preserves calendar param —",
  );
  setLocation("/profile?calendar=connected");
  const root = await mountAt();
  try {
    // The OAuth round-trip landing rule: no ?tab but ?calendar=connected
    // must land on Booking so its mount effect shows the success toast.
    const active = activeTabValue();
    assert(
      active === "booking",
      `?calendar=connected must land on the Booking tab (got '${active}')`,
    );
    await clickTab("communications");
    assert(
      activeTabValue() === "communications",
      "clicking the Communications trigger must activate that tab",
    );
    const params = new URLSearchParams(dom.window.location.search);
    assert(
      params.get("tab") === "communications",
      `URL must carry tab=communications after the switch (got '${dom.window.location.search}')`,
    );
    assert(
      params.get("calendar") === "connected",
      `URL must PRESERVE calendar=connected after the switch (got '${dom.window.location.search}')`,
    );
    console.log(`  ✓ location.search → ${dom.window.location.search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: ?tab=invalid → falls back to the Account tab.
// ---------------------------------------------------------------------------

async function scenarioInvalidTabFallback(): Promise<void> {
  console.log("\n— Scenario 4: /profile?tab=invalid → Account fallback —");
  setLocation("/profile?tab=invalid");
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "account",
      `?tab=invalid must fall back to the Account tab (got '${active}')`,
    );
    assert(
      !!byTestId("card-user-info"),
      "the Account card must render on the fallback tab",
    );
    console.log("  ✓ fell back to Account");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioCommunicationsTab();
  await scenarioBookingTab();
  await scenarioTabSwitchPreservesParams();
  await scenarioInvalidTabFallback();
  console.log("\nprofile-tab-deeplink: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
