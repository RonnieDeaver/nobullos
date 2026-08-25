/**
 * Task #5028 — Auto-quarantine flaky suites out of the blocking gate.
 *
 * Owner-approved policy (2026-08-18):
 *   Entry:        ≥2 intermittent failures of last 10 recorded runs (kind "flaky" from
 *                 classifyRecentFailureHistory; recovered bursts and still-red deterministic
 *                 suites are NOT quarantinable).
 *   Reinstatement: 10 consecutive trailing greens in the flake-history journal,
 *                 of which ≥3 must be from sweep lanes (regression/nightly, not smoke/solo).
 *   Cap:          10 concurrent quarantined suites. Candidates above the cap are denied
 *                 entry (they keep blocking) and a loud day-scoped alert fires.
 *   Override:     A quarantined suite whose import closure intersects the current diff ALWAYS
 *                 runs and blocks. Fail closed when diff detection or the trace fails/times out.
 *   Kill switch:  FLAKE_QUARANTINE=0 disables quarantine entirely (conservative direction).
 *
 * Single writer: tests/run-all.ts inside the TEST_GREEN_BASELINE_PUBLISH=1 block (nightly
 * scheduler on main only). Guard: tests/flake-quarantine-state.test.ts.
 *
 * Schema: tests/flake-quarantine.json — sealed JSON with sha256 over canonical content.
 * Tamper → treated as empty → everything blocks (conservative fail-closed).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DEFAULT_CORE_RULES, coreReason, type CoreRule } from "./relatedSmokeSelection";
import { findRepeatOffenders, type SuiteHistoryFile } from "./flakeHistory";

// ---------------------------------------------------------------------------
// Constants (owner-approved 2026-08-18)
// ---------------------------------------------------------------------------

export const QUARANTINE_LEDGER_PATH = "tests/flake-quarantine.json";
export const QUARANTINE_LEDGER_SCHEMA_VERSION = 1;
/** Entry threshold: ≥2 intermittent failures of last 10 recorded runs. */
export const QUARANTINE_ENTRY_MIN_FAILURES = 2;
export const QUARANTINE_ENTRY_WINDOW = 10;
/** Reinstatement: 10 consecutive trailing greens. */
export const QUARANTINE_REINSTATE_GREENS = 10;
/** Of which ≥3 must be from sweep lanes (regression/nightly, not smoke or solo). */
export const QUARANTINE_REINSTATE_SWEEP_GREENS = 3;
/** Maximum concurrently quarantined suites before a cap-breach alert fires. */
export const QUARANTINE_CAP = 10;
/** Kill switch: FLAKE_QUARANTINE=0 disables auto-quarantine (conservative direction). */
export const QUARANTINE_KILL_SWITCH_ENV = "FLAKE_QUARANTINE";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface QuarantineEvidence {
  failures: number;
  window: number;
  lastFailureAt: string;
  lastReason?: string;
}

export interface QuarantineEntry {
  /** Repo-relative test file path. */
  file: string;
  /** ISO timestamp of quarantine entry. */
  enteredAt: string;
  /** Human-readable entry reason (shown in operator surfaces). */
  reason: string;
  /** Flake evidence at the time of entry. */
  evidence: QuarantineEvidence;
}

interface QuarantineLedgerRaw {
  schemaVersion: number;
  entries: QuarantineEntry[];
  publishedAt: string;
  /** sha256 of canonical JSON of {schemaVersion, entries, publishedAt} */
  seal: string;
}

export interface QuarantineLedger {
  entries: QuarantineEntry[];
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Seal helpers
// ---------------------------------------------------------------------------

function canonicalPayload(data: Omit<QuarantineLedgerRaw, "seal">): string {
  return JSON.stringify(data, null, 2);
}

function computeSeal(data: Omit<QuarantineLedgerRaw, "seal">): string {
  return createHash("sha256").update(canonicalPayload(data)).digest("hex");
}

export function emptyLedger(): QuarantineLedger {
  return { entries: [], publishedAt: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load the quarantine ledger. Any problem (missing file, malformed JSON,
 * schema mismatch, tampered seal) returns an empty ledger — the conservative
 * fail-closed direction. Kill switch FLAKE_QUARANTINE=0 forces empty too.
 * Never throws.
 */
export function loadQuarantineLedger(
  absPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { ledger: QuarantineLedger; note: string | null } {
  if (env[QUARANTINE_KILL_SWITCH_ENV] === "0") {
    return { ledger: emptyLedger(), note: "FLAKE_QUARANTINE=0 — auto-quarantine disabled (kill switch)" };
  }
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return { ledger: emptyLedger(), note: null }; // absent = normal bootstrap
  }
  try {
    const parsed = JSON.parse(raw) as Partial<QuarantineLedgerRaw> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.schemaVersion !== "number" ||
      !Array.isArray(parsed.entries)
    ) {
      return {
        ledger: emptyLedger(),
        note: "flake-quarantine ledger malformed — treated as empty (fail closed; everything blocks)",
      };
    }
    if (parsed.schemaVersion !== QUARANTINE_LEDGER_SCHEMA_VERSION) {
      return {
        ledger: emptyLedger(),
        note: `flake-quarantine ledger schema mismatch (v${parsed.schemaVersion} ≠ v${QUARANTINE_LEDGER_SCHEMA_VERSION}) — treated as empty`,
      };
    }
    const { seal, ...rest } = parsed as QuarantineLedgerRaw;
    const expectedSeal = computeSeal(rest);
    if (seal !== expectedSeal) {
      return {
        ledger: emptyLedger(),
        note: "flake-quarantine ledger seal mismatch — TAMPER DETECTED, treated as empty (everything blocks)",
      };
    }
    return {
      ledger: {
        entries: parsed.entries as QuarantineEntry[],
        publishedAt:
          typeof parsed.publishedAt === "string" ? parsed.publishedAt : new Date(0).toISOString(),
      },
      note: null,
    };
  } catch {
    return {
      ledger: emptyLedger(),
      note: "flake-quarantine ledger unparseable — treated as empty (fail closed)",
    };
  }
}

/**
 * Atomically write the quarantine ledger with a freshly computed seal.
 * The ONLY writer is tests/run-all.ts inside the TEST_GREEN_BASELINE_PUBLISH=1
 * block (nightly scheduler on main only). Never throws.
 */
export function saveQuarantineLedger(
  absPath: string,
  ledger: QuarantineLedger,
  opts: { now?: Date } = {},
): { saved: boolean; note: string | null } {
  try {
    const data: Omit<QuarantineLedgerRaw, "seal"> = {
      schemaVersion: QUARANTINE_LEDGER_SCHEMA_VERSION,
      entries: ledger.entries,
      publishedAt: (opts.now ?? new Date()).toISOString(),
    };
    const seal = computeSeal(data);
    const full: QuarantineLedgerRaw = { ...data, seal };
    mkdirSync(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, "utf8");
    renameSync(tmp, absPath);
    return { saved: true, note: null };
  } catch (err) {
    return {
      saved: false,
      note: `quarantine ledger save failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** True when the given file is currently in the auto-quarantine ledger. */
export function isAutoQuarantined(file: string, ledger: QuarantineLedger): boolean {
  return ledger.entries.some((e) => e.file === file);
}

// ---------------------------------------------------------------------------
// State machine — transition computation (pure, no I/O)
// ---------------------------------------------------------------------------

export interface QuarantineDenied {
  file: string;
  reason: string;
}

export interface QuarantineTransitionResult {
  /** Suites newly added to quarantine this run. */
  entered: QuarantineEntry[];
  /** Suites reinstated from quarantine (proven stable). */
  reinstated: QuarantineEntry[];
  /**
   * Flaky candidates that were denied entry because the cap was full.
   * They continue to block gates — the denied list is an alert signal,
   * not a free pass. Filing a cap-breach alert is the caller's responsibility.
   */
  capDenied: QuarantineDenied[];
  /** The updated ledger to persist. */
  newLedger: QuarantineLedger;
}

/**
 * Compute quarantine state transitions from the accumulated flake-history.
 * Pure: does not read or write the filesystem.
 *
 * Entry:
 *   - Suite's recent history has kind "flaky" (≥QUARANTINE_ENTRY_MIN_FAILURES intermittent
 *     failures of last QUARANTINE_ENTRY_WINDOW records).
 *   - Suite is in the test registry (registered files).
 *   - Suite is NOT a core-always-run suite (never quarantinable).
 *   - Suite is NOT already quarantined.
 *   - The cap has room; otherwise → capDenied (still blocks).
 *
 * Reinstatement:
 *   - Suite has ≥QUARANTINE_REINSTATE_GREENS consecutive trailing greens.
 *   - Of which ≥QUARANTINE_REINSTATE_SWEEP_GREENS are from sweep lanes.
 *
 * Also delists entries for files removed from the registry (deleted tests)
 * or that now match a core rule.
 */
export function computeQuarantineTransitions(
  history: SuiteHistoryFile,
  currentLedger: QuarantineLedger,
  opts: {
    /** All file paths currently registered in the test registry. */
    registeredFiles: Set<string>;
    /** Core rules — suites matching these can NEVER be quarantined. */
    coreRules?: CoreRule[];
    now?: Date;
  },
): QuarantineTransitionResult {
  const coreRules = opts.coreRules ?? DEFAULT_CORE_RULES;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // Step 1: Remove stale entries — file deleted from registry or now matched by a core rule.
  const activeEntries = currentLedger.entries.filter(
    (e) => opts.registeredFiles.has(e.file) && !coreReason(e.file, coreRules),
  );

  // Step 2: Reinstatement — 10 trailing greens, ≥3 from sweep lane.
  const reinstated: QuarantineEntry[] = [];
  const stillQuarantined: QuarantineEntry[] = [];
  for (const entry of activeEntries) {
    const allRecords = history.suites?.[entry.file] ?? [];
    const tail = allRecords.slice(-QUARANTINE_REINSTATE_GREENS);
    if (tail.length < QUARANTINE_REINSTATE_GREENS) {
      // Not enough recorded history yet — keep quarantined.
      stillQuarantined.push(entry);
      continue;
    }
    const allGreen = tail.every((r) => r.outcome === "passed");
    if (!allGreen) {
      stillQuarantined.push(entry);
      continue;
    }
    const sweepGreens = tail.filter((r) => r.sweepLane === true).length;
    if (sweepGreens < QUARANTINE_REINSTATE_SWEEP_GREENS) {
      stillQuarantined.push(entry);
      continue;
    }
    reinstated.push(entry);
  }

  // Step 3: Identify new entry candidates — flaky repeat offenders not already quarantined,
  // not core, and in the registry. Owner-approved exclusion (2026-08-18): suites that are
  // STILL RED in the window (all failures, zero passes) are deterministic breaks, not flakes —
  // they need a real fix, not a quarantine bypass. Only truly intermittent suites enter.
  const quarantinedNow = new Set(stillQuarantined.map((e) => e.file));
  const offenders = findRepeatOffenders(history, {
    window: QUARANTINE_ENTRY_WINDOW,
    minFailures: QUARANTINE_ENTRY_MIN_FAILURES,
  });
  const candidates = offenders.filter((o) => {
    if (o.kind !== "flaky") return false;
    if (quarantinedNow.has(o.file)) return false;
    if (!opts.registeredFiles.has(o.file)) return false;
    if (coreReason(o.file, coreRules)) return false;
    // Require at least one pass in the recent window — a suite with NO passes is
    // deterministically broken, not intermittently flaky.
    const recent = (history.suites?.[o.file] ?? []).slice(-QUARANTINE_ENTRY_WINDOW);
    const hasPass = recent.some((r) => r.outcome === "passed");
    return hasPass;
  });

  // Step 4: Apply cap.
  const capRemaining = Math.max(0, QUARANTINE_CAP - stillQuarantined.length);
  const toEnter = candidates.slice(0, capRemaining);
  const capDenied: QuarantineDenied[] = candidates.slice(capRemaining).map((o) => ({
    file: o.file,
    reason: `${o.failures}/${o.window} recent runs failed intermittently (cap of ${QUARANTINE_CAP} concurrent suites is full)`,
  }));

  // Step 5: Build new QuarantineEntry objects.
  const entered: QuarantineEntry[] = toEnter.map((o) => ({
    file: o.file,
    enteredAt: nowIso,
    reason: `${o.failures} of the last ${o.window} recorded runs failed intermittently (kind: flaky)`,
    evidence: {
      failures: o.failures,
      window: o.window,
      lastFailureAt: o.lastFailureAt,
      ...(o.lastReason ? { lastReason: o.lastReason } : {}),
    },
  }));

  const newEntries = [...stillQuarantined, ...entered];
  // Deterministic order: by enteredAt then file.
  newEntries.sort(
    (a, b) => a.enteredAt.localeCompare(b.enteredAt) || a.file.localeCompare(b.file),
  );

  return {
    entered,
    reinstated,
    capDenied,
    newLedger: { entries: newEntries, publishedAt: nowIso },
  };
}

// ---------------------------------------------------------------------------
// Feedback plan (pure; actual DB filing done by server-side caller)
// ---------------------------------------------------------------------------

export interface QuarantineFeedbackPlan {
  /** Entries to file as new fix-task feedback items. */
  toFile: QuarantineEntry[];
  /** Files to resolve (reinstated — the open fix-task is no longer needed). */
  toResolveFiles: string[];
}

/**
 * Plan feedback actions for a set of transitions — pure, no I/O.
 * The server-side caller (regressionSweepScheduler.ts via regressionSweepFeedback.ts)
 * executes the plan against the database.
 */
export function planQuarantineFeedback(
  transitions: Pick<QuarantineTransitionResult, "entered" | "reinstated">,
): QuarantineFeedbackPlan {
  return {
    toFile: transitions.entered,
    toResolveFiles: transitions.reinstated.map((e) => e.file),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (for console output and feedback text)
// ---------------------------------------------------------------------------

export function formatQuarantineEntry(entry: QuarantineEntry): string {
  return (
    `${entry.file}: auto-quarantined ${entry.enteredAt.slice(0, 10)} ` +
    `(${entry.evidence.failures}/${entry.evidence.window} recent runs failed; ` +
    `last failed ${entry.evidence.lastFailureAt.slice(0, 10)})`
  );
}

export function buildQuarantineFeedbackText(entry: QuarantineEntry): string {
  return (
    `**Auto-quarantined flaky test** — ${entry.reason}\n\n` +
    `File: \`${entry.file}\`\n` +
    `Entered: ${entry.enteredAt.slice(0, 10)}\n` +
    `Failures: ${entry.evidence.failures} of the last ${entry.evidence.window} recorded runs\n` +
    `Last failed: ${entry.evidence.lastFailureAt.slice(0, 10)}\n` +
    (entry.evidence.lastReason ? `Last failure reason: ${entry.evidence.lastReason}\n` : "") +
    `\nThis suite has been removed from the blocking gate automatically. ` +
    `It continues to execute non-blocking in nightly/regression sweeps with results recorded in the flake history. ` +
    `Fix the underlying flakiness and the suite will be automatically reinstated once it records ` +
    `${QUARANTINE_REINSTATE_GREENS} consecutive greens (≥${QUARANTINE_REINSTATE_SWEEP_GREENS} from sweep lanes).`
  );
}
