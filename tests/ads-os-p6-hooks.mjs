// Node ESM resolve hook for the ads-os-alerts-notify-clientlog test (Task #3602).
//
// Redirects the Phase 6 modules' impure collaborators to stubs in
// tests/p6Stubs/ so the alerts engine (severity matrix + Paused/Off
// suppression), the Slack digest (only-on-change fingerprints), and the
// client-log reader (state codes) all run DB-free and network-free:
//   - alertsQueries.ts          -> Ads API row fixtures from test state
//   - criteriaService.ts        -> loadCriteria schedule_days from test state
//   - slackWebhook.ts           -> recording postSlackMessage (never POSTs)
//   - store.ts                  -> in-memory alerts/notified/client-log maps
//   - googleDriveIntegration.ts -> getSheetsAccessToken from test state
//
// The star-re-export stubs import their real modules; the parentURL guard lets
// those pass through un-redirected (same pattern as ads-os-pyramid-hooks.mjs).

const STUBS = [
  ["/server/services/adsOs/alertsQueries.ts", new URL("./p6Stubs/alertsQueries.ts", import.meta.url).href],
  ["/server/services/adsOs/criteriaService.ts", new URL("./p6Stubs/criteriaService.ts", import.meta.url).href],
  ["/server/services/adsOs/slackWebhook.ts", new URL("./p6Stubs/slackWebhook.ts", import.meta.url).href],
  ["/server/services/adsOs/store.ts", new URL("./p6Stubs/store.ts", import.meta.url).href],
  ["/server/services/googleDriveIntegration.ts", new URL("./p6Stubs/googleDriveIntegration.ts", import.meta.url).href],
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
