/* test-registration
{
  "name": "VerdictLine primitive — renders the stored verdict sentence, renders NOTHING when a slide has none (Task #4273)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4273: every queued slide-redesign task adopts VerdictLine as the slide's opening line, binding SharedReportData.slideVerdicts keys. This pins the primitive's two-sided contract before that fan-out: a stored sentence renders trimmed in the report-verdict serif-italic voice with its per-slide testid, and an absent/empty/whitespace verdict renders NOTHING (the deck must look finished without one — an empty <p> or placeholder here would ship a visible gap to every anonymous share/demo viewer on every slide at once). DB-free, network-free, ~2s.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4273 — VerdictLine render contract (client/src/pages/publicReport/
 * VerdictLine.tsx), the shared primitive the slide-adoption tasks build on:
 *
 *   1. A stored verdict renders as a <p class="report-verdict"> with the
 *      per-slide testid (text-verdict-<slideKey>), text TRIMMED.
 *   2. `className` merges after report-verdict (slides append spacing).
 *   3. No slideKey → generic testid text-verdict.
 *   4. Empty / whitespace-only / null / undefined verdicts render NOTHING —
 *      no element, no placeholder (cleared verdict = slide opens plain).
 *
 * DB-free / network-free. Minimal jsdom harness (memory notes
 * jsdom-globals-before-react-dom-eval: globals installed BEFORE react-dom
 * is imported; no CSS side-effect imports in this leaf component, so no
 * heavy-client loader is needed). JSX-free test body — the component file
 * itself compiles via TSX_TSCONFIG_PATH's react-jsx transform.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";

// ── jsdom bootstrap (must precede the dynamic react/component imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

const HEALTHY = "Intake is leaking ~$18K/mo — answer speed is the fix.";

async function run(): Promise<void> {
  console.log("VerdictLine — render/omission contract");

  const React = (await import("react")).default as any;
  const { act } = (await import("react")) as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { VerdictLine } = (await import("@/pages/publicReport/VerdictLine")) as any;

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  const render = async (props: Record<string, unknown>) => {
    await act(async () => {
      root.render(React.createElement(VerdictLine, props));
    });
  };

  try {
    // 1. Stored sentence renders trimmed, in the report-verdict voice, with
    //    the per-slide testid.
    await render({ verdict: `  ${HEALTHY}  `, slideKey: "intake" });
    const line = container.querySelector('[data-testid="text-verdict-intake"]');
    assert.ok(line, "verdict line renders for a stored sentence");
    assert.equal(line!.tagName, "P", "renders as a <p>");
    assert.equal(line!.textContent, HEALTHY, "text is trimmed verbatim copy");
    assert.ok(
      line!.classList.contains("report-verdict"),
      "carries the report-verdict type-scale class",
    );
    console.log("  ✓ stored sentence renders trimmed with per-slide testid");

    // 2. className merges (slides append spacing utilities).
    await render({ verdict: HEALTHY, slideKey: "sales", className: "mt-4" });
    const spaced = container.querySelector('[data-testid="text-verdict-sales"]');
    assert.ok(spaced, "renders with custom className");
    assert.ok(
      spaced!.classList.contains("report-verdict") && spaced!.classList.contains("mt-4"),
      "custom class merges after report-verdict",
    );
    console.log("  ✓ className merges");

    // 3. No slideKey → generic testid.
    await render({ verdict: HEALTHY });
    assert.ok(
      container.querySelector('[data-testid="text-verdict"]'),
      "generic testid without slideKey",
    );
    console.log("  ✓ generic testid without slideKey");

    // 4. Absent/empty/whitespace verdicts render NOTHING — the omission side
    //    of the contract every slide relies on.
    for (const empty of ["", "   ", null, undefined]) {
      await render({ verdict: empty, slideKey: "intake" });
      assert.equal(
        container.innerHTML,
        "",
        `verdict=${JSON.stringify(empty)} renders nothing (no element, no placeholder)`,
      );
    }
    console.log("  ✓ empty/whitespace/null/undefined render nothing");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }

  console.log("verdict-line-render: PASSED");
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("verdict-line-render: FAILED", err);
    process.exitCode = 1;
  });
