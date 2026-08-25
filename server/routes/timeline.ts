import type { Express, Response } from "express";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireCommandCenterAccess } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";
import { getDeal } from "../storage/dealsStorage";
import {
  decodeTimelineCursor,
  getClientTimeline,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
  TIMELINE_MAX_Q_LENGTH,
  timelineEntryTypes,
  type TimelineCursor,
  type TimelineEntryType,
} from "../storage/timelineStorage";

/**
 * Task #4328 — Unified client activity timeline (read-only aggregation).
 *
 * GET /api/clients/:clientId/timeline
 *   Auth parity with the comm log it aggregates: isAuthenticated +
 *   requireCommandCenterAccess (sales read-only, AM/TL+, 404 unknown client).
 *
 * GET /api/deals/:dealId/timeline
 *   Deal visibility first (owner or account_manager+, exactly like
 *   GET /api/deals/:id), then the client-feed bar (sales GET allowed).
 *   Demo clients stay CEO-only (mirrors checkClientAttachable): non-CEO
 *   actors get an empty feed, not the demo client's activity. Deals with
 *   no linked client return an empty feed with clientId: null.
 *
 * The one timeline write path — manual notes — is the EXISTING
 * POST /api/clients/:clientId/communications (sourceType "manual"); this
 * file deliberately adds no second write route.
 */

interface ParsedTimelineQuery {
  types: TimelineEntryType[] | undefined;
  cursor: TimelineCursor | null;
  limit: number;
  q: string | null;
  after: Date | null;
  before: Date | null;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when y-m-d is a real calendar date (rejects 2026-02-30 etc.). */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Task #4418 — parse an `after`/`before` bound. Accepts a plain date
 * (YYYY-MM-DD, expanded to the inclusive start/end of that UTC day) or an
 * ISO-8601 timestamp. Strict: the calendar components must be real (no
 * JS Date overflow normalization) and the grammar must match exactly.
 * Returns null for anything else.
 */
function parseBound(raw: string, edge: "start" | "end"): Date | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  const match = DATE_ONLY_RE.exec(trimmed) ?? ISO_TS_RE.exec(trimmed);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!isRealCalendarDate(y, m, d)) return null;
  const iso = DATE_ONLY_RE.test(trimmed)
    ? `${trimmed}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : trimmed;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parses types/cursor/limit; on failure writes the 400 and returns null. */
function parseTimelineQuery(
  query: Record<string, unknown>,
  scopeClientId: string,
  res: Response,
): ParsedTimelineQuery | null {
  let limit = TIMELINE_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number.parseInt(String(query.limit), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return null;
    }
    limit = Math.min(parsed, TIMELINE_MAX_LIMIT);
  }

  let types: TimelineEntryType[] | undefined;
  if (query.types !== undefined) {
    const rawList = String(query.types)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const known = new Set<string>(timelineEntryTypes);
    const bad = rawList.filter((t) => !known.has(t));
    if (bad.length > 0) {
      res.status(400).json({ error: `Unknown timeline type(s): ${bad.join(", ")}` });
      return null;
    }
    if (rawList.length > 0) types = rawList as TimelineEntryType[];
  }

  let q: string | null = null;
  if (query.q !== undefined) {
    if (typeof query.q !== "string" || query.q.length > TIMELINE_MAX_Q_LENGTH) {
      res.status(400).json({ error: `q must be a string of at most ${TIMELINE_MAX_Q_LENGTH} characters` });
      return null;
    }
    const trimmed = query.q.trim();
    if (trimmed.length > 0) q = trimmed;
  }

  let after: Date | null = null;
  if (query.after !== undefined) {
    after = typeof query.after === "string" ? parseBound(query.after, "start") : null;
    if (!after) {
      res.status(400).json({ error: "after must be a YYYY-MM-DD date or ISO-8601 timestamp" });
      return null;
    }
  }

  let before: Date | null = null;
  if (query.before !== undefined) {
    before = typeof query.before === "string" ? parseBound(query.before, "end") : null;
    if (!before) {
      res.status(400).json({ error: "before must be a YYYY-MM-DD date or ISO-8601 timestamp" });
      return null;
    }
  }

  if (after && before && after.getTime() > before.getTime()) {
    res.status(400).json({ error: "after must not be later than before" });
    return null;
  }

  let cursor: TimelineCursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 600) {
      res.status(400).json({ error: "Invalid cursor" });
      return null;
    }
    cursor = decodeTimelineCursor(query.cursor);
    if (!cursor) {
      res.status(400).json({ error: "Invalid cursor" });
      return null;
    }
    // A cursor minted for one client is meaningless (and confusing) against
    // another scope — reject instead of silently filtering (ATS precedent).
    if (cursor.cid !== scopeClientId) {
      res.status(400).json({ error: "Cursor does not match this timeline" });
      return null;
    }
  }

  return { types, cursor, limit, q, after, before };
}

export function registerTimelineRoutes(app: Express): void {
  app.get(
    "/api/clients/:clientId/timeline",
    isAuthenticated,
    requireCommandCenterAccess,
    async (req: AuthenticatedRequest<{ clientId: string }>, res: Response) => {
      try {
        const clientId = req.params.clientId;
        const parsed = parseTimelineQuery(
          req.query as Record<string, unknown>,
          clientId,
          res,
        );
        if (!parsed) return;
        const page = await getClientTimeline(clientId, parsed);
        res.json({ ...page, clientId });
      } catch (error) {
        console.error("[Timeline] Error fetching client timeline:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.get(
    "/api/deals/:dealId/timeline",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ dealId: string }>, res: Response) => {
      try {
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const user = await storage.getUser(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const deal = await getDeal(req.params.dealId);
        if (!deal) return res.status(404).json({ error: "Deal not found" });

        // Deal visibility: exactly the GET /api/deals/:id bar.
        const canSeeAll = hasRole(user.role, "account_manager");
        if (!canSeeAll && deal.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }
        // Client-feed bar parity (requireCommandCenterAccess, GET):
        // sales / account_manager / team_lead+ may read.
        const mayRead =
          user.role === "sales" ||
          user.role === "account_manager" ||
          hasRole(user.role, "team_lead");
        if (!mayRead) {
          return res.status(403).json({ error: "Access denied" });
        }

        const empty = { entries: [], nextCursor: null, clientId: null };
        if (!deal.clientId) return res.json(empty);

        const client = await storage.getClient(deal.clientId);
        if (!client) return res.json(empty);
        // Demo clients are CEO-only across the deals surface
        // (checkClientAttachable) — hide their activity, not just attach.
        if (client.isDemo && user.role !== "ceo") return res.json(empty);

        const parsed = parseTimelineQuery(
          req.query as Record<string, unknown>,
          deal.clientId,
          res,
        );
        if (!parsed) return;
        const page = await getClientTimeline(deal.clientId, parsed);
        res.json({ ...page, clientId: deal.clientId });
      } catch (error) {
        console.error("[Timeline] Error fetching deal timeline:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );
}
