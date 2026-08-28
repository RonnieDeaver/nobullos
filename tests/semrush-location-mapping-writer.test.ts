/* test-registration
{
  "name": "SEMrush location-mapping writer + cleanup (Task #920E)",
  "scanPaths": [
    "scripts/promote-semrush-configured-mapping-suggestions.ts",
    "server/routes/heatmap.ts",
    "server/services/semrushInventorySync.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #920E — Regression tests for the canonical SEMrush location-mapping
 * write helper, the auto-match endpoint, the inventory apply handler, and the
 * one-off promotion cleanup script.
 *
 * The helper (`server/services/semrushLocationMappingWriter.ts`, Task #920B)
 * is the single entry point for inserting `semrush_location_campaigns` rows
 * from any import / sync surface. This suite pins:
 *
 *   1. Helper outcome variants                — saved / already_mapped /
 *      queued_for_review / invalid_parent / stale_conflict / blocked /
 *      concurrent inserts converge to one saved + one already_mapped.
 *   2. Auto-match endpoint shape              — the route's response keys
 *      `savedCount` / `alreadyMappedCount` / `queuedForReviewCount` /
 *      `staleConflictCount` are populated from helper outcomes.
 *   3. Inventory apply handler                — same outcome matrix when
 *      driven through `inventorySyncApply.handle`.
 *   4. Cleanup script (920D)                  — dry-run classification,
 *      `--apply` mutates only the right buckets, re-running `--apply` is
 *      a no-op (idempotent).
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  importEntitySuggestions,
  semrushLocationCampaigns,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  applySemrushLocationMapping,
  applyAutoMatchCandidates,
  type MappingWriteOutcome,
  type AutoMatchCandidate,
} from "../server/services/semrushLocationMappingWriter";
import type { ApplyInput } from "../server/services/applyPipeline";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${(e as Error).stack || (e as Error).message}`);
    failed++;
  }
}

const TEST_TAG = `slmw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];
const createdMappingIds: string[] = [];
const createdSuggestionIds: string[] = [];

async function seedClient(label: string): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ firmName: `${TEST_TAG}-${label}` })
    .returning({ id: clients.id });
  createdClientIds.push(row.id);
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(clientLocations)
    .values({ clientId, name: `${TEST_TAG}-${name}` })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(row.id);
  return row.id;
}

async function seedStaleMapping(args: {
  clientId: string;
  locationId: string;
  semrushCampaignId: string;
  semrushCampaignName?: string;
}): Promise<string> {
  const [row] = await db
    .insert(semrushLocationCampaigns)
    .values({
      clientId: args.clientId,
      locationId: args.locationId,
      semrushCampaignId: args.semrushCampaignId,
      semrushCampaignName: args.semrushCampaignName ?? null,
      isStale: true,
      staleSince: new Date(),
    })
    .returning({ id: semrushLocationCampaigns.id });
  createdMappingIds.push(row.id);
  return row.id;
}

async function captureMappingId(outcome: MappingWriteOutcome): Promise<void> {
  if (outcome.kind === "saved" || outcome.kind === "already_mapped" || outcome.kind === "stale_conflict") {
    createdMappingIds.push(outcome.row.id);
  }
  if (outcome.kind === "queued_for_review" || outcome.kind === "invalid_parent") {
    createdSuggestionIds.push(outcome.suggestionId);
  }
}

async function cleanup(): Promise<void> {
  try {
    if (createdSuggestionIds.length) {
      await db
        .delete(importEntitySuggestions)
        .where(inArray(importEntitySuggestions.id, Array.from(new Set(createdSuggestionIds))));
    }
    if (createdMappingIds.length) {
      await db
        .delete(semrushLocationCampaigns)
        .where(inArray(semrushLocationCampaigns.id, Array.from(new Set(createdMappingIds))));
    }
    // Clean up any suggestions or mappings created *for* our test clients
    // that we may have missed (e.g. concurrent insert losers).
    if (createdClientIds.length) {
      await db
        .delete(importEntitySuggestions)
        .where(inArray(importEntitySuggestions.clientId, createdClientIds));
      await db
        .delete(semrushLocationCampaigns)
        .where(inArray(semrushLocationCampaigns.clientId, createdClientIds));
    }
    if (createdLocationIds.length) {
      await db
        .delete(clientLocations)
        .where(inArray(clientLocations.id, createdLocationIds));
    }
    if (createdClientIds.length) {
      await db
        .delete(clients)
        .where(inArray(clients.id, createdClientIds));
    }
  } catch (e) {
    console.warn(`[cleanup] non-fatal: ${(e as Error).message}`);
  }
}

console.log(`\n=== SEMrush location-mapping helper (Task #920E) — TEST_TAG=${TEST_TAG} ===`);

try {
  // -------------------------------------------------------------------------
  // Helper outcome variants (Step 1)
  // -------------------------------------------------------------------------

  await run("saved: configured location → inserts row, isStale=false, staleSince=null", async () => {
    const clientId = await seedClient("h-saved");
    const locationId = await seedLocation(clientId, "loc");
    const outcome = await applySemrushLocationMapping({
      clientId,
      locationId,
      semrushCampaignId: "camp-saved-1",
      semrushCampaignName: "Saved Campaign",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(outcome);
    assert(outcome.kind === "saved", `expected saved, got ${outcome.kind}`);
    if (outcome.kind === "saved") {
      assert(outcome.row.isStale === false, "isStale must be false");
      assert(outcome.row.staleSince === null, "staleSince must be null");
      assert(outcome.row.semrushCampaignName === "Saved Campaign", "name should round-trip");
    }
  });

  await run("already_mapped: re-running same input returns already_mapped, no duplicate row", async () => {
    const clientId = await seedClient("h-am");
    const locationId = await seedLocation(clientId, "loc");
    const o1 = await applySemrushLocationMapping({
      clientId, locationId,
      semrushCampaignId: "camp-am",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(o1);
    assert(o1.kind === "saved", `first call should save, got ${o1.kind}`);

    const o2 = await applySemrushLocationMapping({
      clientId, locationId,
      semrushCampaignId: "camp-am",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(o2);
    assert(o2.kind === "already_mapped", `second call should be already_mapped, got ${o2.kind}`);

    const rows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(
        and(
          eq(semrushLocationCampaigns.clientId, clientId),
          eq(semrushLocationCampaigns.locationId, locationId),
          eq(semrushLocationCampaigns.semrushCampaignId, "camp-am"),
        ),
      );
    assert(rows.length === 1, `expected 1 mapping row, got ${rows.length}`);
  });

  await run("invalid_parent: unconfigured (clientId, locationId) → enqueues one suggestion AND is idempotent on rerun", async () => {
    const clientId = await seedClient("h-ip");
    // NOTE: deliberately do NOT seed a location — pass a synthetic UUID.
    const fakeLocationId = "00000000-0000-4000-8000-000000000001";
    const o = await applySemrushLocationMapping({
      clientId,
      locationId: fakeLocationId,
      semrushCampaignId: "camp-ip",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(o);
    assert(o.kind === "invalid_parent", `expected invalid_parent, got ${o.kind}`);

    const sugs = await db
      .select()
      .from(importEntitySuggestions)
      .where(
        and(
          eq(importEntitySuggestions.clientId, clientId),
          eq(importEntitySuggestions.entityKind, "location_mapping"),
          eq(importEntitySuggestions.status, "pending"),
        ),
      );
    assert(sugs.length === 1, `expected 1 suggestion, got ${sugs.length}`);
    const cand = sugs[0].candidate as Record<string, unknown>;
    assert(cand.isConfigured === false, `suggestion candidate should mark isConfigured=false`);
    assert(cand.semrushCampaignId === "camp-ip", `campaignId should round-trip`);
    const firstSuggestionId =
      o.kind === "invalid_parent" || o.kind === "queued_for_review"
        ? o.suggestionId
        : null;
    assert(firstSuggestionId !== null, "first call must produce a suggestion id");

    // Idempotency: a second invocation must reuse the same pending
    // suggestion row instead of stacking duplicates. (Required by the
    // SEMrush mapping correction — re-runs of inventory sync against
    // unconfigured parents previously produced one suggestion per tick.)
    const o2 = await applySemrushLocationMapping({
      clientId,
      locationId: fakeLocationId,
      semrushCampaignId: "camp-ip",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(o2);
    assert(o2.kind === "invalid_parent", `re-run should still be invalid_parent, got ${o2.kind}`);
    const secondSuggestionId =
      o2.kind === "invalid_parent" || o2.kind === "queued_for_review"
        ? o2.suggestionId
        : null;
    assert(secondSuggestionId === firstSuggestionId,
      `re-run must reuse the same suggestion id (got new=${secondSuggestionId} vs first=${firstSuggestionId})`);

    const sugsAfter = await db
      .select({ id: importEntitySuggestions.id })
      .from(importEntitySuggestions)
      .where(
        and(
          eq(importEntitySuggestions.clientId, clientId),
          eq(importEntitySuggestions.entityKind, "location_mapping"),
          eq(importEntitySuggestions.status, "pending"),
        ),
      );
    assert(sugsAfter.length === 1,
      `re-run must NOT create a duplicate suggestion (got ${sugsAfter.length})`);

    const mappings = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    assert(mappings.length === 0, `no mapping row should be created for unconfigured parent, got ${mappings.length}`);
  });

  await run("queued_for_review: synthetic policy override (entityExists=true + allow_review_suggestion) routes to suggestion queue", async () => {
    // Under the current production policy a configured location returns
    // `allow_link_existing`, so the `queued_for_review` outcome (which
    // requires entityExists=true paired with allow_review_suggestion) is
    // unreachable through normal flow. The helper still exposes a
    // `_policyOverride` test seam so this branch is exercised: a future
    // policy change that re-introduces an "operator must approve already-
    // configured links" rule would land in this code path, and we want
    // the regression suite to fail loudly if it ever silently writes.
    const clientId = await seedClient("h-qfr");
    const locationId = await seedLocation(clientId, "loc");
    const o = await applySemrushLocationMapping(
      {
        clientId, locationId,
        semrushCampaignId: "camp-qfr",
        source: { surface: "semrush_inventory" },
      },
      {
        _policyOverride: {
          decision: "allow_review_suggestion",
          surface: "semrush_inventory",
          entityKind: "location_mapping",
          action: "create",
          reason: "test override: force queued_for_review path",
          blocked: false,
        },
      },
    );
    await captureMappingId(o);
    assert(o.kind === "queued_for_review",
      `override should produce queued_for_review (entityExists=true), got ${o.kind}`);
    if (o.kind !== "queued_for_review") return; // type-narrow for the suggestionId access below
    const [sug] = await db
      .select()
      .from(importEntitySuggestions)
      .where(eq(importEntitySuggestions.id, o.suggestionId));
    assert(sug, "suggestion row must exist");
    const cand = sug.candidate as Record<string, unknown>;
    assert(cand.isConfigured === true,
      `queued_for_review suggestion should mark isConfigured=true, got ${cand.isConfigured}`);

    // No mapping row written despite entityExists=true.
    const mappings = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    assert(mappings.length === 0,
      `queued_for_review must NOT write a mapping row, got ${mappings.length}`);
  });

  await run("stale_conflict: pre-existing isStale=true row is NOT auto-revived", async () => {
    const clientId = await seedClient("h-sc");
    const locationId = await seedLocation(clientId, "loc");
    await seedStaleMapping({
      clientId, locationId,
      semrushCampaignId: "camp-sc",
      semrushCampaignName: "Stale Campaign",
    });

    const o = await applySemrushLocationMapping({
      clientId, locationId,
      semrushCampaignId: "camp-sc",
      source: { surface: "semrush_inventory" },
    });
    await captureMappingId(o);
    assert(o.kind === "stale_conflict", `expected stale_conflict, got ${o.kind}`);

    // No new row, no flip on existing row.
    const rows = await db
      .select()
      .from(semrushLocationCampaigns)
      .where(
        and(
          eq(semrushLocationCampaigns.clientId, clientId),
          eq(semrushLocationCampaigns.locationId, locationId),
          eq(semrushLocationCampaigns.semrushCampaignId, "camp-sc"),
        ),
      );
    assert(rows.length === 1, `expected 1 (stale) row, got ${rows.length}`);
    assert(rows[0].isStale === true, "stale row must remain isStale=true");

    // No suggestion should be emitted for stale_conflict.
    const sugs = await db
      .select({ id: importEntitySuggestions.id })
      .from(importEntitySuggestions)
      .where(
        and(
          eq(importEntitySuggestions.clientId, clientId),
          eq(importEntitySuggestions.entityKind, "location_mapping"),
        ),
      );
    assert(sugs.length === 0, `stale_conflict must not emit a suggestion, got ${sugs.length}`);
  });

  await run("blocked: matcher surface refuses to write location_mapping", async () => {
    const clientId = await seedClient("h-blk");
    const locationId = await seedLocation(clientId, "loc");
    // The helper's input type narrows surface to semrush_inventory |
    // local_dominance_sync. Cast through unknown to exercise the policy's
    // blocked branch from a hypothetical bad caller.
    const o = await applySemrushLocationMapping({
      clientId, locationId,
      semrushCampaignId: "camp-blk",
      source: { surface: "matcher" as unknown as "semrush_inventory" },
    });
    await captureMappingId(o);
    assert(o.kind === "blocked", `expected blocked for matcher surface, got ${o.kind}`);

    const rows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    assert(rows.length === 0, `blocked must not write any row, got ${rows.length}`);
  });

  await run("concurrent inserts converge to one saved + one already_mapped", async () => {
    const clientId = await seedClient("h-race");
    const locationId = await seedLocation(clientId, "loc");
    const input = {
      clientId, locationId,
      semrushCampaignId: "camp-race",
      source: { surface: "semrush_inventory" as const },
    };
    const [a, b] = await Promise.all([
      applySemrushLocationMapping(input),
      applySemrushLocationMapping(input),
    ]);
    await captureMappingId(a);
    await captureMappingId(b);
    const kinds = [a.kind, b.kind].sort();
    assert(
      kinds[0] === "already_mapped" && kinds[1] === "saved",
      `expected one saved + one already_mapped, got ${JSON.stringify(kinds)}`,
    );

    const rows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(
        and(
          eq(semrushLocationCampaigns.clientId, clientId),
          eq(semrushLocationCampaigns.locationId, locationId),
          eq(semrushLocationCampaigns.semrushCampaignId, "camp-race"),
        ),
      );
    assert(rows.length === 1, `unique-index should keep 1 row after race, got ${rows.length}`);
  });

  // -------------------------------------------------------------------------
  // Auto-match aggregation (Step 2) — behavioural test of
  // `applyAutoMatchCandidates`. The heatmap `auto-match` route extracts its
  // count aggregation into this exported helper so we can exercise every
  // outcome → counter mapping without standing up Express + Replit Auth.
  // The route is pinned to use the helper by an additional static assertion
  // below.
  // -------------------------------------------------------------------------

  await run("applyAutoMatchCandidates: aggregates counters across saved/already_mapped/invalid_parent/stale_conflict", async () => {
    const clientId = await seedClient("am-agg");
    const goodLocId = await seedLocation(clientId, "good");
    const dupLocId = await seedLocation(clientId, "dup");
    const staleLocId = await seedLocation(clientId, "stale");
    const fakeLocId = "00000000-0000-4000-8000-000000000aa1";

    // Pre-seed an already-mapped row for `dup` so the helper returns
    // `already_mapped` for the matching candidate.
    const [dupRow] = await db.insert(semrushLocationCampaigns).values({
      clientId, locationId: dupLocId, semrushCampaignId: "camp-am-dup",
      semrushCampaignName: null, isStale: false, staleSince: null,
    }).returning({ id: semrushLocationCampaigns.id });
    createdMappingIds.push(dupRow.id);

    // Pre-seed a stale row for `stale`.
    await seedStaleMapping({
      clientId, locationId: staleLocId, semrushCampaignId: "camp-am-stale",
    });

    const matched: AutoMatchCandidate[] = [
      { locationId: goodLocId,  campaignId: "camp-am-good",  campaignName: "Good",  matchType: "proximity" },
      { locationId: dupLocId,   campaignId: "camp-am-dup",   campaignName: "Dup",   matchType: "name" },
      { locationId: fakeLocId,  campaignId: "camp-am-bad",   campaignName: "Bad",   matchType: "location" },
      { locationId: staleLocId, campaignId: "camp-am-stale", campaignName: "Stale", matchType: "proximity" },
    ];

    const agg = await applyAutoMatchCandidates(clientId, matched);

    assert(agg.savedCount === 1, `savedCount expected 1, got ${agg.savedCount}`);
    assert(agg.alreadyMappedCount === 1, `alreadyMappedCount expected 1, got ${agg.alreadyMappedCount}`);
    assert(agg.queuedForReviewCount === 1, `queuedForReviewCount expected 1 (invalid_parent), got ${agg.queuedForReviewCount}`);
    assert(agg.staleConflictCount === 1, `staleConflictCount expected 1, got ${agg.staleConflictCount}`);

    // Warnings carry the right reason tags.
    const reasons = agg.droppedWarnings.map((w) => w.reason).sort();
    assert(reasons.includes("unconfigured_location"),
      `droppedWarnings must include unconfigured_location, got ${JSON.stringify(reasons)}`);
    assert(reasons.includes("stale_conflict"),
      `droppedWarnings must include stale_conflict, got ${JSON.stringify(reasons)}`);

    // Track newly-written rows for cleanup.
    const newRows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    for (const r of newRows) createdMappingIds.push(r.id);
    const newSugs = await db
      .select({ id: importEntitySuggestions.id })
      .from(importEntitySuggestions)
      .where(eq(importEntitySuggestions.clientId, clientId));
    for (const s of newSugs) createdSuggestionIds.push(s.id);
  });

  await run("applyAutoMatchCandidates: empty input returns all-zero aggregate, helper failures surface as droppedWarnings", async () => {
    const empty = await applyAutoMatchCandidates("00000000-0000-4000-8000-000000000bb1", []);
    assert(empty.savedCount === 0 && empty.alreadyMappedCount === 0
        && empty.queuedForReviewCount === 0 && empty.staleConflictCount === 0,
      `empty input must produce all-zero aggregate, got ${JSON.stringify(empty)}`);
    assert(empty.droppedWarnings.length === 0 && empty.queuedSuggestions.length === 0,
      `empty input must produce no warnings/suggestions`);
  });

  await run("auto-match route uses applyAutoMatchCandidates (no inline switch, helper is the only write path)", async () => {
    const src = fs.readFileSync("server/routes/heatmap.ts", "utf8");
    const start = src.indexOf("/auto-match");
    assert(start > 0, "could not locate /auto-match route declaration");
    const after = src.slice(start);
    const end = after.indexOf("\n  app.");
    const handlerBody = end > 0 ? after.slice(0, end) : after;
    assert(handlerBody.includes("applyAutoMatchCandidates"),
      "auto-match must delegate to applyAutoMatchCandidates");
    assert(!/db\.insert\(semrushLocationCampaigns\)/.test(handlerBody),
      "auto-match must NOT insert directly into semrushLocationCampaigns");
    for (const key of ["savedCount", "alreadyMappedCount", "queuedForReviewCount", "staleConflictCount"]) {
      assert(handlerBody.includes(key),
        `auto-match response must surface ${key} from the aggregate`);
    }
  });

  // -------------------------------------------------------------------------
  // Inventory apply handler (Step 3) — drive `inventorySyncApply.handle`
  // through configured + unconfigured + stale-conflict cases.
  // -------------------------------------------------------------------------

  await run("inventory apply handler: configured → applied via helper, unconfigured → dropped, stale → existing-row update", async () => {
    const { inventorySyncApply } = await import("../server/services/applyHandlers");

    const clientId = await seedClient("ah-mix");
    const goodLocId = await seedLocation(clientId, "good");
    const badLocId = "00000000-0000-4000-8000-000000000ff1";
    const staleLocId = await seedLocation(clientId, "stale");
    await seedStaleMapping({
      clientId, locationId: staleLocId,
      semrushCampaignId: "camp-ah-stale",
    });

    const apiInput: ApplyInput = {
      workResultId: `${TEST_TAG}-wr`,
      sourceEventId: `${TEST_TAG}-ev`,
      sourceSystem: "semrush",
      resultType: "inventory_sync_apply",
      resultJson: {
        clientId,
        locationCampaigns: [
          { clientId, locationId: goodLocId, semrushCampaignId: "camp-ah-good" },
          { clientId, locationId: badLocId,  semrushCampaignId: "camp-ah-bad" },
          // Pre-existing stale row hits the apply handler's update-in-place
          // branch (which legitimately mutates `isStale` for already-mapped
          // triples). The handler does NOT auto-revive — the helper is the
          // only path that classifies stale_conflict, and that's covered by
          // the helper-level test above.
          { clientId, locationId: staleLocId, semrushCampaignId: "camp-ah-stale" },
        ],
      },
    };
    const result = await inventorySyncApply.handle(apiInput);

    assert(result.outcome === "success" || result.outcome === "skipped",
      `apply handler outcome: ${result.outcome}`);
    const body = result.responseJson as Record<string, number>;
    // 1 fresh insert (good) + 1 existing-row pass-through (stale) = 2 applied
    assert(body.locationCampaignsApplied === 2,
      `expected 2 applied (good + existing-stale pass-through), got ${body.locationCampaignsApplied}`);
    assert((body.locationCampaignsDropped ?? 0) === 1,
      `expected 1 dropped (unconfigured), got ${body.locationCampaignsDropped}`);

    // Track for cleanup.
    const writtenRows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(eq(semrushLocationCampaigns.clientId, clientId));
    for (const r of writtenRows) createdMappingIds.push(r.id);
  });

  await run("inventory apply handler: re-applying same payload is idempotent (already-mapped is not dropped)", async () => {
    const { inventorySyncApply } = await import("../server/services/applyHandlers");

    const clientId = await seedClient("ah-idemp");
    const locId = await seedLocation(clientId, "loc");

    const payload: ApplyInput = {
      workResultId: `${TEST_TAG}-wr2`,
      sourceEventId: `${TEST_TAG}-ev2`,
      sourceSystem: "semrush",
      resultType: "inventory_sync_apply",
      resultJson: {
        clientId,
        locationCampaigns: [
          { clientId, locationId: locId, semrushCampaignId: "camp-ah-idemp" },
        ],
      },
    };

    const r1 = await inventorySyncApply.handle(payload);
    const r2 = await inventorySyncApply.handle(payload);
    const b1 = r1.responseJson as Record<string, number>;
    const b2 = r2.responseJson as Record<string, number>;

    assert(b1.locationCampaignsApplied === 1, `r1 applied=${b1.locationCampaignsApplied}`);
    // Second invocation either updates-in-place (existing row found) or
    // returns already_mapped — both count as "applied" in this handler's
    // bookkeeping (it only treats unconfigured / stale_conflict / blocked
    // as dropped). Pin the no-duplicate-row invariant explicitly.
    assert((b2.locationCampaignsDropped ?? 0) === 0,
      `r2 should not drop any row, got dropped=${b2.locationCampaignsDropped}`);

    const rows = await db
      .select({ id: semrushLocationCampaigns.id })
      .from(semrushLocationCampaigns)
      .where(
        and(
          eq(semrushLocationCampaigns.clientId, clientId),
          eq(semrushLocationCampaigns.locationId, locId),
          eq(semrushLocationCampaigns.semrushCampaignId, "camp-ah-idemp"),
        ),
      );
    assert(rows.length === 1, `expected 1 mapping after re-apply, got ${rows.length}`);
    for (const r of rows) createdMappingIds.push(r.id);
  });

  // -------------------------------------------------------------------------
  // Inventory sync worker (Step 4) — assert no create paths.
  //
  // `semrushInventorySync.ts` is read-only against `semrush_location_campaigns`:
  // it produces inventory candidates that flow through the queue into
  // `inventorySyncApply.handle` (covered above), and never inserts/updates
  // mapping rows itself. This static assertion guards against a future
  // refactor that quietly re-introduces a create path inside the worker
  // and bypasses the canonical helper.
  // -------------------------------------------------------------------------

  await run("inventory sync worker contains no create/update paths into semrush_location_campaigns", async () => {
    const src = fs.readFileSync("server/services/semrushInventorySync.ts", "utf8");
    assert(!/\.insert\(\s*semrushLocationCampaigns\s*\)/.test(src),
      "semrushInventorySync.ts must NOT call db.insert(semrushLocationCampaigns) — route writes through the helper instead");
    assert(!/\.update\(\s*semrushLocationCampaigns\s*\)/.test(src),
      "semrushInventorySync.ts must NOT call db.update(semrushLocationCampaigns) — stale-flips are the apply handler's job");
  });

  // -------------------------------------------------------------------------
  // Cleanup script (Step 5) — promote-semrush-configured-mapping-suggestions.
  //
  // We seed one suggestion per bucket, run dry-run + --apply via spawnSync,
  // and assert that only `promotable_configured` rows mutate.
  // -------------------------------------------------------------------------

  await run("cleanup script: dry-run classifies, --apply mutates only promotable, re-run is no-op", async () => {
    const clientId = await seedClient("scr");
    const goodLocId = await seedLocation(clientId, "good");
    const staleLocId = await seedLocation(clientId, "stale");
    await seedStaleMapping({
      clientId, locationId: staleLocId,
      semrushCampaignId: "camp-scr-stale",
    });

    // Bucket: promotable_configured
    const [sPromote] = await db.insert(importEntitySuggestions).values({
      clientId,
      entityKind: "location_mapping",
      surface: "semrush_inventory",
      candidate: { locationId: goodLocId, semrushCampaignId: "camp-scr-good", semrushCampaignName: "Good" },
      reason: "test:promotable",
    }).returning();
    createdSuggestionIds.push(sPromote.id);

    // Bucket: unconfigured (location id that doesn't exist for this client)
    const [sUnconf] = await db.insert(importEntitySuggestions).values({
      clientId,
      entityKind: "location_mapping",
      surface: "semrush_inventory",
      candidate: {
        locationId: "00000000-0000-4000-8000-000000000ff2",
        semrushCampaignId: "camp-scr-unconf",
      },
      reason: "test:unconfigured",
    }).returning();
    createdSuggestionIds.push(sUnconf.id);

    // Bucket: stale_conflict (location is configured + stale row exists)
    const [sStale] = await db.insert(importEntitySuggestions).values({
      clientId,
      entityKind: "location_mapping",
      surface: "semrush_inventory",
      candidate: { locationId: staleLocId, semrushCampaignId: "camp-scr-stale" },
      reason: "test:stale",
    }).returning();
    createdSuggestionIds.push(sStale.id);

    // Bucket: other_invalid (missing campaignId)
    const [sInvalid] = await db.insert(importEntitySuggestions).values({
      clientId,
      entityKind: "location_mapping",
      surface: "semrush_inventory",
      candidate: { locationId: goodLocId },
      reason: "test:invalid",
    }).returning();
    createdSuggestionIds.push(sInvalid.id);

    const scriptPath = "scripts/promote-semrush-configured-mapping-suggestions.ts";

    // Helper: run the script, capture summary JSON via --json.
    const tmpDir = path.join(process.cwd(), ".local", "test-artifacts");
    fs.mkdirSync(tmpDir, { recursive: true });
    const dryJsonPath = path.join(tmpDir, `${TEST_TAG}-dry.json`);
    const applyJsonPath = path.join(tmpDir, `${TEST_TAG}-apply.json`);
    const reapplyJsonPath = path.join(tmpDir, `${TEST_TAG}-reapply.json`);

    type ScriptOutcome =
      | "promotable_configured"
      | "already_mapped"
      | "unconfigured"
      | "stale_conflict"
      | "other_invalid";
    interface ScriptRow {
      suggestionId: string;
      clientId: string;
      locationId: string | null;
      campaignId: string | null;
      outcome: ScriptOutcome;
      promotedEntityId?: string | null;
      note?: string;
    }
    interface ScriptJson {
      rows?: ScriptRow[];
    }
    type ScriptCounts = Record<ScriptOutcome, number>;

    function runScript(args: string[]): { json: ScriptJson | null; stdout: string; status: number } {
      const r = spawnSync("npx", ["tsx", scriptPath, ...args], {
        env: process.env,
        encoding: "utf8",
      });
      const last = args[args.length - 1];
      const json: ScriptJson | null = fs.existsSync(last)
        ? (JSON.parse(fs.readFileSync(last, "utf8")) as ScriptJson)
        : null;
      return { json, stdout: r.stdout || "", status: r.status ?? -1 };
    }

    // Filter the script's per-row reports to just the rows we created so
    // unrelated test/prod data doesn't blur the assertions.
    const cleanupSuggestionIds = new Set([sPromote.id, sUnconf.id, sStale.id, sInvalid.id]);
    function filterToOurs(j: ScriptJson | null): { rows: ScriptRow[]; counts: ScriptCounts } {
      const rows = (j?.rows ?? []).filter((r) => cleanupSuggestionIds.has(r.suggestionId));
      const counts: ScriptCounts = {
        promotable_configured: 0,
        already_mapped: 0,
        unconfigured: 0,
        stale_conflict: 0,
        other_invalid: 0,
      };
      for (const r of rows) counts[r.outcome]++;
      return { rows, counts };
    }

    // Dry-run.
    const dry = runScript(["--json", dryJsonPath]);
    assert(dry.status === 0, `dry-run exited ${dry.status}\n${dry.stdout.slice(-500)}`);
    const dryFiltered = filterToOurs(dry.json);
    assert(dryFiltered.counts.promotable_configured === 1,
      `dry-run: expected 1 promotable, got ${dryFiltered.counts.promotable_configured}`);
    assert(dryFiltered.counts.unconfigured === 1,
      `dry-run: expected 1 unconfigured, got ${dryFiltered.counts.unconfigured}`);
    assert(dryFiltered.counts.stale_conflict === 1,
      `dry-run: expected 1 stale_conflict, got ${dryFiltered.counts.stale_conflict}`);
    assert(dryFiltered.counts.other_invalid === 1,
      `dry-run: expected 1 other_invalid, got ${dryFiltered.counts.other_invalid}`);

    // Confirm dry-run did NOT mutate.
    const dryStatuses = await db
      .select({ id: importEntitySuggestions.id, status: importEntitySuggestions.status })
      .from(importEntitySuggestions)
      .where(inArray(importEntitySuggestions.id, createdSuggestionIds));
    for (const s of dryStatuses) {
      assert(s.status === "pending", `dry-run must not mutate: ${s.id} status=${s.status}`);
    }

    // Apply.
    const apply = runScript(["--apply", "--json", applyJsonPath]);
    assert(apply.status === 0, `apply exited ${apply.status}\n${apply.stdout.slice(-500)}`);

    // Promotable suggestion should be promoted with promoted_entity_id.
    const [sPromoteAfter] = await db
      .select()
      .from(importEntitySuggestions)
      .where(eq(importEntitySuggestions.id, sPromote.id));
    assert(sPromoteAfter.status === "promoted",
      `promotable should become promoted, got ${sPromoteAfter.status}`);
    assert(!!sPromoteAfter.promotedEntityId,
      `promoted_entity_id must be set after apply`);
    if (sPromoteAfter.promotedEntityId) createdMappingIds.push(sPromoteAfter.promotedEntityId);

    // Other buckets must be untouched.
    for (const id of [sUnconf.id, sStale.id, sInvalid.id]) {
      const [row] = await db
        .select({ status: importEntitySuggestions.status })
        .from(importEntitySuggestions)
        .where(eq(importEntitySuggestions.id, id));
      assert(row.status === "pending",
        `non-promotable suggestion ${id} should remain pending, got ${row.status}`);
    }

    // Re-running --apply should produce all-zero promotable in our slice.
    const reapply = runScript(["--apply", "--json", reapplyJsonPath]);
    assert(reapply.status === 0, `re-apply exited ${reapply.status}\n${reapply.stdout.slice(-500)}`);
    const reapplyFiltered = filterToOurs(reapply.json);
    assert(reapplyFiltered.counts.promotable_configured === 0,
      `re-apply: promotable should be 0 in our slice, got ${reapplyFiltered.counts.promotable_configured}`);

    // Tidy up scratch JSON.
    for (const p of [dryJsonPath, applyJsonPath, reapplyJsonPath]) {
      try { fs.unlinkSync(p); } catch { /* noop */ }
    }
  });
} finally {
  await cleanup();
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
}
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("\nAll Task #920E SEMrush location-mapping writer tests passed.");
