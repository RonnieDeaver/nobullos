// Shared parsing/normalization for daily-judgment content.
//
// Extracted verbatim from DailyJudgmentStream.tsx so the Churn Command
// Center leaderboard can render the same judgment fields (narrative
// sections, recommended actions, data-basis inventory, concern/win lists)
// without re-implementing the defensive parsing. Behavior is unchanged —
// both surfaces must keep reading judgments through these helpers so the
// shapes can't drift.

import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle, CheckCircle, Lightbulb, Shield, Target, Zap,
} from "lucide-react";

// Judgments persist a structured data-basis inventory in
// dataSourcesSummary ({ tier, basedOn, missing, carriedForward, ... }). Parse
// it defensively: older rows carry arbitrary shapes (or nothing), and those
// fall back to the legacy "Sources: <keys>" footer instead.
export type JudgmentBasis = {
  tier: string | null;
  basedOn: string[];
  missing: string[];
  carriedForward: { fromDate: string | null } | null;
  /**
   * The 30-day window count from the structured source signals
   * (sources.comms.count30d), when present. Task #4048: judgments now
   * analyze every communication in the window, so on new rows this equals
   * communicationsAnalyzed and the UI can collapse the two figures into one
   * chip; on older rows they legitimately differ (silent 50-row cap /
   * double-counted grain) and both stay visible.
   */
  comms30d: number | null;
  /**
   * Task #4292 — lifetime basis (sources.lifetime), present on rows judged
   * under revision 4292.1+. Older rows parse to null and the UI keeps the
   * legacy "full 30d window" wording for them.
   */
  lifetime: { firstCommAt: string | null; totalComms: number } | null;
  /** Business-day silence at judgment time (weekends excluded); null on older rows. */
  businessDaySilence: number | null;
  /** Operator intel entries (90d) that fed this judgment; null on older rows. */
  intelCount90d: number | null;
};

export function parseJudgmentBasis(raw: Record<string, unknown> | null): JudgmentBasis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const anyRaw = raw as any;
  const basedOn = Array.isArray(anyRaw.basedOn) ? anyRaw.basedOn.filter((v: any) => typeof v === "string") : [];
  const missing = Array.isArray(anyRaw.missing) ? anyRaw.missing.filter((v: any) => typeof v === "string") : [];
  const tier = typeof anyRaw.tier === "string" ? anyRaw.tier : null;
  if (!tier && basedOn.length === 0 && missing.length === 0) return null;
  const cf = anyRaw.carriedForward;
  const rawComms30d = anyRaw.sources?.comms?.count30d;
  const rawLifetime = anyRaw.sources?.lifetime;
  const lifetime =
    rawLifetime && typeof rawLifetime === "object" &&
    typeof rawLifetime.totalComms === "number" && Number.isFinite(rawLifetime.totalComms)
      ? {
          firstCommAt: typeof rawLifetime.firstCommAt === "string" ? rawLifetime.firstCommAt : null,
          totalComms: rawLifetime.totalComms as number,
        }
      : null;
  const rawBds = anyRaw.businessDaySilence;
  const rawIntelCount = anyRaw.sources?.intel?.count90d;
  return {
    tier,
    basedOn,
    missing,
    carriedForward: cf && typeof cf === "object"
      ? { fromDate: typeof cf.fromDate === "string" ? cf.fromDate : null }
      : null,
    comms30d: typeof rawComms30d === "number" && Number.isFinite(rawComms30d) ? rawComms30d : null,
    lifetime,
    businessDaySilence: typeof rawBds === "number" && Number.isFinite(rawBds) ? rawBds : null,
    intelCount90d: typeof rawIntelCount === "number" && Number.isFinite(rawIntelCount) ? rawIntelCount : null,
  };
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((v) => typeof v === "string");
  return items.length > 0 ? (items as string[]) : null;
}

export type NarrativeSection = {
  heading: string;
  content: string;
  icon: LucideIcon;
};

export function parseNarrativeSections(text: string): NarrativeSection[] {
  const sectionPatterns: { pattern: RegExp; heading: string; icon: LucideIcon }[] = [
    { pattern: /\*\*Summary\*\*|^Summary$/m, heading: "Summary", icon: Shield },
    { pattern: /\*\*What Changed\*\*|^What Changed$/m, heading: "What Changed", icon: Zap },
    { pattern: /\*\*Concerns\*\*|^Concerns$/m, heading: "Concerns", icon: AlertTriangle },
    { pattern: /\*\*Unresolved Asks|^Unresolved Asks/m, heading: "Unresolved Asks / Likely Dropped Balls", icon: Target },
    { pattern: /\*\*Notable Wins|^Notable Wins/m, heading: "Notable Wins / Useful Observations", icon: Lightbulb },
    { pattern: /\*\*Recommended Actions\*\*|^Recommended Actions$/m, heading: "Recommended Actions", icon: CheckCircle },
  ];

  const lines = text.split("\n");
  const sections: NarrativeSection[] = [];
  let currentSection: NarrativeSection | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    let matched = false;
    for (const sp of sectionPatterns) {
      if (sp.pattern.test(line.trim())) {
        if (currentSection) {
          currentSection.content = contentLines.join("\n").trim();
          if (currentSection.content) sections.push(currentSection);
        }
        currentSection = { heading: sp.heading, content: "", icon: sp.icon };
        contentLines = [];
        matched = true;
        break;
      }
    }
    if (!matched) {
      contentLines.push(line);
    }
  }

  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim();
    if (currentSection.content) sections.push(currentSection);
  }

  return sections;
}

/**
 * Normalize a judgment's actionsJson into [{action, why}] rows.
 * The writer stores Array<{action, why}> but older/looser payloads may be
 * plain strings — accept both, drop anything unusable.
 */
export function normalizeRecommendedActions(actionsJson: unknown): { action: string; why: string | null }[] {
  if (!Array.isArray(actionsJson)) return [];
  const out: { action: string; why: string | null }[] = [];
  for (const item of actionsJson) {
    if (typeof item === "string" && item.trim()) {
      out.push({ action: item.trim(), why: null });
    } else if (item && typeof item === "object" && typeof (item as any).action === "string" && (item as any).action.trim()) {
      const why = typeof (item as any).why === "string" && (item as any).why.trim() ? (item as any).why.trim() : null;
      out.push({ action: (item as any).action.trim(), why });
    }
  }
  return out;
}

/** Strip a leading list marker ("- ", "• ", "1. ", …) off a narrative action line. */
export function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim();
}
