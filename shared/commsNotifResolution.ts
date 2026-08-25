/**
 * Comms notification resolution — pure, testable rule engine.
 * Lives in shared/ so both the server (badge counts) and the client
 * (desktop notifications, sound) can consume it without duplication.
 *
 * Effective-notification resolution order (highest priority wins):
 *   1. DND active            → suppress
 *   2. Channel muted         → suppress
 *   3. Channel pref = mentions AND message NOT a mention/keyword → quiet
 *   4. Channel pref = all    → fall through to global default
 *   5. Global default = nothing → suppress
 *   6. Global default = mentions AND NOT mention/keyword → quiet
 *   7. Otherwise             → notify
 *
 * "quiet"    = increment unread badge only, no desktop notification or sound.
 * "suppress" = no badge increment for the channel (muted behaviour).
 * "notify"   = show desktop notification + play sound.
 */

export type NotifDecision = "notify" | "quiet" | "suppress";

export interface NotifResolutionInput {
  /** Per-channel preference: "all" | "mentions" | "muted". Null = no override (use global). */
  channelPref: "all" | "mentions" | "muted" | null;
  /** Global default preference from comms_user_notification_settings. */
  globalDefault: "all" | "mentions" | "nothing";
  /** Whether DND is currently active for this user. */
  isDndActive: boolean;
  /** Whether this message is a direct @mention of the user OR a keyword match. */
  isMentionOrKeyword: boolean;
  /** Whether the channel is a DM or group DM (all messages count as mentions). */
  isDmChannel: boolean;
}

/**
 * Returns the effective notification decision for a single user/channel/message triple.
 * This is the single source of truth consumed by both the client (desktop alerts)
 * and the server (unread count and keyword badge logic).
 */
export function resolveEffectiveNotifDecision(input: NotifResolutionInput): NotifDecision {
  const { channelPref, globalDefault, isDndActive, isMentionOrKeyword, isDmChannel } = input;

  // DMs treat every message as a mention
  const effectiveMention = isMentionOrKeyword || isDmChannel;

  // 1. DND suppresses ALL desktop notifications and sounds
  if (isDndActive) return "suppress";

  // 2. Channel explicitly muted
  if (channelPref === "muted") return "suppress";

  // 3. Per-channel override takes precedence over global default
  if (channelPref === "mentions") {
    return effectiveMention ? "notify" : "quiet";
  }

  // 4. DMs and group DMs always notify (every message is treated as a direct
  //    mention) unless muted or DND — even when the global default is "nothing".
  if (isDmChannel) return "notify";

  // 5. No per-channel override (channelPref === "all" or null) → fall through to global
  if (globalDefault === "nothing") return "suppress";
  if (globalDefault === "mentions") {
    return effectiveMention ? "notify" : "quiet";
  }

  // globalDefault === "all"
  return "notify";
}

/** Returns true if content contains a word-boundary match for any of the given keywords. */
export function contentMatchesKeywords(
  content: string | null | undefined,
  keywords: string[],
): boolean {
  if (!content || keywords.length === 0) return false;
  const lower = content.toLowerCase();
  for (const kw of keywords) {
    if (!kw.trim()) continue;
    const escaped = kw.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

/**
 * Returns the subset of keywords that word-boundary match the content.
 * Same matching semantics as contentMatchesKeywords — keep the two in lockstep.
 */
export function getMatchedKeywords(content: string, keywords: string[]): string[] {
  if (!content || keywords.length === 0) return [];
  const matched: string[] = [];
  for (const kw of keywords) {
    if (!kw.trim()) continue;
    const escaped = kw.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, "i");
    if (re.test(content)) matched.push(kw.trim());
  }
  return matched;
}
