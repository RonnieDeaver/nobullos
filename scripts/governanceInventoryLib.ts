/**
 * Task #4178 — shared helpers for the five governance inventory generators
 * (audits/governance/*). See audits/governance/README.md for the contract.
 *
 * Design rules (from the approved hardening epic,
 * audits/architecture-governor-hardening-epic-approval.md):
 *   - Generators emit DETERMINISTIC facts: sorted keys, sorted arrays, no
 *     timestamps. The only volatile field is provenance.sourceCommit, which
 *     is EXCLUDED from staleness comparison (otherwise every commit would be
 *     "stale").
 *   - `--check` fails (exit 1) when the committed artifact's facts differ
 *     from freshly generated facts, OR when the committed universeHash does
 *     not match the committed facts (hand-edit detection).
 *   - Human judgment lives in audits/governance/overrides/*.overrides.json,
 *     never inline in generated facts; generators merge overrides under the
 *     entry's `review` key and FAIL on override keys that match nothing, so
 *     regeneration can never silently orphan a decision.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Deep-sort object keys so JSON.stringify is deterministic. Arrays keep order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface InventoryDocument {
  provenance: {
    generator: string;
    generatorVersion: number;
    /** Volatile — excluded from `--check` comparison. */
    sourceCommit: string;
    /** sha256 of the stable-stringified `facts`. */
    universeHash: string;
    regenerateCommand: string;
  };
  facts: unknown;
}

export function currentSourceCommit(repoRoot: string): string {
  try {
    const head = readFileSync(join(repoRoot, ".git/HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      const refPath = join(repoRoot, ".git", ref);
      if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim();
      const packed = join(repoRoot, ".git/packed-refs");
      if (existsSync(packed)) {
        for (const line of readFileSync(packed, "utf8").split("\n")) {
          if (line.endsWith(" " + ref)) return line.split(" ")[0];
        }
      }
      return "unknown";
    }
    return head;
  } catch {
    return "unknown";
  }
}

export function buildDocument(opts: {
  generator: string;
  generatorVersion: number;
  regenerateCommand: string;
  facts: unknown;
  repoRoot: string;
}): InventoryDocument {
  const facts = sortKeysDeep(opts.facts);
  return {
    provenance: {
      generator: opts.generator,
      generatorVersion: opts.generatorVersion,
      sourceCommit: currentSourceCommit(opts.repoRoot),
      universeHash: sha256(stableStringify(facts)),
      regenerateCommand: opts.regenerateCommand,
    },
    facts,
  };
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** Compare committed artifact vs freshly generated document, ignoring
 * provenance.sourceCommit. Also verifies the committed universeHash matches
 * the committed facts (detects hand-edits to the generated file). */
export function checkArtifact(committedPath: string, fresh: InventoryDocument): CheckResult {
  const problems: string[] = [];
  if (!existsSync(committedPath)) {
    return { ok: false, problems: [`missing committed artifact: ${committedPath}`] };
  }
  let committed: InventoryDocument;
  try {
    committed = JSON.parse(readFileSync(committedPath, "utf8"));
  } catch (err) {
    return { ok: false, problems: [`committed artifact is not valid JSON: ${String(err)}`] };
  }
  const committedFactsText = stableStringify(sortKeysDeep(committed.facts));
  const freshFactsText = stableStringify(fresh.facts);
  if (committed.provenance?.universeHash !== sha256(committedFactsText)) {
    problems.push(
      `universeHash mismatch inside the committed artifact (hand-edited generated facts?) — regenerate: ${fresh.provenance.regenerateCommand}`,
    );
  }
  if (committedFactsText !== freshFactsText) {
    const committedLines = committedFactsText.split("\n");
    const freshLines = freshFactsText.split("\n");
    let firstDiff = -1;
    for (let i = 0; i < Math.max(committedLines.length, freshLines.length); i++) {
      if (committedLines[i] !== freshLines[i]) { firstDiff = i; break; }
    }
    problems.push(
      `stale committed facts (first differing line ${firstDiff + 1}: committed ${JSON.stringify(committedLines[firstDiff] ?? "<eof>")} vs fresh ${JSON.stringify(freshLines[firstDiff] ?? "<eof>")}) — regenerate: ${fresh.provenance.regenerateCommand}`,
    );
  }
  if (
    committed.provenance?.generatorVersion !== undefined &&
    committed.provenance.generatorVersion !== fresh.provenance.generatorVersion
  ) {
    problems.push(
      `generatorVersion drift (committed ${committed.provenance.generatorVersion}, generator ${fresh.provenance.generatorVersion}) — regenerate: ${fresh.provenance.regenerateCommand}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

export function writeArtifact(path: string, doc: InventoryDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sortKeysDeep(doc), null, 2) + "\n");
}

/** Load an overrides file ({ "<entryKey>": { field: value } }) and apply it:
 * every override key must match an entry key, and the override lands under
 * the entry's `review` field. Throws on orphan keys so a rename can never
 * silently drop a recorded decision. */
export function applyOverrides<T extends { review?: Record<string, unknown> }>(
  entries: Map<string, T>,
  overridesPath: string,
): void {
  if (!existsSync(overridesPath)) return;
  const raw = JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_")) continue; // _doc etc.
    const entry = entries.get(key);
    if (!entry) {
      throw new Error(
        `override key "${key}" in ${overridesPath} matches no generated entry — fix the key or delete the stale override (decisions must never be silently orphaned)`,
      );
    }
    entry.review = { ...(entry.review ?? {}), ...(value as Record<string, unknown>) };
  }
}

/** Recursively list files under roots (repo-relative), sorted, filtered. */
export function listSourceFiles(
  repoRoot: string,
  roots: string[],
  pattern: RegExp = /\.(ts|tsx|mjs|cjs|js)$/,
): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git") continue;
      const absChild = join(abs, e);
      const relChild = rel ? `${rel}/${e}` : e;
      let st; try { st = statSync(absChild); } catch { continue; }
      if (st.isDirectory()) walk(absChild, relChild);
      else if (pattern.test(e)) out.push(relChild);
    }
  };
  for (const r of roots) walk(join(repoRoot, r), r);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Standard CLI: no args = regenerate + write; --check = compare committed. */
export function runGeneratorCli(opts: {
  argv: string[];
  artifactPath: string;
  generate: () => InventoryDocument;
  label: string;
}): number {
  let doc: InventoryDocument;
  try {
    doc = opts.generate();
  } catch (err) {
    console.error(`${opts.label}: generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (opts.argv.includes("--check")) {
    const res = checkArtifact(opts.artifactPath, doc);
    if (!res.ok) {
      console.error(`${opts.label}: STALE — ${opts.artifactPath}`);
      for (const p of res.problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`${opts.label}: OK (${opts.artifactPath} is fresh)`);
    return 0;
  }
  writeArtifact(opts.artifactPath, doc);
  console.log(`${opts.label}: wrote ${opts.artifactPath} (universeHash ${doc.provenance.universeHash.slice(0, 12)}…)`);
  return 0;
}
