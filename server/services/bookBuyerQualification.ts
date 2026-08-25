import { z } from "zod";

export const BOOK_BUYER_QUALIFICATION_POLICY_SETTING =
  "book_buyer_qualification_policy_v1";
export const BOOK_BUYER_GHL_CALENDAR_SETTING =
  "book_buyer_ghl_calendar_v1";

export const bookBuyerAnswersSchema = z
  .object({
    role: z.enum(["owner", "managing_partner", "decision_maker", "other"]),
    practiceArea: z.string().trim().min(2).max(120),
    monthlyQualifiedInquiries: z.enum([
      "under_10",
      "10_24",
      "25_49",
      "50_99",
      "100_plus",
      "unsure",
    ]),
    annualFirmRevenue: z.enum([
      "under_1m",
      "1m_3m",
      "3m_10m",
      "10m_plus",
      "prefer_not_to_say",
    ]),
    improvementTiming: z.enum(["0_30_days", "31_90_days", "91_plus_days", "exploring"]),
  })
  .strict();
export type BookBuyerAnswers = z.infer<typeof bookBuyerAnswersSchema>;

const qualificationPolicySchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    eligibleRoles: z
      .array(z.enum(["owner", "managing_partner", "decision_maker"]))
      .min(1)
      .max(3),
    maximumImprovementTimelineDays: z.number().int().min(1).max(365),
    thresholdMode: z.enum(["all", "any"]),
    minimumMonthlyQualifiedInquiries: z.number().int().min(1).max(1_000_000).optional(),
    minimumAnnualFirmRevenueUsd: z.number().int().min(1).max(10_000_000_000).optional(),
  })
  .strict()
  .refine(
    (policy) =>
      policy.minimumMonthlyQualifiedInquiries !== undefined ||
      policy.minimumAnnualFirmRevenueUsd !== undefined,
    "At least one approved numeric threshold is required",
  );
export type BookBuyerQualificationPolicy = z.infer<typeof qualificationPolicySchema>;

const ghlCalendarSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    embedUrl: z.string().url().max(2000),
    prefillFields: z
      .array(
        z.enum([
          "name",
          "email",
          "utmSource",
          "utmMedium",
          "utmCampaign",
          "utmTerm",
          "utmContent",
        ]),
      )
      .max(7),
  })
  .strict();
export type BookBuyerGhlCalendar = z.infer<typeof ghlCalendarSchema>;

export type BookBuyerRoutingOutcome =
  | "qualified"
  | "alternate_next_step"
  | "manual_review";

export interface BookBuyerQualificationDecision {
  outcome: BookBuyerRoutingOutcome;
  reason:
    | "policy_missing_or_invalid"
    | "policy_disabled"
    | "role_not_eligible"
    | "timeline_not_eligible"
    | "answer_band_ambiguous"
    | "approved_policy_match"
    | "approved_policy_no_match";
}

type Range = { min: number; max: number | null };

const INQUIRY_RANGES: Record<BookBuyerAnswers["monthlyQualifiedInquiries"], Range | null> = {
  under_10: { min: 0, max: 9 },
  "10_24": { min: 10, max: 24 },
  "25_49": { min: 25, max: 49 },
  "50_99": { min: 50, max: 99 },
  "100_plus": { min: 100, max: null },
  unsure: null,
};

const REVENUE_RANGES: Record<BookBuyerAnswers["annualFirmRevenue"], Range | null> = {
  under_1m: { min: 0, max: 999_999 },
  "1m_3m": { min: 1_000_000, max: 2_999_999 },
  "3m_10m": { min: 3_000_000, max: 9_999_999 },
  "10m_plus": { min: 10_000_000, max: null },
  prefer_not_to_say: null,
};

const TIMING_RANGES: Record<BookBuyerAnswers["improvementTiming"], Range | null> = {
  "0_30_days": { min: 0, max: 30 },
  "31_90_days": { min: 31, max: 90 },
  "91_plus_days": { min: 91, max: null },
  exploring: null,
};

function thresholdResult(
  range: Range | null,
  threshold: number,
): "meets" | "misses" | "ambiguous" {
  if (!range) return "ambiguous";
  if (range.min >= threshold) return "meets";
  if (range.max !== null && range.max < threshold) return "misses";
  return "ambiguous";
}

export function parseBookBuyerQualificationPolicy(
  raw: string | null | undefined,
): BookBuyerQualificationPolicy | null {
  if (!raw) return null;
  try {
    const parsed = qualificationPolicySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function evaluateBookBuyerQualification(
  answers: BookBuyerAnswers,
  policy: BookBuyerQualificationPolicy | null,
): BookBuyerQualificationDecision {
  if (!policy) return { outcome: "manual_review", reason: "policy_missing_or_invalid" };
  if (!policy.enabled) return { outcome: "manual_review", reason: "policy_disabled" };
  if (!policy.eligibleRoles.some((role) => role === answers.role)) {
    return { outcome: "alternate_next_step", reason: "role_not_eligible" };
  }

  const timing = TIMING_RANGES[answers.improvementTiming];
  if (!timing) return { outcome: "manual_review", reason: "answer_band_ambiguous" };
  if (timing.min > policy.maximumImprovementTimelineDays) {
    return { outcome: "alternate_next_step", reason: "timeline_not_eligible" };
  }
  if (
    timing.max === null ||
    timing.max > policy.maximumImprovementTimelineDays
  ) {
    return { outcome: "manual_review", reason: "answer_band_ambiguous" };
  }

  const thresholdResults: Array<"meets" | "misses" | "ambiguous"> = [];
  if (policy.minimumMonthlyQualifiedInquiries !== undefined) {
    thresholdResults.push(
      thresholdResult(
        INQUIRY_RANGES[answers.monthlyQualifiedInquiries],
        policy.minimumMonthlyQualifiedInquiries,
      ),
    );
  }
  if (policy.minimumAnnualFirmRevenueUsd !== undefined) {
    thresholdResults.push(
      thresholdResult(
        REVENUE_RANGES[answers.annualFirmRevenue],
        policy.minimumAnnualFirmRevenueUsd,
      ),
    );
  }

  if (policy.thresholdMode === "all") {
    if (thresholdResults.includes("misses")) {
      return {
        outcome: "alternate_next_step",
        reason: "approved_policy_no_match",
      };
    }
    if (thresholdResults.includes("ambiguous")) {
      return { outcome: "manual_review", reason: "answer_band_ambiguous" };
    }
    return { outcome: "qualified", reason: "approved_policy_match" };
  }

  if (thresholdResults.includes("meets")) {
    return { outcome: "qualified", reason: "approved_policy_match" };
  }
  if (thresholdResults.includes("ambiguous")) {
    return { outcome: "manual_review", reason: "answer_band_ambiguous" };
  }
  return {
    outcome: "alternate_next_step",
    reason: "approved_policy_no_match",
  };
}

export function parseBookBuyerGhlCalendar(
  raw: string | null | undefined,
): BookBuyerGhlCalendar | null {
  if (!raw) return null;
  try {
    const parsed = ghlCalendarSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !parsed.data.enabled) return null;
    const url = new URL(parsed.data.embedUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.leadconnectorhq.com" ||
      !url.pathname.startsWith("/widget/bookings/")
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function buildBookBuyerCalendarUrl(
  calendar: BookBuyerGhlCalendar,
  buyer: {
    name: string | null;
    email: string;
    attribution?: {
      utmSource?: string | null;
      utmMedium?: string | null;
      utmCampaign?: string | null;
      utmTerm?: string | null;
      utmContent?: string | null;
    };
  },
): string {
  const url = new URL(calendar.embedUrl);
  const approved = new Set(calendar.prefillFields);
  if (approved.has("name") && buyer.name) url.searchParams.set("name", buyer.name);
  if (approved.has("email")) url.searchParams.set("email", buyer.email);
  const params = {
    utm_source: approved.has("utmSource") ? buyer.attribution?.utmSource : null,
    utm_medium: approved.has("utmMedium") ? buyer.attribution?.utmMedium : null,
    utm_campaign: approved.has("utmCampaign") ? buyer.attribution?.utmCampaign : null,
    utm_term: approved.has("utmTerm") ? buyer.attribution?.utmTerm : null,
    utm_content: approved.has("utmContent") ? buyer.attribution?.utmContent : null,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}