/* test-registration
{
  "name": "Global query-error toast — humanized copy only, never raw status prefixes or JSON bodies (Task #4685)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Every surface that relies on the default QueryCache/MutationCache error handler shows this toast. A regression here re-exposes engineer-grade payloads (\"429: {\\\"message\\\":…}\") to operators on ANY genuine request failure — the exact flagged-debt item from the growth-tools impeccable pass. Fast, DB-free, deterministic (scripted fetch stub, real queryClient + real use-toast store, jsdom render of the toast copy).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4685 — the global query/mutation error toast renders ONLY humanized
 * copy: a plain-language title plus a plain recovery sentence. Raw status
 * prefixes ("429: …") and JSON bodies must never reach the toast (they stay
 * available to inline panels via `humanizeQueryError(...).technicalDetail`,
 * whose behavior is pinned separately in tests/query-error-copy.test.ts).
 *
 * Drives the REAL shared `queryClient` (default queryFn → throwIfResNotOk →
 * QueryCache.onError → real use-toast store) with a scripted fetch for:
 *   - a representative 4xx: `429: {"message":"Too many requests"}` (the
 *     literal payload from the task report), and
 *   - a representative 5xx: `500: {"error":"Internal Server Error", …}`.
 * The toast's title/description are read through the real `useToast()` store
 * via a recorder component mounted in jsdom, and the description is ALSO
 * rendered into the DOM to assert the visible text carries no raw payload.
 * (The Radix <Toaster/> itself never portals in the raw jsdom harness — the
 * store-subscriber recorder is the established pattern, see
 * tests/client/prod-actions-apply-toast-failed.test.tsx.)
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div><div id='copy'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assertOk(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---- Scripted fetch: per-URL response (sticky) ------------------------------

const responses: Record<string, { status: number; body: string }> = {
  // Representative 4xx — the literal payload shape from the task report.
  "/api/rate-limited": { status: 429, body: '{"message":"Too many requests"}' },
  // Representative 5xx.
  "/api/broken": {
    status: 500,
    body: '{"error":"Internal Server Error","stack":"TypeError: boom at handler"}',
  },
};

(globalThis as any).fetch = async (input: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const r = responses[url];
  assertOk(r, `unexpected fetch: ${url}`);
  return {
    ok: false,
    status: r.status,
    statusText: "",
    json: async () => JSON.parse(r.body),
    text: async () => r.body,
    clone() {
      return this;
    },
  } as any;
};

// ---- Imports AFTER jsdom + fetch globals ------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { useToast } = await import("../../client/src/hooks/use-toast");

// Recorder subscribed to the real toast store (TOAST_LIMIT = 1 — latest wins).
let lastToast: { title?: any; description?: any; variant?: any } | null = null;
function ToastRecorder(): null {
  const { toasts } = (useToast as any)();
  if (Array.isArray(toasts) && toasts.length > 0) {
    lastToast = toasts[0];
  }
  return null;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const recorderRoot = createRoot(document.getElementById("root")!);
await act(async () => {
  recorderRoot.render(React.createElement(ToastRecorder));
});

/** Render the toast description into jsdom and return its visible text. */
async function renderedDescriptionText(description: unknown): Promise<string> {
  const host = document.getElementById("copy")!;
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement("div", null, description as any));
  });
  const text = host.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  return text;
}

function assertHumaneOnly(text: string, label: string): void {
  assertOk(!/\b\d{3}\s*:/.test(text), `${label} contains a raw status prefix: ${text}`);
  assertOk(!text.includes("{") && !text.includes("}"), `${label} contains raw JSON: ${text}`);
  assertOk(!/TypeError|stack|Internal Server Error/.test(text), `${label} leaks server internals: ${text}`);
}

async function fireQueryError(url: string): Promise<void> {
  lastToast = null;
  let rejected = false;
  try {
    // retry: false keeps the 5xx case fast (the default transient retry is
    // pinned by tests/client/query-transient-retry.test.ts, not here).
    await queryClient.fetchQuery({ queryKey: [url], retry: false });
  } catch {
    rejected = true;
  }
  assertOk(rejected, `${url} should reject`);
  await flush();
}

async function run(): Promise<void> {
  // --- 4xx: 429 with a verbatim JSON body -----------------------------------
  await fireQueryError("/api/rate-limited");
  assertOk(lastToast !== null, "429 fired a toast");
  assertOk(lastToast!.variant === "destructive", "429 toast is destructive");
  assertOk(lastToast!.title === "Too many requests", `429 title humane (got ${String(lastToast!.title)})`);
  assertOk(
    lastToast!.description === "Wait a moment and retry.",
    `429 description is the plain recovery sentence (got ${JSON.stringify(lastToast!.description)})`,
  );
  const text429 = await renderedDescriptionText(lastToast!.description);
  assertOk(text429.includes("Wait a moment and retry."), "429 rendered copy present");
  assertHumaneOnly(`${String(lastToast!.title)} ${text429}`, "429 toast");
  console.log("  ✓ 4xx (429 + JSON body) → humane title + plain sentence, no raw payload");

  // --- 5xx: 500 with a JSON error body --------------------------------------
  await fireQueryError("/api/broken");
  assertOk(lastToast !== null, "500 fired a toast");
  assertOk(lastToast!.title === "Server problem", `500 title humane (got ${String(lastToast!.title)})`);
  assertOk(
    typeof lastToast!.description === "string" &&
      /wait a moment and retry/i.test(lastToast!.description),
    `500 description carries recovery guidance (got ${JSON.stringify(lastToast!.description)})`,
  );
  const text500 = await renderedDescriptionText(lastToast!.description);
  assertHumaneOnly(`${String(lastToast!.title)} ${text500}`, "500 toast");
  console.log("  ✓ 5xx (500 + JSON body) → humane title + plain sentence, no raw payload");

  await act(async () => {
    recorderRoot.unmount();
  });
  queryClient.clear();
}

run()
  .then(() => {
    console.log("\nPASS tests/client/query-error-toast-copy.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/query-error-toast-copy.test.tsx");
    console.error(err);
    process.exit(1);
  });
