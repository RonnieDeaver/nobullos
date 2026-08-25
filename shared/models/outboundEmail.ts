import { pgTable, varchar, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { clients } from "./clients";

// Task #4334 — outbound client-facing email: one send seam with
// mailbox-first routing.
//
// Three tables:
//   - email_suppressions:    global policy list enforced on EVERY transport
//                            path. Unsubscribes block marketing; bounce,
//                            complaint, and manual blocks also stop transactional.
//   - user_email_identities: maps a user to their own Front channel (their
//                            real mailbox). No mapping ⇒ sends for that user
//                            are blocked loudly — never silently re-routed.
//   - outbound_emails:       per-recipient send log. One row per recipient
//                            per compose; doubles as the idempotency ledger
//                            (hashed ids + dispatch-claim columns, modeled on
//                            twilio_messages' at-most-once dispatch claim).

// ── Value sets ───────────────────────────────────────────────────────────────

export const SUPPRESSION_REASONS = ["unsubscribe", "bounce", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SOURCES = [
  "website_unsubscribe",       // live hook in POST /api/website/inquiry
  "website_unsubscribe_seed",  // one-time lazy seed sweep of historical rows
  "unsubscribe_link",          // signed per-recipient link in marketing sends
  "sendgrid_event",            // bounce/complaint/unsubscribe webhook events
  "ghl_event",                 // signed GHL ContactDndUpdate Email DND event
  "manual",                    // admin add
] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

// Transport outcome of one per-recipient send. Terminal states:
// sent | suppressed | blocked_no_mailbox | failed | cancelled | unknown.
// `unknown` (vendor call timed out AFTER the request may have been accepted)
// is terminal-by-policy: it is alerted and never auto-retried, because a
// retry is exactly how double-sends happen (pressure case P11).
export const OUTBOUND_EMAIL_STATUSES = [
  "queued",             // row created, job enqueued
  "deferred",           // daily cap hit (or sending paused) — waiting for a later window
  "sending",            // dispatch claim held, vendor call in flight
  "sent",               // vendor accepted
  "suppressed",         // recipient on the suppression list — visibly skipped
  "blocked_no_mailbox", // sender has no active Front-channel identity mapping
  "failed",             // definitive vendor rejection or retries exhausted
  "unknown",            // ambiguous vendor outcome — alerted, never auto-retried
  "cancelled",          // operator cancelled while queued/deferred
] as const;
export type OutboundEmailStatus = (typeof OUTBOUND_EMAIL_STATUSES)[number];

export const OUTBOUND_EMAIL_PATHS = ["front_channel", "sendgrid"] as const;
export type OutboundEmailPath = (typeof OUTBOUND_EMAIL_PATHS)[number];

// transactional = one-to-one business correspondence (no unsubscribe footer
// required); marketing = bulk-class content — unsubscribe link is mandatory
// on BOTH paths and List-Unsubscribe headers ride the SendGrid path.
export const OUTBOUND_MESSAGE_CLASSES = ["transactional", "marketing"] as const;
export type OutboundMessageClass = (typeof OUTBOUND_MESSAGE_CLASSES)[number];

// ── Tables ───────────────────────────────────────────────────────────────────

export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Always stored lowercased/trimmed; uniqueness is on the stored value.
    email: text("email").notNull(),
    reason: varchar("reason", { length: 20 }).notNull(),
    source: varchar("source", { length: 40 }).notNull(),
    notes: text("notes"),
    // Real user id for manual adds; NULL for system-fed rows (webhook, seed).
    createdBy: varchar("created_by").references(() => users.id),
    // Bumped when a later signal re-confirms the suppression (e.g. a second
    // bounce for an already-suppressed address).
    lastEventAt: timestamp("last_event_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    emailUq: uniqueIndex("email_suppressions_email_uq").on(table.email),
    createdAtIdx: index("email_suppressions_created_at_idx").on(table.createdAt),
  }),
);

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type InsertEmailSuppression = typeof emailSuppressions.$inferInsert;

export const userEmailIdentities = pgTable(
  "user_email_identities",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => users.id),
    // The user's own-mailbox channel in Front (cha_...). Sends from this user
    // author into this channel so replies land in their real mailbox and the
    // existing Front sync captures both directions.
    frontChannelId: varchar("front_channel_id").notNull(),
    // The address the channel sends as — display + per-domain counters.
    fromEmail: text("from_email").notNull(),
    // NULL ⇒ the outbound_email_daily_cap_default system setting applies.
    dailyCap: integer("daily_cap"),
    active: boolean("active").notNull().default(true),
    updatedBy: varchar("updated_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_email_identities_user_id_uq").on(table.userId),
  }),
);

export type UserEmailIdentity = typeof userEmailIdentities.$inferSelect;
export type InsertUserEmailIdentity = typeof userEmailIdentities.$inferInsert;

export const outboundEmails = pgTable(
  "outbound_emails",
  {
    // Deterministic id derived from (batchId, recipient) — compose re-POSTs
    // with the same client batch key collide here via ON CONFLICT DO NOTHING
    // instead of minting duplicate sends (pressure case P1).
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    batchId: varchar("batch_id").notNull(),
    senderUserId: varchar("sender_user_id").notNull().references(() => users.id),
    clientId: varchar("client_id").references(() => clients.id),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    messageClass: varchar("message_class", { length: 20 }).notNull().default("transactional"),
    // Where consent came from. One-off composes stamp 'manual_compose';
    // future producers (sequences) must stamp their own source — cold lists
    // have none, which is the structural point.
    consentSource: varchar("consent_source", { length: 40 }).notNull().default("manual_compose"),
    status: varchar("status", { length: 24 }).notNull().default("queued"),
    path: varchar("path", { length: 16 }),
    frontChannelId: varchar("front_channel_id"),
    frontMessageId: varchar("front_message_id"),
    sendgridMessageId: varchar("sendgrid_message_id"),
    // Post-transport delivery signal from the SendGrid event webhook
    // (delivered | bounce | dropped | spamreport | unsubscribe). Front-path
    // rows have no per-message delivery feed — stays NULL there.
    deliveryStatus: varchar("delivery_status", { length: 20 }),
    // At-most-once dispatch claim (twilio_messages convention): a handler
    // CASes the claim before ANY vendor call; a lost claim means another
    // attempt already dispatched — classify, never re-send.
    dispatchClaimToken: varchar("dispatch_claim_token"),
    dispatchClaimedAt: timestamp("dispatch_claimed_at"),
    // UTC day (YYYY-MM-DD) stamped at claim time — the per-user daily cap
    // counts rows in this window, including in-flight and unknown outcomes
    // (conservative: an ambiguous send still consumed mailbox budget).
    capWindowDay: varchar("cap_window_day", { length: 10 }),
    errorCode: varchar("error_code"),
    errorMessage: text("error_message"),
    // Random token backing the signed unsubscribe link (marketing class).
    unsubscribeToken: varchar("unsubscribe_token"),
    deferredCount: integer("deferred_count").notNull().default(0),
    // When deferred: the next send window this row is waiting for.
    scheduledFor: timestamp("scheduled_for"),
    sentAt: timestamp("sent_at"),
    createdBy: varchar("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    batchIdx: index("outbound_emails_batch_id_idx").on(table.batchId),
    createdAtIdx: index("outbound_emails_created_at_idx").on(table.createdAt.desc()),
    toEmailIdx: index("outbound_emails_to_email_idx").on(table.toEmail),
    // Backs the per-user daily cap COUNT: (sender, day) over rows that
    // consumed mailbox budget on the Front path.
    capCountIdx: index("outbound_emails_cap_count_idx")
      .on(table.senderUserId, table.capWindowDay)
      .where(sql`path = 'front_channel' AND status IN ('sending', 'sent', 'unknown')`),
    // Deferred-rows visibility (counters + "waiting for next window" list).
    statusScheduledIdx: index("outbound_emails_status_scheduled_idx").on(table.status, table.scheduledFor),
    // Webhook event → row correlation.
    sendgridMsgIdx: index("outbound_emails_sendgrid_message_id_idx")
      .on(table.sendgridMessageId)
      .where(sql`sendgrid_message_id IS NOT NULL`),
  }),
);

export type OutboundEmail = typeof outboundEmails.$inferSelect;
export type InsertOutboundEmail = typeof outboundEmails.$inferInsert;
