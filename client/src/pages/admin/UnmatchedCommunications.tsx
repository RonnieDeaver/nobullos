import { usePageTitle } from "@/hooks/use-page-title";
import { useAuth } from "@/hooks/use-auth";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { GlobalResetSavedAdminViewsButton } from "@/components/GlobalResetSavedAdminViewsButton";
import { UnmatchedFeedSection } from "@/components/admin/UnmatchedFeedSection";
import { PageHeader } from "@/components/admin/PageHeader";

// Task #1624: standalone System Tools page that hosts the unified
// Front + Slack + Zoom unmatched-communications triage feed. The feed
// itself (state, queries, mutations, dialogs) lives in
// `UnmatchedFeedSection` so it can be moved or re-mounted elsewhere
// without re-deriving its state. This page only provides the chrome.
export default function UnmatchedCommunications() {
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";

  usePageTitle("Unmatched Communications");

  if (authLoading) return <PageSkeleton />;

  if (!user || !isAdmin) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center" data-testid="text-access-denied">
        <div className="text-foreground">Access denied. Team Lead or CEO access required.</div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <PageHeader
          title="Unmatched Communications"
          backHref="/"
          backLabel="Dashboard"
          backTestId="link-back-dashboard"
          actions={
            <GlobalResetSavedAdminViewsButton
              variant="outline"
              size="sm"
            />
          }
        />
        <UnmatchedFeedSection />
      </div>
    </div>
  );
}
