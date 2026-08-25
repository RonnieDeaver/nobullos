// @db-pool-intent: ambient
//
// Task #1758: centralized permission helper. Every route/service goes
// here for role-aware decisions. The "function" axis (what kind of work
// someone does) and the "authority" axis (their decision-making level)
// are kept separate. Today every authenticated user gets full
// permissive access (see `role_permissions_permissive_mode` in
// system_settings, default "true"). Tightening permissions later is a
// single flip of that switch — route handlers do not need to change.

import type { User, UserAuthorityLevel, UserFunction } from "@shared/schema";
import { userFunctions } from "@shared/schema";
import { getSystemSetting } from "../storage/settingsStorage";

const PERMISSIVE_MODE_KEY = "role_permissions_permissive_mode";
const PERMISSIVE_MODE_CACHE_TTL_MS = 5_000;

let permissiveModeCache: { value: boolean; expiresAt: number } | null = null;

/** Read the permissive-mode switch with a tiny in-memory TTL. Default
 *  OFF — if the setting is missing or unreadable the system falls back
 *  to strict role-based checks so a missing row is never a privilege
 *  escalation. Set the system_settings key
 *  `role_permissions_permissive_mode` to `"true"` to enable permissive
 *  mode explicitly in environments that need it. */
export async function isPermissiveModeEnabled(): Promise<boolean> {
  const now = Date.now();
  if (permissiveModeCache && permissiveModeCache.expiresAt > now) {
    return permissiveModeCache.value;
  }
  let value = false;
  try {
    const setting = await getSystemSetting(PERMISSIVE_MODE_KEY);
    if (setting?.value === "true") value = true;
  } catch {
    value = false;
  }
  permissiveModeCache = { value, expiresAt: now + PERMISSIVE_MODE_CACHE_TTL_MS };
  return value;
}

/** Test-only: clear the permissive-mode cache so a test that flips the
 *  setting sees the new value immediately. */
export function __resetPermissiveModeCacheForTests(): void {
  permissiveModeCache = null;
}

type UserLike = Pick<User, "functions" | "authorityLevel" | "role"> & {
  id?: string;
};

/** `revenue_engineer` is the premium cross-lane role — anyone assigned
 *  it implicitly covers Marketing/Intake/Sales engineering too. This
 *  helper does that expansion so callers can ask "who covers sales
 *  engineering?" without enumerating both. */
export function expandFunctions(
  fns: ReadonlyArray<string> | null | undefined,
): UserFunction[] {
  const out = new Set<UserFunction>();
  for (const f of fns ?? []) {
    if (!(userFunctions as readonly string[]).includes(f)) continue;
    out.add(f as UserFunction);
    if (f === "revenue_engineer") {
      out.add("marketing_engineer");
      out.add("intake_engineer");
      out.add("sales_engineer");
    }
  }
  return Array.from(out);
}

export function getAssignedFunctions(user: UserLike | null | undefined): UserFunction[] {
  const raw = (user?.functions ?? []) as ReadonlyArray<string>;
  return raw.filter((f): f is UserFunction =>
    (userFunctions as readonly string[]).includes(f),
  );
}

export function getAssignedAuthority(
  user: UserLike | null | undefined,
): UserAuthorityLevel {
  const raw = user?.authorityLevel;
  const fromAuthorityLevel: UserAuthorityLevel | null =
    raw === "core" || raw === "lead" || raw === "director" || raw === "ceo"
      ? raw
      : null;

  // Bridge from legacy `role` for users predating (or skipped by)
  // Task #1758's backfill — e.g. a legacy CEO whose `authority_level`
  // stayed at the column default `core`.
  let fromLegacyRole: UserAuthorityLevel | null = null;
  switch (user?.role) {
    case "ceo":
      fromLegacyRole = "ceo";
      break;
    case "team_lead":
      fromLegacyRole = "lead";
      break;
  }

  // Take the higher of the two so a backfill gap can never silently
  // demote a legacy CEO (or team lead) to "core".
  if (fromAuthorityLevel && fromLegacyRole) {
    return AUTHORITY_RANK[fromAuthorityLevel] >= AUTHORITY_RANK[fromLegacyRole]
      ? fromAuthorityLevel
      : fromLegacyRole;
  }
  return fromAuthorityLevel ?? fromLegacyRole ?? "core";
}

/** Effective functions: under permissive mode every authenticated user
 *  is treated as covering every function (no function-based gates are
 *  enforced). When permissive mode is later flipped off, this returns
 *  the user's assigned function list (with revenue_engineer expanded).
 *
 *  IMPORTANT: notification recipient resolution must NOT use this — see
 *  `byFunction()` in server/services/notifications/recipients.ts. */
export async function getEffectiveFunctions(
  user: UserLike | null | undefined,
): Promise<UserFunction[]> {
  if (!user) return [];
  if (await isPermissiveModeEnabled()) {
    return [...userFunctions];
  }
  return expandFunctions(getAssignedFunctions(user));
}

/** Effective authority: under permissive mode every authenticated user
 *  is treated as at least `lead`. CEOs always stay CEO. */
export async function getEffectiveAuthority(
  user: UserLike | null | undefined,
): Promise<UserAuthorityLevel> {
  const assigned = getAssignedAuthority(user);
  if (!(await isPermissiveModeEnabled())) return assigned;
  if (assigned === "ceo") return "ceo";
  if (assigned === "director") return "director";
  return assigned === "core" ? "lead" : assigned;
}

const AUTHORITY_RANK: Record<UserAuthorityLevel, number> = {
  core: 1,
  lead: 2,
  director: 3,
  ceo: 4,
};

export async function authorityAtLeast(
  user: UserLike | null | undefined,
  min: UserAuthorityLevel,
): Promise<boolean> {
  if (!user) return false;
  const eff = await getEffectiveAuthority(user);
  return AUTHORITY_RANK[eff] >= AUTHORITY_RANK[min];
}

export function hasFunction(
  user: UserLike | null | undefined,
  fn: UserFunction,
): boolean {
  return expandFunctions(getAssignedFunctions(user)).includes(fn);
}

export function hasAnyFunction(
  user: UserLike | null | undefined,
  fns: ReadonlyArray<UserFunction>,
): boolean {
  const have = new Set(expandFunctions(getAssignedFunctions(user)));
  return fns.some((f) => have.has(f));
}

export async function canAccessFunction(
  user: UserLike | null | undefined,
  fn: UserFunction,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return hasFunction(user, fn);
}

// ─── Action gates ─────────────────────────────────────────────────────
// Each `can*` helper is a single source of truth for whether a route
// should allow an action. Under permissive mode they all return true
// for any authenticated user. When permissive mode is off they fall
// back to authority-level checks (and, where appropriate, function
// checks).

export async function canManageClients(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "core");
}

export async function canReassignWork(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "lead");
}

export async function canManageUsers(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "ceo");
}

export async function canAccessCEOPulse(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "ceo");
}

export async function canAccessReports(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "core");
}

export async function canEditReports(user: UserLike | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "lead");
}

export async function canAccessConversationHub(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "core");
}

export async function canAssignConversation(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "lead");
}

export async function canManageSystemSettings(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "lead");
}

export async function canViewExecutiveDashboards(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "director");
}

// ─── Task #3691 — Churn Command Center gate ───────────────────────────
// The Churn Command Center aggregates every client's churn-risk scores in
// one place for the director of account management. Unlike most `can*`
// helpers (including canViewExecutiveDashboards above), it deliberately
// does NOT open up under permissive mode: the contract is that
// below-director users get a 403 from its APIs in ALL modes.
// `authorityAtLeast(user, "director")` alone is safe for that because
// getEffectiveAuthority only ever elevates core → lead under permissive
// mode — director/ceo pass, core/lead never do.
export async function canAccessChurnCommandCenter(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  return authorityAtLeast(user, "director");
}

// ─── Task #2367 — Revenue Integrity System (RIS) gates ────────────────
// RIS is owned by the Reporting role. When permissive mode is off, view
// access is granted to anyone assigned the `reporting_expert` function OR
// anyone at `lead` authority and above (so team leads / directors / CEO
// retain oversight). Editing the data-driven check catalog is the
// narrower action — restricted to `lead` and above.

export async function canAccessRIS(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  if (hasFunction(user, "reporting_expert")) return true;
  return authorityAtLeast(user, "lead");
}

export async function canManageRIS(
  user: UserLike | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (await isPermissiveModeEnabled()) return true;
  return authorityAtLeast(user, "lead");
}

// ─── Facet + label helpers (display only) ─────────────────────────────

// Exported for the server-paged user listing (Task #4348) so the SQL
// facet filter uses the exact same function groups as this module and
// client/src/lib/userLabels.ts.
export const REVENUE_FUNCTIONS: ReadonlyArray<UserFunction> = [
  "marketing_engineer",
  "intake_engineer",
  "sales_engineer",
  "revenue_engineer",
];

export const FULFILLMENT_FUNCTIONS: ReadonlyArray<UserFunction> = [
  "gbp_expert",
  "google_ads_expert",
  "webinar_expert",
  "reporting_expert",
];

export type UserFacet =
  | "Revenue Engineering"
  | "Fulfillment"
  | "Revenue Engineering + Fulfillment"
  | "Unassigned";

export function getUserFacet(user: UserLike | null | undefined): UserFacet {
  const fns = getAssignedFunctions(user);
  const isRev = fns.some((f) => REVENUE_FUNCTIONS.includes(f));
  const isFul = fns.some((f) => FULFILLMENT_FUNCTIONS.includes(f));
  if (isRev && isFul) return "Revenue Engineering + Fulfillment";
  if (isRev) return "Revenue Engineering";
  if (isFul) return "Fulfillment";
  return "Unassigned";
}

export const FUNCTION_LABELS: Record<UserFunction, string> = {
  marketing_engineer: "Marketing Engineer",
  intake_engineer: "Intake Engineer",
  sales_engineer: "Sales Engineer",
  revenue_engineer: "Revenue Engineer",
  gbp_expert: "GBP Expert",
  google_ads_expert: "Google Ads Expert",
  webinar_expert: "Webinar Expert",
  reporting_expert: "Reporting Expert",
};

export const AUTHORITY_LABELS: Record<UserAuthorityLevel, string> = {
  core: "Core",
  lead: "Lead",
  director: "Director",
  ceo: "CEO",
};

/** Derive the legacy `users.role` value from an authority level. Used
 *  at write time only — keeps the bridge column in sync so legacy
 *  read-side code that hasn't migrated yet continues to work. The
 *  `preserveSales` flag lets us keep an existing `sales` row on `sales`
 *  when an admin only edited their functions/authority and didn't
 *  intend to flip them off the sales lane. */
export function deriveLegacyRole(
  authority: UserAuthorityLevel,
  current: string | null | undefined,
): string {
  if (authority === "ceo") return "ceo";
  if (authority === "lead" || authority === "director") return "team_lead";
  // authority === "core"
  if (current === "sales") return "sales";
  return "account_manager";
}
