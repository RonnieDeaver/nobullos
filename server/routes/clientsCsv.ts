import type { Response } from "express";
import { getTableColumns } from "drizzle-orm";
import { clients, type Client } from "@shared/schema";
import { storage } from "../storage";
import { hasRole } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";

/**
 * Task #4990 — Client list CSV export.
 *
 * `GET /api/clients/export.csv` streams the caller's full client list (every
 * clients-table column) as a CSV attachment so admins can pull client data
 * (notably the "Client Since" start dates) without database access.
 *
 * Contract:
 *  - Role scoping mirrors GET /api/clients EXACTLY (server/routes/clients.ts):
 *    CEO → all clients including demo; account_manager and up → all clients
 *    minus demo; everyone else → own clients minus demo. The same storage
 *    accessors are used (getClients / getClientsByOwner), so the
 *    lifecycle-stage "customer" gate matches the list too — prospects/leads
 *    never appear. The export exposes no row the caller cannot already see
 *    in the client list UI.
 *  - Archived clients are ALWAYS included (the export is the complete client
 *    record; the isArchived column identifies them). The list's showArchived
 *    query param is a display filter, deliberately not mirrored here.
 *  - Columns derive from the drizzle table definition (getTableColumns), so
 *    the CSV stays in lockstep with the schema: a new clients column shows up
 *    in the export (and the route test's header assertion) without touching a
 *    hand-maintained list. One column per field, TS property names as headers.
 *  - Cell serialization: null/undefined → empty cell (an unset
 *    clientStartDate exports as an empty cell, never a placeholder),
 *    Date → ISO 8601, arrays and objects (text[] columns, terminology jsonb)
 *    → JSON strings, everything else → String(value).
 *
 * The handler follows the streaming-CSV pattern of
 * server/routes/blockedRateLimitEventsCsv.ts (escapeCsvCell, timestamped
 * attachment filename, periodic event-loop yield, 500 JSON only when headers
 * are unsent). Helpers are colocated per that file's convention; extract a
 * shared CSV module only when a third exporter appears.
 *
 * Mounted by registerClientRoutes (server/routes/clients.ts) behind
 * `isAuthenticated`, registered BEFORE GET /api/clients/:id so the ":id"
 * matcher can never swallow "export.csv". Also imported directly by
 * tests/client-list-csv-export.test.ts so the test exercises the same code
 * path the production route does.
 */

/**
 * Export column order = drizzle table-definition order
 * (shared/models/clients.ts). Exported so the route test can assert the
 * header row is exactly this list.
 */
export const CLIENT_CSV_COLUMNS = Object.keys(
  getTableColumns(clients),
) as (keyof Client)[];

function formatTimestampForFilename(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`
  );
}

function escapeCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serializes one client-record field into its CSV cell string (before CSV
 * escaping): empty cell for null/undefined, ISO 8601 for timestamps, JSON
 * strings for array (text[]) and object (jsonb) columns.
 */
function serializeClientCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export async function clientListCsvHandler(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      // Unreachable behind isAuthenticated; defensive JSON (never redirect).
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await storage.getUser(userId);

    // Role scoping — EXACT mirror of GET /api/clients (clients.ts): CEO sees
    // everything including demo; account_manager and up see everything minus
    // demo; everyone else sees only their own clients minus demo.
    let rows: Client[];
    if (user?.role === "ceo") {
      rows = await storage.getClients();
    } else if (hasRole(user?.role, "account_manager")) {
      rows = (await storage.getClients()).filter((c) => !c.isDemo);
    } else {
      rows = (await storage.getClientsByOwner(userId)).filter((c) => !c.isDemo);
    }
    // Archived rows deliberately stay in (identifiable via the isArchived
    // column) — the export is the complete record, unlike the list's
    // showArchived display toggle.

    const filename = `clients-export_${formatTimestampForFilename(Date.now())}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(CLIENT_CSV_COLUMNS.join(",") + "\n");

    let count = 0;
    for (const row of rows) {
      const line = CLIENT_CSV_COLUMNS.map((col) =>
        escapeCsvCell(serializeClientCell(row[col])),
      ).join(",");
      res.write(line + "\n");
      count++;
      if (count % 500 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    res.end();
  } catch (err: any) {
    console.error("[ClientsCsv] client list CSV export error:", err?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to export client list" });
    } else {
      res.end();
    }
  }
}
