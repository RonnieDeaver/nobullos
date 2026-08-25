# scripts/

One-shot maintenance, audit, and verification scripts. Most are intentionally
manual — they are not wired to a worker, route, or schedule. Run with `tsx`
from the project root:

```
tsx scripts/<name>.ts [flags]
```

## Conventions

- **Dry-run by default.** Anything that mutates the database requires an
  explicit `--apply` flag. Without it the script prints what it would do.
- **Exit codes.** `0` = success, `1` = unhandled error, `2` = bad CLI args.
- **JSON output.** Audit/cleanup scripts that produce a machine-readable
  summary write it under `tmp/` (and/or to a path passed via `--json`).

## Selected scripts

### `promote-semrush-configured-mapping-suggestions.ts` (Task #920D)

Drains the pile of `pending` rows in `import_entity_suggestions` where
`entity_kind = 'location_mapping'` that piled up between Task #755 and
Task #920A. Routes each candidate through the canonical write helper from
Task #920B (`server/services/semrushLocationMappingWriter.ts`) so promotion
semantics are identical to live writes.

Classifies every pending suggestion into:

- `promotable_configured` — parent `(clientId, locationId)` is configured AND
  no non-stale `semrush_location_campaigns` row exists for the triple. Under
  `--apply` the helper inserts the mapping row and the suggestion is marked
  `promoted` with `promoted_entity_id` pointing at the new row.
- `already_mapped` — a non-stale row already exists for the triple. Under
  `--apply` the suggestion is marked `promoted` pointing at the existing row;
  no insert.
- `unconfigured` — parent missing from `client_locations`. Reported only.
- `stale_conflict` — only a stale row exists for the triple. Reported only;
  the helper never auto-revives stale rows.
- `other_invalid` — candidate JSON missing `locationId` / `semrushCampaignId`.
  Reported only.

Usage:

```
tsx scripts/promote-semrush-configured-mapping-suggestions.ts            # dry-run
tsx scripts/promote-semrush-configured-mapping-suggestions.ts --apply    # mutate
tsx scripts/promote-semrush-configured-mapping-suggestions.ts --json out.json
```

Idempotent: re-running `--apply` on a cleaned-up DB produces all-zero
`promotable_configured` and `already_mapped`.

### `cleanup-import-ghosts.ts`

Audits ghost rows left over from the pre-Task-#755 import path
(`semrush_location_campaigns` whose `(client_id, location_id)` is no longer
in `client_locations`, auto-discovered Front contacts, and a count breakdown
of `import_entity_suggestions`). Only the unambiguous SEMrush ghost case is
mutated under `--apply`.

### `cleanup-ghost-gbp-locations.ts`

Strips ghost GBP locations from `report_sections.data` for `marketing`
sections. Backs up each report's original `gbp.locations` array before
overwriting under `--apply`.

### `cleanup-bloated-contacts-task-914.ts`

Trims `client_contacts.emails` arrays back to a hand-curated allowlist for
specific clients. Edit the `TARGETS` array before running with `--apply`.

### `verify-domains.ts`

Exercises every API domain against a running server. Useful for smoke-testing
after large refactors.

Other scripts in this directory follow the same conventions; see each file's
header comment for details.
