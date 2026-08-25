import { useAuth } from "@/hooks/use-auth";

/**
 * CEO gate for privileged Ads OS operational controls.
 *
 * Read endpoints are open to every authenticated staff role, but the
 * mutating/trigger endpoints (directory refresh, run audits/alerts/status
 * checks, keyword actioning, ClickUp task creation) remain requireCeo
 * server-side. Criteria editing is intentionally available to every signed-in
 * user. `user` is null until the auth probe resolves, so privileged controls
 * fail closed (briefly absent rather than briefly leaked).
 */
export function useIsCeo(): boolean {
  const { user } = useAuth();
  return user?.role === "ceo";
}
