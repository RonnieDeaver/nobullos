// Task #3702 — meeting-modal section for the AI-derived client face
// sentiment stored at rawPayloadJson.zoomFaceSentiment. Renders nothing when
// no result exists yet (the analyzer is opt-in and sweep-driven); otherwise
// shows the analyzed read (overall + timeline + notable moments), or the
// honest no-video / failed state. Everything here is explicitly labeled as
// AI-derived — it is a machine's read of facial expressions, not a fact.

// Default React import kept explicit: the jsdom component test harness runs
// this file under the classic JSX runtime (root tsconfig `jsx: preserve`),
// which compiles JSX to `React.createElement` and needs `React` in scope.
import React from "react";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import {
  formatSentimentTimestamp,
  getOverallSentimentClassName,
  getTimelineSentimentClassName,
  getZoomFaceSentimentBadge,
  type ZoomFaceSentimentResult,
} from "@shared/zoomSentiment";

export function ZoomFaceSentimentSection({
  result,
}: {
  result: Partial<ZoomFaceSentimentResult> | null | undefined;
}) {
  const badge = getZoomFaceSentimentBadge(result);
  if (badge.state === "none") return null;

  return (
    <div className="mt-2 pt-2 border-t border-indigo-200/70 space-y-1.5" data-testid="section-zoom-face-sentiment">
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-violet-500" />
        <span className="text-xs font-medium text-gray-600">Client sentiment</span>
        <Badge
          variant="outline"
          className="text-caption bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-950/25 dark:text-violet-300 dark:border-violet-800"
          data-testid="badge-zoom-sentiment-ai"
        >
          AI-derived
        </Badge>
      </div>

      {badge.state === "analyzed" && result ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`text-caption capitalize ${getOverallSentimentClassName(result.overall)}`}
              data-testid="badge-zoom-sentiment-overall"
            >
              {result.overall ?? "unknown"}
            </Badge>
            {result.clientIdentification && result.clientIdentification.confidence !== "high" && (
              <span className="text-caption text-amber-600 dark:text-amber-400" data-testid="text-zoom-sentiment-confidence">
                {result.clientIdentification.confidence} confidence identifying the client
              </span>
            )}
          </div>

          {result.summary && (
            <p className="text-[11px] text-gray-600 leading-snug" data-testid="text-zoom-sentiment-summary">
              {result.summary}
            </p>
          )}

          {result.timeline && result.timeline.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="row-zoom-sentiment-timeline">
              {result.timeline.map((pt, i) => (
                <span
                  key={i}
                  title={pt.note || undefined}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-caption ${getTimelineSentimentClassName(pt.sentiment)}`}
                  data-testid={`chip-zoom-sentiment-${i}`}
                >
                  <span className="tabular-nums text-gray-400">{formatSentimentTimestamp(pt.atSec)}</span>
                  <span className="capitalize">{pt.sentiment}</span>
                </span>
              ))}
            </div>
          )}

          {result.notableMoments && result.notableMoments.length > 0 && (
            <ul className="space-y-0.5" data-testid="list-zoom-sentiment-moments">
              {result.notableMoments.map((m, i) => (
                <li key={i} className="text-[11px] text-gray-600 leading-snug" data-testid={`moment-zoom-sentiment-${i}`}>
                  <span className="tabular-nums text-gray-400 mr-1">{formatSentimentTimestamp(m.atSec)}</span>
                  {m.note}
                </li>
              ))}
            </ul>
          )}

          <p className="text-caption text-gray-400 leading-snug" data-testid="text-zoom-sentiment-provenance">
            AI read of the client's visible facial expressions across {result.framesSampled ?? "sampled"} video frames
            {result.model ? ` (${result.model})` : ""} — may misread expressions; not a substitute for talking to the client.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <Badge
            variant="outline"
            className={`text-caption ${badge.className}`}
            data-testid="badge-zoom-sentiment-status"
          >
            {badge.label}
          </Badge>
          {badge.detail && (
            <p className="text-[11px] text-gray-500 leading-snug" data-testid="text-zoom-sentiment-detail">
              {badge.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
