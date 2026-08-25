/**
 * Default channels on user creation (Task #3308, COMMS_PARITY gap #2).
 *
 * A team-lead-configurable list of "default channels" is stored in
 * `system_settings` under `comms_default_channel_ids` (JSON array of
 * channel UUIDs). When a brand-new user account is created (first OIDC
 * login upsert or the orphaned-user heal), the user is automatically
 * added as a plain member of every default channel.
 *
 * Rules:
 *  - Only affects NEW users at creation time. Existing users are never
 *    retroactively added when the list changes.
 *  - Membership insert is idempotent (`addChannelMember` uses
 *    ON CONFLICT DO NOTHING), so a create-race double-fire is harmless.
 *  - Fail-open: auto-join must NEVER block or fail account creation /
 *    login. Every error is logged and swallowed.
 *  - Archived channels and client-bound channels in the list are
 *    skipped at join time (they stay in the list so unarchiving a
 *    channel restores its default behavior).
 */

import {
  getSystemSetting,
  setSystemSetting,
} from "../storage/settingsStorage";
import * as commsStorage from "../storage/commsStorage";
import { getAllUsers } from "../storage/clientStorage";
import { insertActivityLogs } from "../storage/activityStorage";

export const DEFAULT_CHANNELS_SETTING_KEY = "comms_default_channel_ids";

/** Max number of default channels — sanity cap, not a product limit. */
export const MAX_DEFAULT_CHANNELS = 50;

/**
 * Read the configured default channel ID list. Returns [] when the
 * setting is missing or unparseable (fail-open: a corrupt setting must
 * not break login).
 */
export async function getDefaultChannelIds(): Promise<string[]> {
  try {
    const row = await getSystemSetting(DEFAULT_CHANNELS_SETTING_KEY);
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch (err) {
    console.error(
      "[CommsDefaultChannels] Failed to read default channel list (fail-open, treating as empty):",
      err,
    );
    return [];
  }
}

/**
 * Persist the default channel ID list. Caller is responsible for
 * authorization and for validating that the IDs are real, non-client,
 * standard channels (the route does this).
 */
export async function setDefaultChannelIds(
  channelIds: string[],
  updatedBy?: string,
): Promise<void> {
  const deduped = Array.from(new Set(channelIds));
  await setSystemSetting(
    DEFAULT_CHANNELS_SETTING_KEY,
    JSON.stringify(deduped),
    updatedBy,
  );
}

export interface AutoJoinResult {
  joined: string[];
  skipped: Array<{ channelId: string; reason: string }>;
}

/**
 * Add a newly created user to every configured default channel.
 * Idempotent and fail-open — never throws.
 */
export async function autoJoinDefaultChannels(
  userId: string,
): Promise<AutoJoinResult> {
  const result: AutoJoinResult = { joined: [], skipped: [] };
  if (!userId) return result;
  let channelIds: string[] = [];
  try {
    channelIds = await getDefaultChannelIds();
  } catch {
    return result; // getDefaultChannelIds already logs; belt-and-braces
  }
  for (const channelId of channelIds) {
    try {
      const channel = await commsStorage.getChannelById(channelId);
      if (!channel) {
        result.skipped.push({ channelId, reason: "not_found" });
        continue;
      }
      if (channel.archivedAt) {
        result.skipped.push({ channelId, reason: "archived" });
        continue;
      }
      if (channel.clientId) {
        result.skipped.push({ channelId, reason: "client_channel" });
        continue;
      }
      if (channel.type !== "channel") {
        result.skipped.push({ channelId, reason: "not_standard_channel" });
        continue;
      }
      await commsStorage.addChannelMember(channelId, userId, "member");
      result.joined.push(channelId);
    } catch (err) {
      result.skipped.push({ channelId, reason: "error" });
      console.error(
        `[CommsDefaultChannels] Auto-join failed for user ${userId} channel ${channelId} (fail-open):`,
        err,
      );
    }
  }
  if (result.joined.length > 0) {
    console.log(
      `[CommsDefaultChannels] Auto-joined new user ${userId} to ${result.joined.length} default channel(s)`,
    );
  }
  return result;
}

export interface ApplyToExistingUsersResult {
  usersProcessed: number;
  membershipsAdded: number;
  alreadyMembers: number;
  channelsApplied: Array<{ channelId: string; added: number }>;
  channelsSkipped: Array<{ channelId: string; reason: string }>;
}

/**
 * Task #3324 — bulk-join EXISTING users to the currently configured
 * default channels. This is the admin-triggered counterpart to
 * `autoJoinDefaultChannels` (which only fires at account creation).
 *
 * Rules:
 *  - Idempotent: users already in a channel are left untouched
 *    (`addChannelMember` is ON CONFLICT DO NOTHING; we also pre-check
 *    membership so counts are accurate and we skip needless writes).
 *  - Same channel eligibility as auto-join: archived, client-bound, and
 *    non-standard channels are skipped.
 *  - Only non-deleted users are considered (`getAllUsers` filters
 *    soft-deleted rows). When `userIds` is provided, it is intersected
 *    with that active-user set.
 *  - Audit-logged to `user_activity_logs` under
 *    `comms_default_channels_applied_to_existing`.
 *
 * Unlike auto-join, this THROWS on unexpected failure — it's an explicit
 * admin action, so the operator should see the error.
 */
export async function applyDefaultChannelsToExistingUsers(
  actorUserId: string,
  userIds?: string[],
): Promise<ApplyToExistingUsersResult> {
  const result: ApplyToExistingUsersResult = {
    usersProcessed: 0,
    membershipsAdded: 0,
    alreadyMembers: 0,
    channelsApplied: [],
    channelsSkipped: [],
  };

  const channelIds = await getDefaultChannelIds();

  const allUsers = await getAllUsers();
  // undefined = "all users"; a provided array (even empty) is an explicit
  // selection — an empty selection targets NOBODY, never everyone.
  const requested = userIds !== undefined ? new Set(userIds) : null;
  const targetUsers = requested
    ? allUsers.filter((u) => requested.has(u.id))
    : allUsers;
  result.usersProcessed = targetUsers.length;

  for (const channelId of channelIds) {
    const channel = await commsStorage.getChannelById(channelId);
    if (!channel) {
      result.channelsSkipped.push({ channelId, reason: "not_found" });
      continue;
    }
    if (channel.archivedAt) {
      result.channelsSkipped.push({ channelId, reason: "archived" });
      continue;
    }
    if (channel.clientId) {
      result.channelsSkipped.push({ channelId, reason: "client_channel" });
      continue;
    }
    if (channel.type !== "channel") {
      result.channelsSkipped.push({ channelId, reason: "not_standard_channel" });
      continue;
    }

    const existingMembers = await commsStorage.getChannelMembers(channelId);
    const memberIds = new Set(existingMembers.map((m) => m.userId));

    let added = 0;
    for (const user of targetUsers) {
      if (memberIds.has(user.id)) {
        result.alreadyMembers++;
        continue;
      }
      await commsStorage.addChannelMember(channelId, user.id, "member");
      added++;
    }
    result.membershipsAdded += added;
    result.channelsApplied.push({ channelId, added });
  }

  try {
    await insertActivityLogs([
      {
        userId: actorUserId,
        actionType: "comms_default_channels_applied_to_existing",
        actionDetail: `Applied default channels to ${result.usersProcessed} existing user(s): ${result.membershipsAdded} membership(s) added, ${result.alreadyMembers} already members`,
        metadata: {
          usersProcessed: result.usersProcessed,
          membershipsAdded: result.membershipsAdded,
          alreadyMembers: result.alreadyMembers,
          channelsApplied: result.channelsApplied,
          channelsSkipped: result.channelsSkipped,
          selectedUserIds: requested ? Array.from(requested) : null,
        },
      },
    ]);
  } catch (err) {
    // Audit failure must not un-do the (already committed) joins; log loudly.
    console.error(
      "[CommsDefaultChannels] Failed to write audit log for apply-to-existing:",
      err,
    );
  }

  console.log(
    `[CommsDefaultChannels] Applied default channels to existing users by ${actorUserId}: ${result.membershipsAdded} added across ${result.channelsApplied.length} channel(s)`,
  );
  return result;
}
