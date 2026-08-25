// Task #877: lightweight in-memory presence tracker for users whose Twilio
// Voice JS SDK device is registered and ready to receive an incoming call.
//
// The browser hook (`useTwilioDevice`) POSTs `/api/twilio/voice-presence`
// every PRESENCE_HEARTBEAT_MS while the device is `ready` and POSTs an
// explicit offline beacon on teardown / page unload. Each heartbeat extends
// the user's TTL so a crashed/closed tab naturally falls out of the set
// after PRESENCE_TTL_MS without an explicit offline ping.
//
// Inbound voice routing consults `isUserBrowserOnline` to decide whether
// to dial `<Client>${userId}</Client>` (route to the browser SDK) instead
// of `<Number>${callRoutingPhone}</Number>` (legacy forward-to-cell). If
// the browser doesn't pick up, the existing `voice-routing-callback`
// retry chain advances to the next tier as before — the forward-to-cell
// fallback is preserved end-to-end.

const PRESENCE_TTL_MS = 75_000;

const presenceMap = new Map<string, number>();

export const PRESENCE_HEARTBEAT_MS = 30_000;

export function markUserBrowserOnline(userId: string): void {
  if (!userId) return;
  presenceMap.set(userId, Date.now() + PRESENCE_TTL_MS);
}

export function markUserBrowserOffline(userId: string): void {
  if (!userId) return;
  presenceMap.delete(userId);
}

export function isUserBrowserOnline(userId: string): boolean {
  if (!userId) return false;
  const expiresAt = presenceMap.get(userId);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    presenceMap.delete(userId);
    return false;
  }
  return true;
}

export function listOnlineUserIds(): string[] {
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
