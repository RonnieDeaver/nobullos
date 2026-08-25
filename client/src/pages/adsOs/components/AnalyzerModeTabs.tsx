import type { KeyboardEvent } from "react";
import { Link } from "wouter";

export type AnalyzerMode = "negatives" | "keywords";

interface Props {
  cid: string;
  activeMode: AnalyzerMode;
}

const MODES: Array<{ mode: AnalyzerMode; label: string }> = [
  { mode: "negatives", label: "Negative Keywords" },
  { mode: "keywords", label: "New Keywords" },
];

/**
 * Route-aware Search Term Analyzer mode switch.
 *
 * The links preserve the two existing deep routes while presenting them as a
 * single keyboard-operable tab set. Arrow/Home/End navigation activates the
 * corresponding route; Tab leaves the set from its active item.
 */
export function AnalyzerModeTabs({ cid, activeMode }: Props) {
  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % MODES.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + MODES.length) % MODES.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = MODES.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
    const nextTab = tabs?.[nextIndex];
    nextTab?.focus();
    nextTab?.click();
  }

  return (
    <div className="analyzer-mode-tabs" role="tablist" aria-label="Analyzer mode">
      {MODES.map(({ mode, label }, index) => {
        const active = mode === activeMode;
        return (
          <Link
            key={mode}
            id={`analyzer-mode-tab-${mode}`}
            href={`/ads-os/a/${cid}/analyzer/${mode}`}
            className={`analyzer-mode-tab${active ? " is-active" : ""}`}
            role="tab"
            aria-selected={active}
            aria-controls="analyzer-mode-panel"
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-testid={`tab-analyzer-${mode}`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}