/**
 * Task #4308 — pure deep-link resolution for the Conversation Hub.
 *
 * The Hub is deep-linked from every profile surface via the canonical
 * builder in `contactHubUrl.ts` (client profile header quick actions,
 * Command Panel client-info phone, contact rows, Comms tab). This module is
 * the CONSUMER side of that contract: given the URL search string and the
 * loaded thread list, decide what the Hub should do. It is deliberately
 * dependency-free so `tests/conversation-hub-deep-link.test.ts` can pin the
 * behavior without mounting the (very large) hub page.
 *
 * ConversationHub.tsx's deep-link effect delegates all decision logic here;
 * keep the two in lockstep with `buildContactHubUrl` param names.
 */

/** Every query param the deep-link contract consumes (and strips from the
 * URL after applying, so back-nav/reload doesn't re-trigger). */
export const DEEP_LINK_PARAM_KEYS = [
  "threadKey",
  "convId",
  "phone",
  "contactName",
  "clientId",
  "intent",
] as const;

/** Minimal thread shape the resolver needs (subset of UnifiedThread). */
export interface DeepLinkThread {
  key: string;
  isGroup: boolean;
  contactPhone: string | null;
  smsConversationIds: string[];
}

/**
 * Phone-match normalization: last 10 digits, mirroring
 * `phoneDedupeKey` in contactHubUrl.ts. "+1 (555) 123-4567" and
 * "5551234567" are the same thread.
 */
export function normalizeDeepLinkPhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export type DeepLinkPlan =
  /** No deep-link params present — mark consumed, change nothing. */
  | { kind: "none" }
  /** Thread-matching params present but the conversations query hasn't
   * resolved yet — do nothing and re-run once it has. */
  | { kind: "wait" }
  /** A thread matched — select it; openDialer for intent=call. */
  | { kind: "select-thread"; threadKey: string; openDialer: boolean }
  /** No thread matched, intent=call with a phone — open the dialer pre-filled. */
  | { kind: "dial"; phone: string }
  /** Open compose pre-filled (phone-no-match message intent, or clientId-only). */
  | { kind: "compose"; phone: string | null; clientId: string | null }
  /** Deep-link params were present but unmatched with nothing to prefill
   * (stale threadKey/convId, no phone, no clientId): strip the params from
   * the URL but change no Hub state. */
  | { kind: "consumed" };

/**
 * Decide what the Hub should do for the given URL search string.
 *
 * Matching precedence: threadKey → convId → phone (last-10-digit,
 * group threads excluded). Loading gate: thread-matching params wait for
 * the conversations query to have resolved at least once (so a
 * loaded-but-empty inbox still falls through to compose/dial); a
 * clientId-only link proceeds immediately.
 */
export function resolveDeepLink(
  searchString: string,
  threads: readonly DeepLinkThread[],
  conversationsLoaded: boolean,
): DeepLinkPlan {
  const params = new URLSearchParams(searchString);
  const paramThreadKey = params.get("threadKey");
  const paramConvId = params.get("convId");
  const paramPhone = params.get("phone");
  const paramClientId = params.get("clientId");
  const paramIntent = params.get("intent") || "message";

  const hasDeepLink = !!(paramThreadKey || paramConvId || paramPhone || paramClientId);
  if (!hasDeepLink) return { kind: "none" };

  const needsThreadMatch = !!(paramThreadKey || paramConvId || paramPhone);
  if (needsThreadMatch && !conversationsLoaded) return { kind: "wait" };

  let target: DeepLinkThread | null = null;
  if (paramThreadKey) {
    target = threads.find((t) => t.key === paramThreadKey) ?? null;
  }
  if (!target && paramConvId) {
    target = threads.find((t) => t.smsConversationIds.includes(paramConvId)) ?? null;
  }
  if (!target && paramPhone) {
    const phoneNorm = normalizeDeepLinkPhone(paramPhone);
    target = threads.find((t) => {
      if (t.isGroup) return false;
      return normalizeDeepLinkPhone(t.contactPhone || "") === phoneNorm;
    }) ?? null;
  }

  if (target) {
    return {
      kind: "select-thread",
      threadKey: target.key,
      openDialer: paramIntent === "call",
    };
  }
  if (paramPhone) {
    if (paramIntent === "call") return { kind: "dial", phone: paramPhone };
    return { kind: "compose", phone: paramPhone, clientId: paramClientId };
  }
  if (paramClientId) {
    // clientId (no phone): open compose with the client pre-selected.
    return { kind: "compose", phone: null, clientId: paramClientId };
  }
  // Stale threadKey/convId with nothing to prefill: consume (strip URL) but
  // leave the Hub exactly as it is — never surprise-open the composer.
  return { kind: "consumed" };
}
