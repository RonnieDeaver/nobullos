import { formatDistanceToNow } from "date-fns";
import type { FilterRule, FilterRuleApplyJobState, FilterRuleScope } from "./types";

export const STALE_RULE_THRESHOLD_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const PIPELINE_REFRESH_INTERVAL_MS = 10000;

export function relativeTime(input: string | number | null | undefined): string {
  if (!input) return "—";
  try {
    const d = typeof input === "number" ? new Date(input) : new Date(input);
    if (Number.isNaN(d.getTime())) return "—";
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function jobStatusColor(status: string): string {
  if (status === "running" || status === "queued") return "bg-blue-50 text-blue-700 border-blue-200";
  if (status === "complete") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "partial") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "failed" || status === "blocked") return "bg-red-50 text-red-700 border-red-200";
  if (status === "empty_source") return "bg-slate-50 text-slate-600 border-slate-200";
  return "bg-gray-50 text-gray-700 border-gray-200";
}

export function normalizeRuleValueClient(scope: FilterRuleScope, raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "";
  if (scope === "sender_email") return v.toLowerCase();
  if (scope === "domain") return v.toLowerCase().replace(/^@/, "");
  if (scope === "channel") return v.toLowerCase().replace(/^#/, "");
  return v;
}

export function ruleIsStale(rule: FilterRule): boolean {
  if (!rule.enabled) return false;
  const now = Date.now();
  const lastActivityIso = rule.lastAppliedAt ?? rule.createdAt;
  const ageDays = (now - new Date(lastActivityIso).getTime()) / MS_PER_DAY;
  if (ageDays < STALE_RULE_THRESHOLD_DAYS) return false;
  if (!rule.lastAppliedAt && rule.affectedCount === 0) return true;
  return !!rule.lastAppliedAt && ageDays >= STALE_RULE_THRESHOLD_DAYS;
}

export function isApplyJobActive(s: FilterRuleApplyJobState): boolean {
  return s.status === "queued" || s.status === "running";
}
