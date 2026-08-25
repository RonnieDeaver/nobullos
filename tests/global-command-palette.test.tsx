/* test-registration
{
  "name": "Global ⌘K command palette — role-gated destinations derive from QUICKLINKS_MANIFEST (CEO sees system tools, AM tier does not); Cmd/Ctrl+K opens/toggles from the body but never from editable targets; /ads-os and /comms keep their module shortcut; keyboard Enter navigates and closes; client search caps, jumps, and surfaces load errors (Task #4376); Actions group derives from manifest-declared paletteActions/paletteClientActions with role gating, and side-effecting verbs require an explicit Confirm step before firing (Task #4494)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4376 (audit §8.4-a/§3.7): the app-wide ⌘K palette is the app shell's primary power-user navigation. If role gating drifted from QUICKLINKS_MANIFEST the palette would leak admin destinations to non-admins; if shortcut ownership broke, /ads-os and /comms would lose their module ⌘K behaviors. Rendered jsdom test mounting the real GlobalCommandPalette + dialog with REAL cmdk and the real manifest; DB-free, network-free (react-query fed by an injected queryFn).",
  "extraNodeArgs": [
    "--import",
    "./tests/global-command-palette-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered + pure coverage for the app-wide ⌘K command palette (Task #4376).
 *
 * Pure layer:
 *   - buildQuicklinkContext role/authority/function derivation;
 *   - real-manifest gating (CEO superset, AM-tier sees no system tools);
 *   - buildPaletteGroups taxonomy (Navigate/Create + the five function-based
 *     QUICKLINK_TOOL_GROUPS sections, Task #4763; Dashboard synthetic entry);
 *   - globalPaletteOwnsShortcut route ownership (defers on /ads-os + /comms
 *     subtrees, exact prefix boundaries);
 *   - isEditableShortcutTarget.
 *
 * Rendered layer (real cmdk, shimmed Radix dialog, controllable wouter
 * Router hook):
 *   - Ctrl+K on the body opens the palette; Enter on the auto-selected first
 *     item navigates via wouter and closes the palette;
 *   - Ctrl+K originating in a textarea is ignored while closed;
 *   - Ctrl+K with pathname /ads-os does NOT open the global palette;
 *   - unmount removes the window listener;
 *   - client search: matches render (capped at 12) once the user types, and
 *     a failing client query surfaces the explicit error notice.
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/global-command-palette-setup.mjs.
 */

// JSDOM + browser globals are installed by tests/global-command-palette-setup.mjs
// (passed via --import), which runs BEFORE these static imports evaluate.
// react-dom's synthetic event system requires the DOM globals at module-eval
// time — this test drives real cmdk keyboard selection and controlled-input
// onChange, both of which silently no-op if the globals land later
// (see .agents/memory/jsdom-globals-before-react-dom-eval.md).
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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

/** Dispatch a keydown that bubbles from `target` up to window. */
function pressKey(
  target: EventTarget,
  key: string,
  opts: { ctrl?: boolean; meta?: boolean } = {},
): KeyboardEvent {
  const ev = new (window as any).KeyboardEvent("keydown", {
    key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev as unknown as KeyboardEvent;
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** Poll until `pred` returns truthy (lazy chunk + react-query settle). */
async function waitFor(pred: () => boolean, label: string, tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await flush();
  }
  console.error(`  (waitFor timed out: ${label})`);
  return false;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

async function main(): Promise<void> {
  const { QUICKLINKS_MANIFEST } = await import("@/components/QuicklinksBar");
  const {
    buildQuicklinkContext,
    buildPaletteGroups,
    globalPaletteOwnsShortcut,
    isEditableShortcutTarget,
  } = await import("@/components/globalPaletteCore");
  const { GlobalCommandPalette } = await import("@/components/GlobalCommandPalette");
  const GlobalCommandPaletteDialog = (await import("@/components/GlobalCommandPaletteDialog")).default;
  const { Router } = await import("wouter");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

  // ---------------------------------------------------------------------
  section("buildQuicklinkContext — role/authority/function derivation");
  // ---------------------------------------------------------------------
  const ceoCtx = buildQuicklinkContext({ role: "ceo" });
  assert(
    ceoCtx.isCeo && ceoCtx.isTeamLead && ceoCtx.canRis && ceoCtx.isDirector && ceoCtx.isAccountManager,
    "role=ceo unlocks every predicate",
  );
  const amCtx = buildQuicklinkContext({ role: "account_manager" });
  assert(
    !amCtx.isCeo && !amCtx.isTeamLead && !amCtx.canRis && !amCtx.isDirector && amCtx.isAccountManager,
    "role=account_manager is AM-only (no lead/ceo/ris/director)",
  );
  const plainCtx = buildQuicklinkContext({ role: "user" });
  assert(
    !plainCtx.isCeo && !plainCtx.isTeamLead && !plainCtx.canRis && !plainCtx.isDirector && !plainCtx.isAccountManager,
    "role=user unlocks nothing",
  );
  assert(
    buildQuicklinkContext({ role: "user", functions: ["reporting_expert"] }).canRis,
    "reporting_expert function grants canRis",
  );
  const directorAuthCtx = buildQuicklinkContext({ role: "user", authorityLevel: "director" });
  assert(
    directorAuthCtx.isDirector && directorAuthCtx.canRis && !directorAuthCtx.isTeamLead,
    "authorityLevel=director grants isDirector + canRis without team-lead",
  );
  assert(
    buildQuicklinkContext({}).isCeo === false && buildQuicklinkContext({}).isAccountManager === false,
    "empty user shape is fully locked down",
  );

  // ---------------------------------------------------------------------
  section("Real-manifest role gating (destinations derive from QUICKLINKS_MANIFEST)");
  // ---------------------------------------------------------------------
  const visibleFor = (ctx: ReturnType<typeof buildQuicklinkContext>) =>
    QUICKLINKS_MANIFEST.filter((i) => i.isVisible(ctx));
  const ceoItems = visibleFor(ceoCtx);
  const amItems = visibleFor(amCtx);
  const ceoIds = new Set(ceoItems.map((i) => i.id));
  const amIds = new Set(amItems.map((i) => i.id));
  assert(ceoItems.length === QUICKLINKS_MANIFEST.length, "CEO sees the full manifest");
  const adminOnly = ["user-management", "integrations", "webhook-logs", "system-health", "mcu-dashboard", "ats", "ceo-pulse", "manage-clients"];
  assert(adminOnly.every((id) => ceoIds.has(id)), "CEO list includes admin/system destinations");
  assert(adminOnly.every((id) => !amIds.has(id)), "AM list excludes ALL admin/system destinations");
  // Task #4977 — Ads OS reads opened to all staff: the nav/palette entry is
  // AM-tier now, matching the requireAccountManager route gate.
  assert(["all-reports", "comms", "campaigns", "add-client", "ads-os-v2"].every((id) => amIds.has(id)), "AM keeps universal + AM-gated destinations (incl. Ads OS, Task #4977)");

  const ceoGroups = buildPaletteGroups(ceoItems);
  const amGroups = buildPaletteGroups(amItems);
  assert(
    JSON.stringify(ceoGroups.map((g) => g.heading)) ===
      JSON.stringify(["Navigate", "Create", "CRM", "Client Management", "Workspace", "Team", "System Admin"]),
    "CEO groups: Navigate/Create then the five function-based tool groups in QUICKLINK_TOOL_GROUPS order (Task #4763)",
  );
  assert(
    JSON.stringify(ceoGroups[0].destinations.map((d) => d.id)) ===
      JSON.stringify(["dashboard", "all-reports", "comms"]),
    "Navigate keeps exactly Dashboard + the inline primary set (All Reports, Comms)",
  );
  assert(
    JSON.stringify(amGroups.map((g) => g.heading)) ===
      JSON.stringify(["Navigate", "Create", "CRM", "Client Management", "Workspace", "Team"]),
    "AM has no System Admin group; Client Management survives via the AM-tier Ads OS entry (Task #4977); empty groups drop out",
  );
  assert(
    ceoGroups[0].destinations[0].id === "dashboard" && ceoGroups[0].destinations[0].href === "/",
    "Dashboard is the synthetic first Navigate entry",
  );
  const groupedIds = ceoGroups.flatMap((g) => g.destinations.map((d) => d.id));
  assert(
    groupedIds.length === ceoItems.length + 1 && new Set(groupedIds).size === groupedIds.length,
    "grouping preserves every visible item exactly once (plus Dashboard)",
  );

  // ---------------------------------------------------------------------
  section("Palette actions derive from the manifest (Task #4494, pure)");
  // ---------------------------------------------------------------------
  const { collectPaletteActions, collectPaletteClientActions } = await import(
    "@/components/globalPaletteCore"
  );
  const ceoActions = collectPaletteActions(ceoItems);
  const amActions = collectPaletteActions(amItems);
  assert(
    ceoActions.some((a) => a.id === "google-ads-sync-now"),
    "CEO items yield the Google Ads sync action (declared on the integrations item)",
  );
  assert(
    !amActions.some((a) => a.id === "google-ads-sync-now"),
    "AM items yield NO Google Ads sync action (gating derives from the owning item)",
  );
  const syncAction = ceoActions.find((a) => a.id === "google-ads-sync-now")!;
  assert(
    typeof syncAction.confirm === "string" && syncAction.confirm.length > 0,
    "side-effecting sync verb declares an explicit confirm prompt",
  );
  const ceoClientActions = collectPaletteClientActions(ceoItems);
  const amClientActions = collectPaletteClientActions(amItems);
  for (const [who, acts] of [["CEO", ceoClientActions], ["AM", amClientActions]] as const) {
    assert(
      acts.some((t) => t.id === "new-report-for-client") &&
        acts.some((t) => t.id === "open-latest-report"),
      `${who} gets both client-scoped report actions (owners are universally visible)`,
    );
  }
  const fixtureClient = { id: "cl-1", firmName: "Acme Law" };
  {
    const navs: string[] = [];
    const toasts: any[] = [];
    const deps = { navigate: (h: string) => navs.push(h), toast: (o: any) => toasts.push(o) };
    const newReportTpl = ceoClientActions.find((t) => t.id === "new-report-for-client")!;
    assert(
      newReportTpl.label(fixtureClient) === "New report for Acme Law",
      "new-report label carries the firm name",
    );
    await newReportTpl.run(fixtureClient, deps);
    assert(
      navs[0] === "/reports/new?clientId=cl-1" && toasts.length === 0,
      "new-report-for-client navigates to the preselected report form",
    );
  }
  {
    // open-latest-report — success, empty, and HTTP-failure lanes via a fetch stub.
    const latestTpl = ceoClientActions.find((t) => t.id === "open-latest-report")!;
    const realFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    let fetchImpl: () => any = () => ({ ok: true, json: async () => [{ id: "rep-9" }, { id: "rep-8" }] });
    (globalThis as any).fetch = async (url: any) => {
      fetchCalls.push(String(url));
      return fetchImpl();
    };
    try {
      const navs: string[] = [];
      const toasts: any[] = [];
      const deps = { navigate: (h: string) => navs.push(h), toast: (o: any) => toasts.push(o) };
      await latestTpl.run(fixtureClient, deps);
      assert(
        fetchCalls[0] === "/api/clients/cl-1/reports" && navs[0] === "/reports/rep-9",
        "open-latest-report fetches the client's reports and opens the newest (first row)",
      );
      fetchImpl = () => ({ ok: true, json: async () => [] });
      await latestTpl.run(fixtureClient, deps);
      assert(
        navs.length === 1 && toasts.some((t) => String(t.title).includes("No reports yet")),
        "empty report list toasts 'No reports yet' and does not navigate",
      );
      fetchImpl = () => ({ ok: false, status: 503, json: async () => ({}) });
      await latestTpl.run(fixtureClient, deps);
      assert(
        toasts.some((t) => t.variant === "destructive") && navs.length === 1,
        "failed reports fetch surfaces a destructive toast (never silent)",
      );
      // Google Ads sync run — success + failure lanes through the same stub.
      const syncToasts: any[] = [];
      const syncDeps = { navigate: () => {}, toast: (o: any) => syncToasts.push(o) };
      fetchImpl = () => ({ ok: true, json: async () => ({ customersSynced: 3 }) });
      fetchCalls.length = 0;
      await syncAction.run(syncDeps);
      assert(
        fetchCalls[0] === "/api/integrations/google-ads/sync-now" &&
          syncToasts.some((t) => String(t.title).includes("finished")),
        "sync action POSTs sync-now and toasts the summary",
      );
      fetchImpl = () => ({ ok: false, status: 503, json: async () => ({ error: "rotate secrets" }) });
      await syncAction.run(syncDeps);
      assert(
        syncToasts.some((t) => t.variant === "destructive" && t.description === "rotate secrets"),
        "failed sync surfaces the server error in a destructive toast",
      );
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  }

  // ---------------------------------------------------------------------
  section("Shortcut ownership + editable-target guards (pure)");
  // ---------------------------------------------------------------------
  assert(globalPaletteOwnsShortcut("/"), "global owns ⌘K on /");
  assert(globalPaletteOwnsShortcut("/reports/matrix"), "global owns ⌘K on /reports/matrix");
  assert(!globalPaletteOwnsShortcut("/ads-os"), "defers to module palette on /ads-os");
  assert(!globalPaletteOwnsShortcut("/ads-os/gads"), "defers on /ads-os subtree");
  assert(!globalPaletteOwnsShortcut("/comms"), "defers to channel search on /comms");
  assert(!globalPaletteOwnsShortcut("/comms/channel/x"), "defers on /comms subtree");
  assert(globalPaletteOwnsShortcut("/ads-osteopathy"), "prefix boundary: /ads-osteopathy is NOT the module");
  assert(globalPaletteOwnsShortcut("/commsy"), "prefix boundary: /commsy is NOT comms");

  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  const editableDiv = document.createElement("div");
  document.body.appendChild(editableDiv);
  editableDiv.setAttribute("contenteditable", "true");
  // jsdom never implements isContentEditable (always undefined), so pin the
  // reflected value the way a browser would report it for this element.
  Object.defineProperty(editableDiv, "isContentEditable", { value: true });
  assert(isEditableShortcutTarget(input), "input is editable target");
  assert(isEditableShortcutTarget(textarea), "textarea is editable target");
  assert(isEditableShortcutTarget(editableDiv), "contenteditable div is editable target");
  assert(!isEditableShortcutTarget(document.body), "body is not editable target");
  assert(!isEditableShortcutTarget(null), "null target tolerated");
  editableDiv.remove();

  // ---------------------------------------------------------------------
  section("Rendered shell — Ctrl+K open/ignore/toggle + Enter navigates");
  // ---------------------------------------------------------------------
  // Controllable wouter hook: the test drives pathname and observes navigations.
  let currentPath = "/";
  const pathListeners = new Set<() => void>();
  const navigate = (to: string) => {
    currentPath = to;
    pathListeners.forEach((l) => l());
  };
  function useTestLocation(): [string, (to: string) => void] {
    const [path, setPath] = React.useState(currentPath);
    React.useEffect(() => {
      const l = () => setPath(currentPath);
      pathListeners.add(l);
      return () => {
        pathListeners.delete(l);
      };
    }, []);
    return [path, navigate];
  }

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async () =>
          Array.from({ length: 20 }, (_, i) => ({
            id: `fixture-${i + 1}`,
            firmName: `Fixture Firm ${String(i + 1).padStart(2, "0")}`,
            clientCode: `FX${i + 1}`,
          })),
      },
    },
  });

  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Router,
          { hook: useTestLocation },
          React.createElement(GlobalCommandPalette, { items: ceoItems }),
        ),
      ),
    );
  });

  assert(!!q('[data-testid="button-global-palette"]'), "nav affordance renders");
  assert(!q('[data-testid="global-command-palette"]'), "palette closed initially");

  // Ctrl+K on the body opens (lazy dialog chunk settles via polling).
  await act(async () => {
    pressKey(document.body, "k", { ctrl: true });
  });
  const opened = await waitFor(
    () => !!q('[data-testid="input-global-palette-search"]'),
    "palette input after Ctrl+K",
  );
  assert(opened, "Ctrl+K on body opens the palette");
  assert(
    qa("[data-testid^='palette-dest-']").length === ceoItems.length + 1,
    "all role-visible destinations render (manifest + Dashboard)",
  );

  // Enter selects the auto-highlighted first item (Dashboard → "/") — but we
  // are already at "/", so pick a distinct target: ArrowDown once to
  // All Reports, then Enter.
  const searchInput = q('[data-testid="input-global-palette-search"]')!;
  await act(async () => {
    pressKey(searchInput, "ArrowDown");
  });
  await act(async () => {
    pressKey(searchInput, "Enter");
  });
  await flush();
  assert(currentPath === "/reports/matrix", `keyboard Enter navigates (got ${currentPath})`);
  const closedAfterNav = await waitFor(
    () => !q('[data-testid="global-command-palette"]'),
    "palette closes after navigation",
  );
  assert(closedAfterNav, "palette closes after keyboard navigation");

  // Ctrl+K from a textarea is ignored while closed.
  const composer = document.createElement("textarea");
  document.body.appendChild(composer);
  const evEditable = pressKey(composer, "k", { ctrl: true });
  await flush();
  assert(!q('[data-testid="global-command-palette"]'), "Ctrl+K from textarea does not open");
  assert(!evEditable.defaultPrevented, "editable-target press is not preventDefault'ed");
  composer.remove();

  // On /ads-os the global palette must not contest the shortcut.
  await act(async () => {
    navigate("/ads-os");
  });
  const evAds = pressKey(document.body, "k", { ctrl: true });
  await flush();
  assert(!q('[data-testid="global-command-palette"]'), "Ctrl+K on /ads-os leaves global palette closed");
  assert(!evAds.defaultPrevented, "global palette does not preventDefault on /ads-os (module palette owns it)");

  // Back on an owned route, meta (⌘) works like ctrl.
  await act(async () => {
    navigate("/deals");
  });
  await act(async () => {
    pressKey(document.body, "k", { meta: true });
  });
  const reopened = await waitFor(
    () => !!q('[data-testid="input-global-palette-search"]'),
    "palette reopens via ⌘K",
  );
  assert(reopened, "⌘K (metaKey) reopens the palette on owned routes");
  // Toggle closed with the shortcut even though focus is in the palette input.
  await act(async () => {
    pressKey(q('[data-testid="input-global-palette-search"]')!, "k", { ctrl: true });
  });
  const toggledClosed = await waitFor(
    () => !q('[data-testid="global-command-palette"]'),
    "palette toggles closed",
  );
  assert(toggledClosed, "Ctrl+K toggles the open palette closed (even from its own input)");

  // Unmount removes the window listener: no dialog after unmount + press.
  await act(async () => {
    root!.unmount();
  });
  pressKey(document.body, "k", { ctrl: true });
  await flush();
  assert(!q('[data-testid="global-command-palette"]'), "no palette after unmount (listener removed)");

  // ---------------------------------------------------------------------
  section("Dialog — client search (success cap + explicit error notice)");
  // ---------------------------------------------------------------------
  // Mount the dialog directly (open, controlled) with the fixture queryFn.
  let dialogOpen = true;
  const setDialogOpen = (v: boolean) => {
    dialogOpen = v;
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Router,
          { hook: useTestLocation },
          React.createElement(GlobalCommandPaletteDialog, {
            open: true,
            onOpenChange: setDialogOpen,
            items: amItems,
          }),
        ),
      ),
    );
  });
  const dialogReady = await waitFor(
    () => !!q('[data-testid="input-global-palette-search"]'),
    "directly mounted dialog input",
  );
  assert(dialogReady, "dialog mounts open (direct mount)");
  assert(!qa("[data-testid^='palette-client-']").length, "no client rows before typing");

  // Type into the controlled cmdk input via the native value setter.
  const dialogInput = q('[data-testid="input-global-palette-search"]') as HTMLInputElement;
  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      (window as any).HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  };
  await act(async () => {
    setValue(dialogInput, "fixture");
  });
  const clientsShown = await waitFor(
    () => qa("[data-testid^='palette-client-']").length > 0,
    "client rows after typing",
  );
  assert(clientsShown, "typing a query surfaces client matches");
  assert(
    qa("[data-testid^='palette-client-']").length === 12,
    `client matches cap at 12 (got ${qa("[data-testid^='palette-client-']").length})`,
  );
  assert(!q('[data-testid="text-palette-clients-error"]'), "no error notice on success");

  // Selecting a client navigates to its panel and closes the dialog.
  const firstClient = qa("[data-testid^='palette-client-']")[0];
  if (firstClient) {
    await act(async () => {
      firstClient.dispatchEvent(new (window as any).MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert(
      currentPath.startsWith("/clients/fixture-"),
      `selecting a client jumps to its panel (got ${currentPath})`,
    );
    assert(dialogOpen === false, "selecting a client closes the dialog");
  } else {
    failed += 2;
    console.error("  ✗ selecting a client jumps to its panel (no client rows rendered)");
    console.error("  ✗ selecting a client closes the dialog (no client rows rendered)");
  }
  await act(async () => {
    root!.unmount();
  });

  // Error lane: failing clients query surfaces the explicit notice.
  const failingClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async () => {
          throw new Error("clients unavailable");
        },
      },
    },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: failingClient },
        React.createElement(
          Router,
          { hook: useTestLocation },
          React.createElement(GlobalCommandPaletteDialog, {
            open: true,
            onOpenChange: () => {},
            items: amItems,
          }),
        ),
      ),
    );
  });
  await waitFor(() => !!q('[data-testid="input-global-palette-search"]'), "error-lane dialog input");
  await act(async () => {
    setValue(q('[data-testid="input-global-palette-search"]') as HTMLInputElement, "fixture");
  });
  const errorShown = await waitFor(
    () => !!q('[data-testid="text-palette-clients-error"]'),
    "explicit client-load error notice",
  );
  assert(errorShown, "failing clients query renders the explicit error notice (never silent)");
  assert(!qa("[data-testid^='palette-client-']").length, "no client rows on error");
  await act(async () => {
    root!.unmount();
  });

  // ---------------------------------------------------------------------
  section("Dialog — Actions group + explicit Confirm step (Task #4494)");
  // ---------------------------------------------------------------------
  let actionsDialogOpen = true;
  const realFetch2 = globalThis.fetch;
  const actionFetchCalls: Array<{ url: string; method?: string }> = [];
  (globalThis as any).fetch = async (url: any, init?: any) => {
    actionFetchCalls.push({ url: String(url), method: init?.method });
    return { ok: true, json: async () => ({ customersSynced: 1 }) } as any;
  };
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            Router,
            { hook: useTestLocation },
            React.createElement(GlobalCommandPaletteDialog, {
              open: true,
              onOpenChange: (v: boolean) => {
                actionsDialogOpen = v;
              },
              items: ceoItems,
            }),
          ),
        ),
      );
    });
    await waitFor(() => !!q('[data-testid="input-global-palette-search"]'), "actions dialog input");
    const syncItem = await waitFor(
      () => !!q('[data-testid="palette-action-google-ads-sync-now"]'),
      "sync action row",
    );
    assert(syncItem, "Actions group renders the CEO-gated Google Ads sync action");

    // Selecting the confirm-gated action arms the Confirm step — nothing fires.
    await act(async () => {
      q('[data-testid="palette-action-google-ads-sync-now"]')!.dispatchEvent(
        new (window as any).MouseEvent("click", { bubbles: true }),
      );
    });
    const confirmShown = await waitFor(
      () => !!q('[data-testid="palette-action-confirm"]'),
      "confirm row",
    );
    assert(confirmShown, "selecting the sync action shows the explicit Confirm step");
    assert(!!q('[data-testid="palette-action-cancel"]'), "Cancel row renders beside Confirm");
    assert(actionFetchCalls.length === 0, "no request fires before Confirm");
    assert(
      !q("[data-testid^='palette-dest-']"),
      "confirm mode hides destinations so Enter can only Confirm/Cancel",
    );

    // Cancel returns to the normal list without firing.
    await act(async () => {
      q('[data-testid="palette-action-cancel"]')!.dispatchEvent(
        new (window as any).MouseEvent("click", { bubbles: true }),
      );
    });
    const backToList = await waitFor(
      () => !!q('[data-testid="palette-action-google-ads-sync-now"]'),
      "list after cancel",
    );
    assert(backToList && actionFetchCalls.length === 0, "Cancel restores the list; still no request");

    // Arm again and Confirm — the POST fires and the dialog closes.
    await act(async () => {
      q('[data-testid="palette-action-google-ads-sync-now"]')!.dispatchEvent(
        new (window as any).MouseEvent("click", { bubbles: true }),
      );
    });
    await waitFor(() => !!q('[data-testid="palette-action-confirm"]'), "confirm row (2nd)");
    await act(async () => {
      q('[data-testid="palette-action-confirm"]')!.dispatchEvent(
        new (window as any).MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    assert(
      actionFetchCalls.some(
        (c) => c.url === "/api/integrations/google-ads/sync-now" && c.method === "POST",
      ),
      "Confirm fires exactly the sync-now POST",
    );
    assert(actionsDialogOpen === false, "dialog closes when the confirmed action runs");
    await act(async () => {
      root!.unmount();
    });

    // Client-scoped action: typing a client surfaces "New report for <firm>"
    // against the TOP match; selecting navigates to the preselected form.
    await act(async () => {
      root = createRoot(container);
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            Router,
            { hook: useTestLocation },
            React.createElement(GlobalCommandPaletteDialog, {
              open: true,
              onOpenChange: () => {},
              items: ceoItems,
            }),
          ),
        ),
      );
    });
    await waitFor(() => !!q('[data-testid="input-global-palette-search"]'), "client-action dialog");
    await act(async () => {
      setValue(
        q('[data-testid="input-global-palette-search"]') as HTMLInputElement,
        "Fixture Firm 03",
      );
    });
    const clientActionShown = await waitFor(
      () => !!q('[data-testid="palette-action-client-new-report-for-client"]'),
      "client action row",
    );
    assert(clientActionShown, "typing a client surfaces the New-report client action");
    const actionRow = q('[data-testid="palette-action-client-new-report-for-client"]');
    assert(
      (actionRow?.textContent ?? "").includes("Fixture Firm 03"),
      "client action label names the top matching firm",
    );
    await act(async () => {
      actionRow!.dispatchEvent(new (window as any).MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert(
      currentPath === "/reports/new?clientId=fixture-3",
      `client action navigates to the preselected report form (got ${currentPath})`,
    );
    await act(async () => {
      root!.unmount();
    });
  } finally {
    (globalThis as any).fetch = realFetch2;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
