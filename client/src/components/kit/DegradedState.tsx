import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * DegradedState — the app's "integration needs attention" panel, codified from
 * the Integrations Hub Zoom reconnect card (the audit's exemplar).
 *
 * A degraded state must tell the operator four things, and the slots keep
 * them in that order:
 *
 *   1. `title` + `since`   — what broke, and how long it has been engaged
 *   2. diagnostics         — why (children: reason lines, missing scopes, …)
 *   3. `retryAt`/`retryPaused` — what the system will do about it by itself
 *   4. `action`            — the explicit human path out (e.g. Reconnect)
 *
 * Tones map onto the status tokens: `warn` (default) for degraded-but-working
 * or reconnect-required, `critical` only when the condition is
 * actionable-now-or-else. Token-only, square-cornered.
 */
export type DegradedTone = "warn" | "critical";

const TONE_CLASSES: Record<
  DegradedTone,
  { container: string; body: string }
> = {
  warn: {
    container: "border-status-warn/50 bg-status-warn/10",
    body: "text-status-warn",
  },
  critical: {
    container: "border-status-critical/50 bg-status-critical/10",
    body: "text-status-critical",
  },
};

/**
 * "2h 5m ago" — duration-engaged formatter shared by every degraded surface
 * (moved verbatim from the Integrations Hub Zoom card).
 */
export function formatEngagedFor(sinceMs: number): string {
  const diffMs = Math.max(0, Date.now() - sinceMs);
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return "just now";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  let primary: string;
  let secondary: string | null = null;
  if (days > 0) {
    primary = `${days}d`;
    if (hours > 0) secondary = `${hours}h`;
  } else if (hours > 0) {
    primary = `${hours}h`;
    if (minutes > 0) secondary = `${minutes}m`;
  } else {
    primary = `${minutes}m`;
  }
  return secondary ? `${primary} ${secondary} ago` : `${primary} ago`;
}

export interface DegradedStateProps {
  /** What broke, operator-voiced: "Zoom needs to be reconnected". */
  title: ReactNode;
  /** `warn` (default) or `critical` — see the status-token usage rule. */
  tone?: DegradedTone;
  /** Override the leading icon (defaults to a triangle alert). */
  icon?: ReactNode;
  /**
   * Epoch ms / Date / ISO string of when the condition engaged. Renders
   * "· Engaged 2h 5m ago" next to the title with a full-timestamp tooltip.
   */
  since?: number | string | Date | null;
  /** data-testid for the engaged-for span. */
  sinceTestId?: string;
  /**
   * Next self-heal attempt. Renders "Auto-retry at <time>" with a
   * full-timestamp tooltip. Ignored while `retryPaused` is true.
   */
  retryAt?: Date | string | null;
  /** Self-heal parked: renders the paused line instead of a retry time. */
  retryPaused?: boolean;
  /** Copy for the paused line. */
  retryPausedLabel?: ReactNode;
  /**
   * data-testid prefix for the retry block: the container gets the prefix
   * itself, the paused span `-parked`, the retry-time span `-cooldown-until`.
   */
  retryTestIdPrefix?: string;
  /** Explicit recovery CTA(s), e.g. a Reconnect button. */
  action?: ReactNode;
  /** Diagnostics: reason lines, missing-scope lists, etc. */
  children?: ReactNode;
  className?: string;
  /** Convenience alias for `data-testid` on the panel. */
  testId?: string;
}

export function DegradedState({
  title,
  tone = "warn",
  icon,
  since,
  sinceTestId,
  retryAt,
  retryPaused = false,
  retryPausedLabel = "Auto-retry paused — reconnect required",
  retryTestIdPrefix,
  action,
  children,
  className,
  testId,
}: DegradedStateProps) {
  const toneClasses = TONE_CLASSES[tone];

  let sinceMs: number | null = null;
  if (since != null) {
    const ms = typeof since === "number" ? since : new Date(since).getTime();
    if (Number.isFinite(ms)) sinceMs = ms;
  }

  const retryAtDate = retryAt ? new Date(retryAt) : null;
  const hasRetryLine = retryPaused || retryAtDate !== null;

  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn("space-y-2 border p-3", toneClasses.container, className)}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn("mt-0.5 shrink-0 [&_svg]:h-4 [&_svg]:w-4", toneClasses.body)}
        >
          {icon ?? <AlertTriangle />}
        </span>
        <div className={cn("space-y-1 text-caption", toneClasses.body)}>
          <div className="font-semibold">
            {title}
            {sinceMs !== null && (
              <span
                className="ml-2 font-normal opacity-80"
                data-testid={sinceTestId}
                title={new Date(sinceMs).toLocaleString()}
              >
                · Engaged {formatEngagedFor(sinceMs)}
              </span>
            )}
          </div>
          {children}
        </div>
      </div>
      {hasRetryLine && (
        <div
          className={cn("pl-6 text-caption opacity-90", toneClasses.body)}
          data-testid={retryTestIdPrefix}
        >
          {retryPaused ? (
            <span
              data-testid={
                retryTestIdPrefix ? `${retryTestIdPrefix}-parked` : undefined
              }
            >
              {retryPausedLabel}
            </span>
          ) : (
            retryAtDate && (
              <span
                data-testid={
                  retryTestIdPrefix
                    ? `${retryTestIdPrefix}-cooldown-until`
                    : undefined
                }
                title={retryAtDate.toLocaleString()}
              >
                Auto-retry at {retryAtDate.toLocaleTimeString()}
              </span>
            )
          )}
        </div>
      )}
      {action}
    </div>
  );
}
