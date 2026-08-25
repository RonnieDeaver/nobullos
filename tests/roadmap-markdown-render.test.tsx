/* test-registration
{
  "name": "Roadmap initiative markdown rendering (RoadmapMarkdown) — GFM elements, raw-HTML escape, link protection (Task #4266)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4266: initiative descriptions are markdown rendered on UNAUTHENTICATED surfaces (public /roadmap, the third-party-embeddable iframe, shared report slides) through ONE shared component. Pins its safety contract: bold/italic/strikethrough/lists produce real elements (no raw **asterisks** leaking), links get target=_blank + rel noopener/noreferrer, javascript: hrefs are neutralized, and raw HTML (<script>, <img onerror>) renders as ESCAPED TEXT — never as live elements (react-markdown default, deliberately no rehype-raw: this IS the XSS boundary; there is no server-side sanitizer behind it). Also proves the report Product-updates block renders through the shared component. Fast, DB-free, network-free jsdom render test.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4266 — frontend coverage for roadmap initiative markdown rendering.
 *
 * Renders the shared RoadmapMarkdown component (the ONE renderer behind the
 * public /roadmap page, the /roadmap/embed iframe, the report "Product
 * updates" block, and the admin dialog preview) and asserts:
 *   - GFM markdown becomes real elements: **bold** → <strong>, *italic* →
 *     <em>, ~~struck~~ → <del>, "- " lines → <ul><li>, "1. " lines →
 *     <ol><li> — and no literal marker characters remain visible;
 *   - links render with target="_blank" + rel noopener/noreferrer/nofollow,
 *     and a javascript: href is neutralized by the default urlTransform;
 *   - raw HTML pasted into a description (<script>…</script>, <img onerror>)
 *     shows up as ESCAPED TEXT: the literal source is visible and NO script /
 *     img element exists in the DOM (no rehype-raw — this is the XSS boundary
 *     for the unauthenticated surfaces);
 *   - a plain-text description renders exactly as before (one paragraph,
 *     text byte-identical);
 *   - the report Product-updates block (a real read surface) renders its
 *     description through the shared component, keeping the 2-line clamp.
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json (client render tests need
 * the tests tsconfig for the automatic JSX runtime).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { RoadmapMarkdown } from "../client/src/components/RoadmapMarkdown";
import { ReportProductUpdatesBlock } from "../client/src/components/ReportProductUpdates";
import type {
  PublicRoadmapInitiative,
  ReportProductUpdates,
} from "../shared/models/roadmap";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function rootEl(): HTMLElement {
  return document.getElementById("root")!;
}

async function render(node: React.ReactElement): Promise<Root> {
  const container = rootEl();
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function makeInitiative(overrides: Partial<PublicRoadmapInitiative>): PublicRoadmapInitiative {
  return {
    id: "init-x",
    title: "Initiative",
    description: "",
    status: "in_progress",
    timeframe: "Q3 2026",
    displayOrder: 10,
    board: "product",
    releaseQuarter: "2026-Q3",
    completedAt: null,
    departmentSlug: "operations",
    departmentName: "Operations",
    typeSlug: "feature",
    typeName: "Feature",
    ...overrides,
  };
}

async function main(): Promise<void> {
  section("GFM markdown renders to real elements (no raw markers left)");

  let root = await render(
    <RoadmapMarkdown
      source={
        "**Faster** reports with *live* data and ~~manual exports~~\n\n- one\n- two\n\n1. first\n2. second"
      }
      testId="md-gfm"
    />,
  );
  const gfm = rootEl();
  const strong = gfm.querySelector("strong");
  assert(strong?.textContent === "Faster", `**bold** renders a <strong> (got '${strong?.textContent}')`);
  const em = gfm.querySelector("em");
  assert(em?.textContent === "live", `*italic* renders an <em> (got '${em?.textContent}')`);
  const del = gfm.querySelector("del");
  assert(
    del?.textContent === "manual exports",
    `~~strikethrough~~ renders a <del> via remark-gfm (got '${del?.textContent}')`,
  );
  const ulItems = Array.from(gfm.querySelectorAll("ul > li")).map((li) => li.textContent);
  assert(
    ulItems.length === 2 && ulItems[0] === "one" && ulItems[1] === "two",
    `"- " lines render a <ul> with 2 <li> (got ${JSON.stringify(ulItems)})`,
  );
  const olItems = Array.from(gfm.querySelectorAll("ol > li")).map((li) => li.textContent);
  assert(
    olItems.length === 2 && olItems[0] === "first" && olItems[1] === "second",
    `"1. " lines render an <ol> with 2 <li> (got ${JSON.stringify(olItems)})`,
  );
  const gfmText = gfm.textContent ?? "";
  assert(
    !gfmText.includes("**") && !gfmText.includes("~~"),
    "no literal ** / ~~ marker characters remain visible",
  );
  await unmount(root);

  section("Links — new tab, rel protection, javascript: neutralized");

  root = await render(
    <RoadmapMarkdown
      source={"See [the docs](https://example.com/docs) and [bad](javascript:alert(1))"}
      testId="md-links"
    />,
  );
  const anchors = Array.from(rootEl().querySelectorAll("a"));
  const docsLink = anchors.find((a) => a.textContent === "the docs");
  assert(
    docsLink?.getAttribute("href") === "https://example.com/docs",
    `markdown link carries its href (got '${docsLink?.getAttribute("href")}')`,
  );
  assert(
    docsLink?.getAttribute("target") === "_blank",
    `link opens in a new tab (target='${docsLink?.getAttribute("target")}')`,
  );
  const rel = docsLink?.getAttribute("rel") ?? "";
  assert(
    rel.includes("noopener") && rel.includes("noreferrer"),
    `link rel includes noopener + noreferrer (got '${rel}')`,
  );
  const badLink = anchors.find((a) => a.textContent === "bad");
  const badHref = (badLink?.getAttribute("href") ?? "").toLowerCase();
  assert(
    !badHref.startsWith("javascript:"),
    `javascript: href is neutralized by the default urlTransform (got '${badHref}')`,
  );
  await unmount(root);

  section("Raw HTML stays ESCAPED text — the XSS boundary");

  root = await render(
    <RoadmapMarkdown
      source={'<script>window.__pwned = 1</script>\n\nHi <img src=x onerror="window.__pwned=1"> there'}
      testId="md-xss"
    />,
  );
  const xss = rootEl();
  assert(xss.querySelector("script") == null, "a pasted <script> block creates NO script element");
  assert(xss.querySelector("img") == null, "a pasted <img onerror> creates NO img element");
  const xssText = xss.textContent ?? "";
  assert(
    xssText.includes("<script>window.__pwned = 1</script>"),
    `the <script> source is visible as escaped literal text (got '${xssText.slice(0, 80)}…')`,
  );
  assert(
    xssText.includes('<img src=x onerror="window.__pwned=1">'),
    "the <img onerror> source is visible as escaped literal text",
  );
  assert(
    (dom.window as any).__pwned === undefined,
    "nothing executed: window.__pwned stays undefined",
  );
  await unmount(root);

  section("Plain-text descriptions render exactly as before");

  const plain = "Launch the client portal (phase 2) & migrate 100% of accounts";
  root = await render(<RoadmapMarkdown source={plain} testId="md-plain" />);
  const paragraphs = rootEl().querySelectorAll("p");
  assert(paragraphs.length === 1, `plain text renders a single <p> (got ${paragraphs.length})`);
  assert(
    paragraphs[0]?.textContent === plain,
    `plain text is byte-identical (got '${paragraphs[0]?.textContent}')`,
  );
  await unmount(root);

  section("Report Product-updates block renders descriptions through the shared component");

  const updates: ReportProductUpdates = {
    quarterKey: "2026-Q3",
    quarterLabel: "Q3 2026",
    upcoming: [
      makeInitiative({
        id: "u1",
        title: "Reporting portal",
        description: "**Faster** turnaround with *live* bars",
      }),
    ],
    completed: [],
  };
  root = await render(<ReportProductUpdatesBlock updates={updates} />);
  const card = rootEl().querySelector('[data-testid="product-update-u1"]');
  assert(card != null, "product-update item renders");
  const cardStrong = card?.querySelector("strong");
  assert(
    cardStrong?.textContent === "Faster",
    `report block renders markdown bold via the shared component (got '${cardStrong?.textContent}')`,
  );
  const clamped = card?.querySelector(".line-clamp-2");
  assert(
    clamped != null && clamped.querySelector("strong") != null,
    "the 2-line clamp wrapper is preserved around the rendered markdown",
  );
  assert(
    !(card?.textContent ?? "").includes("**"),
    "no raw ** markers appear on the report surface",
  );
  await unmount(root);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("roadmap-markdown-render: FAILED");
    process.exit(1);
  }
  console.log("roadmap-markdown-render: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("roadmap-markdown-render: FAILED");
  console.error(err);
  process.exit(1);
});
