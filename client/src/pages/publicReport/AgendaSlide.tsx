/**
 * AgendaSlide — one slide of the public client report.
 * Extracted verbatim in Task #4271; redesigned in Task #4275 (audit §8.7-2):
 * roadmap rows are real anchor links that jump to their slides, the accent
 * system is a single gold (no alternating badge colors), each row carries a
 * one-line "what you'll learn", and the slide vertically centers its content
 * to remove the dead zone under the timeline.
 */

import {
  AlertCircle,
  BarChart3,
  ChevronRight,
  Crosshair,
  Eye,
  Heart,
  Settings,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { motion, Variants } from "framer-motion";
import { Slide } from "./Slide";
import type { PublicReportViewModel } from "./derive";
import { AGENDA_ROWS, jumpToSlide } from "./sections";
import { isAgendaRowPresent } from "./sectionPresence";

const ROW_ICONS: Record<string, LucideIcon> = {
  "ceo-pulse": Eye,
  "market-context": BarChart3,
  "engine-health": Settings,
  marketing: TrendingUp,
  closing: AlertCircle,
  "lifetime-value": Heart,
  "next-30-days": Crosshair,
};

export function AgendaSlide({ view }: { view: PublicReportViewModel }) {
  const { prefersReducedMotion, hasCeoPulse, hasMarketContext, sectionPresence, slideNumbers } = view;
  // Task #4693 (superseding the Task #4285 drop-out): the five data-section
  // rows render unconditionally — empty sections now render full slide
  // skeletons with an upsell callout, so every row has a destination. Only
  // the conditional NoBull-authored slides (NoBull Brief, Market Context)
  // keep their flags. The Task #4496 all-empty placeholder is gone with the
  // drop-out: rows can never all be absent now.
  const rows = AGENDA_ROWS.filter((row) =>
    isAgendaRowPresent(row.target, { hasCeoPulse, hasMarketContext, sectionPresence }),
  );

  const containerVars: Variants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
  };
  const itemVars: Variants = {
    hidden: { y: 20, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: { type: "spring", stiffness: 80, damping: 15 } },
  };

  return (
    <Slide slideNumber={slideNumbers.roadmap} variant="cream" pattern="geometric" id="agenda" vCenter>
      <div className="slide-header">
        <Target className="slide-header-icon text-report-crimson" />
        <h2 className="slide-title text-report-crimson">Today's Roadmap</h2>
      </div>
      <p className="text-sm text-report-ink-muted mb-4">
        Your report at a glance — select any section to jump straight to it.
      </p>

      {/* Decorative divider */}
      <div className="divider-gold" />

      {/* Vertical timeline of anchor links (§8.7-2) */}
      <motion.nav
        aria-label="Report sections"
        className="relative mt-4 flex"
        variants={containerVars}
        initial={prefersReducedMotion ? "visible" : "hidden"}
        animate="visible"
      >
        {/* Left spine — single gold accent */}
        <div className="absolute left-[18px] top-4 bottom-4 w-0.5 bg-report-gold/60" aria-hidden="true" />

        <div className="flex flex-col gap-4 w-full">
          {rows.map((row, idx) => {
            const Icon = ROW_ICONS[row.target] ?? Eye;
            return (
              <motion.a
                key={row.target}
                href={`#${row.target}`}
                onClick={(e) => jumpToSlide(e, row.target)}
                variants={itemVars}
                data-testid={`link-agenda-${row.target}`}
                className="group flex items-start gap-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-report-gold-ink focus-visible:ring-offset-2"
              >
                {/* Node */}
                <div
                  aria-hidden="true"
                  className="w-10 h-10 rounded-full bg-report-gold text-report-ink flex items-center justify-center text-sm font-bold shadow-md flex-shrink-0 z-10 group-hover:scale-110 transition-transform"
                >
                  {idx + 1}
                </div>

                {/* Card */}
                <div className="flex-1 min-w-0 bg-white rounded-lg p-4 shadow-sm border-l-4 border-report-gold transition-all group-hover:shadow-md group-hover:-translate-y-0.5 flex items-center gap-4">
                  <div
                    aria-hidden="true"
                    className="w-10 h-10 rounded-lg bg-report-gold/15 flex items-center justify-center flex-shrink-0"
                  >
                    <Icon className="w-5 h-5 text-report-gold-ink" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-report-ink leading-snug font-report-serif">
                      {row.headline}
                    </h3>
                    <p className="text-xs text-report-ink-muted leading-snug mt-1">{row.learn}</p>
                  </div>
                  <ChevronRight
                    aria-hidden="true"
                    className="w-4 h-4 text-report-ink-muted flex-shrink-0 transition-all group-hover:translate-x-1 group-hover:text-report-gold-ink print:hidden"
                  />
                </div>
              </motion.a>
            );
          })}
        </div>
      </motion.nav>
    </Slide>
  );
}
