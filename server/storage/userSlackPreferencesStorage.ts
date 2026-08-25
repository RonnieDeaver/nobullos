// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1687 — storage for per-user Slack DM identities + notification
 * preferences. Mirrors the `ensureNotificationTables()` pattern used by
 * notificationsStorage.ts so tests that boot without running migrations
 * still get the tables in place.
 *
 * In-app behavior NEVER depends on these tables: a missing identity or
 * a missing preference row falls back to "in-app only" and the
 * sendSlackDmToUser path no-ops. Slack failures live entirely in
 * `last_dm_status` / `last_dm_error`.
 */

import { getDb } from "../db";
import { and, eq, sql } from "drizzle-orm";
import {
  userSlackIdentities,
  userNotificationPreferences,
  userNotificationCategories,
  type UserSlackIdentity,
  type UserNotificationPreference,
  type UserNotificationCategory,
} from "@shared/schema";

let tablesEnsured = false;

export async function ensureUserSlackPreferenceTables(): Promise<void> {
  if (tablesEnsured) return;
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_slack_identities (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      slack_user_id varchar NOT NULL,
      slack_team_id varchar,
      slack_email varchar,
      connected_at timestamp NOT NULL DEFAULT now(),
      disconnected_at timestamp,
      last_dm_status varchar,
      last_dm_error text,
      last_dm_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_slack_identities_user_idx ON user_slack_identities (user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_slack_identities_slack_user_idx ON user_slack_identities (slack_user_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category varchar NOT NULL,
      in_app_enabled boolean NOT NULL DEFAULT true,
      slack_dm_enabled boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS user_notification_prefs_user_category_uniq
      ON user_notification_preferences (user_id, category)
  `);
  tablesEnsured = true;
}

export function __resetUserSlackPrefsEnsureCacheForTests(): void {
  tablesEnsured = false;
}

// ─── identities ────────────────────────────────────────────────────────

export async function getUserSlackIdentity(
  userId: string,
): Promise<UserSlackIdentity | undefined> {
  await ensureUserSlackPreferenceTables();
  const [row] = await getDb()
    .select()
    .from(userSlackIdentities)
    .where(eq(userSlackIdentities.userId, userId))
    .limit(1);
  return row;
}

export async function upsertUserSlackIdentity(params: {
  userId: string;
  slackUserId: string;
  slackTeamId?: string | null;
  slackEmail?: string | null;
}): Promise<UserSlackIdentity> {
  await ensureUserSlackPreferenceTables();
  const db = getDb();
  const existing = await getUserSlackIdentity(params.userId);
  if (existing) {
    const [updated] = await db
      .update(userSlackIdentities)
      .set({
        slackUserId: params.slackUserId,
        slackTeamId: params.slackTeamId ?? existing.slackTeamId,
        slackEmail: params.slackEmail ?? existing.slackEmail,
        connectedAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(userSlackIdentities.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(userSlackIdentities)
    .values({
      userId: params.userId,
      slackUserId: params.slackUserId,
      slackTeamId: params.slackTeamId ?? null,
      slackEmail: params.slackEmail ?? null,
    })
    .returning();
  return created;
}

export async function disconnectUserSlackIdentity(
  userId: string,
): Promise<void> {
  await ensureUserSlackPreferenceTables();
  await getDb()
    .update(userSlackIdentities)
    .set({ disconnectedAt: new Date(), updatedAt: new Date() })
    .where(eq(userSlackIdentities.userId, userId));
}

export async function recordUserSlackDmAttempt(params: {
  userId: string;
  status: string;
  error?: string | null;
}): Promise<void> {
  await ensureUserSlackPreferenceTables();
  await getDb()
    .update(userSlackIdentities)
    .set({
      lastDmStatus: params.status,
      lastDmError: params.error ?? null,
      lastDmAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userSlackIdentities.userId, params.userId));
}

export async function listUserSlackIdentitiesAdmin(): Promise<
  UserSlackIdentity[]
> {
  await ensureUserSlackPreferenceTables();
  return getDb()
    .select()
    .from(userSlackIdentities)
    .orderBy(sql`connected_at DESC`);
}

// ─── preferences ───────────────────────────────────────────────────────

export interface PreferenceRow {
  category: UserNotificationCategory;
  inAppEnabled: boolean;
  slackDmEnabled: boolean;
}

const DEFAULT_IN_APP = true;
const DEFAULT_SLACK_DM = false;

export async function getUserNotificationPreferences(
  userId: string,
): Promise<PreferenceRow[]> {
  await ensureUserSlackPreferenceTables();
  const existing = await getDb()
    .select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId));
  const byCategory = new Map<string, UserNotificationPreference>();
  for (const row of existing) byCategory.set(row.category, row);
  return userNotificationCategories.map((category) => {
    const r = byCategory.get(category);
    return {
      category,
      inAppEnabled: r ? r.inAppEnabled : DEFAULT_IN_APP,
      slackDmEnabled: r ? r.slackDmEnabled : DEFAULT_SLACK_DM,
    };
  });
}

export async function getUserPreferenceForCategory(params: {
  userId: string;
  category: string;
}): Promise<PreferenceRow> {
  await ensureUserSlackPreferenceTables();
  const [row] = await getDb()
    .select()
    .from(userNotificationPreferences)
    .where(
      and(
        eq(userNotificationPreferences.userId, params.userId),
        eq(userNotificationPreferences.category, params.category),
      ),
    )
    .limit(1);
  return {
    category: params.category as UserNotificationCategory,
    inAppEnabled: row ? row.inAppEnabled : DEFAULT_IN_APP,
    slackDmEnabled: row ? row.slackDmEnabled : DEFAULT_SLACK_DM,
  };
}

export async function upsertUserNotificationPreference(params: {
  userId: string;
  category: string;
  inAppEnabled: boolean;
  slackDmEnabled: boolean;
}): Promise<PreferenceRow> {
  await ensureUserSlackPreferenceTables();
  const db = getDb();
  await db.execute(sql`
    INSERT INTO user_notification_preferences (user_id, category, in_app_enabled, slack_dm_enabled)
    VALUES (${params.userId}, ${params.category}, ${params.inAppEnabled}, ${params.slackDmEnabled})
    ON CONFLICT (user_id, category) DO UPDATE
      SET in_app_enabled = EXCLUDED.in_app_enabled,
          slack_dm_enabled = EXCLUDED.slack_dm_enabled,
          updated_at = now()
  `);
  const stored = await getUserPreferenceForCategory({
    userId: params.userId,
    category: params.category,
  });
  return stored;
}
