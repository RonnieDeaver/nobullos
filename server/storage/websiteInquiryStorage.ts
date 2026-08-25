// @db-pool-intent: ambient
//
// Task #3740 — persistence for marketing-website inquiries (contact +
// unsubscribe forms on nobullmarketing.com). Called from the public
// POST /api/website/inquiry route; kept as a storage module so a future
// admin surface can list/triage inquiries through the same helpers.

import { desc } from "drizzle-orm";
import {
  websiteInquiries,
  type WebsiteInquiry,
  type InsertWebsiteInquiry,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

export async function createWebsiteInquiry(
  data: InsertWebsiteInquiry,
): Promise<WebsiteInquiry> {
  return withDbAttribution("route:website-inquiry-create", async () => {
    const [row] = await getDb().insert(websiteInquiries).values(data).returning();
    return row;
  });
}

export async function listWebsiteInquiries(limit = 100): Promise<WebsiteInquiry[]> {
  return withDbAttribution("route:website-inquiry-list", async () => {
    return getDb()
      .select()
      .from(websiteInquiries)
      .orderBy(desc(websiteInquiries.createdAt))
      .limit(limit);
  });
}
