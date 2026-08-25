/**
 * Task #4635 — real-browser harness page for
 * tests/pulse-share-chart-palette-browser.test.ts.
 *
 * Mounts the REAL PublicCeoPulse share page exactly as App.tsx routes it
 * (wouter Route path="/pulse/:token"), letting the page's own react-query
 * fetch hit the same origin (the test's Express server, which serves this
 * built harness AND registers the real report routes). Nothing is stubbed:
 * the page's fetch → CeoPulseVisual → CeoPulseChartRenderer pipeline is the
 * production one, and recharts gets a real measured layout so Bar/Line SVG
 * fills/strokes actually render (they render an empty box under jsdom).
 */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route } from "wouter";
import PublicCeoPulse from "@/pages/PublicCeoPulse";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}>
    <Route path="/pulse/:token" component={PublicCeoPulse} />
  </QueryClientProvider>,
);
