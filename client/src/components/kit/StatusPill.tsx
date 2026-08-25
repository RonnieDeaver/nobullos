import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * StatusPill — the app's one way to render a status chip.
 *
 * Tones map 1:1 onto the `--status-*` tokens in `client/src/index.css`, which
 * also documents the usage rule this component bakes in:
 *
 *   RED ONLY FOR ACTIONABLE-NOW. `critical` marks conditions a human should
 *   act on right now. Anything at rest, historical, or merely informational
 *   renders `neutral` (the default). Healthy is quiet: `ok` marks
 *   confirmed-good *moments* (a passing check, a recovery), not the permanent
 *   dress of every healthy row. `warn` = degraded-but-working / attention
 *   soon. `info` = neutral-positive FYI accents.
 *
 * The default tone is deliberately `neutral` so a pill is calm unless the
 * call site explicitly claims otherwise.
 *
 * Pills are the sole sanctioned rounded shape in the internal OS
 * (`--radius-pill`); everything else stays square.
 */
export type StatusTone = "neutral" | "ok" | "warn" | "critical" | "info";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  ok: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  warn: "border-status-warn/40 bg-status-warn/10 text-status-warn",
  critical: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  info: "border-status-info/40 bg-status-info/10 text-status-info",
};

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  /** Visual tone. Defaults to `neutral` — the at-rest state. */
  tone?: StatusTone;
  /** Renders a small leading dot in the tone color. */
  dot?: boolean;
  /** Convenience alias for `data-testid`. */
  testId?: string;
  children: ReactNode;
}

export function StatusPill({
  tone = "neutral",
  dot = false,
  testId,
  className,
  children,
  ...rest
}: StatusPillProps) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-0.5 text-caption font-medium",
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-pill bg-current"
        />
      )}
      {children}
    </span>
  );
}
