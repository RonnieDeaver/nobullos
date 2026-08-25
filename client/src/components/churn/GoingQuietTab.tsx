/**
 * Task #3695 — Churn Command Center: Going Quiet tab.
 *
 * Surfaces clients who are disengaging BEFORE the silence turns into a
 * cancellation: flagged clients ranked by quiet score (severity), showing
 * the inbound-volume drop vs the client's OWN baseline, last inbound
 * message, last call/meeting, viewing recency, 14-day in/out counts, the
 * human-readable reasons the detector flagged them, and the account owner.
 * A toggle reveals the full unflagged list (including
 * insufficient-history clients) for context; clients with no snapshot yet
 * sit in a bucket at the bottom. Row click opens the client detail page.
 *
 * Reads GET /api/churn/going-quiet (director-gated, strict), written daily
 * by the going-quiet sweep that runs after the judgment pass.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Moon, RefreshCw, TriangleAlert } from "lucide-react";

// ── API types (mirror server/routes/churn.ts response) ─────────────────────

interface EngagementSnapshot {
  snapshotDate: string;
  inboundRecent: number;
  outboundRecent: number;
  inbound30d: number;
  outbound30d: number;
  baselineWeeklyInbound: number | null;
  recentWeeklyInbound: number | null;
  dropPct: number | null;
  daysSinceLastInbound: number | null;
  daysSinceLastCallMeeting: number | null;
  daysSinceLastViewed: number | null;
  historyDays: number | null;
  quietScore: number;
  isFlagged: boolean;
  insufficientHistory: boolean;
  /** Task #3889 — snapshot was taken while the ingestion feed was stale:
   *  inbound gaps reflect missing pipeline data, not client silence. */
  dataGap: boolean;
  reasons: string[];
}

/** Task #3889 — live feed-freshness measured by the server at request time. */
interface GoingQuietFeed {
  stale: boolean;
  newestInboundAt: string | null;
  newestSyncActivityAt: string | null;
  syncActiveRecent: number;
  lagDays: number | null;
  staleAfterDays: number;
  minRecentConvs: number;
}

export interface GoingQuietClient {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerAvatar: string | null;
  snapshot: EngagementSnapshot | null;
}

interface GoingQuietResponse {
  clients: GoingQuietClient[];
  feed: GoingQuietFeed | null;
  thresholds: {
    dropThresholdPct: number;
    silenceDays: number;
    minHistoryDays: number;
    minBaselineWeekly: number;
  };
  generatedAt: string;
}

// ── Cell helpers ────────────────────────────────────────────────────────────

function quietScoreClass(v: number): string {
  if (v >= 70) return "text-status-critical font-semibold";
  if (v >= 45) return "text-status-warn font-medium";
  if (v >= 25) return "text-status-warn";
  return "text-muted-foreground";
}

function dropPctClass(v: number | null): string {
  if (v === null) return "text-gray-300";
  if (v >= 80) return "text-status-critical font-medium";
  if (v >= 60) return "text-status-warn";
  if (v > 0) return "text-status-warn";
  return "text-muted-foreground";
}

// Task #3889 — null means "no attributed data on record", NOT "the client
// never did this": call/meeting attribution has known coverage limits and a
// stale feed produces false nulls. Label the absence honestly per column
// instead of claiming "never".
function fmtDaysAgo(days: number | null, nullLabel = "none on record"): string {
  if (days === null) return nullLabel;
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function daysToneClass(days: number | null, badFrom: number): string {
  // Absent data is unknown, not proven-bad — muted, not red (Task #3889).
  if (days === null) return "text-muted-foreground";
  if (days >= badFrom) return "text-status-critical font-medium";
  if (days >= badFrom / 2) return "text-status-warn";
  return "text-muted-foreground";
}

function DropCell({ snapshot, testId }: { snapshot: EngagementSnapshot; testId: string }) {
  if (snapshot.dropPct === null) {
    return (
      <span className="text-gray-300 text-xs" data-testid={testId} title="No baseline yet">
        —
      </span>
    );
  }
  const rounded = Math.round(snapshot.dropPct);
  const rates =
    snapshot.recentWeeklyInbound !== null && snapshot.baselineWeeklyInbound !== null
      ? `${snapshot.recentWeeklyInbound.toFixed(1)}/wk now vs ${snapshot.baselineWeeklyInbound.toFixed(1)}/wk baseline`
      : undefined;
  return (
    <span className={`text-xs whitespace-nowrap ${dropPctClass(snapshot.dropPct)}`} data-testid={testId} title={rates}>
      {rounded > 0 ? `−${rounded}%` : rounded < 0 ? `+${Math.abs(rounded)}%` : "0%"}
    </span>
  );
}

function OwnerCell({ name, avatar }: { name: string | null; avatar: string | null }) {
  const [imgError, setImgError] = useState(false);
  if (!name) return <span className="text-gray-300 text-xs">—</span>;
  const isEmail = name.includes("@");
  const label = isEmail ? name.split("@")[0].toUpperCase() : (name.split(" ")[0] || name).toUpperCase();
  const initials = isEmail
    ? name[0].toUpperCase()
    : name.split(" ").map((n) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);
  const showAvatar = avatar && !imgError;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-caption font-bold tracking-wide bg-muted text-muted-foreground">
      {showAvatar ? (
        <img src={avatar} alt="" className="w-5 h-5 rounded-pill object-cover" onError={() => setImgError(true)} />
      ) : (
        <span className="w-5 h-5 rounded-pill flex items-center justify-center text-[10px] font-semibold bg-muted-foreground/20 text-foreground">
          {initials}
        </span>
      )}
      {label}
    </span>
  );
}

const HEADER_CELL = "px-2 py-2 text-xs font-semibold text-foreground whitespace-nowrap";

/** Task #3889 — marks a snapshot taken while the ingestion feed was stale. */
function DataGapBadge({ clientId }: { clientId: string }) {
  return (
    <span
      className="ml-1.5 px-1.5 py-0.5 rounded-pill text-caption font-medium bg-status-warn/15 text-status-warn whitespace-nowrap"
      title="Snapshot taken while the communication feed was behind — inbound gaps reflect missing ingestion, not client silence"
      data-testid={`badge-data-gap-${clientId}`}
    >
      data gap
    </span>
  );
}

function EngagementCells({ c, prefix }: { c: GoingQuietClient; prefix: string }) {
  const s = c.snapshot!;
  return (
    <>
      <td className="px-2 py-2">
        <DropCell snapshot={s} testId={`${prefix}-drop-${c.clientId}`} />
      </td>
      <td className="px-2 py-2">
        <span className={`text-xs whitespace-nowrap ${daysToneClass(s.daysSinceLastInbound, 21)}`} data-testid={`${prefix}-last-inbound-${c.clientId}`}>
          {fmtDaysAgo(s.daysSinceLastInbound)}
        </span>
      </td>
      <td className="px-2 py-2">
        <span
          className={`text-xs whitespace-nowrap ${daysToneClass(s.daysSinceLastCallMeeting, 60)}`}
          title={s.daysSinceLastCallMeeting === null ? "No call/meeting attribution on record — call coverage is limited, this does not mean no calls happened" : undefined}
          data-testid={`${prefix}-last-call-${c.clientId}`}
        >
          {fmtDaysAgo(s.daysSinceLastCallMeeting, "no call data")}
        </span>
      </td>
      <td className="px-2 py-2">
        <span className={`text-xs whitespace-nowrap ${daysToneClass(s.daysSinceLastViewed, 45)}`} data-testid={`${prefix}-last-viewed-${c.clientId}`}>
          {fmtDaysAgo(s.daysSinceLastViewed)}
        </span>
      </td>
      <td className="px-2 py-2">
        <span className="text-xs text-muted-foreground whitespace-nowrap" title="Inbound / outbound messages in the last 14 days" data-testid={`${prefix}-inout-${c.clientId}`}>
          {s.inboundRecent} in / {s.outboundRecent} out
        </span>
      </td>
    </>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function GoingQuietTab() {
  const [, navigate] = useLocation();
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, isError, error, refetch, isRefetching } =
    useQuery<GoingQuietResponse>({
      queryKey: ["/api/churn/going-quiet"],
    });

  const allClients = useMemo(() => data?.clients ?? [], [data]);
  const flagged = useMemo(
    () =>
      allClients
        .filter((c) => c.snapshot?.isFlagged)
        .sort((a, b) => b.snapshot!.quietScore - a.snapshot!.quietScore),
    [allClients],
  );
  const unflagged = useMemo(
    () =>
      allClients
        .filter((c) => c.snapshot && !c.snapshot.isFlagged)
        .sort((a, b) => b.snapshot!.quietScore - a.snapshot!.quietScore),
    [allClients],
  );
  const noSnapshot = useMemo(
    () =>
      allClients
        .filter((c) => c.snapshot === null)
        .sort((a, b) => a.firmName.localeCompare(b.firmName)),
    [allClients],
  );

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="loading-going-quiet">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-10 bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to load going-quiet list";
    const denied = message.startsWith("403");
    return (
      <Card data-testid="error-going-quiet">
        <CardContent className="py-10 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground text-center">
            {denied ? "Access restricted to directors." : `Couldn't load the going-quiet list. ${message}`}
          </p>
          {!denied && (
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-going-quiet">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isRefetching ? "animate-spin" : ""}`} />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (allClients.length === 0) {
    return (
      <Card data-testid="empty-going-quiet">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No active clients yet.
        </CardContent>
      </Card>
    );
  }

  const thresholds = data?.thresholds;
  const feed = data?.feed;

  return (
    <div className="space-y-4">
      {/* Task #3889 — degraded-feed banner: the pipeline is behind, so the
          numbers below under-count inbound. Flags are suppressed while stale. */}
      {feed?.stale && (
        <div
          className="border border-status-warn/40 bg-status-warn/5 px-3 py-2.5 flex items-start gap-2"
          data-testid="banner-going-quiet-feed-stale"
        >
          <TriangleAlert className="w-4 h-4 text-status-warn mt-0.5 shrink-0" />
          <div className="text-xs text-foreground/80">
            <p className="font-semibold">
              Communication feed is behind — quiet flags are paused
            </p>
            <p className="mt-0.5">
              Newest ingested inbound message:{" "}
              {feed.newestInboundAt
                ? new Date(feed.newestInboundAt).toLocaleDateString()
                : "none on record"}
              {typeof feed.lagDays === "number"
                ? ` (${Math.round(feed.lagDays)}d behind Front's own activity)`
                : ""}
              . Front shows {feed.syncActiveRecent} conversations active in the
              last 14 days, so gaps below reflect missing ingestion — not client
              silence.
            </p>
          </div>
        </div>
      )}

      {thresholds && (
        <p className="text-xs text-muted-foreground" data-testid="text-going-quiet-thresholds">
          Flagged when inbound volume drops ≥{Math.round(thresholds.dropThresholdPct)}% vs the
          client's own baseline, or no inbound message for {Math.round(thresholds.silenceDays)}+
          days. Clients with under {Math.round(thresholds.minHistoryDays)} days of history are
          excluded from flagging.
        </p>
      )}

      {/* Flagged clients, ranked by severity */}
      {flagged.length === 0 ? (
        <Card data-testid="empty-going-quiet-flagged">
          <CardContent className="py-8 flex flex-col items-center gap-2 text-center">
            <Moon className="w-5 h-5 text-gray-300" />
            <p className="text-sm text-muted-foreground">
              No clients are going quiet right now.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="border border-border bg-card overflow-x-auto">
          <table className="w-full text-left" data-testid="table-going-quiet-flagged">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                <th className={HEADER_CELL}>#</th>
                <th className={HEADER_CELL}>Client</th>
                <th className={HEADER_CELL} title="Quiet score (0–100, higher = more disengaged)">Quiet</th>
                <th className={HEADER_CELL} title="Recent inbound volume vs the client's own baseline">Drop</th>
                <th className={HEADER_CELL}>Last Inbound</th>
                <th className={HEADER_CELL}>Last Call/Mtg</th>
                <th className={HEADER_CELL}>Last Viewed</th>
                <th className={HEADER_CELL} title="Messages in the last 14 days">14d In/Out</th>
                <th className={HEADER_CELL}>Why</th>
                <th className={HEADER_CELL}>Owner</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((c, i) => (
                <tr
                  key={c.clientId}
                  onClick={() => navigate(`/clients/${c.clientId}`)}
                  className="border-b border-gray-50 last:border-0 cursor-pointer hover:bg-primary/[0.03] transition-colors"
                  data-testid={`row-going-quiet-${c.clientId}`}
                >
                  <td className="px-2 py-2 text-xs text-muted-foreground" data-testid={`rank-going-quiet-${c.clientId}`}>{i + 1}</td>
                  <td className="px-2 py-2">
                    <span className="text-xs font-medium text-foreground whitespace-nowrap" data-testid={`firm-going-quiet-${c.clientId}`}>
                      {c.firmName}
                    </span>
                    {c.clientCode && <span className="ml-1.5 text-caption text-muted-foreground">{c.clientCode}</span>}
                    {c.snapshot!.dataGap && <DataGapBadge clientId={c.clientId} />}
                  </td>
                  <td className="px-2 py-2">
                    <span className={`text-xs ${quietScoreClass(c.snapshot!.quietScore)}`} data-testid={`score-going-quiet-${c.clientId}`}>
                      {Math.round(c.snapshot!.quietScore)}
                    </span>
                  </td>
                  <EngagementCells c={c} prefix="flagged" />
                  <td className="px-2 py-2 max-w-[320px]">
                    <span className="text-caption text-muted-foreground line-clamp-2" title={c.snapshot!.reasons.join(" · ")} data-testid={`reasons-going-quiet-${c.clientId}`}>
                      {c.snapshot!.reasons.join(" · ") || "—"}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <OwnerCell name={c.ownerName} avatar={c.ownerAvatar} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Toggle: full unflagged list for context */}
      <button
        onClick={() => setShowAll((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary-ink transition-colors"
        data-testid="button-toggle-going-quiet-all"
        aria-expanded={showAll}
      >
        {showAll ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {showAll ? "Hide" : "Show"} all clients ({unflagged.length} not flagged
        {noSnapshot.length > 0 ? `, ${noSnapshot.length} no snapshot` : ""})
      </button>

      {showAll && (
        <div className="space-y-4">
          {unflagged.length > 0 && (
            <div className="border border-border bg-card overflow-x-auto">
              <table className="w-full text-left" data-testid="table-going-quiet-unflagged">
                <thead>
                  <tr className="border-b border-border bg-muted/60">
                    <th className={HEADER_CELL}>Client</th>
                    <th className={HEADER_CELL} title="Quiet score (0–100, higher = more disengaged)">Quiet</th>
                    <th className={HEADER_CELL} title="Recent inbound volume vs the client's own baseline">Drop</th>
                    <th className={HEADER_CELL}>Last Inbound</th>
                    <th className={HEADER_CELL}>Last Call/Mtg</th>
                    <th className={HEADER_CELL}>Last Viewed</th>
                    <th className={HEADER_CELL} title="Messages in the last 14 days">14d In/Out</th>
                    <th className={HEADER_CELL}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {unflagged.map((c) => (
                    <tr
                      key={c.clientId}
                      onClick={() => navigate(`/clients/${c.clientId}`)}
                      className="border-b border-gray-50 last:border-0 cursor-pointer hover:bg-primary/[0.03] transition-colors"
                      data-testid={`row-going-quiet-unflagged-${c.clientId}`}
                    >
                      <td className="px-2 py-2">
                        <span className="text-xs font-medium text-foreground whitespace-nowrap">{c.firmName}</span>
                        {c.clientCode && <span className="ml-1.5 text-caption text-muted-foreground">{c.clientCode}</span>}
                        {c.snapshot!.dataGap && <DataGapBadge clientId={c.clientId} />}
                        {c.snapshot!.insufficientHistory && (
                          <span
                            className="ml-1.5 px-1.5 py-0.5 rounded-pill text-caption font-medium bg-muted text-muted-foreground whitespace-nowrap"
                            title={c.snapshot!.reasons.join(" · ") || "Not enough communication history to judge"}
                            data-testid={`badge-insufficient-${c.clientId}`}
                          >
                            insufficient history
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <span className={`text-xs ${quietScoreClass(c.snapshot!.quietScore)}`}>
                          {Math.round(c.snapshot!.quietScore)}
                        </span>
                      </td>
                      <EngagementCells c={c} prefix="unflagged" />
                      <td className="px-2 py-2">
                        <OwnerCell name={c.ownerName} avatar={c.ownerAvatar} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {noSnapshot.length > 0 && (
            <div className="border border-dashed border-border bg-muted/40 px-3 py-2" data-testid="bucket-going-quiet-no-snapshot">
              <p className="text-caption font-medium text-muted-foreground mb-1">
                No snapshot yet ({noSnapshot.length}) — the daily sweep hasn't covered these clients
              </p>
              <div className="flex flex-wrap gap-1.5">
                {noSnapshot.map((c) => (
                  <button
                    key={c.clientId}
                    onClick={() => navigate(`/clients/${c.clientId}`)}
                    className="px-2 py-0.5 rounded-pill text-caption bg-card border border-border text-muted-foreground hover:border-primary/40 hover:text-primary-ink transition-colors"
                    data-testid={`chip-no-snapshot-${c.clientId}`}
                  >
                    {c.firmName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {data?.generatedAt && (
        <p className="text-caption text-gray-300" data-testid="text-going-quiet-generated-at">
          Snapshots update daily after the judgment pass · fetched {new Date(data.generatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
