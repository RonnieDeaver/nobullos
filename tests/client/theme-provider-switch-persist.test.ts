/* test-registration
{
  "name": "Global theme provider — .dark class application, system matchMedia follow, per-user persistence PUT + localStorage cache (Task #4377)",
  "regression": true,
  "sweepOnlyReason": "Task #4377 — pure client presentation infrastructure: jsdom-rendered ThemeProvider with stubbed auth + request layer, no DB and no server. A theme regression cannot corrupt data or block operator workflows, so it rides the nightly sweep rather than the smoke gate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/theme-provider-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/lib/theme.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Rendered jsdom coverage for the global ThemeProvider (Task #4377 —
 * app-wide dark mode capstone; client/src/lib/theme.tsx):
 *
 *   1. boot: a cached "dark" preference (localStorage "nobull-theme") puts
 *      `.dark` on <html> at mount — the runtime mirror of the no-flash
 *      pre-paint script in client/index.html;
 *   2. setPreference: applies the class immediately, rewrites the
 *      localStorage cache, PUTs /api/users/me/theme for signed-in users and
 *      invalidates the auth query;
 *   3. "system": resolves via matchMedia(prefers-color-scheme: dark) and
 *      follows live OS changes through the change listener;
 *   4. server adoption: the authed user's stored themePreference wins over
 *      a stale local cache once /api/auth/user data arrives;
 *   5. signed-out: the theme still applies locally but nothing is PUT.
 *
 * DB-free, network-free (use-auth + apiRequest stubbed via
 * tests/client/theme-provider-setup.mjs). JSX-free so the file stays
 * classic-transform-safe; components are built with React.createElement.
 */

import { JSDOM } from "jsdom";
import { installJsdomGlobals } from "../helpers/installJsdomGlobals";

// ── jsdom + controllable matchMedia (installed BEFORE react-dom loads) ──────

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

// Controllable prefers-color-scheme stub. Installed before
// installJsdomGlobals so its fallback (`w.matchMedia = w.matchMedia || …`)
// keeps ours.
const mmState = {
  dark: false,
  listeners: new Set<(ev: { matches: boolean }) => void>(),
};
(dom.window as any).matchMedia = (query: string) => {
  const isDarkQuery = query.includes("prefers-color-scheme: dark");
  return {
    get matches() {
      return isDarkQuery ? mmState.dark : false;
    },
    media: query,
    onchange: null,
    addEventListener(type: string, cb: (ev: { matches: boolean }) => void) {
      if (type === "change") mmState.listeners.add(cb);
    },
    removeEventListener(_type: string, cb: (ev: { matches: boolean }) => void) {
      mmState.listeners.delete(cb);
    },
    addListener(cb: (ev: { matches: boolean }) => void) {
      mmState.listeners.add(cb);
    },
    removeListener(cb: (ev: { matches: boolean }) => void) {
      mmState.listeners.delete(cb);
    },
    dispatchEvent() {
      return false;
    },
  };
};

installJsdomGlobals(dom);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── suite state ──────────────────────────────────────────────────────────────

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

type Recorded = { method: string; url: string; data: unknown };

function recordedRequests(): Recorded[] {
  return ((globalThis as any).__THEME_TEST_REQUESTS ?? []) as Recorded[];
}

async function flushAsync(): Promise<void> {
  // Let the apiRequest .then/.finally chain and any queued state updates run.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function main(): Promise<void> {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const themeModule = await import("../../client/src/lib/theme");
  const { ThemeProvider, useTheme, THEME_STORAGE_KEY } = themeModule;
  type ThemeApi = ReturnType<typeof useTheme>;

  const html = dom.window.document.documentElement;
  const rootEl = dom.window.document.getElementById("root")!;

  let themeApi: ThemeApi | null = null;
  function CaptureTheme(): null {
    themeApi = useTheme();
    return null;
  }

  let root: ReturnType<typeof createRoot> | null = null;
  let invalidated: unknown[] = [];

  async function mount(): Promise<void> {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidated = [];
    const origInvalidate = qc.invalidateQueries.bind(qc);
    (qc as any).invalidateQueries = (filters: any, ...rest: any[]) => {
      invalidated.push(filters?.queryKey);
      return origInvalidate(filters, ...rest);
    };
    root = createRoot(rootEl);
    await act(async () => {
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(ThemeProvider, null, React.createElement(CaptureTheme)),
        ),
      );
    });
  }

  async function unmount(): Promise<void> {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    themeApi = null;
    html.classList.remove("dark");
    dom.window.localStorage.clear();
    (globalThis as any).__THEME_TEST_REQUESTS = [];
    (globalThis as any).__THEME_TEST_AUTH = undefined;
    mmState.dark = false;
    mmState.listeners.clear();
  }

  // ── 1. boot from cached preference ─────────────────────────────────────────
  section("boot: cached 'dark' preference applies .dark at mount");
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
  await mount();
  assert(html.classList.contains("dark"), "<html> has .dark after mount");
  assert(themeApi?.preference === "dark", "preference reports 'dark'");
  assert(themeApi?.resolved === "dark", "resolved reports 'dark'");
  assert(recordedRequests().length === 0, "no persistence call on boot");
  await unmount();

  // ── 2. setPreference: apply + cache + PUT + invalidate ─────────────────────
  section("setPreference('dark') while signed in: class + cache + PUT + invalidate");
  (globalThis as any).__THEME_TEST_AUTH = {
    user: { id: "u-theme-1", themePreference: "light" },
    isLoading: false,
    isAuthenticated: true,
  };
  await mount();
  assert(!html.classList.contains("dark"), "starts light (server preference 'light')");
  await act(async () => {
    themeApi!.setPreference("dark");
  });
  await act(flushAsync);
  assert(html.classList.contains("dark"), ".dark applied immediately");
  assert(
    dom.window.localStorage.getItem(THEME_STORAGE_KEY) === "dark",
    "localStorage cache rewritten to 'dark'",
  );
  {
    const puts = recordedRequests();
    assert(puts.length === 1, `exactly one persistence request (got ${puts.length})`);
    assert(puts[0]?.method === "PUT", "persistence request is a PUT");
    assert(puts[0]?.url === "/api/users/me/theme", "PUT targets /api/users/me/theme");
    assert(
      JSON.stringify(puts[0]?.data) === JSON.stringify({ theme: "dark" }),
      "PUT body is { theme: 'dark' }",
    );
    assert(
      invalidated.some((k) => JSON.stringify(k) === JSON.stringify(["/api/auth/user"])),
      "auth query invalidated after the PUT resolves",
    );
  }
  await unmount();

  // ── 3. system preference follows matchMedia live ───────────────────────────
  section("'system' resolves via matchMedia and follows change events");
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, "system");
  mmState.dark = false;
  await mount();
  assert(!html.classList.contains("dark"), "system + light OS = no .dark");
  assert(themeApi?.preference === "system", "preference reports 'system'");
  assert(themeApi?.resolved === "light", "resolved reports 'light'");
  assert(mmState.listeners.size > 0, "a change listener is attached while on 'system'");
  await act(async () => {
    mmState.dark = true;
    for (const cb of [...mmState.listeners]) cb({ matches: true });
  });
  assert(html.classList.contains("dark"), "OS flip to dark applies .dark live");
  assert(themeApi?.resolved === "dark", "resolved follows the OS to 'dark'");
  await act(async () => {
    themeApi!.setPreference("light");
  });
  await act(flushAsync);
  assert(
    mmState.listeners.size === 0,
    "matchMedia listener removed after leaving 'system'",
  );
  assert(!html.classList.contains("dark"), "explicit 'light' overrides the dark OS");
  await unmount();

  // ── 4. server-stored preference wins over stale local cache ────────────────
  section("authed user's stored preference overrides a stale local cache");
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, "light");
  (globalThis as any).__THEME_TEST_AUTH = {
    user: { id: "u-theme-2", themePreference: "dark" },
    isLoading: false,
    isAuthenticated: true,
  };
  await mount();
  await act(flushAsync);
  assert(html.classList.contains("dark"), ".dark applied from users.theme_preference");
  assert(themeApi?.preference === "dark", "preference adopted from the server");
  assert(
    dom.window.localStorage.getItem(THEME_STORAGE_KEY) === "dark",
    "localStorage cache refreshed to the server value",
  );
  assert(recordedRequests().length === 0, "adoption does not echo a PUT back");
  await unmount();

  // ── 5. signed-out: local apply, no persistence ─────────────────────────────
  section("signed out: setPreference applies locally without a PUT");
  await mount();
  await act(async () => {
    themeApi!.setPreference("dark");
  });
  await act(flushAsync);
  assert(html.classList.contains("dark"), ".dark applied while signed out");
  assert(recordedRequests().length === 0, "no persistence request while signed out");
  await unmount();

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\nTheme provider tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Theme provider test suite crashed:", err);
  process.exitCode = 1;
});
