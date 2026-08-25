/* test-registration
{
  "name": "Slack notifications console — sustained-outage banner renders (Task #4645)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4645: the console banner is the operator-facing half of the sustained Slack-outage alarm — prod Slack alerting sat at 100% channel_not_found for weeks with no unmissable surface (audits/slack-outage-diagnosis-2026-08-12.md). The completion review required a mount test proving the ACTIVE detector state actually RENDERS (day count, failure counts, failing channel, repair copy) and that the banner clears when the detector reports no outage. A refactor of SlackNotificationsConsole could silently drop the banner without any server test noticing — exactly the operator-blindness this task exists to fix. Fast deterministic jsdom mount — fully stubbed fetch, no DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #4645 — the /admin/slack/notifications sustained-outage banner must
 * actually render on screen while the detector reports an active outage.
 *
 * The server side (detector lifecycle, console route payload) is covered by
 * tests/slack-outage-detector.test.ts and the console route suite; this test
 * pins the LAST hop: the page consumes `slackOutage` from the console
 * response and paints the unmissable red banner.
 *
 *   Scenario 1 — active outage: `/api/admin/notifications` returns a full
 *   SlackOutageStatus (day 9, 120/120 failures, channel_not_found, failing
 *   channel id). Asserts:
 *     - `banner-slack-outage` renders,
 *     - `text-outage-title` carries the day count ("day 9"),
 *     - `text-outage-stats` carries "120 of 120" + the latest error,
 *     - the failing channel id is named,
 *     - the plain-language repair copy ("Send test") is present.
 *
 *   Scenario 2 (control) — `slackOutage: null`: the banner does NOT render
 *   while the rest of the console (title, summary cards) still does — the
 *   absence is a real clear, not a failed mount.
 *
 * Mounts the REAL page against the real production queryClient with a
 * stubbed fetch (mirrors tests/client/prod-actions-selfheal-reconnect-notice
 * .test.tsx — batch-safe: createElement only, no portals opened at mount).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/slack/notifications" },
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-4645",
  email: "admin@example.com",
  firstName: "Ad",
  lastName: "Min",
  role: "ceo",
};

const FAILING_CHANNEL = "C-test-outage";
const LAST_ERROR = "Slack API error: channel_not_found";

/** Full SlackOutageStatus shape as the console route serves it (Task #4645). */
const ACTIVE_OUTAGE = {
  active: true,
  openedAt: "2026-08-12T09:00:00.000Z",
  failingSince: "2026-08-04T00:00:00.000Z",
  dayCount: 9,
  dayCountLabel: "9",
  windowAttempts: 120,
  windowFailures: 120,
  windowSuccesses: 0,
  lastFailureAt: "2026-08-12T08:55:00.000Z",
  lastSuccessAt: null,
  lastErrorMessage: LAST_ERROR,
  topFailing: [
    { notificationId: "usage.rate_limits.warning", channelId: FAILING_CHANNEL, failures: 120 },
  ],
  lastEscalatedAt: "2026-08-12T09:00:00.000Z",
};

// Mutable per-scenario: the console-route respond() reads this.
let currentOutage: typeof ACTIVE_OUTAGE | null = ACTIVE_OUTAGE;

const consolePayload = () => ({
  summary: {
    total: 42,
    implemented: 30,
    enabled: 25,
    configured: 20,
    missingChannel: 2,
    failed24h: 120,
    slackConnected: true,
  },
  categories: [],
  slackOutage: currentOutage,
});

// Specific routes FIRST — string paths prefix-match, so the bare console
// route must sit below its /kill-switch, /user-slack-*, /call-archive-* kin.
const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: ADMIN_USER },
    {
      path: "/api/admin/notifications/kill-switch",
      json: { enabled: false, updatedAt: null, updatedBy: null },
    },
    { path: "/api/admin/notifications/user-slack-identities", json: { identities: [] } },
    { path: "/api/admin/notifications/user-slack-dm-enabled", json: { enabled: false } },
    {
      path: "/api/admin/notifications/call-archive-thresholds/live-counts",
      json: {
        pendingStuck: 0,
        recentFailures: 0,
        pendingHours: 4,
        failedLookbackHours: 24,
        evaluatedAt: "2026-08-12T09:00:00.000Z",
      },
    },
    {
      path: "/api/admin/notifications/call-archive-thresholds",
      json: {
        enabled: true,
        pendingHours: 4,
        pendingCount: 5,
        failedLookbackHours: 24,
        failedCount: 3,
        cooldownMinutes: 360,
        audit: {},
      },
    },
    { path: "/api/integrations/slack/channels", json: { channels: [] } },
    { path: "/api/admin/notifications", json: () => consolePayload() },
  ],
  defaultJson: {
    rows: [],
    items: [],
    notifications: [],
    deliveries: [],
    identities: [],
    channels: [],
  },
});

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const consoleMod = await import(
  "../../client/src/pages/admin/SlackNotificationsConsole"
);
const SlackNotificationsConsole =
  (consoleMod as any).default ?? (consoleMod as any).SlackNotificationsConsole;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(SlackNotificationsConsole as any),
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
  // ── Scenario 1: active outage → unmissable banner renders ──────────────
  console.log("\n— Scenario 1: console payload carries an ACTIVE slackOutage —");
  currentOutage = ACTIVE_OUTAGE;
  {
    const root = await mountPage();
    try {
      assert(
        $("page-slack-notifications-console") !== null,
        "console page must mount",
      );

      const banner = $("banner-slack-outage");
      assert(banner !== null, "banner-slack-outage must render while the outage is active");

      const title = $("text-outage-title");
      assert(title !== null, "outage title must render");
      assert(
        (title!.textContent || "").includes("day 9"),
        `outage title must carry the day count "day 9", got: ${title!.textContent}`,
      );

      const stats = $("text-outage-stats");
      assert(stats !== null, "outage stats line must render");
      const statsText = (stats!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        statsText.includes("120 of 120"),
        `stats line must read "120 of 120", got: ${statsText}`,
      );
      assert(
        statsText.includes(LAST_ERROR),
        `stats line must surface the latest error "${LAST_ERROR}", got: ${statsText}`,
      );

      const bannerText = (banner!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        bannerText.includes(FAILING_CHANNEL),
        `banner must name the failing channel "${FAILING_CHANNEL}", got: ${bannerText}`,
      );
      assert(
        bannerText.includes("Send test"),
        `banner must carry the plain-language repair copy ('Send test'), got: ${bannerText}`,
      );

      console.log("  ✓ banner renders with day count, 120/120 stats, error, channel + repair copy");
    } finally {
      await unmount(root);
    }
  }

  // ── Scenario 2 (control): no outage → banner absent, page still renders ─
  console.log("\n— Scenario 2: console payload carries slackOutage: null —");
  currentOutage = null;
  {
    const root = await mountPage();
    try {
      assert(
        $("banner-slack-outage") === null,
        "banner-slack-outage must NOT render when the detector reports no outage",
      );
      // The absence must be a real clear, not a failed mount: the console
      // itself (title + summary cards from the same payload) still renders.
      assert(
        $("page-slack-notifications-console") !== null,
        "console page must still mount without an outage",
      );
      assert($("title-console") !== null, "console title must render");
      assert(
        $("summary-cards") !== null,
        "summary cards must render from the same console payload",
      );

      console.log("  ✓ no banner; console title + summary cards still render (real clear, not a dead mount)");
    } finally {
      await unmount(root);
    }
  }

  console.log(
    "\nslack-outage-banner: the Task #4645 sustained-outage banner renders on screen while active (day count, counts, channel, repair copy) and clears when the detector reports none.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
