import type { CommsChannel } from "./types";
import { channelDisplayName } from "./helpers";

export const ACTIVE_CLIENT_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export function byChannelRecency(a: CommsChannel, b: CommsChannel): number {
  if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount;
  const aTs = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
  const bTs = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
  if (bTs !== aTs) return bTs - aTs;
  return channelDisplayName(a).localeCompare(channelDisplayName(b));
}

export function groupChannels(
  channels: CommsChannel[],
  pinnedChannelIds: string[],
): { pinnedChannels: CommsChannel[]; recentChannels: CommsChannel[]; clientChannels: CommsChannel[] } {
  const now = Date.now();
  const pinned = channels.filter((c) => pinnedChannelIds.includes(c.id)).sort(byChannelRecency);
  const unpinned = channels.filter((c) => !pinnedChannelIds.includes(c.id));

  const isActiveClient = (c: CommsChannel): boolean => {
    if (c.unreadCount > 0) return true;
    if (!c.lastMessageAt) return false;
    return now - new Date(c.lastMessageAt).getTime() < ACTIVE_CLIENT_THRESHOLD_MS;
  };

  const clientChannels = unpinned.filter(
    (c) => c.type === "channel" && !!c.clientId && !isActiveClient(c),
  ).sort(byChannelRecency);

  const recentChannels = unpinned
    .filter((c) => !(c.type === "channel" && !!c.clientId && !isActiveClient(c)))
    .sort(byChannelRecency);

  return { pinnedChannels: pinned, recentChannels, clientChannels };
}
