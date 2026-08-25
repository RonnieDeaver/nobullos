/* test-registration
{
  "name": "CeoPulseAdmin — Re-analyze confirm flow (Task #4901)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4901: pins the restored Brief Studio Re-analyze control — the button is visible in the visual-step controls bar, the confirm dialog states what a re-run replaces (published briefs additionally warn that clients see the change immediately), cancel closes it firing NO analyze request, confirm fires POST /api/ceo-pulses/:id/analyze exactly once with a busy state that blocks double-fire, and on success the refreshed analysis + single 'Visual regenerated!' toast land while the letter survives. DB-free, network-free jsdom mount of the REAL CeoPulseAdmin page with the lifecycle alert-dialog shim (real closed→open→cancel→reopen→confirm semantics).",
  "extraNodeArgs": [
    "--import",
    "./tests/ceo-pulse-reanalyze-confirm-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * CeoPulseAdmin Re-analyze confirm flow (Task #4901).
 *
 * A dedicated "Re-analyze" button was removed in the January 2026 workflow
 * simplification, leaving the unlabeled Edit Content → Generate Visual detour
 * as the only way to re-run the AI analysis for an existing brief. Task #4901
 * restores a clearly labeled control in the visual-step controls bar, gated
 * behind an alert-dialog confirm (a re-run replaces chat refinements and
 * takeaway links; the letter HTML and supporting images survive).
 *
 * Pins (dialog-lifecycle convention — the shim models real Radix open/close):
 *   1. Visual step shows the Re-analyze button in the controls bar; the
 *      confirm dialog starts CLOSED (confirm button absent from the DOM).
 *   2. Opening the dialog fires nothing; the copy names what gets replaced
 *      and what is kept; a DRAFT brief shows no published warning; Cancel
 *      closes the dialog (confirm button gone) having fired zero requests.
 *   3. Reopen → confirm fires the analyze POST exactly once and closes the
 *      dialog; while in flight the trigger is disabled with busy copy (no
 *      double-fire) and no success toast fires before the server confirms;
 *      on success exactly one "Visual regenerated!" toast fires, the takeaway
 *      panel reflects the REFRESHED analysis, and the letter is untouched.
 *   4. A PUBLISHED brief's dialog copy additionally warns that clients see
 *      the updated analysis immediately; cancel still fires nothing.
 *
 * Mounts the REAL CeoPulseAdmin page inside the REAL app queryClient with
 * fetch, Clerk, and use-toast stubbed (toasts on globalThis.__capturedToasts).
 */
import { strict as assert } from "node:assert";
import { JSDOM } from "jsdom";
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom bootstrap (must precede dynamic client imports) ─────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/admin/ceo-pulse",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// Guard stubs for browser observers some mounted primitives may probe.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;
(dom.window as any).ResizeObserver = (dom.window as any).ResizeObserver ?? ResizeObserverStub;
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
(dom.window as any).matchMedia = (dom.window as any).matchMedia ?? matchMediaStub;
(globalThis as any).matchMedia = (globalThis as any).matchMedia ?? (dom.window as any).matchMedia;

// ── Clerk stub (fetchWithSessionRetry reads window.Clerk.session.getToken) ────
// Set on dom.window too: `window` in client modules resolves to dom.window.
const clerkSpy = {
  session: {
    getToken: async (_opts?: { skipCache?: boolean }) => "refreshed-token",
  },
};
(globalThis as any).Clerk = clerkSpy;
(dom.window as any).Clerk = clerkSpy;

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CEO_USER = {
  id: "u-ceo-4901",
  email: "ceo@example-nobull.co",
  firstName: "Test",
  lastName: "Ceo",
  role: "ceo",
};

const ORIGINAL_TAKEAWAY = "Original takeaway from the first analysis";
const REFRESHED_TAKEAWAY = "Refreshed takeaway produced by the re-run";
const KEPT_LETTER = "<p>letter that must survive re-analysis</p>";

const DRAFT_PULSE = {
  id: "pulse-4901-draft",
  monthKey: "2026-08",
  title: null,
  rawContent: "August raw content",
  aiAnalysis: {
    headline: "Original headline",
    keyTakeaways: [ORIGINAL_TAKEAWAY],
    strategicImplications: [],
    charts: [],
  },
  fullLetterHtml: KEPT_LETTER,
  includeGraphs: false,
  isPublished: false,
  shareToken: null,
  createdAt: null,
  edition: "company_update",
  supportingImages: [],
};

const PUBLISHED_PULSE = {
  ...DRAFT_PULSE,
  id: "pulse-4901-published",
  monthKey: "2026-07",
  isPublished: true,
  shareToken: "tok-4901",
};

const REFRESHED_DRAFT_PULSE = {
  ...DRAFT_PULSE,
  aiAnalysis: {
    ...DRAFT_PULSE.aiAnalysis,
    headline: "Refreshed headline",
    keyTakeaways: [REFRESHED_TAKEAWAY],
  },
};

let analyzeCalls: string[] = [];

/** (Re)install the fetch stub; auth + list routes stay constant, analyze scripted. */
function installFetch(analyzeRespond: (ctx: any) => any) {
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/auth/user", json: CEO_USER },
      {
        method: "POST",
        path: /\/api\/ceo-pulses\/[^/]+\/analyze$/,
        respond: (ctx: any) => {
          analyzeCalls.push(ctx.url);
          return analyzeRespond(ctx);
        },
      },
      { method: "GET", path: "/api/ceo-pulses", json: () => [DRAFT_PULSE, PUBLISHED_PULSE] },
    ],
    defaultJson: {},
  }) as any;
}

const $t = (id: string): HTMLElement | null =>
  dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function toasts(): any[] {
  return ((globalThis as any).__capturedToasts ?? []) as any[];
}

function consequencesText(): string {
  return $t("text-reanalyze-consequences")?.textContent ?? "";
}

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

async function run(): Promise<void> {
  console.log("CeoPulseAdmin — Re-analyze confirm flow (Task #4901)");

  // Installed before client imports so the auth/pulses queries are always
  // answered. Each case rewires the analyze responder.
  installFetch(() => ({ status: 500, json: {} }));

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const { queryClient } = (await import("@/lib/queryClient")) as any;
  const CeoPulseAdmin = ((await import("@/pages/admin/CeoPulseAdmin")) as any).default;

  const flush = async (times = 10) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush(5);
  };

  const selectMonth = async (label: string) => {
    const span = Array.from(dom.window.document.querySelectorAll("span")).find(
      (s) => s.textContent === label,
    ) as HTMLElement | undefined;
    assert.ok(span, `month dropdown item "${label}" should render (pulses list loaded)`);
    await click(span!.parentElement as HTMLElement);
    await flush(5);
  };

  const resetCase = () => {
    (globalThis as any).__capturedToasts = [];
    analyzeCalls = [];
  };

  // ── Mount the real page under the real app queryClient ─────────────────────
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CeoPulseAdmin),
      ),
    );
  });
  await flush(15);

  // Select the August 2026 draft brief; it has aiAnalysis, so the page lands
  // on the visual step.
  await selectMonth("August 2026");

  // ── 1. Button present on the visual step; dialog starts closed ─────────────
  await check("Re-analyze button renders in the visual-step controls bar, dialog closed", () => {
    const btn = $t("button-reanalyze") as HTMLButtonElement | null;
    assert.ok(btn, "Re-analyze button should render on the visual step");
    assert.equal(btn!.disabled, false, "button enabled while nothing is pending");
    assert.match(btn!.textContent ?? "", /re-analyze/i, "button is clearly labeled");
    // Alongside the other controls-bar actions:
    assert.ok($t("button-edit-links"), "Edit Links shares the controls bar");
    assert.ok($t("button-share-pulse"), "Share shares the controls bar");
    // Lifecycle shim renders dialog content ONLY while open:
    assert.equal($t("dialog-reanalyze"), null, "dialog content absent while closed");
    assert.equal($t("button-reanalyze-confirm"), null, "confirm button absent while closed");
  });

  // ── 2. Open fires nothing; draft copy; cancel closes firing nothing ────────
  await check(
    "open shows replace/keep copy (no published warning on a draft); cancel closes firing nothing",
    async () => {
      resetCase();
      installFetch(() => ({ status: 500, json: {} })); // must never be reached

      await click($t("button-reanalyze")!);
      assert.ok($t("dialog-reanalyze"), "dialog opens on click");
      assert.ok($t("button-reanalyze-confirm"), "confirm button reachable while open");
      assert.equal(analyzeCalls.length, 0, "opening the dialog fires nothing");

      const copy = consequencesText();
      assert.match(copy, /takeaway links will be replaced/i, "copy names what gets replaced");
      assert.match(copy, /letter\s+and supporting images are kept/i, "copy names what is kept");
      assert.doesNotMatch(copy, /published|immediately/i, "draft brief shows no published warning");

      await click($t("button-reanalyze-cancel")!);
      assert.equal($t("dialog-reanalyze"), null, "cancel closes the dialog");
      assert.equal(
        $t("button-reanalyze-confirm"),
        null,
        "confirm button leaves the DOM after cancel",
      );
      assert.equal(analyzeCalls.length, 0, "cancel fires no analyze request");
      assert.equal(toasts().length, 0, `no toasts from a cancelled confirm; got ${JSON.stringify(toasts())}`);
    },
  );

  // ── 3. Reopen → confirm fires exactly once; busy state; refreshed pulse ────
  await check(
    "confirm fires the analyze POST exactly once; busy state blocks double-fire; refreshed analysis + single toast land",
    async () => {
      resetCase();
      let resolveAnalyze!: (v: { status: number; json: any }) => void;
      const analyzeGate = new Promise<{ status: number; json: any }>((r) => {
        resolveAnalyze = r;
      });
      installFetch(() => analyzeGate); // held open until we confirm below

      await click($t("button-reanalyze")!); // reopen after the earlier cancel
      assert.ok($t("button-reanalyze-confirm"), "dialog reopens via the trigger");

      await click($t("button-reanalyze-confirm")!);

      assert.equal(analyzeCalls.length, 1, `confirm fires exactly one analyze POST; got ${analyzeCalls.length}`);
      assert.match(analyzeCalls[0], /\/api\/ceo-pulses\/pulse-4901-draft\/analyze$/, "targets the selected brief");
      assert.equal($t("dialog-reanalyze"), null, "dialog closes on confirm");

      const btn = $t("button-reanalyze") as HTMLButtonElement;
      assert.equal(btn.disabled, true, "trigger disabled while the analysis is in flight (no double-fire)");
      assert.match(btn.textContent ?? "", /re-analyzing/i, "busy copy shown while in flight");
      assert.equal(
        toasts().filter((t) => /visual regenerated/i.test(t.title ?? "")).length,
        0,
        `success toast must NOT fire before the server confirms; got ${JSON.stringify(toasts())}`,
      );

      resolveAnalyze({
        status: 200,
        json: { pulse: REFRESHED_DRAFT_PULSE, analysis: REFRESHED_DRAFT_PULSE.aiAnalysis, chartImagesGenerated: false },
      });
      await flush(8);

      const all = toasts();
      assert.equal(
        all.filter((t) => /visual regenerated/i.test(t.title ?? "")).length,
        1,
        `exactly one 'Visual regenerated!' toast after confirmation; got ${JSON.stringify(all)}`,
      );
      assert.equal(
        all.filter((t) => t.variant === "destructive").length,
        0,
        `a successful re-run must show no failure toast; got ${JSON.stringify(all)}`,
      );
      assert.equal(analyzeCalls.length, 1, "still exactly one analyze POST after settling");

      const settledBtn = $t("button-reanalyze") as HTMLButtonElement;
      assert.equal(settledBtn.disabled, false, "button re-enabled after success");
      assert.match(settledBtn.textContent ?? "", /^\s*Re-analyze\s*$/i, "busy copy cleared after success");

      // UI reflects the refreshed pulse: the takeaway-links panel reads the
      // page's selectedPulse analysis.
      await click($t("button-edit-links")!);
      const panel = $t("panel-takeaway-links");
      assert.ok(panel, "takeaway links panel opens");
      assert.ok(
        (panel!.textContent ?? "").includes(REFRESHED_TAKEAWAY),
        `takeaway panel shows the refreshed analysis; got: ${panel!.textContent}`,
      );
      assert.ok(
        !(panel!.textContent ?? "").includes(ORIGINAL_TAKEAWAY),
        "stale pre-re-run takeaway no longer shown",
      );
      await click($t("button-edit-links")!); // hide again

      // The letter survives a re-run (fullLetterHtml is outside aiAnalysis).
      const ta = $t("textarea-letter-content") as HTMLTextAreaElement | null;
      assert.ok(ta, "letter editor still mounted after re-analysis");
      assert.equal(ta!.value, KEPT_LETTER, "letter content untouched by re-analysis");
    },
  );

  // ── 4. Published brief warns that clients see the change immediately ───────
  await check(
    "published brief adds the clients-see-it-immediately warning; cancel still fires nothing",
    async () => {
      resetCase();
      installFetch(() => ({ status: 500, json: {} })); // must never be reached

      await selectMonth("July 2026");
      await click($t("button-reanalyze")!);
      assert.ok($t("dialog-reanalyze"), "dialog opens for the published brief");

      const copy = consequencesText();
      assert.match(copy, /takeaway links will be replaced/i, "replace copy still present");
      assert.match(copy, /published/i, "copy calls out the published state");
      assert.match(copy, /immediately/i, "copy warns the change is immediately client-visible");

      await click($t("button-reanalyze-cancel")!);
      assert.equal($t("dialog-reanalyze"), null, "cancel closes the dialog");
      assert.equal(analyzeCalls.length, 0, "no analyze request for a cancelled published re-run");
    },
  );

  await act(async () => {
    root.unmount();
  });

  console.log(`\nTest run: ${4 - failures} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
