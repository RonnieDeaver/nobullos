// @db-pool-intent: ambient
//
// Task #3711 — storage helpers for the client-offboarding lifecycle
// (`client_offboardings`). This file calls `getDb()`; the intent above
// declares which pool every `getDb()` call in this module is expected to
// land on. See `scripts/lint-db-pool-tenancy.ts` for the contract and
// `server/db.ts` for the routing.
//
// Status lifecycle:
//   scheduled ──(sweep claims atomically)──▶ processing ──▶ completed
//       │  ▲                                     │
//       │  └──(step failure releases claim)──────┘
//       └──(operator cancels)──▶ cancelled
//
// `processing` is the sweep's execution claim: cancel and reschedule act
// only on `scheduled` rows, so once a record is claimed an operator can no
// longer mutate it out from under the running pipeline (they get a 409
// from the routes instead). A crash mid-pipeline leaves the row in
// `processing`; the next sweep re-claims it and resumes from the first
// incomplete step (steps are idempotent).

import {
  type ClientOffboarding,
  clientOffboardings,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

/** Statuses of records the offboarding pipeline still owns or will act on. */
const ACTIVE_STATUSES = ["scheduled", "processing"] as const;

/**
 * Thrown when an initiate/reschedule hits a record the sweep has claimed
 * (`processing`). Routes map this to a 409 — the pipeline is executing
 * right now and the operator must retry in a moment.
 */
export class OffboardingExecutingError extends Error {
  constructor(clientId: string) {
    super(`Offboarding for client ${clientId} is executing right now`);
    this.name = "OffboardingExecutingError";
  }
}

export interface ScheduleClientOffboardingResult {
  offboarding: ClientOffboarding;
  /** "initiated" = fresh record, "rescheduled" = an existing scheduled record's date moved. */
  action: "initiated" | "rescheduled";
  previousFinalServiceDate: string | null;
}

/**
 * The client's currently-active offboarding (scheduled or mid-execution),
 * if any. `scheduled` wins if a crash ever leaves both present.
 */
export async function getActiveOffboardingForClient(
  clientId: string,
): Promise<ClientOffboarding | undefined> {
  return withDbAttribution("clientOffboarding:getActive", async () => {
    const rows = await getDb()
      .select()
      .from(clientOffboardings)
      .where(
        and(
          eq(clientOffboardings.clientId, clientId),
          inArray(clientOffboardings.status, [...ACTIVE_STATUSES]),
        ),
      );
    return rows.find((r) => r.status === "scheduled") ?? rows[0];
  });
}

/** Batch lookup for list payload enrichment: clientId → active offboarding. */
export async function getActiveOffboardingsByClientIds(
  clientIds: string[],
): Promise<Map<string, ClientOffboarding>> {
  if (clientIds.length === 0) return new Map();
  return withDbAttribution("clientOffboarding:getActiveBatch", async () => {
    const rows = await getDb()
      .select()
      .from(clientOffboardings)
      .where(
        and(
          inArray(clientOffboardings.clientId, clientIds),
          inArray(clientOffboardings.status, [...ACTIVE_STATUSES]),
        ),
      );
    const map = new Map<string, ClientOffboarding>();
    for (const row of rows) {
      const current = map.get(row.clientId);
      if (!current || (current.status !== "scheduled" && row.status === "scheduled")) {
        map.set(row.clientId, row);
      }
    }
    return map;
  });
}

/**
 * Initiate a client's offboarding, or move the date of the already-scheduled
 * one. The partial unique index (`client_offboardings_one_scheduled_idx`)
 * guarantees at most one scheduled record per client — a lost initiate race
 * degrades into a reschedule of the winner's row instead of a 500.
 *
 * Throws {@link OffboardingExecutingError} when the record is `processing`
 * (the sweep claimed it): a reschedule mid-pipeline would be silently
 * ignored by the already-running steps, and a fresh insert would mint a
 * second active record for a client that is being archived this second.
 */
export async function scheduleClientOffboarding(
  clientId: string,
  finalServiceDate: string,
  actorUserId: string | null,
): Promise<ScheduleClientOffboardingResult> {
  return withDbAttribution("clientOffboarding:schedule", async () => {
    const reschedule = async (existing: ClientOffboarding): Promise<ScheduleClientOffboardingResult | null> => {
      const [updated] = await getDb()
        .update(clientOffboardings)
        .set({ finalServiceDate, updatedAt: new Date() })
        .where(and(eq(clientOffboardings.id, existing.id), eq(clientOffboardings.status, "scheduled")))
        .returning();
      if (!updated) return null; // status flipped concurrently — re-inspect below
      return {
        offboarding: updated,
        action: "rescheduled",
        previousFinalServiceDate: existing.finalServiceDate,
      };
    };

    const existing = await getActiveOffboardingForClient(clientId);
    if (existing?.status === "processing") throw new OffboardingExecutingError(clientId);
    if (existing) {
      const moved = await reschedule(existing);
      if (moved) return moved;
      // The scheduled row changed status between our read and update. If the
      // sweep claimed it we must NOT insert a sibling record.
      const recheck = await getActiveOffboardingForClient(clientId);
      if (recheck?.status === "processing") throw new OffboardingExecutingError(clientId);
    }

    try {
      const [inserted] = await getDb()
        .insert(clientOffboardings)
        .values({ clientId, finalServiceDate, initiatedByUserId: actorUserId })
        .returning();
      return { offboarding: inserted, action: "initiated", previousFinalServiceDate: null };
    } catch (err: any) {
      if (err?.code === "23505") {
        // Unique-index race: another request initiated between our select and
        // insert. Treat ours as a reschedule of that winner.
        const raced = await getActiveOffboardingForClient(clientId);
        if (raced?.status === "processing") throw new OffboardingExecutingError(clientId);
        if (raced) {
          const moved = await reschedule(raced);
          if (moved) return moved;
        }
      }
      throw err;
    }
  });
}

/**
 * Cancel the client's scheduled offboarding. Undefined when none is
 * `scheduled` — including when the sweep has already claimed the record
 * (`processing`); callers distinguish the two via
 * {@link getActiveOffboardingForClient}.
 */
export async function cancelScheduledOffboarding(
  clientId: string,
  actorUserId: string | null,
): Promise<ClientOffboarding | undefined> {
  return withDbAttribution("clientOffboarding:cancel", async () => {
    const [row] = await getDb()
      .update(clientOffboardings)
      .set({
        status: "cancelled",
        cancelledByUserId: actorUserId,
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(clientOffboardings.clientId, clientId), eq(clientOffboardings.status, "scheduled")))
      .returning();
    return row;
  });
}

/**
 * Offboardings the sweep must act on: final service day `todayIsoDate`
 * (YYYY-MM-DD, America/New_York) or earlier — `<=` makes a sweep that
 * missed a day (app down) catch up on its next run. Includes `processing`
 * rows: those are claims left behind by a crashed run, and the idempotent
 * step ledger makes resuming them safe.
 */
export async function listDueOffboardings(
  todayIsoDate: string,
): Promise<ClientOffboarding[]> {
  return withDbAttribution("clientOffboarding:listDue", async () => {
    return getDb()
      .select()
      .from(clientOffboardings)
      .where(
        and(
          inArray(clientOffboardings.status, [...ACTIVE_STATUSES]),
          lte(clientOffboardings.finalServiceDate, todayIsoDate),
        ),
      )
      .orderBy(clientOffboardings.finalServiceDate);
  });
}

/**
 * Atomically claim a due offboarding for pipeline execution. The guard
 * re-verifies status AND due date in the same UPDATE, so a cancel
 * (status → cancelled) or reschedule (date → future) that landed after the
 * sweep's list read makes the claim return `undefined` — the sweep then
 * skips the record without running any step. Returns the record's FRESH
 * state (the list read's copy may be stale).
 */
export async function claimOffboardingForProcessing(
  offboardingId: string,
  todayIsoDate: string,
): Promise<ClientOffboarding | undefined> {
  return withDbAttribution("clientOffboarding:claim", async () => {
    const [row] = await getDb()
      .update(clientOffboardings)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(clientOffboardings.id, offboardingId),
          inArray(clientOffboardings.status, [...ACTIVE_STATUSES]),
          lte(clientOffboardings.finalServiceDate, todayIsoDate),
        ),
      )
      .returning();
    return row;
  });
}

/**
 * Hand a claimed record back to the operator after a step failure:
 * processing → scheduled, so the offboarding is cancellable/reschedulable
 * again while it waits for the next sweep's retry. Best-effort — if this
 * fails the record stays `processing` and the next sweep re-claims it.
 */
export async function releaseOffboardingClaim(offboardingId: string): Promise<void> {
  await withDbAttribution("clientOffboarding:releaseClaim", async () => {
    await getDb()
      .update(clientOffboardings)
      .set({ status: "scheduled", updatedAt: new Date() })
      .where(and(eq(clientOffboardings.id, offboardingId), eq(clientOffboardings.status, "processing")));
  });
}

/**
 * Mark a claimed offboarding completed. Guarded on `status = 'processing'`
 * — only the sweep that holds the claim can complete a record, and a
 * re-run (or racing sibling) gets `undefined` instead of double-completing.
 */
export async function completeClientOffboarding(
  offboardingId: string,
): Promise<ClientOffboarding | undefined> {
  return withDbAttribution("clientOffboarding:complete", async () => {
    const [row] = await getDb()
      .update(clientOffboardings)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(clientOffboardings.id, offboardingId), eq(clientOffboardings.status, "processing")))
      .returning();
    return row;
  });
}

/**
 * Record a pipeline step's completion in `step_state` (idempotent tracking).
 * Atomic jsonb merge — never clobbers other steps' records.
 */
export async function recordOffboardingStepCompleted(
  offboardingId: string,
  stepId: string,
  completedAtIso: string,
): Promise<void> {
  await withDbAttribution("clientOffboarding:recordStep", async () => {
    await getDb()
      .update(clientOffboardings)
      .set({
        stepState: sql`${clientOffboardings.stepState} || jsonb_build_object(${stepId}::text, jsonb_build_object('completedAt', ${completedAtIso}::text))`,
        updatedAt: new Date(),
      })
      .where(eq(clientOffboardings.id, offboardingId));
  });
}
