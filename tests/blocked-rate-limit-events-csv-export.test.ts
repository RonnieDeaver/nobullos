/* test-registration
{
  "name": "Blocked rate-limit events CSV export (Task #777)",
  "tier": "medium"
}
test-registration */
/**
 * Task #777 — Regression coverage for the blocked-event CSV export.
 *
 * The HTTP route at GET /api/health/rate-limits/events.csv is gated by
 * `isAuthenticated + requireTeamLead`. Both middlewares are bypassed
 * here by mounting the route's actual handler
 * (`blockedRateLimitEventsCsvHandler` from
 * `server/routes/blockedRateLimitEventsCsv.ts`) directly on a minimal
 * Express app. The handler is the same function `registerRoutes`
 * mounts in production, so this test exercises the real CSV-streaming
 * code path end-to-end against the dev DB.
 *
 * Pinned behavior:
 *   1. Content-Type is `text/csv; charset=utf-8` and Content-Disposition
 *      is an attachment whose filename embeds the active filter tokens.
 *   2. The header row is exactly
 *      `timestamp_iso,timestamp_ms,category,method,path,ip,user_id`.
 *   3. Cell values containing commas, quotes, or newlines are wrapped in
 *      double quotes with embedded quotes doubled; null user_id renders
 *      as an empty cell.
 *   4. The `userId`, `ip`, `category`, and `rangeStart` / `rangeEnd`
 *      filters are forwarded into the storage iterator and only matching
 *      rows are emitted.
 *   5. With no row-narrowing filters (we still scope to our seed tag via
 *      category to stay isolated), every seeded row comes back in
 *      ascending timestamp order.
 *   6. Bad range input (only one of start / end provided) returns
 *      HTTP 400 from the handler's input-validation guard.
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  ensureBlockedRateLimitEventsTable,
  insertBlockedRateLimitEvent,
} from "../server/storage/blockedRateLimitEventsStorage";
import { blockedRateLimitEventsCsvHandler } from "../server/routes/blockedRateLimitEventsCsv";
import type { InsertBlockedRateLimitEvent } from "@shared/schema";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `brlce-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const NASTY_PATH = `/x,with"quote\nand_newline/${TAG}`;
const T0 = Date.now() - 60 * 60 * 1000;

let server: import("node:http").Server | null = null;
let baseUrl = "";

async function clearTestRows(): Promise<void> {
  await db.execute(
    sql`DELETE FROM blocked_rate_limit_events WHERE category LIKE ${TAG + "%"}`,
  );
}

async function setup(): Promise<void> {
  await ensureBlockedRateLimitEventsTable();
  await clearTestRows();

  // Seed a deterministic mix that exercises every filter dimension
  // plus the three escape cases (comma, double-quote, embedded LF) and
  // the null-user_id branch.
  const seeds: InsertBlockedRateLimitEvent[] = [
    {
      timestamp: T0 + 1_000,
      category: TAG,
      method: "GET",
      path: "/plain/path",
      ip: "10.0.0.1",
      userId: "user-alpha",
    },
    {
      timestamp: T0 + 2_000,
      category: TAG,
      method: "POST",
      path: NASTY_PATH,
      ip: "10.0.0.2",
      userId: null,
    },
    {
      timestamp: T0 + 3_000,
      category: TAG,
      method: "GET",
      path: "/another",
      ip: "10.0.0.1",
      userId: "user-alpha",
    },
    {
      timestamp: T0 + 4_000,
      category: `${TAG}-other`,
      method: "GET",
      path: "/other-cat",
      ip: "10.0.0.3",
      userId: "user-beta",
    },
  ];
  for (const seed of seeds) {
    await insertBlockedRateLimitEvent(seed);
  }

  // Mount the real production handler — no auth bypass needed because
  // we don't include isAuthenticated / requireTeamLead in this minimal
  // app; we are exercising the handler that registerRoutes mounts.
  const app = express();
  app.get("/api/health/rate-limits/events.csv", blockedRateLimitEventsCsvHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function cleanup(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await clearTestRows().catch(() => undefined);
}

interface CsvResponse {
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  text: string;
}

async function fetchCsv(query: string): Promise<CsvResponse> {
  const res = await fetch(`${baseUrl}/api/health/rate-limits/events.csv?${query}`);
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentDisposition: res.headers.get("content-disposition"),
    text: await res.text(),
  };
}

/**
 * Minimal CSV parser sufficient for the route's escape rules: commas,
 * double quotes (escaped by doubling), and embedded CR / LF inside
 * quoted fields. Rolling our own keeps the test free of additional
 * dependencies and lets us assert on the exact cell values the handler
 * produced after un-escaping.
 */
function parseCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  while (i < body.length) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function main(): Promise<void> {
  await setup();
  try {
    // (1)+(2)+(3)+(5) Unfiltered (scoped to our category) — headers,
    // header row, escape rules, ordering.
    {
      const r = await fetchCsv(`category=${encodeURIComponent(TAG)}`);
      assert(r.status === 200, `unfiltered: status 200, got ${r.status}`);
      assert(
        r.contentType === "text/csv; charset=utf-8",
        `unfiltered: Content-Type, got ${r.contentType}`,
      );
      assert(
        !!r.contentDisposition && r.contentDisposition.startsWith("attachment;"),
        `unfiltered: Content-Disposition is attachment, got ${r.contentDisposition}`,
      );
      // Filename includes the sanitized category token, truncated to the
      // handler's 32-char cap on each segment.
      const expectedCatToken = `cat-${TAG}`.slice(0, 36);
      assert(
        !!r.contentDisposition && r.contentDisposition.includes(expectedCatToken),
        `unfiltered: filename includes sanitized category, got ${r.contentDisposition}`,
      );

      const rows = parseCsvRows(r.text);
      assert(
        rows[0].join(",") ===
          "timestamp_iso,timestamp_ms,category,method,path,ip,user_id",
        `unfiltered: header row matches contract, got ${JSON.stringify(rows[0])}`,
      );
      const dataRows = rows.slice(1).filter((row) => row.length > 1);
      assert(
        dataRows.length === 3,
        `unfiltered: 3 data rows for our category, got ${dataRows.length}`,
      );
      assert(
        dataRows[0][1] === String(T0 + 1_000) &&
          dataRows[1][1] === String(T0 + 2_000) &&
          dataRows[2][1] === String(T0 + 3_000),
        `unfiltered: rows in ascending timestamp order, got ${JSON.stringify(
          dataRows.map((row) => row[1]),
        )}`,
      );
      // Escape rules: the nasty path row is row index 1 (T0+2_000).
      assert(
        dataRows[1][4] === NASTY_PATH,
        `unfiltered: nasty path round-trips through escape, got ${JSON.stringify(dataRows[1][4])}`,
      );
      // Null user_id renders as an empty trailing cell.
      assert(
        dataRows[1][6] === "",
        `unfiltered: null user_id is empty cell, got ${JSON.stringify(dataRows[1][6])}`,
      );
      // ISO timestamp matches the epoch ms in column 1.
      assert(
        dataRows[0][0] === new Date(T0 + 1_000).toISOString(),
        `unfiltered: timestamp_iso matches timestamp_ms, got ${dataRows[0][0]}`,
      );
    }

    // (4) userId filter — only rows for user-alpha within our category.
    {
      const r = await fetchCsv(
        `category=${encodeURIComponent(TAG)}&userId=user-alpha`,
      );
      assert(r.status === 200, `userId: status 200, got ${r.status}`);
      assert(
        !!r.contentDisposition && r.contentDisposition.includes("user-user-alpha"),
        `userId: filename includes user token, got ${r.contentDisposition}`,
      );
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 2 && rows.every((row) => row[6] === "user-alpha"),
        `userId: only user-alpha rows, got ${JSON.stringify(rows.map((row) => row[6]))}`,
      );
    }

    // (4) ip filter — only the two rows for 10.0.0.1.
    {
      const r = await fetchCsv(
        `category=${encodeURIComponent(TAG)}&ip=10.0.0.1`,
      );
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 2 && rows.every((row) => row[5] === "10.0.0.1"),
        `ip: only 10.0.0.1 rows, got ${JSON.stringify(rows.map((row) => row[5]))}`,
      );
      assert(
        !!r.contentDisposition && r.contentDisposition.includes("ip-10.0.0.1"),
        `ip: filename includes ip token, got ${r.contentDisposition}`,
      );
    }

    // (4) category filter — passing the "other" tag isolates that single row.
    {
      const r = await fetchCsv(
        `category=${encodeURIComponent(`${TAG}-other`)}`,
      );
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 1 &&
          rows[0][2] === `${TAG}-other` &&
          rows[0][6] === "user-beta",
        `category: isolates the other-tag row, got ${JSON.stringify(rows)}`,
      );
    }

    // (4) range filter — only the middle row falls inside [T0+1500, T0+2500].
    {
      const r = await fetchCsv(
        `category=${encodeURIComponent(TAG)}` +
          `&rangeStart=${T0 + 1_500}&rangeEnd=${T0 + 2_500}`,
      );
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 1 && rows[0][1] === String(T0 + 2_000),
        `range: only the in-window row, got ${JSON.stringify(rows.map((row) => row[1]))}`,
      );
      assert(
        !!r.contentDisposition &&
          /blocked-events_\d{8}T\d{4}Z-\d{8}T\d{4}Z/.test(r.contentDisposition),
        `range: filename includes timestamp window, got ${r.contentDisposition}`,
      );
    }

    // (6) Range validation — bad input (only start, no end) is a 400.
    {
      const r = await fetchCsv(`rangeStart=1000`);
      assert(r.status === 400, `range validation: status 400, got ${r.status}`);
    }

    console.log("blocked-rate-limit-events-csv-export: PASSED");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("blocked-rate-limit-events-csv-export: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
