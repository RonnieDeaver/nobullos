// Test-only stub for `@/hooks/use-auth`, wired via
// tests/client/theme-provider-loader.mjs (Task #4377). ThemeProvider reads
// only `user` (for user.themePreference) and `isAuthenticated` (to decide
// whether setPreference should persist via PUT).
export function useAuth() {
  return (
    globalThis.__THEME_TEST_AUTH ?? {
      user: null,
      isLoading: false,
      isAuthenticated: false,
    }
  );
}
