// Shared, parameterizable Node ESM customization hook for mounting large
// real client components (CommandPanel, ReportForm, ClientManagement, …) in
// the bare `tsx` + jsdom test harness.
//
// Two recurring obstacles block rendering a big component graph here (see
// `.agents/memory/mount-large-client-component-jsdom.md`):
//   1. Heavy browser-only leaf components statically imported by the graph pull
//      in deps `tsx`/node can't evaluate — `react-pdf` (+ its `.css`
//      side-effects → ERR_UNKNOWN_FILE_EXTENSION), `maplibre-gl` (WebGL),
//      `@uppy/*`, etc.
//   2. Radix Dialog/Select/Popover/AlertDialog render through a Portal+Presence
//      pair that never mounts in the raw jsdom harness, so their content (forms,
//      submit buttons, listboxes) is never queryable.
//
// Historically each test shipped its own near-identical loader (one per
// component set, one per Radix combo). This single loader replaces all of them:
// each test's tiny `--import` setup file calls `register(...)` with a `data`
// payload describing which leaf components to stub and which Radix primitives to
// shim. The Radix shims themselves remain the canonical files in `tests/`
// (`dialog-shim.mjs`, `select-shim.mjs`, `popover-shim.mjs`,
// `alert-dialog-shim.mjs`); this loader just redirects the bare specifiers to
// them per the requested config.
//
// Usage (from a per-test setup `.mjs` passed via `--import`):
//
//   import { register } from "node:module";
//   register("./helpers/heavyClientLoader.mjs", import.meta.url, {
//     data: {
//       // basename → extra named exports the stub must also publish.
//       // An array form is accepted too: ["PdfPreviewWithSearch", ...].
//       stubComponents: { PdfPreviewWithSearch: [] },
//       radix: ["dialog", "select"],   // any of dialog|select|popover|alert-dialog
//       stubCss: true,                 // map any `.css` import to an empty module
//       // Stub `@clerk/react` (whose hooks throw outside a live <ClerkProvider>)
//       // with a fixed loaded session; `signedIn: false` keeps use-auth's
//       // /api/auth/user query disabled (no fetch), `signedIn: true` lets the
//       // REAL use-auth hook fetch the DB user through the test's fetch stub so
//       // role gating stays genuine (same seam as the client-detail harness).
//       stubClerk: { signedIn: true },
//     },
//   });

// Radix primitive name → { bare specifier it shims, shim file (relative to here) }.
const RADIX_DEFS = {
  dialog: { specifier: "@radix-ui/react-dialog", shim: "../dialog-shim.mjs" },
  select: { specifier: "@radix-ui/react-select", shim: "../select-shim.mjs" },
  popover: { specifier: "@radix-ui/react-popover", shim: "../popover-shim.mjs" },
  "alert-dialog": { specifier: "@radix-ui/react-alert-dialog", shim: "../alert-dialog-shim.mjs" },
  // Lifecycle-modeling variant (Task #4757): content renders ONLY while open,
  // Trigger opens, Cancel/Action close via onOpenChange — for suites that
  // must verify the open→cancel→reopen→confirm sequence rather than just
  // reach the confirm button. Mutually exclusive with "alert-dialog" (both
  // shim the same specifier; the last one listed wins).
  "alert-dialog-lifecycle": {
    specifier: "@radix-ui/react-alert-dialog",
    shim: "../alert-dialog-lifecycle-shim.mjs",
  },
  "dropdown-menu": { specifier: "@radix-ui/react-dropdown-menu", shim: "../dropdown-menu-shim.mjs" },
};

const STUB_COMPONENT_PREFIX = "heavy-client-stub:component";
const STUB_CSS = "heavy-client-stub:css";
const STUB_CLERK = "heavy-client-stub:clerk-react";

// Populated by `initialize` (runs once in the hooks' thread before any
// resolve/load), read by the resolve/load hooks below.
let radixSpecifierToShim = new Map();
let stubComponentsByBasename = new Map(); // basename → string[] of extra named exports
let stubCss = false;
let stubClerk = null; // null = pass @clerk/react through; else { signedIn: boolean }

function basename(specifier) {
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1];
}

export async function initialize(data = {}) {
  radixSpecifierToShim = new Map();
  stubComponentsByBasename = new Map();
  stubCss = !!data.stubCss;
  stubClerk = data.stubClerk ? { signedIn: data.stubClerk.signedIn !== false } : null;

  for (const name of data.radix ?? []) {
    const def = RADIX_DEFS[name];
    if (!def) {
      throw new Error(
        `heavyClientLoader: unknown radix primitive "${name}". Expected one of: ${Object.keys(RADIX_DEFS).join(", ")}`,
      );
    }
    radixSpecifierToShim.set(def.specifier, new URL(def.shim, import.meta.url).href);
  }

  const sc = data.stubComponents ?? {};
  if (Array.isArray(sc)) {
    for (const name of sc) stubComponentsByBasename.set(name, []);
  } else {
    for (const [name, named] of Object.entries(sc)) {
      stubComponentsByBasename.set(name, Array.isArray(named) ? named : []);
    }
  }
}

export async function resolve(specifier, context, nextResolve) {
  const shimUrl = radixSpecifierToShim.get(specifier);
  if (shimUrl) {
    return { url: shimUrl, shortCircuit: true, format: "module" };
  }

  // Match heavy leaf components by basename so both the `./Foo` (relative) and
  // `@/components/Foo` (alias) import shapes resolve to the stub.
  const named = stubComponentsByBasename.get(basename(specifier));
  if (named) {
    const url = named.length
      ? `${STUB_COMPONENT_PREFIX}?named=${named.join(",")}`
      : STUB_COMPONENT_PREFIX;
    return { url, shortCircuit: true, format: "module" };
  }

  if (stubCss && specifier.endsWith(".css")) {
    return { url: STUB_CSS, shortCircuit: true, format: "module" };
  }

  if (stubClerk && specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_COMPONENT_PREFIX || url.startsWith(`${STUB_COMPONENT_PREFIX}?`)) {
    const q = url.indexOf("?named=");
    const named = q >= 0 ? url.slice(q + "?named=".length).split(",").filter(Boolean) : [];
    let source = "const Stub = () => null;\nexport default Stub;\n";
    for (const name of named) source += `export const ${name} = () => null;\n`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === STUB_CSS) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url === STUB_CLERK) {
    // The hooks `@/hooks/use-auth` imports, plus what the real App shell
    // (client/src/App.tsx) needs when a suite mounts it whole: a children-
    // passthrough <ClerkProvider> and a `useClerk().addListener` no-op
    // unsubscribe (ClerkQueryClientCacheInvalidator subscribes on mount).
    // A loaded session with the configured signed-in state; sign-out no-ops.
    const source = `
export function useAuth() { return { isLoaded: true, isSignedIn: ${stubClerk.signedIn} }; }
export function useClerk() { return { signOut: async () => {}, addListener: () => () => {} }; }
export function ClerkProvider({ children }) { return children; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
