import { Link } from "wouter";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Task #4344 — PageHeader codifies the admin panel's "Pattern A" page header
 * (audit §6.1-B / §8.3): a primary-color title with an always-present back
 * affordance, an optional right-side action slot, and an optional breadcrumb
 * for pages nested more than two levels deep. Before this component the panel
 * ran two rival header grammars; several Pattern-A pages (Twilio, Zoom, match
 * settings, system health, audit retention) hand-rolled the same anatomy with
 * slightly different colors and spacing, and one page (Backups) shipped no back
 * affordance at all.
 *
 * Rendering is exclusively from design tokens: the title/icon use `--accent`
 * (crimson page-header identity — one of the sanctioned brand-identity
 * moments under the constitution's accent usage rule, Task #4600 rebalance;
 * dark mode keeps a light heading tone via `dark:text-foreground` per the
 * HEADINGS section) rather than the deprecated legacy burgundy fork
 * the old hand-rolled headers used (retired by the 2026-08 mass re-token),
 * corners stay
 * square (`--radius: 0rem`), and the optional sticky sub-bar sits on the
 * `--z-sticky` rung of the documented z-scale.
 *
 * The Twilio console is the faithful proof adopter: with no subtitle,
 * breadcrumb, actions, or sticky flag the emitted markup is the same flex row
 * it always had (ghost back button + `text-2xl font-bold` title with an inline
 * icon), so it looks unchanged apart from the sanctioned color-token shift.
 */

export interface BreadcrumbCrumb {
  label: string;
  /** Omit `href` for the current (last) crumb; it renders as static text. */
  href?: string;
}

export interface PageHeaderProps {
  /** Page title (one per page). */
  title: string;
  /**
   * Back-affordance target. Always present — Pattern A never ships a page
   * without a way back (the audit flagged Backups for exactly this).
   */
  backHref: string;
  /** Back-button label. Defaults to "Back". */
  backLabel?: string;
  /** Optional leading icon, rendered inline before the title (like the source pages). */
  icon?: LucideIcon;
  /** Optional secondary line under the title. */
  subtitle?: string;
  /** Optional right-side action slot (buttons, reset-view control, etc.). */
  actions?: React.ReactNode;
  /**
   * Optional breadcrumb. Per the audit it is rendered ONLY for pages deeper
   * than two levels (i.e. more than two crumbs); shallower pages rely on the
   * back affordance alone, so a 1–2 entry breadcrumb is intentionally ignored.
   */
  breadcrumb?: BreadcrumbCrumb[];
  /**
   * When true, render as a sticky sub-bar (bg + bottom border + blur) pinned
   * below the global nav on the `--z-sticky` rung. Defaults to false so inline
   * canvas headers (Twilio, match settings) stay exactly as they were.
   */
  sticky?: boolean;
  /**
   * On-band variant (Task #4451): light-on-dark tokens for headers that sit on
   * a `--chrome` brand band (e.g. the NoBull Brief Studio's full-width chrome
   * bar; Task #4600 moved chrome bands off `--primary` onto the chrome tokens).
   * The PARENT supplies the band background (`bg-chrome` wrapper); this flag
   * only flips the anatomy's colors — title/back render `text-chrome-foreground`
   * instead of the accent title (which would be invisible on its own band).
   * Mutually independent from `sticky` (the sticky sub-bar keeps its light bg).
   */
  onBand?: boolean;
  /** Root className passthrough (merged after the sticky chrome). */
  className?: string;
  /** Test id for the back button. Defaults to "button-back". */
  backTestId?: string;
  /** Test id for the title. Defaults to "text-page-title". */
  titleTestId?: string;
}

export function PageHeader({
  title,
  backHref,
  backLabel = "Back",
  icon: Icon,
  subtitle,
  actions,
  breadcrumb,
  sticky = false,
  onBand = false,
  className,
  backTestId = "button-back",
  titleTestId = "text-page-title",
}: PageHeaderProps) {
  // Breadcrumb is a deep-page affordance only: >2-level depth (audit §8.3).
  const showBreadcrumb = Array.isArray(breadcrumb) && breadcrumb.length > 2;

  const heading = (
    <h1
      className={cn(
        "text-2xl font-bold",
        onBand ? "text-chrome-foreground" : "text-accent dark:text-foreground",
      )}
      data-testid={titleTestId}
    >
      {Icon && <Icon className="w-6 h-6 inline mr-2" />}
      {title}
    </h1>
  );

  return (
    <div
      data-testid="page-header"
      className={cn(
        sticky &&
          "sticky top-14 z-[var(--z-sticky)] border-b border-border bg-surface-warm-2/85 backdrop-blur-sm",
        className,
      )}
    >
      {showBreadcrumb && (
        <nav
          className="mb-2 flex items-center gap-1 text-caption text-muted-foreground"
          aria-label="Breadcrumb"
          data-testid="page-header-breadcrumb"
        >
          {breadcrumb!.map((crumb, i) => {
            const isLast = i === breadcrumb!.length - 1;
            return (
              <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="w-3 h-3" aria-hidden="true" />}
                {crumb.href && !isLast ? (
                  <Link href={crumb.href} className="hover:text-primary-ink">
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={isLast ? "text-foreground font-medium" : undefined}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
      )}

      {/* flex-wrap: rollout hardening (Task #4355) — long titles/action
          clusters wrap instead of forcing horizontal page scroll at 375px
          (OS mobile layout baseline). Single-line rendering is unchanged. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className={cn(
            onBand && "text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground",
          )}
          data-testid={backTestId}
        >
          <Link href={backHref}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            {backLabel}
          </Link>
        </Button>

        {subtitle ? (
          <div className="min-w-0">
            {heading}
            <p
              className={cn(
                "text-sm",
                onBand ? "text-chrome-foreground/70" : "text-muted-foreground",
              )}
              data-testid="text-page-subtitle"
            >
              {subtitle}
            </p>
          </div>
        ) : (
          heading
        )}

        {actions && (
          <div className="ml-auto" data-testid="page-header-actions">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
