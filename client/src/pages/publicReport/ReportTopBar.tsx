/**
 * ReportTopBar — sticky chrome for the public client report (Task #4275,
 * audit §8.7-1/2).
 *
 * Slide 1: the bar is transparent — the cover renders full-bleed beneath it
 * (the deck pulls up under the bar via .slideshow-container's -65px top
 * margin) and only a ghost Save-as-PDF button shows, so the cover logo and
 * wordmark can never clip under opaque chrome. Past the cover it becomes the
 * solid eggshell bar.
 *
 * ≤768px it also grows a progress/jump strip once past the cover: "n / total
 * · section", a scroll-progress rule, and a tap target back to the roadmap
 * (#agenda) — whose rows are the deck's anchor navigation.
 *
 * Scroll state lives here, NOT in PublicReport, so per-frame updates
 * re-render only this small component and never the slide tree.
 */

import { useEffect, useState } from "react";
import { ListOrdered, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jumpToSlide, SLIDE_LABELS } from "./sections";

/** Bar row height (h-16) + 1px bottom border. Must stay in lockstep with the
 *  -65px top margin on .slideshow-container in client/src/index.css. */
const BAR_HEIGHT_PX = 65;

interface ScrollNav {
  pastCover: boolean;
  current: number;
  total: number;
  label: string;
  pct: number;
}

const INITIAL_NAV: ScrollNav = { pastCover: false, current: 1, total: 0, label: "", pct: 0 };

export function ReportTopBar({
  title,
  printCountdown,
  isPrinting,
  onPrintClick,
}: {
  title: string;
  printCountdown: number | null;
  isPrinting: boolean;
  onPrintClick: () => void;
}) {
  const [nav, setNav] = useState<ScrollNav>(INITIAL_NAV);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const cover = document.getElementById("cover");
      // Flip once ~75% of the cover has scrolled away. The threshold must
      // exceed the anchor-landing offsets (scroll-margin-top: 5rem desktop /
      // 7.5rem mobile in index.css), or a jump back to the agenda would
      // leave the transparent over-cover chrome sitting on a cream slide
      // and unmount the mobile strip mid-scroll.
      const flipAt = Math.max(BAR_HEIGHT_PX, window.innerHeight * 0.25);
      const pastCover = cover
        ? cover.getBoundingClientRect().bottom <= flipAt
        : true;
      const sections = Array.from(
        document.querySelectorAll<HTMLElement>(".slideshow-container section[id]"),
      );
      const marker = window.innerHeight * 0.35;
      let idx = 0;
      sections.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= marker) idx = i;
      });
      const scrollable = Math.max(
        1,
        document.documentElement.scrollHeight - window.innerHeight,
      );
      const pct = Math.round(Math.min(100, Math.max(0, (window.scrollY / scrollable) * 100)));
      const id = sections[idx]?.id ?? "";
      setNav((prev) => {
        const next: ScrollNav = {
          pastCover,
          current: idx + 1,
          total: sections.length,
          label: SLIDE_LABELS[id] ?? id,
          pct,
        };
        return prev.pastCover === next.pastCover &&
          prev.current === next.current &&
          prev.total === next.total &&
          prev.label === next.label &&
          prev.pct === next.pct
          ? prev
          : next;
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    // Intentional JS resize listener (audit P2-9): a resize changes
    // scrollHeight/innerHeight, which feed the scroll-progress % and
    // current-slide computation — measured state CSS cannot express.
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const overCover = !nav.pastCover;

  return (
    // Task #4286 (audit #19) — the bar is <header> chrome. Its title is
    // deliberately NOT a heading: CoverSlide owns the deck's single h1, and
    // a second h1 in sticky chrome broke the document outline.
    <header
      className={`print:hidden sticky top-0 z-50 border-b transition-colors duration-300 ${
        overCover
          ? "bg-transparent border-transparent"
          : "bg-report-eggshell/95 backdrop-blur-sm border-report-crimson/10"
      }`}
    >
      <div className="max-w-7xl mx-auto h-16 px-6 flex justify-between items-center gap-4">
        <p
          className={`font-report-serif text-lg font-semibold text-report-crimson truncate min-w-0 ${
            overCover ? "invisible" : ""
          }`}
        >
          {title}
        </p>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            onClick={onPrintClick}
            disabled={printCountdown !== null || isPrinting}
            className={
              overCover
                ? "border border-white/40 bg-white/10 text-white hover:bg-white/20 disabled:opacity-50"
                : "bg-report-crimson hover:bg-report-crimson-deep disabled:opacity-50"
            }
          >
            <Printer className="w-4 h-4 mr-2" />{" "}
            {printCountdown !== null ? `Preparing (${printCountdown})...` : "Save as PDF"}
          </Button>
        </div>
      </div>

      {nav.pastCover && nav.total > 0 && (
        // <nav> landmark (Task #4286): the strip is chrome-level navigation
        // back to the roadmap, distinct from the agenda's own in-slide nav.
        <nav
          aria-label="Report progress"
          className="min-[769px]:hidden block border-t border-report-crimson/10"
        >
          <a
            href="#agenda"
            onClick={(e) => jumpToSlide(e, "agenda")}
            data-testid="link-report-progress"
            aria-label={`Section ${nav.current} of ${nav.total}: ${nav.label}. Jump back to the roadmap`}
            className="block"
          >
            <span className="px-6 py-4 flex items-center justify-between gap-4">
              <span className="text-xs font-medium text-report-ink truncate">
                <span className="text-report-ink-muted">
                  {nav.current} / {nav.total} ·{" "}
                </span>
                {nav.label}
              </span>
              <span className="shrink-0 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-report-crimson">
                <ListOrdered className="w-3.5 h-3.5" aria-hidden="true" />
                Roadmap
              </span>
            </span>
            <span className="block h-0.5 bg-report-crimson/10" aria-hidden="true">
              <span
                className="block h-full bg-report-crimson"
                style={{ width: `${nav.pct}%` }}
              />
            </span>
          </a>
        </nav>
      )}
    </header>
  );
}
