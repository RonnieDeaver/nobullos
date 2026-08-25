/* test-registration
{
  "name": "Legacy brief share links render the edition tag end-to-end — seed a pre-edition-era ceo_pulses row (no share_token) backfilled to edition='market_shift', mint its token via POST /api/ceo-pulses/:id/share, then mount the REAL PublicCeoPulse page at /pulse/:token (jsdom + wouter route, live fetch against the real HTTP server) and assert the rendered markup shows the edition tag; NULL-edition legacy rows render with NO tag (Task #4386)",
  "regression": true,
  "sweepOnlyReason": "DB-bound route+jsdom suite (isolated-schema Postgres + a real HTTP server + a mounted client page); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/PublicCeoPulse.tsx",
    "client/src/components/CeoPulseVisual.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4386 — Task #4304 backfills edition='market_shift' onto the 6
 * pre-existing production briefs, which were all created BEFORE editions
 * (and in some cases before share tokens) existed. Two suites already pin
 * halves of this contract in isolation:
 *   - tests/ceo-pulse-patch-validation.test.ts (10): the share payload
 *     serves `edition` (null for untagged rows) — server side only.
 *   - tests/client/nobull-brief-edition-rendering.test.tsx: CeoPulseVisual
 *     renders the tag chip from an `edition` prop — component side only.
 *
 * Neither covers the BRIDGE a live historical share link actually exercises:
 * token lookup → share payload → the real /pulse/:token page → rendered
 * markup. A regression in any link of that chain (token lookup dropping the
 * column, the payload renaming the field, PublicCeoPulse mis-mapping the
 * prop) would silently strip the tag from every historical URL without
 * failing either existing suite. This suite mounts the REAL PublicCeoPulse
 * page (jsdom + wouter Route so useParams resolves the token from the
 * location, react-query fetching over the wire from the real Express app —
 * the page's own fetch/prop-mapping code is the oracle, nothing duplicated):
 *
 *   (1) A legacy row (seeded with share_token NULL, then backfilled to
 *       edition='market_shift' exactly as the migration does) gets its token
 *       minted via POST /api/ceo-pulses/:id/share; navigating the page to
 *       /pulse/<token> renders the "Market Shift" tag chip.
 *   (2) A NULL-edition legacy row renders WITHOUT the tag chip — the
 *       untagged-is-valid regression guard — while the rest of the slide
 *       (title, headline) renders intact.
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
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-pulse-share-legacy-edition-ceo";
const TAG = "task-4386-legacy-edition";

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

      let seedCounter = 0;
      /**
       * Seed a legacy-era brief: created before editions/share tokens existed,
       * so share_token is NULL and edition starts NULL. Text-only (no charts)
       * like the real historical briefs — keeps the render path off object
       * storage.
       */
      async function seedLegacyPulse(): Promise<{ id: string; monthKey: string }> {
        seedCounter++;
        const monthKey = `20${String(10 + seedCounter)}-0${(seedCounter % 9) + 1}`;
        const analysis = {
          headline: `Legacy headline ${TAG}-${seedCounter}`,
          keyTakeaways: ["legacy takeaway"],
          strategicImplications: ["legacy implication"],
          charts: [],
        };
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses
            (month_key, title, raw_content, include_graphs, is_published, share_token, created_by, ai_analysis, edition)
          VALUES (
            ${monthKey},
            ${"Legacy Brief " + monthKey},
            ${"Original raw content for " + monthKey},
            true,
            true,
            NULL,
            ${CEO_ID},
            ${JSON.stringify(analysis)}::jsonb,
            NULL
          )
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return { id: String(rows[0].id), monthKey };
      }

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
        // ── (1) Backfilled legacy row: token mint → real page renders the tag ──
        {
          const { id } = await seedLegacyPulse();
          // Mirror the Task #4304 backfill: UPDATE edition on a row that never
          // had one (not an insert-time edition — that path is already tested).
          await isoDb.execute(sql`
            UPDATE ceo_pulses SET edition = 'market_shift' WHERE id = ${id}
          `);

          const mint = await realFetch(`${baseUrl}/api/ceo-pulses/${id}/share`, { method: "POST" });
          assert.equal(mint.status, 200, "share-token mint on a legacy row → 200");
          const { shareToken } = await mint.json();
          assert.ok(typeof shareToken === "string" && shareToken.length > 0, "token minted");

          const { html, cleanup } = await renderSharePage(shareToken);
          assert.ok(
            document.querySelector('[data-testid="tag-edition"]'),
            "edition tag chip renders on the live share page",
          );
          assert.ok(html.includes("Market Shift"), "edition label text 'Market Shift' appears in rendered output");
          assert.ok(html.includes("The NoBull Brief"), "slide title renders");
          assert.ok(html.includes(`Legacy headline ${TAG}-1`), "brief content renders");
          await cleanup();
          console.log("  ok  (1) backfilled legacy brief: live share link renders the 'Market Shift' tag");
        }

        // ── (2) NULL-edition legacy row renders WITHOUT the tag ────────────────
        {
          const { id } = await seedLegacyPulse();
          const mint = await realFetch(`${baseUrl}/api/ceo-pulses/${id}/share`, { method: "POST" });
          assert.equal(mint.status, 200, "share-token mint on an untagged legacy row → 200");
          const { shareToken } = await mint.json();

          const { html, cleanup } = await renderSharePage(shareToken);
          assert.ok(
            !document.querySelector('[data-testid="tag-edition"]'),
            "NO edition tag chip for a NULL-edition legacy brief",
          );
          assert.ok(
            !html.includes("Market Shift") && !html.includes("Company Update"),
            "no edition label text leaks in",
          );
          assert.ok(html.includes("The NoBull Brief"), "slide still renders its title");
          assert.ok(html.includes(`Legacy headline ${TAG}-2`), "slide content renders intact");
          await cleanup();
          console.log("  ok  (2) untagged legacy brief: share link renders cleanly with no tag");
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

  console.log("Legacy-brief edition share-link rendering: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
