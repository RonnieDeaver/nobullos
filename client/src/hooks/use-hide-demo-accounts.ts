import { usePersistentState } from "@/hooks/use-persistent-state";

/**
 * Task #4363 — the ONE persisted preference behind the app-level
 * "hide demo/test accounts" toggle (design audit P3-4). Scoped per user so
 * a shared browser never leaks one operator's view preference into
 * another's; `usePersistentState` re-hydrates when the key flips from the
 * anon placeholder to the signed-in user's id.
 */
export function hideDemoAccountsStorageKey(userId: string | null | undefined): string {
  return `hide-demo-accounts:${userId ?? "anon"}`;
}

export function useHideDemoAccounts(userId: string | null | undefined) {
  return usePersistentState<boolean>(
    hideDemoAccountsStorageKey(userId),
    false,
    (v): v is boolean => typeof v === "boolean",
  );
}
