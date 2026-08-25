import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * EmptyState — the app's educational empty state, codified from the webhook
 * import logs page (the audit's exemplar).
 *
 * An empty state is a teaching moment, not a dead end. The slots enforce the
 * anatomy the exemplar got right:
 *
 *   - `title`       — what this surface is ("No webhook import attempts yet")
 *   - `description` — when rows will appear ("Imports are triggered via …")
 *   - `hint`        — how to test / produce data (caption-sized fine print)
 *   - `action`      — optional CTA(s), centered under the copy
 *
 * Token-only: muted foreground on the parent surface, square corners, no
 * ad-hoc grays.
 */
export interface EmptyStateProps {
  /**
   * Icon node, e.g. `<Webhook />`. Sized to 48px automatically. Flagship
   * empty states may pass a `<BrandMark kind="icon" variant="earth" />`
   * instead — img children get the same 48px sizing (exact artwork, only
   * resized).
   */
  icon?: ReactNode;
  /** What this surface is. Required — an empty state must say what's empty. */
  title: ReactNode;
  /** When/how rows will appear. */
  description?: ReactNode;
  /** How to test or produce data — caption-sized supporting line. */
  hint?: ReactNode;
  /** Optional CTA slot (buttons/links), centered under the copy. */
  action?: ReactNode;
  /** Extra free-form content (e.g. an API how-to block). */
  children?: ReactNode;
  className?: string;
  /** Convenience alias for `data-testid`. */
  testId?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  hint,
  action,
  children,
  className,
  testId,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn("py-8 text-center text-muted-foreground", className)}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mx-auto mb-4 flex justify-center text-muted-foreground/40 [&_svg]:h-12 [&_svg]:w-12 [&_img]:h-12 [&_img]:w-auto"
        >
          {icon}
        </div>
      )}
      <p className="text-body font-medium">{title}</p>
      {description && <p className="mt-2 text-body">{description}</p>}
      {hint && <div className="mt-2 text-caption">{hint}</div>}
      {children}
      {action && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
        </div>
      )}
    </div>
  );
}
