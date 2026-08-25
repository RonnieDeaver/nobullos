/**
 * Task #5156 — ClickUp Role Projection status presenter helper.
 *
 * Reusable components and utilities for surfacing ClickUp projection
 * status in the UI. The NoBull assignment always succeeds independently
 * of projection — toasts must never be destructive for vendor failures.
 */

import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, Ban, Pause, XCircle } from "lucide-react";

// ─── Projection status kind ───────────────────────────────────────────────────

export type ProjectionStatusKind =
  | "synced"
  | "pending"
  | "ambiguous"
  | "blocked"
  | "failed"
  | "disabled"
  | "drift"
  | "nobull_only"
  | "unconfigured";

// ─── Toast label helper ───────────────────────────────────────────────────────

/**
 * Given a projection summary from a successful mutation response,
 * returns a human-readable ClickUp status label for use in toast
 * descriptions.
 *
 * Rules:
 * - "ClickUp synced" ONLY when all staged === synced (aggregate state synced).
 * - "ClickUp pending" when any staged > 0 and aggregate state pending/ambiguous.
 * - "ambiguous/read-back pending" when ambiguous.
 * - "blocked/NoBull saved" when all blocked.
 * - "paused/disabled" when disabled.
 * - "failed" when failed.
 * - "NoBull-only" when nobullOnly > 0 and staged === 0.
 * - null when no projection info (graceful degradation).
 *
 * Never call this "synced" for pending/ambiguous states.
 */
export function projectionToastLabel(projection: unknown): string | null {
  if (!projection || typeof projection !== "object") return null;
  const p = projection as Record<string, unknown>;
  const staged = Number(p.staged ?? 0);
  const nobullOnly = Number(p.nobullOnly ?? 0);
  const blocked = Number(p.blocked ?? 0);
  const disabled = Number(p.disabled ?? 0);
  const state = typeof p.state === "string" ? p.state : null;

  // If the aggregate reports an explicit state, use it.
  if (state === "synced" && staged > 0) return "ClickUp synced";
  if (state === "ambiguous") return "ClickUp ambiguous/read-back pending";
  if (state === "failed") return "ClickUp failed";
  if (state === "blocked") return "ClickUp blocked/NoBull saved";
  if (state === "disabled") return "ClickUp paused/disabled";
  if (state === "pending") return "ClickUp pending";
  if (state === "drift") return "ClickUp drift/re-syncing";

  // Infer from counts when no explicit aggregate state.
  if (staged === 0 && blocked === 0 && disabled === 0) {
    if (nobullOnly > 0) return "NoBull-only (no ClickUp destination configured)";
    return null;
  }
  if (disabled > 0 && staged === 0 && blocked === 0) return "ClickUp paused/disabled";
  if (blocked > 0 && staged === 0) return "ClickUp blocked/NoBull saved";
  if (staged > 0) return "ClickUp pending";
  return null;
}

// ─── Status badge component ───────────────────────────────────────────────────

const KIND_CONFIG: Record<ProjectionStatusKind, {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  className?: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = {
  synced: {
    label: "ClickUp synced",
    variant: "secondary",
    className: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800",
    Icon: CheckCircle2,
  },
  pending: {
    label: "ClickUp pending",
    variant: "secondary",
    className: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800",
    Icon: Clock,
  },
  ambiguous: {
    label: "ClickUp ambiguous",
    variant: "secondary",
    className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
    Icon: AlertTriangle,
  },
  blocked: {
    label: "ClickUp blocked",
    variant: "secondary",
    className: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-800",
    Icon: Ban,
  },
  failed: {
    label: "ClickUp failed",
    variant: "secondary",
    className: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800",
    Icon: XCircle,
  },
  disabled: {
    label: "ClickUp paused",
    variant: "secondary",
    className: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800/30 dark:text-gray-400 dark:border-gray-700",
    Icon: Pause,
  },
  drift: {
    label: "ClickUp drift",
    variant: "secondary",
    className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
    Icon: RefreshCw,
  },
  nobull_only: {
    label: "NoBull-only",
    variant: "outline",
    Icon: CheckCircle2,
  },
  unconfigured: {
    label: "ClickUp unconfigured",
    variant: "outline",
    Icon: Ban,
  },
};

export function ProjectionStatusBadge({ kind }: { kind: ProjectionStatusKind }) {
  const config = KIND_CONFIG[kind] ?? KIND_CONFIG.unconfigured;
  const { Icon } = config;
  return (
    <Badge
      variant={config.variant}
      className={`inline-flex items-center gap-1 text-xs ${config.className ?? ""}`}
      data-testid={`projection-badge-${kind}`}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

// ─── Status row type for the status list ──────────────────────────────────────

export interface ProjectionStatusRow {
  clientId: string;
  departmentId: string;
  responsibility: string;
  kind: ProjectionStatusKind;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  attemptCount: number;
  maxAttempts: number;
  resyncEligible: boolean;
  nextAttemptAt: string | null;
  updatedAt: string | null;
}

// ─── Resync-eligible kinds ────────────────────────────────────────────────────

export const RESYNC_ELIGIBLE_KINDS: ProjectionStatusKind[] = [
  "failed",
  "blocked",
];

export function isResyncEligible(
  row: Pick<ProjectionStatusRow, "kind" | "resyncEligible">,
): boolean {
  return row.resyncEligible === true && RESYNC_ELIGIBLE_KINDS.includes(row.kind);
}

// ─── Compact status card ──────────────────────────────────────────────────────

export function ProjectionStatusCard({
  row,
  clientName,
  deptName,
  onResync,
  resyncingKey,
}: {
  row: ProjectionStatusRow;
  clientName?: string;
  deptName?: string;
  onResync: (row: ProjectionStatusRow) => void;
  resyncingKey: string | null;
}) {
  const rowKey = `${row.clientId}:${row.departmentId}:${row.responsibility}`;
  const isSyncing = resyncingKey === rowKey;
  const eligible = isResyncEligible(row);

  return (
    <div
      className="flex items-start justify-between gap-3 px-4 py-2.5 text-xs"
      data-testid={`projection-status-row-${row.departmentId}-${row.responsibility}`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <ProjectionStatusBadge kind={row.kind} />
          {deptName && (
            <span className="text-muted-foreground font-medium">{deptName}</span>
          )}
          {clientName && (
            <span className="text-muted-foreground">/ {clientName}</span>
          )}
          <span className="text-muted-foreground capitalize">{row.responsibility}</span>
        </div>
        {row.lastError && (
          <div
            className="text-red-600 dark:text-red-400 truncate max-w-xs"
            title={row.lastError}
            data-testid={`projection-error-${row.departmentId}-${row.responsibility}`}
          >
            {row.lastError.slice(0, 120)}
          </div>
        )}
        {(row.lastErrorCode || row.desiredClickupUserId || row.nextAttemptAt) && (
          <div
            className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5"
            data-testid={`projection-diagnostics-${row.departmentId}-${row.responsibility}`}
          >
            {row.lastErrorCode && <span>Error code: {row.lastErrorCode}</span>}
            {row.desiredClickupUserId && <span>ClickUp person: {row.desiredClickupUserId}</span>}
            {row.nextAttemptAt && <span>Next retry: {new Date(row.nextAttemptAt).toLocaleString()}</span>}
          </div>
        )}
        {row.updatedAt && (
          <div className="text-muted-foreground">
            Updated: {new Date(row.updatedAt).toLocaleString()}
            {row.attemptCount > 0 &&
              ` · ${row.attemptCount}/${row.maxAttempts} attempt${row.attemptCount !== 1 ? "s" : ""}`}
          </div>
        )}
      </div>
      {eligible && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs shrink-0"
          disabled={isSyncing}
          onClick={() => onResync(row)}
          data-testid={`button-resync-${row.departmentId}-${row.responsibility}`}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? "Resyncing…" : "Re-sync"}
        </Button>
      )}
    </div>
  );
}
