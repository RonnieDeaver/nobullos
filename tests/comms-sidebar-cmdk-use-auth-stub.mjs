// Test-only stub for `@/hooks/use-auth`, wired via
// `tests/comms-sidebar-cmdk-use-auth-loader.mjs`. The real hook runs a
// TanStack query against /api/auth/user; CommsSidebar only reads
// `user.dbUser.role` to decide whether to show the emoji-admin nav entry.
export function useAuth() {
  return (
    globalThis.__COMMS_SIDEBAR_TEST_AUTH ?? {
      user: { dbUser: { role: "member" } },
      isLoading: false,
      isAuthenticated: true,
    }
  );
}
