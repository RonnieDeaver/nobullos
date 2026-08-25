export type FrontMessageFeed = {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string | null;
  contentText: string | null;
  contentPreview: string | null;
  timestamp: string;
  direction: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  matchStatus: string | null;
  effectiveMatchStatus: string | null;
  externalUrl: string | null;
  sourceSubtype: string | null;
  aiSummary: string | null;
  createdAt: string;
  rawPayload: Record<string, any> | null;
  participants: Array<{ name?: string; email?: string; role?: string }> | null;
  externalSourceId?: string | null;
  senderEmail: string | null;
  senderName: string | null;
  senderDomain: string | null;
  inboxes: string[];
  eligibleActions: string[];
  review?: {
    decisionId: string;
    reviewReason: string | null;
    explanationSummary: string | null;
    suggestedClientId: string | null;
    suggestedClientName: string | null;
    suggestedConfidence: number | null;
    priorClientId: string | null;
    priorClientName: string | null;
    candidates: Array<{
      clientId: string | null;
      clientName: string | null;
      confidenceScore: number | null;
      evidenceType: string | null;
      explanationSummary: string | null;
    }>;
  } | null;
  resolved?: {
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
  } | null;
};

export type MessageStats = { total: number; matched: number; unmatched: number; matchRate: number };

export type MessageFeedResponse = {
  messages: FrontMessageFeed[];
  filteredStats: MessageStats;
  globalStats: MessageStats;
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export type FrontInbox = {
  id: string;
  name: string;
  type?: string;
  send_as?: string;
  address?: string;
};

export type ClientLite = {
  id: string;
  firmName?: string | null;
  name?: string | null;
};

export type RowActionKind = "assign" | "dismiss" | "block" | "promote";

export const DEFAULT_FILTERS = {
  search: "",
  senderEmail: "",
  senderDomain: "",
  inbox: "all",
  client: "all",
  match: "all",
  dateFrom: "",
  dateTo: "",
};

export type FilterState = typeof DEFAULT_FILTERS;

export type ConsoleJob = {
  id: string;
  type: "historical_recovery" | "rematch_all" | "reprocess_dismissed" | "bulk_action" | "full_backfill_legacy";
  typeLabel: string;
  durability: "durable" | "ephemeral";
  canonical: boolean;
  deprecated: boolean;
  status: string;
  statusReason: string | null;
  progress: Record<string, number | string | null> | null;
  startedAt: string | null;
  startedBy: string | null;
  lastUpdateAt: string | null;
  lastError: string | null;
  itemErrors?: Array<{ rawCommId: string; error: string }>;
  finalSummary?: string | null;
  windows?: Array<{
    label: string;
    status: string;
    statusReason: string | null;
    scanned: number;
    ingested: number;
    skipped: number;
    pages: number;
    errorCount: number;
    firstError: string | null;
  }>;
};

export type ConsoleOverview = {
  connection: {
    connected: boolean;
    error: string | null;
    lastSyncError: string | null;
    lastSyncSuccess: string | null;
  };
  syncProgress: {
    isRunning: boolean;
    currentPage: number;
    conversationsScanned: number;
    conversationsKept: number;
    conversationsFiltered: number;
    startedAt: string | null;
  };
  lastCycle: {
    matched: number;
    unmatched: number;
    skipped: number;
    total: number;
    completedAt: string;
  } | null;
  messages: {
    // Raw imported population (raw_communication_records, incl. per-version dupes).
    rawImportedTotal: number;
    rawMatched: number;
    rawUnmatched: number;
    // Tracked emails (front_sync_emails, de-duplicated per Front thread).
    trackedTotal: number;
    // Canonical matchable figures — reconcile with the Hard-match panel (Bug A).
    matched: number;
    unmatched: number;
    matchable: number;
    matchRate: number;
  };
  pipeline: {
    backlogs: Record<string, number>;
    // Task #2502 (Bug B) — real backlog (non-terminal + failed) and the
    // terminal-done count, computed server-side from the shared definitions.
    backlogCount: number;
    appliedDoneCount: number;
    cursorAgeSeconds: number | null;
    pageTokenActive: boolean;
    lastCursorAdvanceAt: number | null;
    health: {
      oldestUnprocessedAgeSeconds: number | null;
      avgDiscoveryToApplyMs: number | null;
      hydrateRetryCount: number;
      failedCount: number;
      deadLetteredCount: number;
    };
    versionNoopsLast1h: number;
    collectedAt: number;
  } | null;
  jobs: ConsoleJob[];
  canonicalRecoveryEndpoint: string;
  generatedAt: string;
};

export type BulkAction = "assign" | "dismiss" | "block_sender" | "block_domain" | "not_a_match";

export type BulkPreview = {
  action: BulkAction;
  selectionMode: "ids" | "query";
  totalSelected: number;
  eligibleCount: number;
  ineligibleCount: number;
  ineligibleReasons: Record<string, number>;
  distinctSenders: number;
  distinctDomains: number;
  uniqueSender: string | null;
  uniqueDomain: string | null;
  cap: number;
  willRunAsBackgroundJob: boolean;
  warnings: string[];
  errors: string[];
  sampleIds: string[];
};

export type BulkSelection =
  | { mode: "ids"; messageIds: string[] }
  | { mode: "query"; query: Record<string, string> };

export const BULK_ACTION_LABELS: Record<BulkAction, string> = {
  assign: "Assign to client",
  dismiss: "Dismiss with reason",
  block_sender: "Block sender",
  block_domain: "Block domain",
  not_a_match: "Mark as not a match",
};

export type CanonicalAction = "rematch_all" | "reprocess_dismissed";

export type FilterRuleType = "block" | "dismiss" | "never_match";
export type FilterRuleScope = "sender_email" | "domain" | "channel";

export type FilterRule = {
  id: string;
  type: FilterRuleType;
  scope: FilterRuleScope;
  value: string;
  enabled: boolean;
  notes: string | null;
  affectedCount: number;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

export const RULE_TYPE_LABELS: Record<FilterRuleType, string> = {
  block: "Block",
  dismiss: "Dismiss",
  never_match: "Never match",
};

export const RULE_TYPE_BADGE: Record<FilterRuleType, string> = {
  block: "bg-red-100 text-red-700 border-red-200",
  dismiss: "bg-orange-100 text-orange-700 border-orange-200",
  never_match: "bg-gray-100 text-gray-700 border-gray-200",
};

export const RULE_SCOPE_LABELS: Record<FilterRuleScope, string> = {
  sender_email: "Sender email",
  domain: "Domain",
  channel: "Channel (inbox)",
};

export type FilterRuleHit = {
  id: string;
  ruleId: string;
  source: string;
  syncEmailId: string | null;
  conversationId: string | null;
  senderEmail: string | null;
  subject: string | null;
  ruleType: string | null;
  createdAt: string;
};

export type FilterRuleApplyJobState = {
  jobId: string;
  ruleId: string;
  status: "queued" | "running" | "complete" | "partial" | "failed";
  startedAt: number;
  updatedAt: number;
  totalSelected: number;
  totalProcessed: number;
  succeeded: number;
  failed: number;
  childBulkJobId: string | null;
  finalSummary: string | null;
  startedBy: string;
};

export type FilterRuleAuditEntry = {
  id: string;
  actionType: string;
  actionDetail: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  userId: string | null;
  userName: string | null;
};

export const APPLY_AUDIT_LABELS: Record<string, { label: string; tone: string }> = {
  front_filter_rule_apply_started: { label: "Started", tone: "bg-blue-50 text-blue-700 border-blue-200" },
  front_filter_rule_apply_delegated: { label: "Delegated to bulk worker", tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  front_filter_rule_apply_completed: { label: "Completed", tone: "bg-green-50 text-green-700 border-green-200" },
  front_filter_rule_apply_failed: { label: "Failed", tone: "bg-red-50 text-red-700 border-red-200" },
};

export type PipelineMetrics = {
  backlogs: Record<string, number>;
  throughput: Record<string, { total: number; last1h: number; last5m: number }>;
  cursorFreshness: {
    currentCursorTimestamp: number | null;
    cursorAgeSeconds: number | null;
    pageTokenActive: boolean;
    lastCursorAdvanceAt: number | null;
  };
  duplicatePrevention: {
    versionNoops: number;
    versionNoopsLast1h: number;
  };
  cursorIndependence: {
    cursorAdvancesWithoutProcessing: number;
    lastIndependentAdvanceAt: number | null;
  };
  health: {
    oldestUnprocessedAgeSeconds: number | null;
    avgDiscoveryToApplyMs: number | null;
    hydrateRetryCount: number;
    failedCount: number;
    deadLetteredCount: number;
  };
  collectedAt: number;
};
