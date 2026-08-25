/* test-registration
{
  "name": "Brief share page's recharts Bar/Line charts keep brand colors in a REAL browser — seed a published brief with a bar + line chart (AI-emitted stock hexes planted), mint its share token, load /pulse/:token in system Chromium against a Vite-built harness mounting the real PublicCeoPulse over the real report routes, and assert the rendered chart SVG fills/strokes carry the report crimson #8A292F while NO stock-only DEFAULT_COLORS/funnel-scheme hexes appear anywhere in the chart SVG (Task #4635)",
  "regression": true,
  "sweepOnlyReason": "Real-Chromium test with a full Vite build of the client share page (~1-2 min wall) plus an isolated-schema Postgres seed — too slow for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep.",
  "timeoutMs": 300000,
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #4635 — tests/pulse-share-report-chart-palette.test.tsx (Task #4615)
 * pins the /pulse share page's report palette end-to-end but only via the
 * DOM-rendering chart types (metric_cards, funnel), because recharts
 * ResponsiveContainer charts render an empty box under jsdom (no measured
 * width). The recharts fills themselves (Bar Cell fill / Line stroke riding
 * ctx.primary + ctx.resolve) are pinned only at the SSR component level
 * (tests/client/ceo-pulse-slide-polish.test.tsx), never on the live share
 * page — a recharts-specific regression (e.g. a chart type reading
 * DEFAULT_COLORS directly) would slip through both.
 *
 * This suite closes that gap in a REAL browser:
 *   1. Builds a Vite harness (tests/browser/pulse-share-chart-palette/)
 *      that mounts the REAL PublicCeoPulse at wouter Route /pulse/:token.
 *   2. Seeds a published brief WHOSE ANALYSIS CONTAINS a bar chart and a
 *      line chart (one bar carries an AI-emitted stock hex #7C3AED that
 *      report mode must remap onto the report series) in an isolated
 *      Postgres schema, and serves the harness + the real report routes
 *      from ONE Express server so the page's own fetch runs unmodified.
 *   3. Loads the minted share link in system Chromium (puppeteer-core),
 *      waits for both recharts SVGs to render actual bar rects / line
 *      paths, and asserts:
 *        - the report crimson #8A292F appears among the chart SVG
 *          fills/strokes (Bar Cell remap + Line ctx.primary), and
 *        - ZERO stock-only chart hexes (renderer DEFAULT_COLORS minus the
 *          sanctioned shared chrome hexes, plus FunnelChart's stock stage
 *          schemes) appear anywhere in either chart's SVG markup.
 *
 * Run: npm test -- --file=tests/pulse-share-chart-palette-browser.test.ts
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-pulse-share-chart-palette-browser-ceo";
const TAG = "task-4635-recharts-palette";
const HARNESS_DIR = resolve(process.cwd(), "tests/browser/pulse-share-chart-palette");
const OUT_DIR = "/tmp/pulse-share-chart-palette-dist";

/** Report crimson — REPORT_COLORS.crimson, the palette's primary/series[0]. */
const REPORT_CRIMSON = "#8A292F";

/**
 * Stock-only chart hexes that must NEVER reach the share page's chart SVG —
 * same denylist as tests/pulse-share-report-chart-palette.test.tsx: the
 * renderer's DEFAULT_COLORS plus FunnelChart's stock LIGHT/DARK stage
 * schemes, minus the three hexes that double as sanctioned chrome/report
 * tokens on both surfaces (#8B2E31 slide chrome, #C4A35A masthead gold,
 * #9CA3AF report slate).
 */
const STOCK_ONLY_HEXES = [
  "#2D6A4F", "#1E3A5F", "#D97706", "#7C3AED", "#0891B2",
  "#D4A5A7", "#C48B8E", "#B47275", "#A4585C", "#944043",
  "#7A2729", "#6B2023", "#5C191C", "#4D1316",
];

/**
 * The recharts chart types this suite exists for: a bar chart (Cell fills —
 * one bar carries an AI-emitted STOCK hex that report mode must remap onto
 * series[0] crimson, the other rides ctx.primary) and a line chart (stroke =
 * ctx.primary).
 */
const CHARTS = [
  {
    type: "bar",
    title: "Leads by channel",
    data: [
      { label: "Google Ads", value: 42, color: "#7C3AED" },
      { label: "Organic", value: 28 },
      { label: "Referral", value: 17 },
    ],
  },
  {
    type: "line",
    title: "Leads over time",
    data: [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 25 },
      { label: "Mar", value: 40 },
    ],
  },
];

function findChromium(): string {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const found = execSync("which chromium || which chromium-browser", { encoding: "utf8" })
    .split("\n")[0]
    .trim();
  assert.ok(found, "chromium executable found on PATH");
  return found;
}

async function buildHarness(): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  await build({
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    // No postcss config exists at the repo root (Tailwind v4 runs via the
    // vite plugin in the app build); keep the inline empty config so
    // postcss-load-config never goes searching up-tree. The assertions here
    // are on SVG presentation attributes, so the app CSS is not needed.
    css: { postcss: { plugins: [] } },
    resolve: {
      alias: {
        "@": resolve(process.cwd(), "client", "src"),
        "@shared": resolve(process.cwd(), "shared"),
      },
    },
    root: HARNESS_DIR,
    build: { outDir: OUT_DIR, emptyOutDir: true },
  });
  assert.ok(existsSync(join(OUT_DIR, "index.html")), "harness build produced index.html");
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id (needed for the share-token mint POST).
    (req as any).__test_clerkUserId = CEO_ID;
    next();
  });
  registerReportRoutes(app);
  // Serve the built harness: static assets at root, SPA fallback for the
  // share-link path so /pulse/<token> loads the harness page.
  app.use(express.static(OUT_DIR));
  app.get("/pulse/:token", (_req: Request, res: Response) => {
    res.sendFile(join(OUT_DIR, "index.html"));
  });
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main(): Promise<void> {
  await buildHarness();
  console.log("  ok  harness built");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${CEO_ID}, 'ceo', 'ceo', ${TAG + "-ceo"})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
        authorityLevel: "ceo",
        firstName: TAG + "-ceo",
      });

      const analysis = {
        headline: `Recharts palette headline ${TAG}`,
        keyTakeaways: ["recharts takeaway"],
        strategicImplications: ["recharts implication"],
        charts: CHARTS,
      };

      const res: any = await isoDb.execute(sql`
        INSERT INTO ceo_pulses
          (month_key, title, raw_content, include_graphs, is_published, share_token, created_by, ai_analysis, edition)
        VALUES (
          ${"2019-05"},
          ${"Recharted Brief " + TAG},
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
      let browser: import("puppeteer-core").Browser | undefined;

      try {
        const mint = await fetch(`${baseUrl}/api/ceo-pulses/${pulseId}/share`, { method: "POST" });
        assert.equal(mint.status, 200, "share-token mint → 200");
        const { shareToken } = await mint.json();
        assert.ok(typeof shareToken === "string" && shareToken.length > 0, "token minted");

        const puppeteer = (await import("puppeteer-core")).default;
        browser = await puppeteer.launch({
          executablePath: findChromium(),
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        // Headless Chromium defaults prefers-reduced-motion to "reduce";
        // emulate no-preference so the page renders its production motion path.
        await page.emulateMediaFeatures([
          { name: "prefers-reduced-motion", value: "no-preference" },
        ]);
        // tsx's keepNames transform wraps nested named arrows inside
        // evaluate() bodies in __name(...) calls that only exist in the Node
        // bundle — shim it in the browser context before any navigation.
        await page.evaluateOnNewDocument("window.__name = function(f){return f}");
        const pageErrors: string[] = [];
        page.on("pageerror", (err) => pageErrors.push(String(err)));

        await page.goto(`${baseUrl}/pulse/${shareToken}`, { waitUntil: "networkidle0", timeout: 60_000 });

        // Both recharts charts must produce REAL rendered geometry: bar
        // rects with fills and a line path with a stroke. This is the
        // control that jsdom can never provide (empty ResponsiveContainer).
        await page.waitForFunction(
          () => {
            const bar = document.querySelector('[data-testid="chart-bar-0"] svg');
            const line = document.querySelector('[data-testid="chart-line-1"] svg');
            if (!bar || !line) return false;
            const barFills = Array.from(bar.querySelectorAll(".recharts-bar-rectangle path, .recharts-bar-rectangle rect"));
            const linePaths = Array.from(line.querySelectorAll("path.recharts-curve, .recharts-line path"));
            return barFills.length >= 3 && linePaths.length >= 1;
          },
          { timeout: 30_000 },
        );

        const result = await page.evaluate(() => {
          const collect = (rootSel: string) => {
            const svg = document.querySelector(rootSel + " svg");
            if (!svg) return null;
            const colors: string[] = [];
            for (const el of Array.from(svg.querySelectorAll("*"))) {
              for (const attr of ["fill", "stroke"]) {
                const v = el.getAttribute(attr);
                if (v) colors.push(v.toLowerCase());
              }
            }
            return { colors, html: svg.outerHTML.toLowerCase() };
          };
          return {
            headline: document.body.textContent || "",
            bar: collect('[data-testid="chart-bar-0"]'),
            line: collect('[data-testid="chart-line-1"]'),
          };
        });

        assert.ok(
          result.headline.includes(`Recharts palette headline ${TAG}`),
          "brief content renders on the share page",
        );
        assert.ok(result.bar && result.line, "both chart SVGs present");

        const crimson = REPORT_CRIMSON.toLowerCase();
        const barCrimson = result.bar!.colors.filter((c) => c === crimson).length;
        assert.ok(
          barCrimson >= 2,
          `bar chart Cell fills carry the report crimson ${REPORT_CRIMSON} ` +
            `(planted stock hex remapped onto series[0] + paletteless bars on ctx.primary) — got ${barCrimson} of ` +
            JSON.stringify(result.bar!.colors),
        );
        assert.ok(
          result.line!.colors.includes(crimson),
          `line chart stroke carries the report crimson ${REPORT_CRIMSON} (ctx.primary) — got ` +
            JSON.stringify(result.line!.colors),
        );

        for (const hex of STOCK_ONLY_HEXES) {
          const h = hex.toLowerCase();
          const at = result.bar!.html.indexOf(h);
          if (at >= 0) console.error("LEAK CONTEXT:", result.bar!.html.slice(Math.max(0, at - 300), at + 100));
          assert.ok(
            !result.bar!.html.includes(h),
            `stock-only chart hex ${hex} leaked into the share page's bar chart SVG`,
          );
          assert.ok(
            !result.line!.html.includes(h),
            `stock-only chart hex ${hex} leaked into the share page's line chart SVG`,
          );
        }

        assert.equal(
          pageErrors.length,
          0,
          `zero uncaught page errors, got: ${pageErrors.join(" | ")}`,
        );

        console.log("  ok  share link renders Bar/Line recharts SVG in the report palette; no stock hexes leak");
      } finally {
        if (browser) await browser.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
    { tables: ["users", "ceo_pulses"] },
  ).finally(() => {
    __test_resetReconciledUsers();
  });

  console.log("Brief share-page recharts chart palette (real browser): all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
