import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";

/**
 * Task #4344 — SectionNav is a sticky anchor rail for the panel's monolithic
 * consoles (audit §6.1-E / §8.3): system health stacks 15+ sections with no
 * jump-nav, and match settings is 6,384px tall. It registers a list of page
 * sections, jumps to one when clicked, and tracks scroll position so the
 * current section stays highlighted.
 *
 * Token-only styling: the rail pins on the `--z-sticky` rung of the documented
 * z-scale, corners stay square (`--radius: 0rem`), and the active/idle states
 * use `--primary` / `--muted-foreground` with a `--surface-warm-1` active fill.
 *
 * Scroll tracking uses IntersectionObserver when available and degrades
 * gracefully (click-driven highlight only) when it is absent, so the rail works
 * in any long console and stays testable under jsdom.
 */

export interface SectionNavItem {
  /** DOM id of the target section element (matches `id={...}` on the section). */
  id: string;
  /** Human label shown in the rail. */
  label: string;
}

export interface SectionNavProps {
  /** Registered sections, in document order. */
  sections: SectionNavItem[];
  /** Optional rail heading (e.g. "On this page"). */
  title?: string;
  /**
   * Pixel offset applied when tracking/jumping, to account for the sticky
   * global nav overlapping the top of each section. Defaults to 56 (h-14 nav).
   */
  offset?: number;
  /** Root className passthrough (merged after the sticky chrome). */
  className?: string;
}

export function SectionNav({
  sections,
  title = "On this page",
  offset = 56,
  className,
}: SectionNavProps) {
  const [activeId, setActiveId] = useState<string | null>(
    sections.length > 0 ? sections[0].id : null,
  );

  // Scroll tracking: highlight the most-visible registered section. Guarded so
  // the rail still renders (click-jump only) where IntersectionObserver is
  // unavailable.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target as HTMLElement | undefined;
        if (top?.id) setActiveId(top.id);
      },
      {
        // Nudge the observation window down past the sticky nav so a section
        // counts as "current" once its top clears the chrome.
        rootMargin: `-${offset}px 0px -55% 0px`,
        threshold: [0, 0.25, 0.5, 1],
      },
    );

    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections, offset]);

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (el) {
      // CSS `scroll-behavior: auto` can't override an explicit JS behavior
      // option, so honor prefers-reduced-motion here directly (Task #4659;
      // shared helper extracted in Task #4676).
      el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
    }
    setActiveId(id);
  }

  if (sections.length === 0) return null;

  return (
    <nav
      aria-label={title}
      data-testid="section-nav"
      className={cn(
        "sticky top-14 z-[var(--z-sticky)] self-start border border-border bg-surface-warm-2",
        className,
      )}
    >
      {title && (
        <p className="px-3 pt-3 pb-1 text-caption font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      )}
      <ul className="pb-2">
        {sections.map((section) => {
          const isActive = section.id === activeId;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                data-testid={`section-nav-link-${section.id}`}
                aria-current={isActive ? "true" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  jumpTo(section.id);
                }}
                className={cn(
                  "block border-l-2 px-3 py-1.5 text-body transition-colors",
                  isActive
                    ? "border-primary-ink bg-surface-warm-1 font-medium text-primary-ink"
                    : "border-transparent text-muted-foreground hover:text-primary-ink",
                )}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
