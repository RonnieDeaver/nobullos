/**
 * One-shot, restart-safe drain for verified Stripe book events parked by the
 * book_payment_processing kill switch. This is deliberately not a perpetual
 * poller: startup and switch release trigger bounded pages until the paused
 * lane is empty.
 */
import { withWorkerSingletonLock } from "./crossInstanceLock";
import {
  ensureKillSwitchesLoaded,
  isKillSwitchEnabled,
} from "./killSwitches";
import { replayPendingVerifiedBookEvents } from "../storage/bookCheckoutEngineStorage";

const WORKER_NAME = "book_payment_event_replay";
const PAGE_SIZE = 50;
const MAX_HOLD_MS = 60_000;

let inFlight: Promise<void> | null = null;
let continuationRequested = false;

async function runPage(trigger: string): Promise<void> {
  continuationRequested = false;
  await ensureKillSwitchesLoaded();
  if (isKillSwitchEnabled("book_payment_processing")) return;

  const lockResult = await withWorkerSingletonLock(
    WORKER_NAME,
    async () => {
      if (isKillSwitchEnabled("book_payment_processing")) return null;
      return replayPendingVerifiedBookEvents({
        limit: PAGE_SIZE,
        onlyPaused: true,
        effectsPaused: false,
      });
    },
    "[BookPaymentReplay]",
    { maxHoldMs: MAX_HOLD_MS },
  );

  if (!lockResult.ran || !lockResult.result) return;
  const result = lockResult.result;
  console.log(
    `[BookPaymentReplay] trigger=${trigger} attempted=${result.attempted} ` +
      `processed=${result.processed} reconciliation=${result.needsReconciliation} ` +
      `errors=${result.errors.length}`,
  );
  if (result.needsReconciliation > 0 || result.errors.length > 0) {
    console.error(
      `[BookPaymentReplay] ${result.needsReconciliation + result.errors.length} ` +
        "event(s) remain in durable reconciliation/exception state",
    );
  }
  continuationRequested ||= result.moreLikely;
}

/**
 * Start a bounded background catch-up. Concurrent local triggers coalesce;
 * the cluster-wide advisory lock ensures only one deployed instance drains.
 */
export function startBookPaymentEventReplay(trigger: "startup" | "switch_release" | "continuation"): void {
  continuationRequested = true;
  if (inFlight) return;
  inFlight = runPage(trigger)
    .catch((err) => {
      console.error("[BookPaymentReplay] drain failed:", err);
    })
    .finally(() => {
      inFlight = null;
      if (continuationRequested) {
        continuationRequested = false;
        queueMicrotask(() => startBookPaymentEventReplay("continuation"));
      }
    });
}