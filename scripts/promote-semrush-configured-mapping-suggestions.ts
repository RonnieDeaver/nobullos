/**
 * Task #920D — Promote currently stuck `pending` SEMrush location-mapping
 * suggestions whose (clientId, locationId) IS configured in
 * `client_locations`.
 *
 * Background
 * ----------
 * Between Task #755 (April 24) and Task #920A, the import-write policy
 * mapped every SEMrush `location_mapping` candidate — even those whose
 * parent (clientId, locationId) was already configured — to
 * `allow_review_suggestion`. The auto-match endpoint did its job but the
 * policy blocked the write, so each match landed in
 * `import_entity_suggestions` as `pending` and stayed there forever
 * (zero have ever been promoted). 920A fixed the policy and 920B added a
 * canonical write helper. This script drains the existing pile of
 * pending suggestions through that helper.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: every pending `location_mapping` suggestion is
 * scanned and classified into one of:
 *
 *   - promotable_configured  (clientId, locationId) is configured AND no
 *                            non-stale row exists for the triple — would
 *                            be inserted via applySemrushLocationMapping
 *   - already_mapped         a non-stale row already exists for the
 *                            triple — under --apply we mark the suggestion
 *                            promoted with promoted_entity_id pointing at
 *                            the existing row so the queue empties cleanly
 *   - unconfigured           parent (clientId, locationId) missing from
 *                            client_locations — left alone
 *   - stale_conflict         only a stale row exists for the triple — left
 *                            alone (operator decision; never auto-revived)
 *   - other_invalid          missing/malformed candidate fields — left alone
 *
 * `--apply` is required to mutate. Dry-run performs all reads, no writes.
 *
 * Usage:
 *   tsx scripts/promote-semrush-configured-mapping-suggestions.ts
 *   tsx scripts/promote-semrush-configured-mapping-suggestions.ts --apply
 *   tsx scripts/promote-semrush-configured-mapping-suggestions.ts --json out.json
 *
 * Exit codes:
 *   0  scan/apply ran cleanly
 *   1  unhandled error
 *   2  bad CLI arguments
 *
 * Idempotent: re-running --apply on a cleaned-up DB produces all-zero
 * `promotable_configured`/`already_mapped` counts.
 */

import * as fs from "fs";
import * as path from "path";

interface Args {
  apply: boolean;
  jsonPath?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--json") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) {
        console.error("--json requires a path argument");
        process.exit(2);
      }
      out.jsonPath = next;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "promote-semrush-configured-mapping-suggestions.ts [--apply] [--json <path>]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

type Outcome =
  | "promotable_configured"
  | "already_mapped"
  | "unconfigured"
  | "stale_conflict"
  | "other_invalid";

interface RowReport {
  suggestionId: string;
  clientId: string;
  locationId: string | null;
  campaignId: string | null;
  outcome: Outcome;
  promotedEntityId?: string | null;
  note?: string;
}

async function main() {
  const args = parseArgs(process.argv);
  const { db } = await import("../server/db");
  const {
    importEntitySuggestions,
    semrushLocationCampaigns,
    clientLocations,
  } = await import("@shared/schema");
  const { and, eq } = await import("drizzle-orm");
  const { applySemrushLocationMapping } = await import(
    "../server/services/semrushLocationMappingWriter"
  );

  console.log(
    `[promote-920D] mode=${args.apply ? "APPLY" : "DRY-RUN"} startedAt=${new Date().toISOString()}`,
  );

  // 1. Pull every pending location_mapping suggestion.
  const pending = await db
    .select()
    .from(importEntitySuggestions)
    .where(
      and(
        eq(importEntitySuggestions.entityKind, "location_mapping"),
        eq(importEntitySuggestions.status, "pending"),
      ),
    );

  console.log(`[promote-920D] pending location_mapping suggestions: ${pending.length}`);

  // 2. Pre-load configured (clientId, locationId) set and existing
  //    semrush_location_campaigns rows for the triples we'll touch. Two
  //    bulk reads beats N round-trips.
  const allLocs = await db
    .select({ id: clientLocations.id, clientId: clientLocations.clientId })
    .from(clientLocations);
  const configuredKey = new Set(allLocs.map((l) => `${l.clientId}::${l.id}`));

  const allMappings = await db
    .select({
      id: semrushLocationCampaigns.id,
      clientId: semrushLocationCampaigns.clientId,
      locationId: semrushLocationCampaigns.locationId,
      semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
      isStale: semrushLocationCampaigns.isStale,
    })
    .from(semrushLocationCampaigns);

  type MappingRow = (typeof allMappings)[number];
  const mappingByTriple = new Map<string, MappingRow[]>();
  for (const m of allMappings) {
    const k = `${m.clientId}::${m.locationId}::${m.semrushCampaignId}`;
    const arr = mappingByTriple.get(k) ?? [];
    arr.push(m);
    mappingByTriple.set(k, arr);
  }

  // 3. Classify pass.
  const reports: RowReport[] = [];
  for (const s of pending) {
    const candidate = (s.candidate as Record<string, unknown> | null) ?? {};
    const locationId = typeof candidate.locationId === "string" ? candidate.locationId : null;
    const campaignId =
      typeof candidate.semrushCampaignId === "string" ? candidate.semrushCampaignId : null;

    if (!locationId || !campaignId) {
      reports.push({
        suggestionId: s.id,
        clientId: s.clientId,
        locationId,
        campaignId,
        outcome: "other_invalid",
        note: "candidate missing locationId or semrushCampaignId",
      });
      continue;
    }

    if (!configuredKey.has(`${s.clientId}::${locationId}`)) {
      reports.push({
        suggestionId: s.id,
        clientId: s.clientId,
        locationId,
        campaignId,
        outcome: "unconfigured",
      });
      continue;
    }

    const existing = mappingByTriple.get(`${s.clientId}::${locationId}::${campaignId}`) ?? [];
    const live = existing.find((r) => !r.isStale);
    if (live) {
      reports.push({
        suggestionId: s.id,
        clientId: s.clientId,
        locationId,
        campaignId,
        outcome: "already_mapped",
        promotedEntityId: live.id,
      });
      continue;
    }
    if (existing.length > 0) {
      // only stale rows
      reports.push({
        suggestionId: s.id,
        clientId: s.clientId,
        locationId,
        campaignId,
        outcome: "stale_conflict",
        note: `stale row id=${existing[0].id}`,
      });
      continue;
    }

    reports.push({
      suggestionId: s.id,
      clientId: s.clientId,
      locationId,
      campaignId,
      outcome: "promotable_configured",
    });
  }

  // 4. Apply pass — only the `promotable_configured` and `already_mapped`
  //    buckets mutate. `already_mapped` only updates the suggestion row,
  //    no insert.
  let promotedFreshly = 0;
  let promotedAlreadyMapped = 0;
  if (args.apply) {
    for (const r of reports) {
      if (r.outcome === "promotable_configured") {
        const sugRow = pending.find((p) => p.id === r.suggestionId)!;
        const sourceRef =
          (sugRow.sourceRef as Record<string, unknown> | null) ?? null;
        try {
          await db.transaction(async (tx) => {
            const candidate =
              (sugRow.candidate as Record<string, unknown> | null) ?? {};
            const semrushCampaignName =
              typeof candidate.semrushCampaignName === "string"
                ? (candidate.semrushCampaignName as string)
                : null;
            const matchType =
              typeof candidate.matchType === "string"
                ? (candidate.matchType as string)
                : null;

            const outcome = await applySemrushLocationMapping(
              {
                clientId: sugRow.clientId,
                locationId: r.locationId!,
                semrushCampaignId: r.campaignId!,
                semrushCampaignName,
                source: {
                  surface: "semrush_inventory",
                  sourceRef,
                  matchType,
                },
              },
              { tx },
            );

            if (outcome.kind === "saved") {
              await tx
                .update(importEntitySuggestions)
                .set({
                  status: "promoted",
                  promotedEntityId: outcome.row.id,
                  reviewedAt: new Date(),
                })
                .where(eq(importEntitySuggestions.id, sugRow.id));
              r.promotedEntityId = outcome.row.id;
              promotedFreshly++;
            } else if (outcome.kind === "already_mapped") {
              // Race: another writer beat us between classify and apply.
              await tx
                .update(importEntitySuggestions)
                .set({
                  status: "promoted",
                  promotedEntityId: outcome.row.id,
                  reviewedAt: new Date(),
                })
                .where(eq(importEntitySuggestions.id, sugRow.id));
              r.outcome = "already_mapped";
              r.promotedEntityId = outcome.row.id;
              r.note = "raced with concurrent writer";
              promotedAlreadyMapped++;
            } else {
              // Pre-classification said this was insertable. Anything else
              // is a surprise — log loudly and roll back this suggestion.
              console.warn(
                `[promote-920D] UNEXPECTED outcome=${outcome.kind} suggestion=${sugRow.id} — leaving pending`,
              );
              r.note = `apply-phase unexpected outcome ${outcome.kind}`;
              throw new Error(`unexpected outcome ${outcome.kind}`);
            }
          });
        } catch (err) {
          console.error(
            `[promote-920D] FAILED suggestion=${r.suggestionId}: ${(err as Error).message}`,
          );
        }
      } else if (r.outcome === "already_mapped" && r.promotedEntityId) {
        // Triple already lives in semrush_location_campaigns. The
        // user-visible state is identical to a successful promotion, so
        // mark the suggestion `promoted` and point it at the existing
        // row. No insert.
        await db
          .update(importEntitySuggestions)
          .set({
            status: "promoted",
            promotedEntityId: r.promotedEntityId,
            reviewedAt: new Date(),
          })
          .where(eq(importEntitySuggestions.id, r.suggestionId));
        promotedAlreadyMapped++;
      }
    }
  }

  // 5. Per-row report.
  console.log("\n[promote-920D] per-row classification:");
  for (const r of reports) {
    const tail = [
      r.promotedEntityId ? `promoted_entity_id=${r.promotedEntityId}` : "",
      r.note ? `note="${r.note}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `  suggestion=${r.suggestionId} client=${r.clientId} location=${r.locationId ?? "?"} campaign=${r.campaignId ?? "?"} outcome=${r.outcome}${tail ? ` ${tail}` : ""}`,
    );
  }

  // 6. Summary.
  const counts: Record<Outcome, number> = {
    promotable_configured: 0,
    already_mapped: 0,
    unconfigured: 0,
    stale_conflict: 0,
    other_invalid: 0,
  };
  for (const r of reports) counts[r.outcome]++;

  console.log("\n[promote-920D] summary:");
  console.log(`  scanned                = ${reports.length}`);
  console.log(`  promotable_configured  = ${counts.promotable_configured}`);
  console.log(`  already_mapped         = ${counts.already_mapped}`);
  console.log(`  unconfigured           = ${counts.unconfigured}`);
  console.log(`  stale_conflict         = ${counts.stale_conflict}`);
  console.log(`  other_invalid          = ${counts.other_invalid}`);
  if (args.apply) {
    console.log(`  promoted (fresh insert)= ${promotedFreshly}`);
    console.log(`  promoted (already-map) = ${promotedAlreadyMapped}`);
  } else {
    console.log("\n  DRY-RUN — re-run with --apply to mutate the buckets above.");
  }

  // 7. Markdown report (human-readable).
  const md: string[] = [];
  md.push(`# Task #920D — Promotion Report`);
  md.push("");
  md.push(`- mode: \`${args.apply ? "APPLY" : "DRY-RUN"}\``);
  md.push(`- captured at: ${new Date().toISOString()}`);
  md.push(`- scanned: ${reports.length}`);
  md.push("");
  md.push(`## Summary`);
  md.push("");
  md.push(`| outcome | count |`);
  md.push(`| --- | ---: |`);
  md.push(`| promotable_configured | ${counts.promotable_configured} |`);
  md.push(`| already_mapped        | ${counts.already_mapped} |`);
  md.push(`| unconfigured          | ${counts.unconfigured} |`);
  md.push(`| stale_conflict        | ${counts.stale_conflict} |`);
  md.push(`| other_invalid         | ${counts.other_invalid} |`);
  if (args.apply) {
    md.push("");
    md.push(`- promoted (fresh insert): ${promotedFreshly}`);
    md.push(`- promoted (already-mapped link): ${promotedAlreadyMapped}`);
  }
  md.push("");
  md.push(`## Per-row classification`);
  md.push("");
  md.push(`| suggestion | client | location | campaign | outcome | promoted_entity_id |`);
  md.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const r of reports) {
    md.push(
      `| ${r.suggestionId} | ${r.clientId} | ${r.locationId ?? "?"} | ${r.campaignId ?? "?"} | ${r.outcome} | ${r.promotedEntityId ?? ""} |`,
    );
  }
  console.log("\n" + md.join("\n"));

  // 8. JSON dump.
  const summaryJson = {
    mode: args.apply ? "APPLY" : "DRY-RUN",
    capturedAt: new Date().toISOString(),
    counts,
    promotedFreshly,
    promotedAlreadyMapped,
    rows: reports,
  };
  if (args.jsonPath) {
    const abs = path.resolve(process.cwd(), args.jsonPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(summaryJson, null, 2));
    console.log(`\n[promote-920D] JSON summary written to ${abs}`);
  } else {
    console.log("\n[promote-920D] JSON summary:");
    console.log(JSON.stringify(summaryJson, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[promote-920D] Failed:", err);
    process.exit(1);
  });
