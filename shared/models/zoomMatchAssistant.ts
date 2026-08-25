// Task #4057 — Zoom Transcript Match Assistant (manual year-back sweep).
//
// Two tables back the tool:
//
//   * `zoom_match_sweeps` — one row per operator-triggered sweep of the past
//     12 months of Zoom cloud recordings. The row carries the whole durable
//     progress surface the admin panel polls: per-window discovery status,
//     phase, and counters. The background job advances the row through
//     discovery → transcripts → analysis → done; analysis itself completes
//     asynchronously (per-record jobs keep bumping counters after the sweep
//     row is `completed`).
//
//   * `zoom_transcript_match_analyses` — one row per analyzed Zoom call
//     (unique on record id). Holds the AI's guessed client, confidence,
//     rationale, call summary, and the names involved. Re-runs skip records
//     that already have an `analyzed` row; a forced re-analysis flips the row
//     to `pending` and overwrites it when the job lands.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { clients } from "./clients";
import { rawCommunicationRecords } from "./communications";

export const zoomMatchSweepStatuses = ["running", "completed", "failed"] as const;
export type ZoomMatchSweepStatus = (typeof zoomMatchSweepStatuses)[number];

export const zoomMatchSweepPhases = ["discovery", "transcripts", "analysis", "done"] as const;
export type ZoomMatchSweepPhase = (typeof zoomMatchSweepPhases)[number];

/** One ~30-day Zoom listing window inside a sweep (stored in windows_json). */
export interface ZoomMatchSweepWindow {
  /** Inclusive YYYY-MM-DD bounds passed to the Zoom recordings listing. */
  from: string;
  to: string;
  status: "pending" | "done" | "failed";
  /** Recordings the listing returned for this window. */
  meetingsFound?: number;
  /** Recording events that were new (not deduplicated) → apply jobs enqueued. */
  newMeetingEvents?: number;
  /** Transcript-file events that were new → transcript-apply jobs enqueued. */
  newTranscriptEvents?: number;
  error?: string;
}

/** Cumulative sweep counters (stored in counters_json). */
export interface ZoomMatchSweepCounters {
  meetingsFound: number;
  meetingsIngestEnqueued: number;
  transcriptsDownloaded: number;
  transcriptsUnavailable: number;
  transcriptsGenerating: number;
  transcriptsFailed: number;
  transcriptsSkipped: number;
  transcriptsChecked: number;
  analysesEnqueued: number;
  callsAnalyzed: number;
  analysesFailed: number;
  analysesSkipped: number;
}

export const emptyZoomMatchSweepCounters = (): ZoomMatchSweepCounters => ({
  meetingsFound: 0,
  meetingsIngestEnqueued: 0,
  transcriptsDownloaded: 0,
  transcriptsUnavailable: 0,
  transcriptsGenerating: 0,
  transcriptsFailed: 0,
  transcriptsSkipped: 0,
  transcriptsChecked: 0,
  analysesEnqueued: 0,
  callsAnalyzed: 0,
  analysesFailed: 0,
  analysesSkipped: 0,
});

/** Cross-run cursor state for the transcripts/analysis phases (phase_state_json). */
export interface ZoomMatchSweepPhaseState {
  /** Keyset cursor over (timestamp, id) for the transcript backfill walk. */
  transcriptCursor?: { ts: string; id: string } | null;
  /** Keyset cursor over (timestamp, id) for the analysis-enqueue walk. */
  analysisCursor?: { ts: string; id: string } | null;
  /** How many times the transcripts phase has waited for apply jobs to drain. */
  applyDrainWaits?: number;
  /**
   * Monotonic slice counter. Every committed advance increments it inside a
   * compare-and-set UPDATE guarded on the previous value, so a stale or
   * raced advance (work-queue retry overlapping its own continuation) can
   * never double-count a slice or fork the continuation chain — the loser
   * observes 0 updated rows and returns without enqueueing.
   */
  step?: number;
  /**
   * Bounded in-flight retry marker for a transcript record whose backfill
   * THREW (vs returning a terminal outcome): the keyset cursor holds just
   * before the record until it succeeds or exhausts its attempts, so a
   * throwing record is never silently skipped by cursor advancement.
   */
  transcriptRetry?: { id: string; attempts: number } | null;
  /**
   * Records whose backfill kept throwing after the bounded attempts —
   * surfaced explicitly in the sweep status (capped list) instead of
   * disappearing; a fresh sweep re-enumerates and retries them.
   */
  transcriptFailures?: Array<{ recordId: string; error: string }>;
  /** Times the status poll re-enqueued a continuation for a silent chain. */
  resumeCount?: number;
}

export const zoomMatchSweeps = pgTable(
  "zoom_match_sweeps",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    status: varchar("status").notNull().default("running"),
    phase: varchar("phase").notNull().default("discovery"),
    startedByUserId: varchar("started_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    windowsJson: jsonb("windows_json").$type<ZoomMatchSweepWindow[]>().notNull(),
    countersJson: jsonb("counters_json").$type<ZoomMatchSweepCounters>().notNull(),
    phaseStateJson: jsonb("phase_state_json")
      .$type<ZoomMatchSweepPhaseState>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastError: text("last_error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("zoom_match_sweeps_status_idx").on(table.status),
    startedAtIdx: index("zoom_match_sweeps_started_at_idx").on(table.startedAt),
  }),
);

export type ZoomMatchSweep = typeof zoomMatchSweeps.$inferSelect;
export type InsertZoomMatchSweep = typeof zoomMatchSweeps.$inferInsert;

export const zoomTranscriptMatchAnalysisStatuses = ["pending", "analyzed", "failed"] as const;
export type ZoomTranscriptMatchAnalysisStatus =
  (typeof zoomTranscriptMatchAnalysisStatuses)[number];

export const zoomTranscriptMatchAnalyses = pgTable(
  "zoom_transcript_match_analyses",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recordId: varchar("record_id")
      .notNull()
      .references(() => rawCommunicationRecords.id, { onDelete: "cascade" }),
    sweepId: varchar("sweep_id").references(() => zoomMatchSweeps.id, {
      onDelete: "set null",
    }),
    status: varchar("status").notNull(),
    guessedClientId: varchar("guessed_client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    confidence: real("confidence"),
    rationale: text("rationale"),
    callSummary: text("call_summary"),
    /** "existing" when reusing the record's aiSummary, "generated" otherwise. */
    summarySource: varchar("summary_source"),
    namesJson: jsonb("names_json").$type<string[]>(),
    model: varchar("model"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    analyzedAt: timestamp("analyzed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    recordIdUq: uniqueIndex("ztma_record_id_uq").on(table.recordId),
    statusIdx: index("ztma_status_idx").on(table.status),
    guessedClientIdx: index("ztma_guessed_client_idx").on(table.guessedClientId),
    sweepIdx: index("ztma_sweep_idx").on(table.sweepId),
  }),
);

export type ZoomTranscriptMatchAnalysis = typeof zoomTranscriptMatchAnalyses.$inferSelect;
export type InsertZoomTranscriptMatchAnalysis = typeof zoomTranscriptMatchAnalyses.$inferInsert;
