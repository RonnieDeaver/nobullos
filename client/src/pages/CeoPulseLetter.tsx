import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { useRef, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { ceoPulseEditionLabel } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { NOBULL_BRIEF_STRINGS } from "@/components/ceoPulseCopy";

function formatMonthKey(monthKey: string): string {
  if (!monthKey) return "";
  const [year, month] = monthKey.split("-");
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function CeoPulseLetter() {
  const params = useParams<{ token: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: [`/api/ceo-pulse/share/${params.token}`],
    queryFn: async () => {
      const res = await fetch(`/api/ceo-pulse/share/${params.token}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: !!params.token,
  });

  const resizeIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc?.body) {
        const height = doc.documentElement.scrollHeight || doc.body.scrollHeight;
        iframe.style.height = height + "px";
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!data?.fullLetterHtml || !iframeRef.current) return;
    const iframe = iframeRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;
    doc.open();
    doc.write(data.fullLetterHtml);
    doc.close();

    resizeIframe();
    const observer = new ResizeObserver(resizeIframe);
    if (doc.body) observer.observe(doc.body);
    // Intentional JS resize listener (audit P2-9): the iframe's height is
    // measured from its document's scrollHeight, which reflows when the
    // outer viewport width changes — a measurement CSS cannot express, and
    // the same-document ResizeObserver alone can miss outer-window resizes.
    window.addEventListener("resize", resizeIframe);
    const timer = setTimeout(resizeIframe, 500);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeIframe);
      clearTimeout(timer);
    };
  }, [data?.fullLetterHtml, resizeIframe]);

  if (isLoading) {
    return (
      // lint-brief-surface-report-tokens: suppress -- intentional: brief letter uses report-paper-bright as its pinned light paper background
      <div className="min-h-screen bg-report-paper-bright" data-testid="skeleton-pulse-letter">
        <div className="px-6 py-6 max-w-4xl mx-auto space-y-6">
          <Skeleton className="h-8 w-48 bg-brief-ink-strong/10" />
          <Skeleton className="h-6 w-72 bg-brief-ink-strong/10" />
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-4 w-full bg-brief-ink-strong/10" />
            ))}
            <Skeleton className="h-4 w-3/4 bg-brief-ink-strong/10" />
          </div>
          <div className="space-y-4 pt-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full bg-brief-ink-strong/10" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data?.fullLetterHtml) {
    return (
      // lint-brief-surface-report-tokens: suppress -- intentional: brief letter uses report-paper-bright as its pinned light paper background
      <div className="min-h-screen bg-report-paper-bright flex items-center justify-center">
        <div className="text-center">
          <p className="text-brief-ink-strong/70 text-lg" data-testid="text-letter-not-found">This letter is not available.</p>
          <p className="text-brief-ink-strong/55 text-sm mt-2">The full NoBull Brief letter hasn't been uploaded yet.</p>
        </div>
      </div>
    );
  }

  const monthLabel = formatMonthKey(data.monthKey);
  const editionLabel = ceoPulseEditionLabel(data.edition);

  return (
    /* Pinned-light brand surface: this letter shares the paper look of the public
       Brief. Anonymous dark-OS visitors still get `.dark` on <html>, so themed
       tokens here would flip to charcoal under the pinned paper inks — every
       color on this page is therefore a brief-* or report-* token, which are
       fixed hex values defined in @theme inline (not HSL vars that flip with .dark). */
    // lint-brief-surface-report-tokens: suppress -- intentional: brief letter uses report-paper-bright as its pinned light paper background
    <div className="min-h-screen bg-report-paper-bright">
      <div className="px-6 py-4 max-w-4xl mx-auto">
        <a
          href={`/pulse/${params.token}`}
          className="inline-flex items-center gap-1.5 text-sm text-brief-crimson hover:text-brief-crimson-hover transition-colors"
          data-testid="link-back-to-visual"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Summary
        </a>
      </div>

      <div className="px-6 pb-4 max-w-4xl mx-auto">
        <div className="border-b border-brief-border pb-4" data-testid="masthead-brief">
          <h1 className="text-2xl font-semibold text-brief-ink-strong tracking-tight">{NOBULL_BRIEF_STRINGS.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-brief-crimson text-[11px] uppercase tracking-[0.25em] font-medium">Prepared for our partners</p>
            {editionLabel && (
              <span
                className="inline-flex items-center rounded-full border border-brief-crimson/40 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-brief-crimson"
                data-testid="tag-edition"
              >
                {editionLabel}
              </span>
            )}
            {monthLabel && <span className="text-brief-muted text-xs">{monthLabel}</span>}
          </div>
        </div>
      </div>

      <iframe
        ref={iframeRef}
        title="NoBull Brief Letter"
        sandbox="allow-same-origin"
        style={{
          width: "100%",
          border: "none",
          overflow: "hidden",
          display: "block",
          minHeight: "400px",
        }}
        data-testid="content-full-letter"
      />

      <div className="max-w-4xl mx-auto px-6">
        <div className="mt-8 pt-8 border-t border-brief-border">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-brief-crimson flex items-center justify-center text-white font-bold text-lg">R</div>
            <div>
              <p className="font-semibold text-brief-ink-strong">Ronnie Deaver</p>
              <p className="text-sm text-brief-muted">CEO, NoBull OS</p>
            </div>
          </div>
        </div>

        <p className="text-center text-brief-muted text-xs mt-12 pb-8">NoBull OS — {NOBULL_BRIEF_STRINGS.title} — {monthLabel}</p>
      </div>
    </div>
  );
}
