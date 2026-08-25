import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient, consumeSessionExpiredMarker } from "./lib/queryClient";
import { ATS_PAGINATED_PREFETCHERS } from "@/lib/atsListPagination";
import { toast } from "@/hooks/use-toast";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { ConnectionStatusBanner } from "@/components/ConnectionStatusBanner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Suspense, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useActivityTracker } from "@/hooks/use-activity-tracker";
import { useAuth } from "@/hooks/use-auth";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { shouldRenderGlobalQuicklinksBar } from "@/lib/quicklinksVisibility";
import { CommsProvider } from "@/contexts/CommsContext";
import { ClerkProvider, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
// CommsRail / CommsPopupManager are lazy so the comms UI (and the vendor code
// it pulls in) stays out of the entry chunk and fetches after first paint.
// lazyWithRetry keeps the stale-deploy chunk-retry behavior identical to pages.
const CommsRail = lazyWithRetry(() =>
  import("@/components/comms/CommsRail").then((m) => ({ default: m.CommsRail })),
);
const CommsPopupManager = lazyWithRetry(() =>
  import("@/components/comms/CommsPopupManager").then((m) => ({ default: m.CommsPopupManager })),
);
// Task #4482 (bundle budget): the global nav is lazy too — QuicklinksBar's
// manifest + radix dropdown-menu closure stays out of the entry chunk. The
// visibility gate it shares with CommsShell lives in lib/quicklinksVisibility
// so this file needs no static import of the nav module.
const GlobalAppNav = lazyWithRetry(() =>
  import("@/components/QuicklinksBar").then((m) => ({ default: m.GlobalAppNav })),
);
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { BRAND_ASSET_PATHS } from "@/components/kit/BrandMark";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { legacyConversationsUrlToComms } from "@/lib/contactHubUrl";
import { clearAutoReloadGuard } from "@/lib/chunkLoadError";
// Task #4377 global theme — import restored (repeatedly dropped by completion-rebase
// auto-merges; TS2304 at the <ThemeProvider> usage below when missing). Do not remove.
import { ThemeProvider } from "@/lib/theme";
import { TitleProvider } from "@/contexts/TitleContext";
import { GlobalTitleManager } from "@/components/GlobalTitleManager";

const Dashboard = lazyWithRetry(() => import("@/pages/Dashboard"));
const ClientManagement = lazyWithRetry(() => import("@/pages/admin/ClientManagement"));
const CeoPulseAdmin = lazyWithRetry(() => import("@/pages/admin/CeoPulseAdmin"));
const UserManagement = lazyWithRetry(() => import("@/pages/admin/UserManagement"));
const PracticeAreaSettings = lazyWithRetry(() => import("@/pages/admin/PracticeAreaSettings"));
const TagsSegments = lazyWithRetry(() => import("@/pages/admin/TagsSegments"));

const ScoringAdmin = lazyWithRetry(() => import("@/pages/admin/Scoring"));
const DealAutomation = lazyWithRetry(() => import("@/pages/admin/DealAutomation"));
const PhaseSettings = lazyWithRetry(() => import("@/pages/admin/PhaseSettings"));
const ReportForm = lazyWithRetry(() => import("@/pages/ReportForm"));
const PublicReport = lazyWithRetry(() => import("@/pages/PublicReport"));
const PublicBookingPage = lazyWithRetry(() => import("@/pages/PublicBookingPage"));
const PublicBookingCancel = lazyWithRetry(() => import("@/pages/PublicBookingCancel"));
const BookAccess = lazyWithRetry(() => import("@/pages/BookAccess"));
const BookOrderStatus = lazyWithRetry(() => import("@/pages/BookOrderStatus"));
const DemoReport = lazyWithRetry(() => import("@/pages/DemoReport"));
const ClientAdd = lazyWithRetry(() => import("@/pages/ClientAdd"));
const ClientDetail = lazyWithRetry(() => import("@/pages/ClientDetail"));

const DealsBoard = lazyWithRetry(() => import("@/pages/DealsBoard"));

const Leads = lazyWithRetry(() => import("@/pages/Leads"));

const Campaigns = lazyWithRetry(() => import("@/pages/Campaigns"));
const ReportComparison = lazyWithRetry(() => import("@/pages/ReportComparison"));
const TrendAnalytics = lazyWithRetry(() => import("@/pages/TrendAnalytics"));
const PublicReportPrint = lazyWithRetry(() => import("@/pages/PublicReportPrint"));
const CeoInsights = lazyWithRetry(() => import("@/pages/CeoInsights"));
const ChurnCommandCenter = lazyWithRetry(() => import("@/pages/ChurnCommandCenter"));
const CallAnalysis = lazyWithRetry(() => import("@/pages/CallAnalysis"));
const McuChecker = lazyWithRetry(() => import("@/pages/McuChecker"));
const Comms = lazyWithRetry(() => import("@/pages/Comms"));
const McuDashboard = lazyWithRetry(() => import("@/pages/McuDashboard"));
const AtsAdmin = lazyWithRetry(() => import("@/pages/AtsAdmin"));
const CandidatePortal = lazyWithRetry(() => import("@/pages/CandidatePortal"));
const ReportMatrix = lazyWithRetry(() => import("@/pages/ReportMatrix"));
const WebhookImportLogs = lazyWithRetry(() => import("@/pages/WebhookImportLogs"));
const SlackIntegration = lazyWithRetry(() => import("@/pages/admin/SlackIntegration"));
const SlackNotificationsConsole = lazyWithRetry(() => import("@/pages/admin/SlackNotificationsConsole"));
const FrontIntegration = lazyWithRetry(() => import("@/pages/admin/FrontIntegration"));
const SemrushIntegration = lazyWithRetry(() => import("@/pages/admin/SemrushIntegration"));
const ZoomIntegration = lazyWithRetry(() => import("@/pages/admin/ZoomIntegration"));
const ZoomReviewQueue = lazyWithRetry(() => import("@/pages/admin/ZoomReviewQueue"));
const ZoomMatchAssistant = lazyWithRetry(() => import("@/pages/admin/ZoomMatchAssistant"));
const ClickUpModule = lazyWithRetry(() => import("@/pages/admin/ClickUpModule"));
const ServiceDeskSettings = lazyWithRetry(() => import("@/pages/admin/ServiceDeskSettings"));
const RoleAssignments = lazyWithRetry(() => import("@/pages/admin/RoleAssignments"));
const ServiceDeskHome = lazyWithRetry(() => import("@/pages/admin/ServiceDeskHome"));
const ServiceDeskCreate = lazyWithRetry(() => import("@/pages/ServiceDeskCreate"));
const ServiceDeskTicketDetail = lazyWithRetry(() => import("@/pages/admin/ServiceDeskTicketDetail"));
const ServiceDeskReports = lazyWithRetry(() => import("@/pages/admin/ServiceDeskReports"));
const IntegrationsHub = lazyWithRetry(() => import("@/pages/admin/IntegrationsHub"));
const UnmatchedCommunications = lazyWithRetry(() => import("@/pages/admin/UnmatchedCommunications"));
const ImportSuggestions = lazyWithRetry(() => import("@/pages/admin/ImportSuggestions"));
const DbAttributionTrends = lazyWithRetry(() => import("@/pages/admin/DbAttributionTrends"));
const SemrushCadence = lazyWithRetry(() => import("@/pages/admin/SemrushCadence"));
const BackupsConsole = lazyWithRetry(() => import("@/pages/admin/BackupsConsole"));
const BookOperationsConsole = lazyWithRetry(() => import("@/pages/admin/BookOperationsConsole"));

const CommsWebhooks = lazyWithRetry(() => import("@/pages/admin/CommsWebhooks"));
const CommsDefaultChannels = lazyWithRetry(() => import("@/pages/admin/DefaultChannels"));
const PublicCeoPulse = lazyWithRetry(() => import("@/pages/PublicCeoPulse"));
const CeoPulseLetter = lazyWithRetry(() => import("@/pages/CeoPulseLetter"));
const RisDashboard = lazyWithRetry(() => import("@/pages/RisDashboard"));
const TwilioAdmin = lazyWithRetry(() => import("@/pages/admin/TwilioAdmin"));
const CallArchiveStatus = lazyWithRetry(() => import("@/pages/admin/CallArchiveStatus"));

const SmsConsentAdmin = lazyWithRetry(() => import("@/pages/admin/SmsConsent"));
const Profile = lazyWithRetry(() => import("@/pages/Profile"));
const ActivityDashboard = lazyWithRetry(() => import("@/pages/admin/ActivityDashboard"));

const InternalUsage = lazyWithRetry(() => import("@/pages/admin/InternalUsage"));
const RateLimitUsers = lazyWithRetry(() => import("@/pages/admin/RateLimitUsers"));
const RateLimitMultipliers = lazyWithRetry(() => import("@/pages/admin/RateLimitMultipliers"));
const MatchSettings = lazyWithRetry(() => import("@/pages/admin/MatchSettings"));
const SystemHealthConsole = lazyWithRetry(() => import("@/pages/admin/SystemHealthConsole"));
const ConversationDedupeConflicts = lazyWithRetry(() => import("@/pages/admin/ConversationDedupeConflicts"));
const FeedbackAdmin = lazyWithRetry(() => import("@/pages/admin/FeedbackAdmin"));
const GoogleAdsHygieneAudit = lazyWithRetry(() => import("@/pages/admin/GoogleAdsHygieneAudit"));
const AdsOsProofs = lazyWithRetry(() => import("@/pages/AdsOsProofs"));
const AdsOsMain = lazyWithRetry(() => import("@/pages/adsOs/MainDashboard"));
const AdsOsGads = lazyWithRetry(() => import("@/pages/adsOs/GadsDashboard"));
const AdsOsLsa = lazyWithRetry(() => import("@/pages/adsOs/LsaDashboard"));
const AdsOsClientProfile = lazyWithRetry(() => import("@/pages/adsOs/ClientProfile"));
const AdsOsAmDashboard = lazyWithRetry(() => import("@/pages/adsOs/AmDashboard"));
const AdsOsBudgetPacing = lazyWithRetry(() => import("@/pages/adsOs/BudgetPacingTool"));
const AdsOsLsaPacing = lazyWithRetry(() => import("@/pages/adsOs/LsaPacingTool"));
const AdsOsAudit = lazyWithRetry(() => import("@/pages/adsOs/HygieneAuditTool"));
const AdsOsLsaHygiene = lazyWithRetry(() => import("@/pages/adsOs/LsaHygieneTool"));
const AdsOsAnalyzer = lazyWithRetry(() => import("@/pages/adsOs/AnalyzerChooser"));
const AdsOsKeywordIntel = lazyWithRetry(() => import("@/pages/adsOs/KeywordIntelTool"));
const AdsOsKeywordFinder = lazyWithRetry(() => import("@/pages/adsOs/KeywordFinderTool"));
const AdsOsPyramid = lazyWithRetry(() => import("@/pages/adsOs/PyramidTool"));
const Notifications = lazyWithRetry(() => import("@/pages/Notifications"));
const AccessRevoked = lazyWithRetry(() => import("@/pages/AccessRevoked"));
const NotApproved = lazyWithRetry(() => import("@/pages/NotApproved"));
const SheetsLibrary = lazyWithRetry(() => import("@/pages/SheetsLibrary"));

const FilesLibrary = lazyWithRetry(() => import("@/pages/FilesLibrary"));
const SheetEditor = lazyWithRetry(() => import("@/pages/SheetEditor"));
const DocEditor = lazyWithRetry(() => import("@/pages/DocEditor"));
const SheetDashboard = lazyWithRetry(() => import("@/pages/SheetDashboard"));
const RoadmapPage = lazyWithRetry(() => import("@/pages/Roadmap"));
const RoadmapAdmin = lazyWithRetry(() => import("@/pages/admin/RoadmapAdmin"));
const OutboundEmailAdmin = lazyWithRetry(() => import("@/pages/admin/OutboundEmail"));
const EmailSequencesAdmin = lazyWithRetry(() => import("@/pages/admin/EmailSequences"));
const EmailSequenceDetail = lazyWithRetry(() => import("@/pages/admin/EmailSequenceDetail"));
const NotFound = lazyWithRetry(() => import("@/pages/not-found"));

const SignInPage = lazyWithRetry(() => import("@/pages/SignIn"));
function PageLoader() {
  return <PageSkeleton />;
}

// Paths that are intentionally public and must never redirect to sign-in.
// Task #4225 — moved to lib/publicPaths so use-auth and GlobalTitleManager
// can gate their background probes on the same list without importing App.
import { isPublicPath } from "@/lib/publicPaths";

const RETURN_TO_STORAGE_KEY = "nobull:return-to";

function saveReturnTo(path: string): void {
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, path);
  } catch { /* ignore */ }
}

function consumeReturnTo(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const path = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    if (path) window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    return path ?? null;
  } catch {
    return null;
  }
}

/**
 * Redirects unauthenticated users to the sign-in flow for any protected page.
 * Public routes (share/book/pulse/apply/demo-report/access-revoked/sign-in/sign-up)
 * bypass this gate entirely. The current path is saved to sessionStorage so
 * ReturnToHandler can navigate back there after a successful login.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user, isLoading, notApproved } = useAuth();

  useEffect(() => {
    if (!isLoading && !user && !isPublicPath(location)) {
      // Task #4554 — closed admission: a signed-in Clerk session whose
      // email isn't approved must land on /not-approved (public), NOT
      // /sign-in — Clerk would bounce the still-signed-in session straight
      // back and loop.
      if (notApproved) {
        setLocation("/not-approved");
        return;
      }
      saveReturnTo(location + window.location.search);
      setLocation("/sign-in");
    }
  }, [isLoading, user, notApproved, location, setLocation]);

  if (isPublicPath(location)) {
    return <>{children}</>;
  }

  if (isLoading) {
    return <PageLoader />;
  }

  if (!user) {
    // Redirect is in-flight; show the loader to avoid a flash of protected content.
    return <PageLoader />;
  }

  return <>{children}</>;
}

/**
 * After a fresh login, navigate the user back to the page they originally
 * tried to open (saved by AuthGate). Runs once per authenticated boot.
 */
function ReturnToHandler() {
  const [, navigate] = useLocation();
  const { user, isLoading } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (!isLoading && user && !handled.current) {
      handled.current = true;
      const returnTo = consumeReturnTo();
      if (returnTo && returnTo !== "/" && !isPublicPath(returnTo)) {
        navigate(returnTo);
      }
    }
  }, [isLoading, user, navigate]);

  return null;
}

const routeDataPrefetch: Record<string, string[]> = {
  "/": ["/api/dashboard/client-summaries", "/api/reports"],
  "/admin/ceo-pulse": ["/api/ceo-pulses"],
  "/admin/clients": ["/api/clients", "/api/users"],
  "/admin/users": ["/api/users"],
  "/admin/activity": ["/api/users"],
  "/admin/rate-limits": ["/api/health/rate-limits/by-user", "/api/health/rate-limits", "/api/users"],
  "/admin/system-health": ["/api/health/history", "/api/health/thresholds", "/api/integrations/work-queue/status", "/api/integrations/work-queue/dead-letter", "/api/integrations/work-queue/dead-letter/queue-names", "/api/integrations/work-queue/stale-lease-thresholds/history", "/api/integrations/work-queue/timings/history", "/api/integrations/work-queue/audit-prune-events", "/api/admin/route-limiters", "/api/admin/audit-retention", "/api/admin/blocked-ip-audit-retention", "/api/admin/audit-retention/history", "/api/admin/audit-retention/prune-events"],
  "/reports/matrix": ["/api/reports", "/api/reports/matrix"],
  "/reports/compare": ["/api/clients"],
  "/reports/new": ["/api/clients"],
  "/analytics/trends": ["/api/clients"],
  "/ceo/insights": ["/api/clients", "/api/reports", "/api/users", "/api/all-data-access", "/api/all-report-sections", "/api/ceo-pulses"],
  "/churn": ["/api/churn/leaderboard", "/api/churn/save-plays"],
  "/ceo/ats": ["/api/ats/jobs"],
  "/mcu-dashboard": ["/api/mcu/practice-areas"],
  "/mcu-checker": ["/api/mcu/practice-areas"],
  "/clients/add": ["/api/clients"],
  "/admin/backups": ["/api/admin/backups"],
  "/admin/service-desk": ["/api/service-desk/config", "/api/service-desk/departments", "/api/service-desk/request-types"],
};

function RoutePrefetcher() {
  const [location] = useLocation();
  useEffect(() => {
    const keys = routeDataPrefetch[location];
    if (keys) {
      keys.forEach((key) => {
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
          void queryClient.prefetchQuery({ queryKey: [key] });
        }
      });
    }
  }, [location]);
  return null;
}

/**
 * Task #4482: renders the lazy GlobalAppNav behind the same auth/path gate
 * the nav applies internally, so (a) public/unauthenticated surfaces never
 * see the fallback bar flash, and (b) while the nav chunk loads after first
 * paint, a same-height sticky placeholder bar prevents layout shift.
 */
function GlobalAppNavShell() {
  const { user, isAuthenticated } = useAuth();
  const [location] = useLocation();
  if (!isAuthenticated || !user || !shouldRenderGlobalQuicklinksBar(location)) {
    return null;
  }
  return (
    <>
      {/* Task #4659 — skip link: first tab stop on every authed page, outside
          the Suspense so it exists even while the nav chunk loads. Target is
          the #main-content marker Router renders ahead of the routed page. */}
      <a href="#main-content" className="os-skip-link" data-testid="link-skip-to-main">
        Skip to main content
      </a>
      <Suspense
        fallback={
          <header
            className="sticky top-0 z-[var(--z-nav)] bg-chrome border-b border-chrome-edge shadow-sm"
            aria-hidden="true"
          >
            <div className="h-[var(--nav-content-height)]" />
          </header>
        }
      >
        <GlobalAppNav />
      </Suspense>
    </>
  );
}

function CommsShell() {
  const { user, isAuthenticated } = useAuth();
  const [location] = useLocation();
  const currentUserId = (user as any)?.id ?? "";
  // Task #4225 — never render internal chat chrome (rail handle, floating
  // chat FAB, popups) on public/unauthenticated surfaces (share links, demo
  // report, booking, etc.). Same gate CommsProvider uses to decide whether
  // the comms store is live at all.
  if (!isAuthenticated || !user || !shouldRenderGlobalQuicklinksBar(location)) {
    return null;
  }
  return (
    // Own Suspense boundary (fallback null) so the lazy comms shell never
    // triggers the router-level PageLoader while its chunk loads.
    <Suspense fallback={null}>
      <CommsRail />
      <CommsPopupManager currentUserId={currentUserId} />
    </Suspense>
  );
}

function Router() {
  return (
    <>
      {/* Task #4784 — the global chrome (nav shell, comms shell, skip link,
          #main-content marker) lives OUTSIDE the route-level Suspense so a
          suspended lazy route swaps out only the page area: the crimson nav
          stays painted and PageSkeleton's underNav variant renders beneath a
          nav that is actually on screen (previously React display:none'd the
          whole mounted tree, leaving a dead nav-height strip mid-load). The
          nav/comms shells keep their own inner Suspense boundaries for their
          lazy chunks. */}
      <GlobalTitleManager />
      <ReturnToHandler />
      <RoutePrefetcher />
      <GlobalAppNavShell />
      <CommsShell />
      {/* Skip-link landing marker (Task #4659): sits after the nav + comms
          chrome so Tab-after-skip reaches page content first. tabIndex={-1}
          accepts programmatic focus without joining the tab order (the global
          focus-visible baseline excludes it, so no ring paints on it). */}
      <div id="main-content" tabIndex={-1} />
      <Suspense fallback={<PageLoader />}>
      <AuthGate>
      <Switch>
        {/* Sign-in / sign-up are public (in publicPaths) and handled by Clerk */}
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/access-revoked" component={AccessRevoked} />
        <Route path="/not-approved" component={NotApproved} />
        <Route path="/book/access" component={BookAccess} />
        <Route path="/book/order-status" component={BookOrderStatus} />
        <Route path="/" component={Dashboard} />
        <Route path="/admin/clients" component={ClientManagement} />
        <Route path="/admin/ceo-pulse" component={CeoPulseAdmin} />
        <Route path="/admin/users" component={UserManagement} />
        <Route path="/admin/practice-areas" component={PracticeAreaSettings} />
        <Route path="/admin/tags-segments" component={TagsSegments} />
        <Route path="/admin/scoring" component={ScoringAdmin} />
        {/* Task #4331 — deal stage automation rules (team_lead+). */}
        <Route path="/admin/deal-automation" component={DealAutomation} />
        <Route path="/admin/phase-settings" component={PhaseSettings} />
        <Route path="/clients/add" component={ClientAdd} />
        <Route path="/clients/:id" component={ClientDetail} />
        {/* Task #4327 — deals pipeline (kanban board + deal detail). */}
        <Route path="/deals" component={DealsBoard} />
        <Route path="/deals/:id" component={DealDetail} />
        {/* Task #4330 — leads view (lifecycle-gated prospects). */}
        <Route path="/leads" component={Leads} />
        {/* Task #4337 — campaigns & first-touch attribution (AM+). */}
        <Route path="/campaigns" component={Campaigns} />
        <Route path="/campaigns/:id" component={CampaignDetail} />
        <Route path="/reports/new" component={ReportForm} />
        <Route path="/reports/matrix" component={ReportMatrix} />
        <Route path="/reports/compare" component={ReportComparison} />
        <Route path="/analytics/trends" component={TrendAnalytics} />
        <Route path="/ceo/insights" component={CeoInsights} />
        <Route path="/churn" component={ChurnCommandCenter} />
        <Route path="/ceo/call-analysis" component={CallAnalysis} />
        <Route path="/ceo/ats" component={AtsAdmin} />
        <Route path="/ceo/webhook-logs" component={WebhookImportLogs} />
        <Route path="/admin/integrations" component={IntegrationsHub} />
        <Route path="/admin/book-operations" component={BookOperationsConsole} />
        <Route path="/admin/unmatched" component={UnmatchedCommunications} />
        <Route path="/admin/integrations/import-suggestions" component={ImportSuggestions} />
        <Route path="/admin/db-attribution/trends" component={DbAttributionTrends} />
        <Route path="/admin/semrush/cadence" component={SemrushCadence} />
        <Route path="/admin/backups" component={BackupsConsole} />
        <Route path="/admin/comms/webhooks" component={CommsWebhooks} />
        <Route path="/admin/comms/default-channels" component={CommsDefaultChannels} />
        <Route path="/admin/slack" component={SlackIntegration} />
        <Route path="/admin/slack/notifications" component={SlackNotificationsConsole} />
        <Route path="/admin/front" component={FrontIntegration} />
        <Route path="/admin/integrations/semrush" component={SemrushIntegration} />
        <Route path="/admin/zoom" component={ZoomIntegration} />
        <Route path="/admin/zoom/review" component={ZoomReviewQueue} />
        <Route path="/admin/zoom/match-assistant" component={ZoomMatchAssistant} />
        <Route path="/admin/clickup" component={ClickUpModule} />
        <Route path="/admin/service-desk" component={ServiceDeskSettings} />
        <Route path="/admin/role-assignments" component={RoleAssignments} />
        {/* Compatibility alias for bookmarks and historical Service Desk links. */}
        <Route path="/admin/service-desk/role-assignments" component={RoleAssignments} />
        <Route path="/admin/service-desk/home" component={ServiceDeskHome} />
        <Route path="/admin/service-desk/tickets" component={ServiceDeskHome} />
        <Route path="/admin/service-desk/reports" component={ServiceDeskReports} />
        <Route path="/service-desk/create" component={ServiceDeskCreate} />
        <Route path="/service-desk" component={ServiceDeskHome} />
        <Route path="/admin/service-desk/tickets/:taskId" component={ServiceDeskTicketDetail} />
        <Route path="/admin/twilio" component={TwilioAdmin} />
        <Route path="/admin/twilio/call-archive" component={CallArchiveStatus} />
        <Route path="/admin/sms-consent" component={SmsConsentAdmin} />
        <Route path="/admin/activity" component={ActivityDashboard} />
        <Route path="/admin/internal-usage" component={InternalUsage} />
        <Route path="/admin/rate-limits" component={RateLimitUsers} />
        <Route path="/admin/rate-limit-multipliers" component={RateLimitMultipliers} />
        <Route path="/admin/route-limiters">
          <Redirect to="/admin/system-health?tab=route-coverage" />
        </Route>
        <Route path="/admin/audit-retention">
          <Redirect to="/admin/system-health?tab=audit-retention" />
        </Route>
        <Route path="/admin/match-settings" component={MatchSettings} />
        <Route path="/admin/health">
          <Redirect to="/admin/system-health?tab=health" />
        </Route>
        <Route path="/admin/system-health" component={SystemHealthConsole} />
        <Route path="/admin/conversation-dedupe-conflicts" component={ConversationDedupeConflicts} />
        <Route path="/admin/feedback" component={FeedbackAdmin} />
        <Route path="/admin/ads-hygiene" component={GoogleAdsHygieneAudit} />
        {/* Legacy Ads OS retired (Task #3603) — the old /admin/ads-os port
            was replaced by the Ads OS rebuild at /ads-os. */}
        <Route path="/admin/ads-os">
          <Redirect to="/ads-os" />
        </Route>
        <Route path="/ads-os/am" component={AdsOsAmDashboard} />
        <Route path="/ads-os/proofs" component={AdsOsProofs} />
        <Route path="/ads-os/gads" component={AdsOsGads} />
        <Route path="/ads-os/lsa" component={AdsOsLsa} />
        <Route path="/ads-os/a/:cid/pacing" component={AdsOsBudgetPacing} />
        <Route path="/ads-os/lsa/a/:cid/pacing" component={AdsOsLsaPacing} />
        <Route path="/ads-os/a/:cid/audit" component={AdsOsAudit} />
        <Route path="/ads-os/audit/:cid" component={AdsOsAudit} />
        <Route path="/ads-os/lsa/a/:cid/hygiene" component={AdsOsLsaHygiene} />
        <Route path="/ads-os/a/:cid/analyzer" component={AdsOsAnalyzer} />
        <Route path="/ads-os/a/:cid/analyzer/negatives" component={AdsOsKeywordIntel} />
        <Route path="/ads-os/a/:cid/analyzer/keywords" component={AdsOsKeywordFinder} />
        <Route path="/ads-os/a/:cid/pyramid" component={AdsOsPyramid} />
        <Route path="/ads-os/client/:name" component={AdsOsClientProfile} />
        {/* Alias: the operators' morning dashboard is the Main Dashboard */}
        <Route path="/ads-os/dashboard" component={AdsOsMain} />
        <Route path="/ads-os" component={AdsOsMain} />
        <Route path="/profile" component={Profile} />
        <Route path="/notifications" component={Notifications} />
        <Route path="/sheets" component={SheetsLibrary} />
        <Route path="/sheets/dashboard/:id" component={SheetDashboard} />
        <Route path="/sheets/:id" component={SheetEditor} />
        <Route path="/docs/:id" component={DocEditor} />
        <Route path="/files" component={FilesLibrary} />
        {/* Task #4373 (audit §8.4-b): /conversations converged into /comms —
            redirect preserves every deep-link param (threadKey/convId/phone/
            contactName/clientId/intent) so old links keep their intent. */}
        <Route path="/conversations">
          {() => <Redirect to={legacyConversationsUrlToComms(window.location.search)} replace />}
        </Route>
        <Route path="/conversations/:rest*">
          {() => <Redirect to={legacyConversationsUrlToComms(window.location.search)} replace />}
        </Route>
        <Route path="/comms" component={Comms} />
        <Route path="/ris/:clientId" component={RisDashboard} />
        <Route path="/ris" component={RisDashboard} />
        <Route path="/apply/:token" component={CandidatePortal} />
        <Route path="/reports/:id" component={ReportForm} />
        <Route path="/preview/:reportId">{() => <PublicReport isPreview={true} />}</Route>
        <Route path="/share/:token" component={PublicReport} />
        <Route path="/book/cancel/:meetingId" component={PublicBookingCancel} />
        <Route path="/book/:slug/client/:signedToken" component={PublicBookingPage} />
        <Route path="/book/:slug" component={PublicBookingPage} />
        <Route path="/share/:token/print" component={PublicReportPrint} />
        <Route path="/pulse/:token/letter" component={CeoPulseLetter} />
        <Route path="/pulse/:token" component={PublicCeoPulse} />
        <Route path="/demo-report" component={DemoReport} />
        {/* Task #3728 — public company roadmap + its iframe-able embed variant. */}
        <Route path="/roadmap/embed">{() => <RoadmapPage embed />}</Route>
        <Route path="/roadmap">{() => <RoadmapPage />}</Route>
        <Route path="/admin/roadmap" component={RoadmapAdmin} />
        <Route path="/admin/outbound-email" component={OutboundEmailAdmin} />
        {/* Task #4335 — email templates + approval-gated sequences. */}
        <Route path="/admin/email-sequences" component={EmailSequencesAdmin} />
        <Route path="/admin/email-sequences/:id" component={EmailSequenceDetail} />
        <Route path="/mcu-checker" component={McuChecker} />
        <Route path="/mcu-dashboard" component={McuDashboard} />
        <Route component={NotFound} />
      </Switch>
      </AuthGate>
      </Suspense>
    </>
  );
}

function ActivityTrackerWrapper({ children }: { children: ReactNode }) {
  useActivityTracker();
  return <>{children}</>;
}

/**
 * Wraps ClerkProvider (needs wouter's useLocation for routerPush/routerReplace)
 * around QueryClientProvider so ClerkQueryClientCacheInvalidator can use
 * useQueryClient(), and both sit inside the same wouter router context.
 */
function ClerkAndQueryProvider() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        {/* Task #4377 — global theme (light/dark/system). Needs the query
            client (reads /api/auth/user, persists via PUT) and Clerk auth
            state; everything below renders theme-aware. */}
        <ThemeProvider>
          <TooltipProvider>
            <TitleProvider>
              <ActivityTrackerWrapper>
                <CommsProvider>
                  <Toaster />
                  {/* Task #4791 — single connection-lost / restored pill;
                      renders nothing while connectivity is fine. */}
                  <ConnectionStatusBanner />
                  <Router />
                </CommsProvider>
              </ActivityTrackerWrapper>
            </TitleProvider>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
function App() {
  useEffect(() => {
    clearAutoReloadGuard();
    // Task #2882 — the auth-loss redirect (dead session detected by a 401
    // from a query/mutation or the notification bell's SSE probe) sets a
    // sessionStorage marker just before reloading at "/". Surface the
    // explanation here, on the landed page, instead of a silent redirect.
    if (consumeSessionExpiredMarker()) {
      toast({
        title: "Your session expired",
        description: "Please sign in again to continue.",
      });
    }
  }, []);

  return (
    <GlobalErrorBoundary>
      <ClerkAndQueryProvider />
    </GlobalErrorBoundary>
  );
}

export default App;

const DealDetail = lazyWithRetry(() => import("@/pages/DealDetail"));

// NOTE: declared before `clerkAppearance`, which reads it during module
// evaluation (a later declaration is a load-time TDZ ReferenceError).
// typeof-guarded: import.meta.env exists under vite (dev + build define) but is
// undefined under tsx/jsdom test harnesses — a bare read crashes App import.
const basePath = (typeof import.meta.env !== "undefined" ? import.meta.env.BASE_URL : "/").replace(/\/$/, "");

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    // Canonical OS brand asset (Task #4618; client/public/brand/README.md) —
    // the old `/logo.svg` target never existed, so the auth card rendered no
    // logo at all.
    logoImageUrl: `${window.location.origin}${basePath}${BRAND_ASSET_PATHS.logo["full-color"]}`,
  },
  // Task #4618 — post-#4600 brand values. The auth card is pinned LIGHT in
  // both themes (a lifted paper artifact on the canvas, pairing with the
  // always-light full-color logo), so these stay literal light-token mirrors
  // (Clerk appearance takes concrete values, not CSS vars) written as hsl()
  // strings so the mirrored triplets read verbatim; keep in lockstep with
  // client/src/index.css `:root`.
  variables: {
    colorPrimary: "hsl(229 35% 44%)", // Liberty Blue — mirrors --primary
    colorForeground: "hsl(0 0% 20%)", // charcoal — mirrors --foreground
    colorMutedForeground: "hsl(0 0% 37%)", // mirrors --muted-foreground
    colorDanger: "hsl(0 74% 42%)", // mirrors --destructive (light block)
    colorBackground: "hsl(40 37% 97%)", // v2 Warm Paper — mirrors --card
    colorInput: "white", // inputs lift white off the warm-paper card
    colorInputForeground: "hsl(0 0% 20%)", // charcoal — mirrors --foreground
    colorNeutral: "hsl(40 25% 78%)", // warm neutral — mirrors --border
    fontFamily: "Montserrat, sans-serif", // mirrors --font-sans
    borderRadius: "0rem", // mirrors --radius — square corners (kit rule)
  },
  elements: {
    rootBox: "w-full flex justify-center",
    // bg matches colorBackground (v2 Warm Paper): cardBox carries it so the
    // card AND footer share one continuous surface. The card is pinned LIGHT
    // in both app themes, which needs two defenses in dark mode:
    //  1. Clerk's shadcn base theme paints some slots from OUR theme CSS
    //     vars (element-level rules that beat utility classes) — so the
    //     light-block values of every var Clerk consumes are re-declared ON
    //     the card; descendants inherit them regardless of html.dark
    //     (values = the light block in client/src/index.css; keep in
    //     lockstep if those tokens move).
    //  2. The legacy `.dark .{text,bg,border}-gray-*` remap in index.css
    //     restyles gray utilities app-wide — so the element classes below
    //     use warm token-derived hsl arbitrary values instead of gray-*
    //     (remap-immune, and truer to the brand's warm neutrals than
    //     Tailwind's cool grays). red/green-* are not remapped; the
    //     alert/success classes keep them.
    cardBox:
      "bg-[hsl(40_37%_97%)] w-[440px] max-w-full overflow-hidden shadow-lg" +
      " [--foreground:0_0%_20%] [--muted-foreground:0_0%_37%]" +
      " [--secondary-foreground:0_0%_20%] [--border:40_25%_78%]" +
      " [--input:40_25%_78%] [--ring:229_35%_44%]" +
      " [--card:40_37%_97%] [--popover:40_37%_97%]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(0_0%_20%)] font-semibold",
    headerSubtitle: "text-[hsl(0_0%_37%)]",
    socialButtonsBlockButtonText: "text-[hsl(0_0%_20%)] font-medium",
    formFieldLabel: "text-[hsl(0_0%_20%)] font-medium",
    footerActionLink: "text-primary-ink",
    footerActionText: "text-[hsl(0_0%_37%)]",
    dividerText: "text-[hsl(0_0%_37%)]",
    identityPreviewEditButton: "text-primary-ink",
    formFieldSuccessText: "text-green-600",
    alertText: "text-red-600",
    logoBox: "",
    logoImage: "h-9 w-auto",
    socialButtonsBlockButton:
      "border border-[hsl(40_25%_78%)] hover:bg-[hsl(40_37%_94%)]",
    formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground",
    formFieldInput: "border-[hsl(40_25%_78%)]",
    footerAction: "border-t border-[hsl(40_25%_85%)]",
    dividerLine: "bg-[hsl(40_25%_85%)]",
    alert: "bg-red-50 border border-red-200",
    otpCodeFieldInput: "border-[hsl(40_25%_78%)]",
    formFieldRow: "",
    main: "",
  },
};

// Optional-chained for non-Vite evaluators (see basePath note above).
const clerkProxyUrl = import.meta.env?.VITE_CLERK_PROXY_URL;

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

const SignUpPage = lazyWithRetry(() => import("@/pages/SignUp"));

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY,
);

const CampaignDetail = lazyWithRetry(() => import("@/pages/CampaignDetail"));
