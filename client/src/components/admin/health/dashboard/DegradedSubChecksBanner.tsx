// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Badge } from "@/components/ui/badge";
import { Database, AlertTriangle, XCircle } from "lucide-react";
import { useState, useEffect } from "react";
import type { HealthSnapshot } from "./types";

// Task #1068 — render the `degraded: [...]` array from /api/health as a
// visible banner so operators don't miss soft sub-check failures (e.g.
// `scheduler_stale`) just because /api/health now returns HTTP 200 for
// non-critical degradations (Task #1067). Critical entries (`db`,
// `tables`) are styled distinctly from soft warnings.
const CRITICAL_DEGRADATION_KEYS = new Set(["db", "tables"]);

const DEGRADATION_EXPLANATIONS: Record<string, string> = {
  db: "Database is unreachable from the API process",
  tables: "Required application tables are missing — check migrations",
  scheduler: "Background work scheduler is not running",
  scheduler_stale: "Scheduler missed several poll cycles — workers may be stalled",
  workers: "Workload manager metrics are temporarily unavailable",
  advisory_slot_bypass_high:
    "Local-dominance sync is bypassing its advisory slot more than 10% of the time",
};

function explainDegradation(key: string): string {
  return DEGRADATION_EXPLANATIONS[key] ?? `Sub-check reported degraded: ${key}`;
}

// Task #1069 — map each /api/health `degraded: [...]` key to the
// `data-testid` of the most relevant card already rendered on this page,
// so the chip in `DegradedSubChecksBanner` can deep-link to it. Keys not
// listed here render as a non-link with the explanation only.
const DEGRADATION_CARD_TARGETS: Record<string, string> = {
  scheduler: "card-sampler-runtime",
  scheduler_stale: "card-sampler-runtime",
  workers: "card-manual-reserve",
  // Task #1075 — deep-link the bypass-rate sub-check to the new card that
  // shows recent bypass rate, count, and the breakdown by call-site label.
  advisory_slot_bypass_high: "card-advisory-bypass",
};

function scrollToHealthCard(testId: string) {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
  const HIGHLIGHT_CLASSES = [
    "ring-2",
    "ring-offset-2",
    "ring-amber-400",
    "transition-shadow",
  ];
  el.classList.add(...HIGHLIGHT_CLASSES);
  window.setTimeout(() => {
    el.classList.remove(...HIGHLIGHT_CLASSES);
  }, 2000);
}

// Task #1070 — fallback pulse threshold used when /api/health hasn't
// returned `degradedPulseThresholdMs` yet (e.g. older server build).
// The live value is sourced from the snapshot so operators can tune it
// at runtime via the `HEALTH_DEGRADED_PULSE_MS` env without a rebuild.
const DEFAULT_DEGRADED_PULSE_THRESHOLD_MS = 10 * 60 * 1000;

function formatDegradedDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function DegradedSubCheckItem({
  entryKey,
  since,
  now,
  tone,
  pulseThresholdMs,
}: {
  entryKey: string;
  since: number | undefined;
  now: number;
  tone: "critical" | "soft";
  pulseThresholdMs: number;
}) {
  const targetTestId = DEGRADATION_CARD_TARGETS[entryKey];
  const durationMs = since ? Math.max(0, now - since) : 0;
  const durationLabel = since ? formatDegradedDuration(durationMs) : null;
  const pulse = tone === "critical" && durationMs >= pulseThresholdMs;
  const pulseRing =
    pulse && tone === "critical"
      ? "ring-2 ring-red-400 ring-offset-1 rounded animate-pulse"
      : "";
  const badgeClass =
    tone === "critical"
      ? `bg-red-200 text-red-900 hover:bg-red-200 font-mono shrink-0 ${pulseRing}`
      : `bg-amber-200 text-amber-900 hover:bg-amber-200 font-mono shrink-0 ${pulseRing}`;
  const linkBadgeClass =
    tone === "critical"
      ? `bg-red-200 text-red-900 hover:bg-red-300 focus-visible:bg-red-300 font-mono shrink-0 underline underline-offset-2 cursor-pointer ${pulseRing}`
      : `bg-amber-200 text-amber-900 hover:bg-amber-300 focus-visible:bg-amber-300 font-mono shrink-0 underline underline-offset-2 cursor-pointer ${pulseRing}`;
  const textClass =
    tone === "critical" ? "text-sm text-red-900" : "text-sm text-amber-900";
  const sinceTone = tone === "critical" ? "text-red-700" : "text-amber-700";

  return (
    <li
      className={`flex items-start gap-2 ${textClass}`}
      data-testid={`item-degraded-${entryKey}`}
    >
      {targetTestId ? (
        <button
          type="button"
          onClick={() => scrollToHealthCard(targetTestId)}
          title={`Jump to ${targetTestId.replace(/^card-/, "").replace(/-/g, " ")}`}
          data-testid={`link-degraded-${entryKey}`}
        >
          <Badge
            className={linkBadgeClass}
            data-testid={`badge-degraded-${entryKey}`}
          >
            {entryKey}
          </Badge>
        </button>
      ) : (
        <Badge
          className={badgeClass}
          data-testid={`badge-degraded-${entryKey}`}
        >
          {entryKey}
        </Badge>
      )}
      <div className="flex-1">
        <span>{explainDegradation(entryKey)}</span>
        {durationLabel && (
          <span
            className={`ml-2 text-xs ${sinceTone}`}
            data-testid={`text-degraded-since-${entryKey}`}
            title={since ? new Date(since).toLocaleString() : undefined}
          >
            · degraded for {durationLabel}
          </span>
        )}
      </div>
    </li>
  );
}

export function DegradedSubChecksBanner({ snapshot }: { snapshot: HealthSnapshot | undefined }) {
  // Re-render every 10s so the "degraded for Xm" duration ticks forward
  // between /api/health polls without waiting for the next snapshot.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!snapshot || snapshot.status !== "degraded") return null;
  const entries = snapshot.degraded ?? [];
  if (entries.length === 0) return null;

  const since = snapshot.degradedSince ?? {};
  const pulseThresholdMs =
    snapshot.degradedPulseThresholdMs && snapshot.degradedPulseThresholdMs > 0
      ? snapshot.degradedPulseThresholdMs
      : DEFAULT_DEGRADED_PULSE_THRESHOLD_MS;
  const critical = entries.filter((d) => CRITICAL_DEGRADATION_KEYS.has(d));
  const soft = entries.filter((d) => !CRITICAL_DEGRADATION_KEYS.has(d));
  const hasCritical = critical.length > 0;

  return (
    <Card
      className={hasCritical ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"}
      data-testid="card-degraded-subchecks"
    >
      <CardHeader className="pb-2">
        <CardTitle
          className={`text-base flex items-center gap-2 ${hasCritical ? "text-red-800" : "text-amber-800"}`}
        >
          {hasCritical ? <XCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          {hasCritical
            ? "Critical sub-checks are failing"
            : "Some sub-checks are degraded"}
        </CardTitle>
        <CardDescription className={hasCritical ? "text-red-700" : "text-amber-700"}>
          /api/health is returning <code>status: "degraded"</code>. Overall HTTP status stays
          OK for soft warnings so external probes don't page, but the sub-checks below need
          attention.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {critical.length > 0 && (
          <div data-testid="group-degraded-critical">
            <div className="text-xs font-semibold uppercase tracking-wide text-red-700 mb-1">
              Critical
            </div>
            <ul className="space-y-1">
              {critical.map((key) => (
                <DegradedSubCheckItem
                  key={key}
                  entryKey={key}
                  since={since[key]}
                  now={now}
                  tone="critical"
                  pulseThresholdMs={pulseThresholdMs}
                />
              ))}
            </ul>
          </div>
        )}
        {soft.length > 0 && (
          <div data-testid="group-degraded-soft">
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-1">
              Warnings
            </div>
            <ul className="space-y-1">
              {soft.map((key) => (
                <DegradedSubCheckItem
                  key={key}
                  entryKey={key}
                  since={since[key]}
                  now={now}
                  tone="soft"
                  pulseThresholdMs={pulseThresholdMs}
                />
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}