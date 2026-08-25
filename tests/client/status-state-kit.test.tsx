/* test-registration
{
  "name": "Status & state kit — KpiCard delta direction/tone, StatusPill at-rest-neutral tone mapping, EmptyState slots, DegradedState diagnostics/retry (Zoom-shape parity), DangerZone reveal separation, Card accent variant (Task #4345), BrandMark asset map + theme swap (Task #4618)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure jsdom render of the shared status/state kit primitives: no DB, no network, no loader hooks, sub-second in one tsx child. The kit is the designated shared contract for status rendering across admin surfaces (audit \u00a78.3), so tone-mapping or danger-gating regressions should block the routine gate.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4345 — Core-behavior coverage for the shared status & state kit
 * (`client/src/components/kit/*` + the Card accent variant in
 * `client/src/components/ui/card.tsx`):
 *
 *  - KpiCard: delta direction comes from the SIGN of delta.value, delta tone
 *    from what that direction MEANS (`goodWhen` up/down/none — Ads OS
 *    MetricPill semantics); label/unit/caption anatomy (the unlabeled-"0.76"
 *    fix).
 *  - StatusPill: tone → `--status-*` token class mapping, with NEUTRAL as the
 *    default (the "red only for actionable-now" rule baked in) and the pill
 *    radius token.
 *  - EmptyState: what/when/how-to-test/CTA slots (webhook-logs exemplar).
 *  - DegradedState: engaged-for chip, diagnostics children, self-heal retry
 *    line (parked wins over a stale cooldown), reconnect action slot — plus a
 *    composition mirroring the refit Zoom banner's exact testid contract.
 *  - DangerZone: destructive actions are OUT OF THE DOM until the explicit
 *    reveal (separation gate), aria-expanded wiring, non-collapsible variant.
 *  - Card accent: opt-in `data-accent` + tokenized left-stripe classes; no
 *    accent → untouched Card.
 *  - BrandMark: BRAND_ASSET_PATHS maps every variant to a file that actually
 *    exists under client/public (the old Clerk logo pointed at a /logo.svg
 *    that never existed — the exact silent-brand-outage class this guards),
 *    decorative-by-default aria, dark twin swap classes + `-dark` testid.
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
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
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

const { KpiCard, kpiDeltaTone } = await import(
  "../../client/src/components/kit/KpiCard"
);
const { StatusPill } = await import(
  "../../client/src/components/kit/StatusPill"
);
const { EmptyState } = await import(
  "../../client/src/components/kit/EmptyState"
);
const { BrandMark, BRAND_ASSET_PATHS } = await import(
  "../../client/src/components/kit/BrandMark"
);
const { DegradedState, formatEngagedFor } = await import(
  "../../client/src/components/kit/DegradedState"
);
const { DangerZone } = await import(
  "../../client/src/components/kit/DangerZone"
);
const { Card } = await import("../../client/src/components/ui/card");

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function render(node: React.ReactNode): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

// ═══ 1) KpiCard — delta direction & tone semantics ══════════════════════
console.log("\n— KpiCard: delta direction × goodWhen → tone —");
{
  // Pure helper first: the four meaningful quadrants + neutral cases.
  assert(kpiDeltaTone({ value: 12, goodWhen: "up" }) === "ok", "up & up-good → ok");
  assert(kpiDeltaTone({ value: -8, goodWhen: "up" }) === "critical", "down & up-good → critical");
  assert(kpiDeltaTone({ value: 15, goodWhen: "down" }) === "critical", "up & down-good (CPL) → critical");
  assert(kpiDeltaTone({ value: -15, goodWhen: "down" }) === "ok", "down & down-good (CPL) → ok");
  assert(kpiDeltaTone({ value: 40, goodWhen: "none" }) === "neutral", "spend-like goodWhen none → neutral even for big moves");
  assert(kpiDeltaTone({ value: 0, goodWhen: "up" }) === "neutral", "zero change → neutral");
  assert(kpiDeltaTone({ value: 7 }) === "ok", "goodWhen defaults to up");
  console.log("  ✓ kpiDeltaTone quadrants + neutral cases");

  // Rendered chip: up-good ↑ (ok)
  let root = await render(
    <KpiCard
      testId="kpi-leads"
      label="Leads"
      value="231"
      delta={{ value: 12, goodWhen: "up", label: "vs. June" }}
    />,
  );
  try {
    const chip = $("kpi-leads-delta");
    assert(chip !== null, "delta chip renders");
    assert(chip!.getAttribute("data-direction") === "up", "positive value → data-direction=up");
    assert(chip!.getAttribute("data-tone") === "ok", "up-good rise → data-tone=ok");
    assert(chip!.className.includes("text-status-ok"), "ok tone uses --status-ok token class");
    assert(chip!.querySelector("svg") !== null, "direction arrow renders");
    assert((chip!.textContent || "").includes("12%"), "percent magnitude renders");
    assert((chip!.textContent || "").includes("vs. June"), "comparison label renders");
    assert(($("kpi-leads-value")!.textContent || "").trim() === "231", "value renders");
    const rootEl = $("kpi-leads");
    assert(rootEl !== null && (rootEl.textContent || "").includes("Leads"), "label always renders");
    assert(rootEl!.className.includes("rounded-none"), "KpiCard is square-cornered");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ up-good rise renders ▲ chip in ok tone");

  // Rendered chip: down-good ↓ (ok) — CPL falling is good news.
  root = await render(
    <KpiCard
      testId="kpi-cpl"
      label="CPL"
      value="$38.10"
      delta={{ value: -15, goodWhen: "down" }}
    />,
  );
  try {
    const chip = $("kpi-cpl-delta")!;
    assert(chip.getAttribute("data-direction") === "down", "negative value → data-direction=down");
    assert(chip.getAttribute("data-tone") === "ok", "down-good fall → data-tone=ok");
    assert(chip.className.includes("text-status-ok"), "down-good fall renders in ok token");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ down-good fall renders ▼ chip in ok tone (direction ≠ tone)");

  // Rendered chip: up-good fall (critical) + label/unit/caption anatomy.
  root = await render(
    <KpiCard
      testId="kpi-health"
      label="Health score"
      value="0.76"
      unit="of 1.0"
      caption="Avg client health · last 30 days"
      delta={{ value: -8, goodWhen: "up" }}
    />,
  );
  try {
    const chip = $("kpi-health-delta")!;
    assert(chip.getAttribute("data-tone") === "critical", "up-good fall → critical tone");
    assert(chip.className.includes("text-status-critical"), "critical tone uses --status-critical token class");
    const card = $("kpi-health")!;
    assert((card.textContent || "").includes("Health score"), "the 0.76 gets its label");
    assert((card.textContent || "").includes("of 1.0"), "unit renders next to value");
    assert(($("kpi-health-caption")!.textContent || "").includes("last 30 days"), "caption slot renders scale/window context");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ unlabeled-metric fix: label + unit + caption anatomy");

  // Zero delta → flat, neutral, no arrow.
  root = await render(
    <KpiCard testId="kpi-flat" label="Calls" value="52" delta={{ value: 0 }} />,
  );
  try {
    const chip = $("kpi-flat-delta")!;
    assert(chip.getAttribute("data-direction") === "flat", "zero → data-direction=flat");
    assert(chip.getAttribute("data-tone") === "neutral", "zero → neutral tone");
    assert(chip.querySelector("svg") === null, "flat delta renders no arrow");
    assert(chip.className.includes("text-muted-foreground"), "neutral delta stays muted");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ flat delta stays quiet (no arrow, muted)");
}

// ═══ 2) StatusPill — tone → token mapping, neutral at rest ══════════════
console.log("\n— StatusPill: tone mapping —");
{
  const root = await render(
    <div>
      <StatusPill testId="pill-default">Idle</StatusPill>
      <StatusPill testId="pill-ok" tone="ok">Recovered</StatusPill>
      <StatusPill testId="pill-warn" tone="warn">Degraded</StatusPill>
      <StatusPill testId="pill-critical" tone="critical" dot>3 failing</StatusPill>
      <StatusPill testId="pill-info" tone="info">FYI</StatusPill>
    </div>,
  );
  try {
    const def = $("pill-default")!;
    assert(def.getAttribute("data-tone") === "neutral", "tone DEFAULTS to neutral — at-rest pills are calm without opting in");
    assert(def.className.includes("text-muted-foreground"), "neutral pill renders muted, not a status color");
    // Pins the extended twMerge config in cn(): without the type-scale
    // classGroup, tailwind-merge classifies text-caption as a COLOR and
    // drops it in favor of the tone color (pills silently render 16px).
    assert(
      def.className.includes("text-caption"),
      "type-scale class survives merging with a text color (cn font-size group)",
    );
    assert(!def.className.includes("status-critical"), "neutral pill carries no red class at rest");
    assert(def.className.includes("rounded-pill"), "pills use the --radius-pill token (sole rounded exception)");
    // Pins the rounded classGroup in cn() (Task #4361): without registering
    // `pill`, tailwind-merge can't see rounded-pill and rounded-md as
    // conflicting, keeps BOTH, and stylesheet order (not call order) decides
    // the radius — e.g. Badge overrides would silently stay square-ish.
    const { cn } = await import("../../client/src/lib/utils");
    assert(cn("rounded-md", "rounded-pill") === "rounded-pill", "rounded-pill wins a cn() conflict with rounded-md (rounded classGroup registered)");
    assert(cn("rounded-pill", "rounded-none") === "rounded-none", "rounded conflicts still resolve last-wins over rounded-pill");

    const cases: Array<[string, string]> = [
      ["pill-ok", "status-ok"],
      ["pill-warn", "status-warn"],
      ["pill-critical", "status-critical"],
      ["pill-info", "status-info"],
    ];
    for (const [id, token] of cases) {
      const el = $(id)!;
      assert(el.className.includes(`text-${token}`), `${id} maps to text-${token}`);
      assert(el.className.includes(`bg-${token}/10`), `${id} gets the tinted ${token} background`);
      assert(el.getAttribute("data-tone") === token.replace("status-", ""), `${id} exposes data-tone`);
    }
    const dot = $("pill-critical")!.querySelector("span[aria-hidden]");
    assert(dot !== null && (dot as HTMLElement).className.includes("bg-current"), "dot renders in the tone color via bg-current");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ all five tones map to their tokens; neutral is the default");
}

// ═══ 3) EmptyState — educational slots ══════════════════════════════════
console.log("\n— EmptyState: what/when/how-to-test/CTA slots —");
{
  const root = await render(
    <EmptyState
      testId="empty-demo"
      icon={<svg data-icon="webhook" />}
      title="No webhook import attempts yet"
      description="Imports are triggered via POST /api/webhooks/report-import"
      hint="Send a multipart POST with the CEO tools token to test."
      action={<button data-testid="empty-demo-cta">View API docs</button>}
    />,
  );
  try {
    const el = $("empty-demo")!;
    assert(el !== null, "EmptyState renders with testId");
    assert((el.textContent || "").includes("No webhook import attempts yet"), "title (what this is) renders");
    assert((el.textContent || "").includes("Imports are triggered via"), "description (when rows appear) renders");
    assert((el.textContent || "").includes("to test"), "hint (how to test) renders");
    assert($("empty-demo-cta") !== null, "CTA slot renders");
    assert(el.querySelector("[data-icon='webhook']") !== null, "icon slot renders");
    assert(el.className.includes("text-muted-foreground"), "empty state is muted (token, not gray-500)");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ all four educational slots render");
}

// ═══ 4) DegradedState — diagnostics + retry + reconnect ═════════════════
console.log("\n— DegradedState: engaged/diagnostics/retry/action —");
{
  // formatEngagedFor is the shared engaged-duration formatter.
  const now = Date.now();
  assert(formatEngagedFor(now) === "just now", "sub-minute → 'just now'");
  assert(formatEngagedFor(now - 5 * 60_000) === "5m ago", "minutes-only form");
  assert(formatEngagedFor(now - (2 * 60 + 5) * 60_000) === "2h 5m ago", "h+m form");
  assert(formatEngagedFor(now - (3 * 24 * 60 + 4 * 60) * 60_000) === "3d 4h ago", "d+h form");
  console.log("  ✓ formatEngagedFor duration forms");

  // Zoom-shape composition — mirrors the refit Integrations Hub banner's
  // exact testid contract so the proof adopter's markup stays pinned.
  const engagedSince = now - 2 * 60 * 60_000;
  const cooldown = new Date(now + 5 * 60_000);
  let root = await render(
    <DegradedState
      testId="banner-zoom-reconnect-required"
      title="Zoom needs to be reconnected"
      since={engagedSince}
      sinceTestId="text-zoom-reconnect-engaged-for"
      retryAt={cooldown}
      retryPaused={false}
      retryTestIdPrefix="text-zoom-selfheal"
      action={<button data-testid="button-zoom-reconnect-banner">Reconnect Zoom</button>}
    >
      <div data-testid="text-zoom-auth-gate-reason">
        Auth blocked (status 401): token revoked. Calls will keep failing until an operator reconnects.
      </div>
      <div data-testid="text-zoom-scope-gates">Missing Zoom scopes for: recordings.</div>
    </DegradedState>,
  );
  try {
    const banner = $("banner-zoom-reconnect-required")!;
    assert(banner !== null, "panel renders with the adopter's testid");
    assert(banner.getAttribute("data-tone") === "warn", "default tone is warn (degraded-but-working)");
    assert(banner.className.includes("border-status-warn"), "warn tone frames with --status-warn (no ad-hoc amber)");
    assert((banner.textContent || "").includes("Zoom needs to be reconnected"), "title renders");
    const engaged = $("text-zoom-reconnect-engaged-for")!;
    assert(engaged !== null, "engaged-for chip renders");
    assert((engaged.textContent || "").includes("· Engaged 2h ago"), `engaged-for uses formatEngagedFor, got: ${engaged.textContent}`);
    assert((engaged.getAttribute("title") || "").length > 0, "engaged-for carries a full-timestamp tooltip");
    assert($("text-zoom-auth-gate-reason") !== null, "diagnostics children render");
    assert($("text-zoom-scope-gates") !== null, "second diagnostics child renders");
    const selfheal = $("text-zoom-selfheal")!;
    assert(selfheal !== null, "retry line container renders under the prefix testid");
    const until = $("text-zoom-selfheal-cooldown-until")!;
    assert(until !== null, "cooldown-until span renders when not parked");
    assert((until.textContent || "").startsWith("Auto-retry at"), "retry line announces the next self-heal attempt");
    assert($("text-zoom-selfheal-parked") === null, "parked span absent while retries are live");
    assert($("button-zoom-reconnect-banner") !== null, "explicit reconnect action renders inside the panel");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ Zoom-shape composition: engaged chip, diagnostics, retry time, reconnect CTA");

  // Parked wins over any stale cooldown timestamp.
  root = await render(
    <DegradedState
      testId="degraded-parked"
      title="Zoom needs to be reconnected"
      retryAt={cooldown}
      retryPaused
      retryTestIdPrefix="text-zoom-selfheal"
    />,
  );
  try {
    const parked = $("text-zoom-selfheal-parked")!;
    assert(parked !== null, "parked span renders when self-heal is parked");
    assert((parked.textContent || "").includes("Auto-retry paused"), "parked copy explains retries stopped");
    assert($("text-zoom-selfheal-cooldown-until") === null, "cooldown span suppressed while parked (parked wins)");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ retryPaused wins over a supplied cooldown");

  // Critical tone maps to the critical token family.
  root = await render(
    <DegradedState testId="degraded-critical" title="Recordings pipeline down" tone="critical" />,
  );
  try {
    const el = $("degraded-critical")!;
    assert(el.getAttribute("data-tone") === "critical", "tone prop exposed");
    assert(el.className.includes("border-status-critical"), "critical tone frames with --status-critical");
    assert($("text-zoom-selfheal") === null, "no retry line renders without retryAt/retryPaused");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ critical tone + retry line absent when unconfigured");
}

// ═══ 5) DangerZone — destructive actions separated + gated ══════════════
console.log("\n— DangerZone: reveal gate & separation —");
{
  let root = await render(
    <DangerZone
      testId="dz"
      description="These affect the live client record."
    >
      <button data-testid="dz-archive">Archive client</button>
    </DangerZone>,
  );
  try {
    assert($("dz") !== null, "zone renders");
    assert(($("dz")!.textContent || "").includes("Danger zone"), "default title renders");
    assert($("dz")!.className.includes("border-status-critical"), "zone framed with --status-critical outline");
    assert($("dz-archive") === null, "destructive action is OUT OF THE DOM until revealed (separation gate)");
    assert($("dz-actions") === null, "actions region absent while collapsed");
    const toggle = $("dz-toggle")!;
    assert(toggle !== null, "reveal toggle renders");
    assert(toggle.getAttribute("aria-expanded") === "false", "toggle reports collapsed state");
    assert((toggle.textContent || "").includes("Show destructive actions"), "toggle names what it reveals");

    await act(async () => {
      toggle.click();
    });
    assert($("dz-archive") !== null, "action appears only after the explicit reveal");
    const region = $("dz-actions")!;
    assert(region !== null, "actions live in their own separated region");
    assert(region.contains($("dz-archive")!), "action is inside the danger region, not adjacent to routine controls");
    assert(region.getAttribute("role") === "group", "actions region is an ARIA group");
    assert($("dz-toggle")!.getAttribute("aria-expanded") === "true", "toggle reports expanded state");

    await act(async () => {
      $("dz-toggle")!.click();
    });
    assert($("dz-archive") === null, "re-collapsing removes the action again");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ collapsed by default; explicit reveal; actions confined to the region");

  root = await render(
    <DangerZone testId="dz-open" collapsible={false} title="Decommission">
      <button data-testid="dz-open-delete">Delete forever</button>
    </DangerZone>,
  );
  try {
    assert($("dz-open-delete") !== null, "non-collapsible zone renders actions immediately");
    assert($("dz-open-toggle") === null, "non-collapsible zone has no toggle");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ collapsible=false renders open without a toggle");
}

// ═══ 6) Card accent variant ═════════════════════════════════════════════
console.log("\n— Card: sanctioned side-accent variant —");
{
  const root = await render(
    <div>
      <Card data-testid="card-plain">plain</Card>
      <Card data-testid="card-accented" accent="warn">accented</Card>
      <Card data-testid="card-primary" accent="primary">brand</Card>
    </div>,
  );
  try {
    const plain = $("card-plain")!;
    assert(!plain.hasAttribute("data-accent"), "no accent → no data-accent attribute");
    assert(!plain.className.includes("border-l-"), "no accent → no left-stripe classes (existing Cards untouched)");

    const warn = $("card-accented")!;
    assert(warn.getAttribute("data-accent") === "warn", "accent exposed as data-accent");
    assert(warn.className.includes("border-l-[3px]"), "accent widens only the left border (the sanctioned stripe)");
    assert(warn.className.includes("border-l-status-warn"), "accent color comes from the status token");

    const brand = $("card-primary")!;
    assert(brand.className.includes("border-l-primary"), "primary accent uses the brand token");
  } finally {
    await unmount(root);
  }
  console.log("  ✓ accent renders tokenized left stripe; plain Cards unchanged");
}

// ═══ 7) BrandMark — canonical brand artwork (Task #4618) ════════════════
console.log("\n— BrandMark: asset map integrity + theme swap contract —");
{
  // The asset map must point at files that exist: the pre-#4618 Clerk config
  // referenced /logo.svg, which was never served — the brand silently
  // vanished. Every mapped path must resolve under client/public.
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const publicDir = fileURLToPath(
    new URL("../../client/public", import.meta.url),
  );
  const kinds = Object.keys(BRAND_ASSET_PATHS).sort();
  assert(
    kinds.join(",") === "icon,logo",
    "BRAND_ASSET_PATHS exposes exactly logo + icon kinds",
  );
  assert(
    Object.keys(BRAND_ASSET_PATHS.logo).length === 3 &&
      Object.keys(BRAND_ASSET_PATHS.icon).length === 4,
    "3 logo variants (full-color/black/white) + 4 icon variants (crimson/black/white/earth)",
  );
  for (const kind of ["logo", "icon"] as const) {
    for (const [variant, relPath] of Object.entries(BRAND_ASSET_PATHS[kind])) {
      assert(
        typeof relPath === "string" && relPath.startsWith("/brand/"),
        `${kind}/${variant} lives in the OS-owned /brand/ namespace (got ${relPath})`,
      );
      assert(
        existsSync(`${publicDir}${relPath}`),
        `${kind}/${variant} maps to a file that exists: client/public${relPath}`,
      );
    }
  }

  const root = await render(
    <div>
      <BrandMark kind="icon" variant="earth" testId="bm-single" />
      <BrandMark
        kind="icon"
        variant="black"
        darkVariant="white"
        className="h-5 w-auto"
        testId="bm-dual"
      />
      <BrandMark
        kind="logo"
        variant="full-color"
        alt="NoBull Marketing"
        width={56}
        testId="bm-named"
      />
    </div>,
  );
  try {
    const single = $("bm-single") as HTMLImageElement;
    assert(single !== null, "single-variant mark renders");
    assert(
      single.getAttribute("src") === BRAND_ASSET_PATHS.icon.earth,
      "src comes from the asset map",
    );
    assert(
      single.getAttribute("alt") === "" &&
        single.getAttribute("aria-hidden") === "true",
      "default is decorative: empty alt + aria-hidden",
    );
    assert($("bm-single-dark") === null, "no darkVariant → no dark twin");

    const light = $("bm-dual") as HTMLImageElement;
    const dark = $("bm-dual-dark") as HTMLImageElement;
    assert(light !== null && dark !== null, "darkVariant renders both twins");
    assert(
      light.getAttribute("src") === BRAND_ASSET_PATHS.icon.black &&
        dark.getAttribute("src") === BRAND_ASSET_PATHS.icon.white,
      "twin srcs follow variant/darkVariant",
    );
    assert(
      light.className.includes("dark:hidden") &&
        !light.className.includes("hidden dark:block"),
      "light twin hides in dark mode",
    );
    assert(
      dark.className.includes("hidden") &&
        dark.className.includes("dark:block"),
      "dark twin shows only in dark mode",
    );
    assert(
      light.className.includes("h-5") && dark.className.includes("h-5"),
      "className reaches both twins",
    );

    const named = $("bm-named") as HTMLImageElement;
    assert(
      named.getAttribute("alt") === "NoBull Marketing" &&
        named.getAttribute("aria-hidden") === null,
      "non-empty alt → accessible, not aria-hidden",
    );
    assert(
      named.getAttribute("width") === "56",
      "width attr stamps through (CSS-less crash surfaces)",
    );
  } finally {
    await unmount(root);
  }
  console.log("  ✓ asset map complete + on-disk; theme swap + aria contracts hold");
}

console.log(
  "\nstatus-state-kit: all seven primitives hold their core contracts (delta semantics, tone tokens, educational slots, degraded anatomy, danger separation, card accent, brand artwork).",
);
