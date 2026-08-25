/**
 * Task #3691 — Churn Command Center: Leaderboard tab.
 * Task #5123 — Authoritative rating integration (AccountRatingPresentation).
 *
 * Redesigned as a ranked briefing view: every active client gets a readable
 * row — rank, status (and since when), risk score with 7/30-day trend, owner
 * — with the daily judgment's REASONS inline (top concerns + what changed
 * since yesterday) and an evidence strip that grounds the score in real
 * facts: communications analyzed over which window, data-source badges,
 * confidence, days since the client last wrote in, and the client's real
 * lead/review counts from the monthly reports with ~30d and ~90d direction.
 * Rows expand in place (chevron or click, plus an expand-all control) to the
 * full narrative, recommended actions with rationale, wins, and the labeled
 * AI sub-signal grid — the client page is a secondary action, never required
 * to understand why a client is at risk. Zero-fresh-comms and
 * carried-forward judgments say so explicitly instead of silently showing a
 * score.
 *
 * Task #5123 additions:
 *  - judgment.rating (AccountRatingPresentation) is the authoritative source
 *    for status severity rank, status labels/definitions, risk band semantics,
 *    chip/number/filter tone decisions. All local independent score thresholds
 *    are deleted; a risk number's tone derives from the stored status via
 *    accountHealthContract.
 *  - Relationship is kept explicitly separate from Overall account health.
 *  - Every briefing row shows a concise authoritative explanation from
 *    rating.primaryDrivers: provenance, freshness/age, generated vs
 *    carried-forward lineage, and policy/revision. This is more prominent than
 *    old narrative concerns.
 *  - ChurnSignals are model-generated advisory indicators: the section is
 *    relabelled "Advisory AI indicators" with neutral visual bars/number colors
 *    so they cannot look like authoritative status.
 *
 * Reads GET /api/churn/leaderboard (director-gated, strict). Judgment
 * content is parsed with the same helpers the client-detail judgment stream
 * uses (client/src/lib/judgmentContent.ts) so the two surfaces can't drift.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle, ChevronDown, ChevronUp,
  CircleSlash, Clock, Database, ExternalLink, Lightbulb, ListChecks, Loader2,
  Maximize2, MessageSquare, MessageSquarePlus, Minimize2, Minus, RefreshCw,
  ShieldAlert, TrendingDown, TrendingUp, Zap,
} from "lucide-react";
import { StatusPill, type StatusTone } from "@/components/kit/StatusPill";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  asStringArray,
  normalizeRecommendedActions,
  parseJudgmentBasis,
  parseNarrativeSections,
} from "@/lib/judgmentContent";
import {
  accountHealthContract,
  type AccountHealthStatus,
  type AccountRatingPresentation,
  type RatingTone,
  isAccountHealthStatus,
} from "@shared/clientRating";

// ── API types (mirror server/routes/churn.ts response) ─────────────────────

interface ChurnJudgment {
  judgmentId: string | null;
  status: string;
  riskScore: number | null;
  headline: string | null;
  judgmentDate: string;
  summaryText: string | null;
  narrativeSummary: string | null;
  changeSummary: string | null;
  sentimentSummary: string | null;
  concernsJson: unknown;
  keyRisks: unknown;
  actionsJson: unknown;
  winsJson: unknown;
  keyOpportunities: unknown;
  unresolvedAskCount: number | null;
  communicationsAnalyzed: number | null;
  dataSourcesSummary: Record<string, unknown> | null;
  confidence: string | null;
  confidenceLevel: string | null;
  generatedFromStartAt: string | null;
  generatedFromEndAt: string | null;
  statusSince: string | null;
  /** Task #5123 — authoritative rating from the server's judgment gate. */
  rating?: AccountRatingPresentation | null;
}

interface ChurnSignals {
  signalDate: string;
  sentimentScore: number | null;
  complaintScore: number | null;
  trustScore: number | null;
  responsivenessRiskScore: number | null;
  executionRiskScore: number | null;
  leadVolumeConcernScore: number | null;
  unresolvedTaskScore: number | null;
  relationshipHealthScore: number | null;
}

interface ChurnEngagement {
  snapshotDate: string;
  daysSinceLastInbound: number | null;
  daysSinceLastCallMeeting: number | null;
  inbound30d: number | null;
  outbound30d: number | null;
}

interface ChurnReportMetrics {
  latestMonth: string;
  leads: number | null;
  reviews: number | null;
  prevMonth: string | null;
  leadsPrev: number | null;
  reviewsPrev: number | null;
  leadsAvg90: number | null;
  reviewsAvg90: number | null;
  leadsMonthsInAvg: number;
  reviewsMonthsInAvg: number;
}

// Task #4292 — operator concern intel attached to a client's leaderboard
// entry (last 90d, newest first). matchedConcern is the server's
// normalized-text match against the concerns the card displays.
export interface ConcernIntelEntry {
  id: string;
  judgmentId: string | null;
  concernText: string;
  intelType: string;
  note: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  matchedConcern: string | null;
}

export interface ChurnLeaderboardClient {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerAvatar: string | null;
  judgment: ChurnJudgment | null;
  signals: ChurnSignals | null;
  engagement: ChurnEngagement | null;
  reportMetrics: ChurnReportMetrics | null;
  concernIntel: ConcernIntelEntry[];
  riskDelta7d: number | null;
  riskDelta30d: number | null;
}

interface ChurnLeaderboardResponse {
  clients: ChurnLeaderboardClient[];
  generatedAt: string;
}

// Task #4812 — mirror of GET /api/churn/rejudge-progress
// (server/services/rejudgeStaleJudgments.ts getRejudgeRescoreProgress).
interface RejudgeRescoreProgress {
  running: boolean;
  runningSource: "local" | "cross-instance" | null;
  currentRevision: string;
  totalJudged: number;
  fresh: number;
  stale: number;
  lastFreshGeneratedAt: string | null;
}

// ── Contract helpers (Task #5123) ───────────────────────────────────────────
//
// accountHealthContract is the SOLE source for status severity rank, labels,
// definitions, risk band semantics, chip/number/filter tone decisions.
// No local independent score thresholds exist here.

/**
 * Map a contract RatingTone to the StatusPill StatusTone.
 * healthy→neutral, watch→warn, at-risk→warn, critical→critical.
 */
function ratingToneToStatusTone(tone: RatingTone): StatusTone {
  switch (tone) {
    case "critical": return "critical";
    case "at-risk": return "warn";
    case "watch": return "warn";
    case "healthy": return "neutral";
    default: return "neutral";
  }
}

/**
 * Derive the StatusPill tone for a status string.
 * Falls back to "neutral" for unknown statuses.
 */
function statusToTone(status: string): StatusTone {
  if (!isAccountHealthStatus(status)) return "neutral";
  return ratingToneToStatusTone(accountHealthContract[status].tone);
}

/**
 * Derive the status icon for a status string.
 */
function statusToIcon(status: string): typeof CheckCircle {
  if (status === "Critical") return ShieldAlert;
  if (status === "At Risk") return AlertTriangle;
  if (status === "Watch") return Clock;
  return CheckCircle;
}

/**
 * Severity rank for sorting: lower rank = more severe.
 * Uses accountHealthContract when available, falls back to a large number.
 */
function statusSeverityRank(status: string): number {
  if (isAccountHealthStatus(status)) return accountHealthContract[status].severityRank;
  return 99;
}

/**
 * Derive the CSS class for a risk number from the stored status.
 * Tone is authoritative — no local score thresholds.
 */
function riskScoreClassFromStatus(status: string | null | undefined): string {
  if (!status || !isAccountHealthStatus(status)) return "text-muted-foreground";
  switch (accountHealthContract[status].tone) {
    case "critical": return "text-status-critical";
    case "at-risk": return "text-status-warn";
    case "watch": return "text-status-warn";
    case "healthy": return "text-foreground";
    default: return "text-foreground";
  }
}

type StatusFilter = "all" | "Critical" | "At Risk" | "Watch" | "Healthy" | "no_data";

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; color: string; activeColor: string }> = [
  { key: "all", label: "All", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "Critical", label: "Critical", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "At Risk", label: "At Risk", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "Watch", label: "Watch", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "Healthy", label: "Healthy", color: "bg-muted text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
  { key: "no_data", label: "No Data", color: "bg-muted/50 text-muted-foreground hover:bg-muted", activeColor: "bg-primary text-primary-foreground" },
];

const CONFIDENCE_STYLES: Record<string, string> = {
  High: "bg-muted/50 text-muted-foreground border-border",
  Medium: "bg-muted/50 text-muted-foreground border-border",
  Low: "bg-status-warn/10 text-status-warn border-status-warn/30",
};

type SortField = "riskScore" | "delta7" | "delta30" | "judgmentDate" | "firmName" | "ownerName" | "status";
type SortDirection = "asc" | "desc";

const SORT_OPTIONS: Array<{ value: SortField; label: string }> = [
  { value: "riskScore", label: "Risk score" },
  { value: "delta7", label: "7-day change" },
  { value: "delta30", label: "30-day change" },
  { value: "judgmentDate", label: "Judgment date" },
  { value: "firmName", label: "Client name" },
  { value: "ownerName", label: "Owner" },
  { value: "status", label: "Status severity" },
];

const TEXT_FIELDS: SortField[] = ["firmName", "ownerName"];

// ── Formatting helpers ──────────────────────────────────────────────────────

function fmtScore(v: number | null): string {
  return v === null ? "—" : String(Math.round(v));
}

function fmtSigned(v: number): string {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : String(r);
}

/** "YYYY-MM" → "Jul 2026" (UTC-pinned so the label never slips a month). */
function fmtMonth(m: string | null): string {
  if (!m) return "—";
  const parts = m.split("-");
  const y = Number(parts[0]);
  const mo = Number(parts[1]);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, {
    month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** ISO timestamps → "Jul 29 – Aug 5" analysis-window label. */
function fmtWindow(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  const f = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(s)} – ${f(e)}`;
}

/** Format an ageDays number as a human-readable freshness label. */
function fmtAgeDays(ageDays: number | null): string {
  if (ageDays === null) return "";
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1 day ago";
  return `${ageDays}d ago`;
}

// ── Small presentational pieces ─────────────────────────────────────────────

/** 7/30-day risk delta: positive = risk rose = worsening (red, up). */
function DeltaCell({ delta, label, testId }: { delta: number | null; label: string; testId: string }) {
  if (delta === null) {
    return <span className="text-gray-300 text-xs whitespace-nowrap" data-testid={testId}>{label} —</span>;
  }
  const rounded = Math.round(delta);
  if (rounded > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-status-critical whitespace-nowrap" data-testid={testId}>
        {label} <TrendingUp className="w-3 h-3" /> {fmtSigned(delta)}
      </span>
    );
  }
  if (rounded < 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-status-ok whitespace-nowrap" data-testid={testId}>
        {label} <TrendingDown className="w-3 h-3" /> {fmtSigned(delta)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground whitespace-nowrap" data-testid={testId}>
      {label} <Minus className="w-3 h-3" /> 0
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone = statusToTone(status);
  const Icon = statusToIcon(status);
  return (
    <StatusPill tone={tone}>
      <Icon className="w-2.5 h-2.5" />
      {status}
    </StatusPill>
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

/**
 * Real business metric (leads/reviews from the monthly reports) with ~30d
 * (vs prior month) and ~90d (vs avg of up to 3 pre-latest months) direction.
 * Down = bad (red) — these are good-direction numbers, unlike risk deltas.
 */
function MetricTrend({
  label, month, value, prevMonth, prevValue, avg90, monthsInAvg, testId,
}: {
  label: string;
  month: string;
  value: number | null;
  prevMonth: string | null;
  prevValue: number | null;
  avg90: number | null;
  monthsInAvg: number;
  testId: string;
}) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-muted-foreground" data-testid={testId}>
        {label}: no data ({fmtMonth(month)})
      </span>
    );
  }
  const dir = (ref: number | null) => {
    if (ref === null) return null;
    const diff = value - ref;
    if (Math.abs(diff) < 0.05) return { Icon: Minus, cls: "text-muted-foreground" };
    return diff > 0
      ? { Icon: TrendingUp, cls: "text-status-ok" }
      : { Icon: TrendingDown, cls: "text-status-critical" };
  };
  const d30 = dir(prevValue);
  const d90 = dir(avg90);
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground flex-wrap" data-testid={testId}>
      <span className="font-medium text-foreground">{label} {value}</span>
      <span className="text-muted-foreground">({fmtMonth(month)})</span>
      {d30 && prevValue !== null && (
        <span className={`inline-flex items-center gap-0.5 ${d30.cls}`}>
          <d30.Icon className="w-3 h-3" />
          vs {fmtMonth(prevMonth)} {prevValue}
        </span>
      )}
      {d90 && avg90 !== null && monthsInAvg > 0 && (
        <span className={`inline-flex items-center gap-0.5 ${d90.cls}`}>
          <d90.Icon className="w-3 h-3" />
          vs {monthsInAvg}-mo avg {avg90}
        </span>
      )}
    </span>
  );
}

// ── Authoritative explanation (Task #5123) ───────────────────────────────────
//
// Rendered above concerns/narrative. Shows the primary drivers from
// rating.primaryDrivers with provenance, freshness/age, generated vs
// carried-forward lineage, and policy/revision. This is the most prominent
// piece of explanatory content in the briefing row.

function provenance_label(p: string): string {
  switch (p) {
    case "client-authored": return "Client-authored";
    case "objective": return "Objective";
    case "internal": return "Internal";
    default: return p;
  }
}

function freshness_label(f: string, ageDays: number | null): string {
  if (f === "current") return ageDays !== null ? `current · ${fmtAgeDays(ageDays)}` : "current";
  if (f === "standing") return ageDays !== null ? `standing · ${fmtAgeDays(ageDays)}` : "standing";
  return ageDays !== null ? fmtAgeDays(ageDays) : "unknown age";
}

function AuthoritativeExplanation({
  rating,
  clientId,
}: {
  rating: AccountRatingPresentation;
  clientId: string;
}) {
  const drivers = rating.primaryDrivers;
  const isCarriedForward = rating.generation === "carried-forward";
  const lineage = rating.lineage;

  // Build lineage/provenance metadata line
  const lineageLabel = isCarriedForward
    ? `Carried forward from ${lineage?.fromDate ?? "prior judgment"}`
    : `Generated ${rating.generatedAt ? rating.generatedAt.split("T")[0] : rating.judgmentDate}`;

  const policyLabel = `Policy v${rating.policyVersion}${rating.promptRevision ? ` · revision ${rating.promptRevision}` : ""}`;

  return (
    <div
      className="rounded border border-border bg-muted/30 px-2.5 py-2 space-y-1.5"
      data-testid={`authoritative-explanation-${clientId}`}
    >
      {/* Header: generation lineage + policy */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 text-caption font-semibold px-1.5 py-0.5 rounded border ${
            isCarriedForward
              ? "bg-status-warn/10 text-status-warn border-status-warn/30"
              : "bg-muted/50 text-muted-foreground border-border"
          }`}
          data-testid={`rating-lineage-${clientId}`}
        >
          {isCarriedForward ? <Clock className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
          {lineageLabel}
        </span>
        <span className="text-caption text-muted-foreground" data-testid={`rating-policy-${clientId}`}>
          {policyLabel}
        </span>
        {/* Relationship — explicitly separate from Overall account health */}
        {rating.relationship && (
          <span
            className="inline-flex items-center gap-1 text-caption px-1.5 py-0.5 rounded border bg-muted/50 text-muted-foreground border-border"
            data-testid={`rating-relationship-${clientId}`}
          >
            Relationship: {rating.relationship}
          </span>
        )}
      </div>

      {/* Primary drivers */}
      {drivers && drivers.length > 0 ? (
        <ul className="space-y-1" data-testid={`rating-drivers-${clientId}`}>
          {drivers.map((d) => (
            <li key={d.id} className="flex items-start gap-2 text-xs">
              <span
                className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                  d.severity === "critical"
                    ? "bg-status-critical"
                    : d.severity === "at-risk"
                    ? "bg-status-warn"
                    : d.severity === "watch"
                    ? "bg-status-warn/60"
                    : "bg-muted-foreground/40"
                }`}
              />
              <span className="flex-1 text-foreground font-medium">{d.label}</span>
              <span className="shrink-0 text-caption text-muted-foreground whitespace-nowrap">
                {provenance_label(d.provenance)} · {d.sourceLabel}
                {d.ageDays !== null || d.freshness !== "unknown"
                  ? ` · ${freshness_label(d.freshness, d.ageDays)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground italic">No primary drivers recorded for this rating.</p>
      )}
    </div>
  );
}

// ── Advisory AI indicators (relabelled from "AI-scored signals") ─────────────
//
// Task #5123: ChurnSignals are model-generated advisory indicators. The
// section is relabelled "Advisory AI indicators" and uses neutral visual
// bars/number colors so they cannot be mistaken for authoritative status.
// They remain expanded/secondary (inside the expanded section).

type SignalKind = "risk" | "good" | "sentiment";

const SIGNAL_META: Array<{ key: keyof ChurnSignals; label: string; kind: SignalKind; note?: string }> = [
  { key: "sentimentScore", label: "Sentiment", kind: "sentiment", note: "−100 to 100, higher = better" },
  { key: "complaintScore", label: "Complaints", kind: "risk" },
  { key: "trustScore", label: "Trust", kind: "good", note: "higher = better" },
  { key: "responsivenessRiskScore", label: "Responsiveness risk", kind: "risk" },
  { key: "executionRiskScore", label: "Execution risk", kind: "risk" },
  { key: "leadVolumeConcernScore", label: "Lead-volume concern (AI)", kind: "risk", note: "AI-judged from comms — real lead counts are in the evidence line" },
  { key: "unresolvedTaskScore", label: "Unresolved tasks", kind: "risk" },
  { key: "relationshipHealthScore", label: "Relationship health", kind: "good", note: "higher = better" },
];

/**
 * Advisory signal bar — neutral palette so scores cannot look like
 * authoritative status. All bars use muted/neutral colors.
 */
function advisorySignalBar(kind: SignalKind, v: number): { pct: number; barCls: string; textCls: string } {
  if (kind === "sentiment") {
    const pct = Math.max(0, Math.min(100, (v + 100) / 2));
    // Neutral: just show position, no status-color interpretation
    return {
      pct,
      barCls: "bg-muted-foreground/40",
      textCls: "text-muted-foreground",
    };
  }
  const pct = Math.max(0, Math.min(100, v));
  return {
    pct,
    barCls: "bg-muted-foreground/40",
    textCls: "text-muted-foreground",
  };
}

function SignalsGrid({ signals, clientId }: { signals: ChurnSignals; clientId: string }) {
  return (
    <div data-testid={`grid-signals-${clientId}`}>
      <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
        Advisory AI indicators
        <span className="normal-case font-normal ml-1.5 text-muted-foreground/70">
          · model-generated · {signals.signalDate} · not authoritative status
        </span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {SIGNAL_META.map((m) => {
          const raw = signals[m.key];
          const v = typeof raw === "number" ? raw : null;
          if (v === null) {
            return (
              <div key={m.key} className="flex items-center gap-2 text-caption text-gray-300">
                <span className="w-40 shrink-0 truncate" title={m.note}>{m.label}</span>
                <span>—</span>
              </div>
            );
          }
          const { pct, barCls, textCls } = advisorySignalBar(m.kind, v);
          return (
            <div key={m.key} className="flex items-center gap-2 text-caption" title={m.note}>
              <span className="w-40 shrink-0 truncate text-muted-foreground">{m.label}</span>
              <span className="flex-1 h-1.5 rounded-pill bg-muted overflow-hidden min-w-[40px]">
                <span className={`block h-full rounded-pill ${barCls}`} style={{ width: `${pct}%` }} />
              </span>
              <span className={`w-8 text-right tabular-nums ${textCls}`}>
                {m.kind === "sentiment" ? fmtSigned(v) : fmtScore(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Concern intel dialog (Task #4292) ───────────────────────────────────────
//
// Opened by clicking a flagged concern on a card. Shows existing operator
// intel for that concern, a context/resolved + note form, and a one-click
// "Re-run judgment now" so the card refreshes under the new information.

function ConcernIntelDialog({
  open, onOpenChange, clientId, firmName, judgmentId, concernText, entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  firmName: string;
  judgmentId: string | null;
  concernText: string;
  entries: ConcernIntelEntry[];
}) {
  const { toast } = useToast();
  const [intelType, setIntelType] = useState<"context" | "resolved">("context");
  const [note, setNote] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/churn/concern-intel", {
        clientId,
        judgmentId: judgmentId ?? undefined,
        concernText,
        intelType,
        note: note.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/leaderboard"] }); // fire-and-forget: cache refresh only
      toast({
        title: intelType === "resolved" ? "Concern marked resolved" : "Context added",
        description: "Saved — this will inform every future judgment for this client.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save intel",
        description: err?.message || "An error occurred",
        variant: "destructive",
      });
    },
  });

  const rerunMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/clients/${clientId}/judgments/regenerate`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/leaderboard"] }); // fire-and-forget: cache refresh only
      toast({ title: "Judgment re-run complete", description: `${firmName}'s card is refreshed.` });
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({
        title: "Re-run failed",
        description: err?.message || "An error occurred",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-concern-intel">
        <DialogHeader>
          <DialogTitle className="text-sm">Respond to flagged concern</DialogTitle>
          <DialogDescription className="text-xs whitespace-pre-line">
            {`${firmName}\n"${concernText}"`}
          </DialogDescription>
        </DialogHeader>

        {entries.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto" data-testid="list-existing-intel">
            {entries.map((e) => (
              <div key={e.id} className="rounded border border-border bg-muted/50 px-2 py-1.5 text-xs">
                <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  {e.intelType === "resolved" ? (
                    <span className="inline-flex items-center gap-1 text-status-ok font-medium">
                      <CheckCircle className="w-3 h-3" /> Resolved
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-status-info font-medium">
                      <MessageSquarePlus className="w-3 h-3" /> Context
                    </span>
                  )}
                  <span>
                    {e.createdByName ?? "Unknown"}
                    {e.createdAt ? ` · ${new Date(e.createdAt).toLocaleDateString()}` : ""}
                  </span>
                </p>
                <p className="text-foreground mt-0.5">{e.note}</p>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={intelType === "context" ? "default" : "outline"}
              className={intelType === "context" ? "bg-primary hover:bg-primary/90 h-7 text-xs" : "h-7 text-xs"}
              onClick={() => setIntelType("context")}
              data-testid="button-intel-type-context"
            >
              <MessageSquarePlus className="w-3 h-3 mr-1" />
              Add context
            </Button>
            <Button
              size="sm"
              variant={intelType === "resolved" ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => setIntelType("resolved")}
              data-testid="button-intel-type-resolved"
            >
              <CheckCircle className="w-3 h-3 mr-1" />
              Mark resolved
            </Button>
          </div>
          <div>
            <Label htmlFor="intel-note" className="text-xs text-muted-foreground">
              {intelType === "resolved"
                ? "How was this addressed? (feeds future judgments)"
                : "What does the AI not know? (feeds future judgments)"}
            </Label>
            <Textarea
              id="intel-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                intelType === "resolved"
                  ? "e.g. Called the client Tuesday — new campaign approved, they're satisfied."
                  : "e.g. Client is in trial for 3 weeks and told us replies would be slow."
              }
              className="mt-1 text-xs min-h-[70px]"
              maxLength={2000}
              data-testid="input-intel-note"
            />
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={() => rerunMutation.mutate()}
            disabled={rerunMutation.isPending}
            data-testid="button-rerun-judgment"
          >
            {rerunMutation.isPending ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            {rerunMutation.isPending ? "Re-running…" : "Re-run judgment now"}
          </Button>
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90 text-xs"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || note.trim().length === 0}
            data-testid="button-save-intel"
          >
            {saveMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Briefing row ────────────────────────────────────────────────────────────

function BriefingRow({
  c, rank, expanded, onToggle, onOpenClient,
}: {
  c: ChurnLeaderboardClient;
  rank: number | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenClient: () => void;
}) {
  const j = c.judgment!;
  const rating = j.rating ?? null;
  const basis = parseJudgmentBasis(j.dataSourcesSummary);
  const concerns = asStringArray(j.keyRisks) ?? asStringArray(j.concernsJson);
  // Task #4292 — concern-intel wiring: which dialog is open, which concerns
  // already have operator intel (matched server-side by normalized text),
  // and the recent entries that match none of the displayed concerns
  // (shown as an intel log in the expanded card).
  const [intelDialogConcern, setIntelDialogConcern] = useState<string | null>(null);
  const intel = useMemo(() => c.concernIntel ?? [], [c.concernIntel]);
  const intelByConcern = useMemo(() => {
    const m = new Map<string, ConcernIntelEntry[]>();
    for (const e of intel) {
      if (!e.matchedConcern) continue;
      const list = m.get(e.matchedConcern) ?? [];
      list.push(e);
      m.set(e.matchedConcern, list);
    }
    return m;
  }, [intel]);
  const unmatchedIntel = useMemo(() => intel.filter((e) => !e.matchedConcern), [intel]);
  const wins = asStringArray(j.keyOpportunities) ?? asStringArray(j.winsJson);
  const actions = normalizeRecommendedActions(j.actionsJson);
  const narrativeValue = (j.narrativeSummary ?? "").trim() || (j.summaryText ?? "").trim() || null;
  const narrativeSections = narrativeValue ? parseNarrativeSections(narrativeValue) : [];
  const confidence = j.confidenceLevel || j.confidence || null;
  const windowLabel = fmtWindow(j.generatedFromStartAt, j.generatedFromEndAt);
  const commsCount = j.communicationsAnalyzed;
  const zeroComms = commsCount === 0;
  const changeText = (j.changeSummary ?? "").trim() || null;
  // No structured concerns → surface the first paragraph of the headline
  // (which the API already falls back to the summary text), full-width and
  // un-clipped, so the row still explains itself without a click.
  const fallbackReason = !concerns && !changeText && j.headline
    ? j.headline.split(/\n\s*\n/)[0].trim()
    : null;
  const legacySources = !basis && j.dataSourcesSummary && typeof j.dataSourcesSummary === "object"
    ? Object.keys(j.dataSourcesSummary).slice(0, 5)
    : [];
  // Task #4048: judgments now analyze the FULL 30-day window, so analyzed ==
  // window count on new rows — showing "50 comms analyzed" next to a
  // "152 comms (30d)" badge was self-contradicting. When the two figures
  // agree, collapse them into the single chip and drop the duplicate badge;
  // when they differ (pre-fix rows: silent 50-row cap / double-counted
  // grain), keep both visible — that disagreement is honest history.
  const commsAgree =
    commsCount !== null && basis?.comms30d !== null && basis?.comms30d !== undefined && basis.comms30d === commsCount;
  const basisBadges = (basis?.basedOn.length ? basis.basedOn : legacySources).filter(
    (src) => !(commsAgree && /^\d+ comms? \(30d\)$/.test(src)),
  );

  // Risk score color derives from the stored status via accountHealthContract.
  const riskCls = riskScoreClassFromStatus(j.status);

  return (
    <div
      className="border border-border bg-card transition-colors hover:border-primary/20"
      data-testid={`row-churn-${c.clientId}`}
    >
      {/* Header — click to expand in place */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex items-center gap-2 flex-wrap px-3 py-2 cursor-pointer"
        aria-expanded={expanded}
        data-testid={`button-expand-${c.clientId}`}
      >
        <span className="text-xs font-semibold text-muted-foreground w-8 shrink-0">
          {rank !== null ? `#${rank}` : "—"}
        </span>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-semibold text-sm text-foreground truncate" data-testid={`text-firm-${c.clientId}`}>
            {c.firmName}
          </span>
          {c.clientCode && <span className="text-caption text-muted-foreground font-mono shrink-0">{c.clientCode}</span>}
          <StatusChip status={j.status} />
          {j.statusSince && (
            <span className="text-caption text-muted-foreground whitespace-nowrap" data-testid={`text-status-since-${c.clientId}`}>
              since {j.statusSince}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          <span className={`text-base font-bold tabular-nums ${riskCls}`} data-testid={`text-risk-${c.clientId}`}>
            {fmtScore(j.riskScore)}
          </span>
          <DeltaCell delta={c.riskDelta7d} label="7d" testId={`delta7-${c.clientId}`} />
          <DeltaCell delta={c.riskDelta30d} label="30d" testId={`delta30-${c.clientId}`} />
          <OwnerCell name={c.ownerName} avatar={c.ownerAvatar} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-caption text-primary-ink hover:bg-primary/5"
            onClick={(e) => {
              e.stopPropagation();
              onOpenClient();
            }}
            data-testid={`button-open-client-${c.clientId}`}
          >
            <ExternalLink className="w-3 h-3 mr-1" />
            Open client
          </Button>
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Authoritative explanation — most prominent, above concerns/narrative */}
      {rating && (
        <div className="px-3 pb-2 pl-[3.25rem]">
          <AuthoritativeExplanation rating={rating} clientId={c.clientId} />
        </div>
      )}

      {/* Reasons — always visible, never truncated to a single line */}
      <div className="px-3 pb-2 pl-[3.25rem] space-y-1.5">
        {changeText && (
          <p className="text-xs text-foreground flex items-start gap-1.5" data-testid={`text-what-changed-${c.clientId}`}>
            <Zap className="w-3 h-3 text-status-warn mt-0.5 shrink-0" />
            <span><span className="font-medium text-muted-foreground">What changed:</span> {changeText}</span>
          </p>
        )}
        {concerns && concerns.length > 0 && (
          <ul className="space-y-1" data-testid={`list-concerns-${c.clientId}`}>
            {concerns.map((risk, i) => {
              const riskIntel = intelByConcern.get(risk) ?? [];
              const resolvedEntry = riskIntel.find((e) => e.intelType === "resolved") ?? null;
              const addressed = riskIntel.length > 0 ? riskIntel[0] : null;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIntelDialogConcern(risk);
                    }}
                    className="group flex items-start gap-1.5 text-xs text-left w-full rounded px-1 -mx-1 py-0.5 hover:bg-primary/5 transition-colors"
                    title="Add context or mark resolved"
                    data-testid={`button-concern-${c.clientId}-${i}`}
                  >
                    {resolvedEntry ? (
                      <CheckCircle className="w-3 h-3 text-status-ok mt-0.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3 h-3 text-status-critical mt-0.5 shrink-0" />
                    )}
                    <span className={resolvedEntry ? "text-muted-foreground line-through decoration-gray-300" : "text-foreground"}>
                      {risk}
                    </span>
                    {addressed && (
                      <span
                        className="shrink-0 text-caption text-muted-foreground whitespace-nowrap mt-px"
                        data-testid={`text-intel-attribution-${c.clientId}-${i}`}
                      >
                        {resolvedEntry ? "resolved" : "context"} by {addressed.createdByName ?? "team"}
                        {addressed.createdAt ? ` · ${new Date(addressed.createdAt).toLocaleDateString()}` : ""}
                      </span>
                    )}
                    <MessageSquarePlus className="w-3 h-3 text-gray-300 group-hover:text-primary-ink mt-0.5 shrink-0 ml-auto" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {intelDialogConcern !== null && (
          <ConcernIntelDialog
            open={true}
            onOpenChange={(open) => {
              if (!open) setIntelDialogConcern(null);
            }}
            clientId={c.clientId}
            firmName={c.firmName}
            judgmentId={j.judgmentId}
            concernText={intelDialogConcern}
            entries={intelByConcern.get(intelDialogConcern) ?? []}
          />
        )}
        {fallbackReason && (
          <p className="text-xs text-foreground" data-testid={`text-reason-fallback-${c.clientId}`}>
            {fallbackReason}
          </p>
        )}
        {!changeText && !concerns && !fallbackReason && (
          <p className="text-xs text-muted-foreground italic">No judgment narrative recorded for {j.judgmentDate}.</p>
        )}
      </div>

      {/* Evidence strip — what this score is actually based on */}
      <div className="px-3 pb-2.5 pl-[3.25rem] flex items-center gap-x-3 gap-y-1.5 flex-wrap text-caption text-muted-foreground border-t border-gray-50 pt-2">
        <span className="inline-flex items-center gap-1" data-testid={`text-evidence-comms-${c.clientId}`}>
          <MessageSquare className="w-3 h-3 text-muted-foreground" />
          {commsCount !== null
            ? `${commsCount} comms analyzed${
                // Task #4292 — rows judged with lifetime context say so;
                // pre-4292 rows keep the legacy 30d-window wording.
                basis?.lifetime
                  ? ` (30d detail + ${basis.lifetime.totalComms} lifetime${
                      basis.lifetime.firstCommAt ? ` since ${basis.lifetime.firstCommAt.split("T")[0]}` : ""
                    })`
                  : commsAgree
                    ? " (full 30d window)"
                    : ""
              }`
            : "comms analyzed —"}
          {windowLabel ? ` · ${windowLabel}` : ""}
        </span>
        {zeroComms && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-status-warn/10 text-status-warn border border-status-warn/30"
            data-testid={`text-zero-comms-${c.clientId}`}
          >
            <AlertTriangle className="w-3 h-3" />
            No fresh comms in window — judged from operational data only
          </span>
        )}
        {basis?.carriedForward && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-status-warn/10 text-status-warn border border-status-warn/30"
            data-testid={`badge-carried-forward-${c.clientId}`}
          >
            <Clock className="w-3 h-3" />
            Carried forward{basis.carriedForward.fromDate ? ` from ${basis.carriedForward.fromDate}` : ""}
          </span>
        )}
        {basisBadges.map((src) => (
          <span key={src} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 border border-border text-muted-foreground">
            <Database className="w-2.5 h-2.5" />
            {src}
          </span>
        ))}
        {confidence && (
          <span
            className={`px-1.5 py-0.5 rounded border font-medium ${CONFIDENCE_STYLES[confidence] ?? "bg-muted/50 text-muted-foreground border-border"}`}
            data-testid={`badge-confidence-${c.clientId}`}
          >
            {confidence} confidence
          </span>
        )}
        <span className="text-muted-foreground">Judged {j.judgmentDate}</span>
        {c.engagement && c.engagement.daysSinceLastInbound !== null && (
          <span
            className={c.engagement.daysSinceLastInbound > 14 ? "text-status-critical font-medium" : ""}
            data-testid={`text-inbound-recency-${c.clientId}`}
          >
            Client last wrote {c.engagement.daysSinceLastInbound}d ago
          </span>
        )}
        {c.engagement && c.engagement.inbound30d !== null && (
          <span data-testid={`text-inbound-30d-${c.clientId}`}>{c.engagement.inbound30d} inbound / 30d</span>
        )}
        {c.reportMetrics ? (
          <>
            <MetricTrend
              label="Leads"
              month={c.reportMetrics.latestMonth}
              value={c.reportMetrics.leads}
              prevMonth={c.reportMetrics.prevMonth}
              prevValue={c.reportMetrics.leadsPrev}
              avg90={c.reportMetrics.leadsAvg90}
              monthsInAvg={c.reportMetrics.leadsMonthsInAvg}
              testId={`metric-leads-${c.clientId}`}
            />
            <MetricTrend
              label="Reviews"
              month={c.reportMetrics.latestMonth}
              value={c.reportMetrics.reviews}
              prevMonth={c.reportMetrics.prevMonth}
              prevValue={c.reportMetrics.reviewsPrev}
              avg90={c.reportMetrics.reviewsAvg90}
              monthsInAvg={c.reportMetrics.reviewsMonthsInAvg}
              testId={`metric-reviews-${c.clientId}`}
            />
          </>
        ) : (
          <span className="text-muted-foreground" data-testid={`metric-none-${c.clientId}`}>No monthly-report metrics</span>
        )}
      </div>

      {/* Expanded: full narrative, actions, wins, labeled advisory AI indicators */}
      {expanded && (
        <div className="px-3 pb-3 pl-[3.25rem] pt-2 border-t border-border space-y-3" data-testid={`section-expanded-${c.clientId}`}>
          {j.sentimentSummary && (
            <p className="text-xs text-muted-foreground italic">{j.sentimentSummary}</p>
          )}
          {narrativeSections.length > 0 ? (
            <div className="space-y-2.5">
              {narrativeSections.map((sec, i) => (
                <div key={i}>
                  <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-0.5 flex items-center gap-1">
                    <sec.icon className="w-3 h-3" />
                    {sec.heading}
                  </p>
                  <p className="text-xs text-foreground whitespace-pre-line">{sec.content}</p>
                </div>
              ))}
            </div>
          ) : narrativeValue ? (
            <p className="text-xs text-foreground whitespace-pre-line" data-testid={`text-narrative-${c.clientId}`}>{narrativeValue}</p>
          ) : (
            <p className="text-xs text-muted-foreground italic">No full narrative stored for this judgment.</p>
          )}

          {actions.length > 0 && (
            <div>
              <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <ListChecks className="w-3 h-3" />
                Recommended actions
              </p>
              <ul className="space-y-1" data-testid={`list-actions-${c.clientId}`}>
                {actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                    <CheckCircle className="w-3 h-3 text-primary mt-0.5 shrink-0" />
                    <span>
                      {a.action}
                      {a.why && <span className="text-muted-foreground"> — {a.why}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {wins && wins.length > 0 && (
            <div>
              <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <Lightbulb className="w-3 h-3" />
                Wins / useful observations
              </p>
              <ul className="space-y-1" data-testid={`list-wins-${c.clientId}`}>
                {wins.map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                    <CheckCircle className="w-3 h-3 text-status-ok mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {j.unresolvedAskCount !== null && j.unresolvedAskCount > 0 && (
            <p className="text-caption text-status-warn" data-testid={`text-unresolved-asks-${c.clientId}`}>
              {j.unresolvedAskCount} unresolved client ask{j.unresolvedAskCount === 1 ? "" : "s"} on record
            </p>
          )}

          {unmatchedIntel.length > 0 && (
            <div>
              <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <MessageSquarePlus className="w-3 h-3" />
                Operator intel log (not tied to a current concern)
              </p>
              <ul className="space-y-1" data-testid={`list-intel-log-${c.clientId}`}>
                {unmatchedIntel.map((e) => (
                  <li key={e.id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    {e.intelType === "resolved" ? (
                      <CheckCircle className="w-3 h-3 text-status-ok mt-0.5 shrink-0" />
                    ) : (
                      <MessageSquarePlus className="w-3 h-3 text-status-info mt-0.5 shrink-0" />
                    )}
                    <span>
                      <span className="text-muted-foreground">"{e.concernText}"</span> — {e.note}
                      <span className="text-caption text-muted-foreground">
                        {" "}
                        ({e.createdByName ?? "team"}
                        {e.createdAt ? `, ${new Date(e.createdAt).toLocaleDateString()}` : ""})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {c.signals ? (
            <SignalsGrid signals={c.signals} clientId={c.clientId} />
          ) : (
            <p className="text-caption text-muted-foreground">No advisory AI indicators for this client yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function ChurnLeaderboardTab() {
  const [, navigate] = useLocation();
  const [sortField, setSortField] = useState<SortField>("riskScore");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, error, refetch, isRefetching } =
    useQuery<ChurnLeaderboardResponse>({
      queryKey: ["/api/churn/leaderboard"],
    });

  // Task #4812 — re-score progress. After a judge-calibration change the CEO
  // presses "Re-judge stale client judgments" and then looks HERE, at a board
  // still full of old-calibration scores — without this banner a healthy
  // mid-drain board is indistinguishable from a failed fix. Poll faster while
  // a drain is running (anywhere in the cluster) so the fraction moves.
  const { data: rescore } = useQuery<RejudgeRescoreProgress>({
    queryKey: ["/api/churn/rejudge-progress"],
    refetchInterval: (query) => (query.state.data?.running ? 15_000 : 60_000),
  });

  // While the drain lands fresh judgments, the leaderboard (staleTime 5min)
  // would sit visibly frozen — nudge it whenever another client is re-scored
  // and once more when the run finishes, so rows update as the banner counts.
  const prevRescoreRef = useRef<{ fresh: number; running: boolean } | null>(null);
  useEffect(() => {
    if (!rescore) return;
    const prev = prevRescoreRef.current;
    prevRescoreRef.current = { fresh: rescore.fresh, running: rescore.running };
    if (!prev) return;
    if ((rescore.running && rescore.fresh !== prev.fresh) || (prev.running && !rescore.running)) {
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/leaderboard"] }); // fire-and-forget: cache refresh only
    }
  }, [rescore]);

  const allClients = useMemo(() => data?.clients ?? [], [data]);
  const scoredAll = useMemo(() => allClients.filter((c) => c.judgment !== null), [allClients]);
  const noDataAll = useMemo(() => allClients.filter((c) => c.judgment === null), [allClients]);

  // Risk rank (1 = highest risk) is fixed by riskScore regardless of the
  // active sort, so re-sorting never re-numbers the leaderboard.
  const rankById = useMemo(() => {
    const m = new Map<string, number>();
    scoredAll
      .filter((c) => c.judgment!.riskScore !== null)
      .sort((a, b) => b.judgment!.riskScore! - a.judgment!.riskScore!)
      .forEach((c, i) => m.set(c.clientId, i + 1));
    return m;
  }, [scoredAll]);

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    allClients.forEach((c) => {
      if (c.ownerId && c.ownerName) m.set(c.ownerId, c.ownerName);
    });
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allClients]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allClients.length, no_data: noDataAll.length };
    scoredAll.forEach((c) => {
      const s = c.judgment!.status;
      counts[s] = (counts[s] ?? 0) + 1;
    });
    return counts;
  }, [allClients, scoredAll, noDataAll]);

  // Task #5123 — status sort uses accountHealthContract severityRank, not
  // local order constants.
  const numericValue = (c: ChurnLeaderboardClient, field: SortField): number | null => {
    switch (field) {
      case "status": return c.judgment ? statusSeverityRank(c.judgment.status) : 99;
      case "riskScore": return c.judgment?.riskScore ?? null;
      case "delta7": return c.riskDelta7d;
      case "delta30": return c.riskDelta30d;
      case "judgmentDate": {
        if (!c.judgment) return null;
        const t = Date.parse(c.judgment.judgmentDate);
        return Number.isNaN(t) ? null : t;
      }
      default: return null;
    }
  };

  const ownerMatches = (c: ChurnLeaderboardClient) =>
    ownerFilter === "all" || c.ownerId === ownerFilter;

  const tableRows = useMemo(() => {
    if (statusFilter === "no_data") return [];
    let rows = scoredAll.filter(ownerMatches);
    if (statusFilter !== "all") rows = rows.filter((c) => c.judgment!.status === statusFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (TEXT_FIELDS.includes(sortField)) {
        const av = sortField === "firmName" ? a.firmName : (a.ownerName ?? "");
        const bv = sortField === "firmName" ? b.firmName : (b.ownerName ?? "");
        return dir * av.localeCompare(bv);
      }
      const av = numericValue(a, sortField);
      const bv = numericValue(b, sortField);
      // Missing values always sink to the bottom regardless of direction.
      if (av === null && bv === null) return a.firmName.localeCompare(b.firmName);
      if (av === null) return 1;
      if (bv === null) return -1;
      return dir * (av - bv);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoredAll, statusFilter, ownerFilter, sortField, sortDir]);

  const bucketRows = useMemo(
    () => noDataAll.filter(ownerMatches).sort((a, b) => a.firmName.localeCompare(b.firmName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noDataAll, ownerFilter],
  );

  const showBucket = statusFilter === "all" || statusFilter === "no_data";

  const allExpanded = tableRows.length > 0 && tableRows.every((c) => expandedIds.has(c.clientId));

  const toggleRow = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(tableRows.map((c) => c.clientId)));
    }
  };

  const onSortFieldChange = (v: string) => {
    const field = v as SortField;
    setSortField(field);
    setSortDir(TEXT_FIELDS.includes(field) || field === "status" ? "asc" : "desc");
  };

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="loading-churn-leaderboard">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-24 bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to load leaderboard";
    const denied = message.startsWith("403");
    return (
      <Card data-testid="error-churn-leaderboard">
        <CardContent className="py-10 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground text-center">
            {denied ? "Access restricted to directors." : `Couldn't load the leaderboard. ${message}`}
          </p>
          {!denied && (
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-leaderboard">
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
      <Card data-testid="empty-churn-leaderboard">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No active clients yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Task #4812 — re-score progress banner: a mid-drain board full of
          old-calibration scores must say so, or a healthy re-score reads as
          a failed fix. */}
      {rescore?.running && (
        <div
          className="border border-primary/30 bg-primary/5 px-3 py-2.5 flex items-start gap-2"
          data-testid="banner-rejudge-running"
        >
          <Loader2 className="w-4 h-4 text-primary mt-0.5 shrink-0 animate-spin" />
          <div className="text-xs text-foreground/80">
            <p className="font-semibold">
              Re-scoring in progress — {rescore.fresh} of {rescore.totalJudged} clients re-judged
              under the current calibration
            </p>
            <p className="mt-0.5">
              A background re-judge run is working through the book (roughly one client per
              minute). Rows refresh as each client lands; scores still waiting show the previous
              calibration and may read too harsh until their turn.
            </p>
          </div>
        </div>
      )}
      {!rescore?.running && (rescore?.stale ?? 0) > 0 && (
        <div
          className="border border-status-warn/40 bg-status-warn/5 px-3 py-2.5 flex items-start gap-2"
          data-testid="banner-rejudge-stale"
        >
          <AlertTriangle className="w-4 h-4 text-status-warn mt-0.5 shrink-0" />
          <div className="text-xs text-foreground/80">
            <p className="font-semibold">
              {rescore!.stale} of {rescore!.totalJudged} clients are scored under an older judge
              calibration
            </p>
            <p className="mt-0.5">
              Their scores predate the latest calibration change. They re-score with the next
              &ldquo;Re-judge stale client judgments&rdquo; run or tonight&apos;s scheduled
              refresh; clients with no usable data keep their last score until data returns.
            </p>
          </div>
        </div>
      )}
      {/* Filters + sort + expand-all */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-2.5 py-1 rounded-pill text-caption font-medium transition-colors ${
                statusFilter === f.key ? f.activeColor : f.color
              }`}
              data-testid={`filter-status-${f.key === "all" ? "all" : f.key.toLowerCase().replace(" ", "_")}`}
            >
              {f.label} ({statusCounts[f.key] ?? 0})
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Select value={sortField} onValueChange={onSortFieldChange}>
            <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-sort-field">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>Sort: {o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label={`Sort direction: ${sortDir === "asc" ? "ascending" : "descending"}`}
            data-testid="button-sort-direction"
          >
            {sortDir === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
          </Button>
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-owner-filter">
              <SelectValue placeholder="All owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {owners.map(([id, name]) => (
                <SelectItem key={id} value={id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={toggleExpandAll}
            disabled={tableRows.length === 0}
            data-testid="button-expand-all"
          >
            {allExpanded ? (
              <>
                <Minimize2 className="w-3.5 h-3.5 mr-1" />
                Collapse all
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 mr-1" />
                Expand all
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Briefing rows */}
      {statusFilter !== "no_data" && (
        <div className="space-y-2" data-testid="table-churn-leaderboard">
          {tableRows.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-matching-rows">
                No clients match the current filters.
              </CardContent>
            </Card>
          ) : (
            tableRows.map((c) => (
              <BriefingRow
                key={c.clientId}
                c={c}
                rank={rankById.get(c.clientId) ?? null}
                expanded={expandedIds.has(c.clientId)}
                onToggle={() => toggleRow(c.clientId)}
                onOpenClient={() => navigate(`/clients/${c.clientId}`)}
              />
            ))
          )}
        </div>
      )}

      {/* No-data bucket — clients the daily judgment hasn't scored yet. */}
      {showBucket && bucketRows.length > 0 && (
        <Card data-testid="bucket-no-data">
          <CardContent className="py-3 px-3">
            <div className="flex items-center gap-2 mb-2">
              <CircleSlash className="w-3.5 h-3.5 text-muted-foreground" />
              <h3 className="text-xs font-semibold text-muted-foreground">
                No judgment data yet ({bucketRows.length})
              </h3>
            </div>
            <div className="divide-y divide-border">
              {bucketRows.map((c) => (
                <div
                  key={c.clientId}
                  onClick={() => navigate(`/clients/${c.clientId}`)}
                  className="flex items-center justify-between gap-2 py-1.5 cursor-pointer hover:bg-muted/50 rounded px-1.5 transition-colors"
                  data-testid={`row-churn-nodata-${c.clientId}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-foreground truncate">{c.firmName}</span>
                    {c.clientCode && <span className="text-caption text-muted-foreground font-mono">{c.clientCode}</span>}
                  </div>
                  <OwnerCell name={c.ownerName} avatar={c.ownerAvatar} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <p className="text-caption text-muted-foreground" data-testid="text-generated-at">
          {allClients.length} active client{allClients.length === 1 ? "" : "s"} · updated{" "}
          {new Date(data.generatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
