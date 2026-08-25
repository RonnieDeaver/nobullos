import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, type CardAccent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format, subDays } from "date-fns";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown, ChevronUp, RefreshCw, Shield, Heart,
  AlertTriangle, CheckCircle, Eye, TrendingDown, Clock,
  Target, Lightbulb, AlertCircle, Check, X, Loader2, TrendingUp,
  MessageSquareOff, Database, LifeBuoy, Info
} from "lucide-react";
import SavePlaysPanel, { type SavePlayPrefill } from "@/components/SavePlaysPanel";
// Judgment-content parsing shared with the Churn Command Center leaderboard
// (extracted from this file — see client/src/lib/judgmentContent.ts).
import {
  asStringArray,
  normalizeRecommendedActions,
  parseJudgmentBasis,
  parseNarrativeSections,
  stripListMarker,
} from "@/lib/judgmentContent";
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

type DailyJudgment = {
  id: string;
  clientId: string;
  judgmentDate: string;
  status: string;
  relationshipHealth: string | null;
  relationshipStatus: string | null;
  confidence: string | null;
  confidenceLevel: string | null;
  overallSentiment: number | null;
  sentimentTrend: string | null;
  headline: string | null;
  narrativeSummary: string | null;
  summaryText: string | null;
  keyRisks: string[] | null;
  keyOpportunities: string[] | null;
  concernsJson: unknown;
  winsJson: unknown;
  unresolvedAskCount: number | null;
  communicationsAnalyzed: number | null;
  dataSourcesSummary: Record<string, unknown> | null;
  /** Task #3696: recommended actions [{action, why}] — source for save-play prefill. */
  actionsJson: unknown;
  /** Task #5123 — authoritative structured rating from the server judgment gate. */
  rating?: AccountRatingPresentation | null;
  createdAt: string;
};

type OpenAsk = {
  id: string;
  clientId: string;
  askType: string;
  summary: string;
  detail: string | null;
  status: string;
  concernScore: number | null;
  firstMentionedAt: string | null;
  lastReferencedAt: string | null;
  mentionCount: number | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
};

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

// Task #5123 — STATUS_CONFIG entries match accountHealthContract keys exactly.
// Unknown values must NOT fall back to Healthy; they render neutral/explicit
// (see JudgmentCard where statusCfg may be null for an unknown status).
// Task #4372 (audit P2-14): the left rail rides the shared Card `accent`
// variant instead of a hand-rolled `border-l-*` class. Badges keep their
// four palette tones; the rail collapses to the kit's status scale
// (Watch/At Risk both map to "warn" — "critical" stays act-now-only).
const STATUS_STYLE_BY_TONE: Record<RatingTone, {
  color: string;
  dotColor: string;
  icon: LucideIcon;
  accent: CardAccent;
}> = {
  healthy: { color: "bg-green-100 text-green-800 border-green-200", dotColor: "bg-green-500", icon: CheckCircle, accent: "ok" },
  watch: { color: "bg-yellow-100 text-yellow-800 border-yellow-200", dotColor: "bg-yellow-500", icon: Eye, accent: "warn" },
  "at-risk": { color: "bg-orange-100 text-orange-800 border-orange-200", dotColor: "bg-orange-500", icon: AlertTriangle, accent: "warn" },
  critical: { color: "bg-red-100 text-red-800 border-red-200", dotColor: "bg-red-500", icon: AlertCircle, accent: "critical" },
};

const STATUS_CONFIG = Object.fromEntries(
  accountHealthStatusOptions.map(status => [
    status,
    {
      ...STATUS_STYLE_BY_TONE[accountHealthContract[status].tone],
      label: accountHealthContract[status].label,
    },
  ]),
) as Record<AccountHealthStatus, {
  label: string;
  color: string;
  dotColor: string;
  icon: LucideIcon;
  accent: CardAccent;
}>;

// Neutral config for unknown/unrecognized statuses — renders without green
// coloring so an unknown value is visually explicit, not misleadingly healthy.
const STATUS_CONFIG_UNKNOWN = {
  label: "Unknown",
  color: "bg-muted/50 text-muted-foreground border-border",
  dotColor: "bg-muted-foreground/40",
  icon: AlertCircle as LucideIcon,
  accent: "neutral" as CardAccent,
};

const RELATIONSHIP_STYLE_BY_RANK: Record<number, { color: string; icon: LucideIcon }> = {
  3: { color: "bg-green-50 text-green-700 border-green-200", icon: Heart },
  2: { color: "bg-blue-50 text-blue-700 border-blue-200", icon: Shield },
  1: { color: "bg-orange-50 text-orange-700 border-orange-200", icon: TrendingDown },
  0: { color: "bg-red-50 text-red-700 border-red-200", icon: AlertTriangle },
};

const RELATIONSHIP_CONFIG = Object.fromEntries(
  relationshipReadOptions.map(status => [
    status,
    {
      ...RELATIONSHIP_STYLE_BY_RANK[relationshipReadContract[status].severityRank],
      label: relationshipReadContract[status].label,
    },
  ]),
) as Record<RelationshipRead, { label: string; color: string; icon: LucideIcon }>;

const CONFIDENCE_CONFIG: Record<string, { label: string; color: string }> = {
  "High": { label: "High", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "Medium": { label: "Medium", color: "bg-amber-50 text-amber-700 border-amber-200" },
  "Low": { label: "Low", color: "bg-muted/50 text-muted-foreground border-border" },
};

const SENTIMENT_TREND_CONFIG: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  "improving": { label: "Improving", icon: TrendingUp, color: "text-green-600" },
  "stable": { label: "Stable", icon: Shield, color: "text-blue-600" },
  "declining": { label: "Declining", icon: TrendingDown, color: "text-red-600" },
};

const ASK_STATUS_CONFIG: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  open: { label: "Open", color: "bg-red-100 text-red-700", icon: AlertCircle },
  likely_open: { label: "Likely Open", color: "bg-orange-100 text-orange-700", icon: AlertTriangle },
  likely_resolved: { label: "Likely Resolved", color: "bg-blue-100 text-blue-700", icon: Clock },
  resolved: { label: "Resolved", color: "bg-green-100 text-green-700", icon: CheckCircle },
  dismissed: { label: "Dismissed", color: "bg-muted text-muted-foreground", icon: X },
};

function JudgmentCard({
  judgment,
  onStartSavePlay,
}: {
  judgment: DailyJudgment;
  onStartSavePlay?: (prefill: SavePlayPrefill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Task #5123 — unknown statuses render neutral/explicit, never fall back to
  // Healthy (which would give a misleading green to an unrecognized status).
  const statusCfg = isAccountHealthStatus(judgment.status)
    ? STATUS_CONFIG[judgment.status]
    : STATUS_CONFIG_UNKNOWN;
  // Legacy display columns and the newer *Status/*Level/summary_text columns
  // are written in lockstep for new rows, but older rows may only have one
  // side populated — read both.
  const relationshipValue = judgment.relationshipHealth || judgment.relationshipStatus;
  const confidenceValue = judgment.confidenceLevel || judgment.confidence;
  const narrativeValue = judgment.narrativeSummary || judgment.summaryText;
  const risksValue = (judgment.keyRisks && judgment.keyRisks.length > 0) ? judgment.keyRisks : asStringArray(judgment.concernsJson);
  const winsValue = (judgment.keyOpportunities && judgment.keyOpportunities.length > 0) ? judgment.keyOpportunities : asStringArray(judgment.winsJson);
  const relCfg = isRelationshipRead(relationshipValue) ? RELATIONSHIP_CONFIG[relationshipValue] : null;
  const confCfg = confidenceValue ? CONFIDENCE_CONFIG[confidenceValue] : null;
  const trendCfg = judgment.sentimentTrend ? SENTIMENT_TREND_CONFIG[judgment.sentimentTrend] : null;
  const StatusIcon = statusCfg.icon;
  const basis = parseJudgmentBasis(judgment.dataSourcesSummary);

  // Task #5123 — structured rating from the server judgment gate.
  const rating = judgment.rating ?? null;
  const ratingStatus = rating && isAccountHealthStatus(rating.status) ? rating.status : null;
  const ratingRelationship = rating?.relationship && isRelationshipRead(rating.relationship) ? rating.relationship : null;
  const ratingContractEntry = ratingStatus ? accountHealthContract[ratingStatus] : null;
  const relContractEntry = ratingRelationship ? relationshipReadContract[ratingRelationship] : null;

  const narrativeSections = narrativeValue ? parseNarrativeSections(narrativeValue) : [];
  const hasStructuredNarrative = narrativeSections.length > 1;
  const recommendedActions = normalizeRecommendedActions(judgment.actionsJson);

  const startPlayFromAction = (action: string, why: string | null) => {
    onStartSavePlay?.({
      title: action.slice(0, 300),
      why,
      sourceJudgmentId: judgment.id,
    });
  };

  const hasExpandableContent = narrativeValue ||
    recommendedActions.length > 0 ||
    (risksValue && risksValue.length > 0) ||
    (winsValue && winsValue.length > 0) ||
    judgment.overallSentiment !== null ||
    judgment.sentimentTrend ||
    basis;

  return (
    <Card
      accent={statusCfg.accent}
      className="bg-card transition-all"
      data-testid={`card-judgment-${judgment.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="text-sm font-semibold text-foreground" data-testid={`text-judgment-date-${judgment.id}`}>
                {format(new Date(judgment.judgmentDate), "EEEE, MMM d, yyyy")}
              </span>
              {judgment.communicationsAnalyzed !== null && judgment.communicationsAnalyzed > 0 && (
                <span className="text-xs text-muted-foreground/70">
                  ({judgment.communicationsAnalyzed} comms analyzed)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {/* Task #5123 — label both dimensions explicitly */}
              <span className="inline-flex items-center gap-1">
                <span className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Overall account health</span>
                <Badge className={`${statusCfg.color} text-xs border`} data-testid={`badge-overall-status-${judgment.id}`}>
                  <StatusIcon className="w-3 h-3 mr-1" />
                  {statusCfg.label}
                </Badge>
              </span>
              {relCfg && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Relationship</span>
                  <Badge className={`${relCfg.color} text-xs border`} data-testid={`badge-relationship-status-${judgment.id}`}>
                    <relCfg.icon className="w-3 h-3 mr-1" />
                    {relCfg.label}
                  </Badge>
                </span>
              )}
              {confCfg && (
                <Badge className={`${confCfg.color} text-xs border`} data-testid={`badge-confidence-${judgment.id}`}>
                  {confCfg.label} Confidence
                </Badge>
              )}
              {/* Prefer rating.basisTier/lineage for operational/carried-forward badges;
                  fall back to legacy judgmentBasis for older rows. */}
              {(rating ? rating.basisTier === "operational" : basis?.tier === "operational") && (
                <Badge className="bg-sky-50 text-sky-700 border-sky-200 text-xs border" data-testid={`badge-operational-basis-${judgment.id}`}>
                  <Database className="w-3 h-3 mr-1" />
                  Operational data
                </Badge>
              )}
              {(rating ? rating.generation === "carried-forward" : !!basis?.carriedForward) && (
                <Badge
                  className="bg-muted/50 text-muted-foreground border-border text-xs border"
                  data-testid={`badge-carried-forward-${judgment.id}`}
                  title={
                    rating?.lineage?.fromDate
                      ? `No new inputs since ${rating.lineage.fromDate}; status carried forward without a fresh AI call.`
                      : basis?.carriedForward?.fromDate
                        ? `No new inputs since ${basis.carriedForward.fromDate}; status carried forward without a fresh AI call.`
                        : "No new inputs since the prior judgment; status carried forward."
                  }
                >
                  <Clock className="w-3 h-3 mr-1" />
                  Carried forward
                </Badge>
              )}
              {trendCfg && (
                <span className={`inline-flex items-center gap-1 text-xs font-medium ${trendCfg.color}`}>
                  <trendCfg.icon className="w-3 h-3" />
                  {trendCfg.label}
                </span>
              )}
              {judgment.unresolvedAskCount !== null && judgment.unresolvedAskCount > 0 && (
                <Badge className="bg-red-50 text-red-700 border-red-200 text-xs border" data-testid={`badge-unresolved-count-${judgment.id}`}>
                  <Target className="w-3 h-3 mr-1" />
                  {judgment.unresolvedAskCount} unresolved
                </Badge>
              )}
            </div>
            {/* Task #5123 — authoritative rating explanation (visually primary when present).
                Shows contract definition, primary drivers with provenance/freshness/age,
                and lineage. The model narrative/confidence/sentiment below is secondary. */}
            {rating && ratingContractEntry && (
              <div className="mb-2 rounded-none border border-border/60 bg-muted/20 px-3 py-2 space-y-1.5" data-testid={`section-rating-authoritative-${judgment.id}`}>
                <p className="text-xs font-semibold text-foreground flex items-center gap-1">
                  <Info className="w-3 h-3 text-muted-foreground" />
                  {ratingContractEntry.label}: {ratingContractEntry.definition}
                </p>
                {relContractEntry && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Relationship ({relContractEntry.label}):</span> {relContractEntry.definition}
                  </p>
                )}
                {rating.primaryDrivers.length > 0 && (
                  <div data-testid={`section-rating-drivers-${judgment.id}`}>
                    <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1">Key drivers</p>
                    <ul className="space-y-0.5">
                      {rating.primaryDrivers.map((d) => (
                        <li key={d.id} className="text-xs text-foreground/85 flex items-start gap-1.5" data-testid={`driver-${judgment.id}-${d.id}`}>
                          <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-primary/40" />
                          <span>
                            {d.label}
                            <span className="text-muted-foreground ml-1">
                              [{d.provenance}
                              {d.ageDays !== null ? ` · ${d.ageDays}d ago` : ""}
                              {d.freshness !== "unknown" ? ` · ${d.freshness}` : ""}]
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {rating.generation === "carried-forward" && rating.lineage?.fromDate && (
                  <p className="text-caption text-muted-foreground/80">
                    Carried forward from {rating.lineage.fromDate} (root: {rating.lineage.rootDate}) · inputs unchanged
                  </p>
                )}
                <p className="text-caption text-muted-foreground/60">
                  Policy v{rating.policyVersion}{rating.promptRevision ? ` · revision ${rating.promptRevision}` : ""}
                  {rating.judgmentDate ? ` · ${rating.judgmentDate}` : ""}
                </p>
              </div>
            )}
            {judgment.headline && (
              <p className="text-sm text-foreground/90 leading-relaxed font-medium" data-testid={`text-judgment-headline-${judgment.id}`}>
                {judgment.headline}
              </p>
            )}
            {basis && basis.basedOn.length > 0 && (
              <p className="text-caption text-muted-foreground/70 mt-1" data-testid={`text-judgment-basis-${judgment.id}`}>
                Based on: {basis.basedOn.join(" · ")}
              </p>
            )}
          </div>
          {hasExpandableContent && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-8 w-8 p-0"
              onClick={() => setExpanded(!expanded)}
              data-testid={`button-expand-judgment-${judgment.id}`}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          )}
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t border-border space-y-4" data-testid={`section-judgment-details-${judgment.id}`}>
            {/* Task #5123 — when a structured rating is present, model
                narrative/confidence/sentiment are secondary/advisory. Label
                them accordingly to distinguish from the authoritative drivers. */}
            {rating && (narrativeValue || judgment.overallSentiment !== null) && (
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70" data-testid={`label-model-advisory-${judgment.id}`}>
                Model narrative (advisory)
              </p>
            )}
            {narrativeValue && hasStructuredNarrative ? (
              narrativeSections.map((section, i) => {
                const SectionIcon = section.icon;
                // Task #3696: on the Recommended Actions section, each line
                // gets a "Save play" affordance that pre-fills the create
                // form — but only when the structured actionsJson block
                // below isn't already rendering the same actions.
                const actionable =
                  section.heading === "Recommended Actions" &&
                  !!onStartSavePlay &&
                  recommendedActions.length === 0;
                return (
                  <div key={i} data-testid={`section-${section.heading.toLowerCase().replace(/[\s\/]+/g, "-")}-${judgment.id}`}>
                    <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                      <SectionIcon className="w-3 h-3" />
                      {section.heading}
                    </h5>
                    {actionable ? (
                      <ul className="space-y-1">
                        {section.content.split("\n").map((l) => l.trim()).filter(Boolean).map((line, j) => (
                          <li key={j} className="group flex items-start justify-between gap-2 text-sm text-foreground/90 leading-relaxed">
                            <span>{line}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[10px] text-primary-ink hover:bg-primary/5 shrink-0 opacity-60 group-hover:opacity-100"
                              onClick={() => startPlayFromAction(stripListMarker(line), null)}
                              title="Start a save play from this action"
                              data-testid={`button-start-save-play-line-${judgment.id}-${j}`}
                            >
                              <LifeBuoy className="w-3 h-3 mr-1" />
                              Save play
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-line">{section.content}</div>
                    )}
                  </div>
                );
              })
            ) : narrativeValue ? (
              <div data-testid={`section-summary-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  Summary
                </h5>
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-line">{narrativeValue}</p>
              </div>
            ) : null}

            {judgment.overallSentiment !== null && (
              <div data-testid={`section-sentiment-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Heart className="w-3 h-3" />
                  Sentiment{rating ? <span className="font-normal normal-case tracking-normal text-muted-foreground/70 ml-1">(advisory)</span> : null}
                </h5>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        judgment.overallSentiment >= 0.6 ? "bg-green-400" :
                        judgment.overallSentiment >= 0.4 ? "bg-yellow-400" :
                        "bg-red-400"
                      }`}
                      style={{ width: `${Math.max(5, judgment.overallSentiment * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">{Math.round(judgment.overallSentiment * 100)}%</span>
                </div>
              </div>
            )}

            {recommendedActions.length > 0 && (
              <div data-testid={`section-recommended-actions-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  Recommended Actions
                </h5>
                <ul className="space-y-1.5">
                  {recommendedActions.map((a, i) => (
                    <li key={i} className="group flex items-start justify-between gap-2" data-testid={`recommended-action-${judgment.id}-${i}`}>
                      <div className="flex items-start gap-2 text-sm text-foreground/90 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/50 mt-1.5 shrink-0" />
                        <div className="min-w-0">
                          <span>{a.action}</span>
                          {a.why && <p className="text-xs text-muted-foreground/80 mt-0.5">{a.why}</p>}
                        </div>
                      </div>
                      {onStartSavePlay && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px] text-primary-ink hover:bg-primary/5 shrink-0 opacity-60 group-hover:opacity-100"
                          onClick={() => startPlayFromAction(a.action, a.why)}
                          title="Start a save play from this action"
                          data-testid={`button-start-save-play-${judgment.id}-${i}`}
                        >
                          <LifeBuoy className="w-3 h-3 mr-1" />
                          Save play
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {risksValue && risksValue.length > 0 && (
              <div data-testid={`section-risks-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Key Risks & Concerns
                </h5>
                <ul className="space-y-1">
                  {risksValue.map((risk, i) => (
                    <li key={i} className="text-sm text-foreground/90 flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 mt-1.5 shrink-0" />
                      {typeof risk === "string" ? risk : JSON.stringify(risk)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {winsValue && winsValue.length > 0 && (
              <div data-testid={`section-opportunities-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Lightbulb className="w-3 h-3" />
                  Key Opportunities & Wins
                </h5>
                <ul className="space-y-1">
                  {winsValue.map((opp, i) => (
                    <li key={i} className="text-sm text-foreground/90 flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 mt-1.5 shrink-0" />
                      {typeof opp === "string" ? opp : JSON.stringify(opp)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {basis ? (
              <div className="pt-2 border-t border-border space-y-1" data-testid={`section-data-basis-${judgment.id}`}>
                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Database className="w-3 h-3" />
                  Data Basis
                </h5>
                {basis.basedOn.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Based on: {basis.basedOn.join(" · ")}
                  </p>
                )}
                {basis.missing.length > 0 && (
                  <p className="text-xs text-muted-foreground/70" data-testid={`text-judgment-missing-${judgment.id}`}>
                    Not available: {basis.missing.join(", ")}
                  </p>
                )}
                {basis.tier === "operational" && (
                  <p className="text-xs text-sky-700">
                    No recent communications — judged from operational data; relationship/sentiment findings limited accordingly.
                  </p>
                )}
                {basis.carriedForward && (
                  <p className="text-xs text-muted-foreground/70">
                    Carried forward{basis.carriedForward.fromDate ? ` from ${basis.carriedForward.fromDate}` : ""} — inputs unchanged, no fresh AI evaluation.
                  </p>
                )}
              </div>
            ) : judgment.dataSourcesSummary && Object.keys(judgment.dataSourcesSummary).length > 0 ? (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground/70">
                  Sources: {Object.keys(judgment.dataSourcesSummary).join(", ")}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OpenAsksPanel({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: asks = [], isLoading } = useQuery<OpenAsk[]>({
    queryKey: ["/api/clients", clientId, "open-asks"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/open-asks`, { credentials: "include" });
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error("Failed to fetch open asks");
      }
      return res.json();
    },
  });

  const updateAskMutation = useMutation({
    mutationFn: async ({ askId, status }: { askId: string; status: string }) => {
      const res = await fetch(`/api/clients/${clientId}/open-asks/${askId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update ask status");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "open-asks"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "judgments"] }); // fire-and-forget: cache refresh only
      toast({ title: "Ask status updated" });
    },
    onError: () => {
      toast({ title: "Failed to update ask status", variant: "destructive" });
    },
  });

  const activeAsks = asks.filter(a => a.status === "open" || a.status === "likely_open");
  const otherAsks = asks.filter(a => a.status !== "open" && a.status !== "likely_open");

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground p-4 flex items-center gap-2" data-testid="open-asks-loading">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading open asks...
      </div>
    );
  }

  if (asks.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-center" data-testid="open-asks-empty-state">
          <Target className="w-8 h-8 mx-auto mb-2 text-primary/30" />
          <p className="text-sm text-muted-foreground">No tracked asks for this client yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Open asks will appear here once daily judgments begin detecting them.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2" data-testid="text-open-asks-header">
          <Target className="w-4 h-4" />
          Open Asks ({activeAsks.length} active)
        </h3>

        {activeAsks.length > 0 && (
          <div className="space-y-2 mb-4">
            {activeAsks.map(ask => {
              const statusCfg = ASK_STATUS_CONFIG[ask.status] || ASK_STATUS_CONFIG.open;
              const AskIcon = statusCfg.icon;
              return (
                <div key={ask.id} className="p-3 bg-surface-warm-1 rounded-lg" data-testid={`ask-item-${ask.id}`}>
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <Badge className={`${statusCfg.color} text-xs shrink-0`}>
                      <AskIcon className="w-3 h-3 mr-1" />
                      {statusCfg.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground capitalize shrink-0">{ask.askType.replace("_", " ")}</span>
                    {ask.mentionCount !== null && ask.mentionCount > 1 && (
                      <span className="text-xs text-orange-600 font-medium shrink-0">
                        mentioned {ask.mentionCount}x
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-foreground font-medium break-words" data-testid={`text-ask-summary-${ask.id}`}>{ask.summary}</p>
                  {ask.detail && (
                    <p className="text-xs text-muted-foreground mt-1 break-words">{ask.detail}</p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 mt-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {ask.lastReferencedAt && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          Last ref: {format(new Date(ask.lastReferencedAt), "MMM d")}
                        </span>
                      )}
                      {ask.firstMentionedAt && (
                        <span className="text-xs text-muted-foreground/70 whitespace-nowrap">
                          First: {format(new Date(ask.firstMentionedAt), "MMM d")}
                        </span>
                      )}
                      {ask.concernScore !== null && ask.concernScore > 2 && (
                        <span className="text-xs text-red-600 font-medium whitespace-nowrap">
                          concern: {ask.concernScore.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-green-700 hover:bg-green-50"
                        onClick={() => updateAskMutation.mutate({ askId: ask.id, status: "resolved" })}
                        disabled={updateAskMutation.isPending}
                        title="Mark as resolved"
                        data-testid={`button-resolve-ask-${ask.id}`}
                      >
                        <Check className="w-3 h-3 mr-1" />
                        Resolve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:bg-muted/50"
                        onClick={() => updateAskMutation.mutate({ askId: ask.id, status: "dismissed" })}
                        disabled={updateAskMutation.isPending}
                        title="Dismiss this ask"
                        data-testid={`button-dismiss-ask-${ask.id}`}
                      >
                        <X className="w-3 h-3 mr-1" />
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {otherAsks.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2">Resolved / Dismissed ({otherAsks.length})</p>
            <div className="space-y-1">
              {otherAsks.slice(0, 5).map(ask => {
                const statusCfg = ASK_STATUS_CONFIG[ask.status] || ASK_STATUS_CONFIG.resolved;
                return (
                  <div key={ask.id} className="flex items-center gap-2 p-2 rounded bg-muted/50 opacity-70" data-testid={`ask-item-closed-${ask.id}`}>
                    <Badge className={`${statusCfg.color} text-xs`}>{statusCfg.label}</Badge>
                    <span className="text-xs text-muted-foreground truncate">{ask.summary}</span>
                  </div>
                );
              })}
              {otherAsks.length > 5 && (
                <p className="text-xs text-muted-foreground/70 text-center mt-1">+{otherAsks.length - 5} more</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type FilterOption = "all" | "7days" | "30days" | "unresolved" | "negative";

function buildFilterUrl(clientId: string, filter: FilterOption): string {
  const base = `/api/clients/${clientId}/judgments`;
  const params = new URLSearchParams();

  if (filter === "7days") {
    params.set("dateFrom", subDays(new Date(), 7).toISOString());
  } else if (filter === "30days") {
    params.set("dateFrom", subDays(new Date(), 30).toISOString());
  } else if (filter === "unresolved") {
    params.set("hasUnresolvedAsks", "true");
  } else if (filter === "negative") {
    params.set("negativeRelationship", "true");
  }

  const queryString = params.toString();
  return queryString ? `${base}?${queryString}` : base;
}

export default function DailyJudgmentStream({
  clientId,
  currentUser,
}: {
  clientId: string;
  currentUser: User;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterOption>("all");
  // Task #3696: set by a judgment card's "Save play" affordance; consumed by
  // the SavePlaysPanel in the sidebar (opens its create dialog pre-filled).
  const [savePlayPrefill, setSavePlayPrefill] = useState<SavePlayPrefill | null>(null);

  const isAdmin = currentUser.role === "ceo" || currentUser.role === "team_lead";

  const url = buildFilterUrl(clientId, filter);

  const { data: judgments = [], isLoading } = useQuery<DailyJudgment[]>({
    queryKey: ["/api/clients", clientId, "judgments", filter],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error("Failed to fetch daily judgments");
      }
      return res.json();
    },
  });

  const { data: recentCommsData } = useQuery<{ count: number; days: number }>({
    queryKey: ["/api/clients", clientId, "recent-comms-count"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/recent-comms-count`, { credentials: "include" });
      if (!res.ok) return { count: -1, days: 30 };
      return res.json();
    },
  });

  const hasNoRecentComms = recentCommsData && recentCommsData.count === 0;

  const sortedJudgments = [...judgments].sort((a, b) =>
    new Date(b.judgmentDate).getTime() - new Date(a.judgmentDate).getTime()
  );

  const handleRegenerate = async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/judgments/regenerate`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to regenerate judgment");
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "judgments"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "open-asks"] }); // fire-and-forget: cache refresh only
      toast({ title: "Daily judgment regenerated successfully" });
    } catch (err: any) {
      toast({ title: "Regeneration failed", description: err.message || "An error occurred", variant: "destructive" });
    }
  };

  const [isRegenerating, setIsRegenerating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2" data-testid="text-daily-judgment-title">
            <Shield className="w-5 h-5" />
            Daily Account Judgment
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterOption)}>
            <SelectTrigger className="h-8 text-xs w-[180px]" data-testid="select-judgment-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Entries</SelectItem>
              <SelectItem value="7days">Last 7 Days</SelectItem>
              <SelectItem value="30days">Last 30 Days</SelectItem>
              <SelectItem value="unresolved">Unresolved Asks Only</SelectItem>
              <SelectItem value="negative">Negative Signals Only</SelectItem>
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="border-primary/20 text-primary-ink hover:bg-primary/5"
              onClick={async () => {
                setIsRegenerating(true);
                await handleRegenerate();
                setIsRegenerating(false);
              }}
              disabled={isRegenerating}
              data-testid="button-regenerate-judgment"
            >
              {isRegenerating ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-1" />
              )}
              Regenerate
            </Button>
          )}
        </div>
      </div>

      {hasNoRecentComms && (
        <Card className="bg-amber-50 border-amber-200" data-testid="judgment-no-comms-banner">
          <CardContent className="p-4 flex items-center gap-3">
            <MessageSquareOff className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800">No recent communications — judging from operational data</p>
              <p className="text-xs text-amber-600 mt-0.5">
                This client has no matched communications in the last 30 days. Daily judgments continue from whatever operational data exists (reports, command panel, agent memory, engagement checks), with prolonged silence weighed as a relationship risk. Agent-memory fact extraction stays paused until new communications arrive.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3" data-testid="judgment-stream-list">
          {isLoading ? (
            <div className="text-center py-12" data-testid="judgment-loading-state">
              <Loader2 className="w-8 h-8 mx-auto mb-3 text-primary/40 animate-spin" />
              <p className="text-sm text-muted-foreground">Loading daily judgments...</p>
            </div>
          ) : sortedJudgments.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="p-8 text-center" data-testid="judgment-empty-state">
                <Shield className="w-12 h-12 mx-auto mb-3 text-primary/20" />
                <h3 className="text-base font-semibold text-foreground mb-1">No Daily Judgments Yet</h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Daily AI-generated account judgments will appear here once the system begins analyzing this client's communications and account data.
                </p>
                {filter !== "all" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => setFilter("all")}
                    data-testid="button-clear-filter"
                  >
                    Clear filter
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            sortedJudgments.map(judgment => (
              <JudgmentCard
                key={judgment.id}
                judgment={judgment}
                onStartSavePlay={setSavePlayPrefill}
              />
            ))
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start space-y-4">
          <SavePlaysPanel
            clientId={clientId}
            currentUserId={currentUser.id}
            prefill={savePlayPrefill}
            onPrefillHandled={() => setSavePlayPrefill(null)}
          />
          <OpenAsksPanel clientId={clientId} />
        </div>
      </div>
    </div>
  );
}
