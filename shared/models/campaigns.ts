/**
 * Task #4337 — Campaigns, UTM capture and attribution.
 *
 * Closes the loop from marketing touch to revenue at NoBull scale
 * (first-touch only — multi-touch models are an explicit non-goal):
 *
 *   - marketing_campaigns  operator-created campaign records. The normalized
 *     `utm_campaign` value is the campaign's attribution KEY: leads/deals
 *     are joined to campaigns BY STRING, not FK, so a campaign created
 *     after its traffic already arrived still claims that history, and
 *     deleting a campaign never destroys attribution stamped on leads.
 *     (Named marketing_campaigns to avoid colliding with the existing
 *     SEMrush/Google Ads "campaign" naming.)
 *   - campaign_links       tracked URLs built by the UTM builder. The final
 *     URL is derived by `buildCampaignLinkUrl` (pure, shared with the UI);
 *     utm_campaign always comes from the parent campaign's key.
 *
 * First-touch attribution stamps live on `clients.first_touch_*` and
 * `deals.first_touch_*` (see models/clients.ts, models/deals.ts): written
 * once at creation by the intake/storage paths, never from request bodies,
 * and never re-derived. NULL renders as "Unknown"; captured-but-sourceless
 * visits normalize to "direct" — never blank.
 */
import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "./auth";

export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    /** Attribution key — always stored normalized (normalizeUtmCampaign). */
    utmCampaign: varchar("utm_campaign", { length: 120 }).notNull(),
    /** Campaign period — informational, nullable on both ends. */
    startDate: date("start_date"),
    endDate: date("end_date"),
    notes: text("notes"),
    isArchived: boolean("is_archived").default(false).notNull(),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => ({
    // Concurrent creates of the same key resolve here (409 at the route) —
    // no SELECT-then-INSERT race.
    utmKeyUnique: uniqueIndex("marketing_campaigns_utm_campaign_key").on(
      t.utmCampaign,
    ),
  }),
);

export const campaignLinks = pgTable(
  "campaign_links",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: varchar("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    label: text("label"),
    destinationUrl: text("destination_url").notNull(),
    utmSource: varchar("utm_source", { length: 200 }),
    utmMedium: varchar("utm_medium", { length: 200 }),
    utmTerm: varchar("utm_term", { length: 200 }),
    utmContent: varchar("utm_content", { length: 200 }),
    createdBy: varchar("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    campaignIdx: index("campaign_links_campaign_idx").on(t.campaignId),
  }),
);

export type MarketingCampaign = typeof marketingCampaigns.$inferSelect;
export type CampaignLink = typeof campaignLinks.$inferSelect;

// ---------------------------------------------------------------------------
// Public-intake attribution payload (website inquiry + public booking).
// Additive optional fields with hard caps — the capture clients truncate
// before sending, so a legitimate visitor never trips the cap; anything
// longer is a hand-rolled request and 400s (validation is not weakened).
// ---------------------------------------------------------------------------

export const UTM_VALUE_MAX = 200;
export const REFERRER_VALUE_MAX = 1000;

export const publicAttributionSchema = z.object({
  utmSource: z.string().trim().max(UTM_VALUE_MAX).optional(),
  utmMedium: z.string().trim().max(UTM_VALUE_MAX).optional(),
  utmCampaign: z.string().trim().max(UTM_VALUE_MAX).optional(),
  utmTerm: z.string().trim().max(UTM_VALUE_MAX).optional(),
  utmContent: z.string().trim().max(UTM_VALUE_MAX).optional(),
  referrer: z.string().trim().max(REFERRER_VALUE_MAX).optional(),
});
export type PublicAttribution = z.infer<typeof publicAttributionSchema>;

export interface CleanAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
}

/** Empty strings → NULL so storage never holds "" (blank ≠ absent). */
export function cleanAttribution(
  input: PublicAttribution | undefined | null,
): CleanAttribution {
  const pick = (v: string | undefined): string | null => {
    const t = v?.trim();
    return t ? t : null;
  };
  return {
    utmSource: pick(input?.utmSource),
    utmMedium: pick(input?.utmMedium),
    utmCampaign: pick(input?.utmCampaign),
    utmTerm: pick(input?.utmTerm),
    utmContent: pick(input?.utmContent),
    referrer: pick(input?.referrer),
  };
}

// ---------------------------------------------------------------------------
// First-touch normalization (pure — used by lead/deal stamping and the UI).
// ---------------------------------------------------------------------------

export const DIRECT_SOURCE = "direct";
export const FIRST_TOUCH_SOURCE_MAX = 80;
export const FIRST_TOUCH_CAMPAIGN_MAX = 120;

/** Recognized organic search referrers → canonical source names. */
const SEARCH_ENGINE_HOSTS: Array<{ pattern: RegExp; source: string }> = [
  { pattern: /(^|\.)google\./, source: "google" },
  { pattern: /(^|\.)bing\.com$/, source: "bing" },
  { pattern: /(^|\.)duckduckgo\.com$/, source: "duckduckgo" },
  { pattern: /(^|\.)yahoo\./, source: "yahoo" },
  { pattern: /(^|\.)yandex\./, source: "yandex" },
  { pattern: /(^|\.)baidu\.com$/, source: "baidu" },
];

/**
 * Lowercase, trim, collapse whitespace runs to `-`, strip control chars,
 * cap length. Returns null when nothing usable remains ("" / whitespace).
 */
export function normalizeSourceToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw
    .toLowerCase()
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, FIRST_TOUCH_SOURCE_MAX);
  return token || null;
}

/** Hostname of a referrer URL, lowercased, `www.` stripped; null if unparseable. */
export function parseReferrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * First-touch source precedence: explicit utm_source > known search-engine
 * referrer > any other external referrer host > "direct". Never returns
 * blank — a captured touch with no signal IS a direct visit. (Rows that
 * predate capture keep NULL and render as "Unknown" — a distinct state.)
 */
export function normalizeFirstTouchSource(input: {
  utmSource?: string | null;
  referrer?: string | null;
}): string {
  const explicit = normalizeSourceToken(input.utmSource);
  if (explicit) return explicit;
  const host = parseReferrerHost(input.referrer);
  if (!host) return DIRECT_SOURCE;
  for (const engine of SEARCH_ENGINE_HOSTS) {
    if (engine.pattern.test(host)) return engine.source;
  }
  return host.slice(0, FIRST_TOUCH_SOURCE_MAX);
}

/** Campaign attribution key: lowercase, whitespace → `-`, capped. Null when absent. */
export function normalizeUtmCampaign(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw
    .toLowerCase()
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, FIRST_TOUCH_CAMPAIGN_MAX);
  return key || null;
}

/** Derived first-touch stamp for a captured intake touch. */
export function deriveFirstTouch(input: {
  utmSource?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
}): { source: string; campaign: string | null } {
  return {
    source: normalizeFirstTouchSource(input),
    campaign: normalizeUtmCampaign(input.utmCampaign),
  };
}

// ---------------------------------------------------------------------------
// UTM builder — final tracked URL for a campaign link (pure; UI + server).
// ---------------------------------------------------------------------------

export function buildCampaignLinkUrl(
  destinationUrl: string,
  params: {
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmTerm?: string | null;
    utmContent?: string | null;
  },
): string {
  const url = new URL(destinationUrl);
  const set = (key: string, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) url.searchParams.set(key, v);
  };
  set("utm_source", params.utmSource);
  set("utm_medium", params.utmMedium);
  set("utm_campaign", params.utmCampaign);
  set("utm_term", params.utmTerm);
  set("utm_content", params.utmContent);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Route body schemas (hand-written, F8 write-boundary convention: focused
// fields only — id/createdBy/timestamps are server-stamped, unknown keys
// strip). `utmCampaign` is normalized at the storage layer.
// ---------------------------------------------------------------------------

const campaignDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const createCampaignBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  utmCampaign: z.string().trim().min(1).max(FIRST_TOUCH_CAMPAIGN_MAX),
  startDate: campaignDateSchema.nullable().optional(),
  endDate: campaignDateSchema.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

export const updateCampaignBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Editable: attribution joins by string key, so fixing a typo'd key
    // re-points the join (uniqueness still enforced).
    utmCampaign: z.string().trim().min(1).max(FIRST_TOUCH_CAMPAIGN_MAX),
    startDate: campaignDateSchema.nullable(),
    endDate: campaignDateSchema.nullable(),
    notes: z.string().max(5000).nullable(),
    isArchived: z.boolean(),
  })
  .partial();
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;

export const createCampaignLinkBodySchema = z.object({
  label: z.string().trim().max(200).nullable().optional(),
  destinationUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL"),
  utmSource: z.string().trim().max(UTM_VALUE_MAX).nullable().optional(),
  utmMedium: z.string().trim().max(UTM_VALUE_MAX).nullable().optional(),
  utmTerm: z.string().trim().max(UTM_VALUE_MAX).nullable().optional(),
  utmContent: z.string().trim().max(UTM_VALUE_MAX).nullable().optional(),
});
export type CreateCampaignLinkBody = z.infer<typeof createCampaignLinkBodySchema>;
