/* test-registration
{
  "name": "Zoom face sentiment modal section states (Task #3702)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3702: Zoom face-sentiment modal section — absent renders nothing, analyzed renders the AI-labeled read (overall/timeline/moments/ provenance + low-confidence caveat), no_video and failed render the honest explicit notices. jsdom component test, DB-free, fast; a drift here silently shows bogus or unlabeled AI readings to operators.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3702 — Direct component test that `ZoomFaceSentimentSection`
 * (`client/src/components/ZoomFaceSentimentSection.tsx`) renders every
 * stored face-sentiment state honestly in the meeting detail modal:
 *
 *   (a) absent result → renders NOTHING (the analyzer is opt-in and
 *       sweep-driven; absence is expected, not an error state);
 *   (b) analyzed → AI-derived label, overall badge, per-sample timeline
 *       chips, notable moments, provenance footer, and a low-confidence
 *       caveat when the client identification wasn't "high";
 *   (c) no_video → the explicit "No video to analyze" copy per reason
 *       (camera-off / client-not-visible detail included);
 *   (d) failed → retrying vs parked (won't retry) wording from attempts.
 *
 * Mirrors the jsdom harness of tests/client/breaker-detail-row-empty-fields.test.tsx.
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
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLSpanElement = dom.window.HTMLSpanElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { ZoomFaceSentimentSection } = await import(
  "../../client/src/components/ZoomFaceSentimentSection"
);

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function render(result: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(ZoomFaceSentimentSection, { result }));
  });
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

// ── (a) absent result → renders nothing ─────────────────────────────────
console.log("\n— ZoomFaceSentimentSection: absent result —");
for (const absent of [null, undefined, {}]) {
  const root = await render(absent);
  try {
    assert(
      $("section-zoom-face-sentiment") === null,
      `absent (${JSON.stringify(absent)}): section must render nothing — analyzer hasn't run`,
    );
  } finally {
    await unmount(root);
  }
}
console.log("  ✓ renders nothing when no result is stored");

// ── (b) analyzed ─────────────────────────────────────────────────────────
console.log("\n— ZoomFaceSentimentSection: analyzed —");
{
  const root = await render({
    status: "analyzed",
    version: 1,
    at: "2026-08-03T12:00:00.000Z",
    overall: "mixed",
    summary: "Warm start, visible frustration during the pricing discussion.",
    timeline: [
      { atSec: 60, sentiment: "positive", note: "smiling, nodding" },
      { atSec: 660, sentiment: "neutral" },
      { atSec: 1260, sentiment: "negative", note: "arms crossed" },
      { atSec: 1860, sentiment: "unclear" },
    ],
    notableMoments: [{ atSec: 1260, note: "visible frustration during pricing" }],
    clientIdentification: { description: "tile labeled 'Pat (Acme)'", confidence: "medium" },
    framesSampled: 4,
    framesWithClientVisible: 3,
    model: "test-vision-model",
  });
  try {
    assert($("section-zoom-face-sentiment") !== null, "analyzed: section renders");
    assert(
      ($("badge-zoom-sentiment-ai")?.textContent || "").includes("AI-derived"),
      "analyzed: AI-derived label present",
    );
    const overall = $("badge-zoom-sentiment-overall");
    assert(overall !== null, "analyzed: overall badge renders");
    assert(
      (overall!.textContent || "").toLowerCase().includes("mixed"),
      `analyzed: overall badge reads "mixed", got: ${overall!.textContent}`,
    );
    assert(
      ($("text-zoom-sentiment-confidence")?.textContent || "").includes("medium confidence"),
      "analyzed: non-high identification confidence is surfaced as a caveat",
    );
    assert(
      ($("text-zoom-sentiment-summary")?.textContent || "").includes("frustration"),
      "analyzed: summary rendered",
    );
    const chips = document.querySelectorAll("[data-testid^='chip-zoom-sentiment-']");
    assert(chips.length === 4, `analyzed: 4 timeline chips, got ${chips.length}`);
    assert(
      (chips[0].textContent || "").includes("1:00") && (chips[0].textContent || "").toLowerCase().includes("positive"),
      `analyzed: first chip shows mm:ss + sentiment, got: ${chips[0].textContent}`,
    );
    assert(
      (chips[2].textContent || "").includes("21:00") && (chips[2].textContent || "").toLowerCase().includes("negative"),
      `analyzed: third chip shows 21:00 negative, got: ${chips[2].textContent}`,
    );
    const moments = document.querySelectorAll("[data-testid^='moment-zoom-sentiment-']");
    assert(moments.length === 1, `analyzed: 1 notable moment, got ${moments.length}`);
    assert(
      (moments[0].textContent || "").includes("visible frustration during pricing"),
      "analyzed: moment note rendered",
    );
    const prov = $("text-zoom-sentiment-provenance");
    assert(prov !== null, "analyzed: provenance footer renders");
    assert(
      (prov!.textContent || "").includes("4 video frames") &&
        (prov!.textContent || "").includes("test-vision-model") &&
        (prov!.textContent || "").includes("may misread"),
      `analyzed: provenance names frames + model + caveat, got: ${prov!.textContent}`,
    );
    assert(
      $("badge-zoom-sentiment-status") === null,
      "analyzed: no error/no-video status badge",
    );
    console.log("  ✓ analyzed: AI label, overall, chips, moments, caveats, provenance");
  } finally {
    await unmount(root);
  }
}

// High confidence hides the caveat.
{
  const root = await render({
    status: "analyzed",
    overall: "positive",
    clientIdentification: { description: "d", confidence: "high" },
    timeline: [],
    notableMoments: [],
  });
  try {
    assert(
      $("text-zoom-sentiment-confidence") === null,
      "analyzed-high: no confidence caveat when identification is high-confidence",
    );
    console.log("  ✓ analyzed: high-confidence identification renders no caveat");
  } finally {
    await unmount(root);
  }
}

// ── (c) no_video states ──────────────────────────────────────────────────
console.log("\n— ZoomFaceSentimentSection: no_video —");
{
  const root = await render({
    status: "no_video",
    reason: "no_video_file",
    fileTypes: ["M4A", "TIMELINE"],
  });
  try {
    const badge = $("badge-zoom-sentiment-status");
    assert(badge !== null, "no_video: status badge renders");
    assert(
      (badge!.textContent || "").includes("No video to analyze"),
      `no_video: badge says "No video to analyze", got: ${badge!.textContent}`,
    );
    assert(
      ($("text-zoom-sentiment-detail")?.textContent || "").includes("M4A, TIMELINE"),
      "no_video_file: detail lists the delivered file types",
    );
    assert($("badge-zoom-sentiment-overall") === null, "no_video: no sentiment badge — no bogus reading");
    console.log("  ✓ no_video_file: explicit no-video copy with file types");
  } finally {
    await unmount(root);
  }
}
{
  const root = await render({
    status: "no_video",
    reason: "client_not_visible",
    detail: "only a shared slide deck is visible",
  });
  try {
    const detail = $("text-zoom-sentiment-detail")?.textContent || "";
    assert(
      detail.includes("camera was off") || detail.includes("no client face"),
      `client_not_visible: honest camera-off/not-identified copy, got: ${detail}`,
    );
    assert(
      detail.includes("only a shared slide deck is visible"),
      "client_not_visible: stored detail (what WAS visible) is included",
    );
    console.log("  ✓ client_not_visible: honest copy incl. what the frames showed");
  } finally {
    await unmount(root);
  }
}

// ── (d) failed states ────────────────────────────────────────────────────
console.log("\n— ZoomFaceSentimentSection: failed —");
{
  const root = await render({ status: "failed", attempts: 1, error: "download timed out" });
  try {
    assert(
      ($("badge-zoom-sentiment-status")?.textContent || "").includes("failed"),
      "failed: badge names the failure",
    );
    const detail = $("text-zoom-sentiment-detail")?.textContent || "";
    assert(detail.includes("will retry"), `failed-retrying: says the sweep will retry, got: ${detail}`);
    assert(detail.includes("download timed out"), "failed: last error shown for review");
    console.log("  ✓ failed (retrying): names error + upcoming retry");
  } finally {
    await unmount(root);
  }
}
{
  const root = await render({ status: "failed", attempts: 3, error: "vision analysis failed" });
  try {
    const detail = $("text-zoom-sentiment-detail")?.textContent || "";
    assert(detail.includes("won't retry"), `failed-parked: says it won't retry, got: ${detail}`);
    console.log("  ✓ failed (parked): honest terminal wording");
  } finally {
    await unmount(root);
  }
}

console.log(
  "\nzoom-face-sentiment-section: every stored state renders honestly — nothing when absent, AI-labeled read when analyzed, explicit no-video and failed notices otherwise.",
);
