import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ArrowLeft, Mail, MessageSquare, Video, CheckCircle, RefreshCw, Plug, Unplug, ArrowRight, Ban, UserPlus, Loader2, ExternalLink, MapPin, Copy, FileText, ChevronDown, ChevronUp, Sparkles, Filter, RotateCcw, Trash2, CreditCard, Phone, AlertCircle, AlertTriangle, Clock, Inbox, Calendar, XCircle, BarChart3 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { parseGoogleAdsDisconnectedError } from "@shared/googleAdsDisconnect";
import { parseIntegrationStatusUnknownError } from "@shared/integrationStatusUnknown";
import { logActivity } from "@/hooks/use-activity-tracker";
import { InlineLoadingSkeleton, PageSkeleton } from "@/components/ui/skeleton-loaders";
import { useAuth } from "@/hooks/use-auth";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { History } from "lucide-react";
import { BackfillJobsPanel } from "@/components/admin/BackfillJobsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { ProdActionsPanel } from "@/components/admin/ProdActionsPanel";
import { GlobalResetSavedAdminViewsButton } from "@/components/GlobalResetSavedAdminViewsButton";
import { BreakerDetailRow } from "@/components/admin/BreakerDetailRow";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { DegradedState, formatEngagedFor } from "@/components/kit/DegradedState";

type SyncProgress = {
  isRunning: boolean;
  currentPage: number;
  conversationsScanned: number;
  conversationsKept: number;
  conversationsFiltered: number;
  startedAt: string | null;
};

type SyncCycleSummary = {
  matched: number;
  unmatched: number;
  skipped: number;
  total: number;
  completedAt: string;
};

type IntegrationSyncState = {
  progress: SyncProgress;
  lastCycle: SyncCycleSummary | null;
};

// Task #1842: connection / configured fields are nullable. `null` means
// the server has no cached probe result yet (cold start or just-invalidated
// after a connect/disconnect). The client renders "Checking…" for null,
// "Connected" for true, "Not Connected" for false. `lastCheckedAt` is the
// ISO timestamp of the last successful upstream probe (null on cold start).
// Task #2142 — one persisted Front auth-death record (see
// server/services/frontAuthDeathDiagnostics.ts).
type FrontAuthDeathRecord = {
  code: string;
  httpStatus: number | null;
  bodySnippet: string | null;
  environment: string;
  lastSuccessAt: string | null;
  diedAt: string;
  // Task #2435 — set once Front auth recovers after this death (a healed
  // login-race blip). When present the panel renders the entry as recovered
  // instead of a permanent red failure.
  recoveredAt?: string | null;
};

type IntegrationStatus = {
  front: { connected: boolean | null; lastSyncError?: string | null; lastSyncSuccess?: string | null; syncProgress?: IntegrationSyncState; lastCheckedAt?: string | null; lastProbeError?: string | null; disconnectReason?: string | null; breakerOpen?: boolean; cooldownRemainingMs?: number; lastTrippedAt?: string | null; cooldownUntil?: string | null; tripCount?: number; webhookSecretConfigured?: boolean | null; lastEdited?: { token?: LastEditedInfo } };
  slack: { connected: boolean | null; team: string | null; syncProgress?: IntegrationSyncState; lastCheckedAt?: string | null; lastProbeError?: string | null; disconnectReason?: string | null; breakerOpen?: boolean; cooldownRemainingMs?: number; lastTrippedAt?: string | null; cooldownUntil?: string | null; tripCount?: number; lastEdited?: { botToken?: LastEditedInfo } };
  zoom: {
    connected: boolean | null;
    syncProgress?: IntegrationSyncState;
    reconnectRequired?: {
      authGate: { status: number; reason: string; since: number } | null;
      scopeGates: Array<{ scopeKey: string; status: number; reason: string; since: number }>;
    };
    lastCheckedAt?: string | null;
    // Task #1888: outcome-aware probe surfaces (matches Slack/Front).
    disconnectReason?: string | null;
    lastProbeError?: string | null;
    // Task #2254 / #2275 — `cooldownUntil` carries the next self-heal attempt
    // time; `selfHealParked` is true when the loop has stopped and an operator
    // reconnect is required.
    cooldownUntil?: string | null;
    selfHealParked?: boolean;
    lastEdited?: { token?: LastEditedInfo };
  };
  pandadoc: { connected: boolean | null; lastCheckedAt?: string | null; disconnectReason?: string | null; lastProbeError?: string | null; lastEdited?: { apiKey?: LastEditedInfo } };
  ghl?: { connected: boolean | null; lastCheckedAt?: string | null; disconnectReason?: string | null; lastProbeError?: string | null; lastEdited?: { token?: LastEditedInfo } };
  stripe: { connected: boolean | null; lastCheckedAt?: string | null; disconnectReason?: string | null; lastProbeError?: string | null; lastEdited?: { secretKey?: LastEditedInfo } };
  twilio?: { connected: boolean | null; lastCheckedAt?: string | null; disconnectReason?: string | null; lastProbeError?: string | null };
  // Task #4008 — unified single-credential model: every Google Ads surface
  // (Ads Hygiene, Discover Customers, campaign sync, and the Ads OS pulls)
  // mints from the GOOGLE_ADS_* env secret trio, so the whole auth picture
  // is env presence (`configured`) + the shared mint's live auth state (the
  // `adsOs` lane). No stored connection, breaker, or forensics fields.
  googleAds: {
    configured: boolean | null;
    /** configured && credential not terminally rejected; null while the
     * lane summary is unavailable ("Checking…"). */
    connected: boolean | null;
    loginCustomerId?: string | null;
    // Task #4000 — credential lane summary (env presence + this process's
    // cached/negative-cached auth state + store freshness). null = lane
    // build blipped server-side ("Checking…").
    adsOs?: {
      configured: boolean;
      refreshTokenSource: "env" | "none";
      health: "healthy" | "token_rejected" | "unknown" | "not_configured";
      healthDetail: string | null;
      lastDataUpdateAt: string | null;
    } | null;
  };
  semrush?: {
    connected: boolean | null;
    // Task #3670 — v4 API-key mode (OAuth machinery dormant) + last
    // successful key-authenticated call.
    authMode?: "api_key" | "oauth";
    keyModeLastSuccessAt?: string | null;
    // Task #3690 — live key-rejection streak state (null outside key mode).
    keyRejection?: {
      consecutiveRejections: number;
      keyRejected: boolean;
      streakAlertFired: boolean;
      lastRejectionAt: string | null;
      lastRejectionStatus: number | null;
    } | null;
    disconnectReason?: string | null;
    lastProbeError?: string | null;
    breakerOpen?: boolean;
    cooldownRemainingMs?: number;
    lastTrippedAt?: string | null;
    cooldownUntil?: string | null;
    tripCount?: number;
    // Task #2225 — specific terminal trip cause + last successful auth.
    lastTrippedCode?: string | null;
    lastSuccessAt?: string | null;
    // Task #2160 — operator-facing "reconnect required" indicator.
    reconnectRequired?: boolean;
    // Task #3661 — latest durable disconnect-forensics record + keep-alive
    // last-run/last-success heartbeat.
    forensics?: DisconnectForensicsRecord | null;
    keepAliveHeartbeat?: {
      lastRunAt: string;
      lastAction: string;
      lastSuccessAt: string | null;
      lastError: string | null;
    } | null;
  };
  unmatchedCount: number;
};

type GoogleAdsCustomer = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isManager: boolean;
  status: string;
  nobullClientId: string | null;
  syncEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};

type GoogleAdsSyncRun = {
  id: string;
  customerId: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  campaignsSynced: number;
  keywordsSynced: number;
  errorMessage: string | null;
};

type CredentialAuditEntry = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
  oldValues: any;
  newValues: any;
  changedAt: string | Date;
};

// Task #1842: render a three-way connection badge. `null`/`undefined`
// means the server has no cached probe result yet → show neutral
// "Checking…" instead of the misleading "Not Connected".
function ConnectionBadge({
  state,
  connectedLabel = "Connected",
  disconnectedLabel = "Not Connected",
  testId,
}: {
  state: boolean | null | undefined;
  connectedLabel?: string;
  disconnectedLabel?: string;
  testId: string;
}) {
  if (state === true) {
    return <Badge variant="outline" className="ml-auto bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800" data-testid={testId}>{connectedLabel}</Badge>;
  }
  if (state === false) {
    return <Badge variant="outline" className="ml-auto bg-muted/50 text-muted-foreground" data-testid={testId}>{disconnectedLabel}</Badge>;
  }
  return (
    <Badge variant="outline" className="ml-auto bg-muted/50 text-muted-foreground border-border" data-testid={testId}>
      <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Checking…
    </Badge>
  );
}

interface DisconnectForensicsRecord {
  integration: string;
  codePath: string;
  purpose?: string | null;
  providerError?: string | null;
  providerErrorCode?: string | null;
  fingerprintOutcome?: string | null;
  classification?: string | null;
  summary: string;
  operatorAction: string;
  instanceId?: string | null;
  recordedAt?: string;
}
function FrontAuthDeathDetails({
  record,
  testIdPrefix,
}: {
  record: FrontAuthDeathRecord;
  testIdPrefix: string;
}) {
  const diedAt = record.diedAt ? new Date(record.diedAt) : null;
  const lastSuccess = record.lastSuccessAt ? new Date(record.lastSuccessAt) : null;
  // Task #2435 — a recovered death is a healed login-race blip, not a live
  // outage; render it neutrally (with a "recovered" badge) instead of red.
  const recoveredAt = record.recoveredAt ? new Date(record.recoveredAt) : null;
  const recovered = recoveredAt != null;
  const tsClass = recovered ? "font-medium text-foreground" : "font-medium text-red-700 dark:text-red-400";
  const codeClass = recovered ? "text-foreground" : "text-red-700 dark:text-red-400";
  return (
    <div className="text-caption text-muted-foreground space-y-0.5" data-testid={`text-${testIdPrefix}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {diedAt && (
          <span className={tsClass} data-testid={`text-${testIdPrefix}-died-at`} title={diedAt.toLocaleString()}>
            {diedAt.toLocaleString()}
          </span>
        )}
        <code className={codeClass} data-testid={`text-${testIdPrefix}-code`}>{record.code}</code>
        {record.httpStatus != null && (
          <span data-testid={`text-${testIdPrefix}-http-status`}>HTTP {record.httpStatus}</span>
        )}
        <span className="text-muted-foreground" data-testid={`text-${testIdPrefix}-environment`}>{record.environment}</span>
        {recovered && (
          <span
            className="rounded-full bg-green-100 px-1.5 py-0.5 font-medium text-green-700 dark:bg-green-950/40 dark:text-green-300"
            data-testid={`text-${testIdPrefix}-recovered`}
            title={recoveredAt!.toLocaleString()}
          >
            recovered {recoveredAt!.toLocaleString()}
          </span>
        )}
      </div>
      {record.bodySnippet && (
        <div className="text-muted-foreground break-words font-mono" data-testid={`text-${testIdPrefix}-body`}>
          {record.bodySnippet}
        </div>
      )}
      <div data-testid={`text-${testIdPrefix}-last-success`}>
        Last successful Front call:{" "}
        {lastSuccess ? lastSuccess.toLocaleString() : "never recorded"}
      </div>
    </div>
  );
}

// Task #4000 — derived view of the Google Ads "Ads OS (env credentials)"
// lane. Ads OS pulls run daily (morning refresh), so a store write inside
// this window means data is flowing even when THIS server process has no
// live cached token yet (health "unknown" right after a restart).
const ADS_OS_FRESH_WINDOW_MS = 36 * 60 * 60 * 1000;
function deriveAdsOsLaneView(adsOs: IntegrationStatus["googleAds"]["adsOs"]): {
  present: boolean;
  /** Credentials work as far as we can tell AND/OR data landed recently. */
  operating: boolean;
  freshnessRecent: boolean;
} {
  if (!adsOs) return { present: false, operating: false, freshnessRecent: false };
  const freshnessRecent =
    !!adsOs.lastDataUpdateAt &&
    Date.now() - new Date(adsOs.lastDataUpdateAt).getTime() < ADS_OS_FRESH_WINDOW_MS;
  const operating =
    adsOs.health === "healthy" || (adsOs.health === "unknown" && freshnessRecent);
  return { present: true, operating, freshnessRecent };
}

// Task #1888 — humanize the short probe reason codes emitted by the
// outcome-aware probe contract into short, operator-readable sentences.
// `integration` is just the noun used in the rendered string ("Zoom",
// "PandaDoc", etc.). Returns null when there's nothing useful to say.
function humanizeIntegrationDisconnectReason(
  integration: string,
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  // Task #2225 — specific auth-breaker trip codes for SEMrush. Each maps to
  // a distinct operator action: re-authorize or re-enter a secret. Checked
  // before the generic buckets below so the tailored guidance wins. (The
  // google_ads_* trip codes retired with the platform connection —
  // Task #4008.)
  const breakerTripReason: Record<string, string> = {
    semrush_refresh_failed_permanent:
      "SEMrush rejected the saved authorization (token revoked or expired) — reconnect to re-authorize.",
    semrush_no_refresh_token:
      "no SEMrush refresh token stored — reconnect to re-authorize.",
    semrush_not_connected: "not connected — connect to enable.",
  };
  if (breakerTripReason[reason]) {
    return `${integration} ${breakerTripReason[reason]}`;
  }
  const noConfig: Record<string, string> = {
    no_token_stored: "no token configured",
    no_api_key: "no API key configured",
    no_secret_key: "no secret key configured",
    no_service_account_key: "no service account key configured",
    no_tokens_stored: "no OAuth tokens stored",
    no_connection: "no OAuth connection saved",
    secrets_missing: "OAuth secrets missing from environment",
    invalid_service_account_json: "stored service account key is invalid JSON",
    test_fixture_leaked: "service account key is a test fixture — restore the real key.",
  };
  if (noConfig[reason]) {
    return `${integration} ${noConfig[reason]} — connect to enable.`;
  }
  if (reason.startsWith("auth_gate:")) {
    return `${integration} auth previously failed (${reason.slice("auth_gate:".length)}) — reconnect to clear.`;
  }
  if (
    /^http_40[13]$/.test(reason) ||
    /^authentication_error$/.test(reason) ||
    /invalid_grant|invalid_client|invalid_api_key|invalid_scope|insufficient_scope|unauthorized_client|invalid_token|unauthorized|forbidden|revoked|expired/i.test(
      reason,
    )
  ) {
    return `${integration} rejected the saved credentials (${reason}) — reconnect to fix.`;
  }
  return `${integration} disconnected: ${reason}`;
}

// Task #1977 — providers with a per-credential change-history dialog.
// (Google Ads left the list in Task #4008: its credential is env secrets,
// rotated outside the app, so there is no in-app history to show.)
type CredentialHistoryProvider =
  | "front"
  | "zoom"
  | "slack"
  | "pandadoc"
  | "ghl"
  | "semrush";

function CredentialHistoryDialog({
  open,
  onClose,
  provider,
}: {
  open: boolean;
  onClose: () => void;
  provider: CredentialHistoryProvider;
}) {
  const { data, isLoading, isError } = useQuery<{ history: CredentialAuditEntry[] }>({
    queryKey: [`/api/integrations/${provider}/credential-history`],
    enabled: open,
  });
  const history = data?.history ?? [];
  const providerLabel =
    provider === "front"
      ? "Front"
      : provider === "zoom"
        ? "Zoom"
        : provider === "slack"
          ? "Slack"
          : provider === "pandadoc"
            ? "PandaDoc"
              : provider === "ghl"
                ? "HighLevel"
            : provider === "semrush"
              ? "SEMrush"
              : "Google Ads";
  const eventLabel = (entry: CredentialAuditEntry): { text: string; cls: string } => {
    const scope = (entry.scope || "").toLowerCase();
    const event = (scope || (entry.newValues?.event as string) || "").toLowerCase();
    // Task #1968 — Slack uses scope=trigger so we get richer labels for the
    // two ways the token can be cleared.
    if (scope === "manual_disconnect") return { text: "Disconnected (manual)", cls: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800" };
    if (scope === "connect_terminal_auth_error") {
      const code = (entry.newValues?.slackErrorCode as string) || "";
      return {
        text: code ? `Auto-cleared (${code})` : "Auto-cleared (terminal auth error)",
        cls: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800",
      };
    }
    if (event === "connect") return { text: "Connected", cls: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800" };
    if (event === "refresh") return { text: "Token Refreshed", cls: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800" };
    if (event === "disconnect") return { text: "Disconnected", cls: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800" };
    return { text: event || "Updated", cls: "bg-muted/50 text-foreground border-border" };
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl" data-testid={`dialog-${provider}-credential-history`}>
        <DialogHeader>
          <DialogTitle>{providerLabel} credential change history</DialogTitle>
          <DialogDescription>
            Recent connect, token refresh, and disconnect events for the {providerLabel} OAuth credentials.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2" data-testid={`list-${provider}-credential-history`}>
          {isLoading && (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid={`text-${provider}-credential-history-loading`}>
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-red-600 dark:text-red-400 py-6 text-center" data-testid={`text-${provider}-credential-history-error`}>
              Failed to load history.
            </div>
          )}
          {!isLoading && !isError && history.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid={`text-${provider}-credential-history-empty`}>
              No credential changes recorded yet.
            </div>
          )}
          {history.map((entry) => {
            const ev = eventLabel(entry);
            const who = formatEditorAttribution(entry);
            return (
              <div
                key={entry.id}
                className="border px-3 py-2 bg-muted/50"
                data-testid={`row-${provider}-credential-history-${entry.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className={ev.cls} data-testid={`badge-${provider}-credential-event-${entry.id}`}>
                    {ev.text}
                  </Badge>
                  <span className="text-xs text-muted-foreground" data-testid={`text-${provider}-credential-time-${entry.id}`}>
                    {new Date(entry.changedAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 text-xs text-foreground" data-testid={`text-${provider}-credential-actor-${entry.id}`}>
                  By <span className="font-medium">{who}</span>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid={`button-${provider}-credential-history-close`}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SyncActivityDisplay({ syncState, label }: { syncState?: IntegrationSyncState; label: string }) {
  if (!syncState) return null;
  const { progress, lastCycle } = syncState;

  return (
    <div className="space-y-1.5" data-testid={`sync-activity-${label}`}>
      {progress.isRunning && (
        <div className="bg-blue-50 dark:bg-blue-950/30 rounded px-2 py-1.5 space-y-0.5" data-testid={`sync-progress-${label}`}>
          <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Syncing...
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-caption text-blue-600">
            {progress.currentPage > 0 && (
              <span>Pages: {progress.currentPage}</span>
            )}
            {progress.conversationsScanned > 0 && (
              <span>Scanned: {progress.conversationsScanned}</span>
            )}
            {progress.conversationsKept > 0 && (
              <span>Kept: {progress.conversationsKept}</span>
            )}
            {progress.conversationsFiltered > 0 && (
              <span>Filtered: {progress.conversationsFiltered}</span>
            )}
          </div>
        </div>
      )}
      {lastCycle && (
        <div className="bg-muted/50 rounded px-2 py-1.5" data-testid={`sync-lastcycle-${label}`}>
          <div className="text-caption text-muted-foreground mb-0.5">
            Last cycle: {new Date(lastCycle.completedAt).toLocaleString()}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption">
            <span className="text-green-600">{lastCycle.matched} matched</span>
            <span className="text-amber-600">{lastCycle.unmatched} unmatched</span>
            <span className="text-muted-foreground">{lastCycle.skipped} skipped</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ClickUpRedirectUriRow({ redirectUri }: { redirectUri: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select and copy the URL manually.", variant: "destructive" });
    }
  };
  return (
    <div className="rounded border border-border bg-muted/50 px-3 py-2 space-y-1" data-testid="notice-clickup-redirect-uri">
      <p className="text-xs font-medium text-foreground">Redirect URI for ClickUp OAuth app</p>
      <p className="text-xs text-muted-foreground">
        Register this URL in your ClickUp OAuth app (Workspace Settings → ClickUp API → app's redirect URLs). It must match <strong>byte-for-byte</strong> — including scheme, host, and path.
      </p>
      <div className="flex items-center gap-2 pt-0.5">
        <code className="flex-1 min-w-0 truncate rounded bg-card border border-border px-2 py-1 text-xs text-foreground" data-testid="text-clickup-hub-redirect-uri">
          {redirectUri}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} data-testid="button-copy-clickup-hub-redirect-uri">
          {copied ? <CheckCircle className="w-4 h-4 mr-1 text-green-600" /> : <Copy className="w-4 h-4 mr-1" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export default function IntegrationsHub() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  const canAccessIntegrations = isAdmin || user?.role === "account_manager";
  const [slackTokenDialog, setSlackTokenDialog] = useState(false);
  const [slackToken, setSlackToken] = useState("");
  // Task #3662 — Ads OS ClickUp company token (write-only field + test result)
  const [clickupCompanyToken, setClickupCompanyToken] = useState("");
  const [clickupCompanyTestResult, setClickupCompanyTestResult] = useState<
    | { ok: true; clients?: number; tasks?: number; testedToken?: string }
    | { ok: false; error?: string; httpStatus?: number | null }
    | null
  >(null);
  const [pandadocKeyDialog, setPandadocKeyDialog] = useState(false);
  const [pandadocApiKey, setPandadocApiKey] = useState("");
  const [ghlCredentialsDialog, setGhlCredentialsDialog] = useState(false);
  const [ghlPrivateToken, setGhlPrivateToken] = useState("");
  const [ghlLocationId, setGhlLocationId] = useState("");
  const [stripeKeyDialog, setStripeKeyDialog] = useState(false);
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  // Task #1624: unmatched-feed state + URL filter + localStorage hydration
  // moved to client/src/components/admin/UnmatchedFeedSection.tsx so the
  // feed can live at its own /admin/unmatched route.
  usePageTitle("Integrations");

  const isTabVisible = useTabVisibility();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden") {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue", { includeResolved: false }] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient]);

  const { data: status, isLoading: statusLoading, error: allStatusError, dataUpdatedAt: statusUpdatedAt } = useQuery<IntegrationStatus>({
    queryKey: ["/api/integrations/all-status"],
    refetchInterval: isTabVisible ? 5000 : false,
    refetchIntervalInBackground: false,
    enabled: canAccessIntegrations,
  });
  // Task #2830 — the aggregate route answering with the status-unknown 503
  // contract (Task #2811) means "couldn't check right now", NOT "everything
  // is disconnected". React Query keeps the last successful payload across a
  // failed refetch, so the cards keep rendering last-known badges; this flag
  // adds a neutral banner while the blip lasts. The cold-mount variant
  // (no data at all yet) also guards the SEMrush card's "Connect" fall-through
  // from presenting a false not-connected.
  const allStatusUnknown = !!parseIntegrationStatusUnknownError(allStatusError);
  const allStatusUnknownNoData = !status && allStatusUnknown;

  // Task #2142 — durable Front auth-death history (most recent death + a
  // capped recent ring). Read-only; surfaces the HTTP status, body snippet,
  // environment, and last successful Front call behind each disconnect so an
  // operator can confirm a reconnect actually fixed the problem.
  const { data: frontAuthHistory } = useQuery<{
    last: FrontAuthDeathRecord | null;
    recent: FrontAuthDeathRecord[];
  }>({
    queryKey: ["/api/integrations/front/auth-history"],
    refetchInterval: isTabVisible ? 15000 : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });
  const [frontAuthHistoryOpen, setFrontAuthHistoryOpen] = useState(false);

  // Booking system schema readiness (Task #865). Surfaces whether the
  // booking_pages / scheduled_meetings tables and the unique +
  // no-overlap constraints are present so a missing-schema regression
  // is immediately visible to ops instead of waiting for an AM to
  // report a broken Schedule tab.
  const { data: bookingHealth } = useQuery<{
    schemaReadiness?: {
      ready: boolean;
      lastCheckedAt: string | null;
      lastError?: string;
      operatorAction: string | null;
      tables: Record<string, boolean>;
      constraints: Record<string, boolean>;
    };
    dbConstraints?: {
      ready: boolean;
      scheduledMeetingsNoOverlap: { installed: boolean; error?: string };
      bookingPagesAccountManagerUnique: { installed: boolean; error?: string };
      btreeGistExtension: { installed: boolean; error?: string };
    };
  }>({
    queryKey: ["/api/admin/booking/health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/booking/health", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch booking health");
      return res.json();
    },
    enabled: isAdmin,
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const [bookingHealthDetailsOpen, setBookingHealthDetailsOpen] = useState(false);

  // Task #1102 — manual re-check of the booking schema readiness snapshot.
  // The cached snapshot only refreshes at server boot + on the 30s admin
  // poll, so after applying a missing migration ops would otherwise have
  // to wait for a restart for the tile to flip back to green.
  const bookingHealthRecheckMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/booking/health/recheck");
      return res.json() as Promise<{
        schemaReadiness: {
          ready: boolean;
          lastCheckedAt: string | null;
          lastError?: string;
          operatorAction: string | null;
          tables: Record<string, boolean>;
          constraints: Record<string, boolean>;
        };
      }>;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/booking/health"] }); // fire-and-forget: cache refresh only
      const ready = data.schemaReadiness.ready;
      toast({
        title: ready ? "Booking schema healthy" : "Booking schema not ready",
        description: ready
          ? "All booking tables and constraints are present."
          : data.schemaReadiness.operatorAction || "One or more booking tables or constraints are missing.",
        variant: ready ? "default" : "destructive",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Re-check failed",
        description: err?.message || "Could not re-check booking system health.",
        variant: "destructive",
      });
    },
  });

  const { data: zoomReviewQueue } = useQuery<{ items: Array<{ decision: { id: string } }> }>({
    queryKey: ["/api/admin/zoom/review-queue", { includeResolved: false }],
    queryFn: async () => {
      const res = await fetch("/api/admin/zoom/review-queue?includeResolved=false", {
        credentials: "include",
      });
      if (!res.ok) return { items: [] };
      return res.json();
    },
    enabled: isAdmin,
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const zoomPendingReviewCount = zoomReviewQueue?.items?.length ?? 0;


  // Task #1624: feed mutations (assign / dismiss / block / undo-claim /
  // review approve+dismiss / promote / cleanup polling) live in
  // UnmatchedFeedSection now.

  // Task #1624: bulk dismiss by domain|channel|sender +
  // handleBulkDismiss helper live in UnmatchedFeedSection now.

  const slackConnectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/integrations/slack/connect", { token });
      // Task #1968: 202 = token saved but verification probe failed
      // transiently; treat as a soft warning instead of an error.
      const body = await res.json().catch(() => ({}));
      return { status: res.status, ...body };
    },
    onSuccess: (data: any) => {
      if (data?.warning) {
        toast({
          title: "Slack token saved — verifying",
          description: data.warning,
        });
      } else {
        toast({ title: "Slack connected" });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
      // Refresh status badge shortly after so the re-probe outcome lands
      // without the operator having to wait the full polling cycle.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
      }, 6000);
      setSlackTokenDialog(false);
      setSlackToken("");
    },
    onError: (err: any) => {
      // Task #1968: surface the specific Slack error code when the
      // server returned a terminal-auth `reason` so operators don't have
      // to guess why their token was rejected.
      const reason = err?.body?.reason || err?.reason;
      const description = reason
        ? `Slack rejected the token (${reason}) — re-enter the bot token.`
        : err?.message || "Slack connect failed.";
      toast({ title: "Slack connect failed", description, variant: "destructive" });
    },
  });

  const slackDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/slack/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Slack disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
    },
  });


  const [resetSyncDialog, setResetSyncDialog] = useState(false);
  const [resetPurgeRecords, setResetPurgeRecords] = useState(false);
  const [resetTriggerRescan, setResetTriggerRescan] = useState(true);
  const [rematchAllDialog, setRematchAllDialog] = useState(false);
  const [rematchDryRunResult, setRematchDryRunResult] = useState<any>(null);
  const [rematchLastResult, setRematchLastResult] = useState<any>(null);
  const [rematchPollingJobId, setRematchPollingJobId] = useState<string | null>(null);
  const [rematchProgress, setRematchProgress] = useState<any>(null);
  const [rematchInlineSummary, setRematchInlineSummary] = useState<any>(null);
  const [frontAdvancedOpen, setFrontAdvancedOpen] = useState(false);
  const [credentialHistoryProvider, setCredentialHistoryProvider] = useState<CredentialHistoryProvider | null>(null);


  const { data: rematchRunningData } = useQuery({
    queryKey: ["/api/integrations/front/rematch-all/running"],
    refetchInterval: isTabVisible ? (rematchPollingJobId ? 5000 : 30000) : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  const rematchJobRunning = !!(rematchRunningData as any)?.running || !!rematchPollingJobId;

  // Task #3122 — per-user ClickUp connection roster for the ClickUp card.
  const { data: clickupConnectedData, isLoading: clickupConnectedLoading, isError: clickupConnectedError } = useQuery<{
    connectedUsers: Array<{
      userId: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      clickupEmail: string | null;
      status: string;
    }>;
    totalTeamMembers: number;
    oauthConfigured: boolean;
    redirectUri: string | null;
  }>({
    queryKey: ["/api/integrations/clickup/connected-users"],
    enabled: isAdmin,
  });

  // Task #3662 — Ads OS COMPANY token status (source, directory health, last
  // rotation). Never contains the token itself.
  const {
    data: clickupCompanyTokenStatus,
    isError: clickupCompanyStatusError,
  } = useQuery<{
    configured: boolean;
    source: "db" | "env" | "none";
    envPresent: boolean;
    dbOverride: boolean;
    lastEdited: {
      updatedAt: string | null;
      updatedBy: { firstName: string | null; lastName: string | null; email: string | null } | null;
    } | null;
    directory: {
      configured: boolean;
      tokenSource: string;
      live: boolean;
      lastSuccessAt: string | null;
      reason: string | null;
    };
  }>({
    queryKey: ["/api/integrations/clickup/company-token/status"],
    enabled: isAdmin,
  });

  const clickupCompanyTestMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (token: string) => {
      const body = token.trim() ? { token: token.trim() } : {};
      const res = await apiRequest("POST", "/api/integrations/clickup/company-token/test", body);
      return res.json() as Promise<
        | { ok: true; clients: number; tasks: number; testedToken: "candidate" | "active" }
        | { ok: false; error: string; httpStatus: number | null }
      >;
    },
    onSuccess: (data) => setClickupCompanyTestResult(data),
    onError: (err: any) =>
      setClickupCompanyTestResult({ ok: false, error: err?.message || "Test request failed" }),
  });

  const clickupCompanySaveMutation = useMutation({
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/integrations/clickup/company-token", {
        token: token.trim(),
      });
      return res.json() as Promise<{
        success: boolean;
        refresh?: { ok: boolean; clients?: number; error?: string };
      }>;
    },
    onSuccess: (data) => {
      setClickupCompanyToken("");
      setClickupCompanyTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/company-token/status"] }); // fire-and-forget: cache refresh only
      if (data.refresh?.ok) {
        toast({
          title: "Token saved & verified",
          description: `Directory refreshed with the new token — ${data.refresh.clients} clients. All instances pick it up within ~1 minute.`,
        });
      } else {
        toast({
          title: "Token saved, but the directory refresh failed",
          description: data.refresh?.error || "The new token is active but the Client List fetch failed — check the token.",
          variant: "destructive",
        });
      }
    },
    onError: (err: any) =>
      toast({ title: "Save failed", description: err?.message, variant: "destructive" }),
  });

  const clickupCompanyClearMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/integrations/clickup/company-token");
      return res.json() as Promise<{ success: boolean; source: string }>;
    },
    onSuccess: (data) => {
      setClickupCompanyTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/company-token/status"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Override cleared",
        description:
          data.source === "env"
            ? "Reverted to the CLICKUP_API_TOKEN env secret."
            : "No env token present — the ClickUp directory is now unconfigured.",
      });
    },
    onError: (err: any) =>
      toast({ title: "Clear failed", description: err?.message, variant: "destructive" }),
  });

  useEffect(() => {
    const serverJobId = (rematchRunningData as any)?.jobId;
    if (serverJobId && !rematchPollingJobId) {
      setRematchPollingJobId(serverJobId);
    }
  }, [rematchRunningData, rematchPollingJobId]);

  const rematchPollFailCount = useRef(0);

  useEffect(() => {
    if (!rematchPollingJobId) return;
    rematchPollFailCount.current = 0;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/integrations/front/rematch-all/status/${rematchPollingJobId}`, { credentials: "include" });
        if (!res.ok) {
          rematchPollFailCount.current++;
          if (rematchPollFailCount.current >= 3) {
            setRematchPollingJobId(null);
          }
          return;
        }
        rematchPollFailCount.current = 0;
        const job = await res.json();
        if (job.status === "running" && job.progress) {
          setRematchProgress(job.progress);
        }
        if (job.status === "complete") {
          setRematchPollingJobId(null);
          setRematchProgress(null);
          const r = job.result;
          setRematchInlineSummary(r);
          setTimeout(() => setRematchInlineSummary(null), 30000);
          if (r?.resumable) {
            setRematchLastResult(r);
            toast({
              title: "Rematch batch complete",
              description: `${r.total} processed so far. More messages remain — open the dialog to continue.`,
            });
          } else {
            toast({
              title: "Rematch complete",
              description: `${r?.total ?? 0} processed: ${r?.reassigned ?? 0} reassigned, ${r?.newlyMatched ?? 0} newly matched, ${r?.unchanged ?? 0} unchanged, ${r?.errors ?? 0} errors`,
            });
          }
          void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
          void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/rematch-all/running"] }); // fire-and-forget: cache refresh only
        } else if (job.status === "failed") {
          setRematchPollingJobId(null);
          setRematchProgress(null);
          toast({ title: "Rematch failed", description: job.error || "Unknown error", variant: "destructive" });
          void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/rematch-all/running"] }); // fire-and-forget: cache refresh only
        }
      } catch {
        rematchPollFailCount.current++;
        if (rematchPollFailCount.current >= 3) {
          setRematchPollingJobId(null);
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [rematchPollingJobId, toast, queryClient]);


  const rematchAllDryRunMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/front/rematch-all", { dryRun: true, maxItems: 100000 });
      return res.json();
    },
    onSuccess: (data: any) => {
      setRematchDryRunResult(data);
    },
    onError: (err: any) => {
      const msg = err.message?.includes("429") || err.message?.includes("Too many DB-heavy") || err.message?.includes("Try again")
        ? "Other sync jobs are running (Zoom, Local Dominance, etc.). Wait a minute and try again."
        : err.message;
      toast({ title: "Preview failed", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const rematchAllMutation = useMutation({
    mutationFn: async (opts?: { resume?: boolean }) => {
      const res = await apiRequest("POST", "/api/integrations/front/rematch-all", {
        dryRun: false,
        maxItems: 100000,
        resume: opts?.resume === true,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.jobId) {
        setRematchPollingJobId(data.jobId);
        setRematchDryRunResult(null);
        setRematchLastResult(null);
        setRematchProgress(null);
        setRematchInlineSummary(null);
        setRematchAllDialog(false);
        toast({
          title: "Rematch started",
          description: "Processing in the background. You'll be notified when it completes.",
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/rematch-all/running"] }); // fire-and-forget: cache refresh only
      }
    },
    onError: (err: any) => {
      const msg = err.message?.includes("429") || err.message?.includes("Too many DB-heavy") || err.message?.includes("Try again")
        ? "Other sync jobs are running (Zoom, Local Dominance, etc.). Wait a minute and try again."
        : err.message?.includes("409") || err.message?.includes("already running")
        ? "A rematch job is already running. Please wait for it to finish."
        : err.message;
      toast({ title: "Rematch failed", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const frontResetSyncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (opts: { purgeRecords: boolean; triggerRescan: boolean }) => {
      const res = await apiRequest("POST", "/api/integrations/front/reset-sync", opts);
      return res.json();
    },
    onSuccess: (data: any) => {
      let desc = "";
      if (data.rescanResult) {
        desc = `Cursor reset. ${data.recordsPurged > 0 ? `${data.recordsPurged} records purged. ` : ""}Re-scan: ${data.rescanResult.matched} matched, ${data.rescanResult.unmatched} unmatched out of ${data.rescanResult.total} fetched.`;
        if (data.reEvalResult && data.reEvalResult.matched > 0) {
          desc += ` Re-evaluation: ${data.reEvalResult.matched} additional matches from ${data.reEvalResult.total} existing records.`;
        }
      } else {
        desc = `Cursor reset.${data.recordsPurged > 0 ? ` ${data.recordsPurged} records purged.` : ""} Start sync to begin a full re-scan.`;
      }
      toast({ title: data.rescanResult ? "Full Re-scan Complete" : "Sync Reset", description: desc });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setResetSyncDialog(false);
      setResetPurgeRecords(false);
      setResetTriggerRescan(true);
    },
    onError: (err: any) => toast({ title: "Reset failed", description: err.message, variant: "destructive" }),
  });

  const zoomDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/zoom/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Zoom disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
    },
  });

  const googleAdsDiscoverMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/google-ads/customers/discover");
      return res.json() as Promise<{ upserted: number; customers: GoogleAdsCustomer[] }>;
    },
    onSuccess: (data) => {
      toast({ title: "Discovery complete", description: `Upserted ${data?.upserted ?? 0} customer(s)` });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/google-ads/customers"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      // Task #2797 — same clear reconnect message as /admin/ads-hygiene
      // (Task #2794) instead of the raw error text.
      const disconnected = parseGoogleAdsDisconnectedError(err);
      if (disconnected) {
        toast({
          title: "Google Ads is disconnected",
          description: disconnected.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Discovery failed", description: err.message, variant: "destructive" });
    },
  });

  const googleAdsToggleSyncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ customerId, syncEnabled }: { customerId: string; syncEnabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/integrations/google-ads/customers/${customerId}`, { syncEnabled });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/google-ads/customers"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Failed to update customer sync", description: err.message, variant: "destructive" }),
  });

  const googleAdsSyncNowMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/google-ads/sync-now");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Google Ads sync triggered",
        description: `Synced ${data?.customersSynced ?? 0} customer(s), ${data?.campaignsSynced ?? 0} campaign(s), ${data?.keywordsSynced ?? 0} keyword(s)`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/google-ads/customers"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/google-ads/sync-runs"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      // Task #2797 — a dead credential now comes back as the structured
      // disconnect 503 (previously a misleading "Synced 0 customer(s)").
      const disconnected = parseGoogleAdsDisconnectedError(err);
      if (disconnected) {
        toast({
          title: "Google Ads is disconnected",
          description: disconnected.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const { data: googleAdsCustomersData } = useQuery<{ customers: GoogleAdsCustomer[] }>({
    queryKey: ["/api/integrations/google-ads/customers"],
    enabled: isAdmin && !!status?.googleAds?.connected,
  });
  const { data: googleAdsRunsData } = useQuery<{ runs: GoogleAdsSyncRun[] }>({
    queryKey: ["/api/integrations/google-ads/sync-runs"],
    enabled: isAdmin && !!status?.googleAds?.connected,
  });

  const zoomSyncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/integrations/zoom/recordings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to trigger Zoom sync");
      return res.json();
    },
    onSuccess: (data: any[]) => {
      toast({
        title: "Zoom sync completed",
        description: `Found ${data.length} recording(s)`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const { data: semrushStatus, error: semrushStatusError } = useQuery<{
    configured: boolean;
    connected: boolean;
    expired: boolean;
    pendingAuth?: { userCode: string; verificationUri: string };
    disconnectReason?: string | null;
    lastProbeError?: string | null;
  }>({
    queryKey: ["/api/semrush/status"],
    enabled: canAccessIntegrations,
    // Task #2820 — while the status route reports "status unknown" (transient
    // settings-read blip, Task #2811's 503 contract), keep re-checking so the
    // neutral card state resolves itself without a manual reload.
    refetchInterval: (query) =>
      parseIntegrationStatusUnknownError(query.state.error) ? 15_000 : false,
  });
  // Task #2820 — a status-unknown 503 with NO previously-loaded data must not
  // fall through to the "Connect Semrush" branch (a false not-connected).
  // When data exists from an earlier success, React Query keeps it across the
  // failed refetch, so the last-known card state continues to render.
  const semrushStatusUnknown =
    !semrushStatus && !!parseIntegrationStatusUnknownError(semrushStatusError);

  const { data: semrushSyncState } = useQuery<{
    outcomeTotals: {
      freshlySynced: number;
      alreadyCurrent: number;
      partiallyRefreshed: number;
      failed: number;
      neverRun: number;
      totalIntegrations: number;
    };
  }>({
    queryKey: ["/api/semrush/console/sync-state"],
    enabled: canAccessIntegrations && !!semrushStatus?.connected,
  });

  const [semrushPolling, setSemrushPolling] = useState(false);
  const semrushPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const semrushAuthMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/semrush/authorize");
      return res.json();
    },
    onSuccess: (data: { userCode: string; verificationUri: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
      window.open(data.verificationUri, "_blank");
      startSemrushPolling();
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const semrushDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/semrush/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Semrush disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
    },
  });

  // SEMrush heatmap backfill UI now lives in the SEMrush Operations Console
  // (`/admin/integrations/semrush`) — see SemrushBackfillPanel. Task 936E
  // relocated it so all SEMrush operator surface lives in one place.

  const stripeConnectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (apiKey: string) => {
      const res = await apiRequest("POST", "/api/integrations/stripe/connect", { apiKey });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Stripe connected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
      setStripeKeyDialog(false);
      setStripeSecretKey("");
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const stripeDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/stripe/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Stripe disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
    },
  });

  const pandadocConnectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (apiKey: string) => {
      const res = await apiRequest("POST", "/api/integrations/pandadoc/connect", { apiKey });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "PandaDoc connected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
      setPandadocKeyDialog(false);
      setPandadocApiKey("");
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const pandadocDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/pandadoc/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "PandaDoc disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
    },
  });

  const ghlConnectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (credentials: { privateToken: string; locationId: string }) => {
      const res = await apiRequest("POST", "/api/integrations/ghl/connect", credentials);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, ...body };
    },
    onSuccess: (data: any) => {
      toast(
        data?.warning
          ? { title: "HighLevel credentials saved — verifying", description: data.warning }
          : { title: "HighLevel connected" },
      );
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] });
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] });
      }, 6000);
      setGhlCredentialsDialog(false);
      setGhlPrivateToken("");
      setGhlLocationId("");
    },
    onError: (err: any) => {
      toast({
        title: "HighLevel connect failed",
        description: err?.body?.error || err?.message || "Could not verify the saved credentials.",
        variant: "destructive",
      });
    },
  });

  const ghlDisconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/ghl/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "HighLevel disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] });
    },
  });


  const pandadocSyncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/integrations/pandadoc/sync", {
        method: "POST",
        credentials: "include",
      });
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new Error(`Sync request failed with status ${res.status}`);
      }
      if (res.status >= 400) {
        throw new Error(body.error || `Sync failed with status ${res.status}`);
      }
      return body;
    },
    onSuccess: (data: any) => {
      const desc = data.errors?.length > 0
        ? `${data.created} new, ${data.updated} updated (${data.errors.length} document errors)`
        : `${data.created} new, ${data.updated} updated`;
      const variant = data.errors?.length > 0 ? "destructive" as const : "default" as const;
      toast({ title: data.errors?.length > 0 ? "PandaDoc sync completed with errors" : "PandaDoc sync complete", description: desc, variant });
    },
    onError: (err: any) => toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const startSemrushPolling = useCallback(() => {
    setSemrushPolling(true);
    if (semrushPollRef.current) clearInterval(semrushPollRef.current);
    semrushPollRef.current = setInterval(async () => {
      try {
        const res = await apiRequest("POST", "/api/semrush/poll-token");
        const data = await res.json();
        if (data.success) {
          if (semrushPollRef.current) clearInterval(semrushPollRef.current);
          setSemrushPolling(false);
          void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
          toast({ title: "Semrush connected" });
        } else if (data.error && data.error !== "authorization_pending" && data.error !== "No pending device authorization") {
          if (semrushPollRef.current) clearInterval(semrushPollRef.current);
          setSemrushPolling(false);
          void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
          const msg = data.error === "expired_token"
            ? "The authorization code expired. Please try connecting again."
            : data.error;
          toast({ title: "Authorization expired", description: msg, variant: "destructive" });
        } else if (data.error === "No pending device authorization") {
          if (semrushPollRef.current) clearInterval(semrushPollRef.current);
          setSemrushPolling(false);
          void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
        }
      } catch {
        if (semrushPollRef.current) clearInterval(semrushPollRef.current);
        setSemrushPolling(false);
      }
    }, 5000);
  }, [queryClient, toast]);

  useEffect(() => {
    return () => { if (semrushPollRef.current) clearInterval(semrushPollRef.current); };
  }, []);

  useEffect(() => {
    if (semrushStatus?.pendingAuth && !semrushPolling) startSemrushPolling();
  }, [semrushStatus?.pendingAuth, semrushPolling, startSemrushPolling]);

  // -------------------------------------------------------------------------
  // Task #4356 — health rollup + bounded "Checking connection…" wait
  // (audit P1-9 + §3.4). Presentation-only: every state below is derived from
  // EXACTLY the same inputs the per-card badges render, so the rollup can
  // never disagree with a card. Probe/status semantics are untouched.
  // -------------------------------------------------------------------------
  const [rollupNowTick, setRollupNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setRollupNowTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  // When each integration ENTERED its "checking" presentation (wall-clock, so
  // a manually-fired timer in a test cannot fake elapsed time).
  const checkingSinceRef = useRef<Record<string, number>>({});
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const baseRollupEntries = deriveIntegrationRollup({
    status,
    bookingReady: bookingHealth?.schemaReadiness ? bookingHealth.schemaReadiness.ready : null,
    clickup: {
      loading: clickupConnectedLoading,
      error: !!clickupConnectedError,
      oauthConfigured: clickupConnectedData ? clickupConnectedData.oauthConfigured : null,
      companySource: clickupCompanyTokenStatus ? clickupCompanyTokenStatus.source : null,
      companyStatusError: !!clickupCompanyStatusError,
      directoryLive: clickupCompanyTokenStatus?.directory ? clickupCompanyTokenStatus.directory.live : null,
    },
    semrushExpired: !!semrushStatus?.expired,
    semrushPending: !!(semrushStatus?.pendingAuth || semrushPolling),
  });

  // Stamp checking-entry times from the RAW classification (never from the
  // timed-out flip below, or a flipped card would lose its stamp and
  // oscillate back to "checking"). Runs after every render; ref-only.
  useEffect(() => {
    const map = checkingSinceRef.current;
    const checkingIds = new Set(
      baseRollupEntries.filter((e) => e.state === "checking").map((e) => e.id),
    );
    for (const id of checkingIds) {
      if (!(id in map)) map[id] = Date.now();
    }
    for (const id of Object.keys(map)) {
      if (!checkingIds.has(id)) delete map[id];
    }
  });

  const statusCheckTimedOut = (id: string): boolean => {
    const since = checkingSinceRef.current[id];
    return typeof since === "number" && rollupNowTick - since >= CHECKING_TIMEOUT_MS;
  };

  // A card stuck in "checking" past the bounded wait counts as needing
  // attention (its body resolves to the couldn't-reach presentation).
  const rollupEntries: IntegrationRollupEntry[] = baseRollupEntries.map((e) =>
    e.state === "checking" && statusCheckTimedOut(e.id)
      ? { ...e, state: "attention" as const, reason: "Status check not answering" }
      : e,
  );
  const rollupHealthyCount = rollupEntries.filter((e) => e.state === "healthy").length;
  const rollupAttentionEntries = rollupEntries.filter((e) => e.state === "attention");
  const rollupCheckingCount = rollupEntries.filter((e) => e.state === "checking").length;

  // Attention-first ordering for the mobile single-column collapse. CSS-only
  // (`max-md:order-*`): the md+ two-column layout keeps stable source order.
  const gridStateRank: Record<IntegrationCardHealth, number> = { attention: 0, checking: 1, healthy: 2 };
  const mobileOrderClassById: Record<string, string> = {};
  rollupEntries
    .filter((e) => e.id !== "booking")
    .map((e, idx) => ({ id: e.id, idx, rank: gridStateRank[e.state] }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .forEach((item, pos) => {
      mobileOrderClassById[item.id] = MOBILE_ORDER_CLASSES[pos] ?? "";
    });

  // Task #4452 — ClickUp and SEMrush card bodies render from their own
  // per-card queries, so they need the same bounded-wait resolution the
  // all-status cards got in Task #4356. Derive "stalled checking" from the
  // RAW rollup classification (the exact inputs the rollup chips use) so the
  // card bodies can never disagree with the rollup bar. Presentation only.
  const rawRollupStateById: Record<string, IntegrationCardHealth> = {};
  for (const e of baseRollupEntries) rawRollupStateById[e.id] = e.state;
  const clickupCheckingTimedOut =
    rawRollupStateById["clickup"] === "checking" && statusCheckTimedOut("clickup");
  const semrushCheckingTimedOut =
    rawRollupStateById["semrush"] === "checking" && statusCheckTimedOut("semrush");

  const retryStatusCheck = () => {
    // Presentation-level retry: restart the bounded wait and refetch the same
    // aggregate the page already polls. No probe semantics involved.
    checkingSinceRef.current = {};
    setRollupNowTick(Date.now());
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
  };

  // Task #4452 — per-card retries also refetch the vendor-specific queries
  // those card bodies actually render from. Cache refresh only.
  const retryClickupStatusCheck = () => {
    retryStatusCheck();
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/connected-users"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/company-token/status"] }); // fire-and-forget: cache refresh only
  };
  const retrySemrushStatusCheck = () => {
    retryStatusCheck();
    void queryClient.invalidateQueries({ queryKey: ["/api/semrush/status"] }); // fire-and-forget: cache refresh only
  };

  const jumpToIntegrationCard = (id: string) => {
    setHighlightedCardId(id);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedCardId(null), 2500);
    document.getElementById(`integration-card-${id}`)?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
  };

  if (authLoading) return <PageSkeleton />;

  if (!user || !canAccessIntegrations) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center" data-testid="text-access-denied">
        <div className="text-foreground">Access denied. Account Manager access or higher required.</div>
      </div>
    );
  }

  if (!isAdmin) {
    const semrushAll = status?.semrush;
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1" data-testid="page-integrations-hub-am">
        {/* Task #4661 — shared Pattern-A header replaces the hand-rolled
            primary band (a global h1 color rule overrode the band's inherited
            text-white, leaving the title ~1.3:1 in light mode). */}
        <PageHeader
          className="max-w-6xl mx-auto px-4 sm:px-6 pt-4"
          title="Integrations"
          backHref="/"
          backLabel="Dashboard"
          backTestId="link-back-dashboard"
        />
        <div className="max-w-6xl mx-auto p-6 space-y-6">
          <Card className="bg-card" data-testid="card-semrush-integration">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MapPin className="w-5 h-5 text-orange-600" />
                Semrush
                {(() => {
                  const connected = semrushAll?.connected;
                  // Task #3670 — key mode indicator (OAuth dormant).
                  if (semrushAll?.authMode === "api_key") {
                    return (
                      <span className="ml-auto flex items-center gap-1.5">
                        <Badge variant="outline" className="border-purple-400 text-purple-700 dark:border-purple-500 dark:text-purple-300" data-testid="badge-semrush-auth-mode">
                          API key
                        </Badge>
                        <ConnectionBadge state={connected ?? null} testId="badge-semrush-status" />
                      </span>
                    );
                  }
                  if (semrushAll?.reconnectRequired) {
                    return (
                      <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-semrush-status">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Reconnect Required
                      </Badge>
                    );
                  }
                  if (semrushStatus?.pendingAuth || semrushPolling) {
                    return <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-semrush-status">Pending</Badge>;
                  }
                  return <ConnectionBadge state={connected ?? null} testId="badge-semrush-status" />;
                })()}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {semrushAll?.disconnectReason && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-950/30 dark:border-red-800 rounded px-2 py-1" data-testid="text-semrush-disconnect-reason">
                  Disconnected: {semrushAll.disconnectReason}
                </div>
              )}
              <Button size="sm" asChild data-testid="button-semrush-open-console">
                <Link href="/admin/integrations/semrush">
                  <ExternalLink className="w-3 h-3 mr-1" /> Open SEMrush Console
                </Link>
              </Button>
              {semrushAll?.connected === true && (
                <p className="text-sm text-muted-foreground">Map Rank Tracker ready</p>
              )}
              <p className="text-xs text-muted-foreground" data-testid="text-semrush-admin-only-hint">
                Connect / disconnect requires Team Lead access.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4661 — shared Pattern-A header replaces the hand-rolled
          primary band (title was near-invisible in light mode: global h1
          color rule beat the band's inherited text-white). */}
      <PageHeader
        className="max-w-6xl mx-auto px-4 sm:px-6 pt-4"
        title="Integrations"
        backHref="/"
        backLabel="Dashboard"
        backTestId="link-back-dashboard"
        actions={
          isAdmin ? (
            <GlobalResetSavedAdminViewsButton variant="outline" size="sm" />
          ) : undefined
        }
      />

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Task #4356 — health rollup (audit P1-9): healthy vs needs-attention
            counts + jump chips, derived from the same inputs as the card
            badges. Lives at the very top so "what's broken" is one glance,
            not an eleven-card scan. */}
        <div
          className="bg-card border border-border rounded-lg px-4 py-3 space-y-2"
          data-testid="bar-integrations-rollup"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-sm font-semibold text-foreground">Integration health</span>
            <span className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400" data-testid="text-rollup-healthy-count">
              <CheckCircle className="w-4 h-4" />
              {rollupHealthyCount} healthy
            </span>
            <span
              className={`flex items-center gap-1.5 text-sm ${rollupAttentionEntries.length > 0 ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground"}`}
              data-testid="text-rollup-attention-count"
            >
              <AlertTriangle className="w-4 h-4" />
              {rollupAttentionEntries.length} {rollupAttentionEntries.length === 1 ? "needs" : "need"} attention
            </span>
            {rollupCheckingCount > 0 && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="text-rollup-checking-count">
                <Loader2 className="w-4 h-4 animate-spin" />
                {rollupCheckingCount} checking
              </span>
            )}
            {statusUpdatedAt > 0 && (
              <span className="ml-auto text-caption text-muted-foreground" data-testid="text-rollup-freshness">
                Updated {formatRollupFreshness(statusUpdatedAt, rollupNowTick)}
              </span>
            )}
          </div>
          {rollupAttentionEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="row-rollup-jump-chips">
              <span className="text-caption uppercase tracking-wide text-muted-foreground">Jump to</span>
              {rollupAttentionEntries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => jumpToIntegrationCard(e.id)}
                  title={e.reason}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
                  data-testid={`chip-rollup-jump-${e.id}`}
                >
                  <AlertTriangle className="w-3 h-3" />
                  {e.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {user?.role === "ceo" && <ProdActionsPanel />}
        {bookingHealth?.schemaReadiness && (() => {
          const sr = bookingHealth.schemaReadiness;
          const dbc = bookingHealth.dbConstraints;
          const ready = sr.ready;
          const tableEntries: Array<{ key: string; label: string; present: boolean }> = [
            { key: "bookingPages", label: "booking_pages", present: !!sr.tables.bookingPages },
            { key: "bookingAvailabilityRules", label: "booking_availability_rules", present: !!sr.tables.bookingAvailabilityRules },
            { key: "bookingAvailabilityOverrides", label: "booking_availability_overrides", present: !!sr.tables.bookingAvailabilityOverrides },
            { key: "scheduledMeetings", label: "scheduled_meetings", present: !!sr.tables.scheduledMeetings },
            { key: "googleCalendarCredentials", label: "google_calendar_credentials", present: !!sr.tables.googleCalendarCredentials },
            { key: "bookingClientTokens", label: "booking_client_tokens", present: !!sr.tables.bookingClientTokens },
          ];
          const constraintEntries: Array<{ key: string; label: string; present: boolean; error?: string }> = [
            {
              key: "bookingPagesAccountManagerUnique",
              label: "booking_pages_account_manager_user_id_unique (UNIQUE)",
              present: !!sr.constraints.bookingPagesAccountManagerUnique,
              error: dbc?.bookingPagesAccountManagerUnique?.error,
            },
            {
              key: "scheduledMeetingsNoOverlap",
              label: "scheduled_meetings_no_overlap (EXCLUDE)",
              present: !!sr.constraints.scheduledMeetingsNoOverlap,
              error: dbc?.scheduledMeetingsNoOverlap?.error,
            },
            {
              key: "btreeGistExtension",
              label: "btree_gist extension",
              present: !!dbc?.btreeGistExtension?.installed,
              error: dbc?.btreeGistExtension?.error,
            },
          ];
          const missingTables = tableEntries.filter((t) => !t.present).length;
          const missingConstraints = constraintEntries.filter((c) => !c.present).length;
          return (
            <Card
              id="integration-card-booking"
              className={`scroll-mt-24 ${ready ? "bg-card border-green-200" : "bg-red-50 border-red-300"}`}
              data-testid="card-booking-health"
            >
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Calendar className={ready ? "w-5 h-5 text-green-700 dark:text-green-400" : "w-5 h-5 text-red-700 dark:text-red-400"} />
                  Booking System Health
                  {ready ? (
                    <Badge
                      variant="outline"
                      className="ml-auto bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800"
                      data-testid="badge-booking-health-status"
                    >
                      <CheckCircle className="w-3 h-3 mr-1" /> Healthy
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="ml-auto bg-red-100 text-red-800 border-red-300"
                      data-testid="badge-booking-health-status"
                    >
                      <AlertTriangle className="w-3 h-3 mr-1" /> Schema Not Ready
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1" data-testid="text-booking-health-subtitle">
                  Confirms the booking tables and unique / no-overlap constraints are present in Postgres.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {!ready && sr.operatorAction && (
                  <div
                    className="flex items-start gap-2 text-sm text-red-800 bg-red-100 border border-red-200 rounded px-3 py-2"
                    data-testid="text-booking-health-operator-action"
                  >
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>
                      <span className="font-medium">Action required:</span> {sr.operatorAction}
                    </span>
                  </div>
                )}
                {sr.lastError && (
                  <div
                    className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-950/30 dark:border-red-800 rounded px-2 py-1"
                    data-testid="text-booking-health-last-error"
                  >
                    <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span className="break-words">Last probe error: {sr.lastError}</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span data-testid="text-booking-health-tables-summary">
                    Tables: <span className={missingTables === 0 ? "font-medium text-green-700 dark:text-green-400" : "font-medium text-red-700 dark:text-red-400"}>
                      {tableEntries.length - missingTables}/{tableEntries.length} present
                    </span>
                  </span>
                  <span data-testid="text-booking-health-constraints-summary">
                    Constraints: <span className={missingConstraints === 0 ? "font-medium text-green-700 dark:text-green-400" : "font-medium text-red-700 dark:text-red-400"}>
                      {constraintEntries.length - missingConstraints}/{constraintEntries.length} installed
                    </span>
                  </span>
                  {sr.lastCheckedAt && (
                    <span className="flex items-center gap-1" data-testid="text-booking-health-last-checked">
                      <Clock className="w-3 h-3" />
                      Last checked: {new Date(sr.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs px-2"
                    onClick={() => setBookingHealthDetailsOpen((v) => !v)}
                    data-testid="button-booking-health-toggle-details"
                  >
                    {bookingHealthDetailsOpen ? (
                      <><ChevronUp className="w-3 h-3 mr-1" /> Hide details</>
                    ) : (
                      <><ChevronDown className="w-3 h-3 mr-1" /> Show details</>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs px-2"
                    onClick={() => bookingHealthRecheckMutation.mutate()}
                    disabled={bookingHealthRecheckMutation.isPending}
                    data-testid="button-booking-health-recheck"
                  >
                    {bookingHealthRecheckMutation.isPending ? (
                      <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Re-checking…</>
                    ) : (
                      <><RefreshCw className="w-3 h-3 mr-1" /> Re-check now</>
                    )}
                  </Button>
                </div>
                {bookingHealthDetailsOpen && (
                  <div
                    className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-border"
                    data-testid="div-booking-health-details"
                  >
                    <div>
                      <div className="text-xs font-semibold text-foreground mb-1">Tables</div>
                      <ul className="space-y-1">
                        {tableEntries.map((t) => (
                          <li
                            key={t.key}
                            className="flex items-center gap-2 text-xs"
                            data-testid={`row-booking-health-table-${t.key}`}
                          >
                            {t.present ? (
                              <CheckCircle className="w-3 h-3 text-green-600 flex-shrink-0" />
                            ) : (
                              <XCircle className="w-3 h-3 text-red-600 flex-shrink-0" />
                            )}
                            <code className={t.present ? "text-foreground" : "text-red-700 dark:text-red-400 font-medium"}>{t.label}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-foreground mb-1">Constraints</div>
                      <ul className="space-y-1">
                        {constraintEntries.map((c) => (
                          <li
                            key={c.key}
                            className="text-xs"
                            data-testid={`row-booking-health-constraint-${c.key}`}
                          >
                            <div className="flex items-center gap-2">
                              {c.present ? (
                                <CheckCircle className="w-3 h-3 text-green-600 flex-shrink-0" />
                              ) : (
                                <XCircle className="w-3 h-3 text-red-600 flex-shrink-0" />
                              )}
                              <code className={c.present ? "text-foreground" : "text-red-700 dark:text-red-400 font-medium"}>{c.label}</code>
                            </div>
                            {!c.present && c.error && (
                              <div
                                className="ml-5 text-caption text-red-600 dark:text-red-400 break-words"
                                data-testid={`text-booking-health-constraint-error-${c.key}`}
                              >
                                {c.error}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}
        {allStatusUnknown && (
          // Task #2830 — the aggregate status poll is temporarily
          // unanswerable (status-unknown 503). Not a disconnect: cards below
          // keep their last-known badges (or "Checking…" on a cold load).
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 border border-border rounded px-3 py-2"
            data-testid="text-all-status-unknown"
          >
            <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
            <span>
              Status check temporarily unavailable — retrying. Showing last known
              connection statuses; this is not a disconnect.
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <IntegrationCardShell
            integrationId="front"
            cardTestId="card-front-integration"
            icon={<Mail className="w-5 h-5 text-blue-600" />}
            name="Front Email"
            badge={<ConnectionBadge state={status?.front.connected} testId="badge-front-status" />}
            subtitle={
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-front-card-subtitle">
                Manage messages, filter rules, and recovery jobs from the Front console.
              </p>
            }
            mobileOrderClass={mobileOrderClassById["front"]}
            highlighted={highlightedCardId === "front"}
          >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <LastEditedBadge info={status?.front?.lastEdited?.token} testId="badge-last-edited-front-token" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                  onClick={() => setCredentialHistoryProvider("front")}
                  data-testid="button-front-credential-history"
                >
                  <History className="w-3 h-3 mr-1" /> View history
                </Button>
              </div>
              {status?.front.webhookSecretConfigured === false && (
                // Task #3964 (A-003 remainder) — presence-only readiness flag
                // from the status loader. Without FRONT_WEBHOOK_SECRET the
                // webhook route rejects deliveries in production (fail-closed,
                // #1593), so sync silently stalls; make that state visible.
                // Rendered independently of connected-state: the API token and
                // the webhook secret are separate credentials.
                <div
                  className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-950/30 dark:border-amber-800 rounded px-2 py-1.5"
                  data-testid="text-front-webhook-secret-missing"
                >
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    Webhook secret not configured — incoming Front webhooks are
                    rejected in production (fail-closed). Set{" "}
                    <code className="font-mono">FRONT_WEBHOOK_SECRET</code> in this
                    environment&apos;s secrets to restore event-driven sync.
                  </span>
                </div>
              )}
              {status?.front.connected === null || status?.front.connected === undefined ? (
                <CheckingConnection
                  name="Front"
                  idSlug="front"
                  testId="text-front-checking"
                  timedOut={statusCheckTimedOut("front")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.front.connected === true ? (
                <>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-front-sync-active">
                    <RefreshCw className="w-3 h-3 text-green-600" /> Webhook-driven sync active
                  </div>
                  {status?.front.lastProbeError && (
                    // Task #1861: surface a transient probe failure
                    // (5xx / network / refresh transport error) without
                    // flipping the Connected badge. The badge stays
                    // green; this muted hint tells the operator why the
                    // probe didn't update so they don't suspect a
                    // silent failure.
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-front-probe-failed">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last check failed — retrying ({status.front.lastProbeError})</span>
                    </div>
                  )}
                  {status?.front.lastSyncError && (
                    <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 dark:text-red-300 dark:bg-red-950/30 rounded px-2 py-1" data-testid="text-front-sync-error">
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last error: {status.front.lastSyncError}</span>
                    </div>
                  )}
                  {status?.front.lastSyncSuccess && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-front-sync-last-success">
                      <Clock className="w-3 h-3 flex-shrink-0" />
                      <span>Last successful sync: {new Date(status.front.lastSyncSuccess).toLocaleString()}</span>
                    </div>
                  )}
                  <SyncActivityDisplay syncState={status?.front.syncProgress} label="front" />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" asChild data-testid="button-front-open-console">
                      <Link href="/admin/front">
                        <ExternalLink className="w-3 h-3 mr-1" /> Open Front Console
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild data-testid="button-import-suggestions">
                      <Link href="/admin/integrations/import-suggestions">
                        <Inbox className="w-3 h-3 mr-1" /> Review Import Suggestions
                      </Link>
                    </Button>
                    <Button size="sm" variant="ghost" className="text-blue-600 hover:text-blue-700" data-testid="button-front-reconnect" onClick={async () => {
                      try {
                        const res = await fetch("/api/integrations/front/authorize", { credentials: "include" });
                        if (!res.ok) throw new Error("Failed to start Front authorization");
                        const data = await res.json();
                        if (data.url) window.location.href = data.url;
                        else throw new Error(data.error || "No authorization URL returned");
                      } catch (e: any) {
                        toast({ title: "Reconnect failed", description: e.message, variant: "destructive" });
                      }
                    }}>
                      <Plug className="w-3 h-3 mr-1" /> Reconnect
                    </Button>
                    <ConfirmActionDialog
                      trigger={
                        <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" data-testid="button-front-disconnect">
                          <Unplug className="w-3 h-3 mr-1" /> Disconnect
                        </Button>
                      }
                      title="Disconnect Front?"
                      description="This clears all Front tokens and sync state, and stops email sync until Front is reconnected. Already-imported emails are kept."
                      confirmLabel="Disconnect"
                      onConfirm={async () => {
                        try {
                          await apiRequest("POST", "/api/integrations/front/disconnect");
                          toast({ title: "Front disconnected", description: "All Front tokens and sync state have been cleared." });
                          void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
                        } catch (e: any) {
                          toast({ title: "Disconnect failed", description: e.message, variant: "destructive" });
                        }
                      }}
                      testId="dialog-front-disconnect"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setFrontAdvancedOpen((v) => !v)}
                      data-testid="button-front-advanced-toggle"
                      aria-expanded={frontAdvancedOpen}
                    >
                      {frontAdvancedOpen ? (
                        <ChevronUp className="w-3 h-3 mr-1" />
                      ) : (
                        <ChevronDown className="w-3 h-3 mr-1" />
                      )}
                      Advanced
                    </Button>
                  </div>
                  {frontAdvancedOpen && (
                    <div
                      className="mt-2 p-2 border border-dashed border-border rounded-md bg-muted/50 space-y-2"
                      data-testid="div-front-advanced"
                    >
                      <p className="text-caption text-muted-foreground">
                        Destructive sync controls. Prefer running these from the{" "}
                        <Link href="/admin/front" className="underline text-blue-600 hover:text-blue-700">
                          Front Console
                        </Link>{" "}
                        where full progress, history, and recovery jobs are visible.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                          onClick={() => setResetSyncDialog(true)}
                          data-testid="button-front-reset-sync"
                        >
                          <RefreshCw className="w-3 h-3 mr-1" /> Reset Sync
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-indigo-600 hover:text-indigo-700"
                          data-testid="button-front-rematch-all"
                          onClick={() => {
                            setRematchDryRunResult(null);
                            setRematchLastResult(null);
                            setRematchAllDialog(true);
                          }}
                        >
                          <RefreshCw className="w-3 h-3 mr-1" /> Rematch All
                        </Button>
                      </div>
                    </div>
                  )}
                  {rematchJobRunning && rematchProgress && (
                    <div className="mt-3 p-3 bg-indigo-50 rounded-lg space-y-2" data-testid="div-rematch-progress">
                      <div className="flex items-center gap-2 text-sm font-medium text-indigo-700">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Rematch in progress
                      </div>
                      <Progress value={Math.min((rematchProgress.processed / (rematchProgress.maxItems || rematchProgress.processed || 1)) * 100, 100)} className="h-2" data-testid="progress-rematch" />
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Processed: <span className="font-medium text-foreground" data-testid="text-progress-processed">{rematchProgress.processed}</span></span>
                        <span>Matched: <span className="font-medium text-green-700" data-testid="text-progress-matched">{rematchProgress.newlyMatched ?? 0}</span></span>
                        <span>Reassigned: <span className="font-medium text-amber-700" data-testid="text-progress-reassigned">{rematchProgress.reassigned ?? 0}</span></span>
                        <span>Unchanged: <span className="font-medium text-muted-foreground" data-testid="text-progress-unchanged">{rematchProgress.unchanged ?? 0}</span></span>
                        <span>Errors: <span className="font-medium text-red-700" data-testid="text-progress-errors">{rematchProgress.errors ?? 0}</span></span>
                      </div>
                    </div>
                  )}
                  {rematchJobRunning && !rematchProgress && (
                    <div className="mt-3 p-3 bg-indigo-50 rounded-lg" data-testid="div-rematch-starting">
                      <div className="flex items-center gap-2 text-sm text-indigo-600">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Rematch starting...
                      </div>
                    </div>
                  )}
                  {!rematchJobRunning && rematchInlineSummary && (
                    <div className="mt-3 p-3 bg-green-50 dark:bg-green-950/20 rounded-lg space-y-1" data-testid="div-rematch-inline-summary">
                      <div className="text-sm font-medium text-green-700 dark:text-green-400">
                        <CheckCircle className="w-4 h-4 inline mr-1" />
                        Rematch complete
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Total: <span className="font-medium text-foreground">{rematchInlineSummary.total}</span></span>
                        <span>Matched: <span className="font-medium text-green-700 dark:text-green-400">{rematchInlineSummary.newlyMatched ?? 0}</span></span>
                        <span>Reassigned: <span className="font-medium text-amber-700 dark:text-amber-400">{rematchInlineSummary.reassigned ?? 0}</span></span>
                        <span>Unchanged: <span className="font-medium text-muted-foreground">{rematchInlineSummary.unchanged ?? 0}</span></span>
                        <span>Errors: <span className="font-medium text-red-700">{rematchInlineSummary.errors ?? 0}</span></span>
                      </div>
                    </div>
                  )}
                </>

              ) : (
                <>
                  {/* Task #2100: explain *why* Front shows disconnected and
                      surface the global auth-dead breaker so the operator
                      knows a reconnect is required, mirroring Slack. */}
                  {(() => {
                    const reason = status?.front.disconnectReason;
                    const breakerOpen = status?.front.breakerOpen;
                    const cooldownSec = Math.ceil((status?.front.cooldownRemainingMs ?? 0) / 1000);
                    // Task #2121 — the durable breaker signal carries *when*
                    // Front lost its connection, *when* suppression lifts, and
                    // how many times it has tripped. Surface those so the badge
                    // is actionable, not just a bare open/closed flag.
                    const tripCount = status?.front.tripCount ?? 0;
                    let text: string | null = null;
                    if (breakerOpen) {
                      text = `Front disconnected — reconnect required. Auth backoff active${cooldownSec > 0 ? ` (~${cooldownSec}s)` : ""}; Front's OAuth token was rejected and every Front sync is paused until you reconnect.`;
                    } else if (reason) {
                      text =
                        humanizeIntegrationDisconnectReason("Front", reason) ??
                        `Front disconnected: ${reason}`;
                    }
                    if (!text) return null;
                    return (
                      <div className="flex flex-col gap-1 text-xs text-red-700 bg-red-50 rounded px-2 py-1" data-testid="text-front-disconnect-reason">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{text}</span>
                        </div>
                        {breakerOpen && (
                          <BreakerDetailRow
                            lastTrippedAt={status?.front.lastTrippedAt}
                            cooldownUntil={status?.front.cooldownUntil}
                            tripCount={tripCount}
                            testIdPrefix="front"
                          />
                        )}
                      </div>
                    );
                  })()}
                  <Button size="sm" variant="outline" data-testid="button-front-connect" onClick={async () => {
                      try {
                        const res = await fetch("/api/integrations/front/authorize", { credentials: "include" });
                        if (!res.ok) throw new Error("Failed to start Front authorization");
                        const data = await res.json();
                        if (data.url) window.location.href = data.url;
                        else throw new Error(data.error || "No authorization URL returned");
                      } catch (e: any) {
                        toast({ title: "Connection failed", description: e.message, variant: "destructive" });
                      }
                    }}>
                      <Plug className="w-3 h-3 mr-1" /> Connect Front
                  </Button>
                </>
              )}
              {/* Task #2142 — read-only Front auth history. Surfaces the
                  most recent terminal auth death plus a capped recent ring
                  (HTTP status, body snippet, environment, last successful
                  Front call) so an operator can see why Front last
                  disconnected and confirm a reconnect. Only rendered once
                  there is at least one death on record. */}
              {frontAuthHistory?.last && (
                <div
                  className="mt-2 border-t border-border pt-2 space-y-2"
                  data-testid="div-front-auth-history"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      Front auth history
                    </span>
                    {(frontAuthHistory.recent?.length ?? 0) > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                        onClick={() => setFrontAuthHistoryOpen((v) => !v)}
                        data-testid="button-front-auth-history-toggle"
                        aria-expanded={frontAuthHistoryOpen}
                      >
                        {frontAuthHistoryOpen ? (
                          <><ChevronUp className="w-3 h-3 mr-1" /> Hide</>
                        ) : (
                          <><ChevronDown className="w-3 h-3 mr-1" /> Show {frontAuthHistory.recent.length}</>
                        )}
                      </Button>
                    )}
                  </div>
                  <FrontAuthDeathDetails record={frontAuthHistory.last} testIdPrefix="front-auth-last" />
                  {frontAuthHistoryOpen && (frontAuthHistory.recent?.length ?? 0) > 1 && (
                    <ul className="space-y-1.5" data-testid="list-front-auth-history">
                      {frontAuthHistory.recent.slice(1).map((rec, i) => (
                        <li
                          key={`${rec.diedAt}-${i}`}
                          // Decorative history-list rail (neutral chrome, not a
                          // status signal) — exempt from the --status-* token
                          // sweep (Task #4492).
                          className="border-l-2 border-border pl-2"
                          data-testid={`row-front-auth-history-${i}`}
                        >
                          <FrontAuthDeathDetails record={rec} testIdPrefix={`front-auth-recent-${i}`} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="slack"
            cardTestId="card-slack-integration"
            icon={<MessageSquare className="w-5 h-5 text-purple-600" />}
            name="Slack"
            badge={<ConnectionBadge state={status?.slack.connected} testId="badge-slack-status" />}
            mobileOrderClass={mobileOrderClassById["slack"]}
            highlighted={highlightedCardId === "slack"}
          >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <LastEditedBadge info={status?.slack?.lastEdited?.botToken} testId="badge-last-edited-slack-bot-token" />
                {/* Task #1968: surface who/what cleared the slack_bot_token. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                  onClick={() => setCredentialHistoryProvider("slack")}
                  data-testid="button-slack-credential-history"
                >
                  <History className="w-3 h-3 mr-1" /> View history
                </Button>
              </div>
              {status?.slack.connected === null || status?.slack.connected === undefined ? (
                <CheckingConnection
                  name="Slack"
                  idSlug="slack"
                  testId="text-slack-checking"
                  timedOut={statusCheckTimedOut("slack")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.slack.connected === true ? (
                <>
                  <p className="text-sm text-muted-foreground">Team: {status.slack.team || "Unknown"}</p>
                  {status?.slack.lastProbeError && (
                    // Task #1876: surface a transient probe failure
                    // without flipping the Connected badge — mirrors the
                    // Front pattern from Task #1861.
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-slack-probe-failed">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last check failed — retrying ({status.slack.lastProbeError})</span>
                    </div>
                  )}
                  <SyncActivityDisplay syncState={status?.slack.syncProgress} label="slack" />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" asChild data-testid="button-slack-manage">
                      <Link href="/admin/slack">
                        <ExternalLink className="w-3 h-3 mr-1" /> Manage Channels
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild data-testid="button-slack-notifications">
                      <Link href="/admin/slack/notifications">
                        <ExternalLink className="w-3 h-3 mr-1" /> Notifications
                      </Link>
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => slackDisconnectMutation.mutate()} data-testid="button-slack-disconnect">
                      <Unplug className="w-3 h-3 mr-1" /> Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/* Task #1876: explain *why* Slack shows disconnected. */}
                  {(() => {
                    const reason = status?.slack.disconnectReason;
                    const breakerOpen = status?.slack.breakerOpen;
                    const cooldownSec = Math.ceil((status?.slack.cooldownRemainingMs ?? 0) / 1000);
                    let text: string | null = null;
                    if (reason === "no_token_stored") {
                      text = "No Slack bot token configured — connect Slack to enable notifications.";
                    } else if (reason && [
                      "invalid_auth",
                      "not_authed",
                      "account_inactive",
                      "token_revoked",
                      "token_expired",
                      "invalid_token",
                    ].includes(reason)) {
                      text = `Token rejected by Slack (${reason}) — re-enter the Slack bot token.`;
                    } else if (breakerOpen && cooldownSec > 0) {
                      text = `Slack auth breaker open — retrying in ~${cooldownSec}s.`;
                    } else if (reason) {
                      text = `Slack disconnected: ${reason}`;
                    }
                    if (!text) return null;
                    return (
                      <div className="flex flex-col gap-1 text-xs text-red-700 bg-red-50 rounded px-2 py-1" data-testid="text-slack-disconnect-reason">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{text}</span>
                        </div>
                        {/* Task #2152 — when/until/how-many detail, mirroring Front. */}
                        {breakerOpen && (
                          <BreakerDetailRow
                            lastTrippedAt={status?.slack.lastTrippedAt}
                            cooldownUntil={status?.slack.cooldownUntil}
                            tripCount={status?.slack.tripCount}
                            testIdPrefix="slack"
                          />
                        )}
                      </div>
                    );
                  })()}
                  <Button size="sm" variant="outline" onClick={() => setSlackTokenDialog(true)} data-testid="button-slack-connect">
                    <Plug className="w-3 h-3 mr-1" /> Connect Slack
                  </Button>
                </>
              )}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="zoom"
            cardTestId="card-zoom-integration"
            icon={<Video className="w-5 h-5 text-indigo-600" />}
            name="Zoom"
            badge={(() => {
              const reconnectNeeded =
                !!status?.zoom.reconnectRequired?.authGate ||
                (status?.zoom.reconnectRequired?.scopeGates?.length ?? 0) > 0;
              if (reconnectNeeded) {
                return (
                  <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-zoom-status">
                    <AlertTriangle className="w-3 h-3 mr-1" /> Reconnect Required
                  </Badge>
                );
              }
              return <ConnectionBadge state={status?.zoom.connected} testId="badge-zoom-status" />;
            })()}
            mobileOrderClass={mobileOrderClassById["zoom"]}
            highlighted={highlightedCardId === "zoom"}
          >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <LastEditedBadge info={status?.zoom?.lastEdited?.token} testId="badge-last-edited-zoom-token" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                  onClick={() => setCredentialHistoryProvider("zoom")}
                  data-testid="button-zoom-credential-history"
                >
                  <History className="w-3 h-3 mr-1" /> View history
                </Button>
              </div>
              {(() => {
                const authGate = status?.zoom.reconnectRequired?.authGate ?? null;
                const scopeGates = status?.zoom.reconnectRequired?.scopeGates ?? [];
                if (!authGate && scopeGates.length === 0) return null;
                const sinceValues: number[] = [
                  ...(authGate ? [authGate.since] : []),
                  ...scopeGates.map((g) => g.since),
                ].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
                const earliestSince = sinceValues.length > 0 ? Math.min(...sinceValues) : null;
                // Task #4345 — refit onto the shared DegradedState kit
                // primitive (diagnostics as children, self-heal retry line via
                // retryAt/retryPaused — Task #2275 semantics preserved).
                return (
                  <DegradedState
                    testId="banner-zoom-reconnect-required"
                    title="Zoom needs to be reconnected"
                    since={earliestSince}
                    sinceTestId="text-zoom-reconnect-engaged-for"
                    retryAt={status?.zoom.cooldownUntil ?? null}
                    retryPaused={!!status?.zoom.selfHealParked}
                    retryTestIdPrefix="text-zoom-selfheal"
                    action={
                      <Button
                        size="sm"
                        className="bg-amber-700 hover:bg-amber-800 text-white dark:bg-amber-600 dark:hover:bg-amber-500 dark:text-amber-950"
                        data-testid="button-zoom-reconnect-banner"
                        onClick={async () => {
                          try {
                            const res = await fetch("/api/integrations/zoom/authorize", { credentials: "include" });
                            if (!res.ok) throw new Error("Failed to start Zoom authorization");
                            const data = await res.json();
                            if (data.url) window.location.href = data.url;
                            else throw new Error(data.error || "No authorization URL returned");
                          } catch (e: any) {
                            toast({ title: "Reconnect failed", description: e.message, variant: "destructive" });
                          }
                        }}
                      >
                        <RefreshCw className="w-3 h-3 mr-1" /> Reconnect Zoom
                      </Button>
                    }
                  >
                    {authGate && (
                      <div data-testid="text-zoom-auth-gate-reason">
                        Auth blocked (status {authGate.status}): {authGate.reason}. Calls will keep failing until an operator reconnects.
                        {typeof authGate.since === "number" && Number.isFinite(authGate.since) && (
                          <span
                            className="ml-1 opacity-80"
                            data-testid="text-zoom-auth-gate-engaged-for"
                            title={new Date(authGate.since).toLocaleString()}
                          >
                            (Engaged {formatEngagedFor(authGate.since)})
                          </span>
                        )}
                      </div>
                    )}
                    {scopeGates.length > 0 && (
                      <div data-testid="text-zoom-scope-gates">
                        <div>
                          Missing Zoom scopes for: {scopeGates.map((g) => g.scopeKey).join(", ")}. Reconnect to grant the new scopes.
                        </div>
                        <ul className="ml-4 list-disc">
                          {scopeGates.map((g) => (
                            <li
                              key={g.scopeKey}
                              data-testid={`text-zoom-scope-gate-engaged-${g.scopeKey}`}
                              title={typeof g.since === "number" && Number.isFinite(g.since) ? new Date(g.since).toLocaleString() : undefined}
                            >
                              <span className="font-medium">{g.scopeKey}</span>
                              {typeof g.since === "number" && Number.isFinite(g.since) && (
                                <span className="ml-1 opacity-80">— Engaged {formatEngagedFor(g.since)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </DegradedState>
                );
              })()}
              {status?.zoom.connected === null || status?.zoom.connected === undefined ? (
                <CheckingConnection
                  name="Zoom"
                  idSlug="zoom"
                  testId="text-zoom-checking"
                  timedOut={statusCheckTimedOut("zoom")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.zoom.connected === true ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-zoom-sync-active">
                    <RefreshCw className="w-3 h-3 text-green-600" /> Webhook-driven sync active
                  </div>
                  {status?.zoom.lastProbeError && (
                    // Task #1888: surface a transient probe failure without
                    // flipping the Connected badge — matches Slack/Front.
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-zoom-probe-failed">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last check failed — retrying ({status.zoom.lastProbeError})</span>
                    </div>
                  )}
                  <SyncActivityDisplay syncState={status?.zoom.syncProgress} label="zoom" />
                  <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="outline" data-testid="button-zoom-sync-now" onClick={() => zoomSyncMutation.mutate()} disabled={zoomSyncMutation.isPending}>
                    {zoomSyncMutation.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3 mr-1" />
                    )}
                    {zoomSyncMutation.isPending ? "Syncing..." : "Sync Now"}
                  </Button>
                  <Button size="sm" variant="outline" asChild data-testid="button-zoom-manage">
                    <Link href="/admin/zoom">
                      <ExternalLink className="w-3 h-3 mr-1" /> Review Meetings
                    </Link>
                  </Button>
                  <Button size="sm" variant="outline" asChild data-testid="button-zoom-review-queue">
                    <Link href="/admin/zoom/review">
                      <Inbox className="w-3 h-3 mr-1" /> Review Queue
                      {zoomPendingReviewCount > 0 && (
                        <Badge
                          className="ml-2 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/40"
                          data-testid="badge-zoom-review-queue-count"
                        >
                          {zoomPendingReviewCount}
                        </Badge>
                      )}
                    </Link>
                  </Button>
                  {!status?.zoom.reconnectRequired?.authGate &&
                    (status?.zoom.reconnectRequired?.scopeGates?.length ?? 0) === 0 && (
                    <Button size="sm" variant="outline" data-testid="button-zoom-reconnect" onClick={async () => {
                      try {
                        const res = await fetch("/api/integrations/zoom/authorize", { credentials: "include" });
                        if (!res.ok) throw new Error("Failed to start Zoom authorization");
                        const data = await res.json();
                        if (data.url) window.location.href = data.url;
                        else throw new Error(data.error || "No authorization URL returned");
                      } catch (e: any) {
                        toast({ title: "Reconnect failed", description: e.message, variant: "destructive" });
                      }
                    }}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Reconnect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => zoomDisconnectMutation.mutate()} data-testid="button-zoom-disconnect">
                    <Unplug className="w-3 h-3 mr-1" /> Disconnect
                  </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Task #1888: explain *why* Zoom shows disconnected. */}
                  {(() => {
                    const text = humanizeIntegrationDisconnectReason("Zoom", status?.zoom.disconnectReason);
                    return text ? (
                      <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded px-2 py-1 mb-2" data-testid="text-zoom-disconnect-reason">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{text}</span>
                      </div>
                    ) : null;
                  })()}
                  <Button size="sm" variant="outline" data-testid="button-zoom-connect" onClick={async () => {
                      try {
                        const res = await fetch("/api/integrations/zoom/authorize", { credentials: "include" });
                        if (!res.ok) throw new Error("Failed to start Zoom authorization");
                        const data = await res.json();
                        if (data.url) window.location.href = data.url;
                        else throw new Error(data.error || "No authorization URL returned");
                      } catch (e: any) {
                        toast({ title: "Connection failed", description: e.message, variant: "destructive" });
                      }
                    }}>
                      <Plug className="w-3 h-3 mr-1" /> Connect Zoom
                  </Button>
                </>
              )}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="clickup"
            cardTestId="card-clickup-integration"
            icon={<CheckCircle className="w-5 h-5 text-purple-600" />}
            name="ClickUp"
            badge={
              <Badge variant="outline" className="ml-auto text-caption bg-purple-50 text-purple-700 border-purple-200" data-testid="badge-clickup-status">
                Per-user OAuth
              </Badge>
            }
            mobileOrderClass={mobileOrderClassById["clickup"]}
            highlighted={highlightedCardId === "clickup"}
          >
              <p className="text-xs text-muted-foreground">
                Each team member connects their own ClickUp account individually via their Profile page. The Service Desk runs on the signed-in admin's own connected account — if you haven't connected yours, Service Desk actions will fail.
              </p>
              {clickupConnectedData && clickupConnectedData.oauthConfigured === false && (
                <div className="flex gap-2 items-start rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300" data-testid="notice-clickup-oauth-unconfigured">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div className="space-y-1">
                    <p className="font-medium">OAuth app credentials not configured</p>
                    <p>Nobody can connect their ClickUp account until <code className="bg-amber-100 dark:bg-amber-950/50 rounded px-1">CLICKUP_CLIENT_ID</code> and <code className="bg-amber-100 dark:bg-amber-950/50 rounded px-1">CLICKUP_CLIENT_SECRET</code> are added in Replit Secrets.</p>
                    <p>To create the OAuth app: in ClickUp, click the Workspace avatar (upper-left) → Settings → ClickUp API → "ClickUp API Settings" tab → <strong>Create an App</strong>. Register the callback URL shown below as a redirect URL in the ClickUp app (byte-for-byte — including scheme and path).</p>
                  </div>
                </div>
              )}
              {clickupConnectedData && clickupConnectedData.redirectUri && (
                <ClickUpRedirectUriRow redirectUri={clickupConnectedData.redirectUri} />
              )}
              {/* Task #4452 — bounded wait: a stalled initial status load
                  resolves to the shared couldn't-reach presentation instead
                  of spinning forever (rollup chip already flips; the body
                  now matches). Presentation only. */}
              {clickupCheckingTimedOut && (
                <CheckingConnection
                  name="ClickUp"
                  idSlug="clickup"
                  testId="text-clickup-checking"
                  timedOut
                  onRetry={retryClickupStatusCheck}
                />
              )}
              {/* Task #3122 — per-user connection roster */}
              {clickupConnectedLoading && !clickupCheckingTimedOut ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-clickup-roster-loading">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading team connections…
                </div>
              ) : clickupConnectedError ? (
                <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-clickup-roster-error">
                  <AlertCircle className="w-3 h-3 flex-shrink-0" />
                  <span>Couldn't load team connection status.</span>
                </div>
              ) : clickupConnectedData && Array.isArray(clickupConnectedData.connectedUsers) ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground" data-testid="text-clickup-connected-count">
                    {clickupConnectedData.connectedUsers.filter((u) => u.status === "connected").length} of {clickupConnectedData.totalTeamMembers} team members connected
                  </p>
                  {clickupConnectedData.connectedUsers.length > 0 && (
                    <ul className="space-y-0.5">
                      {clickupConnectedData.connectedUsers.map((u) => {
                        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "Unknown user";
                        return (
                          <li key={u.userId} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`row-clickup-user-${u.userId}`}>
                            {u.status === "connected" ? (
                              <CheckCircle className="w-3 h-3 text-green-600 flex-shrink-0" />
                            ) : (
                              <AlertCircle className="w-3 h-3 text-amber-600 flex-shrink-0" />
                            )}
                            <span className="truncate">
                              {name}
                              {u.clickupEmail ? <span className="text-muted-foreground"> · {u.clickupEmail}</span> : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
              {/* Task #3662 — Ads OS COMPANY token: runtime rotation, no republish */}
              <div className="rounded border border-border bg-muted/50 px-3 py-2 space-y-2" data-testid="section-clickup-company-token">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">Ads OS company token</p>
                  <Badge
                    variant="outline"
                    className={
                      clickupCompanyTokenStatus?.source === "db"
                        ? "text-caption bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                        : clickupCompanyTokenStatus?.source === "env"
                          ? "text-caption bg-muted text-muted-foreground border-border"
                          : "text-caption bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800"
                    }
                    data-testid="badge-clickup-company-source"
                  >
                    {clickupCompanyTokenStatus
                      ? clickupCompanyTokenStatus.source === "db"
                        ? "Runtime override"
                        : clickupCompanyTokenStatus.source === "env"
                          ? "Env secret"
                          : "Not configured"
                      : clickupCompanyStatusError
                        ? "Status unknown"
                        : "Checking…"}
                  </Badge>
                </div>
                <p className="text-caption text-muted-foreground">
                  Shared company token behind the Ads OS Client List directory, dashboard ticket pushes and hygiene alerts.
                  Pasting a new token here reaches all production instances within ~1 minute — no republish needed.
                </p>
                {clickupCompanyTokenStatus?.directory && (
                  clickupCompanyTokenStatus.directory.live ? (
                    <p className="flex items-center gap-1.5 text-caption text-green-700" data-testid="text-clickup-company-directory-health">
                      <CheckCircle className="w-3 h-3 flex-shrink-0" />
                      <span>
                        Client List directory live
                        {clickupCompanyTokenStatus.directory.lastSuccessAt
                          ? ` — last fetch ${new Date(clickupCompanyTokenStatus.directory.lastSuccessAt).toLocaleString()}`
                          : ""}
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5 text-caption text-amber-700" data-testid="text-clickup-company-directory-health">
                      <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>{clickupCompanyTokenStatus.directory.reason || "Directory not live yet."}</span>
                    </p>
                  )
                )}
                {clickupCompanyTokenStatus?.dbOverride && clickupCompanyTokenStatus.lastEdited?.updatedAt && (
                  <p className="text-caption text-muted-foreground" data-testid="text-clickup-company-last-rotated">
                    Last rotated {new Date(clickupCompanyTokenStatus.lastEdited.updatedAt).toLocaleString()}
                    {clickupCompanyTokenStatus.lastEdited.updatedBy
                      ? ` by ${[clickupCompanyTokenStatus.lastEdited.updatedBy.firstName, clickupCompanyTokenStatus.lastEdited.updatedBy.lastName].filter(Boolean).join(" ") || clickupCompanyTokenStatus.lastEdited.updatedBy.email || "unknown"}`
                      : ""}
                  </p>
                )}
                <Input
                  type="password"
                  autoComplete="off"
                  className="h-8 text-xs"
                  placeholder="Paste new ClickUp API token (pk_…) — write-only, never displayed"
                  value={clickupCompanyToken}
                  onChange={(e) => {
                    setClickupCompanyToken(e.target.value);
                    setClickupCompanyTestResult(null);
                  }}
                  data-testid="input-clickup-company-token"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={clickupCompanyTestMutation.isPending}
                    onClick={() => clickupCompanyTestMutation.mutate(clickupCompanyToken)}
                    data-testid="button-clickup-company-test"
                  >
                    {clickupCompanyTestMutation.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : null}
                    Test connection{clickupCompanyToken.trim() ? "" : " (active token)"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!clickupCompanyToken.trim() || clickupCompanySaveMutation.isPending}
                    onClick={() => clickupCompanySaveMutation.mutate(clickupCompanyToken)}
                    data-testid="button-clickup-company-save"
                  >
                    {clickupCompanySaveMutation.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : null}
                    Save & activate
                  </Button>
                  {clickupCompanyTokenStatus?.dbOverride && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={clickupCompanyClearMutation.isPending}
                      onClick={() => clickupCompanyClearMutation.mutate()}
                      data-testid="button-clickup-company-clear"
                    >
                      Clear override
                    </Button>
                  )}
                </div>
                {clickupCompanyTestResult && (
                  clickupCompanyTestResult.ok ? (
                    <p className="text-caption text-green-700" data-testid="text-clickup-company-test-result">
                      ✓ Connection OK — {clickupCompanyTestResult.clients ?? "?"} clients in the Client List
                      {" "}({clickupCompanyTestResult.testedToken === "candidate" ? "pasted token" : "currently active token"}).
                    </p>
                  ) : (
                    <p className="text-caption text-red-700 break-words" data-testid="text-clickup-company-test-result">
                      ✗ {clickupCompanyTestResult.error || "Connection failed."}
                    </p>
                  )
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" asChild data-testid="button-clickup-connect">
                  <a href="/profile?tab=account">
                    <Plug className="w-3 h-3 mr-1" /> Connect
                  </a>
                </Button>
                <Button size="sm" variant="outline" asChild data-testid="button-clickup-open">
                  <Link href="/admin/clickup">
                    <ExternalLink className="w-3 h-3 mr-1" /> Open ClickUp Module
                  </Link>
                </Button>
              </div>
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="google-ads"
            cardTestId="card-google-ads-integration"
            icon={<BarChart3 className="w-5 h-5 text-blue-600" />}
            name="Google Ads"
            badge={
              // Task #4008 — unified single-credential model: one badge for
              // the one env credential. Secrets-missing wins (nothing can
              // run), then a terminal Google rejection, then Connected.
              status?.googleAds?.configured === false ? (
                <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-google-ads-status">
                  <AlertTriangle className="w-3 h-3 mr-1" /> Secrets Missing
                </Badge>
              ) : status?.googleAds?.adsOs?.health === "token_rejected" ? (
                <Badge variant="outline" className="ml-auto bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800" data-testid="badge-google-ads-status">
                  <AlertTriangle className="w-3 h-3 mr-1" /> Credentials Rejected
                </Badge>
              ) : status?.googleAds?.connected === true ? (
                <Badge variant="outline" className="ml-auto bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800" data-testid="badge-google-ads-status">Connected</Badge>
              ) : (
                <Badge variant="outline" className="ml-auto bg-muted/50 text-muted-foreground border-border" data-testid="badge-google-ads-status">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Checking…
                </Badge>
              )
            }
            mobileOrderClass={mobileOrderClassById["google-ads"]}
            highlighted={highlightedCardId === "google-ads"}
          >
              {status?.googleAds?.configured === null || status?.googleAds?.configured === undefined ? (
                <CheckingConnection
                  name="Google Ads"
                  idSlug="google-ads"
                  testId="text-google-ads-config-checking"
                  label="Checking configuration…"
                  timedOut={statusCheckTimedOut("google-ads")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.googleAds?.configured === false ? (
                <p className="text-xs text-muted-foreground" data-testid="text-google-ads-not-configured">
                  Set <code>GOOGLE_ADS_CLIENT_ID</code>, <code>GOOGLE_ADS_CLIENT_SECRET</code>, <code>GOOGLE_ADS_REFRESH_TOKEN</code>, <code>GOOGLE_ADS_DEVELOPER_TOKEN</code>, and <code>GOOGLE_ADS_LOGIN_CUSTOMER_ID</code> in environment secrets to enable. See <code>GOOGLE_ADS.md</code>.
                </p>
              ) : (
                <>
                  {status?.googleAds?.loginCustomerId && (
                    <p className="text-xs text-muted-foreground" data-testid="text-google-ads-mcc">
                      MCC: <span className="font-mono">{status.googleAds.loginCustomerId}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {status?.googleAds?.connected === null || status?.googleAds?.connected === undefined ? (
                      <CheckingConnection
                        name="Google Ads"
                        idSlug="google-ads"
                        testId="text-google-ads-checking"
                        timedOut={statusCheckTimedOut("google-ads")}
                        onRetry={retryStatusCheck}
                      />
                    ) : status?.googleAds?.connected === true ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => googleAdsDiscoverMutation.mutate()}
                          disabled={googleAdsDiscoverMutation.isPending}
                          data-testid="button-google-ads-discover"
                        >
                          {googleAdsDiscoverMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                          Discover Customers
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => googleAdsSyncNowMutation.mutate()}
                          disabled={googleAdsSyncNowMutation.isPending}
                          data-testid="button-google-ads-sync-now"
                        >
                          {googleAdsSyncNowMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                          Sync Now
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {status?.googleAds?.connected && (googleAdsCustomersData?.customers?.length ?? 0) > 0 && (
                    <div className="mt-2 border rounded p-2" data-testid="panel-google-ads-customers">
                      <div className="text-caption font-semibold text-foreground mb-1">
                        Customers ({googleAdsCustomersData?.customers?.length ?? 0})
                      </div>
                      <ul className="text-caption text-muted-foreground space-y-0.5 max-h-32 overflow-y-auto">
                        {googleAdsCustomersData?.customers?.map((c) => (
                          <li key={c.customerId} data-testid={`text-google-ads-customer-${c.customerId}`} className="flex items-center gap-2">
                            <span className="font-mono">{c.customerId}</span>
                            <span className="flex-1 truncate">
                              {c.descriptiveName || (
                                <span className="italic text-muted-foreground">Unnamed account</span>
                              )}
                            </span>
                            {c.isManager && <Badge variant="outline" className="h-4 text-caption">MCC</Badge>}
                            {c.syncEnabled ? (
                              <Badge variant="outline" className="h-4 text-caption bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800">sync on</Badge>
                            ) : (
                              <Badge variant="outline" className="h-4 text-caption bg-muted/50 text-muted-foreground">sync off</Badge>
                            )}
                            {!c.isManager && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-5 px-1.5 text-caption"
                                onClick={() => googleAdsToggleSyncMutation.mutate({ customerId: c.customerId, syncEnabled: !c.syncEnabled })}
                                disabled={googleAdsToggleSyncMutation.isPending}
                                data-testid={`button-google-ads-toggle-sync-${c.customerId}`}
                              >
                                {c.syncEnabled ? "Disable" : "Enable"}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {status?.googleAds?.connected && (googleAdsRunsData?.runs?.length ?? 0) > 0 && (
                    <div className="mt-2 border rounded p-2" data-testid="panel-google-ads-sync-runs">
                      <div className="text-caption font-semibold text-foreground mb-1">Recent Sync Runs</div>
                      <ul className="text-caption text-muted-foreground space-y-0.5 max-h-24 overflow-y-auto">
                        {googleAdsRunsData?.runs?.slice(0, 5).map((r) => (
                          <li key={r.id} data-testid={`text-google-ads-run-${r.id}`}>
                            <span className="font-mono">{new Date(r.startedAt).toLocaleString()}</span>
                            {" · "}
                            <span className={r.status === "success" ? "text-green-700" : r.status === "failed" ? "text-red-600" : "text-muted-foreground"}>{r.status}</span>
                            {" · "}
                            campaigns {r.campaignsSynced}, keywords {r.keywordsSynced}
                            {r.errorMessage && <span className="text-red-600"> — {r.errorMessage}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
              {/* Task #4008 — THE credential lane (was "lane 2 of 2" under
                  Task #4000's split model). One env-secret trio powers every
                  Google Ads surface, so this single lane is the whole auth
                  story. Health comes from stored/cached state only —
                  rendering it never triggers a token refresh. */}
              {(() => {
                const adsOs = status?.googleAds?.adsOs;
                const view = deriveAdsOsLaneView(adsOs);
                return (
                  <div className="mt-3 pt-2 border-t" data-testid="lane-google-ads-adsos">
                    <div className="flex items-center gap-2">
                      <span className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Env credential (GOOGLE_ADS_* secrets)</span>
                      {!adsOs ? (
                        <Badge variant="outline" className="h-4 text-caption bg-muted/50 text-muted-foreground" data-testid="badge-google-ads-adsos-status">
                          Checking…
                        </Badge>
                      ) : adsOs.health === "not_configured" ? (
                        <Badge variant="outline" className="h-4 text-caption bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-google-ads-adsos-status">
                          Env Credentials Missing
                        </Badge>
                      ) : adsOs.health === "token_rejected" ? (
                        <Badge variant="outline" className="h-4 text-caption bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800" data-testid="badge-google-ads-adsos-status">
                          Token Rejected
                        </Badge>
                      ) : view.operating ? (
                        <Badge variant="outline" className="h-4 text-caption bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800" data-testid="badge-google-ads-adsos-status">
                          Healthy
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="h-4 text-caption bg-muted/50 text-muted-foreground" data-testid="badge-google-ads-adsos-status">
                          No Recent Data
                        </Badge>
                      )}
                    </div>
                    <p className="text-caption text-muted-foreground" data-testid="text-google-ads-adsos-powers">
                      Powers: Ads Hygiene, Discover Customers, campaign sync, pacing, dashboards, account alerts
                    </p>
                    {adsOs && (
                      <p className="text-caption text-muted-foreground" data-testid="text-google-ads-adsos-freshness">
                        {adsOs.lastDataUpdateAt
                          ? `Last data update: ${new Date(adsOs.lastDataUpdateAt).toLocaleString()}`
                          : "No Ads OS data pulled yet"}
                      </p>
                    )}
                    {adsOs?.health === "token_rejected" && adsOs.healthDetail && (
                      <p className="text-xs text-red-600" data-testid="text-google-ads-adsos-health-detail">
                        {adsOs.healthDetail}
                      </p>
                    )}
                    {/* Task #4008 — a terminal Google rejection stalls EVERY
                        Google Ads surface (single point of failure by
                        design); rotation is a secrets edit, not an in-app
                        reconnect. */}
                    {adsOs &&
                      (adsOs.health === "token_rejected" || adsOs.health === "not_configured") && (
                        <div className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1" data-testid="text-google-ads-adsos-attention">
                          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                          <span>
                            {adsOs.health === "not_configured"
                              ? "Env credentials are missing — every Google Ads surface (hygiene, customer sync, pacing, dashboards, alerts) is stalled until the GOOGLE_ADS_* secrets are set (see GOOGLE_ADS.md)."
                              : "Google rejected the env credential — every Google Ads surface is stalled. Rotate the GOOGLE_ADS_* secret trio together (matching client id / secret / refresh token) and restart; see the GOOGLE_ADS.md runbook."}
                          </span>
                        </div>
                      )}
                  </div>
                );
              })()}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="twilio"
            cardTestId="card-twilio-integration"
            icon={<Phone className="w-5 h-5 text-green-600" />}
            name="Twilio"
            badge={
              // Task #3406 — real connection badge from the cached
              // account-resource probe (was a static "SMS & Calling"
              // label before).
              <ConnectionBadge state={status?.twilio?.connected} testId="badge-twilio-status" />
            }
            mobileOrderClass={mobileOrderClassById["twilio"]}
            highlighted={highlightedCardId === "twilio"}
          >
              {status?.twilio?.connected === false && status?.twilio?.disconnectReason && (
                <div className="text-xs text-red-600" data-testid="text-twilio-disconnect-reason">
                  {status.twilio.disconnectReason === "credentials_missing"
                    ? "Twilio credentials are not configured. Add the Account SID and Auth Token under Manage Twilio."
                    : status.twilio.disconnectReason === "auth_failed"
                      ? "Twilio rejected the configured credentials. Re-save the Account SID and Auth Token."
                      : status.twilio.disconnectReason === "account_not_found"
                        ? "The configured Account SID was not found in Twilio."
                        : `Twilio disconnected — ${status.twilio.disconnectReason}`}
                </div>
              )}
              {status?.twilio?.connected === true && status?.twilio?.lastProbeError && (
                <div className="text-xs text-amber-600" data-testid="text-twilio-probe-error">
                  Last check failed — retrying ({status.twilio.lastProbeError})
                </div>
              )}
              {(status?.twilio?.connected === null || status?.twilio?.connected === undefined) && (
                // Task #4356 — Twilio previously showed nothing in the body
                // while the badge said "Checking…"; normalized with the
                // other cards' checking presentation.
                <CheckingConnection
                  name="Twilio"
                  idSlug="twilio"
                  testId="text-twilio-checking"
                  timedOut={statusCheckTimedOut("twilio")}
                  onRetry={retryStatusCheck}
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild data-testid="button-twilio-manage">
                  <Link href="/admin/twilio">
                    <ExternalLink className="w-3 h-3 mr-1" /> Manage Twilio
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild data-testid="button-twilio-call-archive">
                  <Link href="/admin/twilio/call-archive">
                    <ExternalLink className="w-3 h-3 mr-1" /> Call recording archive
                  </Link>
                </Button>
              </div>
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="semrush"
            cardTestId="card-semrush-integration"
            icon={<MapPin className="w-5 h-5 text-orange-600" />}
            name="Semrush"
            badge={(() => {
                  // Task #1975 — badge primary source is the cached
                  // outcome-aware `/api/integrations/all-status` probe;
                  // semrushStatus still drives the device-flow
                  // Expired / Pending sub-states (not present in
                  // all-status).
                  const semrushAll = (status as any)?.semrush as
                    | { connected: boolean | null; disconnectReason?: string | null; reconnectRequired?: boolean; authMode?: "api_key" | "oauth" }
                    | undefined;
                  // Task #3670 — key mode: badge derives from the key probe
                  // alone; device-flow Expired/Pending sub-states never apply.
                  if (semrushAll?.authMode === "api_key") {
                    return (
                      <span className="ml-auto flex items-center gap-1.5">
                        <Badge variant="outline" className="border-purple-400 text-purple-700 dark:border-purple-500 dark:text-purple-300" data-testid="badge-semrush-auth-mode">
                          API key
                        </Badge>
                        <ConnectionBadge state={semrushAll?.connected ?? null} testId="badge-semrush-status" />
                      </span>
                    );
                  }
                  // Task #2160 — amber "reconnect required" badge when the
                  // SEMrush auth-dead breaker is open, mirroring Zoom/Front.
                  // Evaluated BEFORE the connected check: `connected` is
                  // probe-cache driven and can stay true while the live,
                  // reconciled breaker is open, so the reconnect signal must win.
                  if (semrushAll?.reconnectRequired) {
                    return (
                      <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-semrush-status">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Reconnect Required
                      </Badge>
                    );
                  }
                  if (semrushAll?.connected === true) {
                    return <ConnectionBadge state={true} testId="badge-semrush-status" />;
                  }
                  if (semrushStatus?.expired) {
                    return <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-semrush-status">Expired</Badge>;
                  }
                  if (semrushStatus?.pendingAuth || semrushPolling) {
                    return <Badge variant="outline" className="ml-auto bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" data-testid="badge-semrush-status">Pending</Badge>;
                  }
                  return <ConnectionBadge state={semrushAll?.connected ?? null} testId="badge-semrush-status" />;
                })()}
            mobileOrderClass={mobileOrderClassById["semrush"]}
            highlighted={highlightedCardId === "semrush"}
          >
              {(() => {
                const semrushAll = status?.semrush;
                const breakerOpen = semrushAll?.breakerOpen;
                // Task #2225 — when the breaker is open but the probe cache has
                // no disconnectReason, translate the specific trip code so the
                // operator sees *why* (token revoked vs missing) rather than the
                // generic "auth breaker open" line.
                const breakerReason =
                  breakerOpen && !semrushAll?.disconnectReason
                    ? humanizeIntegrationDisconnectReason("SEMrush", semrushAll?.lastTrippedCode)
                    : null;
                return (
                  <>
                    {/* Task #2189 — surface the disconnect reason + breaker
                        timing/count detail whenever the breaker is open, not
                        only when `connected === false`. The probe cache can
                        keep `connected` true while the reconciled breaker is
                        open (that's when the "Reconnect Required" badge shows),
                        so the actionable detail must follow the badge. */}
                    {(breakerOpen || (semrushAll?.connected === false && semrushAll?.disconnectReason)) && (
                      <div
                        className="flex flex-col gap-1 text-xs text-red-700 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-950/30 dark:border-red-800 rounded px-2 py-1"
                        data-testid="text-semrush-disconnect-reason"
                      >
                        <span className="truncate" data-testid="text-semrush-disconnect-reason-detail">
                          {semrushAll?.disconnectReason
                            ? `Disconnected: ${semrushAll.disconnectReason}`
                            : breakerReason ?? "Semrush auth breaker open — reconnect required."}
                        </span>
                        {/* Task #2152 — when/until/how-many detail, mirroring Front. */}
                        {breakerOpen && (
                          <BreakerDetailRow
                            lastTrippedAt={semrushAll?.lastTrippedAt}
                            cooldownUntil={semrushAll?.cooldownUntil}
                            tripCount={semrushAll?.tripCount}
                            testIdPrefix="semrush"
                          />
                        )}
                      </div>
                    )}
                    {semrushAll?.lastProbeError && (
                      <p
                        className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                        data-testid="text-semrush-last-probe-error"
                      >
                        Probe error (preserving last known state): {semrushAll.lastProbeError}
                      </p>
                    )}
                    {/* Task #3661 — durable "why + when + what to do" forensics
                        record for the current/most-recent disconnect. */}
                    {(breakerOpen ||
                      semrushAll?.reconnectRequired ||
                      semrushAll?.connected === false) &&
                      semrushAll?.forensics && (
                        <DisconnectForensicsPanel
                          record={semrushAll.forensics}
                          testIdPrefix="semrush"
                        />
                      )}
                    {/* Task #3690 — persistent "API key rejected" warning while
                        a key-mode rejection streak is active; clears
                        automatically once a key-mode call succeeds. */}
                    {semrushAll?.authMode === "api_key" && semrushAll?.keyRejection?.keyRejected && (
                      <div
                        className="flex flex-col gap-0.5 text-xs text-red-800 bg-red-50 border border-red-300 rounded px-2 py-1.5"
                        data-testid="banner-semrush-key-rejected"
                      >
                        <span className="font-medium">
                          API key rejected — rotate SEMRUSH_V4_API_KEY and republish.
                        </span>
                        <span data-testid="text-semrush-key-rejected-detail">
                          {semrushAll.keyRejection.consecutiveRejections} consecutive key-mode call
                          {semrushAll.keyRejection.consecutiveRejections === 1 ? "" : "s"} rejected
                          {semrushAll.keyRejection.lastRejectionStatus
                            ? ` (latest HTTP ${semrushAll.keyRejection.lastRejectionStatus})`
                            : ""}
                          {semrushAll.keyRejection.lastRejectionAt
                            ? `; last rejection ${new Date(semrushAll.keyRejection.lastRejectionAt).toLocaleString()}`
                            : ""}
                          .{" "}
                          {semrushAll.keyRejection.streakAlertFired
                            ? "Operator alert was sent for this streak."
                            : "Operator alert not yet sent for this streak."}{" "}
                          This is not an OAuth problem — do not use the reconnect flow. Clears
                          automatically once a key-authenticated call succeeds.
                        </span>
                      </div>
                    )}
                    {/* Task #3670 — API-key mode: explicit indicator + last
                        successful key-authenticated call. OAuth machinery
                        (device flow, keep-alive, breaker) is dormant. */}
                    {semrushAll?.authMode === "api_key" && (
                      <p
                        className="text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded px-2 py-1"
                        data-testid="text-semrush-api-key-mode"
                      >
                        Authenticated via v4 API key (SEMRUSH_V4_API_KEY). OAuth device flow, token
                        keep-alive, and reconnect prompts are dormant.
                        {semrushAll?.keyModeLastSuccessAt
                          ? ` Last successful call: ${new Date(semrushAll.keyModeLastSuccessAt).toLocaleString()}.`
                          : " No successful call recorded yet."}
                      </p>
                    )}
                    {/* Task #3661 — keep-alive heartbeat: makes "the proactive
                        token keep-alive silently isn't running" visible. */}
                    {(() => {
                      const hb = semrushAll?.keepAliveHeartbeat;
                      if (semrushAll?.authMode === "api_key") {
                        return (
                          <p className="text-caption text-muted-foreground" data-testid="text-semrush-keepalive-heartbeat">
                            Token keep-alive: dormant (API-key mode — nothing expires).
                          </p>
                        );
                      }
                      if (!hb) {
                        return (
                          <p className="text-caption text-muted-foreground" data-testid="text-semrush-keepalive-heartbeat">
                            Token keep-alive: no run recorded yet in this deployment.
                          </p>
                        );
                      }
                      return (
                        <p className="text-caption text-muted-foreground" data-testid="text-semrush-keepalive-heartbeat">
                          Token keep-alive: last ran {new Date(hb.lastRunAt).toLocaleString()} ({hb.lastAction})
                          {hb.lastSuccessAt
                            ? `; last success ${new Date(hb.lastSuccessAt).toLocaleString()}`
                            : "; no successful run recorded"}
                          {hb.lastError ? ` — ${hb.lastError}` : ""}
                        </p>
                      );
                    })()}
                  </>
                );
              })()}
              <Button size="sm" asChild data-testid="button-semrush-open-console">
                <Link href="/admin/integrations/semrush">
                  <ExternalLink className="w-3 h-3 mr-1" /> Open SEMrush Console
                </Link>
              </Button>
              {semrushCheckingTimedOut ? (
                // Task #4452 — bounded wait: a stalled initial status load
                // resolves to the shared couldn't-reach presentation instead
                // of an indefinite neutral state (rollup chip already flips;
                // the body now matches). Presentation only — probe/status
                // semantics untouched.
                <CheckingConnection
                  name="Semrush"
                  idSlug="semrush"
                  testId="text-semrush-checking"
                  timedOut
                  onRetry={retrySemrushStatusCheck}
                />
              ) : (status as any)?.semrush?.authMode === "api_key" ? (
                // Task #3670 — key mode: the device-flow connect/disconnect
                // controls are reserved for the no-key OAuth fallback. Rotate
                // or remove the SEMRUSH_V4_API_KEY secret to change auth.
                <p className="text-xs text-muted-foreground" data-testid="text-semrush-key-mode-controls">
                  Map Rank Tracker ready. Manage the connection by rotating the SEMRUSH_V4_API_KEY
                  secret; device-flow connect is only used when the key is absent.
                </p>
              ) : (((status as any)?.semrush?.connected === true) || semrushStatus?.connected) ? (
                <>
                  <p className="text-sm text-muted-foreground">Map Rank Tracker ready</p>
                  {semrushSyncState && (semrushSyncState.outcomeTotals as any)?.pausedAuth > 0 && (
                    <div
                      className="text-xs border border-orange-300 bg-orange-50 text-orange-900 rounded px-2 py-1.5"
                      data-testid="banner-semrush-paused-auth"
                    >
                      <span className="font-medium">Semrush not connected for sweep —</span>{" "}
                      {(semrushSyncState.outcomeTotals as any)?.pausedAuth} client(s) paused. Reconnect above to resume.
                    </div>
                  )}
                  {(semrushSyncState?.outcomeTotals?.totalIntegrations ?? 0) > 0 && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-semrush-outcome-totals"
                    >
                      <span className="text-green-700">{semrushSyncState?.outcomeTotals?.freshlySynced} freshly synced</span>
                      {" · "}
                      <span className="text-sky-700">{semrushSyncState?.outcomeTotals?.alreadyCurrent} already current</span>
                      {" · "}
                      <span className="text-amber-700">{semrushSyncState?.outcomeTotals?.partiallyRefreshed} partially refreshed</span>
                      {" · "}
                      <span className="text-red-700">{semrushSyncState?.outcomeTotals?.failed} failed</span>
                      {(semrushSyncState?.outcomeTotals as any)?.pausedAuth > 0 && (
                        <>
                          {" · "}
                          <span className="text-orange-700">{(semrushSyncState?.outcomeTotals as any)?.pausedAuth} paused (auth)</span>
                        </>
                      )}
                      {(semrushSyncState?.outcomeTotals?.neverRun ?? 0) > 0 && (
                        <>
                          {" · "}
                          <span className="text-muted-foreground">{semrushSyncState?.outcomeTotals?.neverRun} never run</span>
                        </>
                      )}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => semrushDisconnectMutation.mutate()} data-testid="button-semrush-disconnect">
                      <Unplug className="w-3 h-3 mr-1" /> Disconnect
                    </Button>
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setCredentialHistoryProvider("semrush")} data-testid="button-semrush-credential-history">
                      <History className="w-3 h-3 mr-1" /> View history
                    </Button>
                  </div>
                </>
              ) : ((status as any)?.semrush?.connected === false && semrushStatus?.expired) ? (
                <div className="space-y-2">
                  <p className="text-sm text-amber-700" data-testid="text-semrush-expired">Your Semrush session has expired — please re-authorize.</p>
                  <Button size="sm" variant="outline" onClick={() => semrushAuthMutation.mutate()} disabled={semrushAuthMutation.isPending} data-testid="button-semrush-reconnect">
                    {semrushAuthMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plug className="w-3 h-3 mr-1" />}
                    Re-connect Semrush
                  </Button>
                </div>
              ) : semrushStatus?.pendingAuth || semrushPolling ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-amber-600">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Waiting for approval...
                  </div>
                  {semrushStatus?.pendingAuth && (
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs bg-muted px-2 py-1 rounded font-mono font-bold">{semrushStatus.pendingAuth.userCode}</code>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => { void navigator.clipboard.writeText(semrushStatus.pendingAuth!.userCode); /* fire-and-forget: clipboard write */ toast({ title: "Copied!" }); }}>
                        <Copy className="w-3 h-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => window.open(semrushStatus.pendingAuth!.verificationUri, "_blank")}>
                        <ExternalLink className="w-3 h-3 mr-1" /> Open
                      </Button>
                    </div>
                  )}
                </div>
              ) : (semrushStatusUnknown || allStatusUnknownNoData) && (status as any)?.semrush?.connected !== false ? (
                // Task #2820 — the dedicated status probe is temporarily
                // unanswerable (status-unknown 503) and all-status has NOT
                // confirmed a disconnect, so a "Connect Semrush" button would
                // be a false not-connected. Render neutral instead.
                // Task #2830 — same guard when the AGGREGATE all-status route
                // is status-unknown with no data yet (cold mount during a
                // blip): don't fall through to "Connect Semrush".
                <div className="text-xs text-muted-foreground flex items-center gap-2" data-testid="text-semrush-status-unknown">
                  <Loader2 className="w-3 h-3 animate-spin" /> Status check temporarily unavailable — retrying. This is not a disconnect.
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => semrushAuthMutation.mutate()} disabled={semrushAuthMutation.isPending} data-testid="button-semrush-connect">
                  {semrushAuthMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plug className="w-3 h-3 mr-1" />}
                  Connect Semrush
                </Button>
              )}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="pandadoc"
            cardTestId="card-pandadoc-integration"
            icon={<FileText className="w-5 h-5 text-green-600" />}
            name="PandaDoc"
            badge={<ConnectionBadge state={status?.pandadoc?.connected} testId="badge-pandadoc-status" />}
            mobileOrderClass={mobileOrderClassById["pandadoc"]}
            highlighted={highlightedCardId === "pandadoc"}
          >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <LastEditedBadge info={status?.pandadoc?.lastEdited?.apiKey} testId="badge-last-edited-pandadoc-api-key" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                  onClick={() => setCredentialHistoryProvider("pandadoc")}
                  data-testid="button-pandadoc-credential-history"
                >
                  <History className="w-3 h-3 mr-1" /> View history
                </Button>
              </div>
              {status?.pandadoc?.connected === null || status?.pandadoc?.connected === undefined ? (
                <CheckingConnection
                  name="PandaDoc"
                  idSlug="pandadoc"
                  testId="text-pandadoc-checking"
                  timedOut={statusCheckTimedOut("pandadoc")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.pandadoc?.connected === true ? (
                <>
                  <p className="text-sm text-muted-foreground">Contracts & documents</p>
                  {status?.pandadoc.lastProbeError && (
                    // Task #1888: transient probe failure without flipping
                    // the Connected badge.
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-pandadoc-probe-failed">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last check failed — retrying ({status.pandadoc.lastProbeError})</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => pandadocSyncMutation.mutate()} disabled={pandadocSyncMutation.isPending} data-testid="button-pandadoc-sync">
                      {pandadocSyncMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                      Sync Documents
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => pandadocDisconnectMutation.mutate()} data-testid="button-pandadoc-disconnect">
                      <Unplug className="w-3 h-3 mr-1" /> Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/* Task #1888: explain *why* PandaDoc shows disconnected. */}
                  {(() => {
                    const text = humanizeIntegrationDisconnectReason("PandaDoc", status?.pandadoc?.disconnectReason);
                    return text ? (
                      <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded px-2 py-1 mb-2" data-testid="text-pandadoc-disconnect-reason">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{text}</span>
                      </div>
                    ) : null;
                  })()}
                  <Button size="sm" variant="outline" onClick={() => setPandadocKeyDialog(true)} data-testid="button-pandadoc-connect">
                    <Plug className="w-3 h-3 mr-1" /> Connect PandaDoc
                  </Button>
                </>
              )}
          </IntegrationCardShell>

          <IntegrationCardShell
            integrationId="ghl"
            cardTestId="card-ghl-integration"
            icon={<Phone className="w-5 h-5 text-emerald-600" />}
            name="HighLevel"
            badge={<ConnectionBadge state={status?.ghl?.connected} testId="badge-ghl-status" />}
            mobileOrderClass={mobileOrderClassById["ghl"]}
            highlighted={highlightedCardId === "ghl"}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <LastEditedBadge info={status?.ghl?.lastEdited?.token} testId="badge-last-edited-ghl-token" />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-caption text-muted-foreground hover:text-foreground"
                onClick={() => setCredentialHistoryProvider("ghl")}
                data-testid="button-ghl-credential-history"
              >
                <History className="w-3 h-3 mr-1" /> View history
              </Button>
            </div>
            {status?.ghl?.connected === null || status?.ghl?.connected === undefined ? (
              <CheckingConnection
                name="HighLevel"
                idSlug="ghl"
                testId="text-ghl-checking"
                timedOut={statusCheckTimedOut("ghl")}
                onRetry={retryStatusCheck}
              />
            ) : status.ghl.connected ? (
              <>
                <p className="text-sm text-muted-foreground">CRM contact and operations mirror</p>
                {status.ghl.lastProbeError && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-ghl-probe-failed">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">Last check failed — retrying ({status.ghl.lastProbeError})</span>
                  </div>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  onClick={() => ghlDisconnectMutation.mutate()}
                  data-testid="button-ghl-disconnect"
                >
                  <Unplug className="w-3 h-3 mr-1" /> Disconnect
                </Button>
              </>
            ) : (
              <>
                {(() => {
                  const text = humanizeIntegrationDisconnectReason("HighLevel", status?.ghl?.disconnectReason);
                  return text ? (
                    <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded px-2 py-1" data-testid="text-ghl-disconnect-reason">
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{text}</span>
                    </div>
                  ) : null;
                })()}
                <Button size="sm" variant="outline" onClick={() => setGhlCredentialsDialog(true)} data-testid="button-ghl-connect">
                  <Plug className="w-3 h-3 mr-1" /> Connect HighLevel
                </Button>
              </>
            )}
          </IntegrationCardShell>


          <IntegrationCardShell
            integrationId="stripe"
            cardTestId="card-stripe-integration"
            icon={<CreditCard className="w-5 h-5 text-primary" />}
            name="Stripe"
            badge={<ConnectionBadge state={status?.stripe?.connected} testId="badge-stripe-status" />}
            mobileOrderClass={mobileOrderClassById["stripe"]}
            highlighted={highlightedCardId === "stripe"}
          >
              <LastEditedBadge info={status?.stripe?.lastEdited?.secretKey} testId="badge-last-edited-stripe-secret-key" />
              <p className="text-xs text-muted-foreground">Billing, subscriptions & payment tracking for client profiles</p>
              {status?.stripe?.connected === null || status?.stripe?.connected === undefined ? (
                <CheckingConnection
                  name="Stripe"
                  idSlug="stripe"
                  testId="text-stripe-checking"
                  timedOut={statusCheckTimedOut("stripe")}
                  onRetry={retryStatusCheck}
                />
              ) : status?.stripe?.connected === true ? (
                <>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle className="w-3 h-3 text-green-600" /> Stripe data syncing
                  </div>
                  {status?.stripe.lastProbeError && (
                    // Task #1888: transient probe failure without flipping
                    // the Connected badge.
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30 rounded px-2 py-1" data-testid="text-stripe-probe-failed">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">Last check failed — retrying ({status.stripe.lastProbeError})</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => stripeDisconnectMutation.mutate()} data-testid="button-stripe-disconnect">
                      <Unplug className="w-3 h-3 mr-1" /> Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/* Task #1888: explain *why* Stripe shows disconnected. */}
                  {(() => {
                    const text = humanizeIntegrationDisconnectReason("Stripe", status?.stripe?.disconnectReason);
                    return text ? (
                      <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded px-2 py-1 mb-2" data-testid="text-stripe-disconnect-reason">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{text}</span>
                      </div>
                    ) : null;
                  })()}
                  <Button size="sm" variant="outline" onClick={() => setStripeKeyDialog(true)} data-testid="button-stripe-connect">
                    <Plug className="w-3 h-3 mr-1" /> Connect Stripe
                  </Button>
                </>
              )}
          </IntegrationCardShell>
        </div>

        <BackfillJobsPanel />
      </div>

      <Dialog open={slackTokenDialog} onOpenChange={setSlackTokenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Slack</DialogTitle>
            <DialogDescription>Enter your Slack Bot Token (starts with xoxb-). You can find this in your Slack App settings at api.slack.com/apps.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="slack-token">Bot Token</Label>
            <Input
              id="slack-token"
              placeholder="xoxb-..."
              value={slackToken}
              onChange={(e) => setSlackToken(e.target.value)}
              data-testid="input-slack-token"
            />
            {slackToken.length > 0 && !slackToken.startsWith("xoxb-") && (
              <p
                className="text-xs text-amber-700"
                data-testid="text-slack-token-hint"
              >
                {slackToken.startsWith("xoxe.") || slackToken.startsWith("xoxp-")
                  ? "That looks like a Slack user token (xoxp- / xoxe.xoxp-). NoBull OS needs the Bot User OAuth Token from your Slack app's OAuth & Permissions page — it starts with xoxb-."
                  : "Slack Bot tokens start with xoxb-. Copy the Bot User OAuth Token from your Slack app's OAuth & Permissions page."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSlackTokenDialog(false)}>Cancel</Button>
            <Button
              onClick={() => slackConnectMutation.mutate(slackToken)}
              disabled={!slackToken.startsWith("xoxb-") || slackConnectMutation.isPending}
              data-testid="button-slack-submit-token"
            >
              {slackConnectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pandadocKeyDialog} onOpenChange={setPandadocKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect PandaDoc</DialogTitle>
            <DialogDescription>Enter your PandaDoc API key. You can find this in PandaDoc Settings → API → API Key.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="pandadoc-key">API Key</Label>
            <Input
              id="pandadoc-key"
              placeholder="Enter your PandaDoc API key..."
              value={pandadocApiKey}
              onChange={(e) => setPandadocApiKey(e.target.value)}
              data-testid="input-pandadoc-api-key"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPandadocKeyDialog(false)}>Cancel</Button>
            <Button
              onClick={() => pandadocConnectMutation.mutate(pandadocApiKey)}
              disabled={!pandadocApiKey.trim() || pandadocConnectMutation.isPending}
              data-testid="button-pandadoc-submit-key"
            >
              {pandadocConnectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ghlCredentialsDialog} onOpenChange={setGhlCredentialsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect HighLevel</DialogTitle>
            <DialogDescription>
              Enter a private integration token and its approved sub-account location ID. This connection mirrors CRM operations only; payments, access, orders, refunds, and consent stay in NoBull OS.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ghl-private-token">Private integration token</Label>
              <Input
                id="ghl-private-token"
                type="password"
                autoComplete="off"
                value={ghlPrivateToken}
                onChange={(e) => setGhlPrivateToken(e.target.value)}
                data-testid="input-ghl-private-token"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ghl-location-id">Approved location ID</Label>
              <Input
                id="ghl-location-id"
                autoComplete="off"
                value={ghlLocationId}
                onChange={(e) => setGhlLocationId(e.target.value)}
                data-testid="input-ghl-location-id"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGhlCredentialsDialog(false)}>Cancel</Button>
            <Button
              onClick={() => ghlConnectMutation.mutate({ privateToken: ghlPrivateToken, locationId: ghlLocationId })}
              disabled={ghlPrivateToken.trim().length < 12 || !ghlLocationId.trim() || ghlConnectMutation.isPending}
              data-testid="button-ghl-submit-credentials"
            >
              {ghlConnectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stripeKeyDialog} onOpenChange={setStripeKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Stripe</DialogTitle>
            <DialogDescription>Enter your Stripe Secret Key. You can find this in the Stripe Dashboard under Developers → API Keys.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="stripe-key">Secret Key</Label>
            <Input
              id="stripe-key"
              type="password"
              placeholder="sk_live_... or sk_test_..."
              value={stripeSecretKey}
              onChange={(e) => setStripeSecretKey(e.target.value)}
              data-testid="input-stripe-secret-key"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStripeKeyDialog(false)}>Cancel</Button>
            <Button
              onClick={() => stripeConnectMutation.mutate(stripeSecretKey)}
              disabled={!stripeSecretKey.trim() || stripeConnectMutation.isPending}
              data-testid="button-stripe-submit-key"
            >
              {stripeConnectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={resetSyncDialog} onOpenChange={setResetSyncDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Front Sync</DialogTitle>
            <DialogDescription>
              This will reset the sync cursor so all conversations are re-fetched from the beginning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="purge-records"
                checked={resetPurgeRecords}
                onChange={(e) => setResetPurgeRecords(e.target.checked)}
                className="rounded border-border"
                data-testid="checkbox-purge-records"
              />
              <Label htmlFor="purge-records" className="text-sm">Also purge all existing sync records</Label>
            </div>
            {resetPurgeRecords && (
              <p className="text-xs text-red-600">This will delete all synced Front email records. They will be re-fetched on the next sync.</p>
            )}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="trigger-rescan"
                checked={resetTriggerRescan}
                onChange={(e) => setResetTriggerRescan(e.target.checked)}
                className="rounded border-border"
                data-testid="checkbox-trigger-rescan"
              />
              <Label htmlFor="trigger-rescan" className="text-sm">Run full re-scan immediately after reset</Label>
            </div>
            {resetTriggerRescan && (
              <p className="text-xs text-blue-600">After resetting, a full sync cycle will run immediately to re-fetch and re-match all conversations. This may take several minutes.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetSyncDialog(false); setResetPurgeRecords(false); setResetTriggerRescan(true); }} data-testid="button-cancel-reset-sync">Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => frontResetSyncMutation.mutate({ purgeRecords: resetPurgeRecords, triggerRescan: resetTriggerRescan })}
              disabled={frontResetSyncMutation.isPending}
              data-testid="button-confirm-reset-sync"
            >
              {frontResetSyncMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              {resetTriggerRescan ? "Full Re-scan" : "Reset Sync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rematchAllDialog} onOpenChange={(open) => { setRematchAllDialog(open); if (!open) { setRematchDryRunResult(null); setRematchLastResult(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rematch All Front Messages</DialogTitle>
            <DialogDescription>
              Re-run the full matching pipeline on all Front messages — including those already assigned to a client. If a better match is found, the assignment will be updated. Processes up to 100,000 messages per run; if more remain, you can continue from where it left off.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {!rematchDryRunResult && !rematchLastResult && !rematchAllDryRunMutation.isPending && !rematchAllMutation.isPending && (
              <p className="text-sm text-muted-foreground">This will re-run the matching pipeline on all Front messages. If a better match is found, the assignment will be updated.</p>
            )}
            {rematchAllDryRunMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-blue-600" data-testid="text-rematch-dry-run-loading">
                <Loader2 className="w-4 h-4 animate-spin" /> Running dry run preview...
              </div>
            )}
            {rematchJobRunning && (
              <div className="space-y-2" data-testid="text-rematch-running">
                <div className="flex items-center gap-2 text-sm text-indigo-600">
                  <Loader2 className="w-4 h-4 animate-spin" /> Rematch is running in the background...
                </div>
                {rematchProgress && (
                  <div className="p-3 bg-indigo-50 rounded-lg space-y-2">
                    <Progress value={Math.min((rematchProgress.processed / (rematchProgress.maxItems || rematchProgress.processed || 1)) * 100, 100)} className="h-2" />
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-muted-foreground">Processed:</div>
                      <div className="font-medium">{rematchProgress.processed}</div>
                      <div className="text-muted-foreground">Newly matched:</div>
                      <div className="font-medium text-green-700 dark:text-green-400">{rematchProgress.newlyMatched ?? 0}</div>
                      <div className="text-muted-foreground">Reassigned:</div>
                      <div className="font-medium text-amber-700 dark:text-amber-400">{rematchProgress.reassigned ?? 0}</div>
                      <div className="text-muted-foreground">Unchanged:</div>
                      <div className="font-medium">{rematchProgress.unchanged ?? 0}</div>
                      <div className="text-muted-foreground">Errors:</div>
                      <div className="font-medium text-red-700">{rematchProgress.errors ?? 0}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {rematchDryRunResult && !rematchLastResult && !rematchAllMutation.isPending && (
              <div className="space-y-2 p-3 bg-blue-50 rounded-lg" data-testid="div-rematch-dry-run-results">
                <p className="text-sm font-medium text-blue-800">Dry Run Preview</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-muted-foreground">Total scanned:</div>
                  <div className="font-medium" data-testid="text-rematch-total">{rematchDryRunResult.total}</div>
                  <div className="text-muted-foreground">Would be reassigned:</div>
                  <div className="font-medium text-amber-700" data-testid="text-rematch-reassigned">{rematchDryRunResult.reassigned}</div>
                  <div className="text-muted-foreground">Newly matched:</div>
                  <div className="font-medium text-green-700" data-testid="text-rematch-newly-matched">{rematchDryRunResult.newlyMatched}</div>
                  <div className="text-muted-foreground">Unchanged:</div>
                  <div className="font-medium" data-testid="text-rematch-unchanged">{rematchDryRunResult.unchanged}</div>
                  <div className="text-muted-foreground">Skipped (spam):</div>
                  <div className="font-medium" data-testid="text-rematch-spam">{rematchDryRunResult.skippedSpam}</div>
                  <div className="text-muted-foreground">Errors:</div>
                  <div className="font-medium text-red-700" data-testid="text-rematch-errors">{rematchDryRunResult.errors}</div>
                </div>
                {(rematchDryRunResult.reassigned > 0 || rematchDryRunResult.newlyMatched > 0) && (
                  <p className="text-xs text-amber-700 mt-2">Proceeding will update {rematchDryRunResult.reassigned + rematchDryRunResult.newlyMatched} message assignments.</p>
                )}
              </div>
            )}
            {rematchLastResult && !rematchAllMutation.isPending && (
              <div className={`space-y-2 p-3 rounded-lg ${rematchLastResult.resumable ? "bg-amber-50" : "bg-green-50"}`} data-testid="div-rematch-results">
                <p className={`text-sm font-medium ${rematchLastResult.resumable ? "text-amber-800" : "text-green-800"}`}>
                  {rematchLastResult.resumable ? "Batch Complete — More Messages Remain" : "Rematch Complete"}
                </p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-muted-foreground">Total processed:</div>
                  <div className="font-medium" data-testid="text-result-total">{rematchLastResult.total}</div>
                  <div className="text-muted-foreground">Reassigned:</div>
                  <div className="font-medium text-amber-700" data-testid="text-result-reassigned">{rematchLastResult.reassigned}</div>
                  <div className="text-muted-foreground">Newly matched:</div>
                  <div className="font-medium text-green-700" data-testid="text-result-newly-matched">{rematchLastResult.newlyMatched}</div>
                  <div className="text-muted-foreground">Unchanged:</div>
                  <div className="font-medium" data-testid="text-result-unchanged">{rematchLastResult.unchanged}</div>
                  <div className="text-muted-foreground">Skipped (spam):</div>
                  <div className="font-medium" data-testid="text-result-spam">{rematchLastResult.skippedSpam}</div>
                  <div className="text-muted-foreground">Errors:</div>
                  <div className="font-medium text-red-700" data-testid="text-result-errors">{rematchLastResult.errors}</div>
                </div>
                {rematchLastResult.resumable && (
                  <p className="text-xs text-amber-700 mt-2">The 100,000-message batch limit was reached. Click "Continue" to process the next batch from where this run left off.</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRematchAllDialog(false); setRematchDryRunResult(null); setRematchLastResult(null); }} data-testid="button-cancel-rematch-all">
              {rematchLastResult && !rematchLastResult.resumable ? "Done" : "Cancel"}
            </Button>
            {!rematchLastResult && !rematchAllMutation.isPending && (
              <Button
                variant="outline"
                onClick={() => rematchAllDryRunMutation.mutate()}
                disabled={rematchAllDryRunMutation.isPending}
                data-testid="button-rematch-dry-run"
              >
                {rematchAllDryRunMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                Preview Only
              </Button>
            )}
            {!rematchLastResult && (
              <Button
                onClick={() => rematchAllMutation.mutate({})}
                disabled={rematchAllMutation.isPending || rematchAllDryRunMutation.isPending || rematchJobRunning}
                data-testid="button-confirm-rematch-all"
              >
                {rematchAllMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                {rematchJobRunning ? "Rematch Running…" : "Run Rematch"}
              </Button>
            )}
            {rematchLastResult?.resumable && (
              <Button
                onClick={() => rematchAllMutation.mutate({ resume: true })}
                disabled={rematchAllMutation.isPending || rematchJobRunning}
                data-testid="button-continue-rematch"
              >
                {rematchAllMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                {rematchJobRunning ? "Rematch Running…" : "Continue"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CredentialHistoryDialog
        open={credentialHistoryProvider !== null}
        onClose={() => setCredentialHistoryProvider(null)}
        provider={credentialHistoryProvider ?? "front"}
      />
    </div>
  );
}

function DisconnectForensicsPanel({
  record,
  testIdPrefix,
}: {
  record: DisconnectForensicsRecord;
  testIdPrefix: string;
}) {
  const recordedAt = record.recordedAt ? new Date(record.recordedAt) : null;
  return (
    <div
      className="text-caption text-foreground bg-amber-50 border border-amber-200 rounded px-2 py-1.5 space-y-0.5"
      data-testid={`text-${testIdPrefix}-forensics`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium text-amber-900">Why disconnected</span>
        {recordedAt && (
          <span className="text-muted-foreground" data-testid={`text-${testIdPrefix}-forensics-at`} title={recordedAt.toLocaleString()}>
            {recordedAt.toLocaleString()}
          </span>
        )}
        <code className="text-amber-800" data-testid={`text-${testIdPrefix}-forensics-code-path`}>{record.codePath}</code>
        {record.purpose && <span className="text-muted-foreground">purpose: {record.purpose}</span>}
        {record.instanceId && <span className="text-muted-foreground">instance: {record.instanceId}</span>}
      </div>
      <div data-testid={`text-${testIdPrefix}-forensics-summary`}>{record.summary}</div>
      {record.providerError && (
        <div className="text-muted-foreground break-words font-mono" data-testid={`text-${testIdPrefix}-forensics-provider-error`}>
          {record.providerError}
        </div>
      )}
      {record.fingerprintOutcome && (
        <div className="text-muted-foreground" data-testid={`text-${testIdPrefix}-forensics-fingerprint`}>
          Fingerprint check: {record.fingerprintOutcome}
        </div>
      )}
      <div className="font-medium text-amber-900" data-testid={`text-${testIdPrefix}-forensics-action`}>
        → {record.operatorAction}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task #4356 — Integrations hub health rollup (audit P1-9 + §3.4).
// Everything below is presentation-only plumbing: a shared card skeleton, a
// bounded-wait "Checking connection…" element, and a rollup classifier that
// mirrors the per-card badge inputs 1:1. No probe or status semantics here.
// ---------------------------------------------------------------------------

/** Bounded wait before "Checking connection…" resolves to the explicit
 * couldn't-reach presentation (4 cycles of the 5s all-status poll). */
const CHECKING_TIMEOUT_MS = 20_000;

type IntegrationCardHealth = "healthy" | "attention" | "checking";

type IntegrationRollupEntry = {
  /** Anchor/testid slug — cards carry `id="integration-card-${id}"`. */
  id: string;
  /** Operator-facing display name for the jump chip. */
  name: string;
  state: IntegrationCardHealth;
  /** Short reason for the chip tooltip (attention entries only). */
  reason?: string;
};

/** Literal class list so Tailwind's scanner sees every `max-md:order-*`
 * utility we can assign (runtime-built class names would not compile). */
const MOBILE_ORDER_CLASSES = [
  "max-md:order-1",
  "max-md:order-2",
  "max-md:order-3",
  "max-md:order-4",
  "max-md:order-5",
  "max-md:order-6",
  "max-md:order-7",
  "max-md:order-8",
  "max-md:order-9",
];

function formatRollupFreshness(updatedAt: number, now: number): string {
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

/**
 * Rollup classifier. Each branch mirrors the corresponding card's badge
 * expression exactly (plus the card's own unconditional red/amber problem
 * banners), so the summary bar can never disagree with what the cards show.
 * Green badge → healthy; null-spinner badge → checking; every gray/amber/red
 * badge state → attention.
 */
function deriveIntegrationRollup(inputs: {
  status: IntegrationStatus | undefined;
  /** null = booking-health card absent (no data yet). */
  bookingReady: boolean | null;
  clickup: {
    loading: boolean;
    error: boolean;
    oauthConfigured: boolean | null;
    companySource: "db" | "env" | "none" | null;
    companyStatusError: boolean;
    directoryLive: boolean | null;
  };
  semrushExpired: boolean;
  semrushPending: boolean;
}): IntegrationRollupEntry[] {
  const { status, bookingReady, clickup, semrushExpired, semrushPending } = inputs;
  const entries: IntegrationRollupEntry[] = [];

  const badgeOnly = (
    id: string,
    name: string,
    connected: boolean | null | undefined,
    notConnectedReason = "Not connected",
  ): IntegrationRollupEntry =>
    connected === true
      ? { id, name, state: "healthy" }
      : connected === false
        ? { id, name, state: "attention", reason: notConnectedReason }
        : { id, name, state: "checking" };

  if (bookingReady !== null) {
    entries.push(
      bookingReady
        ? { id: "booking", name: "Booking System", state: "healthy" }
        : { id: "booking", name: "Booking System", state: "attention", reason: "Schema not ready" },
    );
  }

  // Front — ConnectionBadge(front.connected); the Task #3964 webhook-secret
  // warning renders even while Connected, so it also flags attention.
  const front = badgeOnly("front", "Front Email", status?.front?.connected);
  entries.push(
    front.state === "healthy" && status?.front?.webhookSecretConfigured === false
      ? { ...front, state: "attention", reason: "Webhook secret not configured" }
      : front,
  );

  // Slack — ConnectionBadge(slack.connected).
  entries.push(badgeOnly("slack", "Slack", status?.slack?.connected));

  // Zoom — the amber "Reconnect Required" badge wins over the connection badge.
  const zoomReconnectNeeded =
    !!status?.zoom?.reconnectRequired?.authGate ||
    (status?.zoom?.reconnectRequired?.scopeGates?.length ?? 0) > 0;
  entries.push(
    zoomReconnectNeeded
      ? { id: "zoom", name: "Zoom", state: "attention", reason: "Reconnect required" }
      : badgeOnly("zoom", "Zoom", status?.zoom?.connected),
  );

  // ClickUp — no connection badge (per-user OAuth); mirrors the card's own
  // notice blocks and the company-token source badge.
  {
    let state: IntegrationCardHealth = "healthy";
    let reason: string | undefined;
    if (clickup.oauthConfigured === false) {
      state = "attention";
      reason = "OAuth app credentials not configured";
    } else if (clickup.companySource === "none") {
      state = "attention";
      reason = "Ads OS company token not configured";
    } else if (clickup.directoryLive === false) {
      state = "attention";
      reason = "Client List directory not live";
    } else if (clickup.error || clickup.companyStatusError) {
      state = "attention";
      reason = "Status unavailable";
    } else if (clickup.loading || clickup.oauthConfigured === null || clickup.companySource === null) {
      state = "checking";
    }
    entries.push({ id: "clickup", name: "ClickUp", state, reason });
  }

  // Google Ads — mirrors the badge chain exactly (Task #4008 precedence:
  // Secrets Missing > Credentials Rejected > Connected > Checking…). A
  // `connected === false` blip deliberately presents as "Checking…".
  const ga = status?.googleAds;
  entries.push(
    ga?.configured === false
      ? { id: "google-ads", name: "Google Ads", state: "attention", reason: "Secrets missing" }
      : ga?.adsOs?.health === "token_rejected"
        ? { id: "google-ads", name: "Google Ads", state: "attention", reason: "Credentials rejected" }
        : ga?.connected === true
          ? { id: "google-ads", name: "Google Ads", state: "healthy" }
          : { id: "google-ads", name: "Google Ads", state: "checking" },
  );

  // Twilio — ConnectionBadge(twilio.connected).
  entries.push(badgeOnly("twilio", "Twilio", status?.twilio?.connected));

  // HighLevel — ConnectionBadge(ghl.connected).
  entries.push(badgeOnly("ghl", "HighLevel", status?.ghl?.connected));

  // SEMrush — mirrors the badge IIFE order: key-mode (+ rejection streak
  // banner), Reconnect Required, Connected, Expired, Pending, badge fallback.
  {
    const sem = status?.semrush;
    let entry: IntegrationRollupEntry;
    if (sem?.authMode === "api_key") {
      entry = sem?.keyRejection?.keyRejected
        ? { id: "semrush", name: "Semrush", state: "attention", reason: "API key rejected" }
        : badgeOnly("semrush", "Semrush", sem?.connected ?? null);
    } else if (sem?.reconnectRequired) {
      entry = { id: "semrush", name: "Semrush", state: "attention", reason: "Reconnect required" };
    } else if (sem?.connected === true) {
      entry = { id: "semrush", name: "Semrush", state: "healthy" };
    } else if (semrushExpired) {
      entry = { id: "semrush", name: "Semrush", state: "attention", reason: "Session expired" };
    } else if (semrushPending) {
      entry = { id: "semrush", name: "Semrush", state: "attention", reason: "Authorization pending approval" };
    } else {
      entry = badgeOnly("semrush", "Semrush", sem?.connected ?? null);
    }
    entries.push(entry);
  }

  // PandaDoc / Stripe — ConnectionBadge(connected).
  entries.push(badgeOnly("pandadoc", "PandaDoc", status?.pandadoc?.connected));
  entries.push(badgeOnly("stripe", "Stripe", status?.stripe?.connected));

  return entries;
}

/**
 * Task #4356 — the one normalized integration-card skeleton: header row
 * (icon · name · status badge), optional subtitle, then vendor-specific body
 * content. Also carries the rollup's jump anchor, the transient jump
 * highlight, and the mobile attention-first order class.
 */
function IntegrationCardShell({
  integrationId,
  cardTestId,
  icon,
  name,
  badge,
  subtitle,
  mobileOrderClass,
  highlighted,
  children,
}: {
  integrationId: string;
  cardTestId: string;
  icon: ReactNode;
  name: ReactNode;
  badge: ReactNode;
  subtitle?: ReactNode;
  mobileOrderClass?: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <Card
      id={`integration-card-${integrationId}`}
      className={[
        "bg-card scroll-mt-24 transition-shadow",
        mobileOrderClass ?? "",
        highlighted ? "ring-2 ring-amber-400" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={cardTestId}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {name}
          {badge}
        </CardTitle>
        {subtitle}
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

/**
 * Task #4356 — shared "Checking connection…" element with a bounded wait.
 * Pre-timeout markup is byte-identical to the blocks it replaced (tests
 * assert that copy). After CHECKING_TIMEOUT_MS of continuous checking it
 * resolves to an explicit couldn't-reach DegradedState with retry guidance —
 * purely presentational; the underlying nullable-status contract (Task
 * #1842) is untouched.
 */
function CheckingConnection({
  name,
  idSlug,
  testId,
  label = "Checking connection…",
  timedOut,
  onRetry,
}: {
  name: string;
  idSlug: string;
  testId: string;
  label?: string;
  timedOut: boolean;
  onRetry: () => void;
}) {
  if (!timedOut) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2" data-testid={testId}>
        <Loader2 className="w-3 h-3 animate-spin" /> {label}
      </div>
    );
  }
  return (
    <DegradedState
      testId={`degraded-${idSlug}-status-unreachable`}
      title={`Couldn't reach ${name} status`}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          data-testid={`button-${idSlug}-retry-status-check`}
        >
          <RefreshCw className="w-3 h-3 mr-1" /> Retry status check
        </Button>
      }
    >
      <div>
        The status check hasn't answered after {Math.round(CHECKING_TIMEOUT_MS / 1000)} seconds. This is
        a status-reporting problem, not a confirmed disconnect — {name} may still be working. Retry now,
        or reload the page; if this keeps happening the server may be busy or restarting.
      </div>
    </DegradedState>
  );
}
