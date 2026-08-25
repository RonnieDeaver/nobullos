// @db-pool-intent: ambient
//
// Task #3721 — internal tool-usage tracker aggregation. Storage module
// inherits its pool from the caller (the leadership-gated API route runs
// on the request-scoped pool). Every getDb() call below runs inside
// `withDbAttribution("internalUsage:computeReport", …)`.
//
// Member rows count only team-initiated actions across the five core
// client tools:
//   - scheduler bookings attributed to the account manager
//     (`scheduled_meetings.account_manager_user_id`), split direct
//     (`booking_source = 'client_profile'`) vs via public link (the two
//     public-link sources);
//   - outbound SMS by sender (`twilio_messages.sent_by_user_id`,
//     direction = 'outbound'; inbound rows excluded);
//   - outbound calls by initiator (`twilio_calls.initiated_by_user_id`,
//     direction = 'outbound');
//   - intel notes by creator (`intelligence_feed_entries.created_by`,
//     NOT NULL since inception — every intel row has a creator);
//   - user-role agent chat messages by sender
//     (`client_agent_chats.created_by_user_id`). Historical rows have no
//     sender and are reported per client only (`agentChatUnattributed`);
//     assistant-role rows are never counted.
//
// Accuracy audit (follow-up to Task #3721): outbound bookings/SMS/calls
// whose actor column is NULL (automated/system writes, e.g. a browser-call
// webhook that could not resolve the client identity, or legacy rows) are
// NOT silently dropped anymore — they surface in the card-level
// `*Unattributed` totals, mirroring agent chat's historical bucket. They
// are deliberately kept out of member rows, per-client grids and the
// idle-client detection: those measure team adoption, and an automated
// send must not mask a real gap. As of the 2026-08-06 production audit,
// zero such rows exist (all-time) — this is forward-proofing.

import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  clientAgentChats,
  clients,
  intelligenceFeedEntries,
  scheduledMeetings,
  twilioCalls,
  twilioConversations,
  twilioMessages,
  users,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

export interface InternalUsageToolCounts {
  bookings: number;
  bookingsDirect: number;
  bookingsPublicLink: number;
  sms: number;
  calls: number;
  intel: number;
  agentChat: number;
}

export interface InternalUsageClientRow {
  clientId: string;
  firmName: string;
  counts: InternalUsageToolCounts;
  /** Total member-attributed actions on this client (sum of counts). */
  total: number;
  /** User-role agent chat rows on this client whose sender is unknown (historical). */
  agentChatUnattributed: number;
  /** Attributed actions on this client by team members OTHER than this member. */
  othersActivity: number;
  /** True when nobody touched this client with any tool in the range. */
  noActivity: boolean;
}

export interface InternalUsageMember {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  counts: InternalUsageToolCounts;
  /** Total attributed actions by this member across all clients (incl. unassigned/no-client). */
  total: number;
  assignedClientCount: number;
  /** Assigned clients with zero activity from ANY tool (by anyone) in the range. */
  clientsWithNoActivity: number;
  clients: InternalUsageClientRow[];
}

/**
 * Task #4872 — selectable window: a trailing day count, or "all" for the
 * tool's entire recorded history (no lower bound on created_at).
 */
export type InternalUsageWindow = number | "all";

export interface InternalUsageReport {
  days: InternalUsageWindow;
  /**
   * Start of the reported range. For numeric windows this is the window
   * boundary (now − days); for "all" it is the earliest counted row —
   * never a fake epoch. Equals `until` when nothing was counted.
   */
  since: string;
  until: string;
  /**
   * Earliest created_at among the rows actually counted in this window,
   * across all five tools — the true coverage start of the data shown.
   * Null when the window contains no counted rows (Task #4872).
   */
  coverageStart: string | null;
  totals: {
    /** All counted bookings in range (attributed + unattributed). */
    bookings: number;
    /** Direct/link split covers ALL counted bookings, so it sums to `bookings`. */
    bookingsDirect: number;
    bookingsPublicLink: number;
    bookingsAttributed: number;
    /** Bookings with no account manager (automated/legacy) — card level only. */
    bookingsUnattributed: number;
    /** All outbound SMS in range (attributed + unattributed). */
    sms: number;
    smsAttributed: number;
    /** Outbound SMS with no recorded sender (automated) — card level only. */
    smsUnattributed: number;
    /** All outbound calls in range (attributed + unattributed). */
    calls: number;
    callsAttributed: number;
    /** Outbound calls with no recorded initiator (automated) — card level only. */
    callsUnattributed: number;
    intel: number;
    /** All counted user-role chat messages (attributed + unattributed). */
    agentChat: number;
    agentChatAttributed: number;
    agentChatUnattributed: number;
  };
  members: InternalUsageMember[];
  /** Per-client counts of user-role chat rows with unknown sender (historical). */
  unattributedAgentChat: Array<{
    clientId: string | null;
    firmName: string | null;
    count: number;
  }>;
}

type ToolKey = "bookings" | "sms" | "calls" | "intel" | "agentChat";

const NO_CLIENT_KEY = "__none__";

function emptyCounts(): InternalUsageToolCounts {
  return {
    bookings: 0,
    bookingsDirect: 0,
    bookingsPublicLink: 0,
    sms: 0,
    calls: 0,
    intel: 0,
    agentChat: 0,
  };
}

function countsTotal(c: InternalUsageToolCounts): number {
  return c.bookings + c.sms + c.calls + c.intel + c.agentChat;
}

/**
 * Compute the internal tool-usage report for the trailing `days` window
 * (created_at >= now - days), or for all recorded history when `days` is
 * "all" (Task #4872 — pre-launch rows are countable because aggregation
 * happens at query time over the never-pruned source tables). Members are
 * all non-deleted users that hold a team role (account_manager and up), own
 * at least one client, or performed at least one counted action in the
 * range — so zero-usage members still appear (that is the adoption gap
 * leadership wants to see).
 */
export async function computeInternalUsageReport(
  days: InternalUsageWindow,
): Promise<InternalUsageReport> {
  const until = new Date();
  const since =
    days === "all" ? null : new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  // Window bound shared by the five tool queries: numeric windows are
  // two-sided; "all" keeps only the upper bound so every historical row
  // back to each tool's first write is counted.
  const createdWithinWindow = (createdAt: AnyPgColumn) =>
    since ? and(gte(createdAt, since), lte(createdAt, until)) : lte(createdAt, until);

  return withDbAttribution("internalUsage:computeReport", async () => {
    const [bookingRows, smsRows, callRows, intelRows, chatRows, allUsers, allClients] =
      await Promise.all([
        getDb()
          .select({
            userId: scheduledMeetings.accountManagerUserId,
            clientId: scheduledMeetings.clientId,
            direct: sql<number>`count(*) filter (where ${scheduledMeetings.bookingSource} = 'client_profile')::int`,
            publicLink: sql<number>`count(*) filter (where ${scheduledMeetings.bookingSource} <> 'client_profile')::int`,
            earliest: sql<string | Date | null>`min(${scheduledMeetings.createdAt})`,
          })
          .from(scheduledMeetings)
          // No NULL-actor filter: AM-less rows are counted card-level as
          // unattributed instead of being silently dropped.
          .where(createdWithinWindow(scheduledMeetings.createdAt))
          .groupBy(scheduledMeetings.accountManagerUserId, scheduledMeetings.clientId),
        getDb()
          .select({
            userId: twilioMessages.sentByUserId,
            clientId: twilioConversations.clientId,
            count: sql<number>`count(*)::int`,
            earliest: sql<string | Date | null>`min(${twilioMessages.createdAt})`,
          })
          .from(twilioMessages)
          .leftJoin(
            twilioConversations,
            eq(twilioMessages.conversationId, twilioConversations.id),
          )
          .where(
            and(
              eq(twilioMessages.direction, "outbound"),
              createdWithinWindow(twilioMessages.createdAt),
            ),
          )
          .groupBy(twilioMessages.sentByUserId, twilioConversations.clientId),
        getDb()
          .select({
            userId: twilioCalls.initiatedByUserId,
            clientId: twilioCalls.clientId,
            count: sql<number>`count(*)::int`,
            earliest: sql<string | Date | null>`min(${twilioCalls.createdAt})`,
          })
          .from(twilioCalls)
          .where(
            and(
              eq(twilioCalls.direction, "outbound"),
              createdWithinWindow(twilioCalls.createdAt),
            ),
          )
          .groupBy(twilioCalls.initiatedByUserId, twilioCalls.clientId),
        getDb()
          .select({
            userId: intelligenceFeedEntries.createdBy,
            clientId: intelligenceFeedEntries.clientId,
            count: sql<number>`count(*)::int`,
            earliest: sql<string | Date | null>`min(${intelligenceFeedEntries.createdAt})`,
          })
          .from(intelligenceFeedEntries)
          .where(createdWithinWindow(intelligenceFeedEntries.createdAt))
          .groupBy(intelligenceFeedEntries.createdBy, intelligenceFeedEntries.clientId),
        // userId is nullable here on purpose: historical rows have no sender
        // and surface in the per-client unattributed bucket.
        getDb()
          .select({
            userId: clientAgentChats.createdByUserId,
            clientId: clientAgentChats.clientId,
            count: sql<number>`count(*)::int`,
            earliest: sql<string | Date | null>`min(${clientAgentChats.createdAt})`,
          })
          .from(clientAgentChats)
          .where(
            and(
              eq(clientAgentChats.role, "user"),
              createdWithinWindow(clientAgentChats.createdAt),
            ),
          )
          .groupBy(clientAgentChats.createdByUserId, clientAgentChats.clientId),
        getDb()
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            role: users.role,
          })
          .from(users)
          .where(isNull(users.deletedAt)),
        getDb()
          .select({
            id: clients.id,
            firmName: clients.firmName,
            ownerId: clients.ownerId,
            isArchived: clients.isArchived,
            isDemo: clients.isDemo,
          })
          .from(clients),
      ]);

    // Task #4872 — true coverage start: the earliest created_at among rows
    // actually counted in this window, across all five tools. Each grouped
    // query carries a per-group min(created_at); the overall minimum is the
    // honest "data begins here" stamp (null when the window is empty).
    let earliestCounted: Date | null = null;
    const noteEarliest = (value: string | Date | null | undefined) => {
      if (!value) return;
      const d = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(d.getTime())) return;
      if (!earliestCounted || d < earliestCounted) earliestCounted = d;
    };
    for (const r of bookingRows) noteEarliest(r.earliest);
    for (const r of smsRows) noteEarliest(r.earliest);
    for (const r of callRows) noteEarliest(r.earliest);
    for (const r of intelRows) noteEarliest(r.earliest);
    for (const r of chatRows) noteEarliest(r.earliest);

    // usage[userId][clientKey] = per-tool counts by that member on that client.
    const usage = new Map<string, Map<string, InternalUsageToolCounts>>();
    // Attributed activity per client by ANY member (for othersActivity / idle-client detection).
    const clientActivityByUser = new Map<string, Map<string, number>>();
    const unattributedChatByClient = new Map<string, number>();
    // Card-level unattributed buckets for the three tools whose actor column
    // is nullable (automated/system writes; zero rows in prod as of the
    // 2026-08-06 audit). Never attributed to members or clients.
    const unattributed = {
      bookings: 0,
      bookingsDirect: 0,
      bookingsPublicLink: 0,
      sms: 0,
      calls: 0,
    };

    const bump = (
      userId: string,
      clientId: string | null,
      tool: ToolKey,
      n: number,
      bookingBreakdown?: { direct: number; publicLink: number },
    ) => {
      if (n <= 0 && !bookingBreakdown) return;
      const clientKey = clientId ?? NO_CLIENT_KEY;
      let perClient = usage.get(userId);
      if (!perClient) {
        perClient = new Map();
        usage.set(userId, perClient);
      }
      let counts = perClient.get(clientKey);
      if (!counts) {
        counts = emptyCounts();
        perClient.set(clientKey, counts);
      }
      counts[tool] += n;
      if (bookingBreakdown) {
        counts.bookingsDirect += bookingBreakdown.direct;
        counts.bookingsPublicLink += bookingBreakdown.publicLink;
      }
      if (clientId) {
        let perUser = clientActivityByUser.get(clientId);
        if (!perUser) {
          perUser = new Map();
          clientActivityByUser.set(clientId, perUser);
        }
        perUser.set(userId, (perUser.get(userId) ?? 0) + n);
      }
    };

    for (const r of bookingRows) {
      const direct = r.direct ?? 0;
      const publicLink = r.publicLink ?? 0;
      const total = direct + publicLink;
      if (r.userId) {
        bump(r.userId, r.clientId, "bookings", total, { direct, publicLink });
      } else {
        unattributed.bookings += total;
        unattributed.bookingsDirect += direct;
        unattributed.bookingsPublicLink += publicLink;
      }
    }
    for (const r of smsRows) {
      if (r.userId) {
        bump(r.userId, r.clientId, "sms", r.count ?? 0);
      } else {
        unattributed.sms += r.count ?? 0;
      }
    }
    for (const r of callRows) {
      if (r.userId) {
        bump(r.userId, r.clientId, "calls", r.count ?? 0);
      } else {
        unattributed.calls += r.count ?? 0;
      }
    }
    for (const r of intelRows) {
      // No NULL branch: intelligence_feed_entries.created_by is NOT NULL
      // since inception (shared/models/commandCenter.ts), so every intel
      // row is attributable — the old `if (!r.userId) continue` skip was
      // dead code and was removed in the accuracy audit.
      bump(r.userId, r.clientId, "intel", r.count ?? 0);
    }
    for (const r of chatRows) {
      if (r.userId) {
        bump(r.userId, r.clientId, "agentChat", r.count ?? 0);
      } else {
        const key = r.clientId ?? NO_CLIENT_KEY;
        unattributedChatByClient.set(
          key,
          (unattributedChatByClient.get(key) ?? 0) + (r.count ?? 0),
        );
      }
    }

    // Overall per-tool totals. Attributed = actions by a stamped actor
    // (regardless of whether the actor is still a visible member);
    // card totals = attributed + unattributed so they never under-report.
    const totals = {
      bookings: 0,
      bookingsDirect: unattributed.bookingsDirect,
      bookingsPublicLink: unattributed.bookingsPublicLink,
      bookingsAttributed: 0,
      bookingsUnattributed: unattributed.bookings,
      sms: 0,
      smsAttributed: 0,
      smsUnattributed: unattributed.sms,
      calls: 0,
      callsAttributed: 0,
      callsUnattributed: unattributed.calls,
      intel: 0,
      agentChat: 0,
      agentChatAttributed: 0,
      agentChatUnattributed: 0,
    };
    for (const perClient of Array.from(usage.values())) {
      for (const c of Array.from(perClient.values())) {
        totals.bookingsAttributed += c.bookings;
        totals.bookingsDirect += c.bookingsDirect;
        totals.bookingsPublicLink += c.bookingsPublicLink;
        totals.smsAttributed += c.sms;
        totals.callsAttributed += c.calls;
        totals.intel += c.intel;
        totals.agentChatAttributed += c.agentChat;
      }
    }
    for (const n of Array.from(unattributedChatByClient.values())) {
      totals.agentChatUnattributed += n;
    }
    totals.bookings = totals.bookingsAttributed + totals.bookingsUnattributed;
    totals.sms = totals.smsAttributed + totals.smsUnattributed;
    totals.calls = totals.callsAttributed + totals.callsUnattributed;
    totals.agentChat = totals.agentChatAttributed + totals.agentChatUnattributed;

    const clientById = new Map(allClients.map((c) => [c.id, c]));

    const TEAM_ROLES = new Set(["account_manager", "team_lead", "ceo"]);
    const memberUsers = allUsers.filter((u) => {
      if (TEAM_ROLES.has(u.role ?? "")) return true;
      if (usage.has(u.id)) return true;
      return allClients.some((c) => c.ownerId === u.id && !c.isArchived);
    });

    const members: InternalUsageMember[] = memberUsers.map((u) => {
      const perClient = usage.get(u.id) ?? new Map<string, InternalUsageToolCounts>();

      const memberCounts = emptyCounts();
      for (const c of Array.from(perClient.values())) {
        memberCounts.bookings += c.bookings;
        memberCounts.bookingsDirect += c.bookingsDirect;
        memberCounts.bookingsPublicLink += c.bookingsPublicLink;
        memberCounts.sms += c.sms;
        memberCounts.calls += c.calls;
        memberCounts.intel += c.intel;
        memberCounts.agentChat += c.agentChat;
      }

      // Assigned book of clients: active (non-archived, non-demo) clients
      // owned by this member. Archived/demo clients are excluded so they
      // don't show up as fake "no activity" gaps.
      const assigned = allClients.filter(
        (c) => c.ownerId === u.id && !c.isArchived && !c.isDemo,
      );

      const clientRows: InternalUsageClientRow[] = assigned
        .map((c) => {
          const counts = perClient.get(c.id) ?? emptyCounts();
          const total = countsTotal(counts);
          const agentChatUnattributed = unattributedChatByClient.get(c.id) ?? 0;
          const perUser = clientActivityByUser.get(c.id);
          let othersActivity = 0;
          if (perUser) {
            for (const [actorId, n] of Array.from(perUser.entries())) {
              if (actorId !== u.id) othersActivity += n;
            }
          }
          return {
            clientId: c.id,
            firmName: c.firmName,
            counts,
            total,
            agentChatUnattributed,
            othersActivity,
            noActivity: total === 0 && agentChatUnattributed === 0 && othersActivity === 0,
          };
        })
        .sort((a, b) => a.total - b.total || a.firmName.localeCompare(b.firmName));

      return {
        userId: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        counts: memberCounts,
        total: countsTotal(memberCounts),
        assignedClientCount: assigned.length,
        clientsWithNoActivity: clientRows.filter((r) => r.noActivity).length,
        clients: clientRows,
      };
    });

    members.sort(
      (a, b) =>
        b.total - a.total ||
        `${a.firstName ?? ""} ${a.lastName ?? ""}`.localeCompare(
          `${b.firstName ?? ""} ${b.lastName ?? ""}`,
        ),
    );

    const unattributedAgentChat = Array.from(unattributedChatByClient.entries())
      .map(([key, count]) => {
        const client = key === NO_CLIENT_KEY ? undefined : clientById.get(key);
        return {
          clientId: key === NO_CLIENT_KEY ? null : key,
          firmName: client?.firmName ?? null,
          count,
        };
      })
      .sort((a, b) => b.count - a.count);

    // `since` for a numeric window is the window boundary; for "all" it is
    // the earliest counted row (never a fake epoch), falling back to `until`
    // when nothing has ever been counted.
    // (cast: TS control-flow analysis can't see the closure assignments in
    // noteEarliest and would otherwise narrow this to `null`.)
    const coverageStartDate = earliestCounted as Date | null;
    return {
      days,
      since: (since ?? coverageStartDate ?? until).toISOString(),
      until: until.toISOString(),
      coverageStart: coverageStartDate ? coverageStartDate.toISOString() : null,
      totals,
      members,
      unattributedAgentChat,
    };
  });
}

// ── Task #4874: weekly win cadence tracker ───────────────────────────────────
// Leadership view: per-member `win_progress` submissions bucketed by UTC
// calendar week (Monday start) over a fixed trailing window. Deliberately
// independent of the usage report's selectable range — the cadence target
// ("at least one win per week" for account managers) is fixed, so its window
// is too. Wins on demo or archived clients never count toward the target and
// archived (retracted) entries are excluded — same read semantics as the
// dashboard Win Feed except demo exclusion happens server-side here because
// it is target math, not a display preference.

export const WIN_TRACKING_WEEKS = 8;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Same role set as the usage report's member filter (function-local there).
const WIN_TRACKING_TEAM_ROLES = new Set(["account_manager", "team_lead", "ceo"]);

/** Monday 00:00:00 UTC of the week containing `date`. */
export function getUtcWeekStart(date: Date): Date {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - daysSinceMonday,
  ));
}

/**
 * Week starts (oldest → newest) for the trailing window whose last week is
 * the one containing `now`. UTC week starts are exactly 7×24h apart (UTC has
 * no DST), so plain millisecond arithmetic is safe.
 */
export function buildTrailingWeekStarts(now: Date, weekCount: number = WIN_TRACKING_WEEKS): Date[] {
  const currentStart = getUtcWeekStart(now);
  const starts: Date[] = [];
  for (let i = weekCount - 1; i >= 0; i--) {
    starts.push(new Date(currentStart.getTime() - i * WEEK_MS));
  }
  return starts;
}

/** Per-user win counts per week index; rows outside the grid are dropped. */
export function bucketWinCounts(
  rows: Array<{ createdBy: string; createdAt: Date | string | null }>,
  weekStarts: Date[],
): Map<string, number[]> {
  const counts = new Map<string, number[]>();
  if (weekStarts.length === 0) return counts;
  const gridStart = weekStarts[0].getTime();
  const gridEnd = weekStarts[weekStarts.length - 1].getTime() + WEEK_MS;
  for (const row of rows) {
    if (!row.createdAt) continue;
    const t = new Date(row.createdAt).getTime();
    if (Number.isNaN(t) || t < gridStart || t >= gridEnd) continue;
    const idx = Math.floor((t - gridStart) / WEEK_MS);
    let arr = counts.get(row.createdBy);
    if (!arr) {
      arr = new Array(weekStarts.length).fill(0);
      counts.set(row.createdBy, arr);
    }
    arr[idx] += 1;
  }
  return counts;
}

export interface WinTrackingWeek {
  start: string;
  end: string;
  isCurrent: boolean;
}

export interface WinTrackingWeekCell {
  count: number;
  /** ≥1 win this week. Only meaningful for account managers; null otherwise. */
  met: boolean | null;
}

export interface WinTrackingMember {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  isAccountManager: boolean;
  weeks: WinTrackingWeekCell[];
  total: number;
}

export interface WinTrackingReport {
  weeks: WinTrackingWeek[];
  members: WinTrackingMember[];
  summary: { accountManagers: number; metThisWeek: number };
  generatedAt: string;
}

export async function computeWinTrackingReport(now: Date = new Date()): Promise<WinTrackingReport> {
  const weekStarts = buildTrailingWeekStarts(now);
  const windowStart = weekStarts[0];
  return withDbAttribution("internalUsage:winTracking", async () => {
    const [winRows, allUsers] = await Promise.all([
      getDb()
        .select({
          createdBy: intelligenceFeedEntries.createdBy,
          createdAt: intelligenceFeedEntries.createdAt,
        })
        .from(intelligenceFeedEntries)
        .innerJoin(clients, eq(intelligenceFeedEntries.clientId, clients.id))
        .where(and(
          eq(intelligenceFeedEntries.entryType, "win_progress"),
          ne(intelligenceFeedEntries.status, "archived"),
          or(eq(clients.isArchived, false), isNull(clients.isArchived)),
          or(eq(clients.isDemo, false), isNull(clients.isDemo)),
          gte(intelligenceFeedEntries.createdAt, windowStart),
          lte(intelligenceFeedEntries.createdAt, now),
        )),
      getDb()
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
        })
        .from(users)
        .where(isNull(users.deletedAt)),
    ]);

    const countsByUser = bucketWinCounts(winRows, weekStarts);
    // Same member-universe rule as the usage report: everyone in a team role
    // is listed (a zero-win account manager must show the gap), plus anyone
    // else who logged a counted win inside the window.
    const memberUsers = allUsers.filter(
      (u) => WIN_TRACKING_TEAM_ROLES.has(u.role ?? "") || countsByUser.has(u.id),
    );

    const members: WinTrackingMember[] = memberUsers.map((u) => {
      const counts: number[] = countsByUser.get(u.id) ?? new Array(weekStarts.length).fill(0);
      const isAccountManager = (u.role ?? "") === "account_manager";
      return {
        userId: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        isAccountManager,
        weeks: counts.map((count) => ({
          count,
          met: isAccountManager ? count >= 1 : null,
        })),
        total: counts.reduce((a, b) => a + b, 0),
      };
    });

    const memberSortName = (m: WinTrackingMember) =>
      `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.email || m.userId;
    members.sort((a, b) => {
      if (a.isAccountManager !== b.isAccountManager) return a.isAccountManager ? -1 : 1;
      return memberSortName(a).localeCompare(memberSortName(b));
    });

    const accountManagers = members.filter((m) => m.isAccountManager);
    const currentIdx = weekStarts.length - 1;
    return {
      weeks: weekStarts.map((start, i) => ({
        start: start.toISOString(),
        end: new Date(start.getTime() + WEEK_MS).toISOString(),
        isCurrent: i === currentIdx,
      })),
      members,
      summary: {
        accountManagers: accountManagers.length,
        metThisWeek: accountManagers.filter((m) => m.weeks[currentIdx].count >= 1).length,
      },
      generatedAt: now.toISOString(),
    };
  });
}
