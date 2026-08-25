/* test-registration
{
  "name": "Brief share page never falls back to stock chart colors — seed a published brief WITH charts (AI-emitted stock hexes included), mint its share token, mount the REAL PublicCeoPulse page at /pulse/:token (jsdom + wouter + live fetch against the real HTTP server) and assert a rendered chart fill uses the report crimson #8A292F while NO stock-only DEFAULT_COLORS (e.g. #7C3AED) leak in; the admin preview call site (paletteless CeoPulseVisual) keeps stock colors (Task #4615)",
  "regression": true,
  "sweepOnlyReason": "DB-bound route+jsdom suite (isolated-schema Postgres + a real HTTP server + a mounted client page); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/admin/CeoPulseAdmin.tsx",
    "client/src/pages/PublicCeoPulse.tsx",
    "client/src/components/CeoPulseVisual.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4615 — Task #4576 made the public /pulse share page pass
 * REPORT_CEO_PULSE_CHART_PALETTE through CeoPulseVisual's chartPalette prop
 * into CeoPulseChartRenderer, while the internal admin preview
 * (client/src/pages/admin/CeoPulseAdmin.tsx) deliberately passes no palette
 * and keeps the stock OS chart colors. Existing suites pin halves of this:
 *   - tests/client/ceo-pulse-slide-polish.test.tsx: the RENDERER honors a
 *     palette prop (component side only — nothing mounts the share page).
 *   - tests/pulse-share-legacy-edition-rendering.test.tsx: the share page
 *     mounts end-to-end, but with chartless briefs (no color coverage).
 *
 * Neither pins the BRIDGE: PublicCeoPulse actually forwarding the report
 * palette into the rendered chart DOM. A refactor that drops the
 * chartPalette prop would silently revert every client-facing share link to
 * stock SaaS chart colors without failing either suite. This suite mounts
 * the REAL PublicCeoPulse page (jsdom + wouter Route so useParams resolves
 * the token, react-query fetching over the wire from the real Express app —
 * the page's own fetch/prop code is the oracle) with a brief WHOSE ANALYSIS
 * CONTAINS CHARTS, using the DOM-rendering chart types (metric_cards,
 * funnel) whose fills appear in markup without a measured box (recharts
 * ResponsiveContainer charts render empty under jsdom):
 *
 *   (1) The rendered share-page chart markup contains the report crimson
 *       #8A292F, and NONE of the stock-only chart hexes (renderer
 *       DEFAULT_COLORS like #7C3AED, FunnelChart's stock stage schemes) —
 *       even though the seeded charts carry AI-emitted stock hexes, which
 *       report mode must remap onto the report series.
 *   (2) The admin preview call site — CeoPulseVisual mounted with the exact
 *       prop shape CeoPulseAdmin.tsx passes (NO chartPalette) — keeps the
 *       stock colors (AI hex passes through verbatim, stock funnel scheme,
 *       no report crimson), and the CeoPulseAdmin.tsx source still passes no
 *       chartPalette prop.
 *
 * Runs against a per-test isolated schema via runInIsolatedSchema so writes
 * are invisible to live workers and the suite is hermetic.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
// wouter's use-browser-location calls bare addEventListener/removeEventListener.
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// framer-motion's useReducedMotion needs matchMedia; jsdom has none.
(dom.window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
(globalThis as any).ResizeObserver =
  (dom.window as any).ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route } from "wouter";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import PublicCeoPulse from "../client/src/pages/PublicCeoPulse";
import CeoPulseVisual from "../client/src/components/CeoPulseVisual";
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-pulse-share-chart-palette-ceo";
const TAG = "task-4615-chart-palette";

/** Report crimson — REPORT_COLORS.crimson, the palette's primary/series[0]. */
const REPORT_CRIMSON = "#8A292F";

/**
 * Stock-only chart hexes that must NEVER reach the share page's markup:
 * the renderer's DEFAULT_COLORS plus FunnelChart's stock LIGHT/DARK stage
 * schemes. Deliberately EXCLUDED:
 *   - #8B2E31: doubles as CeoPulseVisual's slide-chrome accent (bullet
 *     icons, borders) which legitimately renders on both surfaces;
 *   - #C4A35A: doubles as CeoPulseVisual's masthead/edition-tag gold chrome
 *     (deck gold predating brand v2), also on both surfaces;
 *   - #9CA3AF: doubles as the sanctioned report `slate` token (the
 *     palette's previous-period neutral).
 */
const STOCK_ONLY_HEXES = [
  // CeoPulseChartRenderer DEFAULT_COLORS (minus the three shared hexes above)
  "#2D6A4F", "#1E3A5F", "#D97706", "#7C3AED", "#0891B2",
  // FunnelChart stock LIGHT_COLORS
  "#D4A5A7", "#C48B8E", "#B47275", "#A4585C", "#944043",
  // FunnelChart stock DARK_COLORS (minus #8B2E31)
  "#7A2729", "#6B2023", "#5C191C", "#4D1316",
];

/**
 * Charts whose fills render in plain DOM (no recharts ResponsiveContainer —
 * those need a measured box and render empty under jsdom). AI-emitted STOCK
 * hexes are planted on purpose: report mode must remap them onto the report
 * series (first-seen #7C3AED → series[0] crimson), while the admin surface
 * keeps them verbatim.
 */
const CHARTS = [
  {
    type: "metric_cards",
    title: "KPIs",
    data: [
      { label: "Leads", value: 42, previousValue: 30, color: "#7C3AED" },
      { label: "Calls", value: 18, previousValue: 25, color: "#1E3A5F" },
    ],
    legend: [
      { label: "Leads", color: "#7C3AED" },
      { label: "Calls", color: "#1E3A5F" },
    ],
  },
  {
    // Funnel: one AI-supplied stock stage color plus scheme-default stages —
    // report mode replaces BOTH with the crimson funnelStages ramp.
    type: "funnel",
    title: "Lead funnel",
    groups: [
      {
        label: "This month",
        colorScheme: "dark",
        stages: [
          { label: "Visits", value: 900, color: "#7C3AED" },
          { label: "Leads", value: 300 },
          { label: "Booked", value: 90 },
        ],
      },
    ],
    annotations: [{ afterStage: 0, text: "33% convert" }],
  },
];

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = CEO_ID;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/**
 * Mount the REAL public share page at /pulse/<token> exactly as App.tsx
 * routes it (Route path="/pulse/:token" → PublicCeoPulse), let its own
 * react-query fetch hit the live server, and return the settled markup.
 * The page's fetch/prop-mapping code is the oracle — nothing re-implemented.
 */
async function renderSharePage(token: string): Promise<{ html: string; cleanup: () => Promise<void> }> {
  dom.window.history.pushState({}, "", `/pulse/${token}`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <Route path="/pulse/:token" component={PublicCeoPulse} />
      </QueryClientProvider>,
    );
  });
  // Wait for the page's own query to settle (skeleton → content/error).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!document.querySelector('[data-testid="skeleton-public-pulse"]')) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  assert.ok(
    !document.querySelector('[data-testid="skeleton-public-pulse"]'),
    "share page query settled (skeleton gone)",
  );
  return {
    html: container.innerHTML,
    cleanup: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

/**
 * Count occurrences of a color (case-insensitive) in markup, in BOTH forms
 * it can serialize as: raw hex (SVG presentation attributes keep it) and
 * the rgb() form jsdom's CSSOM normalizes inline styles to.
 */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
}
function countHex(html: string, hex: string): number {
  const lower = html.toLowerCase();
  return (
    lower.split(hex.toLowerCase()).length -
    1 +
    lower.split(hexToRgb(hex).toLowerCase()).length -
    1
  );
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${CEO_ID}, 'ceo', 'ceo', ${TAG + "-ceo"})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      // Seeded in the isolated (uncommitted) schema, invisible to requireAuth's
      // ambient public-schema lookup. Pre-register so the real middleware admits
      // the CEO without JIT-provisioning a public row (surprise default role).
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
        authorityLevel: "ceo",
        firstName: TAG + "-ceo",
      });

      const analysis = {
        headline: `Chart palette headline ${TAG}`,
        keyTakeaways: ["palette takeaway"],
        strategicImplications: ["palette implication"],
        charts: CHARTS,
      };

      const res: any = await isoDb.execute(sql`
        INSERT INTO ceo_pulses
          (month_key, title, raw_content, include_graphs, is_published, share_token, created_by, ai_analysis, edition)
        VALUES (
          ${"2019-04"},
          ${"Charted Brief " + TAG},
          ${"Raw content for " + TAG},
          true,
          true,
          NULL,
          ${CEO_ID},
          ${JSON.stringify(analysis)}::jsonb,
          'company_update'
        )
        RETURNING id
      `);
      const rows = Array.isArray(res) ? res : res?.rows ?? [];
      const pulseId = String(rows[0].id);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      // PublicCeoPulse fetches relative URLs ("/api/ceo-pulse/share/<token>")
      // — route them to the real server so the page's own network code runs
      // unmodified. Absolute URLs (DB pool internals etc.) pass through.
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = (input: any, init?: any) => {
        if (typeof input === "string" && input.startsWith("/")) {
          return realFetch(`${baseUrl}${input}`, init);
        }
        return realFetch(input, init);
      };

      try {
        // ── (1) Live share page: charts ride the report palette, zero stock leakage ──
        const mint = await realFetch(`${baseUrl}/api/ceo-pulses/${pulseId}/share`, { method: "POST" });
        assert.equal(mint.status, 200, "share-token mint → 200");
        const { shareToken } = await mint.json();
        assert.ok(typeof shareToken === "string" && shareToken.length > 0, "token minted");

        const { html, cleanup } = await renderSharePage(shareToken);
        assert.ok(html.includes(`Chart palette headline ${TAG}`), "brief content renders");
        assert.ok(
          document.querySelector('[data-testid="chart-metric_cards-0"]'),
          "metric-cards chart mounts on the share page",
        );
        assert.ok(
          document.querySelector('[data-testid="chart-funnel-1"]'),
          "funnel chart mounts on the share page",
        );

        assert.ok(
          countHex(html, REPORT_CRIMSON) > 0,
          `share page chart markup must carry the report crimson ${REPORT_CRIMSON} ` +
            "(the palette's primary/series[0]) — if this is missing, PublicCeoPulse " +
            "stopped forwarding REPORT_CEO_PULSE_CHART_PALETTE via chartPalette",
        );
        for (const hex of STOCK_ONLY_HEXES) {
          assert.equal(
            countHex(html, hex),
            0,
            `stock-only chart hex ${hex} leaked into the client-facing share page markup`,
          );
        }
        // Report ink class in play too — the renderer is genuinely in report
        // mode. (text-[#333333] is NOT asserted absent here: CeoPulseVisual's
        // own slide chrome uses it outside the charts on both surfaces.)
        assert.ok(html.includes("text-report-ink"), "report ink class active in share-page chart DOM");
        await cleanup();
        console.log("  ok  (1) live share link renders charts in the report palette; no stock hexes leak");

        // ── (2) Admin preview call site stays stock ────────────────────────────
        {
          // CeoPulseAdmin.tsx's live preview mounts CeoPulseVisual WITHOUT a
          // chartPalette prop — pin the source so a palette can't quietly be
          // added (or defaulted) on the internal surface.
          const adminSrc = readFileSync("client/src/pages/admin/CeoPulseAdmin.tsx", "utf8");
          assert.ok(adminSrc.includes("<CeoPulseVisual"), "admin preview still mounts CeoPulseVisual");
          assert.ok(
            !adminSrc.includes("chartPalette"),
            "CeoPulseAdmin.tsx must NOT pass chartPalette — the internal preview keeps stock colors",
          );

          // Mount the shared slide with the exact paletteless shape the admin
          // preview passes and assert the stock rendering survives.
          const container = document.getElementById("root")!;
          container.innerHTML = "";
          let root: Root;
          await act(async () => {
            root = createRoot(container);
            root.render(
              <CeoPulseVisual
                analysis={analysis as any}
                monthLabel="April 2019"
                animate={false}
                includeGraphs={true}
                edition={"company_update"}
                supportingImages={[]}
              />,
            );
          });
          const adminHtml = container.innerHTML;
          assert.ok(
            countHex(adminHtml, "#7C3AED") > 0,
            "admin preview keeps the AI-emitted stock hex verbatim",
          );
          assert.ok(
            countHex(adminHtml, "#7A2729") > 0,
            "admin preview funnel keeps its stock dark stage scheme",
          );
          assert.equal(
            countHex(adminHtml, REPORT_CRIMSON),
            0,
            "report crimson must NOT leak into the paletteless admin preview",
          );
          assert.ok(adminHtml.includes("text-[#333333]"), "admin preview keeps the stock chart ink class");
          assert.ok(!adminHtml.includes("text-report-ink"), "report classes absent from admin preview");
          await act(async () => root.unmount());
          console.log("  ok  (2) admin preview call site (paletteless) keeps stock chart colors");
        }
      } finally {
        (globalThis as any).fetch = realFetch;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    { tables: ["users", "ceo_pulses"] },
  ).finally(() => {
    __test_resetReconciledUsers();
  });

  console.log("Brief share-page report chart palette: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
