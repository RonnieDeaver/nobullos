// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1688 — recipient-resolution helpers for the per-user
 * notification inbox.
 *
 * Each helper returns an array of user IDs that should receive an
 * in-app notification for a given event. Event sources call these and
 * then pass the IDs to `notifyUser()` — the helpers themselves never
 * write to the inbox, broadcast, or call Slack.
 *
 * Hard rule from the task brief: event sources only RESOLVE recipients
 * and call `notifyUser`. They must not duplicate the persistence or
 * Slack-DM logic the helper owns.
 *
 * All helpers:
 *   - return [] (not throw) when their inputs don't resolve
 *   - swallow DB errors so notification fan-out can never block the
 *     primary event handler
 *   - de-duplicate within the returned list
 *   - never include null/empty strings
 */

import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getAssignedAuthority } from "../../auth/permissions";
import { getDb, withDbAttribution } from "../../db";
import {
  clients,
  scheduledMeetings,
  threadAssignmentNotifications,
  threadAssignments,
  threadNotes,
  twilioCalls,
  users,
} from "@shared/schema";

function dedupe(ids: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (id && typeof id === "string" && id.trim()) out.add(id);
  }
  return Array.from(out);
}

/** The account manager (`clients.ownerId`) responsible for a client. */
export async function getClientAccountManagers(
  clientId: string | null | undefined,
): Promise<string[]> {
  if (!clientId) return [];
  try {
    const rows = await getDb()
      .select({ ownerId: clients.ownerId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return dedupe(rows.map((r) => r.ownerId));
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getClientAccountManagers(${clientId}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Tasks #3693/#3694 — director-level+ users (assigned authority `director`
 *  or `ceo`, including the legacy `role` bridge `getAssignedAuthority`
 *  applies for pre-backfill CEOs). Uses ASSIGNED authority on purpose:
 *  recipient resolution must reflect real seniority, and permissive mode
 *  only lifts core→lead so it can never inflate this list either way.
 *  Team leads are deliberately excluded — this mirrors the Churn Command
 *  Center gate (authorityAtLeast(user, "director")), so director-scoped
 *  fan-outs (client risk-shift alerts, the weekly aging asks & promises
 *  digest) never reach wider than the pages they deep-link to. */
export async function getDirectorPlusUsers(): Promise<string[]> {
  try {
    const rows = await withDbAttribution("notifications:getDirectorPlusUsers", () =>
      getDb()
        .select({
          id: users.id,
          functions: users.functions,
          authorityLevel: users.authorityLevel,
          role: users.role,
        })
        .from(users),
    );
    return dedupe(
      rows
        .filter((r) => {
          const authority = getAssignedAuthority(r);
          return authority === "director" || authority === "ceo";
        })
        .map((r) => r.id),
    );
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getDirectorPlusUsers() failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Returns the user currently assigned to a Conversation Hub thread,
 *  or [] if the thread is unassigned. */
export async function getAssignedUserForThread(
  threadKey: string | null | undefined,
): Promise<string[]> {
  if (!threadKey) return [];
  try {
    const rows = await getDb()
      .select({ uid: threadAssignments.assignedToUserId })
      .from(threadAssignments)
      .where(eq(threadAssignments.threadKey, threadKey))
      .limit(1);
    return dedupe(rows.map((r) => r.uid));
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getAssignedUserForThread(${threadKey}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Conversation owners = thread assignee ∪ client account manager.
 *  For an unmatched thread (no client), this collapses to just the
 *  assignee. */
export async function getConversationOwners(args: {
  threadKey?: string | null;
  clientId?: string | null;
}): Promise<string[]> {
  const [assignees, ams] = await Promise.all([
    getAssignedUserForThread(args.threadKey),
    getClientAccountManagers(args.clientId),
  ]);
  return dedupe([...assignees, ...ams]);
}

/** Host of a booking (the account manager who owns the meeting). */
export async function getBookingHost(
  meetingId: string | null | undefined,
): Promise<string[]> {
  if (!meetingId) return [];
  try {
    const rows = await getDb()
      .select({ uid: scheduledMeetings.accountManagerUserId })
      .from(scheduledMeetings)
      .where(eq(scheduledMeetings.id, meetingId))
      .limit(1);
    return dedupe(rows.map((r) => r.uid));
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getBookingHost(${meetingId}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** For an inbound call: the user the routing chain ended at
 *  (`twilio_calls.routedToUserId`). Falls back to the client AM if no
 *  rep answered. */
export async function getRoutedCallUser(args: {
  callSid?: string | null;
  callId?: string | null;
  clientId?: string | null;
}): Promise<string[]> {
  try {
    let row: { routedToUserId: string | null; clientId: string | null } | undefined;
    if (args.callId) {
      const rows = await getDb()
        .select({
          routedToUserId: twilioCalls.routedToUserId,
          clientId: twilioCalls.clientId,
        })
        .from(twilioCalls)
        .where(eq(twilioCalls.id, args.callId))
        .limit(1);
      row = rows[0];
    } else if (args.callSid) {
      const rows = await getDb()
        .select({
          routedToUserId: twilioCalls.routedToUserId,
          clientId: twilioCalls.clientId,
        })
        .from(twilioCalls)
        .where(eq(twilioCalls.twilioSid, args.callSid))
        .limit(1);
      row = rows[0];
    }
    if (row?.routedToUserId) return [row.routedToUserId];
    const fallbackClient = row?.clientId ?? args.clientId ?? null;
    return getClientAccountManagers(fallbackClient);
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getRoutedCallUser failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Admins responsible for queue / health / system alerts.
 *  Today that's any user with role `ceo` or `team_lead` (the legacy
 *  bridge column populated by Task #1758's authority-level derivation). */
export async function getResponsibleAdminsForAlert(): Promise<string[]> {
  try {
    const rows = await getDb()
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(inArray(users.role, ["ceo", "team_lead"]));
    return dedupe(rows.map((r) => r.id));
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getResponsibleAdminsForAlert failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Task #1758 — Returns user IDs of everyone whose ASSIGNED function
 *  list covers `functionName`. `revenue_engineer` implicitly covers
 *  marketing/intake/sales engineering (see `expandFunctions()`), so
 *  asking for `sales_engineer` also returns any revenue_engineer user.
 *
 *  IMPORTANT — reads ASSIGNED functions, not effective functions. Under
 *  permissive mode (`role_permissions_permissive_mode = "true"`), every
 *  authenticated user is *effectively* every function for permission
 *  purposes, but notification routing must stay narrow — otherwise
 *  flipping permissive mode on would spam every function-targeted
 *  notification to every user. Do NOT "fix" this by switching to
 *  `getEffectiveFunctions()`. */
export async function byFunction(
  functionName: string | null | undefined,
): Promise<string[]> {
  if (!functionName) return [];
  try {
    // The premium `revenue_engineer` role implicitly covers
    // marketing/intake/sales engineering, so a query for any of those
    // three must also include `revenue_engineer` users.
    const targets = new Set<string>([functionName]);
    if (
      functionName === "marketing_engineer" ||
      functionName === "intake_engineer" ||
      functionName === "sales_engineer"
    ) {
      targets.add("revenue_engineer");
    }
    const rows = await withDbAttribution(
      "recipients:byFunction",
      () =>
        getDb()
          .select({ id: users.id, functions: users.functions })
          .from(users),
    );
    const matched: string[] = [];
    for (const r of rows) {
      const fns = (r.functions ?? []) as string[];
      if (fns.some((f) => targets.has(f))) matched.push(r.id);
    }
    return dedupe(matched);
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] byFunction(${functionName}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Parse `@first.last` / `@username` style mentions from free-text and
 *  resolve to user IDs by matching against `users.email` local-part or
 *  display name. Stays best-effort: an unknown mention just returns no
 *  user. */
const MENTION_REGEX = /@([a-zA-Z0-9._-]{2,64})/g;

export async function resolveMentionsToUserIds(
  body: string | null | undefined,
): Promise<string[]> {
  if (!body) return [];
  const handles = new Set<string>();
  for (const m of body.matchAll(MENTION_REGEX)) {
    handles.add(m[1].toLowerCase());
  }
  if (handles.size === 0) return [];
  try {
    const rows = await getDb()
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(isNotNull(users.email));
    const matched: string[] = [];
    for (const u of rows) {
      const localPart = (u.email || "").split("@")[0]?.toLowerCase() || "";
      const handle = [u.firstName, u.lastName]
        .filter(Boolean)
        .join(".")
        .toLowerCase();
      const first = (u.firstName || "").toLowerCase();
      if (
        handles.has(localPart) ||
        (handle && handles.has(handle)) ||
        (first && handles.has(first))
      ) {
        matched.push(u.id);
      }
    }
    return dedupe(matched);
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] resolveMentionsToUserIds failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Task #1703 — Returns user IDs of teammates who have previously
 *  engaged with a conversation thread: prior note authors, anyone who
 *  has ever been assigned to the thread (current or historical), and
 *  the current assignee. Used to fan out a "teammate replied" inbox
 *  ping when someone posts to a thread other teammates were watching.
 *
 *  Best-effort: returns [] on any DB failure so the primary reply
 *  handler is never blocked.
 */
export async function getThreadParticipants(
  threadKey: string | null | undefined,
): Promise<string[]> {
  if (!threadKey) return [];
  try {
    const dbi = getDb();
    const [noteAuthors, assignmentHistory, currentAssignment] = await Promise.all([
      dbi
        .selectDistinct({ uid: threadNotes.createdByUserId })
        .from(threadNotes)
        .where(eq(threadNotes.threadKey, threadKey)),
      dbi
        .selectDistinct({ uid: threadAssignmentNotifications.userId })
        .from(threadAssignmentNotifications)
        .where(eq(threadAssignmentNotifications.threadKey, threadKey)),
      dbi
        .select({ uid: threadAssignments.assignedToUserId })
        .from(threadAssignments)
        .where(eq(threadAssignments.threadKey, threadKey))
        .limit(1),
    ]);
    return dedupe([
      ...noteAuthors.map((r) => r.uid),
      ...assignmentHistory.map((r) => r.uid),
      ...currentAssignment.map((r) => r.uid),
    ]);
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getThreadParticipants(${threadKey}) failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Task #3695 — every non-deleted user at director+ authority
 * (`authority_level` director/ceo, plus the legacy role-"ceo" bridge).
 * Mirrors the audience `canAccessChurnCommandCenter` admits, so
 * going-quiet alerts land exactly with the people who can open the tab.
 */
export async function getDirectorPlusUserIds(): Promise<string[]> {
  try {
    const rows = await withDbAttribution("userNotifications:recipients:directorPlus", () =>
      getDb()
        .select({ uid: users.id })
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            or(
              inArray(users.authorityLevel, ["director", "ceo"]),
              eq(users.role, "ceo"),
            ),
          ),
        ),
    );
    return dedupe(rows.map((r) => r.uid));
  } catch (err: any) {
    console.warn(
      `[notifications/recipients] getDirectorPlusUserIds failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

/** Filter `actorUserId` out of a recipient list — we never notify a
 *  user about an action they themselves just took. */
export function excludeActor(
  recipients: string[],
  actorUserId: string | null | undefined,
): string[] {
  if (!actorUserId) return recipients;
  return recipients.filter((id) => id !== actorUserId);
}
