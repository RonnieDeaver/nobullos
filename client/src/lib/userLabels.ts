// Task #1758 — shared client-side label helpers for the function +
// authority framework. Keep in sync with server/auth/permissions.ts.
// Display-only — these helpers do not gate behavior.

export type UserFunction =
  | "marketing_engineer"
  | "intake_engineer"
  | "sales_engineer"
  | "revenue_engineer"
  | "gbp_expert"
  | "google_ads_expert"
  | "webinar_expert"
  | "reporting_expert";

export type UserAuthorityLevel = "core" | "lead" | "director" | "ceo";

export const ALL_USER_FUNCTIONS: UserFunction[] = [
  "marketing_engineer",
  "intake_engineer",
  "sales_engineer",
  "revenue_engineer",
  "gbp_expert",
  "google_ads_expert",
  "webinar_expert",
  "reporting_expert",
];

export const ALL_AUTHORITY_LEVELS: UserAuthorityLevel[] = [
  "core",
  "lead",
  "director",
  "ceo",
];

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

const REVENUE_FUNCTIONS: UserFunction[] = [
  "marketing_engineer",
  "intake_engineer",
  "sales_engineer",
  "revenue_engineer",
];

const FULFILLMENT_FUNCTIONS: UserFunction[] = [
  "gbp_expert",
  "google_ads_expert",
  "webinar_expert",
  "reporting_expert",
];

// Three Revenue-Engineering lanes that `revenue_engineer` subsumes.
// Selecting Revenue Engineer in the User Management form disables
// these three chips with a tooltip — see UserManagement.tsx.
export const REVENUE_SUBSUMED_FUNCTIONS: UserFunction[] = [
  "marketing_engineer",
  "intake_engineer",
  "sales_engineer",
];

export function isUserFunction(v: unknown): v is UserFunction {
  return typeof v === "string" && (ALL_USER_FUNCTIONS as string[]).includes(v);
}

export function isAuthorityLevel(v: unknown): v is UserAuthorityLevel {
  return typeof v === "string" && (ALL_AUTHORITY_LEVELS as string[]).includes(v);
}

export type UserFacet =
  | "Revenue Engineering"
  | "Fulfillment"
  | "Revenue Engineering + Fulfillment"
  | "Unassigned";

export function getUserFacet(functions: string[] | null | undefined): UserFacet {
  const fns = (functions ?? []).filter(isUserFunction);
  const isRev = fns.some((f) => REVENUE_FUNCTIONS.includes(f));
  const isFul = fns.some((f) => FULFILLMENT_FUNCTIONS.includes(f));
  if (isRev && isFul) return "Revenue Engineering + Fulfillment";
  if (isRev) return "Revenue Engineering";
  if (isFul) return "Fulfillment";
  return "Unassigned";
}

/** Build the inline user label used on profile, @mention picker,
 *  assignee picker, etc. Examples:
 *    "Jane Smith — Revenue Engineer · Lead"
 *    "Carlos Rivera — Google Ads Expert · Core"
 *  Falls back gracefully when functions/authority are missing. */
export function formatUserLabel(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  functions?: string[] | null;
  authorityLevel?: string | null;
}): string {
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email ||
    "Unknown user";
  const fns = (user.functions ?? []).filter(isUserFunction);
  // Prefer revenue_engineer as the headline label if it's set, otherwise
  // use the first assigned function.
  const headline = fns.includes("revenue_engineer")
    ? "revenue_engineer"
    : fns[0];
  const fnLabel = headline ? FUNCTION_LABELS[headline] : "Unassigned";
  const authority = isAuthorityLevel(user.authorityLevel)
    ? AUTHORITY_LABELS[user.authorityLevel]
    : "Core";
  return `${name} — ${fnLabel} · ${authority}`;
}
