/* test-registration
{
  "name": "PageHeader — Pattern-A anatomy, back-affordance navigation, actions/subtitle/breadcrumb-depth gate (Task #4344)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4344: pins the codified admin Pattern-A page header — token-only crimson title (--accent identity moment per the Task #4558/#4600 rebalance, with the documented dark:text-foreground heading tone; never the deprecated #6B2C3E fork or the pre-#4558 --primary), always-present back affordance that fires real wouter navigation, right-slot actions, subtitle, the sticky --z-sticky rung, the >2-level breadcrumb gate, and the onBand chrome-band variant (text-chrome-foreground per Task #4600). Pure jsdom component mount: DB-free, network-free, deterministic and sub-second, so it earns a routine-gate slot alongside the other tests/client component suites.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4344 — Direct component test for the shared admin `PageHeader`
 * (`client/src/components/admin/PageHeader.tsx`).
 *
 * PageHeader codifies the panel's "Pattern A" header (audit §6.1-B / §8.3).
 * This suite proves the contract the codification promises:
 *
 *   (a) Faithful Pattern-A anatomy — a `flex items-center gap-3` row with a
 *       ghost back button and a `text-2xl font-bold` title that renders from the
 *       `--accent` token (class `text-accent`, the crimson page-header identity
 *       moment sanctioned by the Task #4558 re-primary + Task #4600 rebalance,
 *       keeping the documented `dark:text-foreground` heading tone), NOT the
 *       deprecated `#6B2C3E` hex the hand-rolled headers used and NOT the
 *       pre-#4558 `text-primary` contract this suite pinned before the rebalance.
 *   (b) The back affordance is always present and actually navigates — clicking
 *       it drives wouter to `backHref`.
 *   (c) The right-side action slot renders (with `ml-auto`).
 *   (d) The optional subtitle renders when supplied.
 *   (e) The breadcrumb is a deep-page-only affordance: it renders for >2 crumbs
 *       and is intentionally suppressed for 2-or-fewer.
 *   (f) The `sticky` variant pins on the documented `--z-sticky` rung.
 *
 * jsdom harness mirrors tests/client/client-detail-tab-to-url.test.tsx: globals
 * installed before the dynamic react/react-dom import, wouter's bare
 * location/history/addEventListener globals wired so <Link> navigation works.
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
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
// wouter's use-browser-location reads BARE location/history and subscribes via
// bare addEventListener/removeEventListener/dispatchEvent.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
const { PageHeader } = await import("../../client/src/components/admin/PageHeader");
const { Phone } = await import("lucide-react");

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function render(props: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(PageHeader, props));
  });
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

let failed = false;
try {
  // ── (a) Faithful Pattern-A anatomy on the Twilio-shaped props ─────────────
  console.log("\n— PageHeader: faithful Pattern-A anatomy (Twilio shape) —");
  {
    // Start on a non-target path so the navigation assertion is meaningful.
    dom.window.history.replaceState(null, "", "/admin/twilio");
    const root = await render({
      title: "Twilio Settings",
      icon: Phone,
      backHref: "/admin/integrations",
    });
    try {
      const title = $("text-page-title");
      assert(title !== null, "anatomy: title must render");
      assert(
        (title!.textContent || "").includes("Twilio Settings"),
        `anatomy: title text, got: ${title!.textContent}`,
      );
      assert(title!.tagName === "H1", "anatomy: title must be an <h1>");
      const cls = title!.className;
      assert(cls.includes("text-2xl"), `anatomy: title keeps text-2xl, got: ${cls}`);
      assert(cls.includes("font-bold"), `anatomy: title keeps font-bold, got: ${cls}`);
      assert(
        cls.includes("text-accent"),
        `anatomy: title must render from the --accent token (text-accent, the sanctioned crimson page-header identity), got: ${cls}`,
      );
      assert(
        cls.includes("dark:text-foreground"),
        `anatomy: title must keep the documented dark-mode heading tone (dark:text-foreground), got: ${cls}`,
      );
      assert(
        !cls.includes("text-primary"),
        `anatomy: title must NOT render from --primary (the pre-#4558 contract; the header identity moved to --accent), got: ${cls}`,
      );
      assert(
        !cls.includes("6B2C3E") && !cls.includes("6b2c3e"),
        `anatomy: title must NOT hardcode the deprecated #6B2C3E fork, got: ${cls}`,
      );
      // Inline leading icon lives inside the h1 (lucide renders an <svg>).
      assert(
        title!.querySelector("svg") !== null,
        "anatomy: leading icon renders inline inside the title",
      );
      // The flex row that Twilio relies on for its unchanged look.
      assert(
        document.querySelector(".flex.items-center.gap-3") !== null,
        "anatomy: header uses the Pattern-A flex row",
      );
      // No subtitle / no actions / no breadcrumb for this shape.
      assert($("text-page-subtitle") === null, "anatomy: no subtitle when unset");
      assert($("page-header-actions") === null, "anatomy: no action slot when unset");
      assert($("page-header-breadcrumb") === null, "anatomy: no breadcrumb when unset");
      console.log("  ✓ token-styled crimson (--accent) title + inline icon + Pattern-A flex row");
    } finally {
      await unmount(root);
    }
  }

  // ── (b) Back affordance is always present and navigates ───────────────────
  console.log("\n— PageHeader: back affordance fires navigation —");
  {
    dom.window.history.replaceState(null, "", "/admin/twilio");
    const root = await render({
      title: "Twilio Settings",
      icon: Phone,
      backHref: "/admin/integrations",
    });
    try {
      const back = $("button-back");
      assert(back !== null, "back: back affordance must always render");
      assert(back!.tagName === "A", "back: renders as an anchor (wouter Link)");
      assert(
        back!.getAttribute("href") === "/admin/integrations",
        `back: href points at backHref, got: ${back!.getAttribute("href")}`,
      );
      assert(
        window.location.pathname === "/admin/twilio",
        `back: sanity — start path, got: ${window.location.pathname}`,
      );
      await act(async () => {
        back!.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
            view: dom.window,
          }),
        );
      });
      assert(
        window.location.pathname === "/admin/integrations",
        `back: clicking Back navigates to backHref, got: ${window.location.pathname}`,
      );
      console.log("  ✓ clicking Back drives wouter navigation to backHref");
    } finally {
      await unmount(root);
    }
  }

  // ── (c) Right-side action slot ────────────────────────────────────────────
  console.log("\n— PageHeader: right-side action slot —");
  {
    const root = await render({
      title: "With Actions",
      backHref: "/",
      actions: React.createElement(
        "button",
        { "data-testid": "custom-action" },
        "Refresh",
      ),
    });
    try {
      const action = $("custom-action");
      assert(action !== null, "actions: custom action renders");
      const slot = $("page-header-actions");
      assert(slot !== null, "actions: action slot wrapper renders");
      assert(
        slot!.className.includes("ml-auto"),
        `actions: slot is right-aligned (ml-auto), got: ${slot!.className}`,
      );
      assert(slot!.contains(action), "actions: action lives inside the right slot");
      console.log("  ✓ actions render in the ml-auto right slot");
    } finally {
      await unmount(root);
    }
  }

  // ── (d) Optional subtitle ─────────────────────────────────────────────────
  console.log("\n— PageHeader: optional subtitle —");
  {
    const root = await render({
      title: "System Health",
      backHref: "/",
      subtitle: "Unified console for health, routing, audit retention.",
    });
    try {
      const sub = $("text-page-subtitle");
      assert(sub !== null, "subtitle: renders when supplied");
      assert(
        (sub!.textContent || "").includes("Unified console"),
        `subtitle: text, got: ${sub!.textContent}`,
      );
      console.log("  ✓ subtitle renders under the title");
    } finally {
      await unmount(root);
    }
  }

  // ── (e) Breadcrumb gates on >2-level depth ────────────────────────────────
  console.log("\n— PageHeader: breadcrumb only for >2-level depth —");
  {
    // 3 crumbs → renders.
    const deep = await render({
      title: "Deep Page",
      backHref: "/",
      breadcrumb: [
        { label: "Admin", href: "/admin" },
        { label: "Integrations", href: "/admin/integrations" },
        { label: "Twilio" },
      ],
    });
    try {
      const bc = $("page-header-breadcrumb");
      assert(bc !== null, "breadcrumb: renders for 3 crumbs (>2-level depth)");
      const txt = bc!.textContent || "";
      assert(
        txt.includes("Admin") && txt.includes("Integrations") && txt.includes("Twilio"),
        `breadcrumb: shows every crumb, got: ${txt}`,
      );
      console.log("  ✓ breadcrumb renders for a deep (3-level) page");
    } finally {
      await unmount(deep);
    }

    // 2 crumbs → intentionally suppressed.
    const shallow = await render({
      title: "Shallow Page",
      backHref: "/",
      breadcrumb: [
        { label: "Admin", href: "/admin" },
        { label: "Twilio" },
      ],
    });
    try {
      assert(
        $("page-header-breadcrumb") === null,
        "breadcrumb: suppressed for 2 crumbs (not deep enough)",
      );
      console.log("  ✓ breadcrumb suppressed for a shallow (2-level) page");
    } finally {
      await unmount(shallow);
    }
  }

  // ── (f) Sticky variant sits on the --z-sticky rung ────────────────────────
  console.log("\n— PageHeader: sticky variant uses the z-scale —");
  {
    const root = await render({
      title: "Sticky Header",
      backHref: "/",
      sticky: true,
    });
    try {
      const rootEl = $("page-header");
      assert(rootEl !== null, "sticky: root renders");
      const cls = rootEl!.className;
      assert(cls.includes("sticky"), `sticky: root is sticky, got: ${cls}`);
      assert(
        cls.includes("z-[var(--z-sticky)]"),
        `sticky: root pins on the --z-sticky rung, got: ${cls}`,
      );
      assert(
        !/\bz-\d/.test(cls),
        `sticky: must not use a raw Tailwind z-number, got: ${cls}`,
      );
      console.log("  ✓ sticky variant renders on the documented z-scale rung");
    } finally {
      await unmount(root);
    }
  }

  // ── (g) On-band variant flips to light-on-dark tokens (Task #4451) ────────
  console.log("\n— PageHeader: onBand variant renders light-on-dark tokens —");
  {
    const root = await render({
      title: "NoBull Brief Studio",
      backHref: "/",
      onBand: true,
      subtitle: "On a primary band",
      actions: React.createElement(
        "button",
        { "data-testid": "band-action" },
        "New",
      ),
    });
    try {
      const title = $("text-page-title");
      assert(title !== null, "onBand: title renders");
      const cls = title!.className;
      assert(
        cls.includes("text-chrome-foreground"),
        `onBand: title uses text-chrome-foreground on the chrome band (Task #4600 moved bands off --primary), got: ${cls}`,
      );
      assert(
        !cls.includes("text-accent"),
        `onBand: title must NOT keep text-accent (crimson-on-crimson is invisible on its own band), got: ${cls}`,
      );
      assert(
        !cls.includes("text-primary"),
        `onBand: title must NOT use the retired primary/primary-foreground band tokens (Task #4600), got: ${cls}`,
      );
      assert(cls.includes("text-2xl") && cls.includes("font-bold"), `onBand: keeps Pattern-A title scale, got: ${cls}`);
      const back = $("button-back");
      assert(back !== null, "onBand: back affordance still present");
      assert(
        back!.className.includes("text-chrome-foreground"),
        `onBand: back affordance flips to light-on-dark chrome tokens, got: ${back!.className}`,
      );
      const sub = $("text-page-subtitle");
      assert(sub !== null && sub.className.includes("text-chrome-foreground/70"), `onBand: subtitle uses band-legible tone, got: ${sub?.className}`);
      const slot = $("page-header-actions");
      assert(slot !== null && slot.contains($("band-action")!), "onBand: actions slot unchanged");
      console.log("  ✓ onBand renders title/back/subtitle from chrome-foreground tokens");
    } finally {
      await unmount(root);
    }
  }

  console.log("\npage-header: PageHeader codifies Pattern A from tokens with a faithful back affordance.");
} catch (err) {
  failed = true;
  console.error(err);
}

process.exit(failed ? 1 : 0);
