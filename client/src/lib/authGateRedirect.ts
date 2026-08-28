import { isPublicPath } from "@/lib/publicPaths";

/**
 * Pure decision core for AuthGate's redirect effect (client/src/App.tsx) —
 * deliberately import-light (only the public-path list, no React/Clerk/
 * wouter) so it is unit-testable without mounting the app tree.
 *
 * Returns the path to redirect to, or null when no redirect is warranted
 * (still loading, already authenticated, or already on a public path).
 *
 * Precedence mirrors the closed-admission rollout: notApproved and revoked
 * are both "session is Clerk-valid but locally denied" states that must
 * land on their OWN public page, never fall through to the generic
 * /sign-in loop (Task #4554, Task #5330).
 */
export function resolveAuthGateRedirect(state: {
  isLoading: boolean;
  user: unknown;
  notApproved: boolean;
  revoked: boolean;
  location: string;
}): "/not-approved" | "/access-revoked" | "/sign-in" | null {
  if (state.isLoading || state.user || isPublicPath(state.location)) return null;
  if (state.notApproved) return "/not-approved";
  if (state.revoked) return "/access-revoked";
  return "/sign-in";
}
