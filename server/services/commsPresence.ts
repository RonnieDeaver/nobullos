/**
 * NoBull Comms — general online/away presence for internal team chat.
 *
 * Extends the same heartbeat-TTL pattern as browserPresence.ts (Twilio voice)
 * but is scoped to the Comms system. Presence is set when a user opens the
 * Comms SSE stream and cleared when the stream closes. Heartbeats from the
 * client keep the TTL alive.
 *
 * Distinct from the Twilio browser-call presence map to avoid polluting the
 * voice routing logic.
 *
 * Auto-away: if a user's heartbeat TTL expires but they've been active within
 * AUTO_AWAY_WINDOW_MS, they show as "away" rather than "offline". The
 * lastActivityAt timestamp (stored in comms_user_statuses by the routes
 * layer on every heartbeat) is the authoritative record that survives
 * across instances. This in-memory lastSeenMap provides fast sub-DB lookups
 * for the within-instance case only.
 */

const PRESENCE_TTL_MS = 90_000;

export const COMMS_PRESENCE_HEARTBEAT_MS = 30_000;

/** After a heartbeat stops, show the user as "away" for this window. */
export const COMMS_AUTO_AWAY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const presenceMap = new Map<string, number>();

/** Last heartbeat wall-clock time per user (for in-process auto-away reads). */
// @bounded-cache-safe: keyed by userId — internal team only (small bounded set); kept after disconnect intentionally for auto-away window
const lastSeenMap = new Map<string, number>();

export function markCommsUserOnline(userId: string): void {
  if (!userId) return;
  presenceMap.set(userId, Date.now() + PRESENCE_TTL_MS);
  lastSeenMap.set(userId, Date.now());
}

export function markCommsUserOffline(userId: string): void {
  if (!userId) return;
  presenceMap.delete(userId);
}

export function heartbeatCommsUser(userId: string): void {
  if (!userId) return;
  presenceMap.set(userId, Date.now() + PRESENCE_TTL_MS);
  lastSeenMap.set(userId, Date.now());
}

export function isCommsUserOnline(userId: string): boolean {
  if (!userId) return false;
  const expiresAt = presenceMap.get(userId);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    presenceMap.delete(userId);
    return false;
  }
  return true;
}

/**
 * Returns the last heartbeat wall-clock time for a user, or null if unknown
 * for this process. Used to derive the auto-away window without a DB call.
 * The persistent source is comms_user_statuses.last_activity_at.
 */
export function getCommsUserLastSeen(userId: string): number | null {
  return lastSeenMap.get(userId) ?? null;
}

export function listOnlineCommsUserIds(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const [userId, expiresAt] of presenceMap.entries()) {
    if (expiresAt < now) {
      presenceMap.delete(userId);
      continue;
    }
    out.push(userId);
  }
  return out;
}

/**
 * Derives the effective status from heartbeat state and a stored status row.
 * This is a pure helper — no DB access. Routes and storage use it after
 * reading from comms_user_statuses.
 *
 * Precedence:
 *   1. manual=dnd  → "dnd"  (unless DND has expired, then restore priorStatus)
 *   2. manual=offline → "offline"
 *   3. manual=away → "away"
 *   4. manual=online → "online"
 *   5. no manual + heartbeat online → "online"
 *   6. no manual + last seen within AUTO_AWAY_WINDOW → "away"
 *   7. else → "offline"
 */
export function deriveEffectiveStatus(
  stored: {
    manualStatus: string | null | undefined;
    dndExpiresAt: Date | null | undefined;
    priorStatus: string | null | undefined;
    lastActivityAt: Date | null | undefined;
  } | null | undefined,
  isOnlineViaHeartbeat: boolean,
  nowMs: number = Date.now(),
): "online" | "away" | "dnd" | "offline" {
  const manual = stored?.manualStatus ?? null;

  if (manual === "dnd") {
    const exp = stored?.dndExpiresAt;
    if (exp && exp.getTime() <= nowMs) {
      const restored = (stored?.priorStatus as "online" | "away" | "dnd" | "offline" | null) ?? "online";
      return restored === "dnd" ? "online" : restored;
    }
    return "dnd";
  }

  if (manual === "offline") return "offline";
  if (manual === "away") return "away";
  if (manual === "online") return "online";

  if (isOnlineViaHeartbeat) return "online";

  const lastActivity = stored?.lastActivityAt;
  if (lastActivity && nowMs - lastActivity.getTime() < COMMS_AUTO_AWAY_WINDOW_MS) {
    return "away";
  }

  return "offline";
}
