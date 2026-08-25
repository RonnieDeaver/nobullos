/**
 * CEO-only card for reading and enabling Clerk Restricted sign-up mode.
 * Lives in /admin/system-health?tab=auth (Task #4611).
 *
 * The Clerk instance's sign-up mode is environment-scoped: the Development
 * key governs the dev workspace and the Production key governs the deployed
 * app. Enable Restricted mode in BOTH environments by toggling this card once
 * per environment (open the deployed app's /admin/system-health?tab=auth to
 * flip the production instance).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, ShieldAlert, Loader2, RefreshCw } from "lucide-react";

interface ClerkRestrictions {
  allowlist: boolean;
  blocklist: boolean;
}

export function ClerkRestrictionsSection({ enabled = true }: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const {
    data,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery<ClerkRestrictions>({
    queryKey: ["/api/admin/clerk/restrictions"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/clerk/restrictions");
      return res.json();
    },
    enabled,
    retry: 1,
  });

  const enableMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/clerk/enable-restricted-signup",
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setConfirmOpen(false);
      // void: fire-and-forget cache refresh; the query's own error state
      // surfaces any refetch failure.
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/clerk/restrictions"],
      });
    },
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center py-12 text-muted-foreground"
        data-testid="status-clerk-restrictions-loading"
      >
        <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading Clerk
        restrictions…
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent
          className="py-6 text-red-700"
          data-testid="status-clerk-restrictions-error"
        >
          Could not load Clerk restrictions.{" "}
          {error instanceof Error ? error.message : "Please try again."}
        </CardContent>
      </Card>
    );
  }

  const isRestricted = data.allowlist;

  return (
    <Card data-testid="card-clerk-restrictions">
      <CardContent className="py-4 space-y-4">
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {isRestricted ? (
              <ShieldCheck className="w-4 h-4 text-green-700" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-amber-600" />
            )}
            <h2
              className="text-sm font-semibold"
              data-testid="text-clerk-restrictions-title"
            >
              Clerk Sign-up Restrictions
            </h2>
            <Badge
              variant="outline"
              className={
                isRestricted
                  ? "bg-green-100 text-green-800 border-green-200"
                  : "bg-amber-50 text-amber-800 border-amber-200"
              }
              data-testid="badge-clerk-restrictions-status"
            >
              {isRestricted ? "Restricted (enabled)" : "Open (not restricted)"}
            </Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching || enableMutation.isPending}
            data-testid="button-clerk-restrictions-refresh"
          >
            {isFetching ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>

        {/* Description */}
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-clerk-restrictions-desc"
        >
          When <strong>Restricted</strong> is enabled, only pre-approved
          (allowlisted) emails can create a Clerk account. Unapproved visitors
          are blocked at the Clerk sign-up page before they ever reach the app.
          This is a Clerk-instance-level setting and is{" "}
          <strong>environment-scoped</strong>: enable it here (dev) AND in the
          deployed production app to fully close sign-up.
        </p>

        {/* Current status detail */}
        {isRestricted ? (
          <p
            className="text-xs text-green-700 font-medium"
            data-testid="text-clerk-restrictions-active"
          >
            ✓ Restricted sign-up is active for this Clerk instance.
          </p>
        ) : confirmOpen ? (
          /* Confirmation step */
          <div
            className="flex flex-wrap items-center gap-3 p-3 rounded-none border border-amber-200 bg-amber-50"
            data-testid="confirm-clerk-restrictions-enable"
          >
            <p className="text-xs text-amber-900 flex-1">
              This will immediately set Clerk sign-up to{" "}
              <strong>Restricted</strong> for the <strong>current environment</strong>{" "}
              (dev or prod, depending on which app URL you're on). Confirm?
            </p>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmOpen(false)}
                disabled={enableMutation.isPending}
                data-testid="button-clerk-restrictions-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => enableMutation.mutate()}
                disabled={enableMutation.isPending}
                data-testid="button-clerk-restrictions-confirm"
              >
                {enableMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : null}
                Enable Restricted Sign-up
              </Button>
            </div>
          </div>
        ) : (
          /* Enable button */
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              data-testid="button-clerk-restrictions-enable"
            >
              <ShieldCheck className="w-4 h-4 mr-1.5" />
              Enable Restricted Sign-up
            </Button>
            {enableMutation.isError && (
              <p
                className="text-xs text-red-700"
                data-testid="text-clerk-restrictions-enable-error"
              >
                {enableMutation.error instanceof Error
                  ? enableMutation.error.message
                  : "Failed to enable. Check server logs."}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
