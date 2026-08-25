/**
 * Task #4553 — Completion-rebase conflict triage: pure decision layer.
 *
 * When main moves during a task's completion/validation window, the rebase
 * round used to be manual archaeology: inspect every conflicted file "all
 * three ways" and re-derive the take-a-side-then-regenerate convention from
 * scattered memory notes. This module makes the round mechanical: it maps
 * conflicted paths to known conflict classes and plans the auto-resolution
 * (which generators to run, in which dependency order) as PURE data — no
 * fs, no child_process, no git. Execution lives in
 * scripts/rebase-conflict-triage.ts; the canonical operator protocol is
 * COMPLETION_REBASE_TRIAGE.md.
 *
 * Conflict classes (the ONLY auto-resolvable ones):
 *   - generated-artifact  Committed generator output. Convention (from the
 *                         generators' own headers + post-merge refresh
 *                         hooks): take either side to clear the markers,
 *                         then regenerate on the rebased tree and stage.
 *                         Never hand-merge. Dependency order matters: the
 *                         endpoint contract table is generated FROM the
 *                         route inventory, so the inventory regens first
 *                         and a route-inventory regen cascades a
 *                         contract-table regen even when the table itself
 *                         did not conflict.
 *   - memory-index        .agents/memory/MEMORY.md is union-merged (see
 *                         .gitattributes `merge=union`). If it still shows
 *                         up conflicted, the resolution is a 3-stage
 *                         `git merge-file --union`, not a hand-merge.
 *   - lockfile            package-lock.json is never merged: take a side,
 *                         reinstall (`npm install`), stage the result.
 *   - source              Everything else — genuine conflicts needing
 *                         human/agent judgment. NEVER auto-resolved; the
 *                         helper falls open to manual handling and says so
 *                         in the round report. This includes the L3 test
 *                         control-plane surfaces (gate/runner/selection/
 *                         fingerprint/green-baseline/red-manifest, owned by
 *                         the #4530/#4531 track) — deliberately NOT
 *                         families here.
 *
 * The family table below mirrors the canonical specs exported by
 * scripts/post-merge-generated-artifact-refresh.ts (ARTIFACTS),
 * scripts/post-merge-route-inventory-refresh.ts (INVENTORY_PATHS) and
 * scripts/designContractRatchet.ts (BASELINE_RELPATH). It is deliberately
 * data-only (importing those modules would drag the whole generator import
 * graph into this pure layer); tests/rebase-conflict-triage.test.ts imports
 * BOTH sides and asserts path/argv lockstep, so drift fails the gate.
 */

export type ConflictSide = "ours" | "theirs";

/** What kind of in-progress operation the repo is in. */
export type RepoMergeMode = "rebase" | "merge" | "none";

export type ConflictClassId =
  | "generated-artifact"
  | "memory-index"
  | "lockfile"
  | "source";

/** One unmerged path as reported by `git ls-files -u`. */
export interface UnmergedPath {
  path: string;
  /** stage 1 present (common ancestor) */
  hasBase: boolean;
  /** stage 2 present (ours) */
  hasOurs: boolean;
  /** stage 3 present (theirs) */
  hasTheirs: boolean;
}

export interface ArtifactFamily {
  id: string;
  label: string;
  /** Exact repo-relative artifact paths owned by this family. */
  exactPaths?: readonly string[];
  /** Directory prefix (with trailing slash) owned by this family. */
  pathPrefix?: string;
  /** argv of the sanctioned generator (never a re-implementation). */
  regenArgv: readonly [string, ...string[]];
  /** Human-readable form of regenArgv. */
  regenCommand: string;
  /** Paths passed to `git add` after a successful regen. */
  stagePaths: readonly string[];
  /** Regens run in ascending order. */
  order: number;
  /**
   * Family ids that, when they regen, force THIS family to regen too
   * (derived artifact), even if its own paths did not conflict.
   */
  regenAlsoWhen?: readonly string[];
  /** Per-regen wall-clock budget for the executor. */
  timeoutMs: number;
  notes?: string;
}

export const MEMORY_INDEX_PATH = ".agents/memory/MEMORY.md";
export const LOCKFILE_PATH = "package-lock.json";

/**
 * L3 test-control-plane surfaces (owned by the #4530/#4531 track). Listed
 * ONLY so the classifier can attach an explicit "never auto-resolve" reason;
 * they classify as `source` like any other manual conflict.
 */
export const L3_CONTROL_PLANE_PATHS: readonly string[] = [
  "tests/green-baseline.json",
  "tests/red-manifest.json",
  "tests/run-all.ts",
  "tests/testRegistry.ts",
  "tests/relatedSmokeSelection.ts",
  "tests/suiteFingerprint.ts",
  "scripts/gate.ts",
  "scripts/predeploy.sh",
];

export const ARTIFACT_FAMILIES: readonly ArtifactFamily[] = [
  {
    id: "route-inventory",
    label: "Route inventory (tests/route-inventory.{json,md-report})",
    exactPaths: ["tests/route-inventory.json", "tests/route-inventory-report.md"],
    regenArgv: ["npx", "tsx", "scripts/regen-route-inventory.mjs"],
    regenCommand: "npx tsx scripts/regen-route-inventory.mjs",
    stagePaths: ["tests/route-inventory.json", "tests/route-inventory-report.md"],
    order: 10,
    timeoutMs: 300_000,
    notes:
      "Regenerates FIRST: the endpoint contract table is generated FROM tests/route-inventory.json.",
  },
  {
    id: "endpoint-contract-table",
    label: "Endpoint contract table (audits/D-endpoint-contract-table.{md,json})",
    exactPaths: [
      "audits/D-endpoint-contract-table.md",
      "audits/D-endpoint-contract-table.json",
    ],
    regenArgv: ["node", "scripts/generate-endpoint-contract-table.mjs"],
    regenCommand: "node scripts/generate-endpoint-contract-table.mjs",
    stagePaths: [
      "audits/D-endpoint-contract-table.md",
      "audits/D-endpoint-contract-table.json",
    ],
    order: 20,
    regenAlsoWhen: ["route-inventory"],
    timeoutMs: 300_000,
    notes:
      "Generated FROM the route inventory — cascades whenever route-inventory regens.",
  },
  {
    id: "design-contract-baseline",
    label: "Design-contract ratchet baseline (scripts/design-contract-baseline.json)",
    exactPaths: ["scripts/design-contract-baseline.json"],
    regenArgv: ["npx", "tsx", "scripts/regen-design-contract-baseline.ts"],
    regenCommand: "npx tsx scripts/regen-design-contract-baseline.ts",
    stagePaths: ["scripts/design-contract-baseline.json"],
    order: 30,
    timeoutMs: 300_000,
    notes:
      "Sole-writer script; sha256 self-hash rejects hand-merges. The regen REFUSES category-count increases (ratchet) — a refusal here means the rebased tree has new violations to fix with tokens; the path then falls open to manual.",
  },
  {
    id: "governance-data-ownership",
    label: "Governance inventory: data ownership",
    exactPaths: ["audits/governance/data-ownership.json"],
    regenArgv: ["npx", "tsx", "scripts/generate-data-ownership-inventory.ts"],
    regenCommand: "npx tsx scripts/generate-data-ownership-inventory.ts",
    stagePaths: ["audits/governance/data-ownership.json"],
    order: 40,
    timeoutMs: 300_000,
  },
  {
    id: "governance-integration-reliability",
    label: "Governance inventory: integration reliability",
    exactPaths: ["audits/governance/integration-reliability.json"],
    regenArgv: ["npx", "tsx", "scripts/generate-integration-reliability-inventory.ts"],
    regenCommand: "npx tsx scripts/generate-integration-reliability-inventory.ts",
    stagePaths: ["audits/governance/integration-reliability.json"],
    order: 41,
    timeoutMs: 300_000,
  },
  {
    id: "governance-async-topology",
    label: "Governance inventory: async topology",
    exactPaths: ["audits/governance/async-topology.json"],
    regenArgv: ["npx", "tsx", "scripts/generate-async-topology-inventory.ts"],
    regenCommand: "npx tsx scripts/generate-async-topology-inventory.ts",
    stagePaths: ["audits/governance/async-topology.json"],
    order: 42,
    timeoutMs: 300_000,
  },
  {
    id: "governance-test-portfolio-baseline",
    label: "Governance inventory: test-portfolio baseline",
    exactPaths: ["audits/governance/test-portfolio-baseline.json"],
    regenArgv: ["npx", "tsx", "scripts/generate-test-portfolio-baseline.ts"],
    regenCommand: "npx tsx scripts/generate-test-portfolio-baseline.ts",
    stagePaths: ["audits/governance/test-portfolio-baseline.json"],
    order: 43,
    timeoutMs: 300_000,
  },
  {
    id: "website-bundle",
    label: "Marketing website bundle (website/public/**)",
    pathPrefix: "website/public/",
    regenArgv: ["npx", "tsx", "website/generate.ts"],
    regenCommand: "npx tsx website/generate.ts",
    stagePaths: ["website/public"],
    order: 50,
    timeoutMs: 300_000,
    notes: "Committed generator output; one regen covers every conflicted path under the prefix.",
  },
];

export interface Classification {
  path: string;
  classId: ConflictClassId;
  familyId?: string;
  /** True only when the helper may resolve this path mechanically. */
  autoResolvable: boolean;
  reason: string;
}

/** Classify one unmerged path. Pure. */
export function classifyPath(u: UnmergedPath): Classification {
  const bothSides = u.hasOurs && u.hasTheirs;
  if (u.path === MEMORY_INDEX_PATH) {
    return {
      path: u.path,
      classId: "memory-index",
      autoResolvable: bothSides,
      reason: bothSides
        ? "memory index union-merges (.gitattributes merge=union): 3-stage git merge-file --union"
        : "memory index has a side deleted — union undefined, resolve by hand",
    };
  }
  if (u.path === LOCKFILE_PATH) {
    return {
      path: u.path,
      classId: "lockfile",
      autoResolvable: bothSides,
      reason: bothSides
        ? "lockfile is never merged: take a side, then `npm install` re-derives it from the resolved package.json"
        : "lockfile deleted on one side — resolve by hand",
    };
  }
  const family = ARTIFACT_FAMILIES.find(
    (f) =>
      (f.exactPaths ?? []).includes(u.path) ||
      (f.pathPrefix !== undefined && u.path.startsWith(f.pathPrefix)),
  );
  if (family) {
    return {
      path: u.path,
      classId: "generated-artifact",
      familyId: family.id,
      autoResolvable: bothSides,
      reason: bothSides
        ? `generated artifact (${family.id}): take a side, then regen on the rebased tree via \`${family.regenCommand}\``
        : `generated artifact (${family.id}) deleted on one side — auto-regen could resurrect a retired artifact; resolve by hand`,
    };
  }
  if (L3_CONTROL_PLANE_PATHS.includes(u.path)) {
    return {
      path: u.path,
      classId: "source",
      autoResolvable: false,
      reason:
        "L3 test-control-plane surface (gate/runner/selection/fingerprint/green-baseline/red-manifest — #4530/#4531 track): never auto-resolved, inspect all three stages by hand",
    };
  }
  if (u.path.startsWith(".agents/memory/")) {
    return {
      path: u.path,
      classId: "source",
      autoResolvable: false,
      reason:
        "memory TOPIC file (union merge covers only MEMORY.md): merge the prose by hand",
    };
  }
  return {
    path: u.path,
    classId: "source",
    autoResolvable: false,
    reason: "no known mechanical class — genuine conflict, resolve by hand",
  };
}

export interface PlannedRegen {
  familyId: string;
  regenArgv: readonly [string, ...string[]];
  regenCommand: string;
  stagePaths: readonly string[];
  order: number;
  timeoutMs: number;
  trigger: "conflicted" | "cascade";
  /** Conflicted paths (trigger=conflicted) or family ids (trigger=cascade). */
  triggeredBy: readonly string[];
}

export interface TriagePlan {
  classifications: Classification[];
  /** Artifact paths to `git checkout --<side>` before regenning. */
  takeSidePaths: { path: string; familyId: string }[];
  /** Memory-index paths to union-merge (0 or 1). */
  memoryUnionPaths: string[];
  /** Lockfile paths to take-side + reinstall (0 or 1). */
  lockfilePaths: string[];
  /** Deduped regens in dependency order (cascades included). */
  regens: PlannedRegen[];
  /** Conflicts the helper must NOT touch (fall open to manual). */
  residual: Classification[];
  /**
   * True when residual conflicts remain: generators must not parse a tree
   * that still contains conflict markers, so ALL take-side/regen/lockfile
   * work is deferred. Protocol: resolve the residual conflicts, then re-run
   * the same command — the memory-index union (content-independent) is the
   * only action that still executes on a deferred round.
   */
  deferRegens: boolean;
}

/** Build the resolution plan for a set of unmerged paths. Pure. */
export function planTriage(unmerged: readonly UnmergedPath[]): TriagePlan {
  const classifications = unmerged.map(classifyPath);
  const residual = classifications.filter((c) => !c.autoResolvable);
  const deferRegens = residual.length > 0;

  const takeSidePaths = classifications
    .filter((c) => c.classId === "generated-artifact" && c.autoResolvable)
    .map((c) => ({ path: c.path, familyId: c.familyId! }));

  const memoryUnionPaths = classifications
    .filter((c) => c.classId === "memory-index" && c.autoResolvable)
    .map((c) => c.path);

  const lockfilePaths = classifications
    .filter((c) => c.classId === "lockfile" && c.autoResolvable)
    .map((c) => c.path);

  // Families with at least one auto-resolvable conflicted path.
  const conflictedFamilies = new Map<string, string[]>();
  for (const t of takeSidePaths) {
    const list = conflictedFamilies.get(t.familyId) ?? [];
    list.push(t.path);
    conflictedFamilies.set(t.familyId, list);
  }

  const regens: PlannedRegen[] = [];
  for (const family of ARTIFACT_FAMILIES) {
    const conflictedPaths = conflictedFamilies.get(family.id);
    if (conflictedPaths) {
      regens.push({
        familyId: family.id,
        regenArgv: family.regenArgv,
        regenCommand: family.regenCommand,
        stagePaths: family.stagePaths,
        order: family.order,
        timeoutMs: family.timeoutMs,
        trigger: "conflicted",
        triggeredBy: conflictedPaths,
      });
      continue;
    }
    // Cascade: derived artifacts regen whenever an upstream family regens.
    const cascadeSources = (family.regenAlsoWhen ?? []).filter((id) =>
      conflictedFamilies.has(id),
    );
    if (cascadeSources.length > 0) {
      regens.push({
        familyId: family.id,
        regenArgv: family.regenArgv,
        regenCommand: family.regenCommand,
        stagePaths: family.stagePaths,
        order: family.order,
        timeoutMs: family.timeoutMs,
        trigger: "cascade",
        triggeredBy: cascadeSources,
      });
    }
  }
  regens.sort((a, b) => a.order - b.order);

  return {
    classifications,
    takeSidePaths,
    memoryUnionPaths,
    lockfilePaths,
    regens,
    residual,
    deferRegens,
  };
}

/**
 * Parse `git ls-files -u -z` output. Pure. Entry format per git docs:
 * `<mode> <sha> <stage>\t<path>\0`.
 */
export function parseLsFilesUnmergedZ(raw: string): UnmergedPath[] {
  const byPath = new Map<string, UnmergedPath>();
  for (const entry of raw.split("\0")) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const meta = entry.slice(0, tab).trim().split(/\s+/);
    const path = entry.slice(tab + 1);
    const stage = Number(meta[2]);
    if (!Number.isInteger(stage) || stage < 1 || stage > 3) continue;
    const rec =
      byPath.get(path) ??
      ({ path, hasBase: false, hasOurs: false, hasTheirs: false } as UnmergedPath);
    if (stage === 1) rec.hasBase = true;
    if (stage === 2) rec.hasOurs = true;
    if (stage === 3) rec.hasTheirs = true;
    byPath.set(path, rec);
  }
  return [...byPath.values()];
}

/** Derive the in-progress operation from git-dir marker existence. Pure. */
export function detectMode(flags: {
  rebaseMergeDir: boolean;
  rebaseApplyDir: boolean;
  mergeHead: boolean;
}): RepoMergeMode {
  if (flags.rebaseMergeDir || flags.rebaseApplyDir) return "rebase";
  if (flags.mergeHead) return "merge";
  return "none";
}

/**
 * Which of ours/theirs carries UPSTREAM (main) content. During a rebase the
 * checked-out side is the new base (ours=upstream, theirs=your commit being
 * replayed); during a completion merge, main is merged INTO the task branch
 * (theirs=upstream). The executor prints this assumption and accepts
 * --side to override. For most artifact families the choice is irrelevant
 * (regen overwrites the content); it matters for the design baseline (the
 * upstream side carries main's latest ratchet bar, so refusals compare
 * against the strictest current bar) and is arbitrary for the lockfile.
 */
export function upstreamSideFor(mode: RepoMergeMode): ConflictSide {
  return mode === "rebase" ? "ours" : "theirs";
}
