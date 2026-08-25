import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "framer-motion";
import { SectionErrorBoundary } from "./publicReport/SectionErrorBoundary";
import { ReportStatePage, resolveReportStateKind } from "./publicReport/ReportStatePage";
import { SharedReportData } from "./publicReport/types";
import { derivePublicReportView } from "./publicReport/derive";
import { CoverSlide } from "./publicReport/CoverSlide";
import { AgendaSlide } from "./publicReport/AgendaSlide";
import { CeoPulseSlide } from "./publicReport/CeoPulseSlide";
import { EngineHealthSlide } from "./publicReport/EngineHealthSlide";
import { IntakeSlide } from "./publicReport/IntakeSlide";
import { SalesSlide } from "./publicReport/SalesSlide";
import { MarketingSlide } from "./publicReport/MarketingSlide";
import { RevenueLeakSlide } from "./publicReport/RevenueLeakSlide";
import { LifetimeValueSlide } from "./publicReport/LifetimeValueSlide";
import { BookPromoSlide } from "./publicReport/BookPromoSlide";
import { Next30DaysSlide } from "./publicReport/Next30DaysSlide";

// Task #4271: PublicReport.tsx is now the orchestration root; every slide and
// shared piece lives in ./publicReport/*. These re-exports keep the public
// import surface of this module unchanged for existing consumers/tests.
export { TrendsSection, formatTrendMonth, trendSpansMultipleYears, buildTrendMetricSeries, formatTrendValue, trendEndpointLabelText, trendGradientId, TREND_STROKE_WIDTH, TREND_FILL_TOP_OPACITY, TREND_FILL_BOTTOM_OPACITY } from "./publicReport/TrendsSection";
export type { TrendChartPoint, TrendMetricSeries } from "./publicReport/TrendsSection";
export type { SharedReportData, ReportTrendData, CeoPulseAnalysis } from "./publicReport/types";
import { ReportTopBar } from "./publicReport/ReportTopBar";
import { MarketContextSlide, hasMarketContextData } from "./publicReport/MarketContextSlide";
import { computeSlideNumbers } from "./publicReport/sections";
// Repair (Task #4522): the two import groups below were truncated to a bare
// `import {` by an automerge during Task #4288's landing, leaving main's
// typecheck red — reconstructed from that commit's print-image effect usage.
import {
  registerHeatmapPrintPreparer,
  registerHeatmapPrintSyncPreparer,
  subscribeHeatmapPrintMode,
  installHeatmapBrowserPrintHooks,
  runHeatmapPrintSequence,
} from "@/lib/heatmapPrintRegistry";
import {
  downscaleImagesForPrint,
  downscaleImagesForPrintSync,
  restorePrintImages,
} from "@/lib/printImagePrep";

export default function PublicReport(props: { isDemo?: boolean; isPrintMode?: boolean; isPreview?: boolean } & Record<string, any> = {}) {
  const isDemo = props.isDemo || false;
  const isPrintMode = props.isPrintMode || false;
  const isPreview = props.isPreview || false;
  const params = useParams<{ token: string; reportId: string }>();
  const isEditing = false; // Editing disabled for public reports
  const [printCountdown, setPrintCountdown] = useState<number | null>(null); // Starts null, countdown begins after data loads
  const [isPrinting, setIsPrinting] = useState(false);
  const [printModeActive, setPrintModeActive] = useState(isPrintMode);
  // OS-level reduced motion: render entrance states directly (no fades/slides)
  // and stop perpetual loops — same gate CeoPulseVisual uses.
  const prefersReducedMotion = useReducedMotion();

  const { data, isLoading, error } = useQuery<SharedReportData>({
    queryKey: isDemo ? ["/api/demo-report"] : isPreview ? ["/api/preview", params.reportId] : ["/api/share", params.token],
    queryFn: async () => {
      const url = isDemo ? "/api/demo-report" : isPreview ? `/api/preview/${params.reportId}` : `/api/share/${params.token}`;
      const res = await fetch(url, isPreview ? { credentials: 'include' } : undefined);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Status-aware fallback (Task #4283): a JSON-less 5xx/proxy error must
        // land on the "load failure" state, not masquerade as a missing report.
        throw new Error(
          body.error || (res.status === 404 ? "Report not found" : `Request failed (${res.status})`),
        );
      }
      return res.json();
    },
    // Task #4225 — the on-page card below ("Report Not Found" / "Report Not
    // Ready" / "Login Required") owns every error state; the global
    // "Request failed" toast on top of it was duplicate noise for clients.
    meta: { silent: true },
  });

  const hasCeoPulse = !!(data?.ceoPulse?.aiAnalysis);
  // Task #4277 — Market Context drops from the deck (and the agenda) when
  // the report has no market basis at all: no client practice areas AND no
  // embedded seasonal-trend payload. Numbering shifts up automatically.
  const hasMarketContext = hasMarketContextData(data?.client?.practiceAreas, data?.seasonalTrends);
  const slideNumbers = useMemo(
    () => computeSlideNumbers({ hasCeoPulse, hasMarketContext }),
    [hasCeoPulse, hasMarketContext],
  );

  // Task #3688 — the Data Access toggle no longer drives report rendering
  // (metrics are gated purely by data presence); the dataAccess payload
  // remains in the response as Command Panel tracking metadata only.

  // Set document title for print/PDF naming: "Firm Name - Month Year".
  // Task #4287 — restore whatever title the app had before this page took
  // over (captured once on first render): the old hardcoded "NoBull OS"
  // restore leaked internal product naming onto a client-facing tab when
  // navigating away from an in-SPA report view.
  const initialTitleRef = useRef(document.title);
  useEffect(() => {
    const setTitle = () => {
      if (data?.client?.firmName && data?.report?.reportMonth) {
        const [year, month] = data.report.reportMonth.split("-");
        const date = new Date(parseInt(year), parseInt(month) - 1);
        const monthLabel = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        document.title = `${data.client.firmName} - ${monthLabel}`;
      }
    };
    
    // Set title immediately when data is available
    setTitle();
    
    // Also ensure title is set just before printing
    window.addEventListener('beforeprint', setTitle);
    
    // Copy the ref value now: the cleanup must restore the title captured at
    // mount even though ref reads inside cleanups are flagged by
    // react-hooks/exhaustive-deps (the ref itself is set once and never
    // re-pointed, so this is behavior-preserving).
    const initialTitle = initialTitleRef.current;
    return () => {
      window.removeEventListener('beforeprint', setTitle);
      document.title = initialTitle;
    };
  }, [data?.client?.firmName, data?.report?.reportMonth]);

  // Print image downscaling (Task #4288): annotated report images (GBP
  // heatmap scans, book cover) swap to print-sized data URLs before any
  // print capture and restore afterwards. Registered through the same
  // registry the heatmap snapshots use, so all print paths (in-page button,
  // /print route sequence, Cmd+P, headless printToPDF) are covered.
  useEffect(() => {
    const unregisterAsync = registerHeatmapPrintPreparer(() => downscaleImagesForPrint());
    const unregisterSync = registerHeatmapPrintSyncPreparer(() => downscaleImagesForPrintSync());
    const unsubscribe = subscribeHeatmapPrintMode((on) => {
      if (!on) restorePrintImages();
    });
    // Covers browser-native print (Cmd+P / printToPDF) on report pages that
    // render no InteractiveHeatmap (its mounts also install these hooks).
    installHeatmapBrowserPrintHooks();
    return () => {
      unregisterAsync();
      unregisterSync();
      unsubscribe();
    };
  }, []);

  // Countdown timer for print preparation
  useEffect(() => {
    if (printCountdown === null || isPrinting) return;
    
    if (printCountdown <= 0) {
      setIsPrinting(true);
      setPrintCountdown(null);
      // Prepare any live heatmaps (resize, repaint, capture PNG) before printing
      // so MapLibre WebGL canvases don't print as blank.
      void (async () => {
        await runHeatmapPrintSequence({
          print: () => window.print(),
        });
        setIsPrinting(false);
        if (!isPrintMode) {
          setPrintModeActive(false);
        }
      })().catch((err) => console.error("[PublicReport] print sequence failed:", err));
      return;
    }
    
    const timer = setTimeout(() => {
      setPrintCountdown(printCountdown - 1);
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [printCountdown, isPrinting, isPrintMode]);
  
  // Start countdown when in print mode and data is loaded
  useEffect(() => {
    if (isPrintMode && data && !isLoading && printCountdown === null && !isPrinting) {
      setPrintModeActive(true);
      setPrintCountdown(6); // Consistent 6 second countdown
    }
  }, [isPrintMode, data, isLoading, printCountdown, isPrinting]);
  
  const handlePrintClick = () => {
    if (printCountdown === null && !isPrinting) {
      setPrintModeActive(true); // Enable print mode for charts
      setPrintCountdown(6); // 6 second countdown to allow charts to render
    }
  };
  
  const cancelPrint = () => {
    setPrintCountdown(null);
    setIsPrinting(false);
    setPrintModeActive(false);
  };


  if (isLoading) {
    return (
      <div className="report-surface min-h-screen slide-beige flex items-center justify-center">
        <div className="text-report-crimson font-report-serif text-xl">Loading report...</div>
      </div>
    );
  }

  if (error || !data) {
    // Task #4283 — branded public state pages (audit backlog #12). The
    // share query stays `meta.silent` (Task #4225): these pages own the
    // whole error surface, no toast on top.
    return <ReportStatePage kind={resolveReportStateKind(error?.message)} />;
  }

  // All per-render derived values live in derivePublicReportView (verbatim move,
  // Task #4271); slides receive the whole bag and destructure the original names.
  const view = derivePublicReportView({
    isDemo, isPrintMode, isPreview, isEditing, prefersReducedMotion,
    printModeActive, hasCeoPulse, hasMarketContext, slideNumbers, data,
  });
  const { report, client, monthLabel, ceoPulse } = view;
  return (
    <div className="report-surface min-h-screen print:bg-white">
      {/* Task #4286 (audit #19) — skip link: first focusable element, jumps
          keyboard/AT users past the sticky chrome into the deck (<main>
          below). Styled in index.css (.report-skip-link). */}
      <a href="#report-content" className="report-skip-link print:hidden" data-testid="link-skip-to-content">
        Skip to report content
      </a>
      {isPreview && report.status !== 'final' && (
        <div className="print:hidden bg-report-watch text-white text-center py-2 px-4 text-sm font-medium sticky top-0 z-[60]" data-testid="banner-draft-preview">
          Draft Preview — This report has not been finalized. Only logged-in team members can see this.
        </div>
      )}
      {/* Controls — transparent over the cover, solid past it; owns the
          ≤768px progress/jump strip (Task #4275) */}
      <ReportTopBar
        title={`${client.firmName} - ${monthLabel}`}
        printCountdown={printCountdown}
        isPrinting={isPrinting}
        onPrintClick={handlePrintClick}
      />

      {/* Print countdown overlay */}
      {printCountdown !== null && (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center print:hidden">
          <div className="bg-white rounded-xl p-8 text-center shadow-2xl max-w-sm mx-4">
            <div className="text-6xl font-bold text-report-crimson mb-4">{printCountdown}</div>
            {/* Not a heading: the transient overlay must not inject an h3
                between the top bar and the cover's h1 (Task #4286). */}
            <p className="text-xl font-semibold text-report-ink mb-2">Preparing PDF...</p>
            <p className="text-report-ink-muted mb-4">Loading all charts and images for print</p>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={cancelPrint}
              className="border-report-ink/15"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}


      {/* Task #4286 (audit #19) — the deck is the page's single <main>
          landmark and the skip-link target; tabIndex={-1} lets the jump take
          programmatic focus. All CSS hooks are class-based
          (.slideshow-container), so the element swap is style-inert. */}
      <main id="report-content" tabIndex={-1} className="slideshow-container print:p-0 print:space-y-0">

        {/* ===== SLIDE 0: COVER ===== */}
        <CoverSlide view={view} />

        {/* ===== SLIDE 1: AGENDA (Cream) ===== */}
        <SectionErrorBoundary sectionName="agenda" resetKey={report.id}>
        <AgendaSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 3: CEO PULSE (Charcoal) ===== */}
        <SectionErrorBoundary sectionName="ceo-pulse" resetKey={report.id}>
        {hasCeoPulse && ceoPulse?.aiAnalysis && (
          <CeoPulseSlide view={view} />
        )}
        </SectionErrorBoundary>

        {/* ===== SLIDE 4: MARKET CONTEXT (Beige) - Practice Area Based ===== */}
        <SectionErrorBoundary sectionName="market-context" resetKey={report.id}>
        {hasMarketContext && (
          <MarketContextSlide 
            slideNumber={slideNumbers.marketContext} 
            practiceAreas={client.practiceAreas || []}
            embeddedTrends={data.seasonalTrends ?? null}
            isPrintMode={printModeActive}
            isPublicView={!isPreview}
            verdict={data.slideVerdicts?.marketContext ?? null}
          />
        )}
        </SectionErrorBoundary>

        {/* ===== SLIDE 5: ENGINE HEALTH (Cream) ===== */}
        <SectionErrorBoundary sectionName="engine-health" resetKey={report.id}>
        <EngineHealthSlide view={view} />
        </SectionErrorBoundary>

        {/* Deep dives run Marketing → Intake → Sales (funnel order, Task
            #4522): marketing generates leads, intake converts them to
            consults, sales closes cases. */}

        {/* ===== SLIDE 6: MARKETING DEEP DIVE (Charcoal) ===== */}
        <SectionErrorBoundary sectionName="marketing" resetKey={report.id}>
        <MarketingSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 7: INTAKE DEEP DIVE (Beige) ===== */}
        <SectionErrorBoundary sectionName="intake" resetKey={report.id}>
        <IntakeSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 8: SALES DEEP DIVE (Cream) ===== */}
        <SectionErrorBoundary sectionName="sales" resetKey={report.id}>
        <SalesSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 9: REVENUE LEAK ANALYSIS (Burgundy) ===== */}
        <SectionErrorBoundary sectionName="loss-audit" resetKey={report.id}>
        <RevenueLeakSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 10: RELATIONSHIP LIFETIME VALUE (Charcoal) ===== */}
        <SectionErrorBoundary sectionName="lifetime-value" resetKey={report.id}>
        <LifetimeValueSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 11: NEXT 30 DAYS (Cream) ===== */}
        <SectionErrorBoundary sectionName="next-30-days" resetKey={report.id}>
        <Next30DaysSlide view={view} />
        </SectionErrorBoundary>

        {/* ===== SLIDE 12: BOOK PROMO — CLOSING COLOPHON (Eggshell) ===== */}
        <SectionErrorBoundary sectionName="book-promo" resetKey={report.id}>
        <BookPromoSlide view={view} />
        </SectionErrorBoundary>

      </main>
    </div>
  );
}
