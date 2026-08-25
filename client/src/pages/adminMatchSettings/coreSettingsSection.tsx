// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Activity, AlertTriangle, ChevronDown, Minus, RefreshCw, RotateCcw, Save, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GuardrailAcknowledgementRequiredError, SCOPE_LABEL, SOURCE_OF_TRUTH_BADGE, formatNumber, rowKey } from "./guardrails";
import { type CustomWindowUnit, GUARDRAIL_IMPACT_WINDOWS, GUARDRAIL_KEY_TO_REASONS, GUARDRAIL_REASON_LABELS, type ImpactResponse, type KeyImpact, type Scope, WINDOW_CHOICES } from "./model";
import { GuardrailDismissReasonAnchoredDelta, GuardrailImpactSparkline, formatAnchorTooltip, formatDurationShort, renderTrendDelta } from "./trendVisuals";
import type { CoreSettingsBag } from "./useCoreSettings";

type GuardrailWarningsBannerProps = {
  core: CoreSettingsBag;
};

export function GuardrailWarningsBanner(props: GuardrailWarningsBannerProps) {
  const { currentSavedWarnings, data, focusGuardrailRow } = props.core;
  return (
    <>
            {currentSavedWarnings.length > 0 && (
              <div
                className="bg-amber-50 border border-amber-300 rounded-lg p-4"
                data-testid="banner-current-guardrail-warnings"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <h3
                      className="text-sm font-semibold text-amber-900"
                      data-testid="text-current-guardrail-warnings-title"
                    >
                      Current Zoom guardrails are in a risky combination
                    </h3>
                    <p className="text-xs text-amber-800 mt-0.5">
                      The values currently in effect for Zoom matching trigger the rules below.
                      Update the affected settings to restore the intended behavior.
                    </p>
                    <ul className="mt-2 space-y-2">
                      {currentSavedWarnings.map(w => (
                        <li
                          key={w.code}
                          className="text-sm text-amber-900"
                          data-testid={`text-current-guardrail-warning-${w.code}`}
                        >
                          <div>{w.message}</div>
                          {w.involvedKeys.length > 0 && (
                            <div
                              className="mt-1 flex flex-wrap items-center gap-1.5"
                              data-testid={`group-jump-guardrail-${w.code}`}
                            >
                              <span className="text-caption uppercase tracking-wide text-amber-800/80">
                                Jump to:
                              </span>
                              {w.involvedKeys.map(k => {
                                const label = data?.descriptors.find(d => d.key === k)?.label ?? k;
                                return (
                                  <button
                                    key={k}
                                    type="button"
                                    onClick={() => focusGuardrailRow(k)}
                                    className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border border-amber-400 bg-amber-100 text-amber-900 hover:bg-amber-200 hover:underline underline-offset-2 transition-colors"
                                    data-testid={`button-jump-guardrail-${w.code}-${k}`}
                                    title={`Scroll to ${label} (${k})`}
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
    </>
  );
}


type CoreSettingsTablesProps = {
  core: CoreSettingsBag;
};

export function CoreSettingsTables(props: CoreSettingsTablesProps) {
  const { computeRowWarnings, currentRiskyKeys, customWindowMs, customWindowUnit, customWindowValue, data, draftValues, error, flashRowKey, guardrailImpact, guardrailImpactQuery, guardrailImpactWindow, impact, impactKeyByScope, impactWindowId, rowsByScope, savingKey, setCustomWindowUnit, setCustomWindowValue, setDraftValues, setGuardrailImpactWindow, setImpactKeyByScope, setImpactWindowId, setSavingKey, updateMutation } = props.core;
  // Task #4355 — progressive disclosure (audit §6.1-E): the two threshold
  // walls collapse by default so the dry-run impact preview stays the page's
  // first-read surface. Table headers (incl. the zoom guardrail-impact
  // widget) stay visible; only the row walls hide.
  const [openTables, setOpenTables] = useState<Record<Scope, boolean>>({
    default: false,
    zoom: false,
  });
  const openTablesRef = useRef(openTables);
  openTablesRef.current = openTables;
  // The guardrail-banner "focus row" flow scrolls to a specific row; a
  // collapsed table would swallow it. Force-open the owning table, then
  // re-run the scroll once the rows exist (the click-time query missed).
  useEffect(() => {
    if (!flashRowKey) return;
    const scope: Scope = flashRowKey.startsWith("zoom::") ? "zoom" : "default";
    if (openTablesRef.current[scope]) return;
    setOpenTables((prev) => ({ ...prev, [scope]: true }));
    const raf = requestAnimationFrame(() => {
      const selector = `[data-row-key="${
        typeof CSS !== "undefined" && CSS.escape ? CSS.escape(flashRowKey) : flashRowKey
      }"]`;
      const el = document.querySelector(selector) as HTMLElement | null;
      el?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [flashRowKey]);
  const renderImpactPanel = (resp: ImpactResponse) => {
    const formatPct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
    const formatDuration = (ms: number) => {
      const h = ms / 3_600_000;
      if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
      if (h < 48) return `${h.toFixed(1)}h`;
      return `${(h / 24).toFixed(1)}d`;
    };
    const delta = (after: number, before: number, lowerIsBetter = true) => {
      const diff = after - before;
      if (diff === 0) return { icon: <Minus className="w-3 h-3" />, cls: "text-muted-foreground", label: "0" };
      const better = lowerIsBetter ? diff < 0 : diff > 0;
      const cls = better ? "text-emerald-600" : "text-red-600";
      const Icon = diff > 0 ? TrendingUp : TrendingDown;
      const sign = diff > 0 ? "+" : "";
      return { icon: <Icon className="w-3 h-3" />, cls, label: `${sign}${diff}` };
    };
    const deltaPct = (after: number | null, before: number | null, lowerIsBetter = true) => {
      if (after === null || before === null) return { icon: <Minus className="w-3 h-3" />, cls: "text-muted-foreground", label: "—" };
      const diff = after - before;
      if (Math.abs(diff) < 0.0005) return { icon: <Minus className="w-3 h-3" />, cls: "text-muted-foreground", label: "0.0pp" };
      const better = lowerIsBetter ? diff < 0 : diff > 0;
      const cls = better ? "text-emerald-600" : "text-red-600";
      const Icon = diff > 0 ? TrendingUp : TrendingDown;
      const sign = diff > 0 ? "+" : "";
      return { icon: <Icon className="w-3 h-3" />, cls, label: `${sign}${(diff * 100).toFixed(1)}pp` };
    };

    const descriptorLabel = (key: string): string => {
      const d = data?.descriptors.find((x) => x.key === key);
      return d?.label ?? key;
    };

    const renderScopeCard = (scope: Scope) => {
      const scopeData = resp.scopes[scope];
      const perKey = scopeData?.perKey ?? [];
      const rawSelectedKey = impactKeyByScope[scope];
      const selectedKey =
        rawSelectedKey !== "__latest__" && !perKey.some((k) => k.settingKey === rawSelectedKey)
          ? "__latest__"
          : rawSelectedKey;
      const selected: KeyImpact | null =
        selectedKey === "__latest__"
          ? scopeData?.hasChange
            ? {
                settingKey: scopeData.lastChange.settingKey,
                changedAt: scopeData.changedAt,
                windowMs: scopeData.windowMs,
                lastChange: scopeData.lastChange,
                after: scopeData.after,
                before: scopeData.before,
              }
            : null
          : perKey.find((k) => k.settingKey === selectedKey) ?? null;
      return (
        <div key={scope} className="bg-card rounded-lg border shadow-sm overflow-hidden" data-testid={`card-impact-${scope}`}>
          <div className="px-4 py-3 border-b bg-muted/50">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold text-foreground" data-testid={`text-impact-title-${scope}`}>
                  Impact {scopeData?.hasChange && scopeData.windowMode === "custom" ? `over ${formatDuration(scopeData.windowMs)}` : "since last change"} · {SCOPE_LABEL[scope]}
                </h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {scope === "zoom"
                    ? "Counts only Zoom decisions."
                    : "Counts decisions from all sources (including Zoom)."}
                </p>
              </div>
              {perKey.length > 0 && (
                <select
                  value={selectedKey}
                  onChange={(e) => setImpactKeyByScope((prev) => ({ ...prev, [scope]: e.target.value }))}
                  className="text-xs border rounded px-2 py-1 bg-card"
                  data-testid={`select-impact-key-${scope}`}
                >
                  <option value="__latest__">Latest change (any key)</option>
                  {perKey.map((k) => (
                    <option key={k.settingKey} value={k.settingKey}>
                      {descriptorLabel(k.settingKey)} ({k.settingKey})
                    </option>
                  ))}
                </select>
              )}
            </div>
            {!selected ? (
              <p className="text-xs text-muted-foreground mt-2" data-testid={`text-impact-empty-${scope}`}>
                No persisted changes recorded for this scope yet.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-2" data-testid={`text-impact-summary-${scope}`}>
                {selectedKey === "__latest__" ? "Last change " : "Since change to "}
                <span className="font-mono">{selected.lastChange.settingKey}</span>{" "}
                {selected.lastChange.oldValue === null ? "—" : selected.lastChange.oldValue.toFixed(3)} →{" "}
                {selected.lastChange.newValue === null ? <span className="italic">cleared</span> : selected.lastChange.newValue.toFixed(3)}
                {" · "}
                {new Date(selected.changedAt).toLocaleString()}
                {" ("}
                {formatDuration(Math.max(0, Date.now() - new Date(selected.changedAt).getTime()))} ago
                {")"}
                {resp.requestedWindowMs !== null && selected.windowMs < resp.requestedWindowMs && (
                  <span className="ml-1 italic" data-testid={`text-window-clamped-${scope}`}>
                    · requested {formatDuration(resp.requestedWindowMs)}, capped to {formatDuration(selected.windowMs)} (only {formatDuration(Math.max(0, Date.now() - new Date(selected.changedAt).getTime()))} elapsed since change)
                  </span>
                )}
              </p>
            )}
          </div>
          {selected && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Metric</th>
                    <th className="px-4 py-2 font-medium">Before ({formatDuration(selected.windowMs)})</th>
                    <th className="px-4 py-2 font-medium">After ({formatDuration(selected.windowMs)})</th>
                    <th className="px-4 py-2 font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[
                    { key: "claimed", label: "Auto-claims", after: selected.after.claimed, before: selected.before.claimed, lowerBetter: false },
                    { key: "review_required", label: "Review-required", after: selected.after.reviewRequired, before: selected.before.reviewRequired, lowerBetter: true },
                    { key: "ambiguous", label: "Ambiguous", after: selected.after.ambiguous, before: selected.before.ambiguous, lowerBetter: true },
                    { key: "corrected", label: "Human corrections", after: selected.after.corrected, before: selected.before.corrected, lowerBetter: true },
                    { key: "total", label: "Total decisions", after: selected.after.total, before: selected.before.total, lowerBetter: false, neutral: true },
                  ].map((m) => {
                    const d = m.neutral
                      ? { icon: <Minus className="w-3 h-3" />, cls: "text-muted-foreground", label: `${m.after - m.before >= 0 ? "+" : ""}${m.after - m.before}` }
                      : delta(m.after, m.before, m.lowerBetter);
                    return (
                      <tr key={m.key} data-testid={`row-impact-${scope}-${m.key}`}>
                        <td className="px-4 py-2 text-foreground">{m.label}</td>
                        <td className="px-4 py-2 font-mono text-muted-foreground" data-testid={`text-before-${scope}-${m.key}`}>{m.before}</td>
                        <td className="px-4 py-2 font-mono text-foreground" data-testid={`text-after-${scope}-${m.key}`}>{m.after}</td>
                        <td className={`px-4 py-2 font-mono ${d.cls}`} data-testid={`text-delta-${scope}-${m.key}`}>
                          <span className="inline-flex items-center gap-1">{d.icon}{d.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {[
                    { key: "ambiguity_rate", label: "Ambiguity rate ((ambiguous + review-required) ÷ total)", after: selected.after.ambiguityRate, before: selected.before.ambiguityRate },
                    { key: "false_positive_rate", label: "False-positive rate (corrected ÷ claimed)", after: selected.after.falsePositiveRate, before: selected.before.falsePositiveRate },
                  ].map((m) => {
                    const d = deltaPct(m.after, m.before, true);
                    return (
                      <tr key={m.key} data-testid={`row-impact-${scope}-${m.key}`}>
                        <td className="px-4 py-2 text-foreground">{m.label}</td>
                        <td className="px-4 py-2 font-mono text-muted-foreground" data-testid={`text-before-${scope}-${m.key}`}>{formatPct(m.before)}</td>
                        <td className="px-4 py-2 font-mono text-foreground" data-testid={`text-after-${scope}-${m.key}`}>{formatPct(m.after)}</td>
                        <td className={`px-4 py-2 font-mono ${d.cls}`} data-testid={`text-delta-${scope}-${m.key}`}>
                          <span className="inline-flex items-center gap-1">{d.icon}{d.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="space-y-3" data-testid="section-impact">
        <div className="flex flex-wrap items-center gap-2 bg-card rounded-lg border shadow-sm px-4 py-3">
          <span className="text-xs font-medium text-foreground mr-1">Comparison window:</span>
          {WINDOW_CHOICES.map(choice => {
            const active = impactWindowId === choice.id;
            return (
              <Button
                key={choice.id}
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => setImpactWindowId(choice.id)}
                data-testid={`button-impact-window-${choice.id}`}
                aria-pressed={active}
              >
                {choice.label}
              </Button>
            );
          })}
          {impactWindowId === "custom" && (
            <div className="flex items-center gap-1.5" data-testid="group-impact-window-custom">
              <Input
                type="number"
                min={1}
                step={1}
                value={customWindowValue}
                onChange={(e) => setCustomWindowValue(e.target.value)}
                className="h-8 w-20 text-xs"
                data-testid="input-impact-window-custom-value"
                aria-label="Custom comparison window value"
              />
              <select
                value={customWindowUnit}
                onChange={(e) => setCustomWindowUnit(e.target.value as CustomWindowUnit)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                data-testid="select-impact-window-custom-unit"
                aria-label="Custom comparison window unit"
              >
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
              {customWindowMs === null && (
                <span
                  className="text-[11px] text-red-600"
                  data-testid="text-impact-window-custom-error"
                >
                  Enter a value between 1h and 90d — results paused.
                </span>
              )}
            </div>
          )}
          <span className="text-[11px] text-muted-foreground ml-2">
            Sets the size of the before/after sample windows anchored at the last change.
            Capped at the time elapsed since the change.
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {renderScopeCard("default")}
          {renderScopeCard("zoom")}
        </div>
      </div>
    );
  };

  const renderTable = (scope: Scope) => {
    const rows = rowsByScope.get(scope) || [];
    const open = openTables[scope];
    return (
      <div className="bg-card rounded-lg border shadow-sm overflow-hidden" data-testid={`table-scope-${scope}`}>
        <div className={`px-4 py-3 bg-muted/50 flex items-center justify-between gap-3 ${open ? "border-b" : ""}`}>
          <div>
            <h3 className="text-sm font-semibold text-foreground" data-testid={`text-scope-title-${scope}`}>
              {SCOPE_LABEL[scope]}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {scope === "zoom"
                ? "Zoom-specific overrides. Falls back to Default if cleared."
                : "Applies to every source unless a more specific override exists."}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
          {scope === "zoom" && (
            <div className="flex flex-col items-end gap-1.5" data-testid="group-guardrail-impact-window">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground mr-1">Review-queue impact:</span>
                {GUARDRAIL_IMPACT_WINDOWS.map((opt) => {
                  const active = guardrailImpactWindow === opt.value;
                  return (
                    <Button
                      key={opt.value}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className="h-7 px-2 text-caption"
                      onClick={() => setGuardrailImpactWindow(opt.value)}
                      data-testid={`button-guardrail-impact-window-${opt.value}`}
                      aria-pressed={active}
                    >
                      {opt.label}
                    </Button>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-caption"
                  onClick={() => guardrailImpactQuery.refetch()}
                  disabled={guardrailImpactQuery.isFetching}
                  data-testid="button-guardrail-impact-refresh"
                  title="Refresh review-queue impact and sparklines"
                  aria-label="Refresh review-queue impact"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${guardrailImpactQuery.isFetching ? "animate-spin" : ""}`}
                  />
                </Button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end" data-testid="guardrail-impact-summary">
                {(["weak_signal_only", "contact_name_only_weak", "solo_internal_participants"] as const).map((reason) => {
                  const count = guardrailImpact?.reasonSummary.byReason[reason] ?? 0;
                  const previous = guardrailImpact?.previousSummary?.byReason[reason] ?? 0;
                  return (
                    <span
                      key={reason}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-card text-foreground"
                      data-testid={`guardrail-impact-summary-${reason}`}
                    >
                      {GUARDRAIL_REASON_LABELS[reason]}:
                      <span className="font-mono font-semibold text-foreground">
                        {guardrailImpactQuery.isFetching ? "…" : count}
                      </span>
                      {!guardrailImpactQuery.isFetching && guardrailImpact?.previousSummary && renderTrendDelta(count, previous)}
                    </span>
                  );
                })}
                <span
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/50 text-foreground"
                  data-testid="guardrail-impact-summary-total"
                >
                  Total:
                  <span className="font-mono font-semibold text-foreground">
                    {guardrailImpactQuery.isFetching ? "…" : guardrailImpact?.reasonSummary.total ?? 0}
                  </span>
                </span>
              </div>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-caption"
            onClick={() => setOpenTables((prev) => ({ ...prev, [scope]: !prev[scope] }))}
            aria-expanded={open}
            data-testid={`button-toggle-thresholds-${scope}`}
          >
            <ChevronDown
              className={`w-3.5 h-3.5 mr-1 transition-transform ${open ? "rotate-180" : ""}`}
            />
            {open ? "Hide settings" : `Show ${rows.length} settings`}
          </Button>
          </div>
        </div>
        {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Setting</th>
                <th className="px-4 py-2 font-medium">Effective</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Persisted</th>
                <th className="px-4 py-2 font-medium">Env</th>
                <th className="px-4 py-2 font-medium">Default</th>
                <th className="px-4 py-2 font-medium">Last edited</th>
                <th className="px-4 py-2 font-medium">Update</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const draftKey = rowKey(scope, r.key);
                const draft = draftValues[draftKey] ?? "";
                const isSaving = savingKey === draftKey;
                const fallbackHint =
                  r.sourceOfTruth === "persisted" && r.persistedScope && r.persistedScope !== scope
                    ? ` (from ${SCOPE_LABEL[r.persistedScope]})`
                    : "";
                const previewWarnings = computeRowWarnings(scope, r.key, draft);
                const isFlashing = flashRowKey === draftKey;
                const rowClassName = [
                  "transition-colors duration-500",
                  isFlashing ? "bg-amber-200/80 ring-2 ring-amber-500" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr
                    key={draftKey}
                    data-testid={`row-setting-${scope}-${r.key}`}
                    data-row-key={draftKey}
                    data-flashing={isFlashing ? "true" : undefined}
                    className={rowClassName || undefined}
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-foreground" data-testid={`text-label-${scope}-${r.key}`}>
                          {r.label}
                        </div>
                        {scope === "zoom" && currentRiskyKeys.has(r.key) && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800"
                            data-testid={`badge-currently-risky-${scope}-${r.key}`}
                            title="This setting is part of a currently risky guardrail combination"
                          >
                            <AlertTriangle className="w-3 h-3" /> Currently risky
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{r.description}</div>
                      {scope === "zoom" && (GUARDRAIL_KEY_TO_REASONS[r.key] || []).length > 0 && (() => {
                        const perKey = guardrailImpact?.perKey?.[r.key];
                        const loading = guardrailImpactQuery.isFetching;
                        const anchorTooltip = formatAnchorTooltip(perKey);
                        return (
                          <div
                            className="mt-1.5 flex flex-wrap items-center gap-1"
                            data-testid={`guardrail-impact-${scope}-${r.key}`}
                            data-anchor={perKey?.anchor || ""}
                          >
                            {(GUARDRAIL_KEY_TO_REASONS[r.key] || []).map((reason) => {
                              const count = guardrailImpact?.reasonSummary.byReason[reason] ?? 0;
                              const afterCount = perKey?.after?.byReason[reason] ?? 0;
                              const beforeCount = perKey?.before?.byReason[reason] ?? 0;
                              const hasAnchoredDelta =
                                !!perKey?.anchor && !!perKey.after && !!perKey.before;
                              return (
                                <span
                                  key={reason}
                                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-800"
                                  title={
                                    `Items currently routed to review for reason: ${GUARDRAIL_REASON_LABELS[reason] || reason} (chosen window). ` +
                                    `Δ compares an equal-length window before vs. after the last change. ${anchorTooltip}`
                                  }
                                  data-testid={`guardrail-impact-${scope}-${r.key}-${reason}`}
                                >
                                  <Activity className="w-2.5 h-2.5" />
                                  {GUARDRAIL_REASON_LABELS[reason] || reason}:
                                  <span className="font-mono font-semibold">
                                    {loading ? "…" : count}
                                  </span>
                                  {!loading && hasAnchoredDelta && (
                                    <span
                                      className="inline-flex items-center gap-0.5"
                                      data-testid={`guardrail-impact-${scope}-${r.key}-${reason}-trend`}
                                    >
                                      <span className="text-muted-foreground">Δ</span>
                                      {renderTrendDelta(afterCount, beforeCount)}
                                    </span>
                                  )}
                                  {!loading && hasAnchoredDelta && (
                                    <GuardrailImpactSparkline
                                      buckets={perKey?.buckets?.[reason]}
                                      sampleMs={perKey?.sampleMs ?? 0}
                                      reasonLabel={GUARDRAIL_REASON_LABELS[reason] || reason}
                                      reasonKey={reason}
                                      testId={`guardrail-impact-${scope}-${r.key}-${reason}-sparkline`}
                                    />
                                  )}
                                </span>
                              );
                            })}
                            <span
                              className="text-[10px] text-muted-foreground"
                              title={anchorTooltip}
                              data-testid={`guardrail-impact-${scope}-${r.key}-anchor-hint`}
                            >
                              {perKey?.anchor
                                ? `Δ vs ${formatDurationShort(perKey.sampleMs)} before last change`
                                : "no change recorded"}
                            </span>
                            {!loading && perKey?.anchor && (
                              <GuardrailDismissReasonAnchoredDelta
                                perKey={perKey}
                                testId={`guardrail-impact-${scope}-${r.key}-dismiss`}
                              />
                            )}
                          </div>
                        );
                      })()}
                      <div className="text-[11px] text-muted-foreground mt-1 font-mono">
                        {r.key} · {r.bounds.min.toFixed(2)}..{r.bounds.max.toFixed(2)}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top font-mono" data-testid={`text-effective-${scope}-${r.key}`}>
                      {formatNumber(r.effectiveValue)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span
                        className={`text-xs px-2 py-0.5 rounded border ${SOURCE_OF_TRUTH_BADGE[r.sourceOfTruth]}`}
                        data-testid={`badge-source-${scope}-${r.key}`}
                      >
                        {r.sourceOfTruth}
                      </span>
                      {fallbackHint && (
                        <div className="text-[11px] text-muted-foreground mt-1">{fallbackHint}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-foreground" data-testid={`text-persisted-${scope}-${r.key}`}>
                      {formatNumber(r.persistedValue)}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-foreground" data-testid={`text-env-${scope}-${r.key}`}>
                      {formatNumber(r.envValue)}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-muted-foreground" data-testid={`text-default-${scope}-${r.key}`}>
                      {formatNumber(r.codeDefault)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <LastEditedBadge
                        info={r.lastEdited}
                        testId={`last-edited-${scope}-${r.key}`}
                        emptyText="—"
                        className="!mt-0"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          step="0.01"
                          min={r.bounds.min}
                          max={r.bounds.max}
                          placeholder={formatNumber(r.effectiveValue)}
                          value={draft}
                          onChange={(e) => setDraftValues((d) => ({ ...d, [draftKey]: e.target.value }))}
                          className="w-24"
                          data-testid={`input-value-${scope}-${r.key}`}
                          disabled={isSaving}
                        />
                        <Button
                          size="sm"
                          variant="default"
                          disabled={isSaving || draft === ""}
                          onClick={() => {
                            const numeric = Number(draft);
                            if (!Number.isFinite(numeric)) return;
                            setSavingKey(draftKey);
                            updateMutation.mutate(
                              { scope, key: r.key, value: numeric },
                              {
                                onSuccess: () => {
                                  setDraftValues((d) => {
                                    const { [draftKey]: _, ...rest } = d;
                                    return rest;
                                  });
                                },
                              },
                            );
                          }}
                          data-testid={`button-save-${scope}-${r.key}`}
                        >
                          <Save className="w-3.5 h-3.5 mr-1" /> Save
                        </Button>
                        {r.persistedValue !== null && r.persistedScope === scope && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isSaving}
                            onClick={() => {
                              setSavingKey(draftKey);
                              updateMutation.mutate({ scope, key: r.key, value: null });
                            }}
                            data-testid={`button-clear-${scope}-${r.key}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Clear
                          </Button>
                        )}
                      </div>
                      {previewWarnings.length > 0 && (
                        <div
                          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 space-y-1"
                          data-testid={`warning-preview-${scope}-${r.key}`}
                        >
                          <div className="flex items-center gap-1 font-medium">
                            <AlertTriangle className="w-3 h-3" /> Risky combination
                          </div>
                          {previewWarnings.map(w => (
                            <div key={w.code} data-testid={`warning-preview-${scope}-${r.key}-${w.code}`}>
                              {w.effectiveScope && w.effectiveScope !== scope && (
                                <span
                                  className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-medium uppercase tracking-wide"
                                  data-testid={`warning-preview-${scope}-${r.key}-${w.code}-scope`}
                                >
                                  affects {SCOPE_LABEL[w.effectiveScope]}
                                </span>
                              )}
                              {w.message}
                            </div>
                          ))}
                        </div>
                      )}
                      {updateMutation.isError && savingKey === draftKey && !(updateMutation.error instanceof GuardrailAcknowledgementRequiredError) && (
                        <div className="text-[11px] text-red-600 mt-1" data-testid={`text-error-${scope}-${r.key}`}>
                          {(updateMutation.error as Error)?.message}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>
    );
  };
  return (
    <>
      {/* Task #4355 — SectionNav anchors for the match-settings rail. */}
      {impact && (
        <section id="impact-preview" className="scroll-mt-16">
          {renderImpactPanel(impact)}
        </section>
      )}

      <section id="thresholds" className="scroll-mt-16 space-y-6">
        {renderTable("default")}
        {renderTable("zoom")}
      </section>
    </>
  );
}


type WarningConfirmDialogProps = {
  core: CoreSettingsBag;
  toast: ReturnType<typeof useToast>["toast"];
};

export function WarningConfirmDialog(props: WarningConfirmDialogProps) {
  const { data, pendingConfirm, setDraftValues, setPendingConfirm, setSavingKey, updateMutation } = props.core;
  const { toast } = props;
  return (
    <>
      {pendingConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="dialog-warning-confirm"
        >
          <div className="bg-card rounded-lg shadow-xl max-w-lg w-full overflow-hidden">
            <div className="px-5 py-4 border-b bg-amber-50 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <h3 className="text-base font-semibold text-amber-900" data-testid="text-warning-dialog-title">
                Confirm risky guardrail change
              </h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-foreground">
                You're setting <span className="font-mono">{pendingConfirm.key}</span> on{" "}
                <span className="font-medium">{SCOPE_LABEL[pendingConfirm.scope]}</span> to{" "}
                <span className="font-mono">
                  {pendingConfirm.value === null ? "(cleared)" : pendingConfirm.value}
                </span>. This combination is likely an operational mistake:
              </p>
              <ul className="space-y-2">
                {pendingConfirm.warnings.map(w => (
                  <li
                    key={w.code}
                    className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    data-testid={`text-warning-dialog-${w.code}`}
                  >
                    {w.effectiveScope && w.effectiveScope !== pendingConfirm.scope && (
                      <span
                        className="inline-block mr-2 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-medium uppercase tracking-wide align-middle"
                        data-testid={`text-warning-dialog-${w.code}-scope`}
                      >
                        affects {SCOPE_LABEL[w.effectiveScope]}
                      </span>
                    )}
                    {w.message}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                You can save anyway if this is intentional. The acknowledgement will be recorded in the audit log.
              </p>
            </div>
            <div className="px-5 py-3 border-t bg-muted/50 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPendingConfirm(null);
                  setSavingKey(null);
                  updateMutation.reset();
                }}
                data-testid="button-warning-cancel"
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 text-white"
                disabled={updateMutation.isPending}
                onClick={() => {
                  const params = {
                    scope: pendingConfirm.scope,
                    key: pendingConfirm.key,
                    value: pendingConfirm.value,
                    acknowledgeWarnings: true,
                    restoreFromHistoryId: pendingConfirm.restoreFromHistoryId ?? null,
                  };
                  const wasRestore = !!pendingConfirm.restoreFromHistoryId;
                  setSavingKey(rowKey(pendingConfirm.scope, pendingConfirm.key));
                  setPendingConfirm(null);
                  updateMutation.mutate(params, {
                    onSuccess: () => {
                      setDraftValues((d) => {
                        const k = rowKey(params.scope, params.key);
                        const { [k]: _, ...rest } = d;
                        return rest;
                      });
                      if (wasRestore) {
                        toast({
                          title: "Snapshot restored",
                          description: `Restored ${params.key} to ${
                            params.value === null ? "(cleared)" : formatNumber(params.value)
                          } (guardrail warning acknowledged)`,
                          duration: 5000,
                        });
                      }
                    },
                  });
                }}
                data-testid="button-warning-save-anyway"
              >
                Save anyway
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
