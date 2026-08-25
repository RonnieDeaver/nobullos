/* test-registration
{
  "name": "Blocked rate-limit events per-user CSV export (Task #1230)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1230 — Regression coverage for the per-user blocked-event CSV export.
 *
 * Mirrors `tests/blocked-rate-limit-events-csv-export.test.ts` (Task #777)
 * for the sibling endpoint
 * `GET /api/health/rate-limits/by-user/:userId/events.csv` whose handler
 * (`blockedRateLimitEventsByUserCsvHandler`) was extracted from
 * `server/routes.ts` so this test can mount the real production handler
 * on a minimal Express app without standing up the full auth chain.
 *
 * Pinned behavior:
 *   1. Content-Type is `text/csv; charset=utf-8`.
 *   2. Content-Disposition is an attachment whose filename embeds the
 *      sanitized `:userId` path param (non `[a-zA-Z0-9_-]` chars become
 *      underscores) — the userId in the URL scopes the rows.
 *   3. The header row is exactly
 *      `timestamp_iso,timestamp_ms,category,method,path,ip,user_id`.
 *   4. Cell values containing commas, quotes, or newlines are wrapped in
 *      double quotes with embedded quotes doubled.
 *   5. `rangeStart` / `rangeEnd` are forwarded to the storage iterator
 *      and only matching rows are emitted.
 *   6. Bad range input (only one of start / end provided, or non-numeric)
 *      returns HTTP 400 from the handler's input-validation guard.
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  ensureBlockedRateLimitEventsTable,
  insertBlockedRateLimitEvent,
} from "../server/storage/blockedRateLimitEventsStorage";
import { blockedRateLimitEventsByUserCsvHandler } from "../server/routes/blockedRateLimitEventsByUserCsv";
import type { InsertBlockedRateLimitEvent } from "@shared/schema";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `brlce-byuser-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Non-sanitizable characters so we can also assert the filename sanitizer
// rewrites them to underscores.
const NASTY_USER = `${TAG}/u:1`;
const SANITIZED_USER = NASTY_USER.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
const OTHER_USER = `${TAG}-other`;
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

  // Three rows for NASTY_USER (one with a nasty path that exercises every
  // escape rule), and one row for OTHER_USER which must NOT appear in the
  // CSV when we hit the route scoped to NASTY_USER.
  const seeds: InsertBlockedRateLimitEvent[] = [
    {
      timestamp: T0 + 1_000,
      category: TAG,
      method: "GET",
      path: "/plain/path",
      ip: "10.0.0.1",
      userId: NASTY_USER,
    },
    {
      timestamp: T0 + 2_000,
      category: TAG,
      method: "POST",
      path: NASTY_PATH,
      ip: "10.0.0.2",
      userId: NASTY_USER,
    },
    {
      timestamp: T0 + 3_000,
      category: TAG,
      method: "GET",
      path: "/another",
      ip: "10.0.0.1",
      userId: NASTY_USER,
    },
    {
      timestamp: T0 + 4_000,
      category: `${TAG}-other`,
      method: "GET",
      path: "/wrong-user",
      ip: "10.0.0.3",
      userId: OTHER_USER,
    },
  ];
  for (const seed of seeds) {
    await insertBlockedRateLimitEvent(seed);
  }

  const app = express();
  app.get(
    "/api/health/rate-limits/by-user/:userId/events.csv",
    blockedRateLimitEventsByUserCsvHandler,
  );
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

async function fetchCsv(userId: string, query = ""): Promise<CsvResponse> {
  const qs = query ? `?${query}` : "";
  const url =
    `${baseUrl}/api/health/rate-limits/by-user/${encodeURIComponent(userId)}/events.csv${qs}`;
  const res = await fetch(url);
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
 * quoted fields.
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
    // (1)+(2)+(3)+(4) Headers, filename sanitization, path-param scoping,
    // header row, escape rules, ascending timestamp order, null-vs-set
    // user_id rendering.
    {
      const r = await fetchCsv(NASTY_USER);
      assert(r.status === 200, `unfiltered: status 200, got ${r.status}`);
      assert(
        r.contentType === "text/csv; charset=utf-8",
        `unfiltered: Content-Type, got ${r.contentType}`,
      );
      assert(
        !!r.contentDisposition && r.contentDisposition.startsWith("attachment;"),
        `unfiltered: Content-Disposition is attachment, got ${r.contentDisposition}`,
      );
      const expectedFilename = `rate-limit-events-${SANITIZED_USER}.csv`;
      assert(
        !!r.contentDisposition && r.contentDisposition.includes(expectedFilename),
        `unfiltered: filename embeds sanitized userId, got ${r.contentDisposition}`,
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
        `unfiltered: 3 data rows for our user (other-user row excluded), got ${dataRows.length}`,
      );
      assert(
        dataRows.every((row) => row[6] === NASTY_USER),
        `unfiltered: every row scoped to path-param userId, got ${JSON.stringify(
          dataRows.map((row) => row[6]),
        )}`,
      );
      assert(
        dataRows[0][1] === String(T0 + 1_000) &&
          dataRows[1][1] === String(T0 + 2_000) &&
          dataRows[2][1] === String(T0 + 3_000),
        `unfiltered: ascending timestamp order, got ${JSON.stringify(
          dataRows.map((row) => row[1]),
        )}`,
      );
      // Escape rules: the nasty path round-trips through CSV un-escape.
      assert(
        dataRows[1][4] === NASTY_PATH,
        `unfiltered: nasty path round-trips through escape, got ${JSON.stringify(dataRows[1][4])}`,
      );
      // ISO timestamp matches the epoch ms in column 1.
      assert(
        dataRows[0][0] === new Date(T0 + 1_000).toISOString(),
        `unfiltered: timestamp_iso matches timestamp_ms, got ${dataRows[0][0]}`,
      );
    }

    // (5) range filter — only the middle row (T0+2_000) falls inside
    // [T0+1500, T0+2500].
    {
      const r = await fetchCsv(
        NASTY_USER,
        `rangeStart=${T0 + 1_500}&rangeEnd=${T0 + 2_500}`,
      );
      assert(r.status === 200, `range: status 200, got ${r.status}`);
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 1 && rows[0][1] === String(T0 + 2_000),
        `range: only the in-window row, got ${JSON.stringify(rows.map((row) => row[1]))}`,
      );
    }

    // (5) range filter — wide window covers all three of our user's rows
    // and nothing belonging to OTHER_USER.
    {
      const r = await fetchCsv(
        NASTY_USER,
        `rangeStart=${T0}&rangeEnd=${T0 + 10_000}`,
      );
      const rows = parseCsvRows(r.text).slice(1).filter((row) => row.length > 1);
      assert(
        rows.length === 3 && rows.every((row) => row[6] === NASTY_USER),
        `range-wide: 3 rows for path-param user, got ${JSON.stringify(
          rows.map((row) => [row[1], row[6]]),
        )}`,
      );
    }

    // (6) Range validation — only start, no end → 400.
    {
      const r = await fetchCsv(NASTY_USER, `rangeStart=${T0}`);
      assert(
        r.status === 400,
        `range validation (missing end): status 400, got ${r.status}`,
      );
    }

    // (6) Range validation — only end, no start → 400.
    {
      const r = await fetchCsv(NASTY_USER, `rangeEnd=${T0 + 10_000}`);
      assert(
        r.status === 400,
        `range validation (missing start): status 400, got ${r.status}`,
      );
    }

    // (6) Range validation — non-numeric input → 400.
    {
      const r = await fetchCsv(NASTY_USER, `rangeStart=abc&rangeEnd=def`);
      assert(
        r.status === 400,
        `range validation (non-numeric): status 400, got ${r.status}`,
      );
    }

    // (6) Range validation — end <= start → 400.
    {
      const r = await fetchCsv(
        NASTY_USER,
        `rangeStart=${T0 + 5_000}&rangeEnd=${T0 + 1_000}`,
      );
      assert(
        r.status === 400,
        `range validation (end <= start): status 400, got ${r.status}`,
      );
    }

    console.log("blocked-rate-limit-events-by-user-csv-export: PASSED");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("blocked-rate-limit-events-by-user-csv-export: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
