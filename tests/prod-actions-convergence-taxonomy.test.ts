/* test-registration
{
  "name": "Prod-action convergence taxonomy + feeder closures (Task #4054)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4054: framework guard for the CEO badge-zero contract — every registered prod-action must declare converging vs continuous (continuous requires a named always-on drain loop), the auto-managed loop-health derivation must fail toward visibility, and the three ingest-time feeder closures (Common Issues normalize-before-stamp, heatmap snapshot client resolution, Front matched-conversation attribution) must keep their predicates. A new action shipping a pending feed with no terminal-stamping or ingest-closure story fails here.",
  "scanPaths": [
    "server/services/prodActionsRegistry.ts",
    "server/services/prodActions"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4054 — "Make the CEO prod-actions badge hit zero and stay there."
 *
 * Part A — real-registry taxonomy invariants: every action declares its
 *          convergence class; continuous actions name their drain loop and
 *          have either self-heal enrollment or a loopHealth probe; the
 *          specific actions this task classified keep their classes.
 * Part B — assertProdActionConvergenceInvariants rejects synthetic
 *          violations (missing declaration, unnamed loop, continuous with
 *          no drain loop, duplicate id) so the next feature cannot ship a
 *          silently-recurring pending feed.
 * Part C — evaluateContinuousLoopHealth derivation: probe passthrough,
 *          probe failure => unhealthy (fail toward visibility), self-heal
 *          master OFF => unhealthy, enrolled-but-not-yet-run => healthy,
 *          persistent failure streak >= alert threshold => unhealthy.
 * Part D — Common Issues feeder closure: finalizeCommonIssuesForStorage
 *          normalizes on write and its output can never be flagged by the
 *          malformed-shape detector again (sections are stored well-formed,
 *          so the repair arm stops finding freshly-imported rows).
 * Part E — heatmap client-link feeder closure: the ingest-time resolver
 *          shares the backfill's unambiguous campaign→client rule (single
 *          binding resolves; ambiguous or unmatched stays NULL).
 * Part F — Front attribution feeder closure: the ingest-time resolver only
 *          attributes matched conversations with a live (non-archived)
 *          client, mirroring the backfill's phase-1 predicate.
 *
 * Isolation: Parts E/F run inside runInTxSandbox — the heatmap resolver
 * takes an explicit db handle (the sandbox tx) and the attribution resolver
 * goes through storage, whose getDb() is pinned to the sandbox.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  clients,
  clientLocations,
  frontSyncEmails,
  semrushLocationCampaigns,
  clientSemrushIntegrations,
} from "@shared/schema";
import {
  PROD_ACTIONS,
  assertProdActionConvergenceInvariants,
  evaluateContinuousLoopHealth,
  getProdActionStatuses,
  type ProdAction,
} from "../server/services/prodActionsRegistry";
import { evaluateSelfHealEnrollmentHealth } from "../server/services/prodActions/engine";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { SETTING_ENABLED } from "../server/services/prodActionSelfHeal";
import {
  finalizeCommonIssuesForStorage,
  needsCommonIssuesStructureRepair,
} from "../server/services/commonIssuesFormatter";
import { resolveUnambiguousClientForCampaign } from "../server/services/heatmapClientBackfill";
import { resolveMatchedClientForConversation } from "../server/services/frontThreadAttribution";

function mkAction(overrides: Partial<ProdAction> & { id: string }): ProdAction {
  return {
    title: "synthetic",
    description: "synthetic",
    change: "synthetic",
    convergence: { kind: "converging" },
    status: async () => ({ state: "not-needed", detail: "" }),
    apply: async () => ({ state: "not-needed", detail: "" }),
    ...overrides,
  } as ProdAction;
}

const emptyReadout = { enabled: false, actions: {} as Record<string, any> };

async function partA_realRegistryInvariants() {
  // The module-load assertion already ran at import time; re-run explicitly
  // so a regression fails HERE with a readable message, not at import.
  assertProdActionConvergenceInvariants();

  let converging = 0;
  let continuous = 0;
  for (const action of PROD_ACTIONS) {
    const conv = action.convergence;
    assert.ok(
      conv && (conv.kind === "converging" || conv.kind === "continuous"),
      `action ${action.id} must declare convergence`,
    );
    if (conv.kind === "continuous") {
      continuous++;
      assert.ok(
        typeof conv.loop === "string" && conv.loop.trim().length > 0,
        `continuous action ${action.id} must name its drain loop`,
      );
      // THE framework guard: a continuous pending feed must have an
      // always-on drain — self-heal enrollment or an external-loop probe.
      assert.ok(
        action.selfHeal != null || typeof conv.loopHealth === "function",
        `continuous action ${action.id} has no drain loop (selfHeal or loopHealth)`,
      );
    } else {
      converging++;
    }
  }
  assert.equal(converging + continuous, PROD_ACTIONS.length);
  assert.ok(continuous >= 20, `expected the enrolled maintenance set to be continuous (got ${continuous})`);

  const byId = new Map(PROD_ACTIONS.map((a) => [a.id, a]));
  // Task #4054 trio + walkers keep their classes.
  const attribution = byId.get("backfill_front_message_attribution")!;
  assert.equal(attribution.convergence.kind, "continuous");
  assert.ok(attribution.selfHeal, "attribution drain must be self-heal enrolled");

  for (const id of ["trigger_front_reconciliation_sweep", "trigger_front_auto_closure_tick"]) {
    const trigger = byId.get(id)!;
    assert.equal(trigger.convergence.kind, "continuous", id);
    assert.equal(
      typeof (trigger.convergence as any).loopHealth,
      "function",
      `${id} must probe its external scheduler`,
    );
  }

  for (const id of [
    "reach_front_coverage_full_message_grain",
    "front_recent_window_message_freshness",
    "recover_front_plan_limited_messages",
    "finish_front_message_grain_coverage",
    "study_materialized_front_messages",
  ]) {
    assert.equal(byId.get(id)?.convergence.kind, "continuous", `walker ${id} must be continuous`);
  }

  // Feeder-closed backfills stay converging: after #4054 their inflow is
  // resolved at ingest, so fresh pending = genuine incident.
  for (const id of [
    "backfill_heatmap_snapshot_client_links",
    "reformat_common_issues_all_reports",
    "clear_placeholder_common_issues",
  ]) {
    assert.equal(byId.get(id)?.convergence.kind, "converging", `${id} must be converging`);
  }

  // Task #4762 — REQUIRED drain declaration over the real registry: every
  // converging action states how it reaches zero without a human, and the
  // three paths never overlap. This is the "zero by default" contract —
  // a converging action with none of the three cannot ship.
  let enrolled = 0;
  let levers = 0;
  let humanGated = 0;
  for (const action of PROD_ACTIONS) {
    if (action.convergence.kind !== "converging") continue;
    const paths = [
      action.selfHeal != null,
      action.manualLever === true,
      action.humanGate != null,
    ].filter(Boolean).length;
    assert.equal(
      paths,
      1,
      `converging action ${action.id} must declare exactly ONE drain path (selfHeal | manualLever | humanGate), got ${paths}`,
    );
    if (action.selfHeal != null) enrolled++;
    else if (action.manualLever === true) levers++;
    else humanGated++;
    if (action.humanGate) {
      assert.ok(
        action.humanGate.reason.trim().length > 0,
        `${action.id} humanGate reason must be non-empty (it renders beside the amber row)`,
      );
    }
  }
  assert.ok(enrolled >= 4, `expected ≥4 enrolled converging actions (got ${enrolled})`);
  assert.ok(levers >= 4, `expected ≥4 manual levers (got ${levers})`);
  assert.ok(humanGated >= 1, `expected ≥1 human-gated converging action (got ${humanGated})`);

  // Task #4762 — the five newly-enrolled stranded converging actions all
  // self-drain on the mop-up cadence (6h cadence / 6h backoff).
  for (const id of [
    "rematch_unmatched_front_backlog",
    "heal_imported_fabricated_zero_metrics",
    "retire_legacy_zoom_oauth_tokens",
    "backfill_seasonal_trend_ai_commentary",
  ]) {
    const a = byId.get(id);
    assert.ok(a, `${id} must be registered`);
    assert.equal(a!.convergence.kind, "converging", `${id} must be converging`);
    assert.deepEqual(
      a!.selfHeal,
      { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
      `${id} must be enrolled at 6h/6h`,
    );
  }
  const freshSlate = byId.get("rejudge_stale_client_judgments");
  assert.ok(freshSlate, "fresh-slate rating action must be registered");
  assert.equal(freshSlate!.manualLever, true, "irreversible rating cleanup must be a manual lever");
  assert.equal(freshSlate!.selfHeal, undefined, "irreversible rating cleanup must never self-heal");
  assert.ok(
    freshSlate!.destructiveConfirmation?.phrase.trim(),
    "irreversible rating cleanup must require a typed destructive confirmation",
  );

  // Task #4762 — served-purpose retirement probes on exactly the levers /
  // one-shot residue actions whose "done" state is verifiable.
  for (const id of [
    "delete_google_drive_legacy_sa_key",
    "zoom_s2s_rollback_to_oauth",
    "cleanup_inactive_product_report_blocks",
    "ads-os-reconcile-practice-areas",
  ]) {
    const a = byId.get(id);
    assert.ok(a, `${id} must be registered`);
    assert.equal(a!.manualLever, true, `${id} must be a manual lever`);
    assert.equal(
      typeof a!.servedPurpose,
      "function",
      `${id} must carry a servedPurpose retirement probe`,
    );
  }

  // Task #4762 — the SEMrush on-demand nudge is human-gated (the scheduled
  // keep-alive loop owns routine freshness; auto-firing would duplicate it).
  const nudge = byId.get("semrush_keepalive_rotate_now")!;
  assert.equal(nudge.convergence.kind, "converging");
  assert.ok(nudge.humanGate, "semrush_keepalive_rotate_now must declare humanGate");

  console.log(
    `Part A ok — ${PROD_ACTIONS.length} actions (${converging} converging: ${enrolled} enrolled / ${levers} levers / ${humanGated} human-gated; ${continuous} continuous)`,
  );
}

async function partB_syntheticViolations() {
  // Missing declaration.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({ id: "no_convergence", convergence: undefined as any }),
      ]),
    /must declare convergence/,
  );
  // Continuous with an unnamed loop.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "unnamed_loop",
          convergence: { kind: "continuous", loop: "  " } as any,
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
        }),
      ]),
    /must name the always-on loop/,
  );
  // Continuous with NO drain loop at all — the exact anti-pattern this
  // task closes: a pending feed that only a manual button ever drains.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "recurring_with_no_drain",
          convergence: { kind: "continuous", loop: "imaginary cron" },
        }),
      ]),
    /neither self-heal enrollment nor a loopHealth probe/,
  );
  // Duplicate id. (Both carry a valid drain declaration so the loop
  // reaches the SECOND item's duplicate check instead of throwing the
  // #4762 no-drain-path error on the first.)
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({ id: "dup", humanGate: { reason: "synthetic" } }),
        mkAction({ id: "dup", humanGate: { reason: "synthetic" } }),
      ]),
    /duplicate action id/,
  );

  // Task #4762 — the required drain declaration. A converging action with
  // NO path to zero (not enrolled, not a lever, no human-gate reason) is
  // exactly the "ships pending, waits for a human forever" class this
  // task closes; it must fail at module load.
  assert.throws(
    () => assertProdActionConvergenceInvariants([mkAction({ id: "no_drain_path" })]),
    /declares NO drain path/,
  );
  // A lever must never auto-fire.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "lever_and_enrolled",
          manualLever: true,
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
        }),
      ]),
    /BOTH manualLever and selfHeal/,
  );
  // humanGate is mutually exclusive with the no-human drain paths.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "gate_and_enrolled",
          humanGate: { reason: "why" },
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
        }),
      ]),
    /mutually exclusive/,
  );
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "gate_and_lever",
          humanGate: { reason: "why" },
          manualLever: true,
        }),
      ]),
    /mutually exclusive/,
  );
  // The gate reason is operator-facing — blank is not a declaration.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({ id: "empty_gate_reason", humanGate: { reason: "   " } }),
      ]),
    /empty reason/,
  );
  // Continuous actions: their drain story is the named loop — the
  // converging-only declarations are contradictions there.
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "continuous_with_gate",
          convergence: { kind: "continuous", loop: "loop" },
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
          humanGate: { reason: "why" },
        }),
      ]),
    /must not declare humanGate/,
  );
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "continuous_lever",
          convergence: { kind: "continuous", loop: "loop" },
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
          manualLever: true,
        }),
      ]),
    /must not be a manual lever/,
  );
  assert.throws(
    () =>
      assertProdActionConvergenceInvariants([
        mkAction({
          id: "continuous_served",
          convergence: { kind: "continuous", loop: "loop" },
          selfHeal: { cadenceMs: 1, backoffMs: 1 },
          servedPurpose: async () => ({ served: true }),
        }),
      ]),
    /must not declare servedPurpose/,
  );
  console.log("Part B ok — synthetic violations rejected");
}

// The invariants only bite if the registry ACTUALLY invokes them at module
// load — a merge/rebase once silently dropped the top-level call while
// keeping the function definition, leaving the boot-time guard inert.
// Assert the source contains the bare top-level invocation line (column 0,
// not inside a comment or another function's body).
async function partB2_moduleLoadInvocationPresent() {
  const src = await fs.readFile(
    path.join(process.cwd(), "server/services/prodActionsRegistry.ts"),
    "utf8",
  );
  assert.match(
    src,
    /^assertProdActionConvergenceInvariants\(\);$/m,
    "prodActionsRegistry.ts must invoke assertProdActionConvergenceInvariants() at top level (module load) — the definition alone enforces nothing",
  );
  console.log("Part B2 ok — module-load invocation present in registry source");
}

async function partC_loopHealthDerivation() {
  // Converging action is never "loop-healthy".
  const conv = await evaluateContinuousLoopHealth(mkAction({ id: "c1" }), emptyReadout, 3);
  assert.equal(conv.healthy, false);

  // Probe passthrough.
  const probeHealthy = await evaluateContinuousLoopHealth(
    mkAction({
      id: "c2",
      convergence: {
        kind: "continuous",
        loop: "ext",
        loopHealth: async () => ({ healthy: true, detail: "armed" }),
      },
    }),
    emptyReadout,
    3,
  );
  assert.deepEqual(probeHealthy, { healthy: true, detail: "armed" });

  // Probe failure => unhealthy (fail toward visibility), never a throw.
  const probeThrew = await evaluateContinuousLoopHealth(
    mkAction({
      id: "c3",
      convergence: {
        kind: "continuous",
        loop: "ext",
        loopHealth: async () => {
          throw new Error("scheduler exploded");
        },
      },
    }),
    emptyReadout,
    3,
  );
  assert.equal(probeThrew.healthy, false);
  assert.match(probeThrew.detail, /scheduler exploded/);

  const enrolled = mkAction({
    id: "c4",
    convergence: { kind: "continuous", loop: "self-heal" },
    selfHeal: { cadenceMs: 1, backoffMs: 1 },
  });
  // Master OFF => unhealthy (nothing drains it).
  const masterOff = await evaluateContinuousLoopHealth(enrolled, { enabled: false, actions: {} }, 3);
  assert.equal(masterOff.healthy, false);
  assert.match(masterOff.detail, /master switch is OFF/i);

  // Master ON, not yet run => healthy (loop armed; don't flap post-deploy).
  const notYetRun = await evaluateContinuousLoopHealth(enrolled, { enabled: true, actions: {} }, 3);
  assert.equal(notYetRun.healthy, true);

  // Failure streak at/over the alert threshold => unhealthy.
  const failing = await evaluateContinuousLoopHealth(
    enrolled,
    {
      enabled: true,
      actions: { c4: { consecutiveFailures: 3, lastRunAt: "x", lastOutcome: "error" } },
    },
    3,
  );
  assert.equal(failing.healthy, false);
  assert.match(failing.detail, /3 consecutive error/);

  // Below the threshold (transient blip) => still auto-managed.
  const blip = await evaluateContinuousLoopHealth(
    enrolled,
    {
      enabled: true,
      actions: { c4: { consecutiveFailures: 1, lastRunAt: "x", lastOutcome: "applied" } },
    },
    3,
  );
  assert.equal(blip.healthy, true);
  console.log("Part C ok — loop-health derivation");
}

async function partD_commonIssuesFinalize() {
  // A stored-malformed shape: canonical markers, zero line breaks. Assert
  // the fixture really is what the repair arm would flag (self-checking).
  const malformed =
    "🔴 **Issue:** Calls going to voicemail during lunch **Why it matters:** Missed revenue ➡️ **Fix:** Add lunch coverage 🔴 **Issue:** Slow email replies **Why it matters:** Leads go cold ➡️ **Fix:** Set a 1-hour SLA";
  assert.equal(needsCommonIssuesStructureRepair(malformed), true, "fixture must be repair-flagged");

  const fixed = finalizeCommonIssuesForStorage(malformed);
  assert.ok(fixed.text.includes("\n"), "normalize-on-write must restore line structure");
  assert.equal(
    needsCommonIssuesStructureRepair(fixed.text),
    false,
    "stored output can never be flagged by the repair arm again",
  );
  assert.equal(fixed.stampable, true, "well-formed output is stampable");

  // Idempotence: finalizing the finalized text is a no-op.
  const again = finalizeCommonIssuesForStorage(fixed.text);
  assert.equal(again.text, fixed.text);
  assert.equal(again.stampable, true);

  // Already well-formed text passes through unchanged.
  const wellFormed = fixed.text;
  assert.equal(finalizeCommonIssuesForStorage(wellFormed).text, wellFormed);

  // Empty / non-string input finalizes to "" and is stampable.
  assert.deepEqual(finalizeCommonIssuesForStorage(""), { text: "", stampable: true });
  assert.deepEqual(finalizeCommonIssuesForStorage(null), { text: "", stampable: true });
  console.log("Part D ok — Common Issues normalize-before-stamp");
}

async function partE_heatmapResolver() {
  await runInTxSandbox(async () => {
    const db = getDb();
    const clientA = randomUUID();
    const clientB = randomUUID();
    await db.insert(clients).values([
      { id: clientA, firmName: `Taxonomy Test A ${clientA.slice(0, 8)}` } as any,
      { id: clientB, firmName: `Taxonomy Test B ${clientB.slice(0, 8)}` } as any,
    ]);
    const [locationA] = await db
      .insert(clientLocations)
      .values({ clientId: clientA, name: `Taxonomy Loc ${clientA.slice(0, 8)}` } as any)
      .returning();
    const unambiguous = `taxo-camp-a-${clientA.slice(0, 8)}`;
    const ambiguous = `taxo-camp-b-${clientA.slice(0, 8)}`;
    await db.insert(semrushLocationCampaigns).values({
      clientId: clientA,
      locationId: locationA.id,
      semrushCampaignId: unambiguous,
    } as any);
    // Same campaign bound to TWO clients across the two mapping tables.
    await db.insert(semrushLocationCampaigns).values({
      clientId: clientA,
      locationId: locationA.id,
      semrushCampaignId: ambiguous,
    } as any);
    await db.insert(clientSemrushIntegrations).values({
      clientId: clientB,
      semrushCampaignId: ambiguous,
    } as any);

    assert.equal(
      await resolveUnambiguousClientForCampaign(db as any, unambiguous),
      clientA,
      "single binding resolves at ingest",
    );
    assert.equal(
      await resolveUnambiguousClientForCampaign(db as any, ambiguous),
      null,
      "ambiguous campaign stays NULL (never guess)",
    );
    assert.equal(
      await resolveUnambiguousClientForCampaign(db as any, "taxo-camp-none"),
      null,
      "unmatched campaign stays NULL",
    );
  });
  console.log("Part E ok — heatmap ingest-time client resolution");
}

async function partF_frontAttributionResolver() {
  await runInTxSandbox(async () => {
    const db = getDb();
    const liveClient = randomUUID();
    const archivedClient = randomUUID();
    await db.insert(clients).values([
      { id: liveClient, firmName: `Taxonomy Live ${liveClient.slice(0, 8)}` } as any,
      {
        id: archivedClient,
        firmName: `Taxonomy Archived ${archivedClient.slice(0, 8)}`,
        isArchived: true,
      } as any,
    ]);
    const mkConv = (suffix: string) => `cnv_taxo_${suffix}_${liveClient.slice(0, 8)}`;
    await db.insert(frontSyncEmails).values([
      {
        conversationId: mkConv("matched"),
        matchStatus: "auto_matched",
        matchedClientId: liveClient,
      } as any,
      {
        conversationId: mkConv("unmatched"),
        matchStatus: "unmatched",
        matchedClientId: null,
      } as any,
      {
        conversationId: mkConv("archived"),
        matchStatus: "manually_matched",
        matchedClientId: archivedClient,
      } as any,
    ]);

    assert.equal(
      await resolveMatchedClientForConversation(mkConv("matched")),
      liveClient,
      "matched conversation attributes at ingest",
    );
    assert.equal(
      await resolveMatchedClientForConversation(mkConv("unmatched")),
      null,
      "unmatched conversation stays unattributed",
    );
    assert.equal(
      await resolveMatchedClientForConversation(mkConv("archived")),
      null,
      "archived client is never attributed (orphaned-client guard)",
    );
    assert.equal(
      await resolveMatchedClientForConversation("cnv_taxo_absent_zzz"),
      null,
      "unknown conversation resolves null, never throws",
    );
    assert.equal(await resolveMatchedClientForConversation(null), null);
  });
  console.log("Part F ok — Front ingest-time attribution predicate");
}

// Task #4762 — the calm auto-managed bucket through the REAL engine
// (getProdActionStatuses): working rows, enrolled-converging scheduled
// rows, human-gated amber rows, served-purpose lever retirement, and the
// fail-toward-visibility fallbacks. Uses the wiring-test registry-swap
// pattern so no real action's status()/servedPurpose() fires.
async function partG_engineBucketing() {
  // Pure enrollment-health derivation first (no DB): nextEligibleAt is
  // passed through so the panel can render "auto-applies by ~time".
  const enrolledAction = mkAction({
    id: "g_pure",
    selfHeal: { cadenceMs: 1, backoffMs: 1 },
  });
  // Clock-derived (never absolute literals — they rot at a fixed UTC
  // midnight; see lint-calendar-fixture-bucket-gap's future_date_literal).
  const nextAt = new Date(Date.now() + 6 * 3600_000).toISOString();
  const lastAt = new Date(Date.now() - 6 * 3600_000).toISOString();
  const withSchedule = evaluateSelfHealEnrollmentHealth(
    enrolledAction,
    {
      enabled: true,
      actions: {
        g_pure: {
          nextEligibleAt: nextAt,
          lastRunAt: lastAt,
          lastOutcome: "applied",
          consecutiveFailures: 0,
        } as any,
      },
    },
    3,
  );
  assert.equal(withSchedule.healthy, true);
  assert.equal(withSchedule.nextEligibleAt, nextAt);
  assert.equal(
    evaluateSelfHealEnrollmentHealth(mkAction({ id: "g_pure2" }), { enabled: true, actions: {} }, 3)
      .healthy,
    false,
    "un-enrolled action is never enrollment-healthy",
  );

  const working = mkAction({
    id: "g_working",
    selfHeal: { cadenceMs: 1000, backoffMs: 1000 },
    status: async () => ({ state: "pending", working: true, detail: "3 of 9 drained" }),
  });
  const enrolledCalm = mkAction({
    id: "g_enrolled_calm",
    selfHeal: { cadenceMs: 1000, backoffMs: 1000 },
    status: async () => ({ state: "pending", detail: "12 rows remaining" }),
  });
  const humanGated = mkAction({
    id: "g_humangate",
    humanGate: { reason: "External console operation only a human can run." },
    status: async () => ({ state: "pending", detail: "waiting on console op" }),
  });
  const retiredLever = mkAction({
    id: "g_retired_lever",
    manualLever: true,
    status: async () => ({ state: "not-needed", detail: "Manual lever — fire only if needed." }),
    servedPurpose: async () => ({ served: true, note: "Target state reached; lever retired." }),
  });
  const probeThrows = mkAction({
    id: "g_probe_throws",
    manualLever: true,
    status: async () => ({ state: "not-needed", detail: "Manual lever." }),
    servedPurpose: async () => {
      throw new Error("probe exploded");
    },
  });
  const erroredEnrolled = mkAction({
    id: "g_error_enrolled",
    selfHeal: { cadenceMs: 1000, backoffMs: 1000 },
    status: async () => ({ state: "error", detail: "boom" }),
  });

  const saved = PROD_ACTIONS.splice(0, PROD_ACTIONS.length);
  try {
    PROD_ACTIONS.push(working, enrolledCalm, humanGated, retiredLever, probeThrows, erroredEnrolled);

    // Pass 1 — self-heal master ON (pinned; restored in finally).
    await setSystemSetting(SETTING_ENABLED, "true");
    const on = await getProdActionStatuses();
    const row = (id: string) => on.actions.find((a) => a.id === id)!;

    // Working drain ⇒ calm, any convergence class, badge-excluded.
    assert.equal(row("g_working").autoManaged, true);
    assert.match(row("g_working").autoManagedDetail ?? "", /actively working/i);
    assert.ok(on.autoManaged.some((a) => a.id === "g_working"));
    assert.ok(!on.active.some((a) => a.id === "g_working"));

    // Enrolled converging + healthy scheduler ⇒ scheduled auto-apply, calm.
    assert.equal(row("g_enrolled_calm").autoManaged, true);
    assert.match(row("g_enrolled_calm").autoManagedDetail ?? "", /auto-applies/i);
    assert.ok(!on.active.some((a) => a.id === "g_enrolled_calm"));

    // Human-gated pending stays amber and carries its reason.
    assert.equal(row("g_humangate").autoManaged, false);
    assert.ok(on.active.some((a) => a.id === "g_humangate"));
    assert.equal(
      row("g_humangate").humanGate?.reason,
      "External console operation only a human can run.",
    );

    // Served-purpose lever retires to History (levers read not-needed).
    assert.equal(row("g_retired_lever").retired, true);
    assert.equal(row("g_retired_lever").retiredNote, "Target state reached; lever retired.");
    assert.ok(on.completed.some((a) => a.id === "g_retired_lever"));
    assert.ok(!on.active.some((a) => a.id === "g_retired_lever"));

    // Probe failure ⇒ NOT retired (fail toward visibility), still completed
    // (not-needed lever), never amber.
    assert.equal(row("g_probe_throws").retired, undefined);
    assert.ok(on.completed.some((a) => a.id === "g_probe_throws"));

    // error state is never calm — even enrolled.
    assert.equal(row("g_error_enrolled").autoManaged, false);
    assert.ok(on.active.some((a) => a.id === "g_error_enrolled"));

    // Partitions stay disjoint: active ∩ autoManaged = ∅.
    const activeIds = new Set(on.active.map((a) => a.id));
    for (const a of on.autoManaged) {
      assert.ok(!activeIds.has(a.id), `${a.id} in BOTH active and autoManaged`);
    }

    // Pass 2 — master OFF: the enrolled converging row falls through amber
    // (nothing will press it), with the reason surfaced. The working row
    // stays calm: its own drain is progressing regardless of the scheduler.
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    const off = await getProdActionStatuses();
    const offRow = (id: string) => off.actions.find((a) => a.id === id)!;
    assert.equal(offRow("g_enrolled_calm").autoManaged, false);
    assert.match(offRow("g_enrolled_calm").autoManagedDetail ?? "", /master switch is OFF/i);
    assert.ok(off.active.some((a) => a.id === "g_enrolled_calm"));
    assert.equal(offRow("g_working").autoManaged, true);
  } finally {
    PROD_ACTIONS.splice(0, PROD_ACTIONS.length, ...saved);
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  }
  console.log("Part G ok — engine calm-bucket semantics (Task #4762)");
}

async function main() {
  await partA_realRegistryInvariants();
  await partB_syntheticViolations();
  await partB2_moduleLoadInvocationPresent();
  await partC_loopHealthDerivation();
  await partD_commonIssuesFinalize();
  await partE_heatmapResolver();
  await partF_frontAttributionResolver();
  await partG_engineBucketing();
  console.log("prod-actions-convergence-taxonomy: ALL PARTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("prod-actions-convergence-taxonomy FAILED:", err);
    process.exit(1);
  });
