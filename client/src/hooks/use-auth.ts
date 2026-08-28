import { useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { User } from "@shared/models/auth";
import { clearConversationCache } from "@/lib/conversationCache";
import { isPublicPath } from "@/lib/publicPaths";

export function useAuth() {
  const { isLoaded, isSignedIn } = useClerkAuth();
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const [location] = useLocation();

  const onPublicPath = isPublicPath(location);

  // Task #4554 — closed admission: a signed-in Clerk session whose email is
  // not on the approved-users allowlist gets 403 { code:
  // "account_not_approved" } from every API call. The probe maps that to a
  // sentinel (NOT an error, NOT null) so AuthGate can route to /not-approved
  // instead of looping between the app and /sign-in.
  type NotApprovedSentinel = { __notApproved: true; email: string | null };
  // Mirrors the not-approved sentinel: a soft-deleted (revoked) user's
  // session is still Clerk-valid, so this must route to /access-revoked
  // instead of falling through to a generic "not authenticated" /sign-in
  // loop (Task #5330).
  type RevokedSentinel = { __revoked: true };
  type AuthProbeResult = User | NotApprovedSentinel | RevokedSentinel | null;

  // Fetch the local DB user record (has role, permissions, etc.) once Clerk
  // has validated the session. Disabled on public paths (no auth needed) and
  // before Clerk finishes loading (would 401 before the cookie is attached).
  const { data, isLoading: isUserLoading } = useQuery<AuthProbeResult>({
    queryKey: ["/api/auth/user"],
    queryFn: async () => {
      const response = await fetch("/api/auth/user", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        const body = await response.json().catch(() => null);
        if (body?.code === "account_revoked") {
          return { __revoked: true } satisfies RevokedSentinel;
        }
        return null;
      }
      if (response.status === 403) {
        const body = await response.json().catch(() => null);
        if (body?.code === "account_not_approved") {
          return {
            __notApproved: true,
            email: typeof body.email === "string" ? body.email : null,
          } satisfies NotApprovedSentinel;
        }
        throw new Error(`${response.status}: ${response.statusText}`);
      }
      if (!response.ok) throw new Error(`${response.status}: ${response.statusText}`);
      return response.json();
    },
    enabled: !onPublicPath && isLoaded && !!isSignedIn,
    // The auth probe is the gatekeeper for the whole app — errors are
    // handled inline (401 → unauthenticated; 5xx retried below).
    // Do not surface them through the global "Request failed" toast.
    meta: { silent: true },
    retry: (failureCount, error) => {
      if (error instanceof TypeError) return failureCount < 3;
      if (error instanceof Error) {
        const status = parseInt(error.message, 10);
        if (!isNaN(status) && status >= 500) return failureCount < 3;
      }
      return false;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: true,
  });

  // isLoading is true while:
  //   - Clerk hasn't validated its session cookie yet (!isLoaded), OR
  //   - Clerk is loaded + signed in but the DB user fetch is still in flight
  const isLoading =
    !isLoaded ||
    (!!isSignedIn && isUserLoading && !onPublicPath);

  const notApprovedSentinel =
    data && typeof data === "object" && "__notApproved" in data
      ? (data as NotApprovedSentinel)
      : null;
  const revokedSentinel =
    data && typeof data === "object" && "__revoked" in data
      ? (data as RevokedSentinel)
      : null;
  const user =
    notApprovedSentinel || revokedSentinel
      ? null
      : ((data as User | null | undefined) ?? null);

  const logoutMutation = useMutation({
    mutationFn: async () => {
      // Purge per-user conversation cache before navigating away so the next
      // user on this browser doesn't see another account's messages.
      clearConversationCache();
      await signOut({ redirectUrl: "/" });
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null);
    },
  });

  return {
    user: isLoaded && isSignedIn ? user : null,
    isLoading,
    isAuthenticated: !!isSignedIn && !!user,
    // Task #4554 — closed admission: true when the Clerk session is valid
    // but the email has no approved users row. AuthGate routes this state
    // to /not-approved (public) so it can never loop back to /sign-in.
    notApproved: !!isSignedIn && !!notApprovedSentinel,
    notApprovedEmail: notApprovedSentinel?.email ?? null,
    // True when the local users row is soft-deleted (deletedAt set) while
    // Clerk's session is still valid. AuthGate routes this to the public
    // /access-revoked page instead of /sign-in (Task #5330).
    revoked: !!isSignedIn && !!revokedSentinel,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
