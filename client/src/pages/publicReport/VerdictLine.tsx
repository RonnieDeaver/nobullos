/**
 * VerdictLine — Task #4273 (audit §8.1-1).
 *
 * The shared render primitive for a slide's opening verdict sentence: one
 * plain-language line ("Intake is leaking ~$18K/mo — answer speed is the
 * fix.") in the report's serif italic voice (`.report-verdict`,
 * Merriweather 400 italic per the report type scale — client/src/index.css).
 *
 * Renders nothing when the slide has no stored verdict — the deck must look
 * finished with or without one. Slide modules adopt it like:
 *
 *   <VerdictLine verdict={data.slideVerdicts?.intake} slideKey="intake" />
 *
 * where `data.slideVerdicts` is the server-stored map from the share/demo/
 * preview payloads (SharedReportData.slideVerdicts). Never generated
 * client-side.
 */
import * as React from "react";

import { cn } from "@/lib/utils";
import type { SlideVerdictKey } from "@shared/slideVerdicts";

export function VerdictLine({
  verdict,
  slideKey,
  className,
}: {
  verdict?: string | null;
  /** Used only for the per-slide test id. */
  slideKey?: SlideVerdictKey | string;
  className?: string;
}) {
  const text = typeof verdict === "string" ? verdict.trim() : "";
  if (text.length === 0) return null;
  // Deliberately React.createElement, not JSX: batched test workers compile
  // .tsx with the classic transform (root tsconfig `jsx: "preserve"` → esbuild
  // default), where JSX without a React import throws "React is not defined".
  // createElement renders identically in the Vite app lane and every test lane.
  return React.createElement(
    "p",
    {
      className: cn("report-verdict", className),
      "data-testid": slideKey ? `text-verdict-${slideKey}` : "text-verdict",
    },
    text,
  );
}
