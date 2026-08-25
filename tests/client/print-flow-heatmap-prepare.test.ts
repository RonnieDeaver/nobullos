/* test-registration
{
  "name": "PDF print flow waits for heatmap preparers (Task #1651)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression test for Task #1647 (and follow-up Task #1651): the public
 * report's Save-as-PDF flow must await every registered heatmap preparer
 * AND flip `setHeatmapPrintMode(true)` BEFORE calling `window.print()`,
 * or MapLibre WebGL heatmaps print as blank canvases.
 *
 * Rather than mount the entire PublicReport page, we exercise the
 * extracted orchestration helper `runHeatmapPrintSequence` (which the
 * PublicReport print-countdown effect now calls when the countdown
 * reaches zero). This test is the guard the task description asks for:
 *
 *   1. The fake preparer registered via registerHeatmapPrintPreparer
 *      finishes before window.print() fires.
 *   2. setHeatmapPrintMode(true) is observable (via subscribeHeatmapPrintMode)
 *      before window.print() fires.
 *   3. setHeatmapPrintMode(false) is called after print completes.
 *   4. A preparer that never resolves does not deadlock the flow — the
 *      timeout inside prepareAllHeatmapsForPrint kicks in and print still
 *      fires.
 */

import {
  registerHeatmapPrintPreparer,
  runHeatmapPrintSequence,
  subscribeHeatmapPrintMode,
  getHeatmapPrintMode,
} from "../../client/src/lib/heatmapPrintRegistry";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

interface PrintEvent {
  type: "preparer-start" | "preparer-end" | "print-mode-on" | "print-mode-off" | "print";
  at: number;
}

function makeRecorder() {
  const events: PrintEvent[] = [];
  const push = (type: PrintEvent["type"]) =>
    events.push({ type, at: events.length });
  return { events, push };
}

async function testHappyPathOrdering(): Promise<void> {
  const { events, push } = makeRecorder();

  let resolvePreparer: () => void = () => {};
  const preparerDone = new Promise<void>((r) => {
    resolvePreparer = r;
  });
  const unregister = registerHeatmapPrintPreparer(async () => {
    push("preparer-start");
    await preparerDone;
    push("preparer-end");
  });

  const unsubscribe = subscribeHeatmapPrintMode((v) => {
    push(v ? "print-mode-on" : "print-mode-off");
  });

  let printCalled = false;
  const sequence = runHeatmapPrintSequence({
    print: () => {
      printCalled = true;
      push("print");
    },
    prepareTimeoutMs: 5000,
    beforePrintDelayMs: 5,
    afterPrintDelayMs: 5,
  });

  // Yield so the preparer kicks off and we observe it has actually started
  // and is blocking the sequence (no print mode flip, no print call).
  await new Promise((r) => setTimeout(r, 20));
  assert(
    events.some((e) => e.type === "preparer-start"),
    "preparer must have been invoked once the sequence starts",
  );
  assert(
    !events.some((e) => e.type === "print-mode-on"),
    "setHeatmapPrintMode(true) must NOT fire while preparer is still pending",
  );
  assert(!printCalled, "window.print must NOT fire while preparer is still pending");

  // Release the preparer; sequence should now flip print mode on, wait the
  // before-print delay, then call print, then wait, then flip print mode off.
  resolvePreparer();
  await sequence;

  const order = events.map((e) => e.type);
  const idx = (t: PrintEvent["type"]) => order.indexOf(t);

  assert(idx("preparer-start") === 0, `preparer-start must be first event, got ${order.join(",")}`);
  assert(
    idx("preparer-end") < idx("print-mode-on"),
    `preparer must resolve before print mode flips on; got ${order.join(",")}`,
  );
  assert(
    idx("print-mode-on") < idx("print"),
    `setHeatmapPrintMode(true) must be observable before window.print(); got ${order.join(",")}`,
  );
  assert(
    idx("preparer-end") < idx("print"),
    `preparer must finish before window.print(); got ${order.join(",")}`,
  );
  assert(
    idx("print") < idx("print-mode-off"),
    `setHeatmapPrintMode(false) must be called after window.print(); got ${order.join(",")}`,
  );
  assert(printCalled, "window.print must have been called");
  assert(
    getHeatmapPrintMode() === false,
    "heatmap print mode must be cleared after the sequence completes",
  );

  unregister();
  unsubscribe();
}

async function testHungPreparerDoesNotDeadlock(): Promise<void> {
  const { events, push } = makeRecorder();

  // A preparer that never resolves. The timeout inside
  // prepareAllHeatmapsForPrint must keep the flow alive.
  const unregister = registerHeatmapPrintPreparer(
    () => new Promise<void>(() => {}),
  );

  const unsubscribe = subscribeHeatmapPrintMode((v) => {
    push(v ? "print-mode-on" : "print-mode-off");
  });

  let printCalled = false;
  const start = Date.now();
  await runHeatmapPrintSequence({
    print: () => {
      printCalled = true;
      push("print");
    },
    prepareTimeoutMs: 50,
    beforePrintDelayMs: 5,
    afterPrintDelayMs: 5,
  });
  const elapsed = Date.now() - start;

  assert(
    printCalled,
    "window.print must still fire even when a registered preparer never resolves (preparer timeout must kick in)",
  );
  assert(
    elapsed < 1500,
    `sequence with a hung preparer must complete well under 1.5s thanks to the prepareTimeoutMs guard; took ${elapsed}ms`,
  );
  const order = events.map((e) => e.type);
  assert(
    order.indexOf("print-mode-on") < order.indexOf("print"),
    `setHeatmapPrintMode(true) must still be observable before print in the hung-preparer path; got ${order.join(",")}`,
  );
  assert(
    order.indexOf("print") < order.indexOf("print-mode-off"),
    `setHeatmapPrintMode(false) must still fire after print in the hung-preparer path; got ${order.join(",")}`,
  );
  assert(
    getHeatmapPrintMode() === false,
    "heatmap print mode must be cleared after the hung-preparer sequence completes",
  );

  unregister();
  unsubscribe();
}

async function main(): Promise<void> {
  await testHappyPathOrdering();
  await testHungPreparerDoesNotDeadlock();
  console.log("print-flow-heatmap-prepare: all cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
