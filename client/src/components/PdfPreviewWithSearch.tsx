import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, Loader2, Search, X } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const ESCAPE_HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_HTML[c]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Props = {
  fileUrl: string;
  title?: string;
};

export default function PdfPreviewWithSearch({ fileUrl, title }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [pageWidth, setPageWidth] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docLoaded, setDocLoaded] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const matchesRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    setNumPages(0);
    setDocLoaded(false);
    setLoadError(null);
    setQuery("");
    setDebouncedQuery("");
    setActiveIndex(0);
    setMatchCount(0);
    matchesRef.current = [];
  }, [fileUrl]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (w: number) => {
      if (w > 0) setPageWidth(Math.min(1100, Math.max(280, Math.floor(w - 8))));
    };
    update(el.clientWidth);
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) update(e.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);
  const documentOptions = useMemo(() => ({}), []);

  const customTextRenderer = useCallback(
    ({ str }: { str: string }) => {
      if (!debouncedQuery) return escapeHtml(str);
      const re = new RegExp(escapeRegExp(debouncedQuery), "gi");
      let out = "";
      let last = 0;
      for (const m of str.matchAll(re)) {
        const idx = m.index ?? 0;
        out += escapeHtml(str.slice(last, idx));
        out += `<mark class="pdf-search-match">${escapeHtml(m[0])}</mark>`;
        last = idx + m[0].length;
      }
      out += escapeHtml(str.slice(last));
      return out;
    },
    [debouncedQuery],
  );

  const recollectMatches = useCallback(() => {
    const root = scrollRef.current;
    if (!root) {
      matchesRef.current = [];
      setMatchCount(0);
      return;
    }
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(".pdf-search-match"),
    );
    matchesRef.current = els;
    setMatchCount(els.length);
    setActiveIndex((i) => {
      if (els.length === 0) return 0;
      return Math.min(i, els.length - 1);
    });
  }, []);

  useEffect(() => {
    setActiveIndex(0);
    const id = window.requestAnimationFrame(recollectMatches);
    return () => window.cancelAnimationFrame(id);
  }, [debouncedQuery, numPages, recollectMatches]);

  useEffect(() => {
    const els = matchesRef.current;
    if (els.length === 0) return;
    els.forEach((el, i) => {
      if (i === activeIndex) {
        el.classList.add("pdf-search-match-active");
      } else {
        el.classList.remove("pdf-search-match-active");
      }
    });
    const target = els[activeIndex];
    if (target) {
      target.scrollIntoView({ block: "center", behavior: motionSafeScrollBehavior() });
    }
  }, [activeIndex, matchCount]);

  const goPrev = useCallback(() => {
    setActiveIndex((i) => {
      if (matchCount === 0) return 0;
      return (i - 1 + matchCount) % matchCount;
    });
  }, [matchCount]);

  const goNext = useCallback(() => {
    setActiveIndex((i) => {
      if (matchCount === 0) return 0;
      return (i + 1) % matchCount;
    });
  }, [matchCount]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      } else if (e.key === "Escape") {
        setQuery("");
      }
    },
    [goPrev, goNext],
  );

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full">
      <style>{`
        .pdf-search-match { background: #fde68a; color: inherit; border-radius: 2px; }
        .pdf-search-match-active { background: #f59e0b; outline: 2px solid #b45309; }
        .react-pdf__Page { margin: 0 auto 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); background: white; }
        .react-pdf__Page__textContent { user-select: text; }
      `}</style>
      <div className="flex items-center gap-2 px-2 py-2 border-b border-border bg-card">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search within contract…"
            className="h-8 pl-7 pr-7 text-sm"
            data-testid="input-contract-pdf-search"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-muted-foreground"
              aria-label="Clear search"
              data-testid="button-contract-pdf-search-clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <span
          className="text-xs text-muted-foreground tabular-nums min-w-[3.5rem] text-center"
          data-testid="text-contract-pdf-search-count"
        >
          {debouncedQuery
            ? matchCount > 0
              ? `${activeIndex + 1} / ${matchCount}`
              : "0 / 0"
            : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={matchCount === 0}
          onClick={goPrev}
          data-testid="button-contract-pdf-search-prev"
          aria-label="Previous match"
        >
          <ChevronUp className="w-4 h-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={matchCount === 0}
          onClick={goNext}
          data-testid="button-contract-pdf-search-next"
          aria-label="Next match"
        >
          <ChevronDown className="w-4 h-4" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-muted"
        data-testid="container-contract-pdf-pages"
      >
        {loadError ? (
          <div
            className="h-full flex items-center justify-center px-4 text-center text-sm text-muted-foreground"
            data-testid="status-contract-pdf-render-error"
          >
            {loadError}
          </div>
        ) : (
          <Document
            file={file}
            options={documentOptions}
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n);
              setDocLoaded(true);
            }}
            onLoadError={(err) => {
              setLoadError(
                err?.message ||
                  "Could not render this contract preview. Use Download PDF to view it.",
              );
            }}
            loading={
              <div className="h-full flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            }
            error={
              <div className="h-full flex items-center justify-center px-4 py-10 text-center text-sm text-muted-foreground">
                Could not render this contract preview. Use Download PDF to
                view it.
              </div>
            }
          >
            {docLoaded && pageWidth > 0
              ? Array.from({ length: numPages }, (_, i) => (
                  <Page
                    key={`page_${i + 1}`}
                    pageNumber={i + 1}
                    width={pageWidth}
                    renderAnnotationLayer={false}
                    renderTextLayer
                    customTextRenderer={customTextRenderer}
                    onRenderTextLayerSuccess={recollectMatches}
                    data-testid={`page-contract-pdf-${i + 1}`}
                  />
                ))
              : null}
          </Document>
        )}
      </div>
      {title ? <span className="sr-only">{title}</span> : null}
    </div>
  );
}
