import type { Request, Response } from "express";
import { iterateUserBlockedEvents } from "../services/rateLimitMonitor";

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

function escapeCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Streaming handler for `GET /api/health/rate-limits/by-user/:userId/events.csv`.
 * Mounted by `registerRoutes` behind `isAuthenticated + requireTeamLead`
 * and imported directly by
 * `tests/blocked-rate-limit-events-by-user-csv-export` so the regression
 * test exercises the same code path the production route does.
 */
export async function blockedRateLimitEventsByUserCsvHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const range = parseRangeQuery(req.query.rangeStart, req.query.rangeEnd);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "user";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="rate-limit-events-${safe}.csv"`,
    );
    res.write("timestamp_iso,timestamp_ms,category,method,path,ip,user_id\n");
    let count = 0;
    for await (const ev of iterateUserBlockedEvents(userId, range.start, range.end)) {
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
    console.error("[RateLimitMetrics] User events CSV error:", err?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream user blocked events" });
    } else {
      res.end();
    }
  }
}
