/* test-registration
{
  "name": "SectionNav — registers sections, anchor-jumps on click, tracks scroll via IntersectionObserver; health-dashboard adopter lockstep (Task #4344)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4344: pins the sticky anchor-rail primitive for monolithic consoles — it renders every registered section, jumps to one on click (scrollIntoView + active highlight), and tracks scroll position through IntersectionObserver so the current section stays highlighted. Also pins the proof adopter: the health dashboard's HEALTH_DASHBOARD_SECTIONS registry mounts against real anchors and a source-scan keeps every registered id lockstep with a <section id> anchor in HealthDashboardSection.tsx. Pure jsdom component mount with a stubbed IntersectionObserver: DB-free, network-free, deterministic and sub-second, so it earns a routine-gate slot alongside the other tests/client component suites.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/admin/SectionNav.tsx",
    "client/src/components/admin/health/HealthDashboardSection.tsx",
    "client/src/components/admin/health/dashboard/healthSections.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4344 — Direct component test for the shared admin `SectionNav`
 * (`client/src/components/admin/SectionNav.tsx`).
 *
 * SectionNav is the sticky anchor rail for the panel's monolithic consoles
 * (audit §6.1-E / §8.3: system health 15+ sections, match settings 6,384px).
 * This suite proves:
 *
 *   (a) Registration — the rail renders one link per registered section (in
 *       order), pins on the documented `--z-sticky` rung, and highlights the
 *       first section by default.
 *   (b) Anchor jump — clicking a section link scrolls its target element into
 *       view (via getElementById + scrollIntoView) and moves the active
 *       highlight to it.
 *   (c) Scroll tracking — as sections intersect the viewport the rail follows,
 *       driven here by a stubbed IntersectionObserver whose callback we invoke
 *       with a synthetic entry.
 *
 * scrollIntoView and IntersectionObserver are absent in jsdom, so both are
 * stubbed: scrollIntoView records the id it was called on, and the IO stub
 * captures its callback + observed elements for deterministic driving.
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
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither of these; stub both for deterministic driving.
const scrollCalls: string[] = [];
(dom.window as any).HTMLElement.prototype.scrollIntoView = function (
  this: HTMLElement,
) {
  scrollCalls.push(this.id);
};

type IOEntry = {
  target: HTMLElement;
  isIntersecting: boolean;
  intersectionRatio: number;
};
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  cb: (entries: IOEntry[]) => void;
  observed: HTMLElement[] = [];
  disconnected = false;
  constructor(cb: (entries: IOEntry[]) => void) {
    this.cb = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: HTMLElement) {
    this.observed.push(el);
  }
  unobserve(el: HTMLElement) {
    this.observed = this.observed.filter((e) => e !== el);
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
(globalThis as any).IntersectionObserver = MockIntersectionObserver;
(dom.window as any).IntersectionObserver = MockIntersectionObserver;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { SectionNav } = await import("../../client/src/components/admin/SectionNav");

const SECTIONS = [
  { id: "sec-alpha", label: "Alpha" },
  { id: "sec-beta", label: "Beta" },
  { id: "sec-gamma", label: "Gamma" },
];

function link(id: string): HTMLElement | null {
  return document.querySelector(
    `[data-testid="section-nav-link-${id}"]`,
  ) as HTMLElement | null;
}

// Create the target section elements the rail scrolls to.
for (const s of SECTIONS) {
  const el = dom.window.document.createElement("div");
  el.id = s.id;
  dom.window.document.body.appendChild(el);
}

let failed = false;
try {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SectionNav, { sections: SECTIONS }));
  });

  // ── (a) Registration ──────────────────────────────────────────────────────
  console.log("\n— SectionNav: registers every section —");
  {
    const nav = document.querySelector('[data-testid="section-nav"]') as HTMLElement | null;
    assert(nav !== null, "registration: rail renders");
    assert(nav!.tagName === "NAV", "registration: rail is a <nav>");
    assert(
      nav!.className.includes("sticky") &&
        nav!.className.includes("z-[var(--z-sticky)]"),
      `registration: rail is sticky on the --z-sticky rung, got: ${nav!.className}`,
    );
    for (const s of SECTIONS) {
      const a = link(s.id);
      assert(a !== null, `registration: link for ${s.id} renders`);
      assert(
        (a!.textContent || "").includes(s.label),
        `registration: link ${s.id} shows label ${s.label}, got: ${a!.textContent}`,
      );
      assert(
        a!.getAttribute("href") === `#${s.id}`,
        `registration: link ${s.id} points at #${s.id}, got: ${a!.getAttribute("href")}`,
      );
    }
    // First section active by default.
    assert(
      link("sec-alpha")!.getAttribute("aria-current") === "true",
      "registration: first section is active by default",
    );
    assert(
      link("sec-beta")!.getAttribute("aria-current") === null,
      "registration: non-active sections have no aria-current",
    );
    // IO wired up: one observer observing all three targets.
    assert(
      MockIntersectionObserver.instances.length === 1,
      `registration: exactly one IntersectionObserver created, got: ${MockIntersectionObserver.instances.length}`,
    );
    assert(
      MockIntersectionObserver.instances[0].observed.length === 3,
      `registration: observes all 3 section targets, got: ${MockIntersectionObserver.instances[0].observed.length}`,
    );
    console.log("  ✓ renders + observes all sections; first is active");
  }

  // ── (b) Anchor jump on click ──────────────────────────────────────────────
  console.log("\n— SectionNav: clicking a link jumps + activates —");
  {
    scrollCalls.length = 0;
    await act(async () => {
      link("sec-beta")!.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          view: dom.window,
        }),
      );
    });
    assert(
      scrollCalls.length === 1 && scrollCalls[0] === "sec-beta",
      `jump: scrollIntoView called on the beta target, got: ${JSON.stringify(scrollCalls)}`,
    );
    assert(
      link("sec-beta")!.getAttribute("aria-current") === "true",
      "jump: clicked section becomes active",
    );
    assert(
      link("sec-alpha")!.getAttribute("aria-current") === null,
      "jump: previously-active section is deactivated",
    );
    console.log("  ✓ click scrolls target into view and moves the highlight");
  }

  // ── (c) Scroll tracking via IntersectionObserver ──────────────────────────
  console.log("\n— SectionNav: tracks scroll position —");
  {
    const gamma = dom.window.document.getElementById("sec-gamma") as HTMLElement;
    await act(async () => {
      MockIntersectionObserver.instances[0].cb([
        { target: gamma, isIntersecting: true, intersectionRatio: 1 },
      ]);
    });
    assert(
      link("sec-gamma")!.getAttribute("aria-current") === "true",
      "tracking: intersecting section becomes active",
    );
    assert(
      link("sec-beta")!.getAttribute("aria-current") === null,
      "tracking: prior active section is deactivated on scroll",
    );
    console.log("  ✓ active highlight follows the intersecting section");
  }

  await act(async () => {
    root!.unmount();
  });
  // Unmount tears down the observer.
  assert(
    MockIntersectionObserver.instances[0].disconnected === true,
    "cleanup: observer disconnected on unmount",
  );

  // ── (d) Proof adopter: health dashboard (audit's 15+-section monolith) ────
  console.log("\n— SectionNav: health-dashboard adopter renders the real registry —");
  {
    const { HEALTH_DASHBOARD_SECTIONS } = await import(
      "../../client/src/components/admin/health/dashboard/healthSections"
    );
    assert(
      HEALTH_DASHBOARD_SECTIONS.length >= 15,
      `adopter: registry covers the audit's 15+ stacked sections, got: ${HEALTH_DASHBOARD_SECTIONS.length}`,
    );

    // Source lockstep — the dashboard renders SectionNav with this registry,
    // and every registered id exists as a <section id="…"> anchor in it.
    const { readFileSync } = await import("node:fs");
    const dashboardSrc = readFileSync(
      "client/src/components/admin/health/HealthDashboardSection.tsx",
      "utf8",
    );
    assert(
      /import\s*{\s*SectionNav\s*}\s*from\s*"@\/components\/admin\/SectionNav"/.test(dashboardSrc),
      "adopter: HealthDashboardSection imports SectionNav",
    );
    assert(
      /<SectionNav\s[^>]*sections={HEALTH_DASHBOARD_SECTIONS}/s.test(dashboardSrc) ||
        /<SectionNav\s+sections={HEALTH_DASHBOARD_SECTIONS}/.test(dashboardSrc),
      "adopter: HealthDashboardSection renders <SectionNav sections={HEALTH_DASHBOARD_SECTIONS}>",
    );
    for (const s of HEALTH_DASHBOARD_SECTIONS) {
      assert(
        dashboardSrc.includes(`id="${s.id}"`),
        `adopter lockstep: <section id="${s.id}"> anchor exists in HealthDashboardSection.tsx`,
      );
    }

    // Behavior against the real registry: mount SectionNav with the real
    // sections + real anchor elements, then jump to a deep section.
    for (const s of HEALTH_DASHBOARD_SECTIONS) {
      const el = dom.window.document.createElement("section");
      el.id = s.id;
      dom.window.document.body.appendChild(el);
    }
    try {
      let adopterRoot: Root | null = null;
      await act(async () => {
        adopterRoot = createRoot(container);
        adopterRoot.render(
          React.createElement(SectionNav, { sections: HEALTH_DASHBOARD_SECTIONS }),
        );
      });
      for (const s of HEALTH_DASHBOARD_SECTIONS) {
        assert(link(s.id) !== null, `adopter: rail link for ${s.id} renders`);
      }
      const adopterIO =
        MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
      assert(
        adopterIO.observed.length === HEALTH_DASHBOARD_SECTIONS.length,
        `adopter: observes every real anchor, got: ${adopterIO.observed.length}`,
      );
      scrollCalls.length = 0;
      await act(async () => {
        link("db-pools")!.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
            view: dom.window,
          }),
        );
      });
      assert(
        scrollCalls.length === 1 && scrollCalls[0] === "db-pools",
        `adopter: clicking DB pools scrolls the real anchor, got: ${JSON.stringify(scrollCalls)}`,
      );
      assert(
        link("db-pools")!.getAttribute("aria-current") === "true",
        "adopter: clicked section becomes active",
      );
      await act(async () => {
        adopterRoot!.unmount();
      });
    } finally {
      for (const s of HEALTH_DASHBOARD_SECTIONS) {
        dom.window.document.getElementById(s.id)?.remove();
      }
    }
    console.log("  ✓ real registry: lockstep anchors in source + rail mounts, observes and jumps");
  }

  console.log("\nsection-nav: SectionNav registers sections, jumps on click, tracks scroll, and the health dashboard adopts it.");
} catch (err) {
  failed = true;
  console.error(err);
}

// Remove the target elements we appended to the shared document body.
for (const s of SECTIONS) {
  dom.window.document.getElementById(s.id)?.remove();
}

process.exit(failed ? 1 : 0);
