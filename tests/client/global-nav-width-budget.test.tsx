/* test-registration
{
  "name": "GlobalAppNav — CEO nav band intrinsic-width budget: modeled band width must fit a 1280px viewport, so future inline links / labels / right-cluster controls can't silently reintroduce horizontal scroll on 1366px laptops (Task #4698)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4698: the ONLY automated guard on the nav band's width budget. Task #4675 fixed CEO nav overflow at 1280-1408px by trimming PRIMARY_INLINE_IDS and verified it manually in a browser; the placement test asserts membership only, and the browser layout sweep measures 375-1024px where the inline nav is hidden. This suite mounts the REAL GlobalAppNav as CEO and applies a deterministic width model (paddings/gaps/icons from rendered Tailwind classes + calibrated per-character text widths, worst-case truncation caps) so the next inline link, wider label, or right-cluster control fails it at merge time. Because it imports QuicklinksBar, related-smoke selection runs it on every nav edit. Fast, DB-free, network-free (fetch stubbed).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/global-nav-width-budget-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4698 — Catch top-nav overflow automatically when future links are added.
 *
 * Task #4675 established the contract: the CEO-role nav band (the widest
 * role's link set + the right cluster) must fit a 1280px viewport, because
 * the inline primary nav renders from the xl (1280px) breakpoint up and
 * 1366px laptops are the common floor. That fix was verified manually via
 * authed puppeteer; nothing automated guarded the budget afterwards.
 *
 * jsdom performs no layout, so this suite models the band's intrinsic width
 * deterministically from the RENDERED DOM (real components, real manifest,
 * real Button/cva classes):
 *
 *   - visibility at 1280px is derived from Tailwind display classes
 *     (base/sm:/md:/lg:/xl: active, 2xl: inactive);
 *   - fixed widths come from class tokens (w-4 icons, w-9 icon buttons,
 *     px-, ml-, mr- paddings and margins, gap- between visible flex
 *     children);
 *   - text width = character count x a calibrated per-character width for
 *     the active font-size class (conservative averages for the Inter-ish
 *     UI font; semibold/uppercase get a bump);
 *   - `max-w-[...]` + truncate caps use the CAP (worst case), not the
 *     fixture's short text — the username span must be priced at its full
 *     10rem allowance;
 *   - controls the harness can't mount (lazy NotificationBell /
 *     FeedbackButton stubs, the avatar img absent from the fixture) are
 *     priced at their fixed fallback footprints.
 *
 * The model is calibrated against Task #4675's real measurements: the full
 * pre-trim CEO set needed ~1410px and the trimmed set fits 1280px. Two
 * self-checks keep the model honest:
 *   1. the modeled total must land in a sane band (> 900px) — a model bug
 *      that prices the band at ~0 must fail, not hollow-pass;
 *   2. re-adding the two demoted links (Client Admin + Insights) must bust
 *      the budget — proving the model has teeth at roughly one-link
 *      granularity.
 *
 * Run: npm test -- --file=tests/client/global-nav-width-budget.test.tsx
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).PopStateEvent = dom.window.PopStateEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
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
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// CEO user — the widest link set (every isCeo/isTeamLead/isDirector/
// isAccountManager gate opens), so this is the binding width case.
const CEO_USER = {
  id: "ceo-4698",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
  authorityLevel: "ceo",
  functions: [],
};

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [{ path: "/api/auth/user", json: CEO_USER }],
  defaultJson: {},
});

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
const { ThemeProvider } = await import("../../client/src/lib/theme");
const { GlobalAppNav } = await import("../../client/src/components/QuicklinksBar");

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// ---------------------------------------------------------------------------
// Width model
// ---------------------------------------------------------------------------

/** The budget: the band must fit a 1280px viewport (Task #4675 contract). */
const VIEWPORT_BUDGET_PX = 1280;

// Tailwind breakpoints active when the viewport is exactly 1280px wide
// (xl = min-width 1280px, inclusive; 2xl = 1536px, inactive).
const ACTIVE_PREFIXES = ["sm", "md", "lg", "xl"];
const INACTIVE_PREFIXES = ["2xl"];

// Calibrated per-character average advance widths (px) for the UI font.
// Conservative averages including spaces; calibrated so the trimmed Task
// #4675 band models under 1280 while the pre-trim band (two extra inline
// links, ~244px) models over it — matching the real browser measurements
// (~1410px full set vs. fits-at-1280 trimmed).
const CHAR_PX: Record<string, number> = {
  "text-xs": 6.3,
  "text-caption": 6.3,
  "text-sm": 7.2,
  "text-base": 8.2,
  "text-lg": 9.5,
};
const DEFAULT_FONT_CLASS = "text-sm"; // band inherits the app's small UI text
const BOLD_FACTOR = 1.05; // font-semibold / font-bold render slightly wider
const UPPERCASE_TRACKING_FACTOR = 1.1; // uppercase + tracking-wide badges

// Fixed footprints for pieces jsdom can't size:
// - the brand bull mark img (h-6 w-auto — real aspect ~1.15, ≈28px wide);
// - the two lazy right-cluster icon buttons (NotificationBell /
//   FeedbackButton) whose Suspense fallbacks are h-9 w-9 = 36px each —
//   stubbed out of this harness, priced explicitly below;
// - the user avatar img (w-7 = 28px + its share of the gap-2), absent from
//   the fixture user but present for real users.
const BRAND_MARK_PX = 28;
const LAZY_ICON_BUTTON_PX = 36;
const LAZY_ICON_BUTTON_COUNT = 2;
const AVATAR_ALLOWANCE_PX = 36;

const SPACING_SCALE_PX = 4; // Tailwind default: 1 unit = 0.25rem = 4px

/** Parse a numeric Tailwind spacing suffix ("3", "1.5", "[10rem]") to px. */
function spacingToPx(suffix: string): number | null {
  const arb = suffix.match(/^\[(\d+(?:\.\d+)?)(rem|px)\]$/);
  if (arb) return arb[2] === "rem" ? parseFloat(arb[1]) * 16 : parseFloat(arb[1]);
  const n = suffix.match(/^(\d+(?:\.\d+)?)$/);
  if (n) return parseFloat(n[1]) * SPACING_SCALE_PX;
  return null;
}

/**
 * Resolve the class list applicable at a 1280px viewport: strip inactive
 * breakpoint prefixes, unwrap active ones (later breakpoints override
 * earlier same-property tokens only for the tokens we interpret, which is
 * handled by callers taking the LAST match).
 */
function classesAt1280(el: Element): string[] {
  const out: string[] = [];
  for (const raw of (el.getAttribute("class") || "").split(/\s+/)) {
    if (!raw) continue;
    const m = raw.match(/^([a-z0-9]+):(.+)$/);
    if (!m) {
      out.push(raw);
      continue;
    }
    if (INACTIVE_PREFIXES.includes(m[1])) continue;
    if (ACTIVE_PREFIXES.includes(m[1])) {
      out.push(m[2]);
      continue;
    }
    // Non-breakpoint variant (hover:, focus:, dark:, [&_svg]: …) — not a
    // static-layout contributor.
  }
  return out;
}

/** Last matching token wins (Tailwind cascade for our stripped list). */
function lastToken(classes: string[], re: RegExp): RegExpMatchArray | null {
  let found: RegExpMatchArray | null = null;
  for (const c of classes) {
    const m = c.match(re);
    if (m) found = m;
  }
  return found;
}

function isVisibleAt1280(el: Element): boolean {
  const classes = classesAt1280(el);
  // Overlay-layer elements contribute nothing to the band's intrinsic
  // width: dropdown/popover panels are portal-mounted and absolutely
  // positioned in a real browser (the jsdom Radix shim renders them inline
  // next to their triggers, so they must be excluded here explicitly).
  if (classes.some((c) => c === "absolute" || c === "fixed" || c === "z-50")) return false;
  const display = lastToken(classes, /^(hidden|block|flex|inline-flex|inline-block|inline|grid)$/);
  if (display && display[1] === "hidden") return false;
  if (el.tagName === "TEMPLATE" || el.tagName === "STYLE" || el.tagName === "SCRIPT") return false;
  return true;
}

interface FontCtx {
  sizeClass: string;
  bold: boolean;
  upper: boolean;
}

function fontFor(el: Element, inherited: FontCtx): FontCtx {
  const classes = classesAt1280(el);
  const size = lastToken(classes, /^(text-(?:xs|sm|base|lg|caption))$/);
  const bold = classes.some((c) => c === "font-semibold" || c === "font-bold");
  const upper = classes.some((c) => c === "uppercase");
  return {
    sizeClass: size ? size[1] : inherited.sizeClass,
    bold: bold || inherited.bold,
    upper: upper || inherited.upper,
  };
}

function textWidth(text: string, font: FontCtx): number {
  const chars = text.replace(/\s+/g, " ").trim().length;
  if (chars === 0) return 0;
  let per = CHAR_PX[font.sizeClass] ?? CHAR_PX[DEFAULT_FONT_CLASS];
  if (font.bold) per *= BOLD_FACTOR;
  if (font.upper) per *= UPPERCASE_TRACKING_FACTOR;
  return chars * per;
}

/**
 * Model the horizontal footprint of an element inside the flex row:
 * own padding + margins + max(fixed width, content width), where content
 * width = sum of visible children + text nodes + own gap between them.
 * `max-w-*` caps the CONTENT (worst-case truncation allowance).
 */
function modelWidth(el: Element, inherited: FontCtx): number {
  if (!isVisibleAt1280(el)) return 0;
  const classes = classesAt1280(el);
  const font = fontFor(el, inherited);

  // Margins (horizontal only).
  let margins = 0;
  for (const c of classes) {
    const m = c.match(/^m([lrx])-(.+)$/);
    if (!m) continue;
    const px = spacingToPx(m[2]);
    if (px == null) continue;
    margins += m[1] === "x" ? px * 2 : px;
  }

  // Fixed width classes (w-4 icons, w-9 icon buttons, w-7 avatars …).
  const wTok = lastToken(classes, /^w-(.+)$/);
  if (wTok && wTok[1] !== "auto" && wTok[1] !== "full") {
    const px = spacingToPx(wTok[1]);
    if (px != null) return margins + px;
  }

  // The brand bull mark: h-6 w-auto img — jsdom has no intrinsic size.
  if (el.getAttribute("data-testid") === "img-brand-bull" || el.tagName === "IMG") {
    return margins + BRAND_MARK_PX;
  }
  // SVG icons without an explicit w-* class default to the lucide 16px box.
  if (el.tagName.toLowerCase() === "svg") return margins + 16;

  // Horizontal padding.
  let padding = 0;
  for (const c of classes) {
    const m = c.match(/^p([lrx])-(.+)$/);
    if (!m) continue;
    const px = spacingToPx(m[2]);
    if (px == null) continue;
    padding += m[1] === "x" ? px * 2 : px;
  }

  // Gap between visible children (flex row assumption — the band is one).
  const gapTok = lastToken(classes, /^gap(?:-x)?-(.+)$/);
  const gapPx = gapTok ? (spacingToPx(gapTok[1]) ?? 0) : 0;

  // Content: element children + direct text nodes.
  let content = 0;
  let visibleParts = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const w = textWidth(node.textContent || "", font);
      if (w > 0) {
        content += w;
        visibleParts += 1;
      }
    } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const w = modelWidth(node as Element, font);
      if (w > 0) {
        content += w;
        visibleParts += 1;
      }
    }
  }
  if (visibleParts > 1) content += gapPx * (visibleParts - 1);

  // A truncating element with max-w-* is priced at its FULL truncation
  // allowance (worst case: a long value — e.g. an email-address username —
  // fills the whole max-w-[10rem] cap). Non-truncating max-w (e.g. the
  // band's own max-w-[1536px] centering cap) does not change intrinsic
  // content width and is ignored.
  const maxW = lastToken(classes, /^max-w-(\[.+\])$/);
  if (maxW && classes.includes("truncate")) {
    const cap = spacingToPx(maxW[1]);
    if (cap != null) content = cap;
  }

  return margins + padding + content;
}

/**
 * Model one inline HeaderNavLink the way the band renders it:
 * px-3 (24) + 16px icon + gap-1.5 (6) + text-sm label.
 */
function modelInlineLink(label: string): number {
  return 24 + 16 + 6 + textWidth(label, { sizeClass: "text-sm", bold: false, upper: false });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("GlobalAppNav — CEO nav band width budget (Task #4698)");

  dom.window.history.replaceState(null, "", "/");
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(
          ThemeProvider as any,
          null,
          React.createElement(GlobalAppNav as any),
        ),
      ),
    );
  });
  await flush();

  try {
    const header = document.querySelector('[data-testid="global-app-nav"]') as HTMLElement;
    assert(header, "GlobalAppNav header must render for the CEO fixture");
    const band = header.firstElementChild as HTMLElement;
    assert(band, "nav band container must render inside the header");

    // Sanity: the CEO band really is the widest configuration under test —
    // the inline primary nav and the right-cluster menus all rendered.
    assert(
      band.querySelector('nav[aria-label="Primary"]'),
      "inline primary nav must render (CEO fixture)",
    );
    for (const id of ["button-global-palette", "button-new-menu", "button-more-menu", "button-user-menu"]) {
      assert(band.querySelector(`[data-testid="${id}"]`), `${id} must render in the band`);
    }

    // ── Model the band ────────────────────────────────────────────────────
    const rootFont: FontCtx = { sizeClass: DEFAULT_FONT_CLASS, bold: false, upper: false };
    // Per-child breakdown first — so a budget failure names the offender.
    for (const child of Array.from(band.children)) {
      const w = modelWidth(child, rootFont);
      if (w === 0) continue;
      const label =
        child.getAttribute("data-testid") ||
        child.querySelector("[data-testid]")?.getAttribute("data-testid") ||
        `<${child.tagName.toLowerCase()} class="${(child.getAttribute("class") || "").slice(0, 60)}">`;
      console.log(`    ${Math.round(w)}px  ${label}`);
    }
    const modeled = modelWidth(band, rootFont);

    // Pieces the harness can't mount, priced at fixed footprints (plus
    // their share of the band's gap-4):
    const bandClasses = classesAt1280(band);
    const bandGapTok = lastToken(bandClasses, /^gap(?:-x)?-(.+)$/);
    const bandGap = bandGapTok ? (spacingToPx(bandGapTok[1]) ?? 0) : 0;
    const renderedIconButtons = band.querySelectorAll(
      '[data-testid="button-notification-bell"], [data-testid="button-feedback"]',
    ).length;
    const missingLazyButtons = Math.max(0, LAZY_ICON_BUTTON_COUNT - renderedIconButtons);
    const lazyAllowance = missingLazyButtons * (LAZY_ICON_BUTTON_PX + bandGap);
    const avatarRendered = !!band.querySelector('[data-testid="img-user-avatar"]');
    const avatarAllowance = avatarRendered ? 0 : AVATAR_ALLOWANCE_PX;

    const total = modeled + lazyAllowance + avatarAllowance;

    console.log(
      `  modeled band width: ${Math.round(modeled)}px` +
        ` + lazy-button allowance ${Math.round(lazyAllowance)}px` +
        ` + avatar allowance ${avatarAllowance}px` +
        ` = ${Math.round(total)}px (budget ${VIEWPORT_BUDGET_PX}px)`,
    );

    // Model self-check 1: a broken model (empty band, visibility bug, parse
    // bug) must fail loudly instead of hollow-passing at ~0px.
    assert(
      total > 900,
      `modeled band width ${Math.round(total)}px is implausibly small — the width model ` +
        `or the harness broke; refusing a hollow pass`,
    );

    // ── THE BUDGET ────────────────────────────────────────────────────────
    assert(
      total <= VIEWPORT_BUDGET_PX,
      `CEO nav band models at ${Math.round(total)}px, exceeding the ${VIEWPORT_BUDGET_PX}px ` +
        `viewport budget (Task #4675 contract: the band must fit 1280px so 1366px laptops ` +
        `don't horizontally scroll). Remedies: fold a link into More (PRIMARY_INLINE_IDS in ` +
        `QuicklinksBar.tsx), shorten a label, or slim the right cluster — then re-verify in a ` +
        `real browser at 1280/1366 (see the Task #4675 recipe) before recalibrating this model.`,
    );
    console.log(`  ✓ band fits the ${VIEWPORT_BUDGET_PX}px budget`);

    // Model self-check 2 (teeth): re-adding the two links Task #4675 demoted
    // must bust the budget. If this ever fails, the model has drifted too
    // loose to catch a real regression — recalibrate against a browser
    // measurement instead of deleting the assertion.
    const readdedTotal =
      total + modelInlineLink("Client Admin") + modelInlineLink("Insights") + 2 * 4; /* gap-1 */
    assert(
      readdedTotal > VIEWPORT_BUDGET_PX,
      `model lost its teeth: re-adding Client Admin + Insights inline models at ` +
        `${Math.round(readdedTotal)}px, which should exceed ${VIEWPORT_BUDGET_PX}px ` +
        `(the pre-#4675 band measured ~1410px in a real browser)`,
    );
    console.log(
      `  ✓ model has teeth: pre-#4675 configuration would model at ${Math.round(readdedTotal)}px > ${VIEWPORT_BUDGET_PX}px`,
    );
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    queryClient.clear();
  }

  console.log("\nAll GlobalAppNav width-budget assertions passed.");
}

await main();
process.exit(0);
