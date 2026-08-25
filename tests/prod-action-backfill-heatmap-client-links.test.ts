/* test-registration
{
  "name": "Prod-action backfill heatmap snapshot client links — unambiguous stamp + surfaced leftovers + convergence (Task #2895)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2895: backfill_heatmap_snapshot_client_links prod-action — stamps client_id on pre-link heatmap snapshots ONLY where the SEMrush campaign resolves to exactly one client across both binding tables; ambiguous / unmatched / already-linked rows untouched (surfaced, never guessed); converges to not-needed with a no-op re-press. Fast, hermetic (isolated schema, all touched tables cloned), deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #2895 — End-to-end verification of the
 * `backfill_heatmap_snapshot_client_links` CEO prod-action: a one-press,
 * idempotent, worker-pool background drain that stamps
 * `heatmap_snapshots.client_id` on rows imported before the import path
 * captured the client link, resolving via the snapshot's SEMrush
 * campaign_id against the existing campaign → client bindings
 * (semrush_location_campaigns ∪ client_semrush_integrations).
 *
 * Matching is deliberately conservative: only campaigns claimed by exactly
 * ONE distinct client are stamped. Ambiguous (2+ clients) and unmatched
 * (no binding) campaigns leave their snapshots NULL and are surfaced in
 * status() — never guessed.
 *
 * Everything runs inside `runInIsolatedSchema` (Task #1929 pattern) so the
 * live `Start application` workers (default search_path = public) can
 * neither see nor race-write the rows this test seeds. The LIKE clone
 * drops FKs, so client ids here are plain strings; keyword names are
 * seeded canonical so the cloned canonical CHECK constraint is satisfied.
 *
 * Coverage:
 *   1. stamp + surface: resolvable rows (bound via either table, or via
 *      both tables agreeing) get stamped; ambiguous / unmatched /
 *      already-linked rows are untouched; drain tally + audit row match.
 *   2. convergence: after the drain, status() is `not-needed` (with the
 *      leftover ambiguous/unmatched counts surfaced in the detail) and a
 *      re-press is `not-needed` with no drain and no second audit row.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION = "backfill_heatmap_snapshot_client_links";
const TABLES = [
  "heatmap_snapshots",
  "semrush_location_campaigns",
  "client_semrush_integrations",
  "prod_action_runs",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function getAction(id: string) {
  const action = PROD_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`${id} missing from PROD_ACTIONS registry`);
  return action;
}

async function awaitDrain(actionId: string, timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(actionId);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${actionId} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

let seedCounter = 0;
async function seedSnapshot(
  isoDb: IsoDb,
  campaignId: string,
  clientId: string | null = null,
): Promise<string> {
  const id = `hcb-seed-${seedCounter++}`;
  await isoDb.execute(sql`
    INSERT INTO heatmap_snapshots
      (id, client_id, location_id, location_name, campaign_id, keyword_name,
       report_date, business_lat, business_lng, grid_template, grid_unit,
       grid_distance, base_lat, base_lng, raw_payload, created_at)
    VALUES (
      ${id}, ${clientId}, 'loc-1', 'Loc One', ${campaignId}, 'plumber',
      NOW(), 0, 0, '5x5', 'MILES', 1, 0, 0, '{}'::jsonb, NOW()
    )
  `);
  return id;
}

async function bindLocationCampaign(
  isoDb: IsoDb,
  clientId: string,
  campaignId: string,
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO semrush_location_campaigns
      (client_id, location_id, semrush_campaign_id, created_at)
    VALUES (${clientId}, ${`loc-${clientId}-${campaignId}`}, ${campaignId}, NOW())
  `);
}

async function bindIntegration(
  isoDb: IsoDb,
  clientId: string,
  campaignId: string,
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO client_semrush_integrations
      (client_id, semrush_campaign_id, created_at, updated_at)
    VALUES (${clientId}, ${campaignId}, NOW(), NOW())
  `);
}

async function clientOf(isoDb: IsoDb, id: string): Promise<string | null> {
  const res: any = await isoDb.execute(
    sql`SELECT client_id FROM heatmap_snapshots WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.length ? (rows[0].client_id === null ? null : String(rows[0].client_id)) : null;
}

async function auditRowCount(isoDb: IsoDb): Promise<number> {
  const res: any = await isoDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM prod_action_runs WHERE action_id = ${ACTION}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows?.[0]?.n ?? 0);
}

async function main(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    // ── Seed bindings ──────────────────────────────────────────────
    // camp-loc: bound to client-1 via semrush_location_campaigns only.
    await bindLocationCampaign(isoDb, "client-1", "camp-loc");
    // camp-int: bound to client-2 via client_semrush_integrations only.
    await bindIntegration(isoDb, "client-2", "camp-int");
    // camp-both: bound to client-3 in BOTH tables — still unambiguous.
    await bindLocationCampaign(isoDb, "client-3", "camp-both");
    await bindIntegration(isoDb, "client-3", "camp-both");
    // camp-ambig: claimed by two different clients → ambiguous.
    await bindLocationCampaign(isoDb, "client-4", "camp-ambig");
    await bindIntegration(isoDb, "client-5", "camp-ambig");
    // camp-none: no binding anywhere → unmatched.

    // ── Seed snapshots ─────────────────────────────────────────────
    const viaLoc = await seedSnapshot(isoDb, "camp-loc");
    const viaInt = await seedSnapshot(isoDb, "camp-int");
    const viaBoth = await seedSnapshot(isoDb, "camp-both");
    const ambig = await seedSnapshot(isoDb, "camp-ambig");
    const unmatched = await seedSnapshot(isoDb, "camp-none");
    // Already linked (to a DIFFERENT client than its campaign binding) —
    // the backfill must never overwrite an existing link.
    const linked = await seedSnapshot(isoDb, "camp-loc", "client-existing");

    // ── status() before the press ──────────────────────────────────
    const before = await getAction(ACTION).status();
    assert.equal(before.state, "pending", `expected pending, got ${JSON.stringify(before)}`);
    assert.match(before.detail, /3 unlinked heatmap snapshot\(s\)/);
    assert.match(before.detail, /1 row\(s\) whose campaign is claimed by multiple clients/);
    assert.match(before.detail, /1 row\(s\) whose campaign has no client binding/);
    ok(`${ACTION}: status() counts 3 resolvable and surfaces 1 ambiguous + 1 unmatched`);

    // ── One press → background drain stamps the 3 resolvable rows ──
    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain(ACTION);
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    assert.equal(state.totalAtStart, 3, `countPending should be 3, got ${state.totalAtStart}`);
    assert.equal(state.processed, 3, `processed should be 3, got ${state.processed}`);
    assert.deepEqual(state.perKey, { linked: 3 }, `unexpected perKey ${JSON.stringify(state.perKey)}`);

    assert.equal(await clientOf(isoDb, viaLoc), "client-1");
    assert.equal(await clientOf(isoDb, viaInt), "client-2");
    assert.equal(await clientOf(isoDb, viaBoth), "client-3");
    // Ambiguous / unmatched stay NULL — surfaced, never guessed.
    assert.equal(await clientOf(isoDb, ambig), null);
    assert.equal(await clientOf(isoDb, unmatched), null);
    // Existing link never overwritten.
    assert.equal(await clientOf(isoDb, linked), "client-existing");
    assert.equal(await auditRowCount(isoDb), 1, "exactly one audit row after the press");
    ok(`${ACTION}: drain stamped 3 resolvable rows; ambiguous/unmatched/linked untouched; audit row written`);

    // ── Convergence: status not-needed, re-press is a no-op ────────
    const after = await getAction(ACTION).status();
    assert.equal(after.state, "not-needed", `expected not-needed, got ${JSON.stringify(after)}`);
    assert.match(after.detail, /1 row\(s\) whose campaign is claimed by multiple clients/);
    assert.match(after.detail, /1 row\(s\) whose campaign has no client binding/);

    __resetDrainsForTest();
    const repress = await getAction(ACTION).apply(null);
    assert.equal(repress.state, "not-needed", `re-press should be not-needed, got ${JSON.stringify(repress)}`);
    assert.equal(getDrainState(ACTION), undefined, "no drain may be created on a converged re-press");
    assert.equal(await auditRowCount(isoDb), 1, "re-press must not write a second audit row");
    ok(`${ACTION}: converged — status not-needed (leftovers surfaced), re-press no-op, no extra audit row`);
  }, { tables: TABLES });

  console.log(`\nprod-action-backfill-heatmap-client-links: ${passed} assertions passed`);
}

main().then(
  () => {
    console.log("prod-action-backfill-heatmap-client-links: verified");
  },
  (err) => {
    console.error("prod-action-backfill-heatmap-client-links: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
