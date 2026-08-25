import { useAuth } from "@/hooks/use-auth";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { ResetSavedViewButton } from "@/components/ResetSavedViewButton";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/admin/PageHeader";
import { Users, Activity, Clock, Eye, MousePointerClick, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Trash2, GitCompare, X, Link2, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useMemo, useEffect, Fragment } from "react";
import { format } from "date-fns";
import { ActivityDashboardSkeleton, ActivityContentSkeleton } from "@/components/ui/skeleton-loaders";

const ACTIVITY_ACTION_OPTIONS = new Set<string>([
  "all",
  "page_view",
  "navigation",
  "save",
  "export",
  "search",
  "sync",
  "form_submit",
  "action",
  "rate_limit_multipliers_updated",
  "rate_limit_multipliers_reset",
  "alert_threshold_updated",
  "warning_percent_updated",
  "user_role_updated",
  "recovery_jobs",
  "front_recovery_job_deleted",
  "front_recovery_jobs_cleared",
  "twilio_config_updated",
  "match_setting_updated",
  "zoom_common_first_names_updated",
  "front_recovery_max_age_updated",
]);

type ActivityLog = {
  id: string;
  userId: string | null;
  actionType: string;
  route: string | null;
  actionDetail: string | null;
  metadata: any;
  sessionId: string | null;
  duration: number | null;
  timestamp: string;
  userName?: string;
};

type ActivityStats = {
  activeUsersToday: number;
  totalEventsToday: number;
  topPages: { route: string; count: number }[];
  topActions: { actionType: string; count: number }[];
  avgSessionDuration: number;
};

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  page_view: "Page View",
  navigation: "Navigation",
  action: "Action",
  save: "Save",
  export: "Export",
  search: "Search",
  form_submit: "Form Submit",
  sync: "Sync",
  rate_limit_multipliers_updated: "Rate Limits Updated",
  rate_limit_multipliers_reset: "Rate Limits Reset",
  alert_threshold_updated: "Alert Threshold Updated",
  warning_percent_updated: "Warning % Updated",
  user_role_updated: "Role Updated",
  front_recovery_job_deleted: "Recovery Job Deleted",
  front_recovery_jobs_cleared: "Recovery Jobs Cleared",
  twilio_config_updated: "Twilio Config Updated",
  match_setting_updated: "Match Setting Updated",
  zoom_common_first_names_updated: "Zoom Common Names Updated",
  front_recovery_max_age_updated: "Front Recovery Max Age Updated",
};

const RECOVERY_JOB_ACTION_TYPES = ["front_recovery_job_deleted", "front_recovery_jobs_cleared"] as const;

const ACTION_TYPE_COLORS: Record<string, string> = {
  page_view: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  navigation: "bg-muted text-foreground",
  action: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
  save: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300",
  export: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
  search: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300",
  form_submit: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300",
  sync: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  rate_limit_multipliers_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  rate_limit_multipliers_reset: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  alert_threshold_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  warning_percent_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  user_role_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  front_recovery_job_deleted: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  front_recovery_jobs_cleared: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  twilio_config_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  match_setting_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  zoom_common_first_names_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  front_recovery_max_age_updated: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  team_lead: "Team Lead",
  recruiter: "Recruiter",
  client: "Client",
  candidate: "Candidate",
  anonymous: "Anonymous",
};

function formatRoleLabel(role: string): string {
  return ROLE_LABELS[role] || role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type DiffPrimitive = string | number | boolean | null;
type DiffRow = {
  key: string;
  oldValue: DiffPrimitive;
  newValue: DiffPrimitive;
  delta: number | null;
};

export type DiffConfig = {
  title: string;
  keyHeader: string;
  formatKey: (key: string) => string;
  formatValue: (value: DiffPrimitive) => string;
};

const DIFFABLE_ACTION_CONFIGS: Record<string, DiffConfig> = {
  rate_limit_multipliers_updated: {
    title: "Rate limit multiplier changes",
    keyHeader: "Role",
    formatKey: (k) => formatRoleLabel(k),
    formatValue: (v) => (typeof v === "number" ? `${v}×` : v == null ? "—" : String(v)),
  },
  rate_limit_multipliers_reset: {
    title: "Rate limit multiplier changes",
    keyHeader: "Role",
    formatKey: (k) => formatRoleLabel(k),
    formatValue: (v) => (typeof v === "number" ? `${v}×` : v == null ? "—" : String(v)),
  },
  alert_threshold_updated: {
    title: "Alert threshold changes",
    keyHeader: "Category",
    formatKey: (k) => k,
    formatValue: (v) => (typeof v === "number" ? String(v) : v == null ? "—" : String(v)),
  },
  warning_percent_updated: {
    title: "Warning percent changes",
    keyHeader: "Category",
    formatKey: (k) => k,
    formatValue: (v) => (typeof v === "number" ? `${v}%` : v == null ? "—" : String(v)),
  },
  user_role_updated: {
    title: "Role changes",
    keyHeader: "Field",
    formatKey: (k) => (k === "role" ? "Role" : k),
    formatValue: (v) => (typeof v === "string" ? formatRoleLabel(v) : v == null ? "—" : String(v)),
  },
  twilio_config_updated: {
    title: "Twilio config changes",
    keyHeader: "Field",
    formatKey: (k) => k,
    formatValue: (v) => (v == null ? "—" : String(v)),
  },
  match_setting_updated: {
    title: "Match setting changes",
    keyHeader: "Setting",
    formatKey: (k) => k,
    formatValue: (v) =>
      typeof v === "number" ? Number(v).toFixed(3) : v == null ? "unset" : String(v),
  },
  zoom_common_first_names_updated: {
    title: "Zoom common first names changes",
    keyHeader: "Field",
    formatKey: (k) => (k === "commonFirstNames" ? "Names" : k === "count" ? "Count" : k),
    formatValue: (v) => (v == null ? "—" : String(v)),
  },
  front_recovery_max_age_updated: {
    title: "Front recovery max age changes",
    keyHeader: "Setting",
    formatKey: (k) => (k === "maxAgeDays" ? "Max age (days)" : k),
    formatValue: (v) => (typeof v === "number" ? String(v) : v == null ? "—" : String(v)),
  },
};

function isDiffPrimitive(value: unknown): value is DiffPrimitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRecoveryJobEvent(actionType: string): boolean {
  return actionType === "front_recovery_job_deleted" || actionType === "front_recovery_jobs_cleared";
}

type RecoveryJobDetail = {
  primaryLabel: string;
  primaryValue: string;
  jobIds: string[];
  skippedJobIds: string[];
  jobStatus?: string | null;
  startedAt?: string | null;
};

function buildRecoveryJobDetail(actionType: string, metadata: any): RecoveryJobDetail | null {
  if (!metadata || typeof metadata !== "object") return null;
  if (actionType === "front_recovery_job_deleted") {
    const jobId = typeof metadata.jobId === "string" ? metadata.jobId : "";
    return {
      primaryLabel: "Job ID",
      primaryValue: jobId || "—",
      jobIds: jobId ? [jobId] : [],
      skippedJobIds: [],
      jobStatus: typeof metadata.jobStatus === "string" ? metadata.jobStatus : null,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : null,
    };
  }
  if (actionType === "front_recovery_jobs_cleared") {
    const deletedIds: string[] = Array.isArray(metadata.deletedJobIds) ? metadata.deletedJobIds.filter((s: any) => typeof s === "string") : [];
    const skippedIds: string[] = Array.isArray(metadata.skippedJobIds) ? metadata.skippedJobIds.filter((s: any) => typeof s === "string") : [];
    const deletedCount = typeof metadata.deletedCount === "number" ? metadata.deletedCount : deletedIds.length;
    const skippedCount = typeof metadata.skippedCount === "number" ? metadata.skippedCount : skippedIds.length;
    return {
      primaryLabel: "Deleted / Skipped",
      primaryValue: `${deletedCount} deleted${skippedCount ? `, ${skippedCount} skipped (still running)` : ""}`,
      jobIds: deletedIds,
      skippedJobIds: skippedIds,
    };
  }
  return null;
}

function buildDiffRows(metadata: any): DiffRow[] {
  if (!metadata || typeof metadata !== "object") return [];
  const oldValues: Record<string, unknown> =
    metadata.oldValues && typeof metadata.oldValues === "object" && !Array.isArray(metadata.oldValues)
      ? metadata.oldValues
      : {};
  const newValues: Record<string, unknown> =
    metadata.newValues && typeof metadata.newValues === "object" && !Array.isArray(metadata.newValues)
      ? metadata.newValues
      : {};
  const keys = Array.from(new Set([...Object.keys(oldValues), ...Object.keys(newValues)])).sort();
  const rows: DiffRow[] = [];
  for (const key of keys) {
    const oldRaw = oldValues[key];
    const newRaw = newValues[key];
    if (!isDiffPrimitive(oldRaw) || !isDiffPrimitive(newRaw)) continue;
    const delta =
      typeof oldRaw === "number" && typeof newRaw === "number" ? newRaw - oldRaw : null;
    rows.push({ key, oldValue: oldRaw, newValue: newRaw, delta });
  }
  return rows;
}

function isDiffableAction(actionType: string, metadata: any): boolean {
  if (!(actionType in DIFFABLE_ACTION_CONFIGS)) return false;
  return buildDiffRows(metadata).length > 0;
}

type MetadataEntry = { key: string; value: string; multiline: boolean };

function formatMetadataValue(value: unknown): { value: string; multiline: boolean } {
  if (value === null || value === undefined) return { value: "—", multiline: false };
  if (typeof value === "string") return { value, multiline: value.includes("\n") || value.length > 80 };
  if (typeof value === "number" || typeof value === "boolean") return { value: String(value), multiline: false };
  try {
    const json = JSON.stringify(value, null, 2);
    return { value: json, multiline: true };
  } catch {
    return { value: String(value), multiline: false };
  }
}

function formatMetadataKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function buildMetadataEntries(metadata: any): MetadataEntry[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const entries: MetadataEntry[] = [];
  for (const [key, raw] of Object.entries(metadata)) {
    if (raw === undefined) continue;
    const { value, multiline } = formatMetadataValue(raw);
    entries.push({ key, value, multiline });
  }
  return entries;
}

function hasGenericMetadata(actionType: string, metadata: any): boolean {
  if (isRecoveryJobEvent(actionType)) return false;
  if (isDiffableAction(actionType, metadata)) return false;
  return buildMetadataEntries(metadata).length > 0;
}

function getStateSnapshot(metadata: any): Record<string, DiffPrimitive> {
  if (!metadata || typeof metadata !== "object") return {};
  const newValues =
    metadata.newValues && typeof metadata.newValues === "object" && !Array.isArray(metadata.newValues)
      ? metadata.newValues
      : {};
  const oldValues =
    metadata.oldValues && typeof metadata.oldValues === "object" && !Array.isArray(metadata.oldValues)
      ? metadata.oldValues
      : {};
  const out: Record<string, DiffPrimitive> = {};
  for (const [k, v] of Object.entries(newValues)) {
    if (isDiffPrimitive(v)) out[k] = v;
  }
  for (const [k, v] of Object.entries(oldValues)) {
    if (k in out) continue;
    if (isDiffPrimitive(v)) out[k] = v;
  }
  return out;
}

function buildComparisonRows(beforeMeta: any, afterMeta: any): DiffRow[] {
  const before = getStateSnapshot(beforeMeta);
  const after = getStateSnapshot(afterMeta);
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const rows: DiffRow[] = [];
  for (const key of keys) {
    const oldRaw = key in before ? before[key] : null;
    const newRaw = key in after ? after[key] : null;
    const delta =
      typeof oldRaw === "number" && typeof newRaw === "number" ? newRaw - oldRaw : null;
    rows.push({ key, oldValue: oldRaw, newValue: newRaw, delta });
  }
  return rows;
}

type MultiStepCell = {
  oldValue: DiffPrimitive;
  newValue: DiffPrimitive;
  changed: boolean;
  stepDelta: number | null;
  differsFromPrevious: boolean;
};
export type MultiStepRow = {
  key: string;
  cells: MultiStepCell[];
};

function getOldValuesSnapshot(metadata: any): Record<string, DiffPrimitive> {
  if (!metadata || typeof metadata !== "object") return {};
  const oldValues =
    metadata.oldValues && typeof metadata.oldValues === "object" && !Array.isArray(metadata.oldValues)
      ? metadata.oldValues
      : {};
  const out: Record<string, DiffPrimitive> = {};
  for (const [k, v] of Object.entries(oldValues)) {
    if (isDiffPrimitive(v)) out[k] = v;
  }
  return out;
}

function getNewValuesSnapshot(metadata: any): Record<string, DiffPrimitive> {
  if (!metadata || typeof metadata !== "object") return {};
  const newValues =
    metadata.newValues && typeof metadata.newValues === "object" && !Array.isArray(metadata.newValues)
      ? metadata.newValues
      : {};
  const out: Record<string, DiffPrimitive> = {};
  for (const [k, v] of Object.entries(newValues)) {
    if (isDiffPrimitive(v)) out[k] = v;
  }
  return out;
}

function buildMultiStepComparisonRows(entries: ActivityLog[]): MultiStepRow[] {
  if (entries.length < 2) return [];
  const olds = entries.map((e) => getOldValuesSnapshot(e.metadata));
  const news = entries.map((e) => getNewValuesSnapshot(e.metadata));
  const keySet = new Set<string>();
  for (const snap of olds) for (const k of Object.keys(snap)) keySet.add(k);
  for (const snap of news) for (const k of Object.keys(snap)) keySet.add(k);
  const keys = Array.from(keySet).sort();

  const rows: MultiStepRow[] = [];
  for (const key of keys) {
    const cells: MultiStepCell[] = [];
    let prevNew: DiffPrimitive | undefined = undefined;
    for (let i = 0; i < entries.length; i++) {
      const oldVal = key in olds[i] ? olds[i][key] : null;
      const newVal = key in news[i] ? news[i][key] : null;
      const changed = oldVal !== newVal;
      let stepDelta: number | null = null;
      if (i > 0 && typeof prevNew === "number" && typeof newVal === "number") {
        stepDelta = newVal - prevNew;
      }
      const differsFromPrevious = i > 0 && newVal !== (prevNew ?? null);
      cells.push({ oldValue: oldVal, newValue: newVal, changed, stepDelta, differsFromPrevious });
      prevNew = newVal;
    }
    rows.push({ key, cells });
  }
  return rows;
}

export function buildMultiStepCsv(
  config: DiffConfig,
  entries: Pick<ActivityLog, "timestamp">[],
  rows: MultiStepRow[],
): string {
  const escape = (val: string) => {
    if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
    return val;
  };
  const header = [config.keyHeader];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const ts = format(new Date(entry.timestamp), "yyyy-MM-dd HH:mm:ss");
    header.push(`Step ${i + 1} timestamp`);
    header.push(`Step ${i + 1} value (${ts})`);
    if (i > 0) header.push(`Step ${i + 1} Δ`);
  }
  const lines = [header.map(escape).join(",")];
  for (const row of rows) {
    const cols: string[] = [config.formatKey(row.key)];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const cell = row.cells[i];
      cols.push(format(new Date(entry.timestamp), "yyyy-MM-dd HH:mm:ss"));
      cols.push(config.formatValue(cell.newValue));
      if (i > 0) {
        cols.push(typeof cell.stepDelta === "number" ? String(cell.stepDelta) : "");
      }
    }
    lines.push(cols.map(escape).join(","));
  }
  return lines.join("\r\n");
}

const LONG_STRING_DIFF_THRESHOLD = 40;

const COMPARE_STORAGE_KEY = "activityCompareSelectionIds";

type WordDiffSegment = { type: "eq" | "add" | "del"; text: string };

function tokenizeForDiff(value: string): string[] {
  return value.match(/\s+|[^\s,;]+|[,;]/g) ?? [];
}

function computeWordDiff(oldStr: string, newStr: string): WordDiffSegment[] {
  const a = tokenizeForDiff(oldStr);
  const b = tokenizeForDiff(newStr);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: WordDiffSegment[] = [];
  const push = (type: WordDiffSegment["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  while (i < n) {
    push("del", a[i]);
    i++;
  }
  while (j < m) {
    push("add", b[j]);
    j++;
  }
  return out;
}

function isLongStringChange(formattedOld: string, formattedNew: string): boolean {
  return (
    Math.max(formattedOld.length, formattedNew.length) >= LONG_STRING_DIFF_THRESHOLD &&
    formattedOld !== "—" &&
    formattedNew !== "—"
  );
}

function InlineWordDiff({
  oldText,
  newText,
  testId,
}: {
  oldText: string;
  newText: string;
  testId?: string;
}) {
  const segments = computeWordDiff(oldText, newText);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-y-0.5 text-left whitespace-pre-wrap break-words" data-testid={testId}>
      {segments.map((seg, idx) => {
        if (seg.type === "eq") {
          return (
            <span key={idx} className="text-foreground">
              {seg.text}
            </span>
          );
        }
        if (seg.type === "add") {
          return (
            <span
              key={idx}
              className="bg-emerald-100 text-emerald-900 font-semibold rounded px-0.5"
            >
              {seg.text}
            </span>
          );
        }
        return (
          <span
            key={idx}
            className="bg-rose-100 text-rose-800 line-through decoration-rose-500/70 rounded px-0.5"
          >
            {seg.text}
          </span>
        );
      })}
    </span>
  );
}

function MiniSparkline({
  values,
  testId,
  labels,
}: {
  values: (number | null)[];
  testId?: string;
  labels?: (string | undefined)[];
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const numeric = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const present = numeric.filter((v): v is number => v !== null);
  if (present.length < 2) return null;
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min;
  const width = 80;
  const height = 20;
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const stepX = numeric.length > 1 ? innerW / (numeric.length - 1) : 0;
  const yFor = (v: number) => {
    if (range === 0) return padY + innerH / 2;
    return padY + innerH - ((v - min) / range) * innerH;
  };
  const points: { x: number; y: number; v: number | null }[] = numeric.map((v, i) => ({
    x: padX + i * stepX,
    y: v === null ? padY + innerH / 2 : yFor(v),
    v,
  }));
  const segments: string[] = [];
  let pen = false;
  for (const p of points) {
    if (p.v === null) {
      pen = false;
      continue;
    }
    segments.push(`${pen ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    pen = true;
  }
  const path = segments.join(" ");
  const last = [...points].reverse().find((p) => p.v !== null);
  const first = points.find((p) => p.v !== null);
  const trendColor =
    last && first && last.v !== null && first.v !== null
      ? last.v > first.v
        ? "#047857"
        : last.v < first.v
          ? "#be123c"
          : "#6b7280"
      : "#6b7280";
  const labelFor = (i: number) => {
    const v = points[i].v;
    const stepLabel = labels?.[i] ? `Step ${i + 1} (${labels[i]})` : `Step ${i + 1}`;
    return v === null ? `${stepLabel}: no value` : `${stepLabel}: ${v}`;
  };
  const safeActiveIdx =
    activeIdx !== null && activeIdx >= 0 && activeIdx < points.length ? activeIdx : null;
  const active = safeActiveIdx !== null ? points[safeActiveIdx] : null;
  const activeLabel = safeActiveIdx !== null ? labelFor(safeActiveIdx) : "";
  const tooltipPaddingX = 4;
  // Task #4500: geometry sized for the 10px chart-label floor (was 8px).
  const tooltipHeight = 14;
  const charW = 6.2;
  const tooltipWidth = Math.max(20, activeLabel.length * charW + tooltipPaddingX * 2);
  let tooltipX = active ? active.x - tooltipWidth / 2 : 0;
  if (tooltipX < 0) tooltipX = 0;
  if (tooltipX + tooltipWidth > width) tooltipX = width - tooltipWidth;
  const tooltipY = active && active.y > tooltipHeight + 2 ? active.y - tooltipHeight - 2 : (active ? active.y + 4 : 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Trend sparkline"
      data-testid={testId}
      className="inline-block align-middle overflow-visible"
    >
      <path d={path} fill="none" stroke={trendColor} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) =>
        p.v === null ? null : (
          <circle key={`pt-${i}`} cx={p.x} cy={p.y} r={1.4} fill={trendColor} />
        ),
      )}
      {points.map((p, i) => (
        <circle
          key={`hit-${i}`}
          cx={p.x}
          cy={p.y}
          r={5}
          fill="transparent"
          stroke="transparent"
          tabIndex={0}
          focusable="true"
          aria-label={labelFor(i)}
          data-testid={testId ? `${testId}-point-${i + 1}` : undefined}
          style={{ cursor: "default", outline: "none" }}
          onMouseEnter={() => setActiveIdx(i)}
          onMouseLeave={() => setActiveIdx((curr) => (curr === i ? null : curr))}
          onFocus={() => setActiveIdx(i)}
          onBlur={() => setActiveIdx((curr) => (curr === i ? null : curr))}
        />
      ))}
      {active && (
        <g
          pointerEvents="none"
          data-testid={testId ? `${testId}-tooltip` : undefined}
        >
          <rect
            x={tooltipX}
            y={tooltipY}
            width={tooltipWidth}
            height={tooltipHeight}
            rx={2}
            ry={2}
            fill="#111827"
            opacity={0.92}
          />
          <text
            x={tooltipX + tooltipWidth / 2}
            y={tooltipY + tooltipHeight - 3.5}
            textAnchor="middle"
            fontSize={10}
            fill="#ffffff"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {activeLabel}
          </text>
        </g>
      )}
    </svg>
  );
}

function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  if (delta === 0) return "0";
  const rounded = Math.round(delta * 1000) / 1000;
  return `${delta > 0 ? "+" : ""}${rounded}`;
}

function getRouteName(route: string): string {
  const routeNames: Record<string, string> = {
    "/": "Dashboard",
    "/admin/clients": "Client Management",
    "/admin/users": "User Management",
    "/admin/ceo-pulse": "NoBull Brief Studio",
    "/admin/activity": "Activity Dashboard",
    "/reports/new": "New Report",
    "/reports/matrix": "Report Matrix",
    "/reports/compare": "Report Comparison",
    "/analytics/trends": "Trend Analytics",
    "/ceo/insights": "CEO Insights",
    "/ceo/ats": "ATS Admin",
    "/comms": "Comms",
    // Legacy route (Task #4373: converged into /comms) — old visit rows keep a label.
    "/conversations": "Conversations",
    "/profile": "Profile",
  };
  return routeNames[route] || route;
}

export default function ActivityDashboard() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Activity Dashboard");

  const ns = user?.id ? `admin.activityDashboard.${user.id}` : null;
  const isString = (v: unknown): v is string => typeof v === "string";
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const validAction = (v: unknown): v is string =>
    typeof v === "string" && ACTIVITY_ACTION_OPTIONS.has(v);
  const [filterUser, setFilterUser] = usePersistentState<string>(
    ns ? `${ns}.filterUser` : null,
    "all",
    isString,
  );
  const [filterAction, setFilterAction] = usePersistentState<string>(
    ns ? `${ns}.filterAction` : null,
    "all",
    validAction,
  );
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [page, setPage] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  // REGRESSION NOTE: MAX_COMPARE is the single source of truth for the compare-entries cap.
  // It governs (a) the in-feed selection limit, (b) the localStorage hydrate slice,
  // (c) the shareable ?compare=<csv> URL parse slice, and (d) the help-text copy.
  // The /api/activity?ids=<csv> endpoint accepts up to 50 ids, so raising this cap
  // up to 50 is safe end-to-end. If you raise it above 50, also bump the server-side
  // cap in server/routes/activity.ts (the `ids.length > 50` guard). The share-link
  // generation joins ALL selected ids — do not reintroduce a hard-coded "before/after"
  // pair when widening the cap.
  const MAX_COMPARE = 5;
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState<ActivityLog[]>([]);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [hideUnchangedRows, setHideUnchangedRows] = usePersistentState<boolean>(
    ns ? `${ns}.hideUnchangedRows` : null,
    false,
    isBool,
  );

  const persistedViewKeys = useMemo(
    () =>
      ns
        ? [
            `${ns}.filterUser`,
            `${ns}.filterAction`,
            `${ns}.hideUnchangedRows`,
            COMPARE_STORAGE_KEY,
          ]
        : [COMPARE_STORAGE_KEY],
    [ns],
  );
  const handleResetSavedView = () => {
    setFilterUser("all");
    setFilterAction("all");
    setHideUnchangedRows(false);
    setCompareSelection([]);
    setCompareMode(false);
    setCompareDialogOpen(false);
  };
  const [hydratingSelection, setHydratingSelection] = useState(false);
  const [initialHydrateAttempted, setInitialHydrateAttempted] = useState(false);
  const [autoOpenedFromShare, setAutoOpenedFromShare] = useState<number>(0);
  const pageSize = 50;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let initialIds: string[] = [];
    let openDialogAfterHydrate = false;
    let autoOpenSessionKey: string | null = null;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const compareParam = urlParams.get("compare");
      if (compareParam) {
        initialIds = compareParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, MAX_COMPARE);
        if (initialIds.length >= 2) {
          // Two-stage gate so auto-open ONLY fires for true external/shared
          // link loads, never for in-app-generated URLs:
          //
          // Stage 1 (external-entry gate): The URL-sync effect below mirrors
          // the in-app compare selection into ?compare= via replaceState.
          // That means a user who builds a comparison in-app, then reloads
          // or hits Back, will land on a URL with ?compare= even though
          // they never followed a shared link. We use the Navigation
          // Timing API + document.referrer to distinguish:
          //   * "navigate" + (no referrer OR cross-origin referrer)
          //     => fresh external entry (paste, click from email/Slack,
          //     new tab) -> eligible for auto-open
          //   * "reload" / "back_forward" => in-tab refresh or history
          //     navigation -> NEVER auto-open (covers the in-app case)
          //   * "navigate" + same-origin referrer => internal navigation
          //     to the dashboard -> NOT auto-open (treat as in-app)
          //
          // Stage 2 (one-shot session key): Even on a qualifying external
          // entry, only auto-open the FIRST time per tab/session for a
          // given normalized id set, so duplicate shared-link loads in
          // the same tab don't re-pop the dialog after dismissal.
          let isExternalEntry = false;
          try {
            const navEntries = window.performance?.getEntriesByType?.(
              "navigation",
            ) as PerformanceNavigationTiming[] | undefined;
            const navType = navEntries && navEntries.length > 0
              ? navEntries[0].type
              : undefined;
            if (navType === "navigate") {
              const referrer = document.referrer;
              if (!referrer) {
                isExternalEntry = true;
              } else {
                try {
                  const refOrigin = new URL(referrer).origin;
                  if (refOrigin !== window.location.origin) {
                    isExternalEntry = true;
                  }
                } catch {
                  // malformed referrer -> treat as external
                  isExternalEntry = true;
                }
              }
            }
            // navType === "reload" or "back_forward" -> isExternalEntry
            // stays false. If navType is undefined (very old browsers),
            // we conservatively skip auto-open rather than risk firing on
            // an in-app URL.
          } catch {
            // performance API unavailable -> skip auto-open conservatively
          }
          if (isExternalEntry) {
            const normalizedKey = [...initialIds].sort().join(",");
            autoOpenSessionKey = `activityCompareAutoOpened:${normalizedKey}`;
            let alreadyAutoOpened = false;
            try {
              alreadyAutoOpened =
                window.sessionStorage.getItem(autoOpenSessionKey) === "1";
            } catch {
              // ignore sessionStorage access errors (private mode, etc.)
            }
            if (!alreadyAutoOpened) openDialogAfterHydrate = true;
          }
        }
      }
    } catch {
      // ignore url parse errors
    }
    if (initialIds.length === 0) {
      let storedRaw: string | null = null;
      try {
        storedRaw = window.localStorage.getItem(COMPARE_STORAGE_KEY);
      } catch {
        return;
      }
      if (!storedRaw) return;
      try {
        const parsed = JSON.parse(storedRaw);
        if (Array.isArray(parsed)) initialIds = parsed.filter((s: unknown) => typeof s === "string").slice(0, MAX_COMPARE);
      } catch {
        return;
      }
    }
    if (initialIds.length === 0) {
      setInitialHydrateAttempted(true);
      return;
    }
    setHydratingSelection(true);
    fetch(`/api/activity?ids=${encodeURIComponent(initialIds.join(","))}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed"))))
      .then((body: { data: ActivityLog[] }) => {
        const byId = new Map(body.data.map((l) => [l.id, l]));
        const ordered = initialIds.map((id) => byId.get(id)).filter((l): l is ActivityLog => !!l);
        setCompareSelection(ordered);
        if (ordered.length > 0) {
          setCompareMode(true);
          if (openDialogAfterHydrate && ordered.length >= 2) {
            setCompareDialogOpen(true);
            setAutoOpenedFromShare(ordered.length);
            if (autoOpenSessionKey) {
              try {
                window.sessionStorage.setItem(autoOpenSessionKey, "1");
              } catch {
                // ignore sessionStorage write errors
              }
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setHydratingSelection(false);
        setInitialHydrateAttempted(true);
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!initialHydrateAttempted) return;
    try {
      if (compareSelection.length === 0) {
        window.localStorage.removeItem(COMPARE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(compareSelection.map((l) => l.id)));
      }
    } catch {
      // ignore quota errors
    }
    try {
      const url = new URL(window.location.href);
      if (compareSelection.length === 0) {
        if (url.searchParams.has("compare")) {
          url.searchParams.delete("compare");
          window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
        }
      } else {
        const next = compareSelection.map((l) => l.id).join(",");
        if (url.searchParams.get("compare") !== next) {
          url.searchParams.set("compare", next);
          window.history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString() + url.hash);
        }
      }
    } catch {
      // ignore url update errors
    }
    // `initialHydrateAttempted` gates the write; once true it never flips
    // back, so adding it can only trigger one extra (idempotent) sync.
  }, [compareSelection, initialHydrateAttempted]);

  const toggleRow = (id: string) => {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const jumpToActivityEntry = (entryId: string) => {
    setCompareDialogOpen(false);
    setHideUnchangedRows(false);
    setExpandedRows(prev => (prev[entryId] ? prev : { ...prev, [entryId]: true }));
    const focusRow = (attempt = 0) => {
      const el = document.getElementById(`activity-row-${entryId}`);
      if (el) {
        el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
        el.classList.add("ring-2", "ring-amber-300", "ring-inset");
        window.setTimeout(() => {
          el.classList.remove("ring-2", "ring-amber-300", "ring-inset");
        }, 1600);
      } else if (attempt < 10) {
        window.setTimeout(() => focusRow(attempt + 1), 50);
      }
    };
    window.setTimeout(() => focusRow(), 60);
  };

  const toggleCompareSelection = (log: ActivityLog) => {
    setCompareSelection(prev => {
      if (prev.some(l => l.id === log.id)) {
        return prev.filter(l => l.id !== log.id);
      }
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, log];
    });
  };

  const clearCompareSelection = () => setCompareSelection([]);

  const { toast } = useToast();

  useEffect(() => {
    if (autoOpenedFromShare <= 0) return;
    // Session-level one-shot: even across different ?compare= id sets,
    // only show the orientation hint once per tab/session. The existing
    // per-id-set sessionStorage gate above prevents the dialog from
    // re-popping for the same set, but a brand-new shared link in the
    // same tab would still re-trigger the hint without this guard.
    const HINT_SESSION_KEY = "activityCompareShareHintShown";
    try {
      if (window.sessionStorage.getItem(HINT_SESSION_KEY) === "1") return;
    } catch {
      // ignore sessionStorage read errors (private mode, etc.)
    }
    toast({
      title: "Opened from shared link",
      description: `${autoOpenedFromShare} entries pre-selected for comparison.`,
    });
    try {
      window.sessionStorage.setItem(HINT_SESSION_KEY, "1");
    } catch {
      // ignore sessionStorage write errors
    }
  }, [autoOpenedFromShare, toast]);

  const compareLinkSummary = useMemo(() => {
    if (compareSelection.length < 2) return "";
    const allSameType = compareSelection.every(
      (l) => l.actionType === compareSelection[0].actionType,
    );
    const noun = allSameType
      ? ACTION_TYPE_LABELS[compareSelection[0].actionType] || compareSelection[0].actionType
      : "config";
    const times = compareSelection
      .map((l) => new Date(l.timestamp).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    let dateRange = "";
    if (times.length > 0) {
      const first = format(new Date(times[0]), "MMM d");
      const last = format(new Date(times[times.length - 1]), "MMM d");
      dateRange = first === last ? ` from ${first}` : ` from ${first} – ${last}`;
    }
    const uniqueNames = Array.from(
      new Set(compareSelection.map((l) => l.userName?.trim()).filter((n): n is string => !!n)),
    );
    let byPart = "";
    if (uniqueNames.length === 1) {
      byPart = ` by ${uniqueNames[0]}`;
    } else if (uniqueNames.length === 2) {
      byPart = ` by ${uniqueNames[0]} and ${uniqueNames[1]}`;
    } else if (uniqueNames.length > 2) {
      byPart = ` by ${uniqueNames[0]}, ${uniqueNames[1]} and ${uniqueNames.length - 2} others`;
    }
    return `Comparing ${compareSelection.length} ${noun} changes${byPart}${dateRange}`;
  }, [compareSelection]);

  const copyCompareLink = async () => {
    try {
      const url = window.location.href;
      const payload = compareLinkSummary ? `${compareLinkSummary}\n${url}` : url;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({
        title: "Link copied",
        description: compareLinkSummary
          ? `${compareLinkSummary} — summary + URL copied.`
          : "Share this URL to show the same comparison.",
      });
    } catch {
      toast({ title: "Couldn't copy link", description: "Copy the address bar manually.", variant: "destructive" });
    }
  };

  const downloadMultiStepCsv = () => {
    if (!multiStepConfig || multiStepEntries.length === 0 || multiStepRows.length === 0) return;
    const csv = buildMultiStepCsv(multiStepConfig, multiStepEntries, multiStepRows);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = format(new Date(), "yyyyMMdd-HHmmss");
    a.download = `comparison-${multiStepEntries[0].actionType}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exitCompareMode = () => {
    setCompareMode(false);
    setCompareSelection([]);
    setCompareDialogOpen(false);
  };

  const compareLockedActionType = compareSelection[0]?.actionType ?? null;
  const compareAllSameActionType =
    compareSelection.length >= 2 &&
    compareSelection.every(l => l.actionType === compareSelection[0].actionType);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(page * pageSize));
    if (filterUser && filterUser !== "all") params.set("userId", filterUser);
    if (filterAction && filterAction !== "all") {
      if (filterAction === "recovery_jobs") {
        params.set("actionTypes", RECOVERY_JOB_ACTION_TYPES.join(","));
      } else {
        params.set("actionType", filterAction);
      }
    }
    if (dateFrom) params.set("dateFrom", new Date(dateFrom).toISOString());
    if (dateTo) params.set("dateTo", new Date(dateTo + "T23:59:59").toISOString());
    return params.toString();
  }, [filterUser, filterAction, dateFrom, dateTo, page]);

  const statsParams = useMemo(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", new Date(dateFrom).toISOString());
    if (dateTo) params.set("dateTo", new Date(dateTo + "T23:59:59").toISOString());
    return params.toString();
  }, [dateFrom, dateTo]);

  const { data: activityData, isLoading: logsLoading } = useQuery<{ data: ActivityLog[]; total: number }>({
    queryKey: ["/api/activity", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/activity?${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch activity");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const { data: stats } = useQuery<ActivityStats>({
    queryKey: ["/api/activity/stats", statsParams],
    queryFn: async () => {
      const res = await fetch(`/api/activity/stats?${statsParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const { data: allUsers } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  useEffect(() => {
    if (!allUsers) return;
    if (filterUser !== "all" && !allUsers.some((u) => u.id === filterUser)) {
      setFilterUser("all");
    }
  }, [allUsers, filterUser, setFilterUser]);

  if (authLoading) {
    return <ActivityDashboardSkeleton />;
  }

  if (!user || (user.role !== "team_lead" && user.role !== "ceo")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground">Access denied. Team Lead or CEO access required.</div>
      </div>
    );
  }

  const logs = activityData?.data || [];
  const totalLogs = activityData?.total || 0;
  const totalPages = Math.ceil(totalLogs / pageSize);

  const sortedCompareEntries = compareSelection.length >= 2
    ? [...compareSelection].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )
    : [];

  const sortedComparePair =
    sortedCompareEntries.length === 2
      ? { before: sortedCompareEntries[0], after: sortedCompareEntries[1] }
      : null;

  const sameTypeComparison =
    sortedComparePair && sortedComparePair.before.actionType === sortedComparePair.after.actionType
      ? sortedComparePair
      : null;

  const comparisonRows = sameTypeComparison
    ? buildComparisonRows(sameTypeComparison.before.metadata, sameTypeComparison.after.metadata)
    : [];

  const comparisonConfig = sameTypeComparison
    ? DIFFABLE_ACTION_CONFIGS[sameTypeComparison.before.actionType] ?? null
    : null;

  const allSameActionType =
    sortedCompareEntries.length >= 2 &&
    sortedCompareEntries.every((e) => e.actionType === sortedCompareEntries[0].actionType);

  const multiStepEntries =
    !sameTypeComparison && allSameActionType && sortedCompareEntries.length >= 3
      ? sortedCompareEntries
      : [];
  const multiStepConfig =
    multiStepEntries.length > 0
      ? DIFFABLE_ACTION_CONFIGS[multiStepEntries[0].actionType] ?? null
      : null;
  const multiStepRows =
    multiStepEntries.length > 0 ? buildMultiStepComparisonRows(multiStepEntries) : [];

  const multiStepSections =
    multiStepEntries.length > 0
      ? multiStepEntries.map((entry, idx) => ({
          position: `step-${idx + 1}`,
          index: idx,
          total: multiStepEntries.length,
          entry,
          config: DIFFABLE_ACTION_CONFIGS[entry.actionType] ?? null,
          rows: buildDiffRows(entry.metadata),
        }))
      : [];

  const multiSectionEntries =
    sortedCompareEntries.length >= 2 && !sameTypeComparison && multiStepEntries.length === 0
      ? sortedCompareEntries.map((entry, idx) => {
          const config = DIFFABLE_ACTION_CONFIGS[entry.actionType] ?? null;
          return {
            position: `entry-${idx + 1}`,
            index: idx,
            total: sortedCompareEntries.length,
            entry,
            config,
            rows: buildDiffRows(entry.metadata),
          };
        })
      : [];

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <main className="max-w-7xl mx-auto p-3 sm:p-6 space-y-6">
        {/* Task #4355 — Pattern-B → shared PageHeader (audit §6.1-B / P1-4);
            replaces the page-local burgundy band header. */}
        <PageHeader
          title="User Activity"
          backHref="/"
          actions={
            <ResetSavedViewButton
              storageKeys={persistedViewKeys}
              onReset={handleResetSavedView}
              testId="button-reset-saved-view-activity"
            />
          }
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-card border-primary/10">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Users className="w-4 h-4" />
                Active Users
              </div>
              <div className="text-2xl font-bold text-foreground" data-testid="text-active-users">
                {stats?.activeUsersToday ?? "—"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-primary/10">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Activity className="w-4 h-4" />
                Total Events
              </div>
              <div className="text-2xl font-bold text-foreground" data-testid="text-total-events">
                {stats?.totalEventsToday ?? "—"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-primary/10">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Clock className="w-4 h-4" />
                Avg Dwell Time
              </div>
              <div className="text-2xl font-bold text-foreground" data-testid="text-avg-dwell">
                {stats ? formatDuration(stats.avgSessionDuration) : "—"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-primary/10">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Eye className="w-4 h-4" />
                Top Page
              </div>
              <div className="text-lg font-bold text-foreground truncate" data-testid="text-top-page">
                {stats?.topPages?.[0] ? getRouteName(stats.topPages[0].route) : "—"}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <Card className="bg-card border-primary/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-foreground">Most Visited Pages</CardTitle>
            </CardHeader>
            <CardContent>
              {stats?.topPages && stats.topPages.length > 0 ? (
                <div className="space-y-2">
                  {stats.topPages.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-sm" data-testid={`row-top-page-${i}`}>
                      <span className="truncate text-foreground">{getRouteName(p.route)}</span>
                      <Badge variant="secondary" className="ml-2 shrink-0">{p.count}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No data yet</p>
              )}
            </CardContent>
          </Card>
          <Card className="bg-card border-primary/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-foreground">Action Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              {stats?.topActions && stats.topActions.length > 0 ? (
                <div className="space-y-2">
                  {stats.topActions.map((a, i) => (
                    <div key={i} className="flex items-center justify-between text-sm" data-testid={`row-top-action-${i}`}>
                      <Badge className={ACTION_TYPE_COLORS[a.actionType] || "bg-muted text-foreground"}>
                        {ACTION_TYPE_LABELS[a.actionType] || a.actionType}
                      </Badge>
                      <span className="text-muted-foreground font-medium">{a.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No data yet</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="bg-card border-primary/10">
          <CardHeader>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-foreground">Activity Feed</CardTitle>
              <Button
                variant={compareMode ? "default" : "outline"}
                size="sm"
                onClick={() => (compareMode ? exitCompareMode() : setCompareMode(true))}
                className={compareMode ? "bg-primary hover:bg-primary/90 text-primary-foreground" : ""}
                data-testid="button-toggle-compare-mode"
              >
                <GitCompare className="w-4 h-4 mr-2" />
                {compareMode ? "Exit compare" : "Compare entries"}
              </Button>
            </div>
            {compareMode && (
              <div
                className="mt-3 flex flex-col gap-2 rounded-md border border-primary/20 bg-surface-warm-1 px-3 py-2"
                data-testid="bar-compare-selection"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm text-foreground">
                  {compareSelection.length === 0 && (
                    <span data-testid="text-compare-help">
                      {hydratingSelection
                        ? "Restoring previous selection…"
                        : `Pick 2–${MAX_COMPARE} config-change entries to compare them side by side. They can be the same action type or different types.`}
                    </span>
                  )}
                  {compareSelection.length === 1 && compareLockedActionType && (
                    <span data-testid="text-compare-help">
                      <span className="font-medium">1 selected</span> ({ACTION_TYPE_LABELS[compareLockedActionType] || compareLockedActionType}). Pick up to {MAX_COMPARE - 1} more config-change entries to compare. You can change pages or filters — your selection is kept.
                    </span>
                  )}
                  {compareSelection.length >= 2 && (
                    <span data-testid="text-compare-help" className="font-medium">
                      {compareSelection.length} selected — ready to compare{compareAllSameActionType ? "" : " (mixed action types)"}.
                      {compareSelection.length < MAX_COMPARE
                        ? ` You can add up to ${MAX_COMPARE - compareSelection.length} more.`
                        : ` Maximum of ${MAX_COMPARE} reached.`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearCompareSelection}
                    disabled={compareSelection.length === 0}
                    data-testid="button-clear-compare-selection"
                  >
                    <X className="w-4 h-4 mr-1" />
                    Clear
                  </Button>
                  {compareLinkSummary && (
                    <span
                      className="hidden md:inline text-xs italic text-muted-foreground max-w-[260px] truncate"
                      title={compareLinkSummary}
                      data-testid="text-compare-link-preview"
                    >
                      “{compareLinkSummary}”
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyCompareLink}
                    disabled={compareSelection.length < 2}
                    data-testid="button-copy-compare-link"
                  >
                    <Link2 className="w-4 h-4 mr-1" />
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setCompareDialogOpen(true)}
                    disabled={compareSelection.length < 2}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    data-testid="button-open-compare-dialog"
                  >
                    Compare
                  </Button>
                </div>
                </div>
                {compareSelection.length > 0 && (
                  <div className="flex flex-wrap gap-2" data-testid="list-compare-chips">
                    {compareSelection.map((sel) => {
                      const onCurrentPage = logs.some((l) => l.id === sel.id);
                      return (
                        <div
                          key={sel.id}
                          className="flex items-center gap-2 rounded-full border border-primary/30 bg-card px-2.5 py-1 text-xs text-primary dark:text-foreground"
                          data-testid={`chip-compare-${sel.id}`}
                        >
                          <Badge className={`text-xs ${ACTION_TYPE_COLORS[sel.actionType] || "bg-muted text-foreground"}`}>
                            {ACTION_TYPE_LABELS[sel.actionType] || sel.actionType}
                          </Badge>
                          <span className="text-muted-foreground">
                            {format(new Date(sel.timestamp), "MMM d, h:mm a")}
                          </span>
                          <span className="text-muted-foreground">· {sel.userName || "Unknown"}</span>
                          {!onCurrentPage && (
                            <span
                              className="text-xs uppercase tracking-wide text-amber-700"
                              data-testid={`text-chip-offpage-${sel.id}`}
                            >
                              off page
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => toggleCompareSelection(sel)}
                            className="text-muted-foreground hover:text-rose-600"
                            aria-label="Remove from comparison"
                            data-testid={`button-chip-remove-${sel.id}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-3 mt-3">
              <Select value={filterUser} onValueChange={(v) => { setFilterUser(v); setPage(0); }}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by user" data-testid="select-filter-user">
                  <SelectValue placeholder="All Users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Users</SelectItem>
                  {allUsers?.map(u => (
                    <SelectItem key={u.id} value={u.id}>
                      {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterAction} onValueChange={(v) => { setFilterAction(v); setPage(0); }}>
                <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filter by action" data-testid="select-filter-action">
                  <SelectValue placeholder="All Actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  <SelectItem value="page_view">Page View</SelectItem>
                  <SelectItem value="navigation">Navigation</SelectItem>
                  <SelectItem value="save">Save</SelectItem>
                  <SelectItem value="export">Export</SelectItem>
                  <SelectItem value="search">Search</SelectItem>
                  <SelectItem value="sync">Sync</SelectItem>
                  <SelectItem value="form_submit">Form Submit</SelectItem>
                  <SelectItem value="action">Action</SelectItem>
                  <SelectItem value="rate_limit_multipliers_updated">Rate Limits Updated</SelectItem>
                  <SelectItem value="rate_limit_multipliers_reset">Rate Limits Reset</SelectItem>
                  <SelectItem value="alert_threshold_updated">Alert Threshold Updated</SelectItem>
                  <SelectItem value="warning_percent_updated">Warning % Updated</SelectItem>
                  <SelectItem value="user_role_updated">Role Updated</SelectItem>
                  <SelectItem value="recovery_jobs">Recovery Jobs (all)</SelectItem>
                  <SelectItem value="front_recovery_job_deleted">Recovery Job Deleted</SelectItem>
                  <SelectItem value="front_recovery_jobs_cleared">Recovery Jobs Cleared</SelectItem>
                  <SelectItem value="twilio_config_updated">Twilio Config Updated</SelectItem>
                  <SelectItem value="match_setting_updated">Match Setting Updated</SelectItem>
                  <SelectItem value="zoom_common_first_names_updated">Zoom Common Names Updated</SelectItem>
                  <SelectItem value="front_recovery_max_age_updated">Front Recovery Max Age Updated</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={filterAction === "recovery_jobs" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setFilterAction(filterAction === "recovery_jobs" ? "all" : "recovery_jobs");
                  setPage(0);
                }}
                className={filterAction === "recovery_jobs" ? "bg-amber-600 hover:bg-amber-700 text-white" : "border-amber-300 text-amber-800 hover:bg-amber-50"}
                data-testid="button-filter-recovery-jobs"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Recovery Jobs
              </Button>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
                className="w-full sm:w-[150px]"
                placeholder="From"
                aria-label="Filter activity from date"
                data-testid="input-date-from"
              />
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
                className="w-full sm:w-[150px]"
                placeholder="To"
                aria-label="Filter activity to date"
                data-testid="input-date-to"
              />
            </div>
          </CardHeader>
          <CardContent>
            {logsLoading ? (
              <ActivityContentSkeleton />
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No activity found</div>
            ) : (
              <>
                {/* Task #4348 — bound the event wall: the page is already
                    server-paginated (50/page), but a tall page of expanded
                    detail rows could still grow unbounded. Cap the viewport
                    and pin the header while scrolling. (Tailwind utilities,
                    not the reserved OsTable shell classes — this bespoke
                    table keeps its expandable detail rows + compare mode.) */}
                <div className="os-table-wrap max-h-[70vh] overflow-y-auto">
                  <table className="w-full text-sm os-sticky-col">
                    <thead className="sticky top-0 z-[var(--z-sticky)] bg-card">
                      <tr className="border-b text-left text-muted-foreground">
                        {compareMode && <th className="pb-2 pr-2 w-8"></th>}
                        <th className="pb-2 pr-4">Time</th>
                        <th className="pb-2 pr-4">User</th>
                        <th className="pb-2 pr-4">Type</th>
                        <th className="pb-2 pr-4">Page</th>
                        <th className="pb-2 pr-4">Detail</th>
                        <th className="pb-2">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log) => {
                        const isRecovery = isRecoveryJobEvent(log.actionType);
                        const isDiffable = isDiffableAction(log.actionType, log.metadata);
                        const isGenericMetadata = hasGenericMetadata(log.actionType, log.metadata);
                        const expandable = isRecovery || isDiffable || isGenericMetadata;
                        const diffConfig = isDiffable ? DIFFABLE_ACTION_CONFIGS[log.actionType] : null;
                        const isExpanded = expandable && !!expandedRows[log.id];
                        const changeRows = isExpanded && isDiffable ? buildDiffRows(log.metadata) : [];
                        const recoveryDetail = isExpanded && isRecovery ? buildRecoveryJobDetail(log.actionType, log.metadata) : null;
                        const metadataEntries = isExpanded && isGenericMetadata ? buildMetadataEntries(log.metadata) : [];
                        const isSelectedForCompare = compareSelection.some(l => l.id === log.id);
                        const compareSelectable = isDiffable;
                        const checkboxDisabled =
                          !isDiffable ||
                          (!isSelectedForCompare && compareSelection.length >= MAX_COMPARE);
                        const colSpan = compareMode ? 7 : 6;
                        return (
                          <Fragment key={log.id}>
                            <tr
                              id={`activity-row-${log.id}`}
                              className={`border-b border-border/50 hover:bg-muted/30 ${expandable && !compareMode ? "cursor-pointer" : ""} ${isSelectedForCompare ? "bg-surface-warm-1/70 [--os-sticky-col-bg:color-mix(in_srgb,hsl(var(--surface-warm-1))_70%,hsl(var(--os-table-surface)))]" : ""}`}
                              data-testid={`row-activity-${log.id}`}
                              onClick={
                                compareMode
                                  ? compareSelectable && !checkboxDisabled
                                    ? () => toggleCompareSelection(log)
                                    : undefined
                                  : expandable
                                    ? () => toggleRow(log.id)
                                    : undefined
                              }
                            >
                              {compareMode && (
                                <td className="py-2 pr-2 align-middle" onClick={(e) => e.stopPropagation()}>
                                  <Checkbox
                                    checked={isSelectedForCompare}
                                    disabled={checkboxDisabled}
                                    onCheckedChange={() => {
                                      if (!checkboxDisabled) toggleCompareSelection(log);
                                    }}
                                    aria-label={
                                      isDiffable
                                        ? "Select for comparison"
                                        : "Not a comparable entry"
                                    }
                                    data-testid={`checkbox-compare-${log.id}`}
                                  />
                                </td>
                              )}
                              <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap text-xs">
                                <div className="flex items-center gap-1">
                                  {expandable && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); toggleRow(log.id); }}
                                      className="text-muted-foreground hover:text-muted-foreground"
                                      aria-label={isExpanded ? "Collapse details" : "Expand details"}
                                      data-testid={`button-toggle-details-${log.id}`}
                                    >
                                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                    </button>
                                  )}
                                  <span>{format(new Date(log.timestamp), "MMM d, h:mm a")}</span>
                                </div>
                              </td>
                              <td className="py-2 pr-4 font-medium text-foreground whitespace-nowrap">
                                {log.userName || "Unknown"}
                              </td>
                              <td className="py-2 pr-4">
                                <Badge className={`text-xs ${ACTION_TYPE_COLORS[log.actionType] || "bg-muted text-foreground"}`}>
                                  {ACTION_TYPE_LABELS[log.actionType] || log.actionType}
                                </Badge>
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground max-w-[200px] truncate">
                                {log.route ? getRouteName(log.route) : "—"}
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground max-w-[250px] truncate">
                                {log.actionDetail || "—"}
                              </td>
                              <td className="py-2 text-muted-foreground">
                                {log.duration ? formatDuration(log.duration) : "—"}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-muted/30" data-testid={`row-activity-details-${log.id}`}>
                                <td colSpan={colSpan} className="py-3 px-4">
                                  {isRecovery ? (
                                    recoveryDetail ? (
                                      <div className="space-y-2 text-xs" data-testid={`block-recovery-detail-${log.id}`}>
                                        <div className="font-semibold text-muted-foreground">
                                          {log.actionType === "front_recovery_jobs_cleared" ? "Recovery jobs cleared" : "Recovery job deleted"}
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                          <div className="bg-card border border-border rounded px-3 py-2">
                                            <div className="text-muted-foreground">{recoveryDetail.primaryLabel}</div>
                                            <div className="text-foreground font-medium break-all" data-testid={`text-recovery-primary-${log.id}`}>
                                              {recoveryDetail.primaryValue}
                                            </div>
                                          </div>
                                          {recoveryDetail.jobStatus && (
                                            <div className="bg-card border border-border rounded px-3 py-2">
                                              <div className="text-muted-foreground">Job status</div>
                                              <div className="text-foreground font-medium" data-testid={`text-recovery-status-${log.id}`}>{recoveryDetail.jobStatus}</div>
                                            </div>
                                          )}
                                          {recoveryDetail.startedAt && (
                                            <div className="bg-card border border-border rounded px-3 py-2">
                                              <div className="text-muted-foreground">Job started at</div>
                                              <div className="text-foreground font-medium" data-testid={`text-recovery-started-${log.id}`}>
                                                {format(new Date(recoveryDetail.startedAt), "MMM d, yyyy h:mm a")}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                        {recoveryDetail.jobIds.length > 1 && (
                                          <div className="bg-card border border-border rounded px-3 py-2">
                                            <div className="text-muted-foreground mb-1">Deleted job IDs ({recoveryDetail.jobIds.length})</div>
                                            <div className="flex flex-wrap gap-1" data-testid={`list-recovery-deleted-${log.id}`}>
                                              {recoveryDetail.jobIds.map((id) => (
                                                <code key={id} className="bg-muted text-foreground rounded px-1.5 py-0.5 text-xs">{id}</code>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                        {recoveryDetail.skippedJobIds.length > 0 && (
                                          <div className="bg-card border border-border rounded px-3 py-2">
                                            <div className="text-muted-foreground mb-1">Skipped job IDs ({recoveryDetail.skippedJobIds.length}) — still running</div>
                                            <div className="flex flex-wrap gap-1" data-testid={`list-recovery-skipped-${log.id}`}>
                                              {recoveryDetail.skippedJobIds.map((id) => (
                                                <code key={id} className="bg-amber-50 text-amber-800 rounded px-1.5 py-0.5 text-xs">{id}</code>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-muted-foreground" data-testid={`text-no-recovery-details-${log.id}`}>
                                        No detailed metadata was recorded for this entry.
                                      </div>
                                    )
                                  ) : isGenericMetadata ? (
                                    <div className="overflow-x-auto" data-testid={`block-metadata-detail-${log.id}`}>
                                      <div className="text-xs font-semibold text-muted-foreground mb-2">
                                        Entry details
                                      </div>
                                      <table className="w-full text-xs border border-border bg-card rounded">
                                        <thead className="bg-muted text-muted-foreground">
                                          <tr>
                                            <th className="text-left py-1.5 px-3 font-medium w-1/3">Field</th>
                                            <th className="text-left py-1.5 px-3 font-medium">Value</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {metadataEntries.map((entry) => (
                                            <tr
                                              key={entry.key}
                                              className="border-t border-border align-top"
                                              data-testid={`row-metadata-${log.id}-${entry.key}`}
                                            >
                                              <td className="py-1.5 px-3 text-foreground" data-testid={`text-metadata-key-${log.id}-${entry.key}`}>
                                                {formatMetadataKey(entry.key)}
                                              </td>
                                              <td className="py-1.5 px-3 text-foreground" data-testid={`text-metadata-value-${log.id}-${entry.key}`}>
                                                {entry.multiline ? (
                                                  <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground m-0">{entry.value}</pre>
                                                ) : (
                                                  <span className="break-all">{entry.value}</span>
                                                )}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : changeRows.length === 0 ? (
                                    <div className="text-xs text-muted-foreground" data-testid={`text-no-change-details-${log.id}`}>
                                      No detailed change data was recorded for this entry.
                                    </div>
                                  ) : diffConfig ? (
                                    <div className="overflow-x-auto">
                                      <div className="text-xs font-semibold text-muted-foreground mb-2" data-testid={`text-diff-title-${log.id}`}>
                                        {diffConfig.title}
                                      </div>
                                      <table className="w-full text-xs border border-border bg-card rounded">
                                        <thead className="bg-muted text-muted-foreground">
                                          <tr>
                                            <th className="text-left py-1.5 px-3 font-medium">{diffConfig.keyHeader}</th>
                                            <th className="text-right py-1.5 px-3 font-medium">Old</th>
                                            <th className="text-right py-1.5 px-3 font-medium">New</th>
                                            <th className="text-right py-1.5 px-3 font-medium">Delta</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {changeRows.map((row) => {
                                            const changed = row.oldValue !== row.newValue;
                                            const deltaColor = row.delta === null || row.delta === 0
                                              ? "text-muted-foreground"
                                              : row.delta > 0
                                                ? "text-emerald-700"
                                                : "text-rose-700";
                                            return (
                                              <tr
                                                key={row.key}
                                                className={`border-t border-border ${changed ? "bg-amber-50/40" : ""}`}
                                                data-testid={`row-diff-change-${log.id}-${row.key}`}
                                              >
                                                <td className="py-1.5 px-3 text-foreground" data-testid={`text-diff-key-${log.id}-${row.key}`}>
                                                  {diffConfig.formatKey(row.key)}
                                                </td>
                                                <td className="py-1.5 px-3 text-right text-muted-foreground tabular-nums" data-testid={`text-diff-old-${log.id}-${row.key}`}>
                                                  {diffConfig.formatValue(row.oldValue)}
                                                </td>
                                                <td className="py-1.5 px-3 text-right text-foreground font-medium tabular-nums" data-testid={`text-diff-new-${log.id}-${row.key}`}>
                                                  {diffConfig.formatValue(row.newValue)}
                                                </td>
                                                <td className={`py-1.5 px-3 text-right tabular-nums ${deltaColor}`} data-testid={`text-diff-delta-${log.id}-${row.key}`}>
                                                  {formatDelta(row.delta)}
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : null}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
                  <span>{totalLogs} total events</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span>Page {page + 1} of {Math.max(1, totalPages)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => p + 1)}
                      disabled={page >= totalPages - 1}
                      data-testid="button-next-page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog
        open={compareDialogOpen}
        onOpenChange={(open) => {
          setCompareDialogOpen(open);
          if (!open) setHideUnchangedRows(false);
        }}
      >
        <DialogContent
          className={multiStepEntries.length > 0 ? "max-w-6xl" : "max-w-4xl"}
          data-testid="dialog-compare"
        >
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {sameTypeComparison && comparisonConfig
                ? comparisonConfig.title
                : multiStepEntries.length > 0 && multiStepConfig
                  ? multiStepConfig.title
                  : "Compare entries"}
            </DialogTitle>
            <DialogDescription>
              {sameTypeComparison
                ? "Side-by-side view of the configuration values recorded in each entry."
                : multiStepEntries.length > 0
                  ? `Chronological progression across ${multiStepEntries.length} entries, with deltas calculated step-to-step.`
                  : multiSectionEntries.length >= 2
                    ? `Each of the ${multiSectionEntries.length} selected entries is shown in its own diff card, ordered earliest to latest.`
                    : "Each entry is shown in its own diff section because they're different action types."}
            </DialogDescription>
            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="toggle-hide-unchanged"
                  checked={hideUnchangedRows}
                  onCheckedChange={setHideUnchangedRows}
                  data-testid="switch-hide-unchanged"
                />
                <Label htmlFor="toggle-hide-unchanged" className="text-xs text-foreground cursor-pointer">
                  Hide unchanged rows
                </Label>
              </div>
              <div className="flex items-center gap-2">
                {multiStepEntries.length > 0 && multiStepRows.length > 0 && multiStepConfig && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadMultiStepCsv}
                    data-testid="button-download-compare-csv"
                  >
                    <Download className="w-4 h-4 mr-1" />
                    Download CSV
                  </Button>
                )}
                {compareLinkSummary && (
                  <span
                    className="hidden md:inline text-xs italic text-muted-foreground max-w-[320px] truncate"
                    title={compareLinkSummary}
                    data-testid="text-compare-link-preview-dialog"
                  >
                    “{compareLinkSummary}”
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyCompareLink}
                  data-testid="button-copy-compare-link-dialog"
                >
                  <Link2 className="w-4 h-4 mr-1" />
                  Copy link
                </Button>
              </div>
            </div>
          </DialogHeader>
          {sortedComparePair && sameTypeComparison && comparisonConfig ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-border bg-muted/50 px-3 py-2" data-testid="text-compare-before-summary">
                  <div className="text-muted-foreground uppercase tracking-wide mb-1">Before</div>
                  <div className="text-foreground font-medium">
                    {format(new Date(sortedComparePair.before.timestamp), "MMM d, yyyy h:mm a")}
                  </div>
                  <div className="text-muted-foreground">
                    {sortedComparePair.before.userName || "Unknown"}
                  </div>
                </div>
                <div className="rounded border border-border bg-muted/50 px-3 py-2" data-testid="text-compare-after-summary">
                  <div className="text-muted-foreground uppercase tracking-wide mb-1">After</div>
                  <div className="text-foreground font-medium">
                    {format(new Date(sortedComparePair.after.timestamp), "MMM d, yyyy h:mm a")}
                  </div>
                  <div className="text-muted-foreground">
                    {sortedComparePair.after.userName || "Unknown"}
                  </div>
                </div>
              </div>
              {(() => {
                const visibleRows = hideUnchangedRows
                  ? comparisonRows.filter((row) => row.oldValue !== row.newValue)
                  : comparisonRows;
                if (comparisonRows.length === 0) {
                  return (
                    <div className="text-sm text-muted-foreground" data-testid="text-compare-no-rows">
                      No comparable values were recorded for these entries.
                    </div>
                  );
                }
                if (visibleRows.length === 0) {
                  return (
                    <div className="text-sm text-muted-foreground" data-testid="text-compare-no-changed-rows">
                      All recorded values are identical between these entries.
                    </div>
                  );
                }
                return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border border-border bg-card rounded">
                    <thead className="bg-muted text-muted-foreground">
                      <tr>
                        <th className="text-left py-1.5 px-3 font-medium">{comparisonConfig.keyHeader}</th>
                        <th className="text-right py-1.5 px-3 font-medium">Before</th>
                        <th className="text-right py-1.5 px-3 font-medium">After</th>
                        <th className="text-right py-1.5 px-3 font-medium">Delta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => {
                        const changed = row.oldValue !== row.newValue;
                        const formattedOld = comparisonConfig.formatValue(row.oldValue);
                        const formattedNew = comparisonConfig.formatValue(row.newValue);
                        const longChange = changed && isLongStringChange(formattedOld, formattedNew);
                        const deltaColor = row.delta === null || row.delta === 0
                          ? "text-muted-foreground"
                          : row.delta > 0
                            ? "text-emerald-700"
                            : "text-rose-700";
                        if (longChange) {
                          return (
                            <tr
                              key={row.key}
                              className="border-t border-border bg-amber-50/40"
                              data-testid={`row-compare-${row.key}`}
                            >
                              <td className="py-1.5 px-3 text-foreground align-top" data-testid={`text-compare-key-${row.key}`}>
                                {comparisonConfig.formatKey(row.key)}
                              </td>
                              <td
                                colSpan={3}
                                className="py-1.5 px-3 text-left text-xs leading-relaxed"
                                data-testid={`text-compare-inline-diff-${row.key}`}
                              >
                                <InlineWordDiff oldText={formattedOld} newText={formattedNew} />
                              </td>
                            </tr>
                          );
                        }
                        return (
                          <tr
                            key={row.key}
                            className={`border-t border-border ${changed ? "bg-amber-50/40" : ""}`}
                            data-testid={`row-compare-${row.key}`}
                          >
                            <td className="py-1.5 px-3 text-foreground" data-testid={`text-compare-key-${row.key}`}>
                              {comparisonConfig.formatKey(row.key)}
                            </td>
                            <td
                              className={`py-1.5 px-3 text-right tabular-nums ${changed ? "text-rose-700 line-through decoration-rose-500/70" : "text-muted-foreground"}`}
                              data-testid={`text-compare-before-${row.key}`}
                            >
                              {formattedOld}
                            </td>
                            <td
                              className={`py-1.5 px-3 text-right tabular-nums font-medium ${changed ? "bg-emerald-100 text-emerald-900" : "text-foreground"}`}
                              data-testid={`text-compare-after-${row.key}`}
                            >
                              {formattedNew}
                            </td>
                            <td className={`py-1.5 px-3 text-right tabular-nums ${deltaColor}`} data-testid={`text-compare-delta-${row.key}`}>
                              {formatDelta(row.delta)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                );
              })()}
            </div>
          ) : multiStepEntries.length > 0 && multiStepConfig ? (
            <div className="space-y-4">
              <div
                className="grid gap-2 text-xs"
                style={{ gridTemplateColumns: `repeat(${multiStepEntries.length}, minmax(0, 1fr))` }}
              >
                {multiStepEntries.map((entry, idx) => (
                  <div
                    key={entry.id}
                    className="rounded border border-border bg-muted/50 px-3 py-2"
                    data-testid={`text-compare-step-summary-${idx + 1}`}
                  >
                    <div className="text-muted-foreground uppercase tracking-wide mb-1">
                      Step {idx + 1} of {multiStepEntries.length}
                    </div>
                    <div className="text-foreground font-medium">
                      {format(new Date(entry.timestamp), "MMM d, yyyy h:mm a")}
                    </div>
                    <div className="text-muted-foreground">{entry.userName || "Unknown"}</div>
                  </div>
                ))}
              </div>
              {multiStepRows.length === 0 ? (
                <div className="text-sm text-muted-foreground" data-testid="text-compare-step-no-rows">
                  No comparable values were recorded for these entries.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border border-border bg-card rounded">
                    <thead className="bg-muted text-muted-foreground">
                      <tr>
                        <th className="text-left py-1.5 px-3 font-medium sticky left-0 bg-muted">
                          {multiStepConfig.keyHeader}
                        </th>
                        <th
                          className="text-left py-1.5 px-2 font-medium text-muted-foreground"
                          data-testid="text-compare-step-head-trend"
                        >
                          Trend
                        </th>
                        {multiStepEntries.map((_, idx) => (
                          <Fragment key={`head-${idx}`}>
                            {idx > 0 && (
                              <th
                                className="text-right py-1.5 px-2 font-medium text-muted-foreground"
                                data-testid={`text-compare-step-head-delta-${idx}`}
                              >
                                Δ
                              </th>
                            )}
                            <th
                              className="text-right py-1.5 px-3 font-medium"
                              data-testid={`text-compare-step-head-${idx + 1}`}
                            >
                              Step {idx + 1}
                            </th>
                          </Fragment>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(hideUnchangedRows
                        ? multiStepRows.filter((r) => r.cells.some((c) => c.differsFromPrevious))
                        : multiStepRows
                      ).map((row) => {
                        const anyDiffersFromPrev = row.cells.some((c) => c.differsFromPrevious);
                        const trendValues: (number | null)[] = row.cells.map((c) =>
                          typeof c.newValue === "number" && Number.isFinite(c.newValue)
                            ? c.newValue
                            : null,
                        );
                        const numericCount = trendValues.filter((v) => v !== null).length;
                        return (
                          <tr
                            key={row.key}
                            className={`border-t border-border ${anyDiffersFromPrev ? "bg-amber-50/40" : ""}`}
                            data-testid={`row-compare-step-${row.key}`}
                          >
                            <td
                              className="py-1.5 px-3 text-foreground sticky left-0 bg-inherit"
                              data-testid={`text-compare-step-key-${row.key}`}
                            >
                              {multiStepConfig.formatKey(row.key)}
                            </td>
                            <td
                              className="py-1.5 px-2 text-left"
                              data-testid={`cell-compare-step-trend-${row.key}`}
                            >
                              {numericCount >= 2 ? (
                                <MiniSparkline
                                  values={trendValues}
                                  testId={`sparkline-compare-step-${row.key}`}
                                  labels={multiStepEntries.map((entry) =>
                                    format(new Date(entry.timestamp), "MMM d, yyyy h:mm a"),
                                  )}
                                />
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            {row.cells.map((cell, idx) => {
                              const stepDeltaColor =
                                cell.stepDelta === null || cell.stepDelta === 0
                                  ? "text-muted-foreground"
                                  : cell.stepDelta > 0
                                    ? "text-emerald-700"
                                    : "text-rose-700";
                              return (
                                <Fragment key={`cell-${row.key}-${idx}`}>
                                  {idx > 0 && (
                                    <td
                                      className={`py-1.5 px-2 text-right tabular-nums ${stepDeltaColor}`}
                                      data-testid={`text-compare-step-delta-${row.key}-${idx}`}
                                    >
                                      {formatDelta(cell.stepDelta)}
                                    </td>
                                  )}
                                  {(() => {
                                    const formattedOld = multiStepConfig.formatValue(cell.oldValue);
                                    const formattedNew = multiStepConfig.formatValue(cell.newValue);
                                    const longChange =
                                      cell.changed && isLongStringChange(formattedOld, formattedNew);
                                    const stepEntry = multiStepEntries[idx];
                                    const cellClickable = cell.differsFromPrevious && !!stepEntry;
                                    return (
                                      <td
                                        className={`py-1.5 px-3 text-right tabular-nums ${cell.differsFromPrevious ? "bg-amber-100 text-foreground font-semibold ring-1 ring-inset ring-amber-300" : cell.changed ? "text-foreground font-medium" : "text-muted-foreground"} ${cellClickable ? "cursor-pointer hover:bg-amber-200 transition-colors" : ""}`}
                                        data-testid={`text-compare-step-cell-${row.key}-${idx + 1}`}
                                        onClick={
                                          cellClickable
                                            ? () => jumpToActivityEntry(stepEntry.id)
                                            : undefined
                                        }
                                        title={cellClickable ? "Jump to this entry in the activity list" : undefined}
                                        role={cellClickable ? "button" : undefined}
                                        tabIndex={cellClickable ? 0 : undefined}
                                        onKeyDown={
                                          cellClickable
                                            ? (e) => {
                                                if (e.key === "Enter" || e.key === " ") {
                                                  e.preventDefault();
                                                  jumpToActivityEntry(stepEntry.id);
                                                }
                                              }
                                            : undefined
                                        }
                                      >
                                        {cell.changed ? (
                                          longChange ? (
                                            <InlineWordDiff
                                              oldText={formattedOld}
                                              newText={formattedNew}
                                              testId={`text-compare-step-inline-diff-${row.key}-${idx + 1}`}
                                            />
                                          ) : (
                                            <span>
                                              <span className="text-rose-700 line-through decoration-rose-500/70">
                                                {formattedOld}
                                              </span>
                                              <span className="text-muted-foreground mx-1">→</span>
                                              <span className="bg-emerald-100 text-emerald-900 font-semibold rounded px-1">
                                                {formattedNew}
                                              </span>
                                            </span>
                                          )
                                        ) : (
                                          <span>{formattedNew}</span>
                                        )}
                                      </td>
                                    );
                                  })()}
                                </Fragment>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {multiStepSections.length >= 3 && (
                <div className="space-y-3" data-testid="block-compare-step-cards">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Per-entry diffs
                  </div>
                  <div
                    className={`grid grid-cols-1 gap-4 ${
                      multiStepSections.length === 3
                        ? "md:grid-cols-2 lg:grid-cols-3"
                        : multiStepSections.length === 4
                          ? "md:grid-cols-2 lg:grid-cols-4"
                          : "md:grid-cols-2 lg:grid-cols-5"
                    }`}
                  >
                    {multiStepSections.map(({ position, index, total, entry, config, rows }) => {
                      const visibleRows = hideUnchangedRows
                        ? rows.filter((row) => row.oldValue !== row.newValue)
                        : rows;
                      return (
                        <div
                          key={position}
                          className="rounded border border-border bg-card p-3 space-y-3"
                          data-testid={`section-compare-${position}`}
                        >
                          <div className="rounded border border-border bg-muted/50 px-3 py-2 text-xs" data-testid={`text-compare-${position}-summary`}>
                            <div className="text-muted-foreground uppercase tracking-wide mb-1">
                              Step {index + 1} of {total}
                            </div>
                            <div className="text-foreground font-medium">
                              {format(new Date(entry.timestamp), "MMM d, yyyy h:mm a")}
                            </div>
                            <div className="text-muted-foreground">
                              {entry.userName || "Unknown"}
                            </div>
                          </div>
                          {config ? (
                            <div className="overflow-x-auto">
                              <div className="text-xs font-semibold text-muted-foreground mb-2" data-testid={`text-compare-section-title-${position}`}>
                                {config.title}
                              </div>
                              {rows.length === 0 ? (
                                <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-empty-${position}`}>
                                  No detailed change data was recorded for this entry.
                                </div>
                              ) : visibleRows.length === 0 ? (
                                <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-no-changed-${position}`}>
                                  All recorded values are unchanged for this entry.
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                <table className="w-full text-xs border border-border bg-card rounded min-w-[480px]">
                                  <thead className="bg-muted text-muted-foreground">
                                    <tr>
                                      <th className="text-left py-1.5 px-3 font-medium">{config.keyHeader}</th>
                                      <th className="text-right py-1.5 px-3 font-medium">Old</th>
                                      <th className="text-right py-1.5 px-3 font-medium">New</th>
                                      <th className="text-right py-1.5 px-3 font-medium">Delta</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {visibleRows.map((row) => {
                                      const changed = row.oldValue !== row.newValue;
                                      const deltaColor = row.delta === null || row.delta === 0
                                        ? "text-muted-foreground"
                                        : row.delta > 0
                                          ? "text-emerald-700"
                                          : "text-rose-700";
                                      return (
                                        <tr
                                          key={row.key}
                                          className={`border-t border-border ${changed ? "bg-amber-50/40" : ""}`}
                                          data-testid={`row-compare-section-${position}-${row.key}`}
                                        >
                                          <td className="py-1.5 px-3 text-foreground" data-testid={`text-compare-section-key-${position}-${row.key}`}>
                                            {config.formatKey(row.key)}
                                          </td>
                                          <td className="py-1.5 px-3 text-right text-muted-foreground tabular-nums" data-testid={`text-compare-section-old-${position}-${row.key}`}>
                                            {config.formatValue(row.oldValue)}
                                          </td>
                                          <td className="py-1.5 px-3 text-right text-foreground font-medium tabular-nums" data-testid={`text-compare-section-new-${position}-${row.key}`}>
                                            {config.formatValue(row.newValue)}
                                          </td>
                                          <td className={`py-1.5 px-3 text-right tabular-nums ${deltaColor}`} data-testid={`text-compare-section-delta-${position}-${row.key}`}>
                                            {formatDelta(row.delta)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-no-config-${position}`}>
                              No diff formatter is registered for this action type.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : multiSectionEntries.length >= 2 ? (
            <div className="space-y-4">
              <div
                className={`grid grid-cols-1 gap-4 ${
                  multiSectionEntries.length === 2
                    ? "md:grid-cols-2"
                    : multiSectionEntries.length === 3
                      ? "md:grid-cols-2 lg:grid-cols-3"
                      : "md:grid-cols-2 lg:grid-cols-4"
                }`}
              >
                {multiSectionEntries.map(({ position, index, total, entry, config, rows }) => {
                  const visibleRows = hideUnchangedRows
                    ? rows.filter((row) => row.oldValue !== row.newValue)
                    : rows;
                  return (
                  <div
                    key={position}
                    className="rounded border border-border bg-card p-3 space-y-3"
                    data-testid={`section-compare-${position}`}
                  >
                    <div className="rounded border border-border bg-muted/50 px-3 py-2 text-xs" data-testid={`text-compare-${position}-summary`}>
                      <div className="text-muted-foreground uppercase tracking-wide mb-1">
                        {total === 2
                          ? index === 0
                            ? "Earlier"
                            : "Later"
                          : `Entry ${index + 1} of ${total}`}
                      </div>
                      <div className="text-foreground font-medium">
                        {format(new Date(entry.timestamp), "MMM d, yyyy h:mm a")}
                      </div>
                      <div className="text-muted-foreground">
                        {entry.userName || "Unknown"}
                      </div>
                      <div className="mt-1">
                        <Badge className={`text-xs ${ACTION_TYPE_COLORS[entry.actionType] || "bg-muted text-foreground"}`}>
                          {ACTION_TYPE_LABELS[entry.actionType] || entry.actionType}
                        </Badge>
                      </div>
                    </div>
                    {config ? (
                      <div className="overflow-x-auto">
                        <div className="text-xs font-semibold text-muted-foreground mb-2" data-testid={`text-compare-section-title-${position}`}>
                          {config.title}
                        </div>
                        {rows.length === 0 ? (
                          <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-empty-${position}`}>
                            No detailed change data was recorded for this entry.
                          </div>
                        ) : visibleRows.length === 0 ? (
                          <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-no-changed-${position}`}>
                            All recorded values are unchanged for this entry.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                          <table className="w-full text-xs border border-border bg-card rounded min-w-[520px]">
                            <thead className="bg-muted text-muted-foreground">
                              <tr>
                                <th className="text-left py-1.5 px-3 font-medium">{config.keyHeader}</th>
                                <th className="text-right py-1.5 px-3 font-medium">Old</th>
                                <th className="text-right py-1.5 px-3 font-medium">New</th>
                                <th className="text-right py-1.5 px-3 font-medium">Delta</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleRows.map((row) => {
                                const changed = row.oldValue !== row.newValue;
                                const formattedOld = config.formatValue(row.oldValue);
                                const formattedNew = config.formatValue(row.newValue);
                                const longChange = changed && isLongStringChange(formattedOld, formattedNew);
                                const deltaColor = row.delta === null || row.delta === 0
                                  ? "text-muted-foreground"
                                  : row.delta > 0
                                    ? "text-emerald-700"
                                    : "text-rose-700";
                                if (longChange) {
                                  return (
                                    <tr
                                      key={row.key}
                                      className="border-t border-border bg-amber-50/40"
                                      data-testid={`row-compare-section-${position}-${row.key}`}
                                    >
                                      <td className="py-1.5 px-3 text-foreground align-top" data-testid={`text-compare-section-key-${position}-${row.key}`}>
                                        {config.formatKey(row.key)}
                                      </td>
                                      <td
                                        colSpan={3}
                                        className="py-1.5 px-3 text-left text-xs leading-relaxed"
                                        data-testid={`text-compare-section-inline-diff-${position}-${row.key}`}
                                      >
                                        <InlineWordDiff oldText={formattedOld} newText={formattedNew} />
                                      </td>
                                    </tr>
                                  );
                                }
                                return (
                                  <tr
                                    key={row.key}
                                    className={`border-t border-border ${changed ? "bg-amber-50/40" : ""}`}
                                    data-testid={`row-compare-section-${position}-${row.key}`}
                                  >
                                    <td className="py-1.5 px-3 text-foreground" data-testid={`text-compare-section-key-${position}-${row.key}`}>
                                      {config.formatKey(row.key)}
                                    </td>
                                    <td
                                      className={`py-1.5 px-3 text-right tabular-nums ${changed ? "text-rose-700 line-through decoration-rose-500/70" : "text-muted-foreground"}`}
                                      data-testid={`text-compare-section-old-${position}-${row.key}`}
                                    >
                                      {formattedOld}
                                    </td>
                                    <td
                                      className={`py-1.5 px-3 text-right tabular-nums font-medium ${changed ? "bg-emerald-100 text-emerald-900" : "text-foreground"}`}
                                      data-testid={`text-compare-section-new-${position}-${row.key}`}
                                    >
                                      {formattedNew}
                                    </td>
                                    <td className={`py-1.5 px-3 text-right tabular-nums ${deltaColor}`} data-testid={`text-compare-section-delta-${position}-${row.key}`}>
                                      {formatDelta(row.delta)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground" data-testid={`text-compare-section-no-config-${position}`}>
                        No diff formatter is registered for this action type.
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Select 2–{MAX_COMPARE} entries to compare.</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
