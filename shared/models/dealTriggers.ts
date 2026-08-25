/**
 * Task #4332 — Native deal auto-move triggers.
 *
 * First-party integration events NoBull OS already captures move deals
 * without manual dragging: a confirmed booking, a PandaDoc document status
 * transition, and an inbound Front reply from a matched contact (logged
 * only — the sequences feature consumes it later to cancel follow-ups).
 *
 *   - deal_trigger_events   durable, append-mostly log of normalized trigger
 *     events. `event_key` is UNIQUE and deterministic per source occurrence
 *     (booking_confirmed:<meetingId>, pandadoc_status:<documentId>:<status>,
 *     front_reply:<conversationId>:<inboundMessageId>) so webhook/sync
 *     replays collapse at INSERT … ON CONFLICT DO NOTHING — only the caller
 *     that actually inserted the row processes it. Rows are never deleted
 *     (audit value, low cardinality); deal/client FKs SET NULL on parent
 *     delete so the log survives.
 *
 * Processing is INLINE at the tap (no queue lane): emit → insert → process.
 * Failed/skipped rows can be reprocessed from the admin surface via a CAS
 * status flip. Moves ride dealsStorage.moveDealStage — the only stage
 * writer — so history, required-fields policy, and stage automations all
 * apply; the history row carries moved_by_source + trigger_event_id.
 *
 * Config lives in system_settings (all hooks default OFF; read fresh per
 * event, no cache latch):
 *   - deal_triggers_booking_enabled / deal_triggers_booking_stage_slug
 *   - deal_triggers_pandadoc_enabled / deal_triggers_pandadoc_stage_map
 *     (JSON object: raw PandaDoc status → stage slug)
 *   - deal_triggers_front_reply_enabled
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { clients } from "./clients";
import { deals } from "./deals";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const dealTriggerTypes = [
  "booking_confirmed",
  "pandadoc_status_changed",
  "front_inbound_reply",
] as const;
export type DealTriggerType = (typeof dealTriggerTypes)[number];

export const dealTriggerTypeLabels: Record<DealTriggerType, string> = {
  booking_confirmed: "Booking confirmed",
  pandadoc_status_changed: "PandaDoc status change",
  front_inbound_reply: "Inbound reply",
};

export const dealTriggerEventStatuses = [
  "pending",
  "processed",
  "skipped",
  "failed",
] as const;
export type DealTriggerEventStatus = (typeof dealTriggerEventStatuses)[number];

/**
 * Closed outcome vocabulary. `processed` rows carry deal_moved /
 * deal_created / already_in_stage / reply_logged; `skipped` rows explain
 * why no action was safe (no guessing — multiple open deals or a missing
 * PandaDoc deal link surface for a human instead).
 */
export const dealTriggerOutcomes = [
  "deal_moved",
  "deal_created",
  "already_in_stage",
  "already_past_stage",
  "reply_logged",
  "no_open_deal",
  "multiple_open_deals",
  "no_mapping",
  "no_deal_link",
  "deal_closed",
  "stage_not_found",
] as const;
export type DealTriggerOutcome = (typeof dealTriggerOutcomes)[number];

export const dealTriggerOutcomeLabels: Record<DealTriggerOutcome, string> = {
  deal_moved: "Deal moved",
  deal_created: "Deal created",
  already_in_stage: "Already in stage",
  already_past_stage: "Already past stage",
  reply_logged: "Reply logged",
  no_open_deal: "No open deal",
  multiple_open_deals: "Multiple open deals",
  no_mapping: "No mapping for status",
  no_deal_link: "Document not linked to a deal",
  deal_closed: "Deal already closed",
  stage_not_found: "Configured stage not found",
};

// ── Table ────────────────────────────────────────────────────────────────────

export const dealTriggerEvents = pgTable(
  "deal_trigger_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    triggerType: varchar("trigger_type", { length: 40 })
      .notNull()
      .$type<DealTriggerType>(),
    /** Deterministic replay-safety key — see header. UNIQUE. */
    eventKey: text("event_key").notNull(),
    /** Source record id (meeting id, pandadoc document row id, conversation id). */
    sourceId: text("source_id").notNull(),
    clientId: varchar("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    /** The deal the event acted on (or would have) — null until resolved. */
    dealId: varchar("deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    /** Normalized source context (status transition, message id, …). */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    status: varchar("status", { length: 16 })
      .default("pending")
      .notNull()
      .$type<DealTriggerEventStatus>(),
    outcome: varchar("outcome", { length: 40 }).$type<DealTriggerOutcome>(),
    /** deal_stage_history row written by this event's move, when it moved. */
    stageHistoryId: varchar("stage_history_id"),
    error: text("error"),
    attempts: integer("attempts").default(0).notNull(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    eventKeyUq: uniqueIndex("deal_trigger_events_event_key_uq").on(t.eventKey),
    typeCreatedIdx: index("deal_trigger_events_type_created_idx").on(
      t.triggerType,
      t.createdAt,
    ),
    sourceIdx: index("deal_trigger_events_source_idx").on(t.sourceId),
  }),
);

export type DealTriggerEvent = typeof dealTriggerEvents.$inferSelect;
export type InsertDealTriggerEvent = typeof dealTriggerEvents.$inferInsert;

// ── Config (system_settings keys + shapes) ───────────────────────────────────

export const DEAL_TRIGGERS_BOOKING_ENABLED_KEY = "deal_triggers_booking_enabled";
export const DEAL_TRIGGERS_BOOKING_STAGE_KEY = "deal_triggers_booking_stage_slug";
export const DEAL_TRIGGERS_PANDADOC_ENABLED_KEY = "deal_triggers_pandadoc_enabled";
export const DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY = "deal_triggers_pandadoc_stage_map";
export const DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY = "deal_triggers_front_reply_enabled";

export const DEAL_TRIGGERS_BOOKING_DEFAULT_STAGE_SLUG = "discovery-call";

/**
 * Raw PandaDoc status → deal stage slug (default pipeline). Stored as a
 * JSON string under DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY. Statuses the
 * vendor may add later are legal keys; the UI offers the known ones.
 */
export const pandadocStageMapSchema = z
  .record(z.string().trim().min(1).max(80), z.string().trim().min(1).max(80))
  .refine((m) => Object.keys(m).length <= 20, {
    message: "At most 20 status mappings",
  });
export type PandadocStageMap = z.infer<typeof pandadocStageMapSchema>;

/** Statuses the PandaDoc list API returns today (UI dropdown source). */
export const pandadocKnownStatuses = [
  "document.draft",
  "document.sent",
  "document.viewed",
  "document.waiting_approval",
  "document.approved",
  "document.rejected",
  "document.waiting_pay",
  "document.paid",
  "document.completed",
  "document.voided",
  "document.declined",
  "document.expired",
] as const;

/** Admin config surface shape (GET/PUT /api/deal-automation/triggers/config). */
export const dealTriggersConfigSchema = z.object({
  bookingEnabled: z.boolean(),
  bookingStageSlug: z.string().trim().min(1).max(80),
  pandadocEnabled: z.boolean(),
  pandadocStageMap: pandadocStageMapSchema,
  frontReplyEnabled: z.boolean(),
});
export type DealTriggersConfig = z.infer<typeof dealTriggersConfigSchema>;
