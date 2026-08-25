import type { Request, Response } from "express";
import { iterateBlockedRateLimitEvents } from "../storage/blockedRateLimitEventsStorage";

/**
 * Parses the optional `rangeStart` / `rangeEnd` query-string pair used by
 * the rate-limit dashboards. Both must be provided together; both must
 * be finite epoch ms; end must be strictly greater than start.
 *
 * Kept colocated with the handler so the CSV export and the JSON list
 * endpoint remain free to evolve their range semantics independently if
 * needed.
 */
function parseRangeQuery(
  rawStart: unknown,
  rawEnd: unknown,
): { start: number | null; end: number | null; error?: string } {
  const startProvided = rawStart !== undefined && rawStart !== "";
  const endProvided = rawEnd !== undefined && rawEnd !== "";
  if (!startProvided && !endProvided) return { start: null, end: null };
  if (!startProvided || !endProvided) {
    return { start: null, end: null, error: "rangeStart and rangeEnd must both be provided" };
  }
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { start: null, end: null, error: "rangeStart and rangeEnd must be numeric epoch ms" };
  }
  if (end <= start) {
    return { start: null, end: null, error: "rangeEnd must be greater than rangeStart" };
  }
  return { start, end };
}

function sanitizeForFilename(v: string, maxLen = 32): string {
  return v.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, maxLen);
}

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
 * Streaming handler for `GET /api/health/rate-limits/events.csv`. Mounted
 * by `registerRoutes` behind `isAuthenticated + requireTeamLead` and
 * also imported directly by `tests/blocked-rate-limit-events-csv-export`
 * so the test exercises the same code path the production route does.
 */
export async function blockedRateLimitEventsCsvHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const range = parseRangeQuery(req.query.rangeStart, req.query.rangeEnd);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }

    const userIdRaw = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const ipRaw = typeof req.query.ip === "string" ? req.query.ip.trim() : "";
    const categoryRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";

    const filenameParts: string[] = ["blocked-events"];
    if (range.start !== null && range.end !== null) {
      filenameParts.push(
        `${formatTimestampForFilename(range.start)}-${formatTimestampForFilename(range.end)}`,
      );
    }
    if (userIdRaw) filenameParts.push(`user-${sanitizeForFilename(userIdRaw)}`);
    if (ipRaw) filenameParts.push(`ip-${sanitizeForFilename(ipRaw)}`);
    if (categoryRaw) filenameParts.push(`cat-${sanitizeForFilename(categoryRaw)}`);
    if (filenameParts.length === 1) filenameParts.push(String(Date.now()));
    const filename = `${filenameParts.join("_")}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write("timestamp_iso,timestamp_ms,category,method,path,ip,user_id\n");

    const filters = {
      userId: userIdRaw || null,
      ip: ipRaw || null,
      category: categoryRaw || null,
      rangeStart: range.start,
      rangeEnd: range.end,
    };
    let count = 0;
    for await (const ev of iterateBlockedRateLimitEvents(filters)) {
      const row = [
        new Date(ev.timestamp).toISOString(),
        ev.timestamp,
        ev.category,
        ev.method,
        ev.path,
        ev.ip,
        ev.userId,
      ].map(escapeCsvCell).join(",");
      res.write(row + "\n");
      count++;
      if (count % 500 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    res.end();
  } catch (err: any) {
    console.error("[RateLimitMetrics] Blocked events CSV error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream blocked events" });
    } else {
      res.end();
    }
  }
}
