import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type StatusState = "pending" | "applied" | "not-needed" | "error" | "blocked";
type OutcomeState = "applied" | "not-needed" | "error" | "blocked";

interface SelfHealReadout {
  lastRunAt: string;
  lastOutcome: OutcomeState;
  lastRowsAffected: number | null;
  nextEligibleAt: string;
  consecutiveFailures: number;
  lastErrorDetail: string | null;
  failureAlertSent: boolean;
  // Task #2124 — true once the reconnect-required (auth-dead) alert has
  // already paged admins for the current `blocked` streak.
  reconnectAlertSent: boolean;
}

interface ActionStatusRow {
  id: string;

  title: string;

  description: string;

  change: string;

  // Task #4762 — `working: true` on a pending status means the action's own
  // background drain is observably progressing right now (renders calm).
  status: { state: StatusState; detail: string; integration?: string; working?: boolean };

  selfHealEligible?: boolean;

  selfHeal?: SelfHealReadout | null;
  // Task #4019 — manual levers are excluded from Apply-all and fired via
  // their own button (POST /api/admin/prod-actions/:actionId/apply).
  manualLever?: boolean;
  destructiveConfirmation?: {
    phrase: string;
    warning: string;
  };
  // Task #4054 — declared convergence class: `converging` settles after one
  // apply; `continuous` is always-on maintenance drained by a named loop.

  convergence?: { kind: "converging" } | { kind: "continuous"; loop: string };
  // Task #4054 — true when a continuous action's routine pending work is
  // being drained by a verifiably-healthy loop (excluded from the badge).

  autoManaged?: boolean;

  autoManagedDetail?: string;
  // Task #4762 — declared human gate: this converging action deliberately
  // waits on a human step; the reason renders on its amber row.
  humanGate?: { reason: string };
  // Task #4762 — served-purpose retirement: the lever/action reached its
  // target state, so it moves to History with a completion note and leaves
  // the Manual levers section.
  retired?: true;
  retiredNote?: string;
}

interface LastRunSummary {
  outcomeState: OutcomeState;
  detail: string | null;
  appliedAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
}

interface CompletedActionRow extends ActionStatusRow {
  lastRun: LastRunSummary | null;
}

interface SelfHealLastRun {
  ranAt: string;
  eligibleCount: number;
  dueCount: number;
  applied: number;
  notNeeded: number;
  errors: number;
  reason?: string;
}

interface StatusesResponse {
  actions: ActionStatusRow[];
  active: ActionStatusRow[];
  // Task #4054 — healthy always-on maintenance with routine pending work;
  // shown in a calm section, never counted by the needs-attention badge.
  autoManaged?: ActionStatusRow[];
  completed: CompletedActionRow[];
  selfHealEnabled?: boolean;
  selfHealLastRun?: SelfHealLastRun | null;
  // Task #2198 — readable-vs-corrupt signal for the stored self-heal last-run.
  selfHealLastRunStatus?: "ok" | "never_run" | "unreadable";
  selfHealLastRunError?: string;
  // Task #2173 — current persistent-failure alert tuning so the panel can
  // show + adjust the consecutive-error trip point (1..50) and tell the
  // operator whether that alert is currently armed.
  selfHealFailureAlertThreshold?: number;
  selfHealFailureAlertEnabled?: boolean;
}

// Task #2173 — bounds for the consecutive-error trip point, mirrored from
// the server (FAILURE_ALERT_THRESHOLD_MIN / _CAP in prodActionSelfHeal.ts).
const FAILURE_ALERT_THRESHOLD_MIN = 1;
const FAILURE_ALERT_THRESHOLD_MAX = 50;

interface ApplyResult {
  id: string;
  title: string;
  description: string;
  change: string;
  // Task #4840 — `integration` rides along on blocked outcomes (the route
  // serializes the outcome verbatim) so result rows/toasts can tell
  // reconnect-blocked from waiting-blocked.
  outcome: { state: OutcomeState; detail: string; rowsAffected?: number; integration?: string };
  appliedAt: string;
}

// Task #2125 — a single automatic self-heal run row from
// GET /api/admin/prod-actions/runs?actor=system. Actor is always null
// (system) for these, so the panel doesn't render an actor column.
interface SelfHealRunRow {
  id: string;
  actionId: string;
  actionTitle: string;
  outcomeState: OutcomeState;
  rowsAffected: number | null;
  detail: string | null;
  errorMessage: string | null;
  appliedAt: string;
}

// Task #2125 / #2195 — base URL for the self-heal (system actor) run
// timeline. The limit is appended at render time so operators can "Load
// more" to look further back; the default keeps the panel lightweight.
const SELF_HEAL_RUNS_BASE = "/api/admin/prod-actions/runs?actor=system";
const SELF_HEAL_PAGE_SIZE = 10;

// Task #4840 — `blocked` has two flavors, discriminated by whether the
// status/outcome names an integration: named = auth-dead reconnect
// ("Needs reconnect", orange); unnamed = waiting on preconditions on a
// healthy integration ("Blocked — waiting", calm amber). Rows that only
// have an outcome-state string (history / self-heal timeline) use the
// neutral "Blocked" label — their detail text self-explains.
type BlockedFlavor = "reconnect" | "waiting" | "neutral";

function blockedFlavorOf(integration: string | undefined | null): BlockedFlavor {
  return integration ? "reconnect" : "waiting";
}

function StateBadge({
  state,
  blockedFlavor = "neutral",
}: {
  state: StatusState | OutcomeState;
  blockedFlavor?: BlockedFlavor;
}) {
  const map: Record<string, { label: string; className: string }> = {
    pending: { label: "Pending", className: "bg-amber-100 text-amber-900 border-amber-300" },
    applied: { label: "Applied", className: "bg-emerald-100 text-emerald-900 border-emerald-300" },
    "not-needed": { label: "Not needed", className: "bg-muted text-foreground border-border" },
    error: { label: "Error", className: "bg-red-100 text-red-900 border-red-300" },
    // Task #2111 — reconnect-required: warm amber/orange so it reads as
    // "needs attention" but is clearly NOT a red error. Task #4840 — only
    // when the row names the integration; otherwise it is a wait-state.
    blocked:
      blockedFlavor === "reconnect"
        ? { label: "Needs reconnect", className: "bg-orange-100 text-orange-900 border-orange-300" }
        : blockedFlavor === "waiting"
          ? { label: "Blocked — waiting", className: "bg-amber-100 text-amber-900 border-amber-300" }
          : { label: "Blocked", className: "bg-amber-100 text-amber-900 border-amber-300" },
  };
  const cfg = map[state] ?? map.error;
  return (
    <Badge variant="outline" className={cfg.className} data-testid={`badge-prod-action-state-${state}`}>
      {cfg.label}
    </Badge>
  );
}

function formatActor(run: LastRunSummary): string {
  return run.actorName || run.actorEmail || (run.actorUserId ? `user ${run.actorUserId}` : "system");
}

const OUTCOME_LABEL: Record<OutcomeState, string> = {
  applied: "Applied",
  "not-needed": "Not needed",
  error: "Error",
  // Task #4840 — neutral: an outcome state alone cannot tell reconnect
  // from waiting-on-preconditions; surfaces that know the integration
  // render the flavor themselves.
  blocked: "Blocked",
};

// Task #4842 — one partition of the post-press results, shared by the
// toast counts AND the "Last apply results" render so the two can never
// drift. Groups that represent real work (applied / errored / blocked)
// come first, each sorted by title; `notNeeded` is the catch-all tail
// (everything not in the other groups, mirroring the toast's historical
// `length - others` arithmetic) and renders collapsed behind a count.
interface ApplyResultsPartition {
  applied: ApplyResult[];
  errored: ApplyResult[];
  reconnectBlocked: ApplyResult[];
  waitingBlocked: ApplyResult[];
  notNeeded: ApplyResult[];
}

function partitionApplyResults(results: ApplyResult[]): ApplyResultsPartition {
  const byTitle = (a: ApplyResult, b: ApplyResult) => a.title.localeCompare(b.title);
  const applied = results.filter((r) => r.outcome.state === "applied").sort(byTitle);
  const errored = results.filter((r) => r.outcome.state === "error").sort(byTitle);
  const reconnectBlocked = results
    .filter((r) => r.outcome.state === "blocked" && r.outcome.integration)
    .sort(byTitle);
  const waitingBlocked = results
    .filter((r) => r.outcome.state === "blocked" && !r.outcome.integration)
    .sort(byTitle);
  const notNeeded = results
    .filter(
      (r) =>
        r.outcome.state !== "applied" &&
        r.outcome.state !== "error" &&
        r.outcome.state !== "blocked",
    )
    .sort(byTitle);
  return { applied, errored, reconnectBlocked, waitingBlocked, notNeeded };
}

// Task #4842 — the human-readable count summary. Used verbatim as the
// toast description and as the results-panel summary line so the toast
// numbers always match the partitioned list. Phrasing is Task #2111 /
// #4840 vintage — do not reword without updating the toast suites.
function applyResultSummaryParts(p: ApplyResultsPartition): string[] {
  const parts = [`${p.applied.length} applied`, `${p.notNeeded.length} not needed`];
  if (p.reconnectBlocked.length > 0) parts.push(`${p.reconnectBlocked.length} needs reconnect`);
  if (p.waitingBlocked.length > 0) parts.push(`${p.waitingBlocked.length} blocked/waiting`);
  if (p.errored.length > 0) parts.push(`${p.errored.length} errored`);
  return parts;
}

/**
 * Task #2086 — per-action auto-heal readout: shows the durable last run
 * time, outcome, and rows affected, plus when it next becomes eligible.
 * Rendered only for self-heal-eligible actions.
 */
function SelfHealReadoutRow({ row }: { row: ActionStatusRow }) {
  if (!row.selfHealEligible) return null;
  const sh = row.selfHeal ?? null;
  return (
    <div
      className="mt-1 rounded border border-sky-200 bg-sky-50/60 px-2 py-1 text-xs text-sky-900"
      data-testid={`panel-prod-action-selfheal-${row.id}`}
    >
      <span className="font-medium">Auto-heal:</span>{" "}
      {sh ? (
        <span data-testid={`text-prod-action-selfheal-summary-${row.id}`}>
          last {OUTCOME_LABEL[sh.lastOutcome]} {new Date(sh.lastRunAt).toLocaleString()}
          {sh.lastRowsAffected != null ? ` · ${sh.lastRowsAffected} row(s)` : ""}
          {" · next "}
          {new Date(sh.nextEligibleAt).toLocaleString()}
        </span>
      ) : (
        <span
          className="italic"
          data-testid={`text-prod-action-selfheal-never-${row.id}`}
        >
          eligible — not yet auto-applied
        </span>
      )}
      {sh && sh.consecutiveFailures > 0 && (
        <div
          className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800"
          data-testid={`text-prod-action-selfheal-failing-${row.id}`}
        >
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>
              Auto-fix keeps failing — {sh.consecutiveFailures}× in a row
              {sh.failureAlertSent ? " · admins alerted" : ""}
            </span>
          </div>
          {sh.lastErrorDetail && (
            <div
              className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-red-700"
              data-testid={`text-prod-action-selfheal-error-detail-${row.id}`}
            >
              {sh.lastErrorDetail}
            </div>
          )}
        </div>
      )}
      {/* Task #4840 — the blocked strip splits on the named integration:
          auth-dead keeps the reconnect + "admins alerted" treatment;
          no-integration blocks are precondition wait-states that never
          page, so the strip must not claim a reconnect or an alert. */}
      {sh && sh.lastOutcome === "blocked" && row.status.integration && (
        <div
          className="mt-1 rounded border border-orange-200 bg-orange-50 px-2 py-1 text-orange-900"
          data-testid={`text-prod-action-selfheal-reconnect-${row.id}`}
        >
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>
              Reconnect required
              {`: ${row.status.integration}`}
              {sh.reconnectAlertSent ? " · admins alerted" : ""}
            </span>
          </div>
        </div>
      )}
      {sh && sh.lastOutcome === "blocked" && !row.status.integration && (
        <div
          className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"
          data-testid={`text-prod-action-selfheal-waiting-${row.id}`}
        >
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>
              Waiting on preconditions — no reconnect needed; retries on its
              own schedule
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const EPOCH_ZERO_ISO = new Date(0).toISOString();

// Task #4768 — the calm auto-managed detail arrives with the scheduler's
// raw `nextEligibleAt` ISO string embedded ("auto-applies by
// ~2026-08-15T02:00:00.000Z"). Match any embedded ISO timestamp so the
// panel can re-render it as a friendly local time; the absent-time branch
// ("auto-applies on an upcoming pass.") has no match and passes through
// untouched.
const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * Task #4768 — friendly local, short-form rendering of an upcoming
 * timestamp, matching the panel's other local-time formatting
 * (`toLocaleString` family). Near-term times read relatively ("in 4h"),
 * same-/next-day times anchor to the local clock ("today 21:00"),
 * anything further gets a short local date. Unparseable input is returned
 * verbatim (never "Invalid Date").
 */
function formatFriendlyLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  // Already eligible (or within the current minute): the scheduler's next
  // pass will pick it up imminently.
  if (diffMs < 60_000) return "any moment now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 6) return `in ${hours}h`;
  const timeOfDay = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameLocalDay = d.toDateString() === now.toDateString();
  if (sameLocalDay) return `today ${timeOfDay}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${timeOfDay}`;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Task #4768 — replace any embedded ISO timestamps with the friendly form. */
function formatAutoManagedDetail(detail: string): string {
  return detail.replace(ISO_TIMESTAMP_RE, (m) => formatFriendlyLocalTime(m));
}

export function ProdActionsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selfHealHistoryOpen, setSelfHealHistoryOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dailyJudgmentConfirmOpen, setDailyJudgmentConfirmOpen] = useState(false);
  const [lastResults, setLastResults] = useState<ApplyResult[] | null>(null);
  // Task #4842 — the long "not needed" tail of the last-apply results is
  // collapsed behind a count by default; this toggles it open.
  const [notNeededOpen, setNotNeededOpen] = useState(false);

  const statusQuery = useQuery<StatusesResponse>({
    queryKey: ["/api/admin/prod-actions"],
    enabled: open,
  });

  // Task #2125 — short timeline of the most recent automatic self-heal
  // runs (system actor). Fetched only when the panel is open; refreshed
  // alongside the status query after a manual apply.
  // Task #2195 — operators can raise the limit ("Load more") to look
  // further back when an action has been flapping; default stays at one
  // page so the panel stays lightweight.
  const [selfHealLimit, setSelfHealLimit] = useState(SELF_HEAL_PAGE_SIZE);
  // Task #2232 — operators can narrow the auto-heal history to a single
  // actionId to follow a flapping action's pattern. Empty string = the
  // default unfiltered view (all system runs).
  const [selfHealActionFilter, setSelfHealActionFilter] = useState<string>("");
  const selfHealRunsUrl =
    `${SELF_HEAL_RUNS_BASE}&limit=${selfHealLimit}` +
    (selfHealActionFilter
      ? `&actionId=${encodeURIComponent(selfHealActionFilter)}`
      : "");
  const selfHealRunsQuery = useQuery<{ runs: SelfHealRunRow[] }>({
    queryKey: [selfHealRunsUrl],
    enabled: open,
  });
  const selfHealRuns = selfHealRunsQuery.data?.runs ?? [];
  // If the server returned a full page, there may be older runs to fetch.
  const selfHealHasMore = selfHealRuns.length >= selfHealLimit;

  // Task #2232 — self-heal-eligible actions are the only ones that produce
  // automatic runs, so they form a stable, complete dropdown of options
  // even when the history is currently filtered to one action.
  const selfHealActionOptions = useMemo(() => {
    const actions = statusQuery.data?.actions ?? [];
    return actions
      .filter((a) => a.selfHealEligible)
      .map((a) => ({ id: a.id, title: a.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [statusQuery.data]);

  // Reset paging whenever the action filter changes so "Load more" state
  // doesn't carry over between different (or no) filters.
  const setSelfHealFilter = (actionId: string) => {
    setSelfHealActionFilter(actionId);
    setSelfHealLimit(SELF_HEAL_PAGE_SIZE);
  };

  const applyMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/prod-actions/apply");
      return (await res.json()) as { results: ApplyResult[] };
    },
    onSuccess: (data) => {
      setLastResults(data.results);
      setNotNeededOpen(false);
      // Refresh both the status partition (active vs history) in one
      // round-trip; the History rows render off the same query.
      void qc.invalidateQueries({ queryKey: ["/api/admin/prod-actions"] }); // fire-and-forget: cache refresh only
      // Task #2125 — a manual apply writes new run rows; refresh the
      // auto-heal timeline too (it's a system-actor-only slice, so manual
      // applies won't appear, but keeping it fresh is cheap and correct).
      // Task #2195 — the limit is now part of the query key, so match any
      // self-heal-runs query regardless of the current "Load more" limit.
      void qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).startsWith(SELF_HEAL_RUNS_BASE),
      }); // fire-and-forget: cache refresh only
      // Task #2111 — blocked (reconnect-required) outcomes are not errors:
      // count them separately and only fire the destructive/red toast when
      // there are genuine errors. "Applied with N error(s)" headline is
      // likewise reserved for real errors.
      // Task #4840 — split blocked by flavor: only outcomes that NAME an
      // integration are reconnect-required; the rest are waiting on
      // preconditions and must not be phrased as reconnect work.
      // Task #4842 — counts come from the SAME partition the results
      // panel renders, so the toast can never disagree with the list.
      const p = partitionApplyResults(data.results);
      const errors = p.errored.length;
      const title =
        errors > 0
          ? `Applied with ${errors} error(s)`
          : p.reconnectBlocked.length > 0
            ? "Applied — some integrations need reconnect"
            : p.waitingBlocked.length > 0
              ? "Applied — some actions are waiting on preconditions"
              : "Prod actions applied";
      toast({
        title,
        description: `${applyResultSummaryParts(p).join(", ")}.`,
        variant: errors > 0 ? "destructive" : "default",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Apply failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Task #4019 — fire one manual lever via its dedicated endpoint. Never
  // part of Apply-all; each press is confirmed individually (the lever's
  // own AlertDialog). Busy state is keyed per action so unrelated levers
  // remain available while one request is in flight.
  const [leverConfirmId, setLeverConfirmId] = useState<string | null>(null);
  const [leverConfirmation, setLeverConfirmation] = useState("");
  const [firingLeverIds, setFiringLeverIds] = useState<Set<string>>(
    () => new Set(),
  );
  const firingLeverIdsRef = useRef<Set<string>>(new Set());
  const fireLever = async (input: {
    actionId: string;
    confirmation?: string;
  }): Promise<void> => {
    if (firingLeverIdsRef.current.has(input.actionId)) return;
    firingLeverIdsRef.current.add(input.actionId);
    setFiringLeverIds((current) => {
      const next = new Set(current);
      next.add(input.actionId);
      return next;
    });
    try {
      const res = await apiRequest(
        "POST",
        `/api/admin/prod-actions/${encodeURIComponent(input.actionId)}/apply`,
        input.confirmation ? { confirmation: input.confirmation } : {},
      );
      const data = (await res.json()) as { result: ApplyResult };
      const r = data.result;
      toast({
        title:
          r.outcome.state === "applied"
            ? `${r.title} — applied`
            : `${r.title} — ${OUTCOME_LABEL[r.outcome.state].toLowerCase()}`,
        description: r.outcome.detail,
        variant: r.outcome.state === "error" ? "destructive" : "default",
      });
    } catch (err: any) {
      toast({
        title: "Lever failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      firingLeverIdsRef.current.delete(input.actionId);
      setFiringLeverIds((current) => {
        if (!current.has(input.actionId)) return current;
        const next = new Set(current);
        next.delete(input.actionId);
        return next;
      });
      // Reconcile both status/completed history and the visible run timeline
      // after every settled response, including request failures.
      void qc.invalidateQueries({ queryKey: ["/api/admin/prod-actions"] });
      void qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).startsWith(SELF_HEAL_RUNS_BASE),
      });
    }
  };
  // This is intentionally separate from registered prod actions. The
  // portfolio-wide judgment pass is an existing CEO-only background route,
  // not an action that Apply all should ever trigger.
  const dailyJudgmentMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/daily-judgments/run-all");
      return (await res.json()) as { message?: string };
    },
    onSuccess: (data) => {
      toast({
        title: "Client ratings started",
        description: data.message ?? "Daily judgment generation started",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not start client ratings",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });
  // Task #2173 — local draft for the consecutive-error trip point so the
  // operator can type a value before saving. `null` means "follow the
  // server value" (the input shows the live threshold); once the operator
  // edits it, the draft holds their in-progress entry until Save clears it
  // (onSuccess resets the draft to null, so the input re-follows the
  // refreshed server value).
  const serverThreshold =
    statusQuery.data?.selfHealFailureAlertThreshold ??
    FAILURE_ALERT_THRESHOLD_MIN;
  const failureAlertEnabled =
    statusQuery.data?.selfHealFailureAlertEnabled ?? false;
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const thresholdInputValue =
    thresholdDraft ?? String(serverThreshold);
  const parsedDraft = Number(thresholdInputValue);
  const thresholdDirty =
    thresholdDraft !== null &&
    Number.isFinite(parsedDraft) &&
    Math.floor(parsedDraft) !== serverThreshold;
  const thresholdValid =
    Number.isFinite(parsedDraft) &&
    Math.floor(parsedDraft) >= FAILURE_ALERT_THRESHOLD_MIN &&
    Math.floor(parsedDraft) <= FAILURE_ALERT_THRESHOLD_MAX;

  const thresholdMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (threshold: number) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/prod-actions/failure-alert-threshold",
        { threshold },
      );
      return (await res.json()) as { threshold: number };
    },
    onSuccess: (data) => {
      setThresholdDraft(null);
      void qc.invalidateQueries({ queryKey: ["/api/admin/prod-actions"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Alert sensitivity updated",
        description: `Self-heal now pages after ${data.threshold} consecutive failure(s).`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't update sensitivity",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const active = statusQuery.data?.active ?? [];
  // Task #4762 — calm bucket: enrolled/working rows a healthy scheduler or
  // background drain will finish on its own; never counted by the badge.
  const autoManaged = statusQuery.data?.autoManaged ?? [];
  const completed = useMemo(
    () => statusQuery.data?.completed ?? [],
    [statusQuery.data?.completed],
  );
  // Task #4019 — manual levers render in their own section with a
  // dedicated button each, regardless of the active/history partition
  // (their status is deliberately not-needed so they never inflate the
  // pending badge). Task #4762 — levers whose served-purpose probe reports
  // the target state reached retire to History and leave this section.
  const manualLevers = useMemo(
    () =>
      (statusQuery.data?.actions ?? []).filter(
        (a) => a.manualLever === true && a.retired !== true,
      ),
    [statusQuery.data?.actions],
  );
  const leverToConfirm = manualLevers.find((a) => a.id === leverConfirmId) ?? null;
  const pendingCount = active.filter((a) => a.status.state === "pending").length;
  const errorCount = active.filter((a) => a.status.state === "error").length;
  // Task #2111 — reconnect-required actions are shown in the active list
  // (amber) but re-pressing them without reconnecting the integration
  // does nothing useful, so they do NOT enable the "Apply all" button on
  // their own. `actionableCount` drives the button; `activeBadgeCount`
  // drives the "X items need attention" badge/empty-state.
  // Task #4840 — count the two blocked flavors separately so the badge
  // and footer never claim "needs reconnect" for precondition wait-states
  // (blocked rows that name no integration).
  const reconnectBlockedCount = active.filter(
    (a) => a.status.state === "blocked" && a.status.integration,
  ).length;
  const waitingBlockedCount = active.filter(
    (a) => a.status.state === "blocked" && !a.status.integration,
  ).length;
  const blockedCount = reconnectBlockedCount + waitingBlockedCount;
  const actionableCount = pendingCount + errorCount;
  const activeBadgeCount = pendingCount + errorCount + blockedCount;
  // Task #4842 — live registered-action count for the Apply-all scope
  // explainer: the statuses payload's `actions` array is the full registry.
  const registeredCount = statusQuery.data?.actions.length ?? 0;
  // Task #4842 — partition the last apply results once; the toast counts
  // use the same helper so the two surfaces can never drift.
  const resultsPartition = useMemo(
    () => (lastResults ? partitionApplyResults(lastResults) : null),
    [lastResults],
  );

  const sortedHistory = useMemo(() => completed, [completed]);

  return (
    <Card className="border-amber-300 bg-amber-50/30" data-testid="card-prod-actions-panel">
      <CardHeader
        className="cursor-pointer select-none py-3"
        onClick={() => setOpen((v) => !v)}
        data-testid="header-prod-actions-toggle"
      >
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <AlertTriangle className="w-4 h-4 text-amber-700" />
            <span>Apply pending prod writes</span>
            <span className="text-xs text-muted-foreground font-normal">(CEO only)</span>
          </div>
          {open && activeBadgeCount > 0 && (
            <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300" data-testid="badge-prod-actions-pending-count">
              {pendingCount} pending{errorCount > 0 ? `, ${errorCount} error` : ""}
              {reconnectBlockedCount > 0 ? `, ${reconnectBlockedCount} needs reconnect` : ""}
              {waitingBlockedCount > 0 ? `, ${waitingBlockedCount} blocked/waiting` : ""}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0">
          {statusQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-prod-actions-loading">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking action statuses…
            </div>
          )}
          {statusQuery.isError && (
            <div className="text-sm text-red-700" data-testid="text-prod-actions-load-error">
              Failed to load action statuses: {(statusQuery.error as any)?.message ?? "Unknown error"}
            </div>
          )}

          {!statusQuery.isLoading && !statusQuery.isError && (
            <div
              className={`rounded border px-3 py-2 text-xs ${
                statusQuery.data?.selfHealEnabled
                  ? "border-sky-300 bg-sky-50/60 text-sky-900"
                  : "border-border bg-muted/50 text-muted-foreground"
              }`}
              data-testid="banner-prod-actions-selfheal"
            >
              <span className="font-medium">Auto-heal scheduler:</span>{" "}
              <span data-testid="text-prod-actions-selfheal-state">
                {statusQuery.data?.selfHealEnabled ? "ON" : "OFF"}
              </span>
              {" — eligible actions are auto-applied on a cadence when ON. Per-action last run / outcome / rows are shown below."}
              {statusQuery.data?.selfHealLastRun ? (
                <div className="mt-1" data-testid="text-prod-actions-selfheal-lastrun">
                  <span className="font-medium">Last pass:</span>{" "}
                  {new Date(statusQuery.data.selfHealLastRun.ranAt).toLocaleString()}
                  {" — "}
                  <span data-testid="text-prod-actions-selfheal-counts">
                    {statusQuery.data.selfHealLastRun.applied} applied,{" "}
                    {statusQuery.data.selfHealLastRun.notNeeded} not needed,{" "}
                    {statusQuery.data.selfHealLastRun.errors} error(s)
                  </span>
                  {statusQuery.data.selfHealLastRun.reason ? (
                    <span data-testid="text-prod-actions-selfheal-reason">
                      {" "}· {statusQuery.data.selfHealLastRun.reason}
                    </span>
                  ) : null}
                </div>
              ) : statusQuery.data?.selfHealLastRunStatus === "unreadable" ? (
                /* Task #2245 — a corrupt stored last-run record must read as a
                   warning, not the calm "never run" state, so a persistence
                   bug isn't mistaken for an idle scheduler. */
                <div
                  className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-800"
                  data-testid="text-prod-actions-selfheal-unreadable"
                >
                  ⚠ The stored last-run record could not be read — this usually
                  means the saved value is corrupt (a persistence bug), not that
                  the scheduler never ran. Check the server logs.
                  {typeof statusQuery.data?.selfHealLastRunError === "string" ? (
                    <span className="mt-0.5 block font-mono text-[10px] text-amber-700">
                      {statusQuery.data.selfHealLastRunError}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="mt-1 italic" data-testid="text-prod-actions-selfheal-never">
                  No automatic pass has run yet.
                </div>
              )}
              {/* Task #2173 — CEO-tunable persistent-failure alert
                  sensitivity. The self-heal scheduler pages once an action
                  fails this many times in a row; lower = more sensitive.
                  Takes effect on the next self-heal tick. */}
              <div
                className="mt-2 flex flex-wrap items-center gap-2 border-t border-current/10 pt-2"
                data-testid="row-prod-actions-failure-alert-threshold"
              >
                <span className="font-medium">Alert after</span>
                <Input
                  type="number"
                  min={FAILURE_ALERT_THRESHOLD_MIN}
                  max={FAILURE_ALERT_THRESHOLD_MAX}
                  step={1}
                  value={thresholdInputValue}
                  onChange={(e) => setThresholdDraft(e.target.value)}
                  className="h-7 w-16 bg-card text-xs"
                  data-testid="input-prod-actions-failure-alert-threshold"
                />
                <span>
                  consecutive failure(s)
                  {failureAlertEnabled ? "" : " (alert currently off)"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={
                    !thresholdDirty ||
                    !thresholdValid ||
                    thresholdMutation.isPending
                  }
                  onClick={() =>
                    thresholdMutation.mutate(Math.floor(parsedDraft))
                  }
                  data-testid="button-prod-actions-failure-alert-threshold-save"
                >
                  {thresholdMutation.isPending ? "Saving…" : "Save"}
                </Button>
                {!thresholdValid && thresholdDraft !== null ? (
                  <span
                    className="text-rose-700"
                    data-testid="text-prod-actions-failure-alert-threshold-error"
                  >
                    Enter {FAILURE_ALERT_THRESHOLD_MIN}–
                    {FAILURE_ALERT_THRESHOLD_MAX}.
                  </span>
                ) : null}
              </div>
            </div>
          )}

          {!statusQuery.isLoading && !statusQuery.isError && (
            <div
              className="rounded border bg-card"
              data-testid="panel-prod-actions-selfheal-history"
            >
              <button
                type="button"
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
                onClick={() => setSelfHealHistoryOpen((v) => !v)}
                data-testid="header-prod-actions-selfheal-history-toggle"
              >
                <span className="flex items-center gap-2">
                  {selfHealHistoryOpen ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  Auto-heal run history
                </span>
                <Badge
                  variant="outline"
                  className="bg-sky-100 text-sky-800 border-sky-300"
                  data-testid="badge-prod-actions-selfheal-history-count"
                >
                  {selfHealRuns.length}
                </Badge>
              </button>
              {selfHealHistoryOpen && (
                <div className="border-t" data-testid="list-prod-actions-selfheal-history">
                  {/* Task #2232 — narrow the history to a single action so
                      operators can follow a flapping action's pattern. */}
                  <div
                    className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2"
                    data-testid="filter-prod-actions-selfheal-history"
                  >
                    <label
                      htmlFor="select-prod-actions-selfheal-history-filter"
                      className="text-xs text-muted-foreground"
                    >
                      Filter to action:
                    </label>
                    <select
                      id="select-prod-actions-selfheal-history-filter"
                      className="h-7 flex-1 min-w-0 rounded border border-border bg-card px-2 text-xs"
                      value={selfHealActionFilter}
                      onChange={(e) => setSelfHealFilter(e.target.value)}
                      data-testid="select-prod-actions-selfheal-history-filter"
                    >
                      <option value="">All actions</option>
                      {selfHealActionOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title}
                        </option>
                      ))}
                    </select>
                    {selfHealActionFilter && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setSelfHealFilter("")}
                        data-testid="button-prod-actions-selfheal-history-clear-filter"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  {selfHealRunsQuery.isLoading && (
                    <div
                      className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"
                      data-testid="text-prod-actions-selfheal-history-loading"
                    >
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading recent automatic runs…
                    </div>
                  )}
                  {selfHealRunsQuery.isError && (
                    <div
                      className="px-3 py-3 text-xs text-red-700"
                      data-testid="text-prod-actions-selfheal-history-error"
                    >
                      Failed to load run history:{" "}
                      {(selfHealRunsQuery.error as any)?.message ?? "Unknown error"}
                    </div>
                  )}
                  {!selfHealRunsQuery.isLoading &&
                    !selfHealRunsQuery.isError &&
                    selfHealRuns.length === 0 && (
                      <div
                        className="px-3 py-3 text-xs text-muted-foreground"
                        data-testid="text-prod-actions-selfheal-history-empty"
                      >
                        {selfHealActionFilter
                          ? "No automatic self-heal runs recorded for this action yet."
                          : "No automatic self-heal runs recorded yet."}
                      </div>
                    )}
                  {selfHealRuns.map((run) => (
                    <div
                      key={run.id}
                      className="border-t first:border-t-0 px-3 py-2 flex items-start gap-2"
                      data-testid={`row-prod-action-selfheal-run-${run.id}`}
                    >
                      <StateBadge state={run.outcomeState} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div
                            className="text-sm font-medium truncate"
                            data-testid={`text-prod-action-selfheal-run-title-${run.id}`}
                          >
                            {run.actionTitle}
                          </div>
                          {selfHealActionFilter !== run.actionId && (
                            <button
                              type="button"
                              className="shrink-0 text-xs text-sky-700 hover:underline"
                              onClick={() => setSelfHealFilter(run.actionId)}
                              data-testid={`button-prod-action-selfheal-run-filter-${run.id}`}
                            >
                              Filter to this
                            </button>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                          <span data-testid={`text-prod-action-selfheal-run-at-${run.id}`}>
                            {new Date(run.appliedAt).toLocaleString()}
                          </span>
                          {run.rowsAffected != null && (
                            <span data-testid={`text-prod-action-selfheal-run-rows-${run.id}`}>
                              {run.rowsAffected} row(s)
                            </span>
                          )}
                        </div>
                        {(run.errorMessage || run.detail) && (
                          <div
                            className={`text-xs mt-0.5 break-words ${
                              run.errorMessage ? "text-red-700" : "text-muted-foreground"
                            }`}
                            data-testid={`text-prod-action-selfheal-run-detail-${run.id}`}
                          >
                            {run.errorMessage ?? run.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {/* Task #2195 — let operators pull older runs on demand
                      without inflating the default lightweight view. */}
                  {!selfHealRunsQuery.isLoading &&
                    !selfHealRunsQuery.isError &&
                    selfHealRuns.length > 0 && (
                      <div
                        className="border-t px-3 py-2 flex items-center justify-between gap-2"
                        data-testid="footer-prod-actions-selfheal-history"
                      >
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid="text-prod-actions-selfheal-history-shown"
                        >
                          Showing {selfHealRuns.length} run(s)
                        </span>
                        {selfHealHasMore ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={selfHealRunsQuery.isFetching}
                            onClick={() =>
                              setSelfHealLimit((n) => n + SELF_HEAL_PAGE_SIZE)
                            }
                            data-testid="button-prod-actions-selfheal-history-load-more"
                          >
                            {selfHealRunsQuery.isFetching ? (
                              <>
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                Loading…
                              </>
                            ) : (
                              "Load more"
                            )}
                          </Button>
                        ) : (
                          selfHealLimit > SELF_HEAL_PAGE_SIZE && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() =>
                                setSelfHealLimit(SELF_HEAL_PAGE_SIZE)
                              }
                              data-testid="button-prod-actions-selfheal-history-show-less"
                            >
                              Show less
                            </Button>
                          )
                        )}
                      </div>
                    )}
                </div>
              )}
            </div>
          )}

          {!statusQuery.isLoading && !statusQuery.isError && active.length === 0 && (
            <div
              className="rounded border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-900"
              data-testid="text-prod-actions-active-empty"
            >
              Nothing pending — all actions are up to date.
              {autoManaged.length > 0
                ? ` ${autoManaged.length} auto-managed item(s) are draining on their own below.`
                : ""}
            </div>
          )}

          {active.length > 0 && (
            <div className="space-y-2" data-testid="list-prod-actions-active">
              {active.map((a) => (
                <div
                  key={a.id}
                  className="rounded border bg-card p-3 space-y-1"
                  data-testid={`row-prod-action-${a.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-sm" data-testid={`text-prod-action-title-${a.id}`}>{a.title}</div>
                    <StateBadge
                      state={a.status.state}
                      blockedFlavor={blockedFlavorOf(a.status.integration)}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid={`text-prod-action-description-${a.id}`}>
                    {a.description}
                  </div>
                  <div className="text-xs font-mono text-foreground" data-testid={`text-prod-action-change-${a.id}`}>
                    {a.change}
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid={`text-prod-action-status-detail-${a.id}`}>
                    {a.status.detail}
                  </div>
                  {/* Task #4762 — declared human gate: name the human step this
                      row is deliberately waiting on, so amber always explains
                      itself. */}
                  {a.humanGate && a.status.state === "pending" && (
                    <div
                      className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                      data-testid={`text-prod-action-humangate-${a.id}`}
                    >
                      <span className="font-medium">Needs a human:</span>{" "}
                      {a.humanGate.reason}
                    </div>
                  )}
                  {/* Task #4840 — blocked-note flavor split: reconnect copy +
                      Integrations Hub link ONLY when the status names the
                      integration; otherwise a neutral precondition-wait note
                      (the status detail above says what it waits for). */}
                  {a.status.state === "blocked" && a.status.integration && (
                    <div
                      className="text-xs text-orange-800 bg-orange-50 border border-orange-200 rounded px-2 py-1"
                      data-testid={`text-prod-action-blocked-note-${a.id}`}
                    >
                      {`${a.status.integration} login expired. `}
                      Reconnect the integration first — re-running this action before then won't help.{" "}
                      <Link
                        href="/admin/integrations"
                        className="font-medium underline text-orange-900"
                        data-testid={`link-prod-action-reconnect-${a.id}`}
                      >
                        Reconnect now →
                      </Link>
                    </div>
                  )}
                  {a.status.state === "blocked" && !a.status.integration && (
                    <div
                      className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                      data-testid={`text-prod-action-blocked-waiting-note-${a.id}`}
                    >
                      Waiting on preconditions — no reconnect needed. The
                      status above explains what it's waiting for; it clears
                      on its own once met.
                    </div>
                  )}
                  <SelfHealReadoutRow row={a} />
                </div>
              ))}
            </div>
          )}

          {/* Task #4762 — calm auto-managed bucket: work that drains without
              an operator (active background drains, self-heal-enrolled rows a
              healthy scheduler will press, healthy continuous loops). Never
              amber, never counted by the needs-attention badge. */}
          {!statusQuery.isLoading && !statusQuery.isError && autoManaged.length > 0 && (
            <div
              className="rounded border border-sky-200 bg-sky-50/40"
              data-testid="panel-prod-actions-automanaged"
            >
              <div className="px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-sky-900">
                  Auto-managed — draining without an operator
                </span>
                <Badge
                  variant="outline"
                  className="bg-sky-100 text-sky-900 border-sky-300"
                  data-testid="badge-prod-actions-automanaged-count"
                >
                  {autoManaged.length}
                </Badge>
              </div>
              <div className="border-t" data-testid="list-prod-actions-automanaged">
                {autoManaged.map((a) => (
                  <div
                    key={a.id}
                    className="border-t first:border-t-0 px-3 py-2 space-y-1"
                    data-testid={`row-prod-action-automanaged-${a.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className="text-sm font-medium"
                        data-testid={`text-prod-action-automanaged-title-${a.id}`}
                      >
                        {a.title}
                      </div>
                      <Badge
                        variant="outline"
                        className="bg-sky-100 text-sky-900 border-sky-300 shrink-0"
                        data-testid={`badge-prod-action-automanaged-kind-${a.id}`}
                      >
                        {a.status.working ? "working" : "scheduled"}
                      </Badge>
                    </div>
                    {a.autoManagedDetail && (
                      <div
                        className="text-xs text-sky-900/80"
                        data-testid={`text-prod-action-automanaged-detail-${a.id}`}
                      >
                        {formatAutoManagedDetail(a.autoManagedDetail)}
                      </div>
                    )}
                    <div
                      className="text-xs text-muted-foreground"
                      data-testid={`text-prod-action-automanaged-status-${a.id}`}
                    >
                      {a.status.detail}
                    </div>
                    <SelfHealReadoutRow row={a} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!statusQuery.isLoading && !statusQuery.isError && (
            <div className="rounded border bg-card" data-testid="panel-prod-actions-history">
              <button
                type="button"
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
                onClick={() => setHistoryOpen((v) => !v)}
                data-testid="header-prod-actions-history-toggle"
              >
                <span className="flex items-center gap-2">
                  {historyOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  History
                </span>
                <Badge variant="outline" className="bg-muted text-foreground border-border" data-testid="badge-prod-actions-history-count">
                  {sortedHistory.length}
                </Badge>
              </button>
              {historyOpen && (
                <div className="border-t" data-testid="list-prod-actions-history">
                  {sortedHistory.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="text-prod-actions-history-empty">
                      No completed actions yet.
                    </div>
                  )}
                  {sortedHistory.map((a) => {
                    const run = a.lastRun;
                    const isExpanded = !!expandedHistory[a.id];
                    const finalState: OutcomeState | StatusState = run?.outcomeState ?? a.status.state;
                    const hasRealTimestamp = !!run && run.appliedAt !== EPOCH_ZERO_ISO;
                    return (
                      <div
                        key={a.id}
                        className="border-t first:border-t-0 px-3 py-2 space-y-1"
                        data-testid={`row-prod-action-history-${a.id}`}
                      >
                        <button
                          type="button"
                          className="w-full text-left flex items-start gap-2"
                          onClick={() =>
                            setExpandedHistory((prev) => ({ ...prev, [a.id]: !prev[a.id] }))
                          }
                          data-testid={`button-prod-action-history-expand-${a.id}`}
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 mt-1 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-3 h-3 mt-1 text-muted-foreground" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <StateBadge state={finalState} />
                              {/* Task #4762 — served-purpose retirement: the
                                  lever reached its target state and left the
                                  Manual levers section for good. */}
                              {a.retired && (
                                <Badge
                                  variant="outline"
                                  className="bg-muted text-muted-foreground border-border"
                                  data-testid={`badge-prod-action-history-retired-${a.id}`}
                                >
                                  retired
                                </Badge>
                              )}
                              <span
                                className="text-sm font-medium truncate"
                                data-testid={`text-prod-action-history-title-${a.id}`}
                              >
                                {a.title}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                              {hasRealTimestamp ? (
                                <>
                                  <span data-testid={`text-prod-action-history-at-${a.id}`}>
                                    {new Date(run!.appliedAt).toLocaleString()}
                                  </span>
                                  <span data-testid={`text-prod-action-history-actor-${a.id}`}>
                                    by {formatActor(run!)}
                                  </span>
                                </>
                              ) : (
                                <span
                                  className="italic"
                                  data-testid={`text-prod-action-history-never-run-${a.id}`}
                                >
                                  Already in target state (never applied via panel)
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                        {isExpanded && (
                          <div
                            className="pl-5 space-y-1 text-xs"
                            data-testid={`panel-prod-action-history-expanded-${a.id}`}
                          >
                            <div className="text-muted-foreground" data-testid={`text-prod-action-history-description-${a.id}`}>
                              {a.description}
                            </div>
                            <div className="font-mono text-foreground" data-testid={`text-prod-action-history-change-${a.id}`}>
                              {a.change}
                            </div>
                            <div className="text-muted-foreground" data-testid={`text-prod-action-history-detail-${a.id}`}>
                              {run?.detail ?? a.status.detail}
                            </div>
                            {a.retiredNote && (
                              <div
                                className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1"
                                data-testid={`text-prod-action-history-retired-note-${a.id}`}
                              >
                                {a.retiredNote}
                              </div>
                            )}
                            <SelfHealReadoutRow row={a} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {resultsPartition && (
            <div className="rounded border border-emerald-300 bg-emerald-50/40 p-3 space-y-1" data-testid="panel-prod-actions-last-results">
              <div className="text-sm font-medium flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700" /> Last apply results
              </div>
              {/* Task #4842 — same count phrasing as the toast (shared
                  helper), so the numbers here always match it. */}
              <div
                className="text-xs text-muted-foreground"
                data-testid="text-prod-actions-results-summary"
              >
                {applyResultSummaryParts(resultsPartition).join(", ")}.
              </div>
              {(
                [
                  ["applied", resultsPartition.applied],
                  ["errored", resultsPartition.errored],
                  ["reconnect", resultsPartition.reconnectBlocked],
                  ["waiting", resultsPartition.waitingBlocked],
                ] as const
              ).map(([group, rows]) =>
                rows.map((r) => (
                  <div
                    key={r.id}
                    className="text-xs flex items-start justify-between gap-2"
                    data-testid={`row-prod-action-result-${r.id}`}
                    data-result-group={group}
                  >
                    <div className="flex-1">
                      <span className="font-medium">{r.title}:</span> {r.outcome.detail}
                    </div>
                    <StateBadge
                      state={r.outcome.state}
                      blockedFlavor={blockedFlavorOf(r.outcome.integration)}
                    />
                  </div>
                )),
              )}
              {resultsPartition.applied.length === 0 &&
                resultsPartition.errored.length === 0 &&
                resultsPartition.reconnectBlocked.length === 0 &&
                resultsPartition.waitingBlocked.length === 0 && (
                  <div
                    className="text-xs text-muted-foreground italic"
                    data-testid="text-prod-actions-results-all-settled"
                  >
                    No action had work to do — everything was already in its
                    target state.
                  </div>
                )}
              {/* Task #4842 — the long "not needed" tail collapses behind a
                  count so the rows that did work stay readable. */}
              {resultsPartition.notNeeded.length > 0 && (
                <>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setNotNeededOpen((v) => !v)}
                    data-testid="button-prod-actions-results-not-needed-toggle"
                  >
                    {notNeededOpen ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    {resultsPartition.notNeeded.length} not needed —{" "}
                    {notNeededOpen ? "hide" : "show"}
                  </button>
                  {notNeededOpen && (
                    <div
                      className="space-y-1 pl-4"
                      data-testid="panel-prod-actions-results-not-needed"
                    >
                      {resultsPartition.notNeeded.map((r) => (
                        <div
                          key={r.id}
                          className="text-xs flex items-start justify-between gap-2"
                          data-testid={`row-prod-action-result-${r.id}`}
                          data-result-group="not-needed"
                        >
                          <div className="flex-1">
                            <span className="font-medium">{r.title}:</span> {r.outcome.detail}
                          </div>
                          <StateBadge
                            state={r.outcome.state}
                            blockedFlavor={blockedFlavorOf(r.outcome.integration)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div
            className="rounded border border-red-200 bg-red-50/40 p-3 space-y-2"
            data-testid="panel-prod-actions-manual-levers"
          >
            <div className="text-sm font-medium flex items-center gap-2 text-red-900">
              <AlertTriangle className="w-4 h-4 text-red-700" /> Manual levers
            </div>
            <div className="text-xs text-red-800/80">
              Deliberate one-press levers, excluded from Apply all. Each asks
              for its own confirmation.
            </div>
            <div
              className="rounded border border-red-200 bg-card p-2 space-y-1"
              data-testid="row-prod-action-daily-judgments-run-all"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-sm">Run all active client ratings</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-300 text-red-800 hover:bg-red-100 shrink-0"
                  disabled={dailyJudgmentMutation.isPending}
                  onClick={() => setDailyJudgmentConfirmOpen(true)}
                  data-testid="button-daily-judgments-run-all"
                >
                  {dailyJudgmentMutation.isPending ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…
                    </>
                  ) : (
                    "Run ratings"
                  )}
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Start the existing daily judgment process for every active client.
              </div>
              <div className="text-xs text-muted-foreground">
                This starts background work; it does not wait for every rating to finish.
              </div>
            </div>
            {manualLevers.map((a) => {
              const isFiring = firingLeverIds.has(a.id);
              return (
              <div
                key={a.id}
                className="rounded border border-red-200 bg-card p-2 space-y-1"
                data-testid={`row-prod-action-lever-${a.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm">{a.title}</div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-300 text-red-800 hover:bg-red-100 shrink-0"
                    disabled={isFiring}
                    onClick={() => setLeverConfirmId(a.id)}
                    data-testid={`button-prod-action-lever-${a.id}`}
                  >
                    {isFiring ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Firing…
                      </>
                    ) : (
                      "Fire lever"
                    )}
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">{a.description}</div>
                <div className="text-xs font-mono text-foreground">{a.change}</div>
                <div
                  className="text-xs text-muted-foreground"
                  data-testid={`text-prod-action-lever-detail-${a.id}`}
                >
                  {a.status.detail}
                </div>
              </div>
              );
            })}
          </div>

          {/* Task #4842 — plain statement of Apply-all's true scope: it
              presses every registered action in a fixed order, not just the
              attention rows above. Always rendered next to the control. */}
          <div
            className="text-caption text-muted-foreground pt-1"
            data-testid="text-prod-actions-apply-scope"
          >
            Apply all runs every registered action
            {registeredCount > 0 ? ` (${registeredCount})` : ""} in a fixed
            order — not just the rows shown above. Settled actions report
            “not needed”; manual levers are excluded and fire individually.
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {activeBadgeCount === 0
                ? "Nothing pending — all actions already applied."
                : `${pendingCount} pending${errorCount > 0 ? `, ${errorCount} error(s)` : ""}${
                    reconnectBlockedCount > 0 ? `, ${reconnectBlockedCount} needs reconnect` : ""
                  }${
                    waitingBlockedCount > 0 ? `, ${waitingBlockedCount} blocked/waiting` : ""
                  }.${
                    actionableCount === 0 && reconnectBlockedCount > 0
                      ? " Reconnect the integration to clear the remaining items."
                      : actionableCount === 0 && waitingBlockedCount > 0
                        ? " Waiting items clear on their own once their preconditions are met."
                        : ""
                  }`}
            </div>
            <Button
              size="sm"
              variant="default"
              disabled={statusQuery.isLoading || applyMutation.isPending || actionableCount === 0}
              onClick={() => setConfirmOpen(true)}
              data-testid="button-prod-actions-apply"
            >
              {applyMutation.isPending ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Applying…
                </>
              ) : (
                "Apply all"
              )}
            </Button>
          </div>
        </CardContent>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-2xl" data-testid="dialog-prod-actions-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply all pending prod actions?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-prod-actions-confirm-scope">
              {/* Task #4842 — Apply all presses EVERY registered action in
                  its fixed order, not just the attention rows listed below;
                  the results toast/list partition out the ones that did
                  work. Manual levers stay excluded (Task #4019). */}
              Apply all runs every registered action
              {registeredCount > 0 ? ` (${registeredCount})` : ""} in a fixed
              order — not just the {active.length} row(s) needing attention
              below. Each is idempotent: anything already in its target state
              reports “not needed”. Manual levers are excluded and fire
              individually. The CEO actor is recorded for every write.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div
            className="max-h-72 overflow-y-auto space-y-2 rounded border bg-muted/50 p-2"
            data-testid="list-prod-actions-confirm"
          >
            {active.map((a) => (
              <div
                key={a.id}
                className="rounded border bg-card p-2 space-y-1"
                data-testid={`row-prod-action-confirm-${a.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm">{a.title}</div>
                  <StateBadge
                    state={a.status.state}
                    blockedFlavor={blockedFlavorOf(a.status.integration)}
                  />
                </div>
                <div className="text-xs text-muted-foreground">{a.description}</div>
                <div className="text-xs font-mono text-foreground">{a.change}</div>
                <div className="text-xs text-muted-foreground">{a.status.detail}</div>
              </div>
            ))}
            {active.length === 0 && (
              <div className="text-xs text-muted-foreground">
                No pending actions.
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-prod-actions-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                applyMutation.mutate();
              }}
              data-testid="button-prod-actions-confirm"
            >
              Apply all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task #4019 — per-lever confirmation. Levers are consequential by
          design (e.g. rolling Zoom back to the legacy app), so each press
          confirms individually and shows the lever's full description. */}
      <AlertDialog
        open={leverToConfirm !== null}
        onOpenChange={(o) => {
          if (!o) {
            setLeverConfirmId(null);
            setLeverConfirmation("");
          }
        }}
      >
        <AlertDialogContent className="max-w-xl" data-testid="dialog-prod-action-lever-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{leverToConfirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              This is a deliberate one-press lever — it is excluded from Apply
              all and runs immediately when you confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {leverToConfirm && (
            <>
              <div className="rounded border bg-muted/50 p-2 space-y-1 text-xs">
                <div className="text-muted-foreground">{leverToConfirm.description}</div>
                <div className="font-mono text-foreground">{leverToConfirm.change}</div>
                <div className="text-muted-foreground">{leverToConfirm.status.detail}</div>
              </div>
              {leverToConfirm.destructiveConfirmation && (
                <div className="rounded border border-red-300 bg-red-50 p-3 space-y-2">
                  <div className="text-sm font-medium text-red-900">
                    {leverToConfirm.destructiveConfirmation.warning}
                  </div>
                  <label className="block text-xs text-red-900" htmlFor="prod-action-destructive-confirmation">
                    Type <span className="font-mono font-semibold">{leverToConfirm.destructiveConfirmation.phrase}</span> to confirm.
                  </label>
                  <Input
                    id="prod-action-destructive-confirmation"
                    value={leverConfirmation}
                    onChange={(event) => setLeverConfirmation(event.target.value)}
                    autoComplete="off"
                    data-testid="input-prod-action-destructive-confirmation"
                  />
                </div>
              )}
            </>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-prod-action-lever-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-700 hover:bg-red-800"
              onClick={() => {
                const id = leverConfirmId;
                const confirmation = leverConfirmation;
                setLeverConfirmId(null);
                setLeverConfirmation("");
                if (id) {
                  void fireLever({
                    actionId: id,
                    ...(confirmation ? { confirmation } : {}),
                  });
                }
              }}
              disabled={
                Boolean(leverToConfirm?.destructiveConfirmation) &&
                leverConfirmation !== leverToConfirm?.destructiveConfirmation?.phrase
              }
              data-testid="button-prod-action-lever-confirm"
            >
              Fire lever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={dailyJudgmentConfirmOpen}
        onOpenChange={setDailyJudgmentConfirmOpen}
      >
        <AlertDialogContent
          className="max-w-xl"
          data-testid="dialog-daily-judgments-run-all-confirm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Run ratings for every active client?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-daily-judgments-run-all-scope">
              This starts the existing daily judgment process across every active
              client. It runs in the background, so this confirmation only
              acknowledges that the portfolio-wide work was started.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-daily-judgments-run-all-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-700 hover:bg-red-800"
              onClick={() => {
                setDailyJudgmentConfirmOpen(false);
                dailyJudgmentMutation.mutate();
              }}
              data-testid="button-daily-judgments-run-all-confirm"
            >
              Run ratings
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
