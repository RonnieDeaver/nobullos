/* test-registration
{
  "name": "Scan image guard hook — /objects/-only fail-closed policy, HEAD Content-Type verdicts, synchronous pending reset on URL swap (Task #4544)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4544: the client render guard that keeps portrait photos out of Map Rankings scan slots. Mounts useScanImageStatus in jsdom with a controllable HEAD-fetch stub and asserts: non-/objects/ URLs are invalid with ZERO network calls (fail-closed — no enforceable MIME contract), image/png resolves valid while image/jpeg (the real portrait-headshot class) resolves invalid, and swapping a validated URL for an unprobed one resets to pending SYNCHRONOUSLY so a non-scan replacement can never flash in a protected slot. DB-free, network-free, fast.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4544 — useScanImageStatus behavior contract.
 *
 * The hook is the client half of the map-scan guard: server claim gate
 * rejects non-PNG/WebP uploads; the hook HEAD-probes each stored
 * `/objects/` URL and only "valid" verdicts render as scans. This suite
 * pins the three review-critical behaviors:
 *   1. External (non-/objects/) URLs fail CLOSED with no fetch at all.
 *   2. Verdicts follow the served Content-Type (png → valid, jpeg → invalid).
 *   3. URL swap resets to "pending" in the SAME render — a previously
 *      "valid" instance never renders an unprobed replacement URL.
 *
 * Pure classifier/thumb-path coverage lives in
 * tests/heatmap-image-acl-serving.test.ts.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Controllable HEAD-fetch stub: each probed URL gets a deferred the test
// resolves explicitly, so pending windows are observable.
const fetchCalls: string[] = [];
const deferreds = new Map<string, (r: { ok: boolean; contentType: string | null }) => void>();
(globalThis as any).fetch = (url: string, init?: { method?: string }) => {
  assert(init?.method === "HEAD", `guard probes via HEAD, got ${init?.method}`);
  fetchCalls.push(url);
  return new Promise((resolve) => {
    deferreds.set(url, ({ ok, contentType }) =>
      resolve({
        ok,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
      }),
    );
  });
};
(dom.window as any).fetch = (globalThis as any).fetch;

// Imports AFTER jsdom globals + fetch stub are installed.
const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useScanImageStatus, __resetScanProbeCacheForTest } = await import(
  "../../client/src/pages/publicReport/scanImageGuard"
);

function Probe({ url }: { url: string }) {
  const status = useScanImageStatus(url);
  return React.createElement("div", { id: "status" }, status);
}

const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const readStatus = () => container.querySelector("#status")!.textContent;

const PNG_URL = "/objects/uploads/scan-a";
const JPEG_URL = "/objects/uploads/portrait-b";
const EXTERNAL_URL = "https://elsewhere.example/photo.jpg";

async function run() {
  __resetScanProbeCacheForTest();

  // 1. External URL: invalid immediately, zero network.
  await act(async () => root.render(React.createElement(Probe, { url: EXTERNAL_URL })));
  assert(readStatus() === "invalid", `external URL fails closed, got ${readStatus()}`);
  assert(fetchCalls.length === 0, "external URL is never probed");

  // 2. /objects/ PNG: pending until the HEAD resolves, then valid.
  await act(async () => root.render(React.createElement(Probe, { url: PNG_URL })));
  assert(readStatus() === "pending", `unresolved probe renders pending, got ${readStatus()}`);
  assert(fetchCalls.length === 1 && fetchCalls[0] === PNG_URL, "probed exactly the png url");
  await act(async () => deferreds.get(PNG_URL)!({ ok: true, contentType: "image/png" }));
  assert(readStatus() === "valid", `png verdict renders valid, got ${readStatus()}`);

  // 3. Swap valid → unprobed JPEG url: pending in the SAME committed render
  //    (no valid flash), then invalid once the probe answers image/jpeg.
  await act(async () => root.render(React.createElement(Probe, { url: JPEG_URL })));
  assert(readStatus() === "pending", `url swap resets synchronously to pending, got ${readStatus()}`);
  await act(async () => deferreds.get(JPEG_URL)!({ ok: true, contentType: "image/jpeg" }));
  assert(readStatus() === "invalid", `jpeg (portrait class) renders invalid, got ${readStatus()}`);

  // 4. Swapping BACK to the already-probed png url serves the cached verdict
  //    without a second network probe.
  const callsBefore = fetchCalls.length;
  await act(async () => root.render(React.createElement(Probe, { url: PNG_URL })));
  assert(readStatus() === "valid", `cached verdict reused, got ${readStatus()}`);
  assert(fetchCalls.length === callsBefore, "no re-probe for a cached url");

  await act(async () => root.unmount());
  console.log("scan-image-guard-hook: all assertions passed");
}

await run();
