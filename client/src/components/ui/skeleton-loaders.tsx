import { useLocation } from "wouter";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { shouldRenderGlobalQuicklinksBar } from "@/lib/quicklinksVisibility";

/**
 * PageSkeleton doubles as the router/AuthGate PageLoader, so it can render
 * both under the global nav (authed pages) and chrome-less (auth still
 * loading, public lazy routes). Follow the exact nav-rendering predicate
 * (GlobalAppNavShell): subtract --nav-height only when the nav is actually
 * on screen, otherwise stay full-viewport.
 *
 * Task #4779 — every shell here renders on the warm palette: the retired
 * Liberty `bg-primary` header band + `bg-white/10` pills are gone (the app
 * has no blue page bands anymore), so the loading phase shares the loaded
 * pages' color scheme. The header pills sit where the PageHeader grammar
 * puts the back button + title, on the warm canvas, with the standard
 * `bg-muted` placeholder tint from the Skeleton primitive. Keep block
 * heights/padding identical when touching these — the loading→loaded
 * transition must not shift layout, and don't reintroduce colored bands.
 */
export function PageSkeleton() {
  const { user, isAuthenticated } = useAuth();
  const [location] = useLocation();
  const underNav =
    isAuthenticated && !!user && shouldRenderGlobalQuicklinksBar(location);
  return (
    <div
      className={
        underNav
          ? "min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1"
          : "min-h-screen bg-surface-warm-1"
      }
      data-testid="skeleton-page"
    >
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-7 w-48" />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
        <div className="bg-card rounded-lg border border-border p-6 space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-card rounded-lg border border-border p-4 space-y-3" data-testid="skeleton-card">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-dashboard">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-7 w-56" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-7 w-20 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-9 w-full rounded" />
        <TableSkeleton rows={8} cols={6} />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-card rounded-lg border border-border overflow-hidden" data-testid="skeleton-table">
      <div className="p-4 border-b border-border">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface-warm-1">
              {Array.from({ length: cols }).map((_, i) => (
                <th key={i} className="p-3 text-left">
                  <Skeleton className="h-4 w-20" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, rowIdx) => (
              <tr key={rowIdx} className={rowIdx % 2 === 0 ? "bg-card" : "bg-surface-warm-2"}>
                {Array.from({ length: cols }).map((_, colIdx) => (
                  <td key={colIdx} className="p-3">
                    <Skeleton className={`h-4 ${colIdx === 0 ? "w-32" : "w-16"}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="skeleton-card-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-card rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-6 w-14 rounded" />
            <Skeleton className="h-6 w-14 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-form">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-20 rounded" />
          <Skeleton className="h-7 w-40" />
        </div>
      </div>
      <div className="max-w-xl mx-auto p-4 sm:p-6">
        <div className="bg-card rounded-lg border border-border p-6 space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded" />
            </div>
          ))}
          <Skeleton className="h-10 w-full rounded" />
        </div>
      </div>
    </div>
  );
}

export function ReportMatrixSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-report-matrix">
      <div className="p-3 sm:p-4">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-24 rounded" />
            <Skeleton className="h-7 w-36" />
          </div>
        </div>
      </div>
      <div className="max-w-[1600px] mx-auto p-4 sm:p-6 space-y-6">
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
        <TableSkeleton rows={6} cols={8} />
      </div>
    </div>
  );
}

export function CeoInsightsSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-ceo-insights">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-7 w-40" />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <CeoInsightsContentSkeleton />
      </div>
    </div>
  );
}

export function CeoInsightsContentSkeleton() {
  return (
    <div className="space-y-6" data-testid="skeleton-ceo-content">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="bg-card rounded-lg border border-border p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-28" />
            </div>
            <Skeleton className="h-10 w-20" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
      <div className="bg-card rounded-lg border border-border p-6 space-y-4">
        <Skeleton className="h-6 w-48" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ClientDetailSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-client-detail">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-8 w-24 shrink-0 rounded" />
            <div className="min-w-0">
              <Skeleton className="h-7 max-w-48 w-[40vw]" />
              <Skeleton className="h-3 max-w-32 w-[28vw] mt-1" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20 rounded" />
            <Skeleton className="h-8 w-20 rounded" />
          </div>
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-9 w-28 rounded shrink-0" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-card rounded-lg border border-border p-4 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function UserManagementSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-user-management">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-7 w-44" />
        </div>
      </div>
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
        <div className="bg-card rounded-lg border border-border p-4 space-y-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-9 w-full rounded" />
        </div>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-card rounded-lg border border-border p-4 flex items-center gap-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-9 w-28 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityDashboardSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-activity-dashboard">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-7 w-48" />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <ActivityContentSkeleton />
      </div>
    </div>
  );
}

export function ActivityContentSkeleton() {
  return (
    <div className="space-y-4" data-testid="skeleton-activity-content">
      <TableSkeleton rows={8} cols={5} />
    </div>
  );
}

export function McuDashboardSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-mcu-dashboard">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-7 w-44" />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <McuContentSkeleton />
      </div>
    </div>
  );
}

export function McuContentSkeleton() {
  return (
    <div className="space-y-4" data-testid="skeleton-mcu-content">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
      <div className="bg-card rounded-lg border border-border p-6">
        <Skeleton className="h-[300px] w-full rounded" />
      </div>
    </div>
  );
}

export function ComparisonSkeleton() {
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="skeleton-comparison">
      <div className="p-3 sm:p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3">
          <Skeleton className="h-8 w-24 rounded" />
          <Skeleton className="h-7 w-48" />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="bg-card rounded-lg border border-border p-6">
          <Skeleton className="h-6 w-48 mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-10 w-full rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function InlineLoadingSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2 py-2" data-testid="skeleton-inline">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

export function ChatLoadingSkeleton() {
  return (
    <div className="flex items-center justify-center h-full" data-testid="skeleton-chat">
      <div className="space-y-3 w-full px-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
            <div className={`space-y-2 ${i % 2 === 0 ? "items-end" : "items-start"} flex flex-col`}>
              <Skeleton className={`h-4 ${i % 2 === 0 ? "w-32" : "w-48"}`} />
              <Skeleton className={`h-10 ${i % 2 === 0 ? "w-40" : "w-56"} rounded-lg`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ContactsSkeleton() {
  return (
    <div className="space-y-2" data-testid="skeleton-contacts">
      {[1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 p-2 rounded border">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-1">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-7 w-7 rounded" />
        </div>
      ))}
    </div>
  );
}
