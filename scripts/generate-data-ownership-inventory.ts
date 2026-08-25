/**
 * Task #4178 — governance inventory #1: data ownership.
 *
 * Emits audits/governance/data-ownership.json: every table the codebase
 * defines (Drizzle pgTable models in shared/models/** plus raw-SQL
 * CREATE TABLE bootstrap tables in server/**), with statically derived
 * writer/reader files and `unknown` for every judgment field that cannot be
 * proven from code (scoping, sensitivity, retention, conflict policy,
 * growth class). Human judgments live in
 * audits/governance/overrides/data-ownership.overrides.json and are merged
 * under each entry's `review` key.
 *
 * Regenerate: npx tsx scripts/generate-data-ownership-inventory.ts
 * Freshness:  npx tsx scripts/generate-data-ownership-inventory.ts --check
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOverrides,
  buildDocument,
  listSourceFiles,
  runGeneratorCli,
  type InventoryDocument,
} from "./governanceInventoryLib";

export const ARTIFACT_PATH = "audits/governance/data-ownership.json";
export const OVERRIDES_PATH = "audits/governance/overrides/data-ownership.overrides.json";
export const GENERATOR_VERSION = 1;
const REGEN = "npx tsx scripts/generate-data-ownership-inventory.ts";

interface TableEntry {
  table: string;
  definition: "drizzle-model" | "raw-sql-bootstrap" | "external-session-store";
  /** Where the schema is declared (model file or raw-DDL file(s)). */
  definedIn: string[];
  /** Owning domain: model filename for drizzle models, else "unknown". */
  owningDomain: string;
  /** Files with a drizzle .insert/.update/.delete on the table object, or a
   * raw INSERT INTO/UPDATE …SET/DELETE FROM literal naming the table. */
  writers: string[];
  /** Files with a drizzle .from()/join() on the table object. Raw-SQL SELECT
   * readers are NOT derived (too noisy) — treat absence as "unproven". */
  readers: string[];
  scoping: string;
  sensitivity: string;
  retention: string;
  conflictPolicy: string;
  growthClass: string;
  review?: Record<string, unknown>;
}

const UNKNOWN = "unknown";
const MODEL_ROOT = "shared/models";
const CODE_ROOTS = ["server", "shared"];

/** Words the raw-SQL regexes can capture that are never real table names:
 * SQL reserved words plus JS keywords/prose words that follow SQL-looking
 * phrases in comments (e.g. the doc comment "…CREATE TABLE IF NOT EXISTS for
 * every store table" in server/services/adsOs/storeSchema.ts once minted a
 * phantom table named "for"). Lowercased before lookup. */
const NON_TABLE_IDENTIFIERS = new Set([
  // SQL keywords that can trail the matched phrases
  "select", "insert", "update", "delete", "from", "into", "set", "where",
  "values", "table", "tables", "if", "not", "exists", "on", "and", "or",
  "as", "in", "is", "null", "default", "primary", "unique", "index",
  // JS keywords / prose words seen after SQL-looking phrases in comments
  "for", "of", "the", "a", "an", "each", "every", "all", "any", "this",
  "that", "these", "those", "its", "their", "some", "no",
]);

/** Owning domain for a raw-SQL bootstrap table, derived from its single
 * defining file the same way drizzle domains derive from model filenames:
 * basename minus extension, minus a Storage/Schema/Store suffix (e.g.
 * server/storage/sheetsStorage.ts -> "sheets"). Multiple defining files or an
 * empty result stay "unknown". */
function rawSqlOwningDomain(files: Set<string>): string {
  if (files.size !== 1) return UNKNOWN;
  const base = [...files][0].replace(/^.*\//, "").replace(/\.(ts|tsx|mjs|cjs|js)$/, "");
  const domain = base.replace(/(Storage|Schema|Store)$/, "");
  return domain.length > 0 ? domain : UNKNOWN;
}

export function generateFacts(repoRoot: string = process.cwd()): { tables: TableEntry[] } {
  const entries = new Map<string, TableEntry>();
  const varToTable = new Map<string, string>(); // drizzle export var -> table name

  // 1) Drizzle models.
  for (const file of listSourceFiles(repoRoot, [MODEL_ROOT])) {
    const src = readFileSync(join(repoRoot, file), "utf8");
    const re = /export const (\w+)\s*(?::[^=]+)?=\s*pgTable\(\s*["'](\w+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const [, varName, tableName] = m;
      varToTable.set(varName, tableName);
      const domain = file.replace(/^.*\//, "").replace(/\.ts$/, "");
      const existing = entries.get(tableName);
      if (existing) {
        if (!existing.definedIn.includes(file)) existing.definedIn.push(file);
      } else {
        entries.set(tableName, {
          table: tableName,
          definition: "drizzle-model",
          definedIn: [file],
          owningDomain: domain,
          writers: [],
          readers: [],
          scoping: UNKNOWN,
          sensitivity: UNKNOWN,
          retention: UNKNOWN,
          conflictPolicy: UNKNOWN,
          growthClass: UNKNOWN,
        });
      }
    }
  }

  // 2) Scan server/shared code once for writers/readers + raw DDL tables.
  const writerByVar = new Map<string, Set<string>>();
  const readerByVar = new Map<string, Set<string>>();
  const rawWriterByTable = new Map<string, Set<string>>();
  const rawDdlByTable = new Map<string, Set<string>>();

  for (const file of listSourceFiles(repoRoot, CODE_ROOTS)) {
    if (file.startsWith(MODEL_ROOT + "/")) continue;
    const src = readFileSync(join(repoRoot, file), "utf8");

    let m: RegExpExecArray | null;
    const verbRe = /\.(insert|update|delete)\(\s*(\w+)\s*[),]/g;
    while ((m = verbRe.exec(src))) {
      const v = m[2];
      if (varToTable.has(v)) (writerByVar.get(v) ?? writerByVar.set(v, new Set()).get(v)!).add(file);
    }
    const readRe = /\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*(\w+)\s*[),]/g;
    while ((m = readRe.exec(src))) {
      const v = m[1];
      if (varToTable.has(v)) (readerByVar.get(v) ?? readerByVar.set(v, new Set()).get(v)!).add(file);
    }
    const ddlRe = /CREATE TABLE IF NOT EXISTS\s+"?(\w+)"?/gi;
    while ((m = ddlRe.exec(src))) {
      const t = m[1].toLowerCase();
      if (NON_TABLE_IDENTIFIERS.has(t)) continue;
      (rawDdlByTable.get(t) ?? rawDdlByTable.set(t, new Set()).get(t)!).add(file);
    }
    const rawWriteRe = /(?:INSERT INTO|DELETE FROM)\s+"?(\w+)"?|UPDATE\s+"?(\w+)"?\s+SET\b/gi;
    while ((m = rawWriteRe.exec(src))) {
      const t = (m[1] ?? m[2]).toLowerCase();
      if (NON_TABLE_IDENTIFIERS.has(t)) continue;
      (rawWriterByTable.get(t) ?? rawWriterByTable.set(t, new Set()).get(t)!).add(file);
    }
  }

  // 3) Fold raw-DDL tables into the entry set.
  for (const [table, files] of rawDdlByTable) {
    const existing = entries.get(table);
    if (existing) {
      for (const f of [...files].sort()) if (!existing.definedIn.includes(f)) existing.definedIn.push(f);
    } else {
      entries.set(table, {
        table,
        definition: "raw-sql-bootstrap",
        definedIn: [...files].sort(),
        owningDomain: rawSqlOwningDomain(files),
        writers: [],
        readers: [],
        scoping: UNKNOWN,
        sensitivity: UNKNOWN,
        retention: UNKNOWN,
        conflictPolicy: UNKNOWN,
        growthClass: UNKNOWN,
      });
    }
  }
  // The Replit-auth session store table has no model and no local DDL.
  if (!entries.has("sessions")) {
    entries.set("sessions", {
      table: "sessions",
      definition: "external-session-store",
      definedIn: ["server/replit_integrations/auth/replitAuth.ts"],
      owningDomain: "auth",
      writers: ["server/replit_integrations/auth/replitAuth.ts"],
      readers: ["server/replit_integrations/auth/replitAuth.ts"],
      scoping: UNKNOWN,
      sensitivity: UNKNOWN,
      retention: UNKNOWN,
      conflictPolicy: UNKNOWN,
      growthClass: UNKNOWN,
    });
  }

  // 4) Attach writers/readers.
  for (const [v, tableName] of varToTable) {
    const e = entries.get(tableName);
    if (!e) continue;
    for (const f of writerByVar.get(v) ?? []) if (!e.writers.includes(f)) e.writers.push(f);
    for (const f of readerByVar.get(v) ?? []) if (!e.readers.includes(f)) e.readers.push(f);
  }
  for (const [table, files] of rawWriterByTable) {
    const e = entries.get(table);
    if (!e) continue;
    for (const f of files) if (!e.writers.includes(f)) e.writers.push(f);
  }
  for (const e of entries.values()) {
    e.writers.sort();
    e.readers.sort();
    e.definedIn.sort();
  }

  applyOverrides(entries, join(repoRoot, OVERRIDES_PATH));
  const tables = [...entries.values()].sort((a, b) => a.table.localeCompare(b.table));
  return { tables };
}

export function generate(repoRoot: string = process.cwd()): InventoryDocument {
  return buildDocument({
    generator: "scripts/generate-data-ownership-inventory.ts",
    generatorVersion: GENERATOR_VERSION,
    regenerateCommand: REGEN,
    facts: generateFacts(repoRoot),
    repoRoot,
  });
}

export function cliMain(argv: string[] = process.argv.slice(2)): number {
  return runGeneratorCli({
    argv,
    artifactPath: ARTIFACT_PATH,
    generate: () => generate(),
    label: "data-ownership-inventory",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(cliMain());
}
