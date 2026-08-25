import { pgTable, serial, varchar, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// NOTE: This table is created at boot via raw SQL in server/routes.ts
// (`CREATE TABLE IF NOT EXISTS user_feedback ...`). The Drizzle definition
// here exists so `drizzle-kit push` knows the table is intentional and does
// NOT prompt to rename it into newly-added tables (e.g. booking_meeting_types).
// Keep the column shape in sync with the CREATE TABLE statement.
// Task #2064 — per-feedback Slack relay state. `slack_status` records
// whether the feedback was relayed to the "Ronnie thought stream" Slack
// channel. Values:
//   - "pending"        — not yet attempted (default for legacy rows)
//   - "delivered"      — chat.postMessage succeeded
//   - "not_connected"  — Slack rejected the token / no token (operator re-auth)
//   - "failed"         — transient error or channel/post problem (retryable)
//   - "undeliverable"  — Task #2131 terminal: gave up after N failed
//                        attempts (or M hours stuck). Stops retrying and
//                        is escalated to responsible admins so a human
//                        re-auths Slack / fixes the channel.
// `slack_reason` holds the plain-English explanation; `slack_updated_at`
// the time of the last relay attempt; `slack_attempts` (Task #2131) counts
// the number of non-delivered relay attempts so the retry scheduler can
// give up instead of retrying a permanently-broken row forever.
export const userFeedback = pgTable("user_feedback", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  userName: varchar("user_name").notNull(),
  topic: varchar("topic").notNull().default("OTHER"),
  feedbackText: text("feedback_text").notNull(),
  currentPage: varchar("current_page"),
  screenshots: text("screenshots").default("[]"),
  status: varchar("status").notNull().default("pending"),
  slackStatus: varchar("slack_status").notNull().default("pending"),
  slackReason: text("slack_reason"),
  slackUpdatedAt: timestamp("slack_updated_at"),
  slackAttempts: integer("slack_attempts").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  // Task #4545 — atomic dedupe for SYSTEM-filed items (nightly sweep +
  // post-merge canary). Their streak dedupe is "one open row per
  // (submitter, current_page)"; a SELECT-then-INSERT alone races across
  // concurrent workspaces sharing the dev DB, so the insert goes through
  // ON CONFLICT DO NOTHING against this partial index (see
  // regressionSweepFeedback.insertSweepItem). Human rows (non-"system:%"
  // user_ids) are unconstrained. Also created at boot + via migration
  // (raw-SQL triple defense — the table itself is boot-created raw SQL).
  uniqueIndex("user_feedback_system_pending_dedupe_idx")
    .on(t.userId, t.currentPage)
    .where(sql`status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL`),
]);

export type UserFeedback = typeof userFeedback.$inferSelect;
export type InsertUserFeedback = typeof userFeedback.$inferInsert;
