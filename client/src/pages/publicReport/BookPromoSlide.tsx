/**
 * BookPromoSlide — the deck's closing colophon (Task #4284, audit §8.7-10,
 * backlog #8/#30).
 *
 * Rebuilt from the off-brand split navy/teal promo onto the report's own
 * palette: eggshell field (shared Slide wrapper, beige variant), ink text,
 * crimson headline accent, gold reserved for the offer card and the book's
 * plate-mark/byline. The book is the hero; the "BESTSELLER" and byline tags
 * are squared (report-status-tag), the glow/gradient-text/pill language is
 * gone, and the slide number now renders via the shared top-right roundel
 * instead of the old stray bottom-left circle. Copy and CTA targets are
 * unchanged. The slide sits after Next 30 Days as the deck's last page.
 */

import { BookOpen, ShoppingCart, Headphones } from "lucide-react";
import { Slide } from "./Slide";
import type { PublicReportViewModel } from "./derive";

export function BookPromoSlide({ view }: { view: PublicReportViewModel }) {
  const { slideNumbers } = view;
  return (
    <Slide slideNumber={slideNumbers.bookPromo} variant="beige" pattern="geometric" id="book-promo" vCenter isLastSlide>
      <div className="book-colophon flex flex-col md:flex-row items-center gap-10 md:gap-14">
        {/* Text column */}
        <div className="book-colophon-text w-full md:w-[55%] text-center md:text-left">
          <h2 className="report-display text-report-ink mb-6">
            Dive deep into the{" "}
            <span className="block italic text-report-crimson">
              Revenue Engineering<br />for Law Firms!
            </span>
          </h2>

          <p className="text-report-ink-muted text-sm md:text-base mb-8 leading-relaxed max-w-md mx-auto md:mx-0">
            The same strategies powering your Revenue Engine Report — now available in your preferred format.
          </p>

          {/* FREE Digital Copy - Primary CTA */}
          <div className="bg-white border-l-4 border-report-gold rounded p-6 shadow-sm mb-6 text-left">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded bg-report-gold/15 flex items-center justify-center flex-shrink-0">
                <BookOpen className="w-6 h-6 text-report-gold-ink" />
              </div>
              <div className="flex-1">
                <div className="text-report-gold-ink text-xs uppercase tracking-wider font-medium mb-1">Exclusive Client Benefit</div>
                <div className="text-report-ink text-xl font-bold">Free Digital Copy</div>
                <div className="text-report-ink-muted text-xs mt-1">Ask your account manager to get yours</div>
              </div>
            </div>
          </div>

          {/* Secondary options */}
          <div className="flex gap-4 justify-center md:justify-start flex-wrap">
            <a
              href="https://www.amazon.com/Revenue-Engineering-Law-Firms-Skyrocket/dp/B0DQH995RX"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white border border-report-ink/15 hover:border-report-crimson/40 hover:bg-report-crimson/5 text-report-ink rounded px-4 py-4 transition-colors"
              data-testid="link-amazon"
            >
              <ShoppingCart className="w-4 h-4 text-report-crimson" />
              <span className="text-sm font-medium">Buy Paperback</span>
            </a>

            <a
              href="https://www.amazon.com/Elite-Business-Development-System-Firms/dp/B0CT93K44P"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white border border-report-ink/15 hover:border-report-crimson/40 hover:bg-report-crimson/5 text-report-ink rounded px-4 py-4 transition-colors"
              data-testid="link-audible"
            >
              <Headphones className="w-4 h-4 text-report-crimson" />
              <span className="text-sm font-medium">Audiobook</span>
            </a>
          </div>
        </div>

        {/* Book column — the hero */}
        <div className="book-colophon-media w-full md:w-[45%] flex items-center justify-center relative">
          <div className="relative">
            {/* Plate mark — gold hairline offset behind the book (position
                offsets, not transforms, so print can't flatten it onto the
                cover) */}
            <div aria-hidden className="hidden md:block absolute top-4 -right-4 -bottom-4 left-4 border border-report-gold/50 rounded" />

            {/* Print caps this at 2.2in (~211px); data-print-alpha keeps the
                cut-out silhouette + drop-shadow (never JPEG-flatten). */}
            <img
              src="/book-cover.webp"
              alt="Revenue Engineering for Law Firms by Ronnie Deaver"
              className="relative w-[180px] sm:w-[220px] md:w-[320px] h-auto"
              data-print-downscale="211"
              data-print-alpha
              style={{
                // drop-shadow (not box-shadow) so the editorial shadow hugs the
                // cut-out book silhouette instead of the img's transparent rect
                filter: 'drop-shadow(0 24px 32px rgba(35, 35, 35, 0.35)) drop-shadow(0 8px 12px rgba(35, 35, 35, 0.25))',
              }}
            />

            <div className="book-tag report-status-tag bg-report-crimson text-white shadow-sm hidden md:inline-flex absolute -top-3 -right-3">
              BESTSELLER
            </div>

            <div className="book-tag report-status-tag bg-report-gold text-report-ink shadow-sm hidden md:inline-flex absolute -bottom-3 -left-3">
              By Ronnie Deaver
            </div>
          </div>
        </div>
      </div>
    </Slide>
  );
}
