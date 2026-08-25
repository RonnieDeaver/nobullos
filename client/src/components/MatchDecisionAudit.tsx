import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ClipboardCheck, CheckCircle, XCircle, AlertTriangle, User, Clock,
  ArrowRightLeft, ExternalLink, Hand,
} from "lucide-react";
import { format } from "date-fns";
import { matchMethodLabel, matchMethodColor, reviewReasonLabel } from "@/lib/matchMethod";
import { dismissReasonLabels, type DismissReason } from "@shared/schema";

type MatchDecision = {
  id: string;
  communicationId: string;
  communicationType: string;
  sourceType: string | null;
  clientId: string;
  confidenceScore: number;
  status: string;
  explanationSummary: string | null;
  supportingSignalsJson: Array<{ type: string; value: string; weight: number }> | null;
  semanticReasoningSummary: string | null;
  evidenceType: string;
  reviewReason: string | null;
  reviewResolution: string | null;
  dismissReason: string | null;
  dismissReasonNote: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewedByHuman: boolean;
  reviewedByName?: string | null;
  reviewedByEmail?: string | null;
  clientName?: string | null;
  correctedToClientName?: string | null;
  priorClientName?: string | null;
  correctedByHuman: boolean;
  correctedToClientId: string | null;
  priorClientId: string | null;
  createdAt: string;
};

function isCommandPanelClaim(d: MatchDecision): boolean {
  return (
    d.status === "claimed" &&
    (d.explanationSummary || "").toLowerCase().includes("command panel")
  );
}

const RESOLUTION_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  approved: { icon: CheckCircle, color: "bg-green-100 text-green-800", label: "Approved by reviewer" },
  reassigned: { icon: ArrowRightLeft, color: "bg-teal-100 text-teal-800", label: "Reassigned by reviewer" },
  dismissed: { icon: XCircle, color: "bg-slate-200 text-slate-700", label: "Dismissed" },
};

const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  claimed: { icon: CheckCircle, color: "bg-green-100 text-green-800", label: "Claimed" },
  not_claimed: { icon: XCircle, color: "bg-gray-100 text-gray-800", label: "Not Claimed" },
  ambiguous: { icon: AlertTriangle, color: "bg-yellow-100 text-yellow-800", label: "Ambiguous" },
  review_required: { icon: Clock, color: "bg-yellow-50 text-yellow-700", label: "Pending review" },
  pending_review: { icon: Clock, color: "bg-yellow-50 text-yellow-700", label: "Pending review" },
};

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 95 ? "bg-green-500" : pct >= 70 ? "bg-yellow-500" : pct >= 40 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono">{pct}%</span>
    </div>
  );
}

export default function MatchDecisionAudit({ clientId, communicationId }: { clientId?: string; communicationId?: string }) {
  const queryKey = clientId
    ? [`/api/clients/${clientId}/agent-decisions`]
    : [`/api/agent-decisions?communicationId=${communicationId}`];

  const { data: decisions = [], isLoading } = useQuery<MatchDecision[]>({
    queryKey,
    enabled: !!(clientId || communicationId),
  });

  if (isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground">Loading decisions...</CardContent></Card>;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4" /> Match Decisions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-decisions">No match decisions recorded yet.</p>
        ) : (
          <ScrollArea className="max-h-[500px]">
            <div className="space-y-2">
              {decisions.map(d => {
                const config = STATUS_CONFIG[d.status] || STATUS_CONFIG.not_claimed;
                const StatusIcon = config.icon;
                const resolution = d.reviewResolution
                  ? RESOLUTION_CONFIG[d.reviewResolution] || {
                      icon: CheckCircle,
                      color: "bg-gray-100 text-gray-700",
                      label: d.reviewResolution,
                    }
                  : null;
                const ResolutionIcon = resolution?.icon;
                // Dismiss reason isn't persisted on the decision row today;
                // explanationSummary for dismissed flows often carries it. Show
                // reviewReason explicitly so admins can always see why it was
                // queued (independent of the resolution outcome).
                const isBackfillDemoted = (d.reviewReason || "").startsWith("backfill_412g");
                const isZoom = d.sourceType === "zoom" || d.communicationType === "zoom";
                const cpClaim = isCommandPanelClaim(d);
                const claimerLabel = d.reviewedByName || d.reviewedByEmail || null;
                const assignedClientLabel = d.clientName || (d.clientId ? d.clientId : null);
                return (
                  <div
                    key={d.id}
                    className={`p-3 rounded border text-sm ${cpClaim ? "border-emerald-300 bg-emerald-50/40" : ""}`}
                    data-testid={`decision-${d.id}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {cpClaim ? (
                          <Badge
                            variant="secondary"
                            className="text-xs bg-emerald-100 text-emerald-900 border border-emerald-300"
                            data-testid={`badge-command-panel-claim-${d.id}`}
                          >
                            <Hand className="h-3 w-3 mr-1" /> Command Panel claim
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className={`text-xs ${config.color}`}>
                            <StatusIcon className="h-3 w-3 mr-1" /> {config.label}
                          </Badge>
                        )}
                        {resolution && ResolutionIcon && (
                          <Badge
                            variant="secondary"
                            className={`text-xs ${resolution.color}`}
                            data-testid={`badge-resolution-${d.id}`}
                          >
                            <ResolutionIcon className="h-3 w-3 mr-1" />
                            {resolution.label}
                          </Badge>
                        )}
                        {d.reviewResolution === "dismissed" && d.dismissReason && (
                          <Badge
                            variant="outline"
                            className="text-caption bg-slate-50 text-slate-700 border-slate-200"
                            data-testid={`badge-dismiss-reason-${d.id}`}
                            title={d.dismissReasonNote || undefined}
                          >
                            {dismissReasonLabels[d.dismissReason as DismissReason] || d.dismissReason}
                            {d.dismissReasonNote ? ` · ${d.dismissReasonNote}` : ""}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">{d.communicationType}</Badge>
                        <Badge variant="outline" className={`text-xs ${matchMethodColor(d.evidenceType)}`} data-testid={`badge-evidence-${d.id}`}>
                          {matchMethodLabel(d.evidenceType)}
                        </Badge>
                        {d.reviewReason && (
                          <Badge
                            variant="outline"
                            className="text-caption bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/25 dark:text-yellow-300 dark:border-yellow-800"
                            data-testid={`badge-review-reason-${d.id}`}
                          >
                            {reviewReasonLabel(d.reviewReason)}
                          </Badge>
                        )}
                      </div>
                      <ConfidenceBar score={d.confidenceScore} />
                    </div>

                    {cpClaim && (
                      <p
                        className="text-xs text-emerald-900 mb-1 flex flex-wrap items-center gap-1"
                        data-testid={`text-command-panel-attribution-${d.id}`}
                      >
                        <User className="h-3 w-3" />
                        <span>
                          Claimed by{" "}
                          <span className="font-medium" data-testid={`text-claimer-${d.id}`}>
                            {claimerLabel || "unknown user"}
                          </span>
                          {assignedClientLabel && (
                            <>
                              {" "}for{" "}
                              <span
                                className={`font-medium ${d.clientName ? "" : "font-mono"}`}
                                data-testid={`text-assigned-client-${d.id}`}
                              >
                                {assignedClientLabel}
                              </span>
                            </>
                          )}
                        </span>
                      </p>
                    )}

                    {d.explanationSummary && !cpClaim && (
                      <p className="text-xs text-muted-foreground mb-1" data-testid={`text-explanation-${d.id}`}>{d.explanationSummary}</p>
                    )}

                    {(d.priorClientId || d.correctedToClientId) && (
                      <p className="text-[11px] text-muted-foreground mb-1" data-testid={`text-attribution-change-${d.id}`}>
                        {d.priorClientId && (
                          <>Was attributed to <span className={d.priorClientName ? "font-medium" : "font-mono"}>{d.priorClientName || d.priorClientId}</span>. </>
                        )}
                        {d.correctedToClientId && (
                          <>Corrected to <span className={d.correctedToClientName ? "font-medium" : "font-mono"}>{d.correctedToClientName || d.correctedToClientId}</span>.</>
                        )}
                      </p>
                    )}

                    {d.supportingSignalsJson && d.supportingSignalsJson.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {(d.supportingSignalsJson as Array<{ type: string; value: string; weight: number }>).slice(0, 5).map((s, i) => (
                          <Badge key={i} variant="outline" className="text-caption font-mono">
                            {s.type}: {s.value.substring(0, 30)}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {d.semanticReasoningSummary && (
                      <p className="text-xs italic text-muted-foreground">AI: {d.semanticReasoningSummary}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-caption text-muted-foreground">
                      <span>{format(new Date(d.createdAt), "MMM d, yyyy h:mm a")}</span>
                      {d.reviewedAt && (
                        <span data-testid={`text-reviewed-at-${d.id}`}>
                          · resolved {format(new Date(d.reviewedAt), "MMM d, yyyy h:mm a")}
                        </span>
                      )}
                      {d.reviewedByHuman && !cpClaim && (
                        <Badge
                          variant="secondary"
                          className="text-caption"
                          data-testid={`badge-reviewed-${d.id}`}
                        >
                          <User className="h-2.5 w-2.5 mr-0.5" />
                          {claimerLabel ? (
                            <>
                              Reviewed by{" "}
                              <span className="font-medium ml-0.5" data-testid={`text-reviewer-${d.id}`}>
                                {claimerLabel}
                              </span>
                            </>
                          ) : (
                            "Reviewed"
                          )}
                        </Badge>
                      )}
                      {d.correctedByHuman && <Badge variant="destructive" className="text-caption">Corrected</Badge>}
                      {isZoom && (isBackfillDemoted || d.status === "review_required") && (
                        <Link
                          href={`/admin/zoom/review#decision-${d.id}`}
                          className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                          data-testid={`link-review-queue-${d.id}`}
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          Open in Zoom review queue
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
