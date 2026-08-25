import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// ─── Task #1758 — Function + Authority framework ────────────────────────
//
// `users.role` is a flat enum (sales | account_manager | team_lead | ceo)
// that conflates *function* (what kind of work someone does) with
// *authority* (their decision-making level). Task #1758 splits this into
// two independent axes while preserving `users.role` as a backward-compat
// bridge derived from `authorityLevel` at write time. New code reads
// `functions` + `authorityLevel`; legacy code can still read `role`
// until a future task removes it.
export const userFunctions = [
  "marketing_engineer",
  "intake_engineer",
  "sales_engineer",
  "revenue_engineer",
  "gbp_expert",
  "google_ads_expert",
  "webinar_expert",
  "reporting_expert",
] as const;
export type UserFunction = (typeof userFunctions)[number];

export const userAuthorityLevels = ["core", "lead", "director", "ceo"] as const;
export type UserAuthorityLevel = (typeof userAuthorityLevels)[number];

export const userFunctionSchema = z.enum(userFunctions);
export const userAuthorityLevelSchema = z.enum(userAuthorityLevels);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  // Task #1758: preserved as legacy bridge — derived from authorityLevel
  // on write (see updateUserRoleProfile in server/storage/clientStorage.ts).
  // New code SHOULD NOT read this column — use getEffectiveAuthority()
  // from server/auth/permissions.ts instead.
  role: varchar("role").default("account_manager"),
  // Task #1758: assigned profile (organizational identity). Used for
  // display, notification routing, and (later) RIS assignment. Does NOT
  // gate access on its own — see getEffectiveFunctions/Authority for
  // gating, which honors role_permissions_permissive_mode.
  functions: text("functions").array().default(sql`'{}'::text[]`),
  authorityLevel: varchar("authority_level").default("core"),
  callerIdName: varchar("caller_id_name"),
  smsSignOff: text("sms_sign_off"),
  callRoutingPhone: varchar("call_routing_phone"),
  callMode: varchar("call_mode").default("browser"),
  timezone: varchar("timezone"),
  displayTimezoneSource: varchar("display_timezone_source"),
  // Task #4377 — app-wide dark mode. Per-user theme preference:
  // 'light' | 'dark' | 'system'. Written only via PUT /api/users/me/theme;
  // read by the client ThemeProvider from the /api/auth/user payload.
  themePreference: varchar("theme_preference").default("system"),
  zoomHostOverrideEmail: varchar("zoom_host_override_email"),
  zoomHostOverrideUserId: varchar("zoom_host_override_user_id"),
  zoomHostOverrideValidatedAt: timestamp("zoom_host_override_validated_at"),
  zoomHostOverrideValidatedEmail: varchar("zoom_host_override_validated_email"),
  zoomHostOverrideDisplayName: varchar("zoom_host_override_display_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  // Task #1866 — soft-delete / revocation marker. When set the user is
  // treated as gone everywhere: hidden from getAllUsers/getUser,
  // rejected at the OIDC verify callback, and their sessions are
  // purged from the session store. See migration 0077.
  deletedAt: timestamp("deleted_at"),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// Update-side schema for the User Management form (Task #1758). Both
// fields are validated against their enums; functions is optional and
// defaults to [].
export const updateUserRoleProfileSchema = z.object({
  functions: z.array(userFunctionSchema).default([]),
  authorityLevel: userAuthorityLevelSchema,
});
export type UpdateUserRoleProfile = z.infer<typeof updateUserRoleProfileSchema>;

// Task #4554 — closed admission. Admins APPROVE a person by pre-creating
// their users row (email + role profile) before that person's first
// sign-in; the auth middleware admits a new Clerk identity only when its
// verified email matches such a row. Email is normalized (trim +
// lowercase) here so storage and the admission match share one canonical
// form. Names are optional — Clerk profile data can fill them later.
export const approveUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  functions: z.array(userFunctionSchema).default([]),
  authorityLevel: userAuthorityLevelSchema.default("core"),
});
export type ApproveUser = z.infer<typeof approveUserSchema>;
