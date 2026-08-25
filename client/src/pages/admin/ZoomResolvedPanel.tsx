import { CheckCircle, X } from "lucide-react";
import { format } from "date-fns";
import { reviewReasonLabel } from "@/lib/matchMethod";

export type ZoomResolvedInfo = {
  decisionId: string;
  resolution: "approved" | "reassigned" | "dismissed";
  reviewedAt: string | null;
  reviewerName: string | null;
  reviewReason: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  finalClientId: string | null;
  finalClientName: string | null;
  dismissReason: string | null;
};

export function ZoomResolvedPanel({
  msgId,
  resolved,
}: {
  msgId: string;
  resolved: ZoomResolvedInfo;
}) {
  const r = resolved;
  const palette =
    r.resolution === "approved"
      ? { border: "border-emerald-300", bg: "bg-emerald-50", icon: "text-emerald-700", title: "text-emerald-900", body: "text-emerald-800", muted: "text-emerald-600" }
      : r.resolution === "reassigned"
      ? { border: "border-blue-300", bg: "bg-blue-50", icon: "text-blue-700", title: "text-blue-900", body: "text-blue-800", muted: "text-blue-600" }
      : { border: "border-slate-300", bg: "bg-slate-50", icon: "text-slate-700", title: "text-slate-900", body: "text-slate-800", muted: "text-slate-500" };
  const Icon = r.resolution === "dismissed" ? X : CheckCircle;
  const headline =
    r.resolution === "approved"
      ? "Approved"
      : r.resolution === "reassigned"
      ? "Reassigned"
      : "Dismissed";
  const reviewedAtLabel = r.reviewedAt
    ? format(new Date(r.reviewedAt), "MMM d, yyyy 'at' h:mm a")
    : null;

  return (
    <div
      className={`border ${palette.border} ${palette.bg} rounded-lg p-3 space-y-2`}
      data-testid={`resolved-panel-${msgId}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Icon className={`w-4 h-4 ${palette.icon}`} />
        <p className={`text-sm font-medium ${palette.title}`} data-testid={`resolved-headline-${msgId}`}>
          Resolved by reviewer — {headline}
        </p>
        {r.reviewReason && (
          <span className={`text-xs ${palette.muted}`}>
            · {reviewReasonLabel(r.reviewReason)}
          </span>
        )}
      </div>
      <p className={`text-xs ${palette.body}`} data-testid={`resolved-meta-${msgId}`}>
        <span className="font-medium">{r.reviewerName || "Unknown reviewer"}</span>
        {reviewedAtLabel && <span className={`ml-1 ${palette.muted}`}>· {reviewedAtLabel}</span>}
      </p>
      {r.resolution === "dismissed" && r.dismissReason && (
        <p className={`text-xs ${palette.body}`} data-testid={`resolved-dismiss-reason-${msgId}`}>
          <span className="font-medium">Dismiss reason:</span> {r.dismissReason}
        </p>
      )}
      <div className={`text-xs ${palette.body} space-y-0.5`}>
        <p data-testid={`resolved-suggested-${msgId}`}>
          <span className="font-medium">Original suggestion:</span>{" "}
          {r.suggestedClientName || <span className={palette.muted}>None</span>}
        </p>
        <p data-testid={`resolved-final-${msgId}`}>
          <span className="font-medium">Final attribution:</span>{" "}
          {r.finalClientName ? (
            r.finalClientName
          ) : (
            <span className={palette.muted}>Unattributed</span>
          )}
          {r.resolution === "reassigned" && r.finalClientName && r.suggestedClientName && (
            <span className={`ml-1 ${palette.muted}`}>(corrected from {r.suggestedClientName})</span>
          )}
        </p>
      </div>
    </div>
  );
}
