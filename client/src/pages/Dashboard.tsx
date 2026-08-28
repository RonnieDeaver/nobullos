import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { reviewReasonLabel } from "@/lib/matchMethod";
import { DismissReasonDialog } from "@/components/DismissReasonDialog";
import { type DismissReason } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import {
  accountHealthContract,
  accountHealthStatusOptions,
  relationshipReadContract,
  relationshipReadOptions,
  isAccountHealthStatus,
  isRelationshipRead,
  type AccountRatingPresentation,
  type AccountHealthStatus,
  type RelationshipRead,
  type RatingTone,
} from "@shared/clientRating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { OsTable, type OsTableColumn, type OsTableSort } from "@/components/ui/os-table";
import { KpiCard } from "@/components/kit/KpiCard";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link, useLocation } from "wouter";
import {
  Building2, FileText, Bell, Sliders,
  Eye, Trash2, Copy, Phone,
  CheckCircle, Clock, AlertTriangle, MessageSquare, Mail, Video,
  Search, ShieldAlert,
  ChevronRight, CircleDot, Download, X, Filter, Info, Trophy
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { logActivity } from "@/hooks/use-activity-tracker";
import { differenceInDays, formatDistanceToNow, format } from "date-fns";
import { DashboardSkeleton, TableSkeleton } from "@/components/ui/skeleton-loaders";
import { TagChipRow, type TagChipData } from "@/components/tags/TagChip";
import { HideDemoToggle } from "@/components/HideDemoToggle";
import { useHideDemoAccounts } from "@/hooks/use-hide-demo-accounts";
import { partitionDemoAccounts } from "@/lib/demoAccounts";

// Task #2675 — Self-healing data loads for the main dashboard. Mirrors the
// Task #1625 pattern from `components/admin/health/DiagnosticCommandCenter.tsx`: per-query backoff retry
// on transient (5xx / network) failures, `meta.silent` so a recovered blip
// never flashes the global "Request failed" toast, and a status-carrying error
// type so a real 4xx (incl. 401 → the existing `handleAuthLoss` path in
// `queryClient.ts`) is NOT retried. The UI degrades to an inline, retryable
// per-section error instead of zeros / "Unknown" / "No clients yet" when only
// part of the page's data fails while the user stays authenticated.
import { EmptyState } from "@/components/kit/EmptyState";
import { BrandMark } from "@/components/kit/BrandMark";
class DashboardHttpError extends Error {
  status: number;
  // Task #2880 — milliseconds to wait before retrying (from Retry-After or
  // RateLimit-Reset response headers). Set only on 429 responses.
  retryAfterMs?: number;
  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`${status}: ${body}`);
    this.name = "DashboardHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Task #2880 — Parse the retry delay from express-rate-limit's standard
 * headers. express-rate-limit with standardHeaders:true sets:
 *   RateLimit-Reset: <epoch seconds when the window resets>
 * and may also set a standard Retry-After header in seconds (delta).
 * We prefer Retry-After (delta) when present, fall back to RateLimit-Reset
 * (epoch → delta). Returns undefined if neither header is present or parseable.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const delta = Number(retryAfter);
    if (Number.isFinite(delta) && delta > 0) {
      // delta seconds → milliseconds. No artificial cap: the server controls
      // the window length and the client should honor it exactly.
      return Math.ceil(delta * 1000);
    }
  }
  const rateLimitReset = headers.get("ratelimit-reset");
  if (rateLimitReset) {
    const epoch = Number(rateLimitReset);
    if (Number.isFinite(epoch) && epoch > 0) {
      const deltaMs = Math.ceil(epoch * 1000) - Date.now();
      if (deltaMs > 0) {
        // +500 ms buffer so the retry fires after the window has definitely
        // reset, not right at the boundary. No cap: honor the full server window.
        return deltaMs + 500;
      }
    }
  }
  return undefined;
}

async function fetchDashboardJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore unreadable error bodies */
    }
    // `401:`-prefixed message lets the shared QueryCache.onError route genuine
    // auth-loss to handleAuthLoss; other 4xx are terminal and not retried.
    // Task #2880: 429 carries a retryAfterMs so the retry delay can honor
    // the server's rate-limit window reset time instead of an arbitrary
    // exponential delay.
    const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers) : undefined;
    throw new DashboardHttpError(res.status, body || res.statusText, retryAfterMs);
  }
  return res.json() as Promise<T>;
}

function isDashboardNetworkError(error: unknown): boolean {
  // Browser network failures reject `fetch` with a TypeError ("Failed to
  // fetch" / "NetworkError" / Safari's "Load failed") — the transient class
  // this resilience is for.
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const m = error.message || "";
  return (
    m.includes("Failed to fetch") ||
    m.includes("NetworkError") ||
    m.includes("Load failed")
  );
}

function shouldRetryDashboardQuery(failureCount: number, error: unknown): boolean {
  // Up to 3 attempts total (initial + 2 retries).
  if (failureCount >= 2) return false;
  if (error instanceof DashboardHttpError) {
    // Task #2880: retry 429 once (after honoring the window reset delay).
    // The interactive api bucket is now larger and background polling is
    // separated, so a 429 is uncommon but recoverable.
    if (error.status === 429) return failureCount === 0;
    return error.status >= 500;
  }
  return isDashboardNetworkError(error);
}

function dashboardRetryDelay(attemptIndex: number, error: unknown): number {
  // Task #2880: for 429, honor the server's RateLimit-Reset / Retry-After
  // header so the retry fires as soon as the window resets — not sooner
  // (which would immediately 429 again) and not much later (which would
  // leave the user staring at blank sections longer than necessary).
  if (error instanceof DashboardHttpError && error.status === 429 && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  // 500ms, 1s, 2s … capped at 4s for transient 5xx / network errors.
  return Math.min(500 * 2 ** attemptIndex, 4000);
}

// Spread into each dashboard data query. `meta.silent` opts the query out of the
// global error toast (escape hatch already honored by QueryCache.onError); we
// own the error surface inline instead.
const DASHBOARD_QUERY_OPTIONS = {
  meta: { silent: true } as const,
  retry: shouldRetryDashboardQuery,
  retryDelay: dashboardRetryDelay,
};

type Client = {
  id: string;
  clientCode: string | null;
  firmName: string;
  contactName: string | null;
  ownerId: string | null;
};

type ClientSummary = {
  id: string;
  firmName: string;
  clientCode: string | null;
  contactName: string | null;
  /** Task #4363 — demo-account marker (same flag as the "Demo Account" badge). */
  isDemo?: boolean;
  products: string[];
  practiceAreas: string[];
  clientStartDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerAvatar: string | null;
  lastCommDate: string | null;
  commCount30d: number;
  commCountTotal: number;
  touchpointCount30d: number;
  touchpointCountTotal: number;
  lastTouchpointDate: string | null;
  judgmentStatus: string | null;
  relationshipHealth: string | null;
  judgmentHeadline: string | null;
  judgmentDate: string | null;
  judgmentConfidence: string | null;
  judgmentBasis: {
    tier: string | null;
    basedOn: string[];
    missing: string[];
    carriedForward: { fromDate: string | null } | null;
  } | null;
  /** Task #5123 — authoritative structured rating from the server judgment gate. */
  accountRating?: AccountRatingPresentation | null;
  lastReviewedAt: string | null;
  budgetPosture: string | null;
};

// Task #5123 — authoritative rating tooltip from AccountRatingPresentation,
// using accountHealthContract as the sole label/definition/provenance source.
// Falls back gracefully to the legacy judgmentBasis shape for older rows.
function judgmentBasisTooltip(c: ClientSummary): string | undefined {
  // Prefer the structured AccountRatingPresentation when present.
  const r = c.accountRating;
  if (r) {
    const parts: string[] = [];
    // Status definition from contract (authoritative).
    const contractEntry = isAccountHealthStatus(r.status) ? accountHealthContract[r.status] : null;
    if (contractEntry) parts.push(`Overall account health: ${contractEntry.label} — ${contractEntry.definition}`);
    // Risk score within range.
    if (r.riskScore !== null) {
      parts.push(`Risk score: ${r.riskScore} (range ${r.riskRange[0]}–${r.riskRange[1]})`);
    }
    // Primary drivers with provenance and freshness.
    if (r.primaryDrivers.length > 0) {
      const driverLines = r.primaryDrivers.map(d => {
        const age = d.ageDays !== null ? ` · ${d.ageDays}d ago` : "";
        const fresh = d.freshness !== "unknown" ? ` · ${d.freshness}` : "";
        return `${d.label} [${d.provenance}${age}${fresh}]`;
      });
      parts.push(`Drivers: ${driverLines.join(" · ")}`);
    }
    // Generation lineage.
    if (r.generation === "carried-forward" && r.lineage?.fromDate) {
      parts.push(`Carried forward from ${r.lineage.fromDate} (inputs unchanged)`);
    } else if (r.generation === "generated" && r.generatedAt) {
      parts.push(`Generated: ${r.generatedAt}`);
    }
    // Policy/revision provenance, followed by still-useful basis context.
    parts.push(`Policy v${r.policyVersion}${r.promptRevision ? ` · revision ${r.promptRevision}` : ""}`);
    if (c.judgmentBasis?.basedOn?.length) parts.push(`Based on: ${c.judgmentBasis.basedOn.join(" · ")}`);
    if (c.judgmentBasis?.missing?.length) parts.push(`Missing: ${c.judgmentBasis.missing.join(", ")}`);
    if (c.judgmentConfidence) parts.push(`Confidence: ${c.judgmentConfidence}`);
    return parts.join("\n");
  }
  // Legacy fallback: judgmentBasis shape (Task #3697).
  const parts: string[] = [];
  if (c.judgmentBasis?.basedOn?.length) parts.push(`Based on: ${c.judgmentBasis.basedOn.join(" · ")}`);
  if (c.judgmentBasis?.missing?.length) parts.push(`Missing: ${c.judgmentBasis.missing.join(", ")}`);
  if (c.judgmentConfidence) parts.push(`Confidence: ${c.judgmentConfidence}`);
  if (c.judgmentBasis?.carriedForward?.fromDate) {
    parts.push(`Carried forward from ${c.judgmentBasis.carriedForward.fromDate} (inputs unchanged)`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function hasLimitedJudgmentBasis(c: ClientSummary): boolean {
  // Prefer accountRating.basisTier when present.
  if (c.accountRating) return c.accountRating.basisTier === "operational";
  return c.judgmentBasis?.tier === "operational" || c.judgmentConfidence === "Low";
}

type Report = {
  id: string;
  clientId: string;
  reportMonth: string;
  status: string;
};

type ReviewCandidate = {
  clientId: string | null;
  clientName: string | null;
  confidenceScore: number | null;
};

type ReviewInfo = {
  decisionId: string;
  reviewReason: string | null;
  explanationSummary: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  suggestedConfidence: number | null;
  priorClientId: string | null;
  priorClientName: string | null;
  candidates: ReviewCandidate[];
};

type UnmatchedItem = {
  id: string;
  source: "front" | "slack" | "zoom";
  title: string;
  snippet: string;
  participants: string[];
  timestamp: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  matchConfidence: number | null;
  review?: ReviewInfo | null;
};

// ── Task #4874: cross-client Win Feed ────────────────────────────────────────
// Recent `win_progress` intel entries across every active client so the whole
// team sees wins, not just visitors to one client page. The server excludes
// archived clients and retracted entries; the demo flag comes back raw and
// the global hide-demo toggle filters here, mirroring Recent Reports.
// Task #4912 promoted the feed from a truncated sidebar card to the
// dashboard's FIRST full-width section. Task #5012 compacted that band into a
// tweet-feed-style single-column list inside a bounded-height scroller: every
// fetched win is reachable by scrolling the band, rows show a clamped body
// preview, and the full text lives in the All Wins dialog (and on the client
// page each row links to).

type RecentWin = {
  id: string;
  clientId: string;
  clientFirmName: string;
  clientIsDemo: boolean;
  title: string;
  body: string | null;
  createdAt: string | null;
  createdBy: string;
  authorFirstName: string | null;
  authorLastName: string | null;
  authorEmail: string | null;
};

function winAuthorName(win: RecentWin): string {
  const name = `${win.authorFirstName ?? ""} ${win.authorLastName ?? ""}`.trim();
  return name || win.authorEmail || "Unknown";
}

// Task #4917 — a single win tile used in both the feed band and the "all wins"
// dialog so styling stays in sync. Task #5012 split it into two variants:
//   "feed"   — compact timeline row: title, body preview clamped to 2 lines,
//              and the author · firm · time meta line. Rows sit in a
//              divider-separated single column inside the feed's
//              bounded-height scroller; the full text lives in the dialog and
//              on the client page the row links to.
//   "dialog" — the full-text card: complete body, no truncation or clamping
//              (the All Wins dialog is where wins are read in full).
function WinTile({
  win,
  variant = "feed",
}: {
  win: RecentWin;
  variant?: "feed" | "dialog";
}) {
  const meta = (
    <p className={`${variant === "dialog" ? "mt-3" : "mt-1.5"} text-xs text-muted-foreground break-words`}>
      <span className="font-medium text-foreground/80">{winAuthorName(win)}</span>
      {" · "}
      {win.clientFirmName}
      {win.clientIsDemo && (
        <span className="ml-1 rounded border border-border px-1 text-caption align-middle">demo</span>
      )}
      {win.createdAt && <> · {formatDistanceToNow(new Date(win.createdAt), { addSuffix: true })}</>}
    </p>
  );
  if (variant === "dialog") {
    return (
      <Link
        href={`/clients/${win.clientId}`}
        className="block min-w-0 p-4 border border-primary/10 bg-surface-warm-1 rounded hover:bg-primary/5 transition-colors"
        data-testid={`row-win-${win.id}`}
      >
        <p className="text-base font-semibold leading-snug text-foreground break-words">{win.title}</p>
        {win.body && (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">{win.body}</p>
        )}
        {meta}
      </Link>
    );
  }
  return (
    <Link
      href={`/clients/${win.clientId}`}
      className="block min-w-0 py-3 hover:bg-primary/5 transition-colors"
      data-testid={`row-win-${win.id}`}
    >
      <p className="text-sm font-semibold leading-snug text-foreground break-words">{win.title}</p>
      {win.body && (
        <p className="mt-1 text-sm leading-snug text-muted-foreground break-words line-clamp-2">{win.body}</p>
      )}
      {meta}
    </Link>
  );
}

// Task #4917 — dialog that lists the full win archive (up to 50 wins).
// Fetched lazily on first open so the dashboard's initial load is unaffected.
function AllWinsDialog({
  open,
  onOpenChange,
  hideDemo,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hideDemo: boolean;
}) {
  const { data: allWins, isLoading, isFetching, error, refetch } = useQuery<RecentWin[]>({
    queryKey: ["/api/dashboard/wins", "all"],
    queryFn: () => fetchDashboardJson<RecentWin[]>("/api/dashboard/wins?limit=50"),
    enabled: open,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  const wins = (allWins ?? []).filter((w) => !hideDemo || !w.clientIsDemo);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl w-full max-h-[90vh] flex flex-col p-0"
        data-testid="dialog-all-wins"
      >
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">
              <Trophy className="w-4 h-4 text-primary" />
            </span>
            All Wins
          </DialogTitle>
          <DialogDescription>
            Every logged win across all accounts, newest first.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="all-wins-loading">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="p-4 bg-surface-warm-1 rounded animate-pulse space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded" />
                  <div className="h-3 w-full bg-muted rounded" />
                  <div className="h-3 w-1/2 bg-muted rounded" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="py-8 text-center" data-testid="all-wins-error" role="alert">
              <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-destructive" />
              <p className="text-sm text-muted-foreground mb-3">Couldn't load the win archive.</p>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? "Retrying..." : "Retry"}
              </Button>
            </div>
          ) : wins.length === 0 ? (
            <p className="py-8 text-sm text-center text-muted-foreground" data-testid="text-no-wins-all">
              No wins yet — log one from a client's Intelligence Feed and it shows up here.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {wins.map((win) => (
                <WinTile key={win.id} win={win} variant="dialog" />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WinFeedCard({ hideDemo }: { hideDemo: boolean }) {
  const [allWinsOpen, setAllWinsOpen] = useState(false);

  const { data: wins, isLoading, isFetching, error, refetch } = useQuery<RecentWin[]>({
    queryKey: ["/api/dashboard/wins"],
    queryFn: () => fetchDashboardJson<RecentWin[]>("/api/dashboard/wins?limit=20"),
    ...DASHBOARD_QUERY_OPTIONS,
  });

  const filteredWins = (wins ?? []).filter((w) => !hideDemo || !w.clientIsDemo);
  // Task #5012 — every fetched win renders inside the bounded-height scroller
  // (the old 6-desktop/3-mobile tile caps and the mobile-only bottom button
  // are gone), so the header "See all wins" affordance follows one simple
  // rule: shown whenever any win survives the demo filter. The dialog is the
  // full-text reading surface for the clamped row previews below.
  const hasWins = filteredWins.length > 0;

  return (
    <>
      <AllWinsDialog open={allWinsOpen} onOpenChange={setAllWinsOpen} hideDemo={hideDemo} />
      <Card className="bg-card border-primary/10" data-testid="card-win-feed">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-lg font-semibold text-foreground flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">
                <Trophy className="w-4 h-4 text-primary" />
              </span>
              Win Feed
            </CardTitle>
            {hasWins && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground shrink-0 h-7 px-2"
                onClick={() => setAllWinsOpen(true)}
                data-testid="button-see-all-wins"
              >
                See all wins
                <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
              </Button>
            )}
          </div>
          <CardDescription className="mt-1">
            Recent wins across all accounts — logged from each client's Intelligence Feed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4" data-testid="win-feed-loading">
              {[0, 1, 2].map((i) => (
                <div key={i} className="animate-pulse space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded" />
                  <div className="h-3 w-full bg-muted rounded" />
                  <div className="h-3 w-1/3 bg-muted rounded" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="py-4 text-center" data-testid="win-feed-error" role="alert">
              <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-destructive" />
              <p className="text-sm text-muted-foreground mb-2">Couldn't load the win feed.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => refetch()}
                disabled={isFetching}
                data-testid="button-retry-win-feed"
              >
                {isFetching ? "Retrying..." : "Retry"}
              </Button>
            </div>
          ) : !hasWins ? (
            <p className="text-sm text-foreground" data-testid="text-no-wins">
              No wins yet — log one from a client's Intelligence Feed and it shows up here for the whole team.
            </p>
          ) : (
            // Task #5012 — the compact band: one modest bounded-height scroll
            // area holding a single-column, divider-separated timeline. All
            // fetched wins (up to the 20 the endpoint returns) are reachable
            // by scrolling on every viewport width.
            <div
              className="max-h-80 overflow-y-auto overscroll-contain pr-1 divide-y divide-border/60"
              data-testid="win-feed-scroll"
            >
              {filteredWins.map((win) => (
                <WinTile key={win.id} win={win} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const SOURCE_ICONS: Record<string, typeof Mail> = { front: Mail, slack: MessageSquare, zoom: Video };
const SOURCE_COLORS: Record<string, string> = { front: "text-blue-600 dark:text-blue-400", slack: "text-purple-600 dark:text-purple-400", zoom: "text-indigo-600 dark:text-indigo-400" };

function UnmatchedCommsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [openReviewId, setOpenReviewId] = useState<string | null>(null);
  const [pendingDecisionId, setPendingDecisionId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ items: UnmatchedItem[]; totalCount: number; needsReviewCount?: number; countsBySource?: { front: number; slack: number; zoom: number }; clients: Array<{ id: string; firmName: string }> }>({
    queryKey: ["/api/integrations/unmatched-feed"],
    refetchInterval: 60000,
  });

  const reviewApprove = useMutation({
    mutationFn: async ({ decisionId, clientId }: { decisionId: string; clientId?: string }) => {
      setPendingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/approve`, {
        approvedClientId: clientId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Attribution applied", description: "Zoom call routed to client." });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setPendingDecisionId(null);
      setOpenReviewId(null);
    },
    onError: (err: any) => {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
      setPendingDecisionId(null);
    },
  });

  const [dismissTarget, setDismissTarget] = useState<string | null>(null);
  const reviewDismiss = useMutation({
    mutationFn: async ({ decisionId, reason, reasonNote }: { decisionId: string; reason: DismissReason; reasonNote?: string }) => {
      setPendingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/dismiss`, {
        reason,
        reasonNote,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Left unattributed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setPendingDecisionId(null);
      setOpenReviewId(null);
      setDismissTarget(null);
    },
    onError: (err: any) => {
      toast({ title: "Dismiss failed", description: err.message, variant: "destructive" });
      setPendingDecisionId(null);
    },
  });

  const items = data?.items?.slice(0, 5) || [];
  const totalCount = data?.totalCount ?? data?.items?.length ?? 0;
  const needsReviewCount = data?.needsReviewCount ?? 0;
  const countsBySource = data?.countsBySource;

  if (isLoading || totalCount === 0) return null;

  return (
    <Card className="bg-card border-amber-200 dark:border-amber-800" data-testid="card-unmatched-comms">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium text-amber-700 dark:text-amber-300 flex items-center gap-2 min-w-0">
            <Mail className="w-4 h-4 shrink-0" />
            <span className="truncate">Unmatched Communications</span>
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {countsBySource && (countsBySource.front + countsBySource.slack + countsBySource.zoom) > 0 && (
              <div className="flex items-center gap-1 flex-wrap" data-testid="group-counts-by-source-dashboard">
                {/* #695: each chip deep-links to the IntegrationsHub feed
                    pre-filtered to that source so reviewers can jump from
                    "Zoom is backed up" straight to a Zoom-only feed. */}
                <Link
                  href="/admin/integrations?source=front"
                  className="inline-flex items-center gap-1 text-caption font-medium px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/25 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/40 cursor-pointer"
                  data-testid="chip-source-front-dashboard"
                  title="Filter unmatched feed to Front emails"
                >
                  <Mail className="w-2.5 h-2.5" />
                  {countsBySource.front.toLocaleString()}
                </Link>
                <Link
                  href="/admin/integrations?source=slack"
                  className="inline-flex items-center gap-1 text-caption font-medium px-1.5 py-0.5 rounded-full bg-purple-50 dark:bg-purple-950/25 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/40 cursor-pointer"
                  data-testid="chip-source-slack-dashboard"
                  title="Filter unmatched feed to Slack messages"
                >
                  <MessageSquare className="w-2.5 h-2.5" />
                  {countsBySource.slack.toLocaleString()}
                </Link>
                <Link
                  href="/admin/integrations?source=zoom"
                  className="inline-flex items-center gap-1 text-caption font-medium px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/25 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 cursor-pointer"
                  data-testid="chip-source-zoom-dashboard"
                  title="Filter unmatched feed to Zoom recordings"
                >
                  <Video className="w-2.5 h-2.5" />
                  {countsBySource.zoom.toLocaleString()}
                </Link>
              </div>
            )}
            {needsReviewCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-caption font-medium px-1.5 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-950/35 text-yellow-800 dark:text-yellow-300 border border-yellow-300 dark:border-yellow-800 whitespace-nowrap"
                data-testid="chip-needs-review-dashboard"
                title="Zoom items needing policy review"
              >
                <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                {needsReviewCount.toLocaleString()} needs review
              </span>
            )}
            <Link href="/admin/integrations">
              <span className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 cursor-pointer font-medium whitespace-nowrap">View all ({totalCount.toLocaleString()})</span>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => {
          const Icon = SOURCE_ICONS[item.source] || Mail;
          const color = SOURCE_COLORS[item.source] || "text-muted-foreground";
          const review = item.review;
          const cardKey = `${item.source}-${item.id}`;
          const isOpen = openReviewId === cardKey;
          const isPending = !!review && pendingDecisionId === review.decisionId;
          return (
            <div key={cardKey} className="rounded hover:bg-amber-50 dark:hover:bg-amber-950/25 text-sm" data-testid={`unmatched-item-${item.source}-${item.id}`}>
              <div className="flex items-center gap-2 p-2">
                <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium text-xs">{item.title}</p>
                  {review ? (
                    <p className="text-caption text-yellow-700 dark:text-yellow-300 truncate" data-testid={`text-review-reason-${item.source}-${item.id}`}>
                      {reviewReasonLabel(review.reviewReason)}
                      {review.suggestedClientName && (
                        <> · → {review.suggestedClientName}</>
                      )}
                    </p>
                  ) : item.suggestedClientName ? (
                    <p className="text-caption text-blue-600 dark:text-blue-400 truncate">→ {item.suggestedClientName}</p>
                  ) : null}
                </div>
                {review && (
                  <Badge
                    variant="outline"
                    className="bg-yellow-50 dark:bg-yellow-950/25 text-yellow-800 dark:text-yellow-300 border-yellow-300 dark:border-yellow-800 text-caption cursor-pointer h-5 px-1.5"
                    title={reviewReasonLabel(review.reviewReason)}
                    onClick={() => setOpenReviewId(isOpen ? null : cardKey)}
                    data-testid={`badge-needs-review-${item.source}-${item.id}`}
                  >
                    <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
                    Needs review
                  </Badge>
                )}
              </div>
              {review && isOpen && (
                <div className="border-t border-yellow-200 dark:border-yellow-800 bg-yellow-50/60 dark:bg-yellow-950/20 px-3 py-2 space-y-2" data-testid={`review-panel-${item.source}-${item.id}`}>
                  {review.explanationSummary && (
                    <p className="text-caption text-yellow-900 dark:text-yellow-200">{review.explanationSummary}</p>
                  )}
                  {review.priorClientName && (
                    <p className="text-caption text-yellow-800 dark:text-yellow-300">
                      <span className="font-medium">Was attributed to:</span> {review.priorClientName}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {review.suggestedClientId && (
                      <Button
                        size="sm"
                        className="h-6 px-2 text-caption bg-yellow-600 hover:bg-yellow-700 text-white"
                        disabled={isPending}
                        onClick={() => reviewApprove.mutate({ decisionId: review.decisionId })}
                        data-testid={`button-review-accept-${item.source}-${item.id}`}
                      >
                        Accept {review.suggestedClientName ?? "suggestion"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-caption text-yellow-800 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-900/40"
                      disabled={isPending}
                      onClick={() => setDismissTarget(review.decisionId)}
                      data-testid={`button-review-dismiss-${item.source}-${item.id}`}
                    >
                      Leave unattributed
                    </Button>
                  </div>
                  {review.candidates.length > 0 && (
                    <div>
                      <p className="text-caption uppercase font-medium text-yellow-700 dark:text-yellow-300 mb-1">Reroute to</p>
                      <div className="flex flex-wrap gap-1">
                        {review.candidates.slice(0, 5).map((c, idx) => (
                          c.clientId ? (
                            <Button
                              key={`${cardKey}-cand-${idx}`}
                              size="sm"
                              variant="outline"
                              className="h-5 px-1.5 text-caption border-yellow-300 dark:border-yellow-800 text-yellow-900 dark:text-yellow-200 hover:bg-yellow-100 dark:hover:bg-yellow-900/40"
                              disabled={isPending}
                              onClick={() => reviewApprove.mutate({ decisionId: review.decisionId, clientId: c.clientId! })}
                              data-testid={`button-review-route-${item.source}-${item.id}-${idx}`}
                            >
                              {c.clientName || c.clientId}
                              {c.confidenceScore != null && (
                                <span className="ml-1 text-yellow-600 dark:text-yellow-400">{Math.round(c.confidenceScore * 100)}%</span>
                              )}
                            </Button>
                          ) : null
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
      <DismissReasonDialog
        open={dismissTarget !== null}
        onOpenChange={(open) => !open && setDismissTarget(null)}
        isPending={reviewDismiss.isPending}
        onConfirm={(reason, note) => {
          if (dismissTarget) {
            reviewDismiss.mutate({ decisionId: dismissTarget, reason, reasonNote: note });
          }
        }}
      />
    </Card>
  );
}

const HEALTH_STYLE_BY_TONE: Record<RatingTone, {
  color: string;
  bg: string;
  icon: typeof CheckCircle;
}> = {
  healthy: { color: "text-green-700 dark:text-green-300", bg: "bg-green-100 dark:bg-green-950/35", icon: CheckCircle },
  watch: { color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-100 dark:bg-amber-950/35", icon: Clock },
  "at-risk": { color: "text-orange-700 dark:text-orange-300", bg: "bg-orange-100 dark:bg-orange-950/35", icon: AlertTriangle },
  critical: { color: "text-red-700 dark:text-red-300", bg: "bg-red-100 dark:bg-red-950/35", icon: ShieldAlert },
};

const HEALTH_CONFIG = Object.fromEntries(
  accountHealthStatusOptions.map(status => [
    status,
    {
      ...HEALTH_STYLE_BY_TONE[accountHealthContract[status].tone],
      label: accountHealthContract[status].label,
    },
  ]),
) as Record<AccountHealthStatus, {
  color: string;
  bg: string;
  icon: typeof CheckCircle;
  label: string;
}>;

const RELATIONSHIP_STYLE_BY_RANK: Record<number, { color: string; bg: string }> = {
  3: { color: "text-green-700 dark:text-green-300", bg: "bg-green-50 dark:bg-green-950/25" },
  2: { color: "text-blue-700 dark:text-blue-300", bg: "bg-blue-50 dark:bg-blue-950/25" },
  1: { color: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-950/25" },
  0: { color: "text-red-700 dark:text-red-300", bg: "bg-red-50 dark:bg-red-950/25" },
};

const RELATIONSHIP_CONFIG = Object.fromEntries(
  relationshipReadOptions.map(status => [
    status,
    RELATIONSHIP_STYLE_BY_RANK[relationshipReadContract[status].severityRank],
  ]),
) as Record<RelationshipRead, { color: string; bg: string }>;

const PRODUCT_LABELS: Record<string, string> = {
  gbp: "GBP",
  google_ads: "Google Ads",
  lsa: "LSA",
  google_ads_lsa: "Ads/LSA",
  webinar: "Webinar",
  webinars: "Webinar",
};

// Task #5123 — rel_strained / rel_at_risk let operators filter by relationship
// read, separate from the overall-account-health policy-rating quick-filter
// chips. The two filter dimensions are independent: one health chip and one
// relationship chip can be active simultaneously. AccountHealthFilter covers the
// policy-rating axis (renamed "Overall account health" in all labels); RelFilter
// covers the relationship-health axis.
type AccountHealthFilter = "all" | "critical" | "at_risk" | "watch" | "healthy" | "silent" | "overdue_review" | "no_data";
type RelFilter = "all" | "rel_strained" | "rel_at_risk";

const STATUS_ORDER = Object.fromEntries(
  accountHealthStatusOptions.map(status => [status, accountHealthContract[status].severityRank]),
) as Record<AccountHealthStatus, number>;

// Task #4994 — Relationship column sort: worst first on ascending, mirroring
// the overall-health (STATUS_ORDER) convention; clients with no relationship
// read sink to the bottom.
const RELATIONSHIP_ORDER = Object.fromEntries(
  relationshipReadOptions.map(status => [status, relationshipReadContract[status].severityRank]),
) as Record<RelationshipRead, number>;

// Task #4362 — mobile triage ranking: worst first. Never-judged accounts sit
// between Watch and Healthy (they deserve a look, but below accepted negative
// evidence).
const UNJUDGED_TRIAGE_RANK = 3;
/** How many worst-first cards the phone view leads with before "Show all". */
const MOBILE_TRIAGE_COUNT = 8;

function safeDate(val: string | null): Date | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function isReviewedThisMonth(lastReviewedAt: string | null): boolean {
  if (!lastReviewedAt) return false;
  const parsed = safeDate(lastReviewedAt);
  if (!parsed) return false;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  return parsed >= monthStart;
}

function getFreshnessBadge(lastReviewedAt: string | null) {
  if (!lastReviewedAt) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-caption font-medium bg-muted text-muted-foreground">
        <Clock className="w-2.5 h-2.5" />
        None
      </span>
    );
  }
  if (isReviewedThisMonth(lastReviewedAt)) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-caption font-medium bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300">
        <CheckCircle className="w-2.5 h-2.5" />
        Reviewed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-caption font-medium bg-red-100 dark:bg-red-950/35 text-red-700 dark:text-red-300">
      <AlertTriangle className="w-2.5 h-2.5" />
      Due
    </span>
  );
}

function getFreshnessLabel(lastReviewedAt: string | null): string {
  if (!lastReviewedAt) return "None";
  if (isReviewedThisMonth(lastReviewedAt)) return "Reviewed";
  return "Due";
}

function isOverdueReview(lastReviewedAt: string | null): boolean {
  return !isReviewedThisMonth(lastReviewedAt);
}

function isSilent(touchpointCount30d: number): boolean {
  return touchpointCount30d === 0;
}

function exportToCsv(summaries: ClientSummary[]) {
  // Task #5123 — "Overall account health" replaces "Performance" everywhere
  // (column header, CSV, filters, mobile label) while Relationship stays a
  // separate dimension.
  const headers = ["Firm Name", "Client Code", "Contact", "Overall account health", "Relationship", "Last Touchpoint", "30d Touchpoints", "Total Touchpoints", "Last Contact", "30d Comms", "Total Comms", "Services", "Review Status", "Owner"];

  const rows = summaries.map(c => {
    const row = [
      c.firmName,
      c.clientCode || "",
      c.contactName || "",
      c.judgmentStatus || "No data",
      c.relationshipHealth || "",
      c.lastTouchpointDate ? format(new Date(c.lastTouchpointDate), "yyyy-MM-dd") : "None",
      String(c.touchpointCount30d),
      String(c.touchpointCountTotal),
      c.lastCommDate ? format(new Date(c.lastCommDate), "yyyy-MM-dd") : "None",
      String(c.commCount30d),
      String(c.commCountTotal),
      c.products.map(p => PRODUCT_LABELS[p] || p).join(", "),
      getFreshnessLabel(c.lastReviewedAt),
      c.ownerName || "",
    ];
    return row;
  });

  const csvContent = [headers, ...rows].map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `client-dashboard-${format(new Date(), "yyyy-MM-dd")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Task #5123 — overall-account-health and relationship chips are two independent
// groups. ACCOUNT_HEALTH_FILTERS covers the policy-rating axis (labeled "Overall
// account health" in all rendered surfaces); RELATIONSHIP_FILTERS covers the
// sentiment axis. Selecting one chip from each group ANDs the conditions.
const ACCOUNT_HEALTH_FILTERS: Array<{ key: AccountHealthFilter; label: string; color: string; activeColor: string }> = [
  { key: "all", label: "All", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "critical", label: "Critical", color: "bg-red-50 dark:bg-red-950/25 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40", activeColor: "bg-red-600 text-white" },
  { key: "at_risk", label: "At Risk", color: "bg-orange-50 dark:bg-orange-950/25 text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40", activeColor: "bg-orange-600 text-white" },
  { key: "watch", label: "Watch", color: "bg-amber-50 dark:bg-amber-950/25 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40", activeColor: "bg-amber-600 text-white" },
  { key: "healthy", label: "Healthy", color: "bg-green-50 dark:bg-green-950/25 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40", activeColor: "bg-green-600 text-white" },
  { key: "silent", label: "Silent 30d+", color: "bg-purple-50 dark:bg-purple-950/25 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/40", activeColor: "bg-purple-600 text-white" },
  { key: "overdue_review", label: "Review Due", color: "bg-rose-50 dark:bg-rose-950/25 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40", activeColor: "bg-rose-600 text-white" },
  { key: "no_data", label: "No Account Health Data", color: "bg-muted/50 text-muted-foreground hover:bg-muted", activeColor: "bg-gray-500 text-white" },
];

// Task #5001 — relationship filter chips. "All Rel." clears the relationship
// filter while leaving the active performance chip untouched.
const RELATIONSHIP_FILTERS: Array<{ key: RelFilter; label: string; color: string; activeColor: string }> = [
  { key: "all", label: "All Rel.", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "rel_strained", label: "Rel: Strained", color: "bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40", activeColor: "bg-amber-700 text-white" },
  { key: "rel_at_risk", label: "Rel: At Risk", color: "bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40", activeColor: "bg-red-700 text-white" },
];

function getMyClientsPrefKey(userId?: string) {
  return `dashboard-show-my-clients${userId ? `:${userId}` : ""}`;
}

function OwnerTag({ ownerName, ownerAvatar, isCurrentUser }: { ownerName: string; ownerAvatar?: string | null; isCurrentUser: boolean }) {
  const [imgError, setImgError] = useState(false);
  const isEmail = ownerName.includes("@");
  const label = isCurrentUser ? "YOU" : isEmail ? ownerName.split("@")[0].toUpperCase() : (ownerName.split(" ")[0] || ownerName).toUpperCase();
  const initials = isEmail
    ? ownerName[0].toUpperCase()
    : ownerName.split(" ").map(n => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);

  const showAvatar = ownerAvatar && !imgError;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-caption font-bold tracking-wide ${
        isCurrentUser
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground"
      }`}
      data-testid={isCurrentUser ? "tag-owner-you" : "tag-owner-other"}
    >
      {showAvatar ? (
        <img src={ownerAvatar} alt="" className="w-4 h-4 rounded-full object-cover" onError={() => setImgError(true)} />
      ) : (
        <span className={`w-4 h-4 rounded-full flex items-center justify-center text-caption font-bold ${
          isCurrentUser
            ? "bg-primary/25 text-primary"
            : "bg-muted-foreground/20 text-foreground"
        }`}>{initials}</span>
      )}
      {label}
    </span>
  );
}

function ClientCRMTable({ summaries, currentUserId, isAccountManager }: { summaries: ClientSummary[]; currentUserId?: string; isAccountManager?: boolean }) {
  const [, navigate] = useLocation();
  // Task #4362 — OsTable runs in controlled-sort mode: this component owns
  // the order, so the CSV export always matches the visible ranking.
  const [sort, setSort] = useState<OsTableSort | null>({ key: "firmName", direction: "asc" });
  const [showAllMobile, setShowAllMobile] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Task #5001 — two independent filter axes so operators can combine one
  // performance chip and one relationship chip simultaneously.
  const [perfFilter, setPerfFilter] = useState<AccountHealthFilter>("all");
  const [relFilter, setRelFilter] = useState<RelFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");

  // Task #4329 — one table-level query powers every row's chips + the filter.
  const clientTagsQuery = useQuery<{
    tags: TagChipData[];
    assignments: { tagId: string; entityId: string; source: "manual" | "rule" }[];
  }>({ queryKey: ["/api/tags?entityType=client&includeAssignments=1"] });

  const tagsByClient = useMemo(() => {
    const map = new Map<string, TagChipData[]>();
    const tagById = new Map((clientTagsQuery.data?.tags ?? []).map((t) => [t.id, t]));
    for (const a of clientTagsQuery.data?.assignments ?? []) {
      const tag = tagById.get(a.tagId);
      if (!tag) continue;
      const list = map.get(a.entityId) ?? [];
      if (!list.some((t) => t.id === tag.id)) {
        list.push({ id: tag.id, name: tag.name, color: tag.color, source: a.source });
      }
      map.set(a.entityId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [clientTagsQuery.data]);
  const prefKey = getMyClientsPrefKey(currentUserId);
  const [showMyClientsOnly, setShowMyClientsOnly] = useState(() => {
    const stored = localStorage.getItem(prefKey);
    if (stored !== null) return stored === "true";
    return !!isAccountManager;
  });

  useEffect(() => {
    localStorage.setItem(prefKey, String(showMyClientsOnly));
  }, [showMyClientsOnly, prefKey]);

  const owners = useMemo(() => {
    const map = new Map<string, { name: string; avatar: string | null }>();
    summaries.forEach(c => {
      if (c.ownerName && c.ownerId) map.set(c.ownerId, { name: c.ownerName, avatar: c.ownerAvatar });
    });
    const sorted = Array.from(map.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
    if (currentUserId) {
      const myIdx = sorted.findIndex(([id]) => id === currentUserId);
      if (myIdx > 0) {
        const [me] = sorted.splice(myIdx, 1);
        sorted.unshift(me);
      }
    }
    return sorted;
  }, [summaries, currentUserId]);

  const filtered = useMemo(() => {
    let list = summaries;

    if (showMyClientsOnly && currentUserId) {
      list = list.filter(c => c.ownerId === currentUserId);
    }

    // Task #5001 — performance and relationship filters are independent axes:
    // both conditions must be satisfied (AND). Selecting "Watch" + "Rel: Strained"
    // shows clients who are both Watch AND Strained simultaneously.
    if (perfFilter !== "all") {
      list = list.filter(c => {
        switch (perfFilter) {
          case "critical": return c.judgmentStatus === "Critical";
          case "at_risk": return c.judgmentStatus === "At Risk";
          case "watch": return c.judgmentStatus === "Watch";
          case "healthy": return c.judgmentStatus === "Healthy";
          case "silent": return isSilent(c.touchpointCount30d);
          case "overdue_review": return isOverdueReview(c.lastReviewedAt);
          case "no_data": return !c.judgmentStatus;
          default: return true;
        }
      });
    }

    if (relFilter !== "all") {
      list = list.filter(c => {
        switch (relFilter) {
          case "rel_strained": return c.relationshipHealth === "Strained";
          case "rel_at_risk": return c.relationshipHealth === "At Risk";
          default: return true;
        }
      });
    }

    if (ownerFilter !== "all") {
      list = list.filter(c => c.ownerId === ownerFilter);
    }

    if (tagFilter !== "all") {
      list = list.filter(c => (tagsByClient.get(c.id) ?? []).some(t => t.id === tagFilter));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c =>
        c.firmName.toLowerCase().includes(q) ||
        c.contactName?.toLowerCase().includes(q) ||
        c.clientCode?.toLowerCase().includes(q) ||
        c.ownerName?.toLowerCase().includes(q)
      );
    }

    return list;
  }, [summaries, searchQuery, perfFilter, relFilter, ownerFilter, showMyClientsOnly, currentUserId, tagFilter, tagsByClient]);

  // Column-keyed comparators for the controlled OsTable sort. In controlled
  // mode the table never reorders rows itself, so this is the one place the
  // visible order (and the CSV export, which reads `sorted`) comes from.
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const cmp = (a: ClientSummary, b: ClientSummary): number => {
      switch (sort.key) {
        case "firmName":
          return a.firmName.localeCompare(b.firmName);
        case "ownerName":
          return (a.ownerName || "").localeCompare(b.ownerName || "");
        case "judgmentStatus": {
          const aOrder = isAccountHealthStatus(a.judgmentStatus) ? STATUS_ORDER[a.judgmentStatus] : 5;
          const bOrder = isAccountHealthStatus(b.judgmentStatus) ? STATUS_ORDER[b.judgmentStatus] : 5;
          return aOrder - bOrder;
        }
        case "relationshipHealth": {
          const aOrder = isRelationshipRead(a.relationshipHealth) ? RELATIONSHIP_ORDER[a.relationshipHealth] : 5;
          const bOrder = isRelationshipRead(b.relationshipHealth) ? RELATIONSHIP_ORDER[b.relationshipHealth] : 5;
          return aOrder - bOrder;
        }
        case "lastTouchpointDate":
          return (safeDate(a.lastTouchpointDate)?.getTime() ?? 0) - (safeDate(b.lastTouchpointDate)?.getTime() ?? 0);
        case "touchpointCount30d":
          return a.touchpointCount30d - b.touchpointCount30d;
        case "touchpointCountTotal":
          return a.touchpointCountTotal - b.touchpointCountTotal;
        case "commCount30d":
          return a.commCount30d - b.commCount30d;
        case "commCountTotal":
          return a.commCountTotal - b.commCountTotal;
        case "lastReviewedAt":
          return (safeDate(a.lastReviewedAt)?.getTime() ?? 0) - (safeDate(b.lastReviewedAt)?.getTime() ?? 0);
        default:
          return 0;
      }
    };
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => dir * cmp(a, b));
  }, [filtered, sort]);

  // Task #4362 — mobile triage ranking, independent of the table sort (the
  // table is hidden below md): worst accounts first so the phone view leads
  // with signal instead of an alphabetical wall.
  const triaged = useMemo(() => {
    const rank = (c: ClientSummary) =>
      isAccountHealthStatus(c.judgmentStatus)
        ? c.judgmentStatus === "Healthy"
          ? UNJUDGED_TRIAGE_RANK + 1
          : accountHealthContract[c.judgmentStatus].severityRank
        : UNJUDGED_TRIAGE_RANK;
    return [...filtered].sort((a, b) =>
      (rank(a) - rank(b)) ||
      (Number(isSilent(b.touchpointCount30d)) - Number(isSilent(a.touchpointCount30d))) ||
      (Number(isOverdueReview(b.lastReviewedAt)) - Number(isOverdueReview(a.lastReviewedAt))) ||
      a.firmName.localeCompare(b.firmName)
    );
  }, [filtered]);

  // Task #5001 — count both independent filter axes separately so "Clear (N)"
  // accurately reflects each active constraint (performance + relationship).
  const activeFilterCount = (perfFilter !== "all" ? 1 : 0) + (relFilter !== "all" ? 1 : 0) + (ownerFilter !== "all" ? 1 : 0) + (searchQuery.trim() ? 1 : 0) + (showMyClientsOnly ? 1 : 0) + (tagFilter !== "all" ? 1 : 0);

  const clearFilters = useCallback(() => {
    setPerfFilter("all");
    setRelFilter("all");
    setOwnerFilter("all");
    setSearchQuery("");
    setShowMyClientsOnly(false);
    setTagFilter("all");
  }, []);

  // Task #4362 — OsTable column model. Cells are single-line (nowrap-safe)
  // so the table stays valid if the portfolio ever crosses the row-
  // virtualization threshold; overflow detail moves into native `title`
  // tooltips, and the header tooltips + Legend popover decode the columns.
  const columns = useMemo<Array<OsTableColumn<ClientSummary>>>(() => [
    {
      key: "firmName",
      header: <span title="Account and client code — click a name to open the client workspace.">Client</span>,
      sortable: true,
      width: 230,
      cell: (c) => (
        <Link href={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>
          <span
            className="flex min-w-0 cursor-pointer items-center gap-1.5"
            title={c.contactName ? `${c.firmName} — ${c.contactName}` : c.firmName}
          >
            <span className="truncate font-medium text-foreground transition-colors hover:text-primary-ink" data-testid={`text-firm-${c.id}`}>
              {c.firmName}
            </span>
            {c.clientCode && <span className="shrink-0 font-mono text-caption text-muted-foreground">{c.clientCode}</span>}
          </span>
        </Link>
      ),
    },
    // Task #5123 — the former combined "Health" column remains split into two
    // explicitly labeled signals: "Overall account health" (the policy rating
    // badge + limited-data note) and "Relationship" (how the client feels
    // about us). Widths sum to roughly the old combined column's 210px footprint.
    {
      key: "judgmentStatus",
      header: (
        <span title="Deterministic account-health rating from accepted evidence and objective account facts: Healthy, Watch, At Risk, or Critical. — means not judged yet; 'limited data' flags a thin evidence base. Hover any badge for its basis.">
          Overall account health
        </span>
      ),
      sortable: true,
      width: 120,
      cell: (c) => {
        const healthCfg = isAccountHealthStatus(c.judgmentStatus) ? HEALTH_CONFIG[c.judgmentStatus] : null;
        if (!healthCfg) return <span className="text-caption text-muted-foreground">—</span>;
        const HealthIcon = healthCfg.icon;
        return (
          <span className="inline-flex items-center gap-1.5" title={judgmentBasisTooltip(c)}>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${healthCfg.bg} ${healthCfg.color}`} data-testid={`badge-health-${c.id}`}>
              <HealthIcon className="h-3 w-3" />
              {healthCfg.label}
            </span>
            {hasLimitedJudgmentBasis(c) && (
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-caption font-medium text-muted-foreground" data-testid={`text-limited-basis-${c.id}`}>
                <Info className="h-2.5 w-2.5" />
                limited data
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "relationshipHealth",
      header: (
        <span title="How the client feels about us, separate from overall account health: Strong, Stable, Strained, or At Risk. — means no relationship read yet.">
          Relationship
        </span>
      ),
      sortable: true,
      width: 90,
      cell: (c) => {
        const relCfg = isRelationshipRead(c.relationshipHealth) ? RELATIONSHIP_CONFIG[c.relationshipHealth] : null;
        if (!relCfg) return <span className="text-caption text-muted-foreground">—</span>;
        return (
          <span className={`whitespace-nowrap text-caption font-medium ${relCfg.color}`} data-testid={`text-relationship-${c.id}`}>
            {c.relationshipHealth}
          </span>
        );
      },
    },
    {
      key: "judgmentHeadline",
      header: <span title="The judgment's one-line summary of what is going on in the account.">Headline</span>,
      width: 240,
      cell: (c) =>
        c.judgmentHeadline ? (
          <span className="block max-w-[220px] truncate text-caption text-muted-foreground" title={c.judgmentHeadline} data-testid={`text-headline-${c.id}`}>
            {c.judgmentHeadline}
          </span>
        ) : (
          <span className="text-caption text-gray-300">—</span>
        ),
    },
    {
      key: "lastTouchpointDate",
      header: <span title="Most recent proactive touch — call, meeting, or logged touchpoint.">Last Touchpoint</span>,
      sortable: true,
      width: 135,
      cell: (c) =>
        c.lastTouchpointDate ? (
          <span className="whitespace-nowrap text-xs text-foreground" data-testid={`text-lasttouchpoint-${c.id}`}>
            {formatDistanceToNow(safeDate(c.lastTouchpointDate)!, { addSuffix: true })}
          </span>
        ) : (
          <span className="whitespace-nowrap text-caption text-red-500">No touchpoints</span>
        ),
    },
    {
      key: "touchpointCount30d",
      header: <span title="Proactive touches in the last 30 days — a red 0 means the account has gone silent.">30d Touchpoints</span>,
      sortable: true,
      align: "center",
      width: 120,
      cell: (c) => (
        <span className={`text-xs font-semibold ${c.touchpointCount30d > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-500"}`} data-testid={`text-touchpoints30d-${c.id}`}>
          {c.touchpointCount30d}
        </span>
      ),
    },
    {
      key: "touchpointCountTotal",
      header: <span title="Proactive touches all-time.">Total Touchpoints</span>,
      sortable: true,
      align: "center",
      width: 125,
      cell: (c) => (
        <span className={`text-xs font-semibold ${c.touchpointCountTotal > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`} data-testid={`text-touchpointstotal-${c.id}`}>
          {c.touchpointCountTotal}
        </span>
      ),
    },
    {
      key: "commCount30d",
      header: <span title="Inbound + outbound messages (email, SMS, calls) in the last 30 days.">30d Comms</span>,
      sortable: true,
      align: "center",
      width: 95,
      cell: (c) => (
        <span className={`text-xs font-medium ${c.commCount30d > 0 ? "text-foreground" : "text-muted-foreground"}`} data-testid={`text-comms30d-${c.id}`}>
          {c.commCount30d}
        </span>
      ),
    },
    {
      key: "commCountTotal",
      header: <span title="Messages all-time.">Total Comms</span>,
      sortable: true,
      align: "center",
      width: 100,
      cell: (c) => (
        <span className={`text-xs font-medium ${c.commCountTotal > 0 ? "text-foreground" : "text-muted-foreground"}`} data-testid={`text-commstotal-${c.id}`}>
          {c.commCountTotal}
        </span>
      ),
    },
    {
      key: "services",
      header: <span title="Products this account is on.">Services</span>,
      width: 150,
      cell: (c) => (
        <span className="flex items-center gap-1 overflow-hidden whitespace-nowrap" title={c.products.map(p => PRODUCT_LABELS[p] || p).join(", ")}>
          {c.products.map(p => (
            <span key={p} className="inline-block shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-caption font-medium text-primary">
              {PRODUCT_LABELS[p] || p}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: "tags",
      header: <span title="CRM tags — manual and rule-applied.">Tags</span>,
      width: 150,
      cell: (c) => {
        const tags = tagsByClient.get(c.id) ?? [];
        if (tags.length === 0) return <span className="text-caption text-gray-300">—</span>;
        return (
          <span className="flex max-h-6 items-center gap-1 overflow-hidden" title={tags.map(t => t.name).join(", ")}>
            <TagChipRow tags={tags} testIdPrefix={`chip-client-${c.id}-tag`} />
          </span>
        );
      },
    },
    {
      key: "ownerName",
      header: <span title="Account owner.">Owner</span>,
      sortable: true,
      width: 110,
      cell: (c) => (
        <span data-testid={`text-owner-${c.id}`}>
          {c.ownerName ? (
            <OwnerTag ownerName={c.ownerName} ownerAvatar={c.ownerAvatar} isCurrentUser={c.ownerId === currentUserId} />
          ) : (
            <span className="text-caption text-muted-foreground">—</span>
          )}
        </span>
      ),
    },
    {
      key: "lastReviewedAt",
      header: <span title="Monthly panel review: Reviewed this month, Due, or None recorded.">Review</span>,
      sortable: true,
      width: 95,
      cell: (c) => getFreshnessBadge(c.lastReviewedAt),
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      align: "right",
      width: 48,
      cell: (c) => (
        <Link href={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-primary-ink" data-testid={`button-view-client-${c.id}`} aria-label={`View ${c.firmName}`}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      ),
    },
  ], [tagsByClient, currentUserId]);

  function MobileCard({ c }: { c: ClientSummary }) {
    const healthCfg = isAccountHealthStatus(c.judgmentStatus)
      ? HEALTH_CONFIG[c.judgmentStatus]
      : null;
    const HealthIcon = healthCfg?.icon || CircleDot;
    // Task #5123 — label both signals explicitly on mobile: the badge is
    // "Overall account health"; the relationship line is "Relationship:".
    const relCfg = isRelationshipRead(c.relationshipHealth)
      ? RELATIONSHIP_CONFIG[c.relationshipHealth]
      : null;
    return (
      <Link href={`/clients/${c.id}`}>
        <div className={`p-3 rounded-lg border hover:border-primary/20 transition-colors cursor-pointer ${c.ownerId === currentUserId ? "bg-primary/[0.03] border-primary/10" : "bg-card border-border"}`} data-testid={`card-client-${c.id}`}>
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm text-foreground" data-testid={`text-firm-${c.id}`}>{c.firmName}</span>
                {c.clientCode && <span className="text-caption text-muted-foreground font-mono">{c.clientCode}</span>}
              </div>
              {c.contactName && <p className="text-xs text-muted-foreground">{c.contactName}</p>}
              <TagChipRow
                tags={tagsByClient.get(c.id) ?? []}
                testIdPrefix={`chip-client-m-${c.id}-tag`}
              />
            </div>
            {(healthCfg || relCfg) && (
              <span className="inline-flex flex-col items-end gap-0.5 shrink-0">
                {healthCfg && (
                  <span className="inline-flex flex-col items-end gap-0.5" title={judgmentBasisTooltip(c)}>
                    <span className="text-caption font-medium text-muted-foreground mb-0.5">Overall account health</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption font-medium ${healthCfg.bg} ${healthCfg.color}`} data-testid={`badge-health-${c.id}`}>
                      <HealthIcon className="w-2.5 h-2.5" />
                      {healthCfg.label}
                    </span>
                    {hasLimitedJudgmentBasis(c) && (
                      <span className="text-caption font-medium text-muted-foreground flex items-center gap-0.5" data-testid={`text-limited-basis-${c.id}`}>
                        <Info className="w-2.5 h-2.5" />
                        limited data
                      </span>
                    )}
                  </span>
                )}
                {relCfg && (
                  <span className="whitespace-nowrap text-caption text-muted-foreground">
                    Relationship:{" "}
                    <span className={`font-medium ${relCfg.color}`} data-testid={`text-relationship-${c.id}`}>
                      {c.relationshipHealth}
                    </span>
                  </span>
                )}
              </span>
            )}
          </div>
          {c.judgmentHeadline && (
            <p className="text-caption text-muted-foreground truncate mb-2" data-testid={`text-headline-${c.id}`}>{c.judgmentHeadline}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
            <span className="text-muted-foreground">
              Last touchpoint: <span className={`font-semibold ${c.lastTouchpointDate ? "text-emerald-700 dark:text-emerald-300" : "text-red-500"}`} data-testid={`text-lasttouchpoint-${c.id}`}>
                {c.lastTouchpointDate ? formatDistanceToNow(safeDate(c.lastTouchpointDate)!, { addSuffix: true }) : "None"}
              </span>
            </span>
            <span className="text-muted-foreground">
              30d: <span className={`font-semibold ${c.touchpointCount30d > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-500"}`} data-testid={`text-touchpoints30d-${c.id}`}>{c.touchpointCount30d}</span> touchpoints
            </span>
            <span className="text-muted-foreground">
              Total: <span className="font-semibold text-emerald-700 dark:text-emerald-300" data-testid={`text-touchpoints-total-${c.id}`}>{c.touchpointCountTotal}</span> touchpoints
            </span>
            <span className="text-muted-foreground">
              30d: <span className="font-medium text-foreground" data-testid={`text-comms30d-${c.id}`}>{c.commCount30d}</span> comms
            </span>
            <span className="text-muted-foreground">
              Total: <span className="font-medium text-foreground" data-testid={`text-comms-total-${c.id}`}>{c.commCountTotal}</span> comms
            </span>
            {getFreshnessBadge(c.lastReviewedAt)}
          </div>
          <div className="flex flex-wrap gap-1 mt-2">
            {c.products.map(p => (
              <span key={p} className="inline-block px-1.5 py-0.5 rounded text-caption font-medium bg-primary/10 text-primary">
                {PRODUCT_LABELS[p] || p}
              </span>
            ))}
            {c.ownerName && (
              <OwnerTag ownerName={c.ownerName} ownerAvatar={c.ownerAvatar} isCurrentUser={c.ownerId === currentUserId} />
            )}
          </div>
        </div>
      </Link>
    );
  }

  return (
    <div>
      {/* Task #5001 — two independent chip rows so operators can hold one
          performance chip and one relationship chip at the same time. The
          rows are separated by a subtle divider so the two axes read as
          distinct (not one long mutually-exclusive strip). */}
      <div className="mb-3 space-y-1.5" data-testid="quick-filters">
        {/* Overall account health axis */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Overall account health filter">
          {ACCOUNT_HEALTH_FILTERS.map(f => {
            const count = f.key === "all" ? summaries.length
              : f.key === "critical" ? summaries.filter(c => c.judgmentStatus === "Critical").length
              : f.key === "at_risk" ? summaries.filter(c => c.judgmentStatus === "At Risk").length
              : f.key === "watch" ? summaries.filter(c => c.judgmentStatus === "Watch").length
              : f.key === "healthy" ? summaries.filter(c => c.judgmentStatus === "Healthy").length
              : f.key === "silent" ? summaries.filter(c => isSilent(c.touchpointCount30d)).length
              : f.key === "overdue_review" ? summaries.filter(c => isOverdueReview(c.lastReviewedAt)).length
              : f.key === "no_data" ? summaries.filter(c => !c.judgmentStatus).length
              : 0;
            if (count === 0 && f.key !== "all") return null;
            return (
              <button
                key={f.key}
                onClick={() => setPerfFilter(f.key)}
                className={`px-2.5 py-1 rounded-full text-caption font-medium transition-colors ${perfFilter === f.key ? f.activeColor : f.color}`}
                data-testid={`filter-${f.key}`}
                aria-pressed={perfFilter === f.key}
              >
                {f.label} ({count})
              </button>
            );
          })}
        </div>
        {/* Relationship axis — chips hidden when no client has a relationship read */}
        {summaries.some(c => c.relationshipHealth) && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Relationship filter">
            {RELATIONSHIP_FILTERS.map(f => {
              const count = f.key === "all" ? summaries.length
                : f.key === "rel_strained" ? summaries.filter(c => c.relationshipHealth === "Strained").length
                : f.key === "rel_at_risk" ? summaries.filter(c => c.relationshipHealth === "At Risk").length
                : 0;
              if (count === 0 && f.key !== "all") return null;
              return (
                <button
                  key={f.key}
                  onClick={() => setRelFilter(f.key)}
                  className={`px-2.5 py-1 rounded-full text-caption font-medium transition-colors ${relFilter === f.key ? f.activeColor : f.color}`}
                  data-testid={`filter-${f.key}`}
                  aria-pressed={relFilter === f.key}
                >
                  {f.label} ({count})
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search clients..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onBlur={() => { if (searchQuery.trim()) logActivity("search", "Searched clients", { query: searchQuery.trim() }); }}
            className="pl-9 h-9 bg-card border-primary/20 focus:border-primary text-sm"
            data-testid="input-search-clients"
            aria-label="Search clients by name, contact, code, or owner"
          />
        </div>
        <Button
          variant={showMyClientsOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setShowMyClientsOnly(!showMyClientsOnly)}
          className={`h-9 px-3 text-xs whitespace-nowrap ${showMyClientsOnly ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border-primary/20 text-primary-ink hover:bg-primary/10"}`}
          data-testid="button-my-clients-toggle"
          aria-pressed={showMyClientsOnly}
        >
          <Filter className="w-3.5 h-3.5 mr-1" />
          My Clients
        </Button>
        {owners.length > 1 && (
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-9 w-full sm:w-[180px] bg-card border-primary/20 text-sm" data-testid="select-owner-filter" aria-label="Filter by account owner">
              <SelectValue placeholder="All Owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Owners</SelectItem>
              {owners.map(([id, { name }]) => (
                <SelectItem key={id} value={id}>{id === currentUserId ? "You" : name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(clientTagsQuery.data?.tags.length ?? 0) > 0 && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="h-9 w-full sm:w-[160px] bg-card border-primary/20 text-sm" data-testid="select-tag-filter" aria-label="Filter by tag">
              <SelectValue placeholder="All Tags" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {(clientTagsQuery.data?.tags ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex gap-2">
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 px-2 text-muted-foreground hover:text-primary-ink" data-testid="button-clear-filters" aria-label="Clear all filters">
              <X className="w-3.5 h-3.5 mr-1" />
              <span className="text-xs">Clear ({activeFilterCount})</span>
            </Button>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-9 px-2 text-muted-foreground hover:text-primary-ink" data-testid="button-health-legend" aria-label="Legend: what the table columns mean">
                <Info className="w-3.5 h-3.5 mr-1" />
                <span className="text-xs">Legend</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80" data-testid="popover-health-legend">
              <div className="space-y-3 text-xs text-foreground">
                <div>
                  <p className="mb-1 font-semibold">Overall account health (policy rating)</p>
                  <div className="mb-1 flex flex-wrap gap-1">
                    {Object.entries(HEALTH_CONFIG).map(([status, cfg]) => {
                      const StatusIcon = cfg.icon;
                      const contractDef = isAccountHealthStatus(status) ? accountHealthContract[status].definition : null;
                      return (
                        <span key={status} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${cfg.bg} ${cfg.color}`} title={contractDef ?? undefined}>
                          <StatusIcon className="h-2.5 w-2.5" />
                          {cfg.label}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-muted-foreground">— = not judged yet · "limited data" = judged from a thin evidence base. Hover a badge for its basis.</p>
                </div>
                <div>
                  <p className="mb-1 font-semibold">Relationship</p>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-green-700 dark:text-green-300">Strong</span> · <span className="font-medium text-blue-700 dark:text-blue-300">Stable</span> · <span className="font-medium text-amber-700 dark:text-amber-300">Strained</span> · <span className="font-medium text-red-700 dark:text-red-300">At Risk</span> — how the client feels about us, separate from overall account health.
                  </p>
                </div>
                <div>
                  <p className="mb-1 font-semibold">Touchpoints & comms</p>
                  <p className="text-muted-foreground">Touchpoints are proactive touches (calls, meetings). <span className="font-semibold text-emerald-700 dark:text-emerald-300">Green</span> = active, <span className="font-semibold text-red-500">red 0</span> = silent 30d+. Comms count every message in and out.</p>
                </div>
                <div>
                  <p className="mb-1 font-semibold">Review</p>
                  <p className="text-muted-foreground">Monthly panel review: <span className="font-medium text-green-700 dark:text-green-300">Reviewed</span> this month · <span className="font-medium text-red-700 dark:text-red-300">Due</span> · <span className="font-medium text-muted-foreground">None</span> recorded yet.</p>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { logActivity("export", "Exported client dashboard CSV", { rowCount: sorted.length }); exportToCsv(sorted); }}
            className="h-9 px-3 border-primary/20 text-primary-ink hover:bg-primary hover:text-white"
            data-testid="button-export-csv"
            aria-label="Export current view as CSV"
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs">Export</span>
          </Button>
        </div>
      </div>

      {sorted.length > 0 && (
        <div className="hidden md:block">
          <OsTable
            columns={columns}
            rows={sorted}
            rowKey={(c) => c.id}
            sort={sort}
            onSortChange={setSort}
            maxHeight="70vh"
            data-testid="table-client-crm"
            onRowClick={(c) => navigate(`/clients/${c.id}`)}
            rowClassName={(c) =>
              c.ownerId === currentUserId
                ? "bg-primary/[0.03] [--os-sticky-col-bg:color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--os-table-surface)))]"
                : undefined
            }
            toolbar={
              <p className="text-caption text-muted-foreground" aria-live="polite">
                Showing {sorted.length} of {summaries.length} accounts
              </p>
            }
          />
        </div>
      )}

      {/* Task #4362 — mobile leads with signal: the worst-N triage list
          replaces the former endless card stack; the full set stays one tap
          away. */}
      {triaged.length > 0 && (
        <div className="md:hidden" data-testid="mobile-client-cards">
          <p className="mb-2 text-caption font-medium uppercase tracking-wide text-muted-foreground" aria-live="polite">
            {showAllMobile || triaged.length <= MOBILE_TRIAGE_COUNT
              ? `All ${triaged.length} accounts · worst first`
              : `Top ${MOBILE_TRIAGE_COUNT} of ${triaged.length} · worst first`}
          </p>
          <div className="space-y-2">
            {(showAllMobile ? triaged : triaged.slice(0, MOBILE_TRIAGE_COUNT)).map(c => <MobileCard key={c.id} c={c} />)}
          </div>
          {triaged.length > MOBILE_TRIAGE_COUNT && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAllMobile(v => !v)}
              className="mt-3 w-full border-primary/20 text-primary-ink hover:bg-primary/10"
              data-testid="button-mobile-show-all"
              aria-expanded={showAllMobile}
            >
              {showAllMobile ? `Show top ${MOBILE_TRIAGE_COUNT} only` : `Show all ${triaged.length} accounts`}
            </Button>
          )}
        </div>
      )}

      {sorted.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground">
            {activeFilterCount > 0
              ? "No clients match the current filters."
              : "No clients yet."}
          </p>
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-2 text-primary-ink" data-testid="button-clear-filters-empty">
              Clear filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Task #4993 — dashboard KPI captions are STRUCTURALLY one line: `truncate`
 * (nowrap + hidden overflow + ellipsis) guarantees the caption zone is
 * exactly one text line tall at every viewport, so no card can grow taller
 * than its siblings because of caption copy — including dynamic strings like
 * "Active accounts · N demo hidden". The title attribute always carries the
 * full text, keeping ellipsized copy reachable. Dashboard-local on purpose:
 * other KpiCard consumers (CEO Insights) rely on captions that wrap.
 */
function oneLineKpiCaption(text: string) {
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}
export default function Dashboard() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Dashboard");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const deleteReportMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const res = await fetch(`/api/reports/${reportId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete report");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/reports"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      toast({ title: "Report deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete report", variant: "destructive" });
    },
  });

  const [duplicateDialog, setDuplicateDialog] = useState<{ open: boolean; reportId: string | null; clientId: string; month: string }>({
    open: false,
    reportId: null,
    clientId: "",
    month: "",
  });

  const duplicateReportMutation = useMutation({
    mutationFn: async ({ reportId, newMonth, newClientId }: { reportId: string; newMonth: string; newClientId?: string }) => {
      const res = await fetch(`/api/reports/${reportId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newMonth, newClientId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to duplicate report");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/reports"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      toast({ title: "Report duplicated successfully" });
      setDuplicateDialog({ open: false, reportId: null, clientId: "", month: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to duplicate report", description: error.message, variant: "destructive" });
    },
  });

  const { data: clientSummaries, isLoading: summariesLoading, isFetching: summariesFetching, error: summariesError, refetch: refetchSummaries } = useQuery<ClientSummary[]>({
    queryKey: ["/api/dashboard/client-summaries"],
    queryFn: () => fetchDashboardJson<ClientSummary[]>("/api/dashboard/client-summaries"),
    enabled: !!user,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  // Task #4363 — global hide-demo filter (audit P3-4): one persisted
  // per-user toggle; every client-derived KPI and list below reads the
  // partitioned rows so counts stay consistent while it filters.
  const [hideDemo, setHideDemo] = useHideDemoAccounts(user?.id);
  const demoPartition = useMemo(
    () => partitionDemoAccounts(clientSummaries ?? [], hideDemo),
    [clientSummaries, hideDemo],
  );
  const visibleSummaries = clientSummaries ? demoPartition.visible : undefined;
  const hiddenDemoCount = demoPartition.hiddenDemoCount;
  const demoClientIds = useMemo(
    () => new Set((clientSummaries ?? []).filter((c) => c.isDemo).map((c) => c.id)),
    [clientSummaries],
  );

  const clients = useMemo(() => clientSummaries?.map(s => ({ id: s.id, clientCode: s.clientCode, firmName: s.firmName, contactName: s.contactName, ownerId: s.ownerId })), [clientSummaries]);
  const clientsLoading = summariesLoading;
  const clientsError = summariesError;

  const { data: reports, isLoading: reportsLoading, error: reportsError, refetch: refetchReports } = useQuery<Report[]>({
    queryKey: ["/api/reports"],
    queryFn: () => fetchDashboardJson<Report[]>("/api/reports"),
    enabled: !!user,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  // Task #1714 — Stage D: Notifications stat card now reads from the
  // per-user inbox (`/api/notifications/unread-count`) and the card
  // itself links to the full inbox at `/notifications`. The legacy
  // `/api/legacy-notifications` reader was retired with this card.
  const { data: unreadNotificationData } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: () => fetchDashboardJson<{ count: number }>("/api/notifications/unread-count"),
    enabled: !!user,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  const { data: monthlyReviewStats } = useQuery<{ reviewed: number; needsReview: number; total: number }>({
    queryKey: ["/api/monthly-review-stats"],
    queryFn: () => fetchDashboardJson<{ reviewed: number; needsReview: number; total: number }>("/api/monthly-review-stats"),
    enabled: !!user,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  useQuery({
    queryKey: ["/api/monthly-review-notifications", new Date().toISOString().slice(0, 7)],
    queryFn: () =>
      fetchDashboardJson("/api/monthly-review-notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    enabled: !!user,
    staleTime: 1000 * 60 * 60,
    ...DASHBOARD_QUERY_OPTIONS,
  });

  const hasLoadError = clientsError || reportsError || summariesError;

  const isCeo = user?.role === "ceo";
  const isAccountManager = user?.role === "account_manager";
  const myClients = clients || [];
  // Task #4363 — the duplicate-report client picker should honor the global
  // hide-demo toggle like every other client-derived list on this page.
  const duplicateDialogClients = hideDemo
    ? myClients.filter((c) => !demoClientIds.has(c.id))
    : myClients;

  const healthCounts = useMemo(() => {
    if (!visibleSummaries) return { healthy: 0, watch: 0, atRisk: 0, critical: 0, noData: 0 };
    return {
      healthy: visibleSummaries.filter(c => c.judgmentStatus === "Healthy").length,
      watch: visibleSummaries.filter(c => c.judgmentStatus === "Watch").length,
      atRisk: visibleSummaries.filter(c => c.judgmentStatus === "At Risk").length,
      critical: visibleSummaries.filter(c => c.judgmentStatus === "Critical").length,
      noData: visibleSummaries.filter(c => !c.judgmentStatus).length,
    };
  }, [visibleSummaries]);

  if (authLoading) {
    return <DashboardSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex flex-col items-center justify-center gap-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-foreground mb-2">NoBull OS</h1>
          <p className="text-foreground">Marketing analytics and reporting platform</p>
        </div>
        <Button 
          asChild
          className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-6 text-lg"
          data-testid="button-login"
        >
          <a href="/api/login">Sign In</a>
        </Button>
      </div>
    );
  }

  const unreadNotifications = unreadNotificationData?.count ?? 0;
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const reportingPeriod = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  // Task #4363 — while demo accounts are hidden, their reports leave the
  // report KPI and the Recent Reports list too.
  const visibleReports = hideDemo ? (reports ?? []).filter((r) => !demoClientIds.has(r.clientId)) : (reports ?? []);
  const reportsThisMonthCount = visibleReports.filter((r) => r.reportMonth === reportingPeriod).length;
  const recentReports = visibleReports.slice(0, 5);

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Extra bottom padding below md keeps the last card/row clear of the
          floating comms button's corner lane at max scroll (Task #4374). */}
      <main className="max-w-7xl mx-auto p-4 sm:p-6 pb-24 sm:pb-24 md:pb-6">
        {hasLoadError && (
          <div className="mb-4 p-4 bg-red-50 dark:bg-red-950/25 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 flex items-start justify-between gap-3" data-testid="error-banner" role="alert">
            <div>
              <div className="font-medium">Some data couldn't be loaded</div>
              <div className="text-sm mt-1">You're still signed in — this is usually temporary. Use the retry buttons below, or try again in a moment.</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 shrink-0"
              onClick={() => {
                if (summariesError) void refetchSummaries(); // fire-and-forget: manual retry refetch
                if (reportsError) void refetchReports(); // fire-and-forget: manual retry refetch
              }}
              data-testid="button-retry-all"
            >
              Retry
            </Button>
          </div>
        )}

        {(summariesLoading || clientsLoading || reportsLoading) && (
          <div className="mb-4 p-3 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg text-blue-700 dark:text-blue-300 flex items-center gap-3" data-testid="loading-indicator" role="status">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse [animation-delay:150ms]" />
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse [animation-delay:300ms]" />
            </div>
            <span className="text-sm">Loading dashboard data...</span>
          </div>
        )}

        {/* Task #4363 — global hide-demo filter (audit P3-4): the switch sits
            above the KPIs it scopes; every count below derives from the
            filtered rows, and the badge reports how many rows are hidden. */}
        <div className="mb-3 flex justify-end">
          <HideDemoToggle
            surface="dashboard"
            checked={hideDemo}
            onCheckedChange={setHideDemo}
            hiddenCount={hiddenDemoCount}
          />
        </div>

        {/* Task #4912 — the Win Feed leads the dashboard: the first full-width
            content section, above the KPIs and the accounts table, so wins get
            celebrated instead of sitting truncated in the sidebar. Role gate
            unchanged from the sidebar placement (Task #4874); the hide-demo
            switch above scopes this band too. */}
        {["account_manager", "team_lead", "ceo"].includes(user.role ?? "") && (
          <div className="mb-6">
            <WinFeedCard hideDemo={hideDemo} />
          </div>
        )}

        {/* Task #4362 — every KPI runs through KpiCard so each number carries
            a label, unit, and caption (audit P2-2: no bare "0.76"-style
            values), and the phone layout is a compact 2-up grid instead of a
            full-width stack (P3-3).
            Task #4993 — copy in this row is deliberately sized to ONE line
            per zone at every breakpoint (KpiCard reserves single-line label
            and bottom-pinned caption zones): max-w-7xl gives each xl card
            ~166px, so longer phrasings ("At Risk / Critical", "Reporting
            period …") wrapped and pushed numbers/captions out of line card
            to card. Shortened text keeps its meaning; the full At Risk /
            Critical phrase stays reachable via the label tooltip. Every
            caption below additionally renders through oneLineKpiCaption so
            even dynamic copy (demo-hidden count, review-due count) is
            STRUCTURALLY one line at any viewport — ellipsized when space
            runs out, full text always reachable via the title attribute. */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
          <KpiCard
            testId="card-stat-clients"
            label="Clients"
            icon={<Building2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
            value={<span data-testid="text-client-count">{summariesError ? "—" : (visibleSummaries?.length ?? (summariesLoading ? "—" : myClients.length))}</span>}
            caption={oneLineKpiCaption(hideDemo && hiddenDemoCount > 0 ? `Active accounts · ${hiddenDemoCount} demo hidden` : "Active accounts")}
          />

          <KpiCard
            testId="card-stat-healthy"
            label="Healthy"
            icon={<CheckCircle className="h-3.5 w-3.5 text-status-ok" aria-hidden="true" />}
            accent={healthCounts.healthy > 0 ? "ok" : undefined}
            value={summariesError ? "—" : healthCounts.healthy}
            unit="accounts"
            caption={oneLineKpiCaption("No action needed")}
          />

          <KpiCard
            testId="card-stat-watch"
            label="Watch"
            icon={<Clock className="h-3.5 w-3.5 text-status-warn" aria-hidden="true" />}
            accent={healthCounts.watch > 0 ? "warn" : undefined}
            value={summariesError ? "—" : healthCounts.watch}
            unit="accounts"
            caption={oneLineKpiCaption("Early warning signs")}
          />

          <KpiCard
            testId="card-stat-atrisk"
            label={<span title="At Risk / Critical">At Risk</span>}
            icon={<AlertTriangle className="h-3.5 w-3.5 text-status-critical" aria-hidden="true" />}
            accent={healthCounts.atRisk + healthCounts.critical > 0 ? "critical" : undefined}
            value={summariesError ? "—" : healthCounts.atRisk + healthCounts.critical}
            unit="accounts"
            caption={oneLineKpiCaption("Needs intervention")}
          />

          <KpiCard
            testId="card-stat-reports"
            label="Reports"
            icon={<FileText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
            value={<span data-testid="text-report-count">{reportsThisMonthCount}</span>}
            caption={oneLineKpiCaption(`Period ${reportingPeriod}`)}
          />

          <Link href="/notifications" data-testid="link-stat-notifications" className="block">
            <KpiCard
              testId="card-stat-notifications"
              label="Notifications"
              icon={<Bell className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
              value={<span data-testid="text-notification-count">{unreadNotifications}</span>}
              unit="unread"
              caption={oneLineKpiCaption("Open your inbox")}
              className="h-full cursor-pointer transition-colors hover:border-primary/30"
            />
          </Link>

          <KpiCard
            testId="card-stat-monthly-reviews"
            label="Panel Reviews"
            icon={<Sliders className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
            accent={monthlyReviewStats && monthlyReviewStats.needsReview > 0 ? "warn" : undefined}
            value={<span data-testid="text-monthly-review-count">{monthlyReviewStats ? `${monthlyReviewStats.reviewed}/${monthlyReviewStats.total}` : "—"}</span>}
            unit="done"
            caption={oneLineKpiCaption(
              monthlyReviewStats
                ? `${monthlyReviewStats.needsReview} due this month`
                : "This month",
            )}
            className="col-span-2 md:col-span-1"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3">
            <Card className="bg-card border-primary/10" data-testid="card-clients-list">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-foreground">
                      All Accounts
                    </CardTitle>
                    <CardDescription className="mt-1">
                      {summariesLoading ? <span className="inline-block animate-pulse">Loading accounts...</span> : summariesError ? "Couldn't load accounts" : `${visibleSummaries?.length ?? myClients.length} active accounts${hideDemo && hiddenDemoCount > 0 ? ` · ${hiddenDemoCount} demo hidden` : ""}`}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {visibleSummaries && visibleSummaries.length > 0 ? (
                  <ClientCRMTable summaries={visibleSummaries} currentUserId={user?.id} isAccountManager={isAccountManager} />
                ) : summariesError ? (
                  // Task #2675 — transient/terminal load failure (user still
                  // signed in). Show an explicit, recoverable error instead of
                  // the misleading "No clients yet." empty state.
                  <div className="py-8 text-center" data-testid="clients-load-error" role="alert">
                    <AlertTriangle className="w-6 h-6 text-red-500 mx-auto mb-2" aria-hidden="true" />
                    <p className="text-foreground text-sm font-medium">Couldn't load your accounts</p>
                    <p className="text-muted-foreground text-xs mt-1">You're still signed in — this is usually temporary.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 border-primary/30 text-primary-ink hover:bg-primary/10"
                      onClick={() => refetchSummaries()}
                      disabled={summariesFetching}
                      data-testid="button-retry-summaries"
                    >
                      {summariesFetching ? "Retrying..." : "Retry"}
                    </Button>
                  </div>
                ) : summariesLoading ? (
                  <TableSkeleton rows={6} cols={5} />
                ) : clientSummaries && clientSummaries.length > 0 && hideDemo ? (
                  <p className="text-foreground text-sm py-4 text-center" data-testid="text-all-demo-hidden">
                    All {clientSummaries.length} accounts are demo accounts — hidden by the demo filter.
                  </p>
                ) : (
                  // Flagship empty state with the earth bull mark (Task
                  // #4618) — testid + "No clients yet." copy preserved for
                  // the transient-resilience absence asserts.
                  <EmptyState
                    testId="text-no-clients"
                    icon={<BrandMark kind="icon" variant="earth" />}
                    title="No clients yet."
                    description="Client accounts appear here once they're added to NoBull OS."
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            {isCeo && <UnmatchedCommsCard />}

            <Card className="bg-card border-primary/10" data-testid="card-recent-reports">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium text-foreground">Recent Reports</CardTitle>
                  <Button asChild variant="ghost" size="sm" className="text-primary-ink hover:bg-primary/10 -mr-2 h-7 text-xs" data-testid="button-view-all-reports">
                    <Link href="/reports/matrix">View all</Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {recentReports.length === 0 ? (
                  <p className="text-foreground text-sm">No reports yet.</p>
                ) : (
                  <div className="space-y-2">
                    {recentReports.map(report => {
                      const client = clients?.find(c => c.id === report.clientId);
                      // Task #4644: DELETE /api/reports/:id is team-lead+ on the server —
                      // owning the client no longer grants report deletion.
                      const canDelete = user.role === "team_lead" || user.role === "ceo";
                      return (
                        <div 
                          key={report.id} 
                          className="flex items-center justify-between p-2 bg-surface-warm-1 rounded gap-2"
                          data-testid={`row-report-${report.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">
                              {client?.firmName || (summariesError ? "Account unavailable" : "Unknown")}
                            </p>
                            <p className="text-caption text-muted-foreground">{report.reportMonth}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className={`text-caption px-1.5 py-0.5 rounded whitespace-nowrap ${
                              report.status === 'final' 
                                ? 'bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300' 
                                : 'bg-yellow-100 dark:bg-yellow-950/35 text-yellow-700 dark:text-yellow-300'
                            }`}>
                              {report.status}
                            </span>
                            <Button asChild size="sm" variant="ghost" className="h-6 w-6 p-0 text-primary-ink hover:bg-primary/10" data-testid={`button-open-report-${report.id}`}>
                              <Link href={`/reports/${report.id}`}>
                                <Eye className="w-3 h-3" />
                              </Link>
                            </Button>
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-6 w-6 p-0 text-primary-ink hover:bg-primary/10"
                              onClick={() => setDuplicateDialog({ 
                                open: true, 
                                reportId: report.id, 
                                clientId: report.clientId,
                                month: "" 
                              })}
                              data-testid={`button-duplicate-report-${report.id}`}
                              aria-label={`Duplicate report for ${client?.firmName || "unknown"}`}
                            >
                              <Copy className="w-3 h-3" />
                            </Button>
                            {canDelete && (
                              <ConfirmActionDialog
                                title="Delete this report?"
                                description="The report and all metrics entered in it are permanently deleted, including any client-facing view. This cannot be undone."
                                confirmLabel="Delete report"
                                testId={`dialog-confirm-delete-report-${report.id}`}
                                onConfirm={() => deleteReportMutation.mutate(report.id)}
                                trigger={
                                  <Button 
                                    size="sm" 
                                    variant="ghost" 
                                    className="h-6 w-6 p-0 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/25"
                                    disabled={deleteReportMutation.isPending}
                                    data-testid={`button-delete-report-${report.id}`}
                                    aria-label={`Delete report for ${client?.firmName || "unknown"}`}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                }
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <Dialog open={duplicateDialog.open} onOpenChange={(open) => setDuplicateDialog(prev => ({ ...prev, open }))}>
        <DialogContent className="bg-card">
          <DialogHeader>
            <DialogTitle className="text-foreground">Duplicate Report</DialogTitle>
            <DialogDescription>
              Create a copy of this report for a different month or client
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="duplicate-client">Client</Label>
              <Select
                value={duplicateDialog.clientId}
                onValueChange={(value) => setDuplicateDialog(prev => ({ ...prev, clientId: value }))}
              >
                <SelectTrigger id="duplicate-client" data-testid="select-duplicate-client">
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  {duplicateDialogClients.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="duplicate-month">New Month</Label>
              <Select
                value={duplicateDialog.month}
                onValueChange={(value) => setDuplicateDialog(prev => ({ ...prev, month: value }))}
              >
                <SelectTrigger id="duplicate-month" data-testid="select-duplicate-month">
                  <SelectValue placeholder="Select month" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => {
                    const d = new Date();
                    d.setMonth(d.getMonth() - i);
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                    return <SelectItem key={key} value={key}>{key}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setDuplicateDialog({ open: false, reportId: null, clientId: "", month: "" })}
              data-testid="button-cancel-duplicate"
            >
              Cancel
            </Button>
            <Button 
              className="bg-primary hover:bg-primary/90"
              disabled={!duplicateDialog.month || !duplicateDialog.clientId || duplicateReportMutation.isPending}
              onClick={() => {
                if (duplicateDialog.reportId && duplicateDialog.month && duplicateDialog.clientId) {
                  duplicateReportMutation.mutate({
                    reportId: duplicateDialog.reportId,
                    newMonth: duplicateDialog.month,
                    newClientId: duplicateDialog.clientId,
                  });
                }
              }}
              data-testid="button-confirm-duplicate"
            >
              {duplicateReportMutation.isPending ? "Duplicating..." : "Duplicate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
