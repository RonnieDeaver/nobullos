// Node ESM resolve hook for the ads-os-client-profile-status-chip test
// (Task #3989). Redirects the client-profile builder's impure collaborators
// to stubs in tests/cpChipStubs/ so buildClientProfile runs DB-free and
// network-free:
//   - combinedDashboardService.ts -> fixture rows from test state
//   - clickUpDirectory.ts         -> identity-only clientRecord/normClientName
//   - clientLog.ts                -> pure sheetIdFromUrl
//   - store.ts                    -> null collections + fixture status-check doc
//
// Same pattern as ads-os-p6-hooks.mjs (parentURL guard lets stub->real
// passthrough work, unused here since these stubs import nothing real).

const STUBS = [
  ["/server/services/adsOs/combinedDashboardService.ts", new URL("./cpChipStubs/combinedDashboardService.ts", import.meta.url).href],
  ["/server/services/adsOs/clickUpDirectory.ts", new URL("./cpChipStubs/clickUpDirectory.ts", import.meta.url).href],
  ["/server/services/adsOs/clientLog.ts", new URL("./cpChipStubs/clientLog.ts", import.meta.url).href],
  ["/server/services/adsOs/store.ts", new URL("./cpChipStubs/store.ts", import.meta.url).href],
];
const STUB_URLS = new Set(STUBS.map(([, url]) => url));

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (STUB_URLS.has(context?.parentURL)) return resolved; // stub -> real passthrough
  for (const [suffix, stubUrl] of STUBS) {
    if (resolved.url.endsWith(suffix)) {
      return { ...resolved, url: stubUrl, shortCircuit: true };
    }
  }
  return resolved;
}
