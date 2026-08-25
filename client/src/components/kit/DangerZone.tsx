import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * DangerZone — the separated home for destructive actions (P1-7).
 *
 * The rule this component bakes in: destructive actions (Archive, Initiate
 * Offboard, force-stop, delete) NEVER sit adjacent to routine actions. They
 * live in this visually separated region, and by default the actions are
 * additionally gated behind an explicit "Show destructive actions" reveal —
 * two deliberate moves before anything irreversible is even clickable.
 *
 * This region is `--status-critical`-framed because its contents are
 * actionable-now by definition; that is the one sanctioned "red at rest"
 * exception, and it stays an outline (no loud fill). Each action inside
 * should still bring its own confirmation (e.g. AlertDialog) — the zone
 * separates, the dialog confirms.
 */
export interface DangerZoneProps {
  /** Region heading. */
  title?: ReactNode;
  /** What lives here / what makes it dangerous. */
  description?: ReactNode;
  /**
   * Gate the actions behind an explicit reveal (default). Set `false` only
   * for surfaces that are already a dedicated danger page.
   */
  collapsible?: boolean;
  /** Start revealed (only meaningful while `collapsible`). */
  defaultOpen?: boolean;
  /** The destructive actions themselves. */
  children: ReactNode;
  className?: string;
  /**
   * Convenience alias for `data-testid`; the reveal toggle gets
   * `-toggle`, the actions region `-actions`.
   */
  testId?: string;
}

export function DangerZone({
  title = "Danger zone",
  description,
  collapsible = true,
  defaultOpen = false,
  children,
  className,
  testId,
}: DangerZoneProps) {
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const regionId = useId();
  const showActions = !collapsible || open;

  return (
    <section
      data-testid={testId}
      className={cn("border border-status-critical/40", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-body font-semibold text-status-critical">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            {title}
          </div>
          {description && (
            <p className="mt-0.5 text-caption text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {collapsible && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-status-critical hover:text-status-critical"
            aria-expanded={open}
            aria-controls={regionId}
            data-testid={testId ? `${testId}-toggle` : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide destructive actions" : "Show destructive actions"}
            {open ? (
              <ChevronUp aria-hidden="true" className="ml-1 h-3 w-3" />
            ) : (
              <ChevronDown aria-hidden="true" className="ml-1 h-3 w-3" />
            )}
          </Button>
        )}
      </div>
      {showActions && (
        <div
          id={regionId}
          role="group"
          aria-label="Destructive actions"
          className="flex flex-wrap items-center gap-2 border-t border-status-critical/30 p-3"
          data-testid={testId ? `${testId}-actions` : undefined}
        >
          {children}
        </div>
      )}
    </section>
  );
}
