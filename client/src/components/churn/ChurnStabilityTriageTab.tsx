/**
 * Task #4766 — Churn Command Center: Stability Triage tab.
 *
 * Operator triage for clients whose latest judgment reads delivery
 * stability "unknown" — even after the measured-live-data fallback. The
 * server splits them deterministically from the judgment's own stored
 * source signals (server/services/stabilityTriage.ts):
 *   • DATA GAP — recent communications prove the relationship is alive;
 *     the honest fix is entering real reports through the normal flow or
 *     configuring the measured BigQuery source. Never an archive
 *     candidate.
 *   • ARCHIVE CANDIDATE — dead across communications, entered reports,
 *     measured data, and open asks; likely no longer a client. Routed to
 *     the EXISTING archive/offboarding actions on the client detail page —
 *     archiving stays a human decision, nothing here mutates.
 *
 * Reads GET /api/churn/stability-triage (director-gated, strict). Row
 * click opens the client detail page where the archive/offboarding and
 * report flows already live.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Archive, Database, RefreshCw } from "lucide-react";

// ── API types (mirror server/routes/churn.ts response) ─────────────────────

interface TriageClient {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerName: string | null;
  ownerAvatar: string | null;
  judgmentDate: string;
  deliveryStabilitySource: string | null;
  lastCommAt: string | null;
  lastEnteredReportMonth: string | null;
  measuredMonths: number;
  measuredSourceConfigured: boolean;
  activeOpenAsks: number;
  kind: "data_gap" | "archive_candidate";
  reasons: string[];
}

interface TriageResponse {
  clients: TriageClient[];
  generatedAt: string;
}

// ── Cell helpers ────────────────────────────────────────────────────────────

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
        <span className="w-5 h-5 rounded-pill flex items-center justify-center text-caption font-semibold bg-muted-foreground/20 text-foreground">
          {initials}
        </span>
      )}
      {label}
    </span>
  );
}

function fmtLastComm(iso: string | null): string {
  if (!iso) return "none on record";
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

const HEADER_CELL = "px-2 py-2 text-xs font-semibold text-foreground whitespace-nowrap";

function TriageRows({ clients, prefix }: { clients: TriageClient[]; prefix: string }) {
  const [, navigate] = useLocation();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-border">
          <tr>
            <th className={HEADER_CELL}>Client</th>
            <th className={HEADER_CELL}>Owner</th>
            <th className={HEADER_CELL}>Last comm</th>
            <th className={HEADER_CELL}>Last entered report</th>
            <th className={HEADER_CELL}>Measured data</th>
            <th className={HEADER_CELL}>Open asks</th>
            <th className={HEADER_CELL}>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr
              key={c.clientId}
              className="border-b border-border/50 hover:bg-muted/40 cursor-pointer"
              onClick={() => navigate(`/clients/${c.clientId}`)}
              data-testid={`${prefix}-row-${c.clientId}`}
            >
              <td className="px-2 py-2">
                <span className="text-xs font-medium text-foreground whitespace-nowrap">
                  {c.firmName}
                </span>
                {c.clientCode && (
                  <span className="ml-1.5 text-caption text-muted-foreground">{c.clientCode}</span>
                )}
              </td>
              <td className="px-2 py-2">
                <OwnerCell name={c.ownerName} avatar={c.ownerAvatar} />
              </td>
              <td className="px-2 py-2">
                <span className="text-xs whitespace-nowrap text-muted-foreground" data-testid={`${prefix}-last-comm-${c.clientId}`}>
                  {fmtLastComm(c.lastCommAt)}
                </span>
              </td>
              <td className="px-2 py-2">
                <span className="text-xs whitespace-nowrap text-muted-foreground" data-testid={`${prefix}-last-report-${c.clientId}`}>
                  {c.lastEnteredReportMonth ?? "none"}
                </span>
              </td>
              <td className="px-2 py-2">
                <span className="text-xs whitespace-nowrap text-muted-foreground" data-testid={`${prefix}-measured-${c.clientId}`}>
                  {c.measuredMonths > 0
                    ? `${c.measuredMonths} month(s)`
                    : c.measuredSourceConfigured
                      ? "configured, no final months yet"
                      : "source not configured"}
                </span>
              </td>
              <td className="px-2 py-2">
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  {c.activeOpenAsks}
                </span>
              </td>
              <td className="px-2 py-2 max-w-md">
                <span className="text-caption text-muted-foreground" title={c.reasons.join("; ")}>
                  {c.reasons.join("; ")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function ChurnStabilityTriageTab() {
  const { data, isLoading, isError, error, refetch, isRefetching } =
    useQuery<TriageResponse>({
      queryKey: ["/api/churn/stability-triage"],
    });

  const clients = useMemo(() => data?.clients ?? [], [data]);
  const dataGaps = useMemo(() => clients.filter((c) => c.kind === "data_gap"), [clients]);
  const archiveCandidates = useMemo(
    () => clients.filter((c) => c.kind === "archive_candidate"),
    [clients],
  );

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="loading-stability-triage">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-10 bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to load stability triage";
    const denied = message.startsWith("403");
    return (
      <Card data-testid="error-stability-triage">
        <CardContent className="py-10 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground text-center">
            {denied ? "Access restricted to directors." : `Couldn't load the stability triage. ${message}`}
          </p>
          {!denied && (
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-stability-triage">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isRefetching ? "animate-spin" : ""}`} />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (clients.length === 0) {
    return (
      <Card data-testid="empty-stability-triage">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No client reads delivery stability "unknown" — every active client's latest judgment
          grounded a verdict from entered reports or measured data.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="stability-triage">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Database className="w-4 h-4 text-status-warn" />
          <h3 className="text-sm font-semibold text-foreground" data-testid="heading-triage-data-gaps">
            Data gaps ({dataGaps.length})
          </h3>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Active clients (recent activity exists) whose delivery can't be judged yet. The honest
          fix: enter real monthly reports through the normal report flow, or configure the
          client's measured BigQuery source on their detail page — never fabricated numbers.
        </p>
        {dataGaps.length === 0 ? (
          <p className="text-xs text-muted-foreground italic" data-testid="empty-triage-data-gaps">None.</p>
        ) : (
          <TriageRows clients={dataGaps} prefix="triage-gap" />
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <Archive className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground" data-testid="heading-triage-archive-candidates">
            Archive candidates ({archiveCandidates.length})
          </h3>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Dead across communications, entered reports, measured data, and open asks — likely no
          longer clients, so they shouldn't be judged at all. Open the client page to use the
          existing archive / offboarding actions; archiving is always a human decision and
          removes the client from judgments and dashboards.
        </p>
        {archiveCandidates.length === 0 ? (
          <p className="text-xs text-muted-foreground italic" data-testid="empty-triage-archive-candidates">None.</p>
        ) : (
          <TriageRows clients={archiveCandidates} prefix="triage-archive" />
        )}
      </div>
    </div>
  );
}
