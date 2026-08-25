/**
 * Task #3711 — client offboarding step pipeline + daily sweep.
 *
 * An operator schedules a client's final day of service (POST
 * /api/clients/:id/offboarding). This sweep — run every morning by
 * clientOffboardingScheduler.ts — finds offboardings whose final day is
 * today or earlier (America/New_York; `<=` means a missed day is caught
 * up on the next run) and executes the ordered step pipeline below for
 * each.
 *
 * CLAIM SEMANTICS (race-safety vs cancel/reschedule): before any step
 * runs, the record is atomically claimed (`scheduled` → `processing`)
 * with a status + due-date guard. A cancel or reschedule that landed
 * after the sweep's list read defeats the claim, and the sweep skips the
 * record untouched. While a claim is held, cancel/reschedule requests get
 * a 409 from the routes. On step failure the claim is released
 * (`processing` → `scheduled`) so the operator regains control while the
 * record waits for the next sweep's retry; on a crash the claim survives
 * and the next sweep re-claims and resumes it.
 *
 * EXTENSION POINT: future offboarding steps (ClickUp task creation,
 * Slack goodbye sequences, T-minus-N-day reminders) are added by
 * appending to `OFFBOARDING_STEPS`. Contract for every step:
 *   - stable `id` (recorded in client_offboardings.step_state — never
 *     rename an id once shipped, or completed runs will re-execute it);
 *   - runs at most once per offboarding: completion is recorded in
 *     step_state before the record is marked completed, so a resumed
 *     pipeline continues from the first incomplete step;
 *   - must still be idempotent (a crash BETWEEN run and record re-runs
 *     it on the next sweep);
 *   - throws on failure — the claim is released and the next sweep
 *     retries from the first incomplete step.
 */
import { storage } from "../storage";
import {
  claimOffboardingForProcessing,
  completeClientOffboarding,
  listDueOffboardings,
  recordOffboardingStepCompleted,
  releaseOffboardingClaim,
} from "../storage/clientOffboardingStorage";
import { archiveClientWithSideEffects } from "./clientArchive";
import type { Client, ClientOffboarding, ClientOffboardingStepState } from "@shared/schema";

export interface OffboardingStepContext {
  offboarding: ClientOffboarding;
  client: Client;
}

export interface OffboardingStepDef {
  /** Stable id recorded in client_offboardings.step_state. Never rename. */
  id: string;
  label: string;
  run: (ctx: OffboardingStepContext) => Promise<void>;
}

export const OFFBOARDING_STEPS: OffboardingStepDef[] = [
  {
    id: "archive_client",
    label: "Archive client",
    run: async ({ client }) => {
      // Same code path as the manual Archive action (shared helper) —
      // includes the comms-channel archive side effect.
      await archiveClientWithSideEffects(client.id);
    },
  },
  // Future steps (ClickUp offboarding task, Slack sequence, T-minus
  // reminders) go here — see the contract in the module doc above.
];

export const OFFBOARD_COMPLETED_NOTIFICATION_ID = "workflow.client_offboarding.completed";

/** Calendar date (YYYY-MM-DD) for `now` in America/New_York. */
export function todayInNewYork(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface OffboardingSweepResult {
  /** Offboardings due (final day today or earlier), before claiming. */
  due: number;
  /** Offboardings whose full pipeline ran and were marked completed. */
  completed: number;
  /** Due records whose claim was defeated (cancelled/rescheduled/completed under us). */
  skipped: number;
  errors: number;
}

type OffboardCompletedNotifier = (client: Client, offboarding: ClientOffboarding) => Promise<void>;

async function notifyOffboardCompleted(client: Client, offboarding: ClientOffboarding): Promise<void> {
  const { notifyByType } = await import("./notifications/dispatcher");
  await notifyByType(
    OFFBOARD_COMPLETED_NOTIFICATION_ID,
    {
      text:
        `Client offboarding completed: ${client.firmName ?? client.id} reached its final day of service ` +
        `(${offboarding.finalServiceDate}) and was automatically archived. ` +
        `It no longer appears in the default client list or dashboards.`,
    },
    {
      triggerSource: "scheduled",
      // Dedupe per client — a sweep re-run inside the dispatcher's dedupe
      // window can't double-announce the same client's offboard.
      dedupeKey: `client-offboarding:${client.id}`,
    },
  );
}

// Test seam: the sweep test swaps in a capture function so exercising the
// pipeline doesn't drive the real Slack/in-app dispatcher.
let notifierOverride: OffboardCompletedNotifier | null = null;
export function __test_setOffboardCompletedNotifier(fn: OffboardCompletedNotifier | null): void {
  notifierOverride = fn;
}

// Test seam: invoked per due record AFTER the list read and BEFORE the
// claim — lets the race test deterministically cancel/reschedule a record
// in exactly the window the claim guard exists for.
type BeforeClaimHook = (offboarding: ClientOffboarding) => Promise<void>;
let beforeClaimHook: BeforeClaimHook | null = null;
export function __test_setBeforeClaimHook(fn: BeforeClaimHook | null): void {
  beforeClaimHook = fn;
}

/**
 * Execute every due offboarding. Designed to be safe to call repeatedly
 * (atomic claims + idempotent step tracking + claim-guarded completion)
 * and from the boot catch-up tick as well as the daily cron.
 */
export async function runClientOffboardingSweep(now: Date = new Date()): Promise<OffboardingSweepResult> {
  const today = todayInNewYork(now);
  const due = await listDueOffboardings(today);
  const result: OffboardingSweepResult = { due: due.length, completed: 0, skipped: 0, errors: 0 };

  for (const dueRecord of due) {
    let claimed: ClientOffboarding | undefined;
    try {
      if (beforeClaimHook) await beforeClaimHook(dueRecord);

      // Atomically claim (status + due-date re-verified in one UPDATE). A
      // cancel/reschedule that landed since the list read defeats the claim
      // and we must not touch the client.
      claimed = await claimOffboardingForProcessing(dueRecord.id, today);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      const client = await storage.getClient(claimed.clientId);
      if (!client) {
        // Unreachable in practice (FK cascade removes offboardings with the
        // client) — but never silently complete a record we couldn't act on.
        console.error(
          `[ClientOffboardingSweep] Client ${claimed.clientId} missing for offboarding ${claimed.id} — releasing claim`,
        );
        result.errors += 1;
        await releaseOffboardingClaim(claimed.id);
        continue;
      }

      // Use the claim's FRESH step state, not the (possibly stale) list row.
      const stepState = (claimed.stepState ?? {}) as ClientOffboardingStepState;
      for (const step of OFFBOARDING_STEPS) {
        if (stepState[step.id]?.completedAt) continue; // already ran on a prior pass
        await step.run({ offboarding: claimed, client });
        await recordOffboardingStepCompleted(claimed.id, step.id, new Date().toISOString());
      }

      const completed = await completeClientOffboarding(claimed.id);
      if (!completed) {
        // Only possible if something external mutated a claimed row —
        // the guard kept us from double-completing. Nothing more to do.
        result.skipped += 1;
        continue;
      }
      result.completed += 1;
      console.log(
        `[ClientOffboardingSweep] Offboarded ${client.firmName ?? client.id} (final day ${claimed.finalServiceDate})`,
      );

      // Completion audit entry — system actor (userId null), same shape as
      // the client CRUD audit rows so the client History popover renders it.
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        await insertActivityLogs([
          {
            userId: null,
            actionType: "client_offboarding_completed",
            route: `/clients/${client.id}`,
            actionDetail: `Offboarding completed — ${client.firmName ?? client.id} auto-archived on final day of service ${claimed.finalServiceDate}`,
            metadata: {
              clientId: client.id,
              clientFirmName: client.firmName ?? null,
              finalServiceDate: claimed.finalServiceDate,
              offboardingId: claimed.id,
              steps: OFFBOARDING_STEPS.map((s) => s.id),
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          },
        ]);
      } catch (logErr: any) {
        console.error("[ClientOffboardingSweep] Completion audit log failed:", logErr?.message ?? logErr);
      }

      // Operator-facing completion notification (in-app mirror + Slack via
      // the dispatcher). Best-effort — the archive already happened.
      try {
        await (notifierOverride ?? notifyOffboardCompleted)(client, claimed);
      } catch (notifyErr: any) {
        console.warn(
          "[ClientOffboardingSweep] Completion notification failed (non-fatal):",
          notifyErr?.message ?? notifyErr,
        );
      }
    } catch (err: any) {
      // One bad record must not block the rest of the day's offboards.
      console.error(
        `[ClientOffboardingSweep] Offboarding ${dueRecord.id} (client ${dueRecord.clientId}) failed:`,
        err?.message ?? err,
      );
      result.errors += 1;
      if (claimed) {
        // Hand the record back to the operator (processing → scheduled) so
        // it stays cancellable while waiting for the next sweep's retry.
        // Best-effort: if THIS fails too, the claim survives and the next
        // sweep re-claims and resumes it.
        try {
          await releaseOffboardingClaim(claimed.id);
        } catch (releaseErr: any) {
          console.error(
            `[ClientOffboardingSweep] Failed to release claim on ${claimed.id} (next sweep will resume it):`,
            releaseErr?.message ?? releaseErr,
          );
        }
      }
    }
  }

  return result;
}
