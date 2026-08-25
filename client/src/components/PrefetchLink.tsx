import { Link } from "wouter";
import { useCallback } from "react";
import { queryClient } from "@/lib/queryClient";
import { ATS_PAGINATED_PREFETCHERS } from "@/lib/atsListPagination";

type PrefetchConfig = {
  module: () => Promise<any>;
  queries?: string[];
};

const routePrefetchers: Record<string, PrefetchConfig> = {
  "/": {
    module: () => import("@/pages/Dashboard"),
    queries: ["/api/dashboard/client-summaries", "/api/reports"],
  },
  "/admin/ceo-pulse": {
    module: () => import("@/pages/admin/CeoPulseAdmin"),
    queries: ["/api/ceo-pulses"],
  },
  "/ceo/insights": {
    module: () => import("@/pages/CeoInsights"),
    queries: ["/api/clients", "/api/reports", "/api/users", "/api/all-data-access", "/api/all-report-sections", "/api/ceo-pulses"],
  },
  "/ceo/call-analysis": {
    module: () => import("@/pages/CallAnalysis"),
  },
  "/ceo/ats": {
    module: () => import("@/pages/AtsAdmin"),
    queries: ["/api/ats/jobs"],
  },
  "/admin/clients": {
    module: () => import("@/pages/admin/ClientManagement"),
    queries: ["/api/clients", "/api/users"],
  },
  "/admin/users": {
    module: () => import("@/pages/admin/UserManagement"),
    queries: ["/api/users"],
  },
  "/admin/activity": {
    module: () => import("@/pages/admin/ActivityDashboard"),
    queries: ["/api/users"],
  },
  "/admin/rate-limits": {
    module: () => import("@/pages/admin/RateLimitUsers"),
    queries: ["/api/health/rate-limits/by-user", "/api/health/rate-limits", "/api/users"],
  },
  "/admin/practice-areas": {
    module: () => import("@/pages/admin/PracticeAreaSettings"),
  },
  "/admin/phase-settings": {
    module: () => import("@/pages/admin/PhaseSettings"),
  },
  "/reports/matrix": {
    module: () => import("@/pages/ReportMatrix"),
    queries: ["/api/reports/matrix"],
  },
  "/reports/compare": {
    module: () => import("@/pages/ReportComparison"),
    queries: ["/api/clients"],
  },
  "/reports/new": {
    module: () => import("@/pages/ReportForm"),
    queries: ["/api/clients"],
  },
  "/analytics/trends": {
    module: () => import("@/pages/TrendAnalytics"),
    queries: ["/api/clients"],
  },
  "/mcu-dashboard": {
    module: () => import("@/pages/McuDashboard"),
    queries: ["/api/mcu/practice-areas"],
  },
  "/mcu-checker": {
    module: () => import("@/pages/McuChecker"),
    queries: ["/api/mcu/practice-areas"],
  },
  "/ceo/webhook-logs": {
    module: () => import("@/pages/WebhookImportLogs"),
  },
  "/clients/add": {
    module: () => import("@/pages/ClientAdd"),
  },
};

interface PrefetchLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

function prefetchDynamicRoute(href: string): boolean {
  const clientMatch = href.match(/^\/clients\/([^/]+)$/);
  if (clientMatch) {
    // fire-and-forget chunk warm-up; a failed dynamic import here is benign
    // (the route load itself will surface any real failure)
    void import("@/pages/ClientDetail").catch(() => {});
    const clientId = clientMatch[1];
    // fire-and-forget warm-up; prefetchQuery never rejects
    void queryClient.prefetchQuery({
      queryKey: ["/api/clients", clientId],
      queryFn: async () => {
        const res = await fetch(`/api/clients/${clientId}`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed");
        return res.json();
      },
      staleTime: 30_000,
    });
    return true;
  }
  const reportMatch = href.match(/^\/reports\/([^/]+)$/);
  if (reportMatch && reportMatch[1] !== "new" && reportMatch[1] !== "matrix" && reportMatch[1] !== "compare") {
    // fire-and-forget chunk warm-up; a failed dynamic import here is benign
    void import("@/pages/ReportForm").catch(() => {});
    return true;
  }
  return false;
}

export default function PrefetchLink({ href, children, className, "data-testid": testId }: PrefetchLinkProps) {
  const handleMouseEnter = useCallback(() => {
    const config = routePrefetchers[href];
    if (config) {
      // fire-and-forget chunk warm-up; a failed dynamic import here is benign
      void config.module().catch(() => {});
      config.queries?.forEach((key) => {
        // Task #3979: cursor-paginated endpoints prefetch ONLY their first
        // page, in the infinite-query cache shape the page's useInfiniteQuery
        // expects (a default queryFn prefetch would cache the raw
        // { items, nextCursor } envelope under the same key).
        const atsPrefetch = ATS_PAGINATED_PREFETCHERS[key];
        if (atsPrefetch) {
          // fire-and-forget warm-up; prefetchQuery never rejects
          void atsPrefetch(queryClient);
        } else {
          // fire-and-forget warm-up; prefetchQuery never rejects
          void queryClient.prefetchQuery({ queryKey: [key], staleTime: 30_000 });
        }
      });
    } else {
      prefetchDynamicRoute(href);
    }
  }, [href]);

  return (
    <Link href={href} className={className} data-testid={testId} onMouseEnter={handleMouseEnter}>
      {children}
    </Link>
  );
}
