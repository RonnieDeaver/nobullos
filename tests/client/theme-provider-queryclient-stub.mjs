// Test-only stub for `@/lib/queryClient`, wired via
// tests/client/theme-provider-loader.mjs (Task #4377). ThemeProvider imports
// only `apiRequest`; this recorder captures every call so the suite can
// assert the persistence PUT (method, url, body) without a network layer.
export async function apiRequest(method, url, data) {
  const calls = (globalThis.__THEME_TEST_REQUESTS ??= []);
  calls.push({ method, url, data });
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
  };
}
