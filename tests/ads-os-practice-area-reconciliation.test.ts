/* test-registration
{
  "name": "Ads OS Practice Area reconciliation — bounded manual lever, fresh ClickUp authority, isolated criteria convergence, preservation, fail-closed recovery, and retirement",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the one-shot production rollout safety contract: one no-egress fresh directory snapshot, raw-key-preserving field-only criteria writes, shared-parent multi-CID convergence, missing/empty behavior, unmapped and ambiguous fail-closed diagnostics, retryable partial failure, manual-only classification, and fresh served-purpose retirement. Uses one isolated criteria schema and stubbed ClickUp data.",
  "tier": "medium",
  "tierReason": "Exercises bounded reconciliation across shared-parent, ambiguous, failure, and retirement cases."
}
test-registration */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { runInIsolatedSchema } from "./db-sandbox";
import type { DirectoryBundle } from "../server/services/adsOs/clickUpDirectory";
import {
  getCriteriaStrict,
  listCriteriaKeysStrict,
  patchCriteriaPracticeAreasStrict,
  putCriteria,
} from "../server/services/adsOs/store";
import {
  PRACTICE_AREA_RECONCILIATION_MAX_CIDS,
  PRACTICE_AREA_RECONCILIATION_MAX_SNAPSHOT_AGE_MS,
  makePracticeAreaReconciliationAction,
  type PracticeAreaReconciliationDeps,
} from "../server/services/prodActions/platformOpsActions";

const NOW = new Date("2026-08-24T16:00:00.000Z");

function directory(
  overrides: Partial<DirectoryBundle> = {},
): DirectoryBundle {
  return {
    clients: {
      alpha: {
        name: "Alpha Law",
        doer: null,
        checker: null,
        log_url: null,
        practice_areas: ["Family", "Immigration"],
      },
      beta: {
        name: "Beta Law",
        doer: null,
        checker: null,
        log_url: null,
        practice_areas: [],
      },
      gamma: {
        name: "Gamma Law",
        doer: null,
        checker: null,
        log_url: null,
        practice_areas: ["Criminal Defense"],
      },
    },
    blocks: [
      { name: "Alpha Law", gads_cids: ["111"], lsa_cids: ["222"] },
      { name: "Beta Law", gads_cids: ["333"], lsa_cids: ["444"] },
      { name: "Gamma Law", gads_cids: ["555"], lsa_cids: [] },
    ],
    statuses: {},
    budgets: {},
    cidClient: {
      "111": "alpha",
      "222": "alpha",
      "333": "beta",
      "444": "beta",
      "555": "gamma",
    },
    lsaCities: {},
    known: {
      gads: new Set(["111", "333", "555"]),
      lsa: new Set(["222", "444"]),
    },
    deepLinks: { gads: {}, lsa: {} },
    practiceAreaField: {
      id: "practice-area-fixture",
      name: "Practice Area",
      type: "labels",
    },
    practiceAreaOptions: [
      { id: "family", label: "Family", orderindex: 0 },
      { id: "immigration", label: "Immigration", orderindex: 1 },
      { id: "criminal", label: "Criminal Defense", orderindex: 2 },
    ],
    cidPracticeAreas: {
      "111": ["Family", "Immigration"],
      "222": ["Family", "Immigration"],
      "333": [],
      "444": [],
      "555": ["Criminal Defense"],
    },
    cidParentTaskIds: {
      "111": ["parent-alpha"],
      "222": ["parent-alpha"],
      "333": ["parent-beta"],
      "444": ["parent-beta"],
      "555": ["parent-gamma"],
    },
    fetchedAt: NOW.getTime(),
    ...overrides,
  };
}

await runInIsolatedSchema(
  async ({ db }) => {
    const original111 = {
      business_name: "Alpha Law",
      practice_areas: ["Old Area"],
      schedule_days: ["Mon", "Tue"],
      service_area: "Austin",
      notes: "preserve me",
      unknown_legacy_key: { nested: true },
      updated_at: "2024-01-01T00:00:00.000Z",
    };
    const original333 = {
      business_name: "Beta Law",
      practice_areas: ["Legacy Area"],
      lsa_schedule_days: ["Sun"],
      another_unknown_key: 42,
      updated_at: "2024-02-01T00:00:00.000Z",
    };
    const unmapped999 = {
      business_name: "Offboarded Law",
      practice_areas: ["Never Clear"],
      unknown: "untouched",
      updated_at: "2024-03-01T00:00:00.000Z",
    };
    for (const [cid, doc] of [
      ["111", original111],
      ["333", original333],
      ["999", unmapped999],
    ] as const) {
      await db.execute(sql`
        INSERT INTO ads_os_clients_criteria (key, data, updated_at)
        VALUES (${cid}, ${JSON.stringify(doc)}::jsonb, NOW())
      `);
    }

    let snapshotLoads = 0;
    const baseDeps: PracticeAreaReconciliationDeps = {
      loadDirectory: async () => {
        snapshotLoads++;
        return directory();
      },
      listCriteriaCids: () =>
        listCriteriaKeysStrict(PRACTICE_AREA_RECONCILIATION_MAX_CIDS),
      readCriteria: getCriteriaStrict,
      patchCriteria: patchCriteriaPracticeAreasStrict,
      now: () => NOW,
    };

    const action = makePracticeAreaReconciliationAction(baseDeps);
    assert.equal(action.manualLever, true);
    assert.equal(action.selfHeal, undefined, "the lever has no scheduler enrollment");
    assert.equal(action.humanGate, undefined, "manualLever is the sole drain path");
    assert.equal(action.convergence.kind, "converging");
    assert.equal(typeof action.servedPurpose, "function");

    const initial = await action.status();
    assert.equal(initial.state, "not-needed", "ordinary drift never becomes Pending");
    assert.match(initial.detail, /2 mismatch/i);
    assert.match(initial.detail, /3 missing document/i);
    assert.match(initial.detail, /1 unmapped stored account/i);
    assert.match(initial.detail, /Alpha Law \(111\)/);
    assert.match(initial.detail, /Alpha Law \(222\)/);
    assert.match(initial.detail, /999/);
    const preApplyRetirement = await action.servedPurpose!();
    assert.equal(preApplyRetirement.served, false);
    assert.equal(
      snapshotLoads,
      2,
      "retirement takes an independent fresh snapshot instead of reusing status",
    );

    // First pass: fail one independent seed after earlier siblings converge.
    let fail555 = true;
    const partial = makePracticeAreaReconciliationAction({
      ...baseDeps,
      patchCriteria: async (cid, labels, updatedAt) => {
        if (cid === "555" && fail555) throw new Error("fixture write failure");
        return patchCriteriaPracticeAreasStrict(cid, labels, updatedAt);
      },
    });
    const partialResult = await partial.apply();
    assert.equal(partialResult.state, "error");
    assert.match(partialResult.detail, /Gamma Law \(555\) write failed/i);
    assert.match(partialResult.detail, /updated 2, seeded 1/i);

    const after111 = await getCriteriaStrict("111");
    assert(after111);
    assert.deepEqual(after111.practice_areas, ["Family", "Immigration"]);
    assert.equal(after111.business_name, original111.business_name);
    assert.deepEqual(after111.schedule_days, original111.schedule_days);
    assert.equal(after111.service_area, original111.service_area);
    assert.equal(after111.notes, original111.notes);
    assert.deepEqual(after111.unknown_legacy_key, original111.unknown_legacy_key);
    assert.equal(after111.updated_at, NOW.toISOString());

    const after333 = await getCriteriaStrict("333");
    assert(after333);
    assert.deepEqual(
      after333.practice_areas,
      [],
      "an existing document may be cleared by an explicit fresh empty authority",
    );
    assert.deepEqual(after333.lsa_schedule_days, original333.lsa_schedule_days);
    assert.equal(after333.another_unknown_key, original333.another_unknown_key);

    const seeded222 = await getCriteriaStrict("222");
    assert.deepEqual(seeded222, {
      practice_areas: ["Family", "Immigration"],
      updated_at: NOW.toISOString(),
    });
    assert.equal(
      await getCriteriaStrict("444"),
      null,
      "an absent document with an empty authority is never seeded",
    );
    assert.equal(await getCriteriaStrict("555"), null, "failed sibling remains retryable");
    assert.deepEqual(
      await getCriteriaStrict("999"),
      unmapped999,
      "unmapped stored criteria are diagnosed and never cleared",
    );

    // Deterministic interleave: an operator adds unrelated data after the
    // probe read but before the action's atomic field patch.
    await putCriteria("111", {
      ...(await getCriteriaStrict("111")),
      practice_areas: ["Drift Again"],
    });
    const concurrent = makePracticeAreaReconciliationAction({
      ...baseDeps,
      patchCriteria: async (cid, labels, updatedAt) => {
        if (cid === "555") throw new Error("fixture write failure");
        if (cid === "111") {
          await db.execute(sql`
            UPDATE ads_os_clients_criteria
            SET data = data || '{"concurrent_operator_key":"must survive"}'::jsonb
            WHERE key = '111'
          `);
        }
        return patchCriteriaPracticeAreasStrict(cid, labels, updatedAt);
      },
    });
    const concurrentResult = await concurrent.apply();
    assert.equal(concurrentResult.state, "error", "the independent 555 failure remains");
    assert.equal(
      (await getCriteriaStrict("111"))?.concurrent_operator_key,
      "must survive",
      "atomic JSONB patch preserves a concurrent unrelated operator edit",
    );

    fail555 = false;
    const recovered = await action.apply();
    assert.equal(recovered.state, "applied");
    assert.equal((recovered as any).rowsAffected, 1);
    assert.deepEqual(await getCriteriaStrict("555"), {
      practice_areas: ["Criminal Defense"],
      updated_at: NOW.toISOString(),
    });

    const idempotent = await action.apply();
    assert.equal(idempotent.state, "not-needed");
    assert.match(idempotent.detail, /already matches/i);

    const retired = await action.servedPurpose!();
    assert.equal(retired.served, true, "a fresh successful convergence probe retires");
    assert.match(retired.note ?? "", /4 stored criteria document/i);

    // A strict read failure remains explicit and never becomes false-clean.
    const readFailure = makePracticeAreaReconciliationAction({
      ...baseDeps,
      readCriteria: async (cid) => {
        if (cid === "111") throw new Error("fixture read failure");
        return getCriteriaStrict(cid);
      },
    });
    const readFailureStatus = await readFailure.status();
    assert.equal(readFailureStatus.state, "error");
    assert.match(readFailureStatus.detail, /Alpha Law \(111\): fixture read failure/i);
    assert.equal((await readFailure.servedPurpose!()).served, false);

    // Unavailable, stale, malformed, and ambiguous authority blocks all writes.
    for (const [name, loadDirectory] of [
      [
        "unavailable",
        async () => {
          throw new Error("fixture ClickUp outage");
        },
      ],
      [
        "stale",
        async () =>
          directory({
            fetchedAt:
              NOW.getTime() -
              PRACTICE_AREA_RECONCILIATION_MAX_SNAPSHOT_AGE_MS -
              1,
          }),
      ],
      ["malformed", async () => directory({ practiceAreaField: null })],
      [
        "ambiguous",
        async () =>
          directory({
            cidParentTaskIds: {
              ...directory().cidParentTaskIds,
              "111": ["parent-alpha", "parent-other"],
            },
          }),
      ],
    ] as const) {
      let writes = 0;
      const blocked = makePracticeAreaReconciliationAction({
        ...baseDeps,
        loadDirectory,
        patchCriteria: async () => {
          writes++;
          return "updated";
        },
      });
      const status = await blocked.status();
      assert.equal(status.state, "blocked", `${name} status blocks`);
      const result = await blocked.apply();
      assert.equal(result.state, "blocked", `${name} apply blocks`);
      assert.equal(writes, 0, `${name} authority never writes or clears criteria`);
      assert.equal((await blocked.servedPurpose!()).served, false);
    }

    console.log(
      "ads-os-practice-area-reconciliation: all isolated/no-egress assertions passed",
    );
  },
  {
    tables: ["ads_os_clients_criteria"],
    pinGetDbForCrossAsync: true,
  },
);