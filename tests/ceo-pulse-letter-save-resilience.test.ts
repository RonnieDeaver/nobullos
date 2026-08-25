/* test-registration
{
  "name": "CeoPulseAdmin — letter-save session-retry resilience (Task #4802)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4802: pins the NoBull Brief letter-save fix — 401 → silent Clerk refresh → one retry succeeds; success toasts fire only after server confirmation; terminal failures show ONE destructive toast with the real reason (session-expired / rate-limit / server copy) instead of the generic unknown-failure toast; the pasted letter is never cleared and auth-loss navigation never fires. DB-free, network-free jsdom mount of the REAL CeoPulseAdmin page under the REAL app queryClient via stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/ceo-pulse-letter-save-resilience-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * CeoPulseAdmin letter-save resilience (Task #4802).
 *
 * Production incident 2026-08-14: saving the pasted full-letter HTML on
 * /admin/ceo-pulse failed with the dead-end generic toast AFTER an
 * unconditional "Letter saved!" toast had already fired. Root cause: the
 * page's mutations raw-fetch'd and threw status-less Errors, so the real
 * reason (prod route-stats evidence: a fast 4xx, consistent with an expired
 * Clerk session 401) was invisible and no session-refresh retry engaged.
 *
 * Pins:
 *   1. 401 → silent Clerk refresh → one retry → success; "Letter saved!"
 *      fires ONLY after the server confirms (gated via a deferred response).
 *   2. Terminal 401 → exactly ONE destructive toast naming the real reason
 *      (session-expired copy); the pasted letter stays in the editor; no
 *      auth-loss navigation (thrown messages carry no "401:" prefix).
 *   3. Terminal 429 → rate-limit copy, no blind retry.
 *   4. Terminal 500 → the server-provided `error` string passes through.
 *   5. A failed "Remove Letter" no longer pre-clears the editor.
 *   6. "Letter removed" fires only on confirmed removal.
 *
 * Mounts the REAL CeoPulseAdmin page inside the REAL app queryClient — so the
 * global mutation-cache handlers are live, proving there is no generic double
 * toast and no handleAuthLoss navigation — with fetch, Clerk, and use-toast
 * stubbed (toasts recorded on globalThis.__capturedToasts).
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
// Must be set on dom.window too: `window` in client modules resolves to
// dom.window, a separate object from globalThis.
let clerkRefreshCalls = 0;
const clerkSpy = {
  session: {
    getToken: async (_opts?: { skipCache?: boolean }) => {
      clerkRefreshCalls++;
      return "refreshed-token";
    },
  },
};
(globalThis as any).Clerk = clerkSpy;
(dom.window as any).Clerk = clerkSpy;

// ── Auth-loss navigation spy: handleAuthLoss() would call location.assign("/").
const assignedUrls: string[] = [];
try {
  Object.defineProperty(dom.window.location, "assign", {
    configurable: true,
    value: (url: unknown) => {
      assignedUrls.push(String(url));
    },
  });
} catch {
  // jsdom refused the override — the pathname assertion below still guards.
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CEO_USER = {
  id: "u-ceo-4802",
  email: "ceo@example-nobull.co",
  firstName: "Test",
  lastName: "Ceo",
  role: "ceo",
};

const BASE_PULSE = {
  id: "pulse-4802",
  monthKey: "2026-08",
  title: null,
  rawContent: "August raw content",
  aiAnalysis: {
    headline: "Headline",
    keyTakeaways: ["Takeaway one"],
    strategicImplications: [],
    charts: [],
  },
  fullLetterHtml: "<p>existing letter</p>",
  includeGraphs: false,
  isPublished: false,
  shareToken: null,
  createdAt: null,
  edition: "company_update",
  supportingImages: [],
};

let patchCalls = 0;
let patchBodies: any[] = [];

/** (Re)install the fetch stub; auth + list routes stay constant, PATCH scripted. */
function installFetch(patchRespond: (ctx: any) => any) {
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/auth/user", json: CEO_USER },
      {
        method: "PATCH",
        path: /\/api\/ceo-pulses\/[^/]+$/,
        respond: (ctx: any) => {
          patchCalls++;
          try {
            patchBodies.push(JSON.parse((ctx.init?.body as string) ?? "null"));
          } catch {
            patchBodies.push(null);
          }
          return patchRespond(ctx);
        },
      },
      { method: "GET", path: "/api/ceo-pulses", json: () => [BASE_PULSE] },
    ],
    defaultJson: {},
  }) as any;
}

const $t = (id: string): HTMLElement | null =>
  dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function toasts(): any[] {
  return ((globalThis as any).__capturedToasts ?? []) as any[];
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
  console.log("CeoPulseAdmin — letter-save session-retry resilience (Task #4802)");

  // Installed before client imports so module-load-time fetches (none known)
  // and the auth/pulses queries are always answered. Each case rewires PATCH.
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

  const typeLetter = async (text: string) => {
    const ta = $t("textarea-letter-content") as HTMLTextAreaElement | null;
    assert.ok(ta, "letter textarea should be present");
    await act(async () => {
      const nativeSet = Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeSet?.call(ta, text);
      ta!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush(2);
  };

  const resetCase = () => {
    (globalThis as any).__capturedToasts = [];
    clerkRefreshCalls = 0;
    patchCalls = 0;
    patchBodies = [];
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

  // Select the August 2026 pulse from the month dropdown (the dropdown shim
  // renders menu content inline, so the item is immediately clickable).
  const monthSpan = Array.from(dom.window.document.querySelectorAll("span")).find(
    (s) => s.textContent === "August 2026",
  ) as HTMLElement | undefined;
  assert.ok(monthSpan, "month dropdown item should render (pulses list loaded)");
  await click(monthSpan!.parentElement as HTMLElement);
  await flush(5);
  assert.ok(
    $t("textarea-letter-content"),
    "letter editor should open for a pulse with an existing letter",
  );

  // ── 1. 401 → Clerk refresh → retry → success; toast only after confirm ─────
  await check(
    "401 → Clerk refresh → retry succeeds; 'Letter saved!' only after server confirms",
    async () => {
      resetCase();
      const LETTER = "<p>my letter — twenty thousand characters of paste</p>";
      await typeLetter(LETTER);

      let resolveRetry!: (v: { status: number; json: any }) => void;
      const retryGate = new Promise<{ status: number; json: any }>((r) => {
        resolveRetry = r;
      });
      installFetch(() => {
        if (patchCalls === 1) return { status: 401, json: { message: "Unauthorized" } };
        return retryGate; // second attempt held open until we confirm below
      });

      await click($t("button-save-letter")!);

      assert.equal(patchCalls, 2, `PATCH called twice (401 + retry); got ${patchCalls}`);
      assert.equal(clerkRefreshCalls, 1, "Clerk session.getToken called once after the 401");
      assert.equal(
        toasts().filter((t) => /letter saved/i.test(t.title ?? "")).length,
        0,
        `success toast must NOT fire before the server confirms; got ${JSON.stringify(toasts())}`,
      );

      resolveRetry({ status: 200, json: { ...BASE_PULSE, fullLetterHtml: LETTER } });
      await flush(8);

      const all = toasts();
      assert.equal(
        all.filter((t) => /letter saved/i.test(t.title ?? "")).length,
        1,
        `exactly one 'Letter saved!' toast after confirmation; got ${JSON.stringify(all)}`,
      );
      assert.equal(
        all.filter((t) => t.variant === "destructive").length,
        0,
        `a recovered save must show no failure toast; got ${JSON.stringify(all)}`,
      );
      assert.equal(patchBodies[0]?.fullLetterHtml, LETTER, "PATCH body carries the letter");
      assert.equal(assignedUrls.length, 0, "no auth-loss navigation");
    },
  );

  // ── 2. Terminal 401 → real reason, letter preserved, no navigation ─────────
  await check(
    "terminal 401 → ONE destructive toast with session-expired copy; letter preserved; no navigation",
    async () => {
      resetCase();
      const LETTER = "<p>letter that must survive a terminal auth failure</p>";
      await typeLetter(LETTER);
      installFetch(() => ({ status: 401, json: { message: "Unauthorized" } }));

      await click($t("button-save-letter")!);
      await flush(5);

      const all = toasts();
      assert.equal(patchCalls, 2, "one silent retry before the terminal failure");
      assert.equal(clerkRefreshCalls, 1, "Clerk refresh attempted");
      assert.equal(
        all.length,
        1,
        `exactly ONE toast — no lying success, no global generic double; got ${JSON.stringify(all)}`,
      );
      assert.equal(all[0].variant, "destructive", "failure toast is destructive");
      assert.equal(all[0].title, "Letter save failed", "failure toast names the action");
      assert.match(
        String(all[0].description ?? ""),
        /session expired/i,
        "real reason: session-expired copy",
      );
      const ta = $t("textarea-letter-content") as HTMLTextAreaElement | null;
      assert.ok(ta, "editor still mounted after terminal failure");
      assert.equal(ta!.value, LETTER, "pasted letter preserved after terminal auth failure");
      assert.equal(assignedUrls.length, 0, "handleAuthLoss must not fire (no '401:'-prefixed error)");
      assert.equal(dom.window.location.pathname, "/admin/ceo-pulse", "no forced navigation away");
    },
  );

  // ── 3. Terminal 429 → rate-limit copy ──────────────────────────────────────
  await check("terminal 429 → rate-limit copy, single attempt, letter preserved", async () => {
    resetCase();
    const LETTER = "<p>letter under rate limit</p>";
    await typeLetter(LETTER);
    installFetch(() => ({ status: 429, json: { message: "Too many write requests." } }));

    await click($t("button-save-letter")!);
    await flush(5);

    const all = toasts();
    assert.equal(patchCalls, 1, "429 is not retried (only 401 gets the refresh-retry)");
    assert.equal(all.length, 1, `exactly one toast; got ${JSON.stringify(all)}`);
    assert.equal(all[0].title, "Letter save failed");
    assert.match(
      String(all[0].description ?? ""),
      /too many requests/i,
      "real reason: rate-limit copy",
    );
    assert.equal(
      ($t("textarea-letter-content") as HTMLTextAreaElement).value,
      LETTER,
      "letter preserved",
    );
  });

  // ── 4. Terminal 500 → server-provided reason passes through ────────────────
  await check("terminal 500 → server-provided error string surfaces as the reason", async () => {
    resetCase();
    const LETTER = "<p>letter facing a server error</p>";
    await typeLetter(LETTER);
    installFetch(() => ({ status: 500, json: { error: "Database write failed" } }));

    await click($t("button-save-letter")!);
    await flush(5);

    const all = toasts();
    assert.equal(patchCalls, 1);
    assert.equal(all.length, 1, `exactly one toast; got ${JSON.stringify(all)}`);
    assert.equal(all[0].title, "Letter save failed");
    assert.equal(
      all[0].description,
      "Database write failed",
      "server `error` copy passes through verbatim",
    );
    assert.equal(
      ($t("textarea-letter-content") as HTMLTextAreaElement).value,
      LETTER,
      "letter preserved",
    );
  });

  // ── 5. Failed Remove Letter must not clear the editor ──────────────────────
  await check(
    "failed Remove Letter keeps the pasted letter (no pre-clear) and names the reason",
    async () => {
      resetCase();
      installFetch(() => ({ status: 401, json: { message: "Unauthorized" } }));
      const before = ($t("textarea-letter-content") as HTMLTextAreaElement).value;
      assert.ok(before.length > 0, "precondition: editor has content");

      await click($t("button-remove-letter")!);
      await flush(5);

      const all = toasts();
      assert.equal(all.length, 1, `exactly one toast; got ${JSON.stringify(all)}`);
      assert.equal(all[0].title, "Letter removal failed");
      assert.match(String(all[0].description ?? ""), /session expired/i);
      assert.equal(
        all.filter((t) => /letter removed/i.test(t.title ?? "")).length,
        0,
        "no lying 'Letter removed' toast",
      );
      assert.equal(
        ($t("textarea-letter-content") as HTMLTextAreaElement).value,
        before,
        "editor content NOT cleared by a failed removal",
      );
    },
  );

  // ── 6. Confirmed Remove Letter → toast + editor clears ─────────────────────
  await check("'Letter removed' fires only on confirmed success and clears the editor", async () => {
    resetCase();
    installFetch(() => ({ status: 200, json: { ...BASE_PULSE, fullLetterHtml: null } }));

    await click($t("button-remove-letter")!);
    await flush(8);

    const all = toasts();
    assert.equal(
      all.filter((t) => /letter removed/i.test(t.title ?? "")).length,
      1,
      `got ${JSON.stringify(all)}`,
    );
    assert.equal(
      all.filter((t) => t.variant === "destructive").length,
      0,
      "no failure toast on confirmed removal",
    );
    assert.equal(
      $t("textarea-letter-content"),
      null,
      "letter editor collapses after confirmed removal",
    );
  });

  await act(async () => {
    root.unmount();
  });

  console.log(`\nTest run: ${6 - failures} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
