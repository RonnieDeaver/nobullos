import { pgTable, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clients } from "./clients";

// Task #3740 — inquiries submitted from the public marketing website
// (nobullmarketing.com). Two kinds today:
//   - "contact":     the "Have a Question?" form on /book-free-demo/
//   - "unsubscribe": the email-only form on /unsubscribe/
// Rows are written by the public rate-limited POST /api/website/inquiry
// endpoint and surfaced to the team via in-app notifications. `status` is
// reserved for a future admin surface ("new" until then).
//
// Task #4330 — contact-kind inquiries are additionally promoted into lead
// records (match-or-create against clients/contacts); `lead_client_id`
// links the inquiry to the client row it created or matched. Null for
// unsubscribe rows, pre-feature rows, and promotion failures (the
// notification flow is unaffected either way).
export const websiteInquiries = pgTable(
  "website_inquiries",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: varchar("kind", { length: 20 }).notNull(),
    fullName: text("full_name"),
    email: text("email").notNull(),
    phone: text("phone"),
    message: text("message"),
    sourcePage: text("source_page"),
    sourceHost: text("source_host"),
    userAgent: text("user_agent"),
    // Task #4337 — first-touch UTM/referrer attribution captured by the
    // marketing-site client (write-once localStorage record forwarded with
    // the submission). All nullable; pre-feature rows and direct visits
    // leave them NULL. Raw values as captured — normalization happens at
    // lead-stamp time (shared/models/campaigns.ts).
    utmSource: varchar("utm_source", { length: 200 }),
    utmMedium: varchar("utm_medium", { length: 200 }),
    utmCampaign: varchar("utm_campaign", { length: 200 }),
    utmTerm: varchar("utm_term", { length: 200 }),
    utmContent: varchar("utm_content", { length: 200 }),
    referrer: text("referrer"),
    status: varchar("status", { length: 20 }).notNull().default("new"),
    // Task #4330 — the lead/client record this inquiry created or matched.
    leadClientId: varchar("lead_client_id").references(() => clients.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("idx_website_inquiries_created_at").on(table.createdAt),
    leadClientIdx: index("idx_website_inquiries_lead_client").on(table.leadClientId),
  }),
);

export type WebsiteInquiry = typeof websiteInquiries.$inferSelect;
export type InsertWebsiteInquiry = typeof websiteInquiries.$inferInsert;
