/* test-registration
{
  "name": "GET /api/clients/export.csv — client list CSV export (Task #4990)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4990: new data-egress endpoint. Locks the auth gate (401/403 JSON on an /api path, never a redirect), EXACT list-parity role scoping (CEO sees demo rows, account_manager does not, non-managers get own clients only; archived rows always included; lead-stage rows never exported), the schema-lockstep header row (getTableColumns), ISO/JSON cell serialization, and CSV quote/comma escaping. Real isAuthenticated middleware + the same handler production mounts; DB writes are run-token-suffixed rows deleted in finally; runs in seconds.",
  "tier": "small"
}
test-registration */
/**
 * Task #4990 — route test for the client list CSV export.
 *
 * The production route is `app.get("/api/clients/export.csv",
 * isAuthenticated, clientListCsvHandler)` (server/routes/clients.ts). This
 * suite mounts that exact middleware + handler pair on a minimal Express app
 * (the users-paged pattern: the Clerk-era per-request test seam
 * `req.__test_clerkUserId` authenticates as a seeded users row, null stays
 * anonymous), so the auth gate and the CSV code path are both end-to-end.
 *
 * Pinned behavior:
 *   1. Unauthenticated → 401 JSON; unknown/unapproved subject → 403 JSON.
 *      /api paths get JSON errors, never a redirect.
 *   2. Content-Type `text/csv; charset=utf-8`, Content-Disposition is an
 *      attachment named `clients-export_<UTC stamp>.csv`.
 *   3. Header row is exactly CLIENT_CSV_COLUMNS — which itself must equal
 *      the drizzle clients-table column keys (schema lockstep: a new column
 *      appears in the export automatically, and this assert fails if the
 *      derivation ever drifts from the schema).
 *   4. Role scoping is list-parity: CEO sees every fixture including demo;
 *      account_manager sees all minus demo; a non-manager role sees only its
 *      own non-demo clients. Archived fixtures appear for every role that can
 *      see their rows (isArchived column identifies them); lifecycle-stage
 *      "lead" rows are never exported (the list's customer-gated accessors).
 *   5. Serialization: Date → ISO 8601, null clientStartDate → empty cell,
 *      text[] and jsonb columns → JSON strings, firm names containing commas
 *      and double quotes are CSV-escaped (quote doubling) and round-trip.
 *
 * Isolation (.agents/memory/route-test-public-schema-collision.md): all
 * seeded users/clients ids, emails, and firm names carry a per-run random
 * token and are deleted in finally. Row assertions are scoped to the fixture
 * ids — never to global row counts.
 */
import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { getTableColumns, inArray } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import { users, clients } from "@shared/schema";
import { isAuthenticated } from "../server/middlewares/requireAuth";
import {
  clientListCsvHandler,
  CLIENT_CSV_COLUMNS,
} from "../server/routes/clientsCsv";

const RUN = randomBytes(4).toString("hex");
const UID = (slug: string) => `csv4990-${slug}-${RUN}`;

const CEO_ID = UID("ceo");
const AM_ID = UID("am");
const SALES_ID = UID("sales");
const GHOST_ID = UID("ghost"); // never seeded → 403 (closed admission)
const USER_IDS = [CEO_ID, AM_ID, SALES_ID];

const C_OWN = UID("c-own");
const C_DEMO = UID("c-demo");
const C_ARCH = UID("c-arch");
const C_OTHER = UID("c-other");
const C_LEAD = UID("c-lead");
const CLIENT_IDS = [C_OWN, C_DEMO, C_ARCH, C_OTHER, C_LEAD];

const NASTY_FIRM = `Smith, "Jones" & Partners ${RUN}`;
const START_DATE = new Date("2023-05-15T12:30:00.000Z");
const PRACTICE_AREAS = ["Personal Injury", "Family Law"];
const TERMINOLOGY = { consults: "Strategy Sessions" };

async function seed(): Promise<void> {
  await db.insert(users).values([
    {
      id: CEO_ID,
      email: `${CEO_ID}@test.local`,
      firstName: "Csv",
      lastName: `Ceo-${RUN}`,
      role: "ceo",
    },
    {
      id: AM_ID,
      email: `${AM_ID}@test.local`,
      firstName: "Csv",
      lastName: `Am-${RUN}`,
      role: "account_manager",
    },
    {
      id: SALES_ID,
      email: `${SALES_ID}@test.local`,
      firstName: "Csv",
      lastName: `Sales-${RUN}`,
      role: "sales",
    },
  ]);

  await db.insert(clients).values([
    {
      // The sales user's own client — carries every serialization fixture:
      // comma+quote firm name, arrays, jsonb terminology, a start date.
      id: C_OWN,
      firmName: NASTY_FIRM,
      contactEmail: `own-${RUN}@smith-jones.test`,
      practiceAreas: PRACTICE_AREAS,
      products: ["gbp", "lsa"],
      emailDomains: ["smith-jones.test"],
      terminology: TERMINOLOGY,
      clientStartDate: START_DATE,
      averageCaseValue: 15000,
      ownerId: SALES_ID,
      lifecycleStage: "customer",
    },
    {
      // Demo client (owned by the sales user): CEO-only in the list, so
      // CEO-only in the export.
      id: C_DEMO,
      firmName: `Demo Firm ${RUN}`,
      isDemo: true,
      ownerId: SALES_ID,
      lifecycleStage: "customer",
    },
    {
      // Archived client owned by the AM: exports for AM and CEO (archived is
      // ALWAYS included), never for the sales user (not the owner). Null
      // clientStartDate → empty cell.
      id: C_ARCH,
      firmName: `Archived Firm ${RUN}`,
      isArchived: true,
      clientStartDate: null,
      ownerId: AM_ID,
      lifecycleStage: "customer",
    },
    {
      // Plain client owned by the CEO: visible to CEO + AM, not to sales.
      id: C_OTHER,
      firmName: `Other Firm ${RUN}`,
      ownerId: CEO_ID,
      lifecycleStage: "customer",
    },
    {
      // Lead-stage row: the list's customer-gated accessors exclude it for
      // every role, so the export must too.
      id: C_LEAD,
      firmName: `Lead Firm ${RUN}`,
      ownerId: CEO_ID,
      lifecycleStage: "lead",
    },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(clients).where(inArray(clients.id, CLIENT_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

/**
 * Mounts the production middleware + handler pair behind the per-request
 * Clerk test seam (string = authenticated as that userId, null = anonymous).
 */
async function withApp<T>(
  sub: string | null,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use((req: any, _res, next) => {
    req.__test_clerkUserId = sub;
    next();
  });
  app.get("/api/clients/export.csv", isAuthenticated, clientListCsvHandler);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface CsvResponse {
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  text: string;
}

async function fetchCsv(baseUrl: string): Promise<CsvResponse> {
  const res = await fetch(`${baseUrl}/api/clients/export.csv`);
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentDisposition: res.headers.get("content-disposition"),
    text: await res.text(),
  };
}

/**
 * Minimal CSV parser sufficient for the handler's escape rules (same as
 * tests/blocked-rate-limit-events-csv-export.test.ts): commas, double quotes
 * escaped by doubling, and embedded CR/LF inside quoted fields.
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

/** Parses a 200 CSV body into { header, byId } keyed on the id column. */
function parseExport(text: string): {
  header: string[];
  byId: Map<string, Map<string, string>>;
} {
  const rows = parseCsvRows(text);
  const header = rows[0] ?? [];
  const idIdx = header.indexOf("id");
  assert.ok(idIdx >= 0, "header row must contain the id column");
  const byId = new Map<string, Map<string, string>>();
  for (const cells of rows.slice(1)) {
    if (cells.length <= 1) continue; // trailing blank line
    const rec = new Map<string, string>();
    header.forEach((col, idx) => rec.set(col, cells[idx] ?? ""));
    byId.set(cells[idIdx], rec);
  }
  return { header, byId };
}

const fixtureIdsIn = (byId: Map<string, unknown>): string[] =>
  CLIENT_IDS.filter((id) => byId.has(id));

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("GET /api/clients/export.csv — client list CSV export (Task #4990)");

  await seed();
  try {
    await step("401 JSON when unauthenticated (never a redirect)", async () => {
      await withApp(null, async (baseUrl) => {
        const r = await fetchCsv(baseUrl);
        assert.equal(r.status, 401, `expected 401, got ${r.status}`);
        assert.match(
          r.contentType ?? "",
          /application\/json/,
          `401 body must be JSON, got content-type ${r.contentType}`,
        );
      });
    });

    await step("403 JSON for an unknown subject (closed admission)", async () => {
      await withApp(GHOST_ID, async (baseUrl) => {
        const r = await fetchCsv(baseUrl);
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
        assert.match(
          r.contentType ?? "",
          /application\/json/,
          `403 body must be JSON, got content-type ${r.contentType}`,
        );
      });
    });

    await step("CEO: headers, schema-lockstep header row, all fixtures incl. demo + archived, no lead rows", async () => {
      await withApp(CEO_ID, async (baseUrl) => {
        const r = await fetchCsv(baseUrl);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        assert.equal(
          r.contentType,
          "text/csv; charset=utf-8",
          `Content-Type, got ${r.contentType}`,
        );
        assert.match(
          r.contentDisposition ?? "",
          /^attachment; filename="clients-export_\d{8}T\d{4}Z\.csv"$/,
          `Content-Disposition, got ${r.contentDisposition}`,
        );

        const { header, byId } = parseExport(r.text);
        // Schema lockstep: exported constant ↔ drizzle table columns ↔ the
        // header row actually served.
        assert.deepEqual(
          CLIENT_CSV_COLUMNS,
          Object.keys(getTableColumns(clients)),
          "CLIENT_CSV_COLUMNS must equal the drizzle clients-table column keys",
        );
        assert.deepEqual(
          header,
          CLIENT_CSV_COLUMNS,
          "served header row must be exactly CLIENT_CSV_COLUMNS",
        );
        for (const col of ["firmName", "clientStartDate", "isArchived", "isDemo", "ownerId"]) {
          assert.ok(header.includes(col), `header must include ${col}`);
        }

        assert.deepEqual(
          fixtureIdsIn(byId).sort(),
          [C_OWN, C_DEMO, C_ARCH, C_OTHER].sort(),
          "CEO export holds every customer fixture (demo + archived included) and never the lead-stage row",
        );

        // Serialization contract on the nasty fixture row.
        const own = byId.get(C_OWN)!;
        assert.equal(own.get("firmName"), NASTY_FIRM, "comma+quote firm name round-trips");
        assert.ok(
          r.text.includes(`"Smith, ""Jones"" & Partners ${RUN}"`),
          "raw CSV stream escapes the firm name via quote doubling",
        );
        assert.deepEqual(
          JSON.parse(own.get("practiceAreas") ?? ""),
          PRACTICE_AREAS,
          "text[] column exports as a JSON string",
        );
        assert.deepEqual(
          JSON.parse(own.get("terminology") ?? ""),
          TERMINOLOGY,
          "jsonb column exports as a JSON string",
        );
        assert.equal(
          own.get("clientStartDate"),
          START_DATE.toISOString(),
          "timestamp exports as ISO 8601",
        );
        assert.equal(own.get("averageCaseValue"), "15000", "numeric column exports as its plain string");
        assert.equal(own.get("isDemo"), "false", "boolean exports as true/false");

        const arch = byId.get(C_ARCH)!;
        assert.equal(arch.get("isArchived"), "true", "archived row is identifiable via isArchived");
        assert.equal(arch.get("clientStartDate"), "", "null clientStartDate exports as an empty cell");
      });
    });

    await step("account_manager: demo excluded, archived + others' clients included", async () => {
      await withApp(AM_ID, async (baseUrl) => {
        const r = await fetchCsv(baseUrl);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const { byId } = parseExport(r.text);
        assert.deepEqual(
          fixtureIdsIn(byId).sort(),
          [C_OWN, C_ARCH, C_OTHER].sort(),
          "AM export holds every non-demo customer fixture (archived included), demo and lead rows excluded",
        );
      });
    });

    await step("non-manager role: own non-demo clients only", async () => {
      await withApp(SALES_ID, async (baseUrl) => {
        const r = await fetchCsv(baseUrl);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const { byId } = parseExport(r.text);
        assert.deepEqual(
          fixtureIdsIn(byId),
          [C_OWN],
          "sales export holds exactly the caller's own non-demo client — no demo, no other owners' rows",
        );
      });
    });
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (route-test-undici-drain-hang).
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    await cleanup();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
