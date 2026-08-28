import { sql } from "drizzle-orm";
import { boolean, index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { commandPanelProductOptions } from "./commandCenter";

// ─── Onboarding roster (Task #5295) ─────────────────────────────────────────
// Stage 1 of the "New Client Onboarding" epic. Tracks which NoBull users
// handle new-client onboarding calls (company-wide — no per-client scoping,
// unlike Service Desk departments/members in shared/models/serviceDesk.ts,
// which this borrows its shape from). Later stages resolve "first available,
// prioritizing the default person" from this table; this stage only builds
// the roster + default-person foundation and its admin management surface.
//
// Deactivating a row (active=false) removes the user from future resolution
// without deleting the row — history of who WAS an onboarding assignee is
// preserved. Permanent removal (DELETE) is also supported for genuine
// mistakes, mirroring sd_department_members' add/remove + active toggle
// pattern.
//
// The partial unique index below enforces "at most one default, ever" at the
// database layer, independent of application logic — see
// server/services/onboardingRoster.ts for the transaction that swaps it
// atomically (clear-then-set inside one advisory-locked transaction, so a
// default change is never briefly two defaults nor silently zero).
export const onboardingAssignees = pgTable(
  "onboarding_assignees",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull(),
    active: boolean("active").default(true).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userUniq: uniqueIndex("onboarding_assignees_user_uniq").on(t.userId),
    activeIdx: index("onboarding_assignees_active_idx").on(t.active),
    // Partial unique index: at most one row may have is_default = true across
    // the whole table. This is the actual "never two defaults" guarantee —
    // application code cooperates with it, but this is what makes it true
    // even under a concurrent write race.
    defaultUniq: uniqueIndex("onboarding_assignees_default_uniq")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
  }),
);

export const insertOnboardingAssigneeSchema = createInsertSchema(onboardingAssignees).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOnboardingAssignee = z.infer<typeof insertOnboardingAssigneeSchema>;
export type OnboardingAssignee = typeof onboardingAssignees.$inferSelect;

const onboardingBudgetSchema = z
  .number({ message: "Enter a valid budget" })
  .positive("Budget must be greater than $0")
  .max(1_000_000_000, "Budget is too large");

export const onboardingIntakeBodySchema = z
  .object({
    firmName: z.string().trim().min(1, "Firm name is required"),
    contactName: z.string().trim().max(200).optional(),
    contactEmail: z.string().trim().email("A valid contact email is required"),
    contactPhone: z.string().trim().max(40).optional(),
    consultType: z.enum(["free", "paid"]).optional(),
    products: z.array(z.enum(commandPanelProductOptions)).min(1, "At least one product is required"),
    googleAdsBudget: onboardingBudgetSchema.optional(),
    lsaBudget: onboardingBudgetSchema.optional(),
    webinarBudget: onboardingBudgetSchema.optional(),
    gbpPlannedLocationCount: z
      .number({ message: "Enter the number of planned GBP locations" })
      .int("Planned location count must be a whole number")
      .positive("Plan at least one GBP location")
      .max(50, "Plan no more than 50 GBP locations at once")
      .optional(),
    gbpPlannedLocationCities: z
      .array(z.string().trim().min(1, "Enter a city for each planned GBP location").max(100))
      .max(50)
      .optional(),
    notes: z.string().trim().min(1, "Notes for the team are required").max(5000),
    startTimeUtc: z.string().datetime(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .superRefine((data, ctx) => {
    const requiredBudgets = [
      ["google_ads", "googleAdsBudget", "Google Ads"],
      ["lsa", "lsaBudget", "LSA"],
      ["webinar", "webinarBudget", "Webinars"],
    ] as const;
    for (const [product, field, label] of requiredBudgets) {
      if (data.products.includes(product) && data[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${label} budget is required when ${label} is selected`,
        });
      }
    }
    if (!data.products.includes("gbp")) return;
    if (data.gbpPlannedLocationCount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gbpPlannedLocationCount"],
        message: "Planned location count is required when GBP is selected",
      });
      return;
    }
    const cities = data.gbpPlannedLocationCities ?? [];
    if (cities.length !== data.gbpPlannedLocationCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gbpPlannedLocationCities"],
        message: `Enter exactly ${data.gbpPlannedLocationCount} ${data.gbpPlannedLocationCount === 1 ? "city" : "cities"}`,
      });
    }
  });

export type OnboardingIntakeBody = z.infer<typeof onboardingIntakeBodySchema>;
