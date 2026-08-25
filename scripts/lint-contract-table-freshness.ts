/**
 * lint-contract-table-freshness.ts
 *
 * Freshness guard for the committed API endpoint contract table
 * (audits/D-endpoint-contract-table.{md,json}).
 *
 * Background: the table silently rotted after Task #1574 generated it —
 * later tasks added docs/, drive-import, and zoom match-assistant routes
 * (and removed legacy google-ads routes) without regenerating, so a later
 * regen showed ~37 added / 4 removed rows that had nothing to do with the
 * regenerating task. The route inventory has a freshness lint
 * (lint-route-inventory-freshness); this closes the same gap for the
 * contract table.
 *
 * Design: the table is generated deterministically FROM
 * tests/route-inventory.json, which is itself freshness-guarded against the
 * live route tree. So this lint only needs to compare the committed contract
 * JSON against the committed inventory (method, path, handler file:line, and
 * row order) plus the md header's "Total routes: N" count — no source
 * count — and the md's per-endpoint table rows (method/path/handler, in
 * order), so the human-facing table can't rot independently of the JSON.
 * No source rescans, no corpus scans. Transitivity through the inventory lint keeps
 * the table current: any route add/remove/move forces an inventory regen,
 * which then flags the contract table here until it is regenerated too.
 * Task #4105: middleware-only changes (e.g. isAuthenticated swapped for
 * requireCeo on the same registration line) update the inventory's
 * `middleware` field without moving the handler file:line, so the signature
 * comparison alone would let the auth/role/classification columns rot. The
 * lint therefore also RECOMPUTES those three columns from the inventory's
 * middleware field via the shared pure classifiers
 * (scripts/contract-table-classifiers.mjs, extracted from the generator) and
 * flags any drift in the committed JSON. Remaining derived columns
 * (request/response inference, caller lists) are deliberately NOT
 * independently diffed, since they depend on the whole client/tests corpus
 * (and handler source windows) and would force a regen on every unrelated
 * frontend edit.
 *
 * Remediation when this fires:
 *   node scripts/generate-endpoint-contract-table.mjs
 *   then commit audits/D-endpoint-contract-table.md and .json.
 *
 * Exit 0 = fresh; 1 = stale.
 */
import * as fs from "node:fs";
import { authClass, roleClass, trackDClass } from "./contract-table-classifiers.mjs";

const INVENTORY_JSON = "tests/route-inventory.json";
const CONTRACT_JSON = "audits/D-endpoint-contract-table.json";
const CONTRACT_MD = "audits/D-endpoint-contract-table.md";

export const REMEDIATION =
  "Run `node scripts/generate-endpoint-contract-table.mjs` and commit the updated " +
  "audits/D-endpoint-contract-table.md and audits/D-endpoint-contract-table.json.";

interface InventoryRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  middleware?: string[];
}

interface ContractRow {
  method: string;
  path: string;
  handler: string;
  auth?: string;
  role?: string;
  classification?: string;
}

export interface ContractTableLintResult {
  ok: boolean;
  inventoryCount: number;
  contractCount: number | null;
  problems: string[];
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Extracts `${method} ${path} @ ${handler}` signatures from the md's
 * per-endpoint table rows. Row shape (generator-emitted):
 *   | METHOD | `path` | file:line | auth | role | ... |
 * Header/separator/count-table rows don't match the METHOD + backtick-path
 * shape and are skipped.
 */
export function parseMdEndpointRows(md: string): string[] {
  const sigs: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\| ([A-Z]+) \| `([^`]+)` \| ([^|]+?) \|/);
    if (m) sigs.push(`${m[1]} ${m[2]} @ ${m[3].trim()}`);
  }
  return sigs;
}

/**
 * Task #4105: parses the auth/role/classification cells from the md's
 * per-endpoint rows (columns 4, 5, and 10 of the generator-emitted row).
 * Returns one entry per endpoint row, aligned 1:1 with parseMdEndpointRows —
 * a row missing cells (truncated/malformed) yields `null` so the caller can
 * flag it instead of silently skipping it.
 */
export function parseMdDerivedCells(
  md: string,
): ({ auth: string; role: string; classification: string } | null)[] {
  const out: ({ auth: string; role: string; classification: string } | null)[] = [];
  for (const line of md.split("\n")) {
    if (!/^\| ([A-Z]+) \| `([^`]+)` \| ([^|]+?) \|/.test(line)) continue;
    const cells = line.split(" | ").map((c) => c.replace(/^\| |\ \|$/g, "").trim());
    // cells: [method, path, handler, auth, role, request, response, fe, ex, classification]
    if (cells.length < 10) {
      out.push(null);
      continue;
    }
    out.push({
      auth: cells[3],
      role: cells[4],
      classification: cells[9].replace(/\s*\|$/, ""),
    });
  }
  return out;
}

/**
 * Pure core, unit-testable: compares committed contract-table artifacts
 * against the committed route inventory. Callers may inject paths/routes
 * for fixture testing.
 */
export function runLint(options?: {
  inventoryRoutes?: InventoryRoute[];
  contractJsonPath?: string;
  contractMdPath?: string;
}): ContractTableLintResult {
  const contractJsonPath = options?.contractJsonPath ?? CONTRACT_JSON;
  const contractMdPath = options?.contractMdPath ?? CONTRACT_MD;
  const problems: string[] = [];

  let inventory: InventoryRoute[];
  if (options?.inventoryRoutes) {
    inventory = options.inventoryRoutes;
  } else {
    const raw = JSON.parse(fs.readFileSync(INVENTORY_JSON, "utf-8"));
    inventory = Array.isArray(raw) ? raw : raw.routes;
  }

  let contractCount: number | null = null;

  // 1. Committed contract JSON rows match the inventory (method, path,
  //    handler, order).
  if (!fs.existsSync(contractJsonPath)) {
    problems.push(`${contractJsonPath} is missing. ${REMEDIATION}`);
  } else {
    let rows: ContractRow[] | null = null;
    try {
      rows = JSON.parse(fs.readFileSync(contractJsonPath, "utf-8")) as ContractRow[];
    } catch {
      problems.push(`${contractJsonPath} is not valid JSON. ${REMEDIATION}`);
    }
    if (rows) {
      contractCount = rows.length;
      const invSig = inventory.map(
        (r) => `${routeKey(r.method, r.path)} @ ${r.file}:${r.line}`,
      );
      const rowSig = rows.map(
        (r) => `${routeKey(r.method, r.path)} @ ${r.handler}`,
      );
      if (JSON.stringify(invSig) !== JSON.stringify(rowSig)) {
        const invKeys = new Set(inventory.map((r) => routeKey(r.method, r.path)));
        const rowKeys = new Set(rows.map((r) => routeKey(r.method, r.path)));
        const missing = inventory
          .map((r) => routeKey(r.method, r.path))
          .filter((k) => !rowKeys.has(k));
        const phantom = rows
          .map((r) => routeKey(r.method, r.path))
          .filter((k) => !invKeys.has(k));
        const sample = (label: string, keys: string[]) =>
          keys.length
            ? `${label} (${keys.length}): ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`
            : null;
        const details = [
          sample("routes in inventory but not in contract table", Array.from(new Set(missing))),
          sample("phantom rows in contract table but not in inventory", Array.from(new Set(phantom))),
        ].filter((d): d is string => d !== null);
        if (details.length === 0) {
          details.push(
            "same route set, but handler file:line or row order drifted from the inventory",
          );
        }
        problems.push(
          `${contractJsonPath} is STALE — table has ${rows.length} row(s), inventory has ${inventory.length}. ` +
            details.join("; ") +
            `. ${REMEDIATION}`,
        );
      } else {
        // Task #4105: signatures match, but a middleware-only change (same
        // registration line) still updates the inventory's middleware field.
        // Recompute the middleware-derived columns and flag drift.
        const drift: string[] = [];
        for (let i = 0; i < inventory.length; i++) {
          const inv = inventory[i];
          const row = rows[i];
          const expected = {
            auth: authClass(inv),
            role: roleClass(inv),
            classification: trackDClass(inv),
          };
          for (const col of ["auth", "role", "classification"] as const) {
            if (row[col] !== expected[col]) {
              drift.push(
                `${routeKey(inv.method, inv.path)}: ${col} is "${row[col]}", middleware implies "${expected[col]}"`,
              );
            }
          }
        }
        if (drift.length) {
          problems.push(
            `${contractJsonPath} has STALE middleware-derived columns (${drift.length} drifted cell(s)): ` +
              drift.slice(0, 10).join("; ") +
              (drift.length > 10 ? "; …" : "") +
              `. ${REMEDIATION}`,
          );
        }
      }
    }
  }

  // 2. md artifact matches too (the md embeds a generation timestamp, so a
  //    byte-diff would always fail). Checked: the "Total routes: N" header,
  //    AND every per-endpoint table row's method/path/handler cells in order —
  //    the human-facing table itself must match the inventory, not just its
  //    row count.
  if (!fs.existsSync(contractMdPath)) {
    problems.push(`${contractMdPath} is missing. ${REMEDIATION}`);
  } else {
    const md = fs.readFileSync(contractMdPath, "utf-8");
    const m = md.match(/^Total routes: (\d+)$/m);
    if (!m) {
      problems.push(`${contractMdPath} has no "Total routes: N" header. ${REMEDIATION}`);
    } else if (Number(m[1]) !== inventory.length) {
      problems.push(
        `${contractMdPath} is STALE — header says ${m[1]} routes, inventory has ${inventory.length}. ${REMEDIATION}`,
      );
    }
    const mdSig = parseMdEndpointRows(md);
    const invSig = inventory.map(
      (r) => `${routeKey(r.method, r.path)} @ ${r.file}:${r.line}`,
    );
    if (JSON.stringify(mdSig) !== JSON.stringify(invSig)) {
      const invKeys = new Set(invSig);
      const mdKeys = new Set(mdSig);
      const missing = invSig.filter((k) => !mdKeys.has(k));
      const phantom = mdSig.filter((k) => !invKeys.has(k));
      const sample = (label: string, keys: string[]) =>
        keys.length
          ? `${label} (${keys.length}): ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}`
          : null;
      const details = [
        sample("inventory rows missing from md table", Array.from(new Set(missing))),
        sample("md rows not matching any inventory route", Array.from(new Set(phantom))),
      ].filter((d): d is string => d !== null);
      if (details.length === 0) {
        details.push("same rows, but md table row order drifted from the inventory");
      }
      problems.push(
        `${contractMdPath} table rows are STALE — md has ${mdSig.length} endpoint row(s), inventory has ${invSig.length}. ` +
          details.join("; ") +
          `. ${REMEDIATION}`,
      );
    } else {
      // Task #4105: md rows align with the inventory — also verify the
      // middleware-derived auth/role/classification cells. parseMdDerivedCells
      // is aligned 1:1 with parseMdEndpointRows (malformed rows come back as
      // null), so a count mismatch or null entry means a truncated/malformed
      // row, never a silent skip.
      const cells = parseMdDerivedCells(md);
      const drift: string[] = [];
      if (cells.length !== inventory.length) {
        drift.push(
          `parsed ${cells.length} derived-cell row(s) but inventory has ${inventory.length} — malformed md table rows`,
        );
      }
      for (let i = 0; i < inventory.length && i < cells.length; i++) {
        const inv = inventory[i];
        const row = cells[i];
        if (row === null) {
          drift.push(
            `${routeKey(inv.method, inv.path)}: md row is malformed/truncated (missing auth/role/classification cells)`,
          );
          continue;
        }
        const expected = {
          auth: authClass(inv),
          role: roleClass(inv),
          classification: trackDClass(inv),
        };
        for (const col of ["auth", "role", "classification"] as const) {
          if (row[col] !== expected[col]) {
            drift.push(
              `${routeKey(inv.method, inv.path)}: ${col} is "${row[col]}", middleware implies "${expected[col]}"`,
            );
          }
        }
      }
      if (drift.length) {
        problems.push(
          `${contractMdPath} has STALE middleware-derived columns (${drift.length} drifted cell(s)): ` +
            drift.slice(0, 10).join("; ") +
            (drift.length > 10 ? "; …" : "") +
            `. ${REMEDIATION}`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    inventoryCount: inventory.length,
    contractCount,
    problems,
  };
}

export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-contract-table-freshness: committed endpoint contract table is out of date",
    );
    console.error("");
    console.error("  Audits treat audits/D-endpoint-contract-table.{md,json} as the canonical");
    console.error("  per-endpoint contract listing; a stale copy misleads them with phantom or");
    console.error("  missing endpoints (it once drifted ~37 added / 4 removed rows unnoticed).");
    console.error("");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("");
    console.error(`  Remediation: ${REMEDIATION}`);
    console.error("");
    return 1;
  }
  console.log(
    `lint-contract-table-freshness: OK (${result.inventoryCount} routes; contract table matches the committed route inventory)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-contract-table-freshness.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
