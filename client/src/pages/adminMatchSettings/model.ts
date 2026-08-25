// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { type LastEditedInfo } from "@/components/LastEditedBadge";
import { History } from "lucide-react";

function diffNameLists(
  current: string[],
  next: string[],
): { added: string[]; removed: string[]; unchanged: number } {
  const cur = new Set(current.map((n) => n.toLowerCase()));
  const nxt = new Set(next.map((n) => n.toLowerCase()));
  const added = next.filter((n) => !cur.has(n.toLowerCase()));
  const removed = current.filter((n) => !nxt.has(n.toLowerCase()));
  const unchanged = current.length - removed.length;
  return { added, removed, unchanged };
}

function summarizeNameList(list: string[], max = 8): string {
  if (list.length === 0) return "—";
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} (+${list.length - max} more)`;
}

type ResolutionSourceOfTruth = "persisted" | "env" | "default";
type Scope = "default" | "zoom";

type Descriptor = {
  key: string;
  label: string;
  envName: string;
  codeDefault: number;
  bounds: { min: number; max: number };
  description: string;
};

type ResolvedRow = {
  key: string;
  scope: Scope;
  effectiveValue: number;
  sourceOfTruth: ResolutionSourceOfTruth;
  persistedValue: number | null;
  persistedScope: Scope | null;
  envValue: number | null;
  codeDefault: number;
  bounds: { min: number; max: number };
  label: string;
  description: string;
  envName: string;
  lastEdited: LastEditedInfo;
};

type SettingsResponse = {
  scopes: Scope[];
  keys: string[];
  descriptors: Descriptor[];
  rows: ResolvedRow[];
  envFallbackUsed: boolean;
};

type CommonFirstNamesResponse = {
  effective: string[];
  override: string[] | null;
  defaults: string[];
  isOverridden: boolean;
  lastEdited?: LastEditedInfo;
};

type CommonFirstNamesMutationResponse = CommonFirstNamesResponse & {
  action?: string;
  auditId?: string | null;
};

type AlertDeliveryStatus = "delivered" | "skipped" | "failed";

type HistoryRow = {
  id: string;
  source: Scope;
  settingKey: string;
  oldValue: number | null;
  newValue: number | null;
  changedBy: string | null;
  changedAt: string;
  changedByUser: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  slackStatus: AlertDeliveryStatus | null;
  emailStatus: AlertDeliveryStatus | null;
  slackFailureReason: string | null;
  emailFailureReason: string | null;
  restoreFromHistoryId?: string | null;
  restoreFromChangedAt?: string | null;
  lastResendAt?: string | null;
  lastResendBy?: string | null;
  lastResendSource?: string | null;
  lastResendByUser?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  slackAttemptCount?: number | null;
  emailAttemptCount?: number | null;
  lastAutoRetryAt?: string | null;
};

type HistoryResponse = {
  rows: HistoryRow[];
  channels?: { slackConfigured: boolean; emailConfigured: boolean };
  autoRetry?: { maxAttempts: number };
};

// Fallback if the server response somehow omits autoRetry.maxAttempts. Keep
// in sync with MAX_ATTEMPTS in server/services/matchSettingsAlertAutoRetry.ts.
const DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS = 4;

// Mirrors BACKOFF_MS_BY_ATTEMPT in matchSettingsAlertAutoRetry. attempt#1 ran
// 1 minute after the original send, etc. Used purely to label the next-retry
// hint shown next to a still-retrying failed row.
const ALERT_AUTO_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

type NamesHistoryRow = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  changedAt: string;
  oldValues: { names?: string[]; count?: number } | null;
  newValues: {
    names?: string[];
    count?: number;
    added?: string[];
    removed?: string[];
    action?: string;
    restoreFromAuditId?: string;
    restoreFromChangedAt?: string | null;
  } | null;
  changedByUser: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  slackStatus: AlertDeliveryStatus | null;
  emailStatus: AlertDeliveryStatus | null;
  slackFailureReason: string | null;
  emailFailureReason: string | null;
  lastResendAt?: string | null;
  lastResendBy?: string | null;
  lastResendSource?: string | null;
  lastResendByUser?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
};

type NamesHistoryResponse = {
  rows: NamesHistoryRow[];
  channels?: { slackConfigured: boolean; emailConfigured: boolean };
};

type ImpactWindowStats = {
  total: number;
  claimed: number;
  reviewRequired: number;
  ambiguous: number;
  notClaimed: number;
  corrected: number;
  ambiguityRate: number | null;
  falsePositiveRate: number | null;
};

type KeyImpact = {
  settingKey: string;
  changedAt: string;
  windowMs: number;
  lastChange: { settingKey: string; oldValue: number | null; newValue: number | null };
  after: ImpactWindowStats;
  before: ImpactWindowStats;
};

type ScopeImpact =
  | { hasChange: false; perKey: KeyImpact[] }
  | {
      hasChange: true;
      changedAt: string;
      windowMs: number;
      windowMode: "since-change" | "custom";
      lastChange: { settingKey: string; oldValue: number | null; newValue: number | null };
      after: ImpactWindowStats;
      before: ImpactWindowStats;
      perKey: KeyImpact[];
    };

type ImpactResponse = {
  scopes: Record<Scope, ScopeImpact>;
  requestedWindowMs: number | null;
  bounds: { minWindowMs: number; maxWindowMs: number };
};

type WindowChoice = { id: string; label: string; ms: number | null };
const WINDOW_CHOICES: WindowChoice[] = [
  { id: "since-change", label: "Since change", ms: null },
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "custom", label: "Custom", ms: null },
];

const CUSTOM_WINDOW_MIN_MS = 60 * 60 * 1000;
const CUSTOM_WINDOW_MAX_MS = 90 * 24 * 60 * 60 * 1000;
type CustomWindowUnit = "h" | "d";
const CUSTOM_UNIT_MS: Record<CustomWindowUnit, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function computeCustomWindowMs(value: string, unit: CustomWindowUnit): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.floor(n * CUSTOM_UNIT_MS[unit]);
  if (ms < CUSTOM_WINDOW_MIN_MS || ms > CUSTOM_WINDOW_MAX_MS) return null;
  return ms;
}

type GuardrailWarningCode = "short_token_len_too_small";

type GuardrailWarning = {
  code: GuardrailWarningCode;
  message: string;
  involvedKeys: string[];
  effectiveScope?: Scope;
};

const ZOOM_GUARDRAIL_KEYS = [
  "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
  "ZOOM_SHORT_TOKEN_MAX_LEN",
] as const;

const GUARDRAIL_KEY_TO_REASONS: Record<string, string[]> = {
  ZOOM_STRONG_SIGNAL_MIN_WEIGHT: ["weak_signal_only", "solo_internal_participants"],
  ZOOM_SHORT_TOKEN_MAX_LEN: ["contact_name_only_weak"],
};

const GUARDRAIL_REASON_LABELS: Record<string, string> = {
  weak_signal_only: "Weak signal only",
  contact_name_only_weak: "Contact name only (weak)",
  solo_internal_participants: "Solo internal participants",
};

const GUARDRAIL_IMPACT_WINDOWS: { label: string; value: string }[] = [
  { label: "Last 24h", value: "1" },
  { label: "Last 7d", value: "7" },
  { label: "Last 30d", value: "30" },
  { label: "Last 90d", value: "90" },
  { label: "All time", value: "all" },
];

type GuardrailImpactBucket = { start: string; end: string; count: number };

type GuardrailImpactPerKey = {
  anchor: string | null;
  sampleMs: number;
  after: { total: number; byReason: Record<string, number> } | null;
  before: { total: number; byReason: Record<string, number> } | null;
  dismissAfter?: { total: number; byReason: Record<string, number> } | null;
  dismissBefore?: { total: number; byReason: Record<string, number> } | null;
  bucketCount?: number;
  buckets?: Record<string, GuardrailImpactBucket[]>;
};

type GuardrailImpactResponse = {
  reasonSummary: {
    windowDays: number | null;
    total: number;
    byReason: Record<string, number>;
  };
  previousSummary: {
    total: number;
    byReason: Record<string, number>;
  } | null;
  windowDays: number | null;
  perKey?: Record<string, GuardrailImpactPerKey>;
};

const ZOOM_COMMON_FIRST_NAMES_KEY = "ZOOM_COMMON_FIRST_NAMES";
const ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY = "zoom_common_first_names";

type GuardrailChangeBucket = { start: string; end: string; count: number };

type GuardrailChangeTrendRow = {
  auditId: string;
  changedAt: string;
  routedToReview: {
    anchor: string;
    windowMs: number;
    bucketCount: number;
    buckets: GuardrailChangeBucket[];
    before: number;
    after: number;
    total: number;
    reason: string | null;
  };
  dismissReasons: {
    before: { byReason: Record<string, number>; total: number };
    after: { byReason: Record<string, number>; total: number };
  };
};

type GuardrailChangeTrendsResponse = {
  settingKey: string;
  reason: string | null;
  windowMs: number;
  bucketCount: number;
  rows: GuardrailChangeTrendRow[];
};

const DISMISS_REASON_LABEL: Record<string, string> = {
  not_relevant: "Not relevant",
  duplicate: "Duplicate",
  test_call: "Test/internal",
  other: "Other",
  unspecified: "Unspecified",
};

function dismissReasonLabel(key: string): string {
  return DISMISS_REASON_LABEL[key] ?? key;
}

// Numeric Zoom guardrail keys whose Change History rows are decorated with
// the routed-to-review sparkline + dismiss-reason delta. Exported so the
// MatchSettings "Impact column" UI regression test can mirror the exact
// wiring without duplicating the key list.
export const ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS = [
  "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
  "ZOOM_SHORT_TOKEN_MAX_LEN",
  // Task #1239: keys backed by the generalized trends endpoint —
  // these don't gate a specific Zoom auto-claim review_reason so the
  // sparkline counts all routed-to-review decisions for the
  // configured sourceType (defaults to "zoom").
  "ZOOM_TRANSCRIPT_CONTEXT_BUDGET",
  "ZOOM_SHORTLIST_MAX",
] as const;
export const ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET: ReadonlySet<string> = new Set(
  ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS,
);

export { diffNameLists, summarizeNameList, DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS, ALERT_AUTO_RETRY_BACKOFF_MS, WINDOW_CHOICES, CUSTOM_WINDOW_MIN_MS, CUSTOM_WINDOW_MAX_MS, CUSTOM_UNIT_MS, computeCustomWindowMs, ZOOM_GUARDRAIL_KEYS, GUARDRAIL_KEY_TO_REASONS, GUARDRAIL_REASON_LABELS, GUARDRAIL_IMPACT_WINDOWS, ZOOM_COMMON_FIRST_NAMES_KEY, ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY, DISMISS_REASON_LABEL, dismissReasonLabel, type ResolutionSourceOfTruth, type Scope, type Descriptor, type ResolvedRow, type SettingsResponse, type CommonFirstNamesResponse, type CommonFirstNamesMutationResponse, type AlertDeliveryStatus, type HistoryRow, type HistoryResponse, type NamesHistoryRow, type NamesHistoryResponse, type ImpactWindowStats, type KeyImpact, type ScopeImpact, type ImpactResponse, type WindowChoice, type CustomWindowUnit, type GuardrailWarningCode, type GuardrailWarning, type GuardrailImpactBucket, type GuardrailImpactPerKey, type GuardrailImpactResponse, type GuardrailChangeBucket, type GuardrailChangeTrendRow, type GuardrailChangeTrendsResponse };
