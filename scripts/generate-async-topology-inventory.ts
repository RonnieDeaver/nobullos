/**
 * Task #4178 — governance inventory #3: async topology.
 *
 * Emits audits/governance/async-topology.json:
 *   - every work-queue handler registration (`registerHandler("job_type"…)`
 *     plus repair-side `registerRepairHandler`), with the files that
 *     reference each job type (producer surface);
 *   - every deferred scheduler init from server/boot/schedulerInits.ts
 *     (startupTick label + imported module);
 *   - every `setInterval` / `cron.schedule` occurrence per file under
 *     server/services + server/boot (unmanaged-interval surface);
 *   - the WORKER_STAGGER_OFFSETS key list from server/services/workerConfig.ts.
 *
 * Judgment fields (class, concurrency, lease ceiling, timeout/cancel,
 * retries, dedupe, locks, kill switch, pause/drain, alert, dead-letter
 * owner, replay, shutdown) are `unknown` unless proven; human answers live
 * in audits/governance/overrides/async-topology.overrides.json. The
 * mechanism-level invariants that ARE proven repo-wide (PG-leased queue with
 * retry/dead-letter, queueDrainControl pause/rate-limit, cross-instance
 * advisory locks) are recorded once under `facts.sharedMechanisms`, not
 * copied per row.
 *
 * Regenerate: npx tsx scripts/generate-async-topology-inventory.ts
 * Freshness:  npx tsx scripts/generate-async-topology-inventory.ts --check
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

export const ARTIFACT_PATH = "audits/governance/async-topology.json";
export const OVERRIDES_PATH = "audits/governance/overrides/async-topology.overrides.json";
export const GENERATOR_VERSION = 2;
const REGEN = "npx tsx scripts/generate-async-topology-inventory.ts";

export const SCAN_ROOTS = ["server/services", "server/boot", "server/routes"];
const SCHEDULER_INITS = "server/boot/schedulerInits.ts";
const WORKER_CONFIG = "server/services/workerConfig.ts";

interface HandlerEntry {
  jobType: string;
  kind: "queue-handler" | "repair-handler";
  registeredIn: string[];
  /** Files (within scan roots) containing the job-type string literal —
   * the producer/reference surface, including the registering file. */
  referencedBy: string[];
  class: string;
  concurrency: string;
  killSwitch: string;
  deadLetterOwner: string;
  replay: string;
  review?: Record<string, unknown>;
}

interface SchedulerEntry {
  label: string;
  module: string;
  class: string;
  crossInstanceLock: string;
  killSwitch: string;
  alert: string;
  shutdown: string;
  review?: Record<string, unknown>;
}

interface IntervalSurface {
  file: string;
  setIntervalCount: number;
  cronScheduleCount: number;
}

export function generateFacts(repoRoot: string = process.cwd()): {
  handlers: HandlerEntry[];
  schedulers: SchedulerEntry[];
  intervalSurfaces: IntervalSurface[];
  workerStaggerOffsetKeys: string[];
  sharedMechanisms: Record<string, string>;
} {
  const files = listSourceFiles(repoRoot, SCAN_ROOTS, /\.ts$/);
  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, readFileSync(join(repoRoot, f), "utf8"));

  // Constant map: `const NAME = "literal"` across scan roots, so handlers
  // registered via a queue-name constant (same-module OR imported) resolve to
  // their string value. Unresolvable identifiers become a loud
  // "unresolved-constant:<IDENT>" row — never a silent omission.
  const constValues = new Map<string, string>();
  for (const src of sources.values()) {
    const cre = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[\w."'| ]+)?=\s*["'`]([\w:.-]+)["'`]/g;
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(src))) {
      const prev = constValues.get(cm[1]);
      if (prev !== undefined && prev !== cm[2]) constValues.set(cm[1], `ambiguous-constant:${cm[1]}`);
      else constValues.set(cm[1], cm[2]);
    }
  }

  // Handlers: literal-registered AND constant-registered.
  const handlers = new Map<string, HandlerEntry>();
  for (const [file, src] of sources) {
    const re = /register(Repair)?Handler(?:<[^>]*>)?\(\s*(?:["'`]([\w:.-]+)["'`]|([A-Za-z_$][\w$]*)\s*,)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let jobType: string;
      if (m[2] !== undefined) {
        jobType = m[2];
      } else {
        const ident = m[3];
        if (ident === "queueName" || ident === "jobType" || ident === "name" || ident === "type") continue; // declaration/wrapper params, not registrations
        jobType = constValues.get(ident) ?? `unresolved-constant:${ident}`;
      }
      const kind = m[1] ? "repair-handler" : "queue-handler";
      const key = `${kind}:${jobType}`;
      const e =
        handlers.get(key) ??
        handlers
          .set(key, {
            jobType,
            kind,
            registeredIn: [],
            referencedBy: [],
            class: "unknown",
            concurrency: "unknown",
            killSwitch: "unknown",
            deadLetterOwner: "unknown",
            replay: "unknown",
          })
          .get(key)!;
      if (!e.registeredIn.includes(file)) e.registeredIn.push(file);
    }
  }
  for (const e of handlers.values()) {
    const needle1 = `"${e.jobType}"`;
    const needle2 = `'${e.jobType}'`;
    for (const [file, src] of sources) {
      if (src.includes(needle1) || src.includes(needle2)) e.referencedBy.push(file);
    }
    e.registeredIn.sort();
    e.referencedBy.sort();
  }

  // Schedulers from schedulerInits.ts: pair each startupTick label with the
  // first dynamic import that follows it.
  const schedulers = new Map<string, SchedulerEntry>();
  const initsSrc = sources.get(SCHEDULER_INITS) ?? "";
  const tickRe = /startupTick\(\s*["']([^"']+)["']/g;
  const ticks: Array<{ label: string; index: number }> = [];
  let tm: RegExpExecArray | null;
  while ((tm = tickRe.exec(initsSrc))) ticks.push({ label: tm[1], index: tm.index });
  for (let i = 0; i < ticks.length; i++) {
    const end = i + 1 < ticks.length ? ticks[i + 1].index : initsSrc.length;
    const slice = initsSrc.slice(ticks[i].index, end);
    const im = /import\(\s*["']([^"']+)["']\s*\)/.exec(slice);
    const module = im ? im[1].replace(/^\.\.\//, "server/") + ".ts" : "unknown";
    schedulers.set(ticks[i].label, {
      label: ticks[i].label,
      module,
      class: "unknown",
      crossInstanceLock: "unknown",
      killSwitch: "unknown",
      alert: "unknown",
      shutdown: "trackTimer + isGracefulShutdown gate (server/boot/schedulerInits.ts)",
    });
  }

  // Interval/cron surfaces.
  const intervalSurfaces: IntervalSurface[] = [];
  for (const [file, src] of sources) {
    if (!file.startsWith("server/services/") && !file.startsWith("server/boot/")) continue;
    const si = (src.match(/\bsetInterval\(/g) ?? []).length;
    const cs = (src.match(/\bcron\.schedule\(/g) ?? []).length;
    if (si + cs > 0) intervalSurfaces.push({ file, setIntervalCount: si, cronScheduleCount: cs });
  }
  intervalSurfaces.sort((a, b) => a.file.localeCompare(b.file));

  // WORKER_STAGGER_OFFSETS keys.
  const wcSrc = sources.get(WORKER_CONFIG) ?? "";
  const offsetKeys: string[] = [];
  const blockMatch = /WORKER_STAGGER_OFFSETS[^{]*\{([\s\S]*?)\n\}/m.exec(wcSrc);
  if (blockMatch) {
    const keyRe = /^\s*(\w+)\s*:/gm;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(blockMatch[1]))) offsetKeys.push(km[1]);
  }
  offsetKeys.sort();

  const handlerEntries = new Map<string, HandlerEntry>();
  for (const e of handlers.values()) handlerEntries.set(`handler:${e.kind}:${e.jobType}`, e);
  const schedulerEntries = new Map<string, SchedulerEntry>();
  for (const e of schedulers.values()) schedulerEntries.set(`scheduler:${e.label}`, e);
  const merged = new Map<string, HandlerEntry | SchedulerEntry>([...handlerEntries, ...schedulerEntries]);
  applyOverrides(merged as Map<string, { review?: Record<string, unknown> }>, join(repoRoot, OVERRIDES_PATH));

  return {
    handlers: [...handlers.values()].sort((a, b) =>
      `${a.kind}:${a.jobType}`.localeCompare(`${b.kind}:${b.jobType}`),
    ),
    schedulers: [...schedulers.values()].sort((a, b) => a.label.localeCompare(b.label)),
    intervalSurfaces,
    workerStaggerOffsetKeys: offsetKeys,
    sharedMechanisms: {
      queue: "in-PG leased work_queue: pending→leased→processing→completed; retry w/ exponential backoff; exhausted attempts→dead_letter; expired-lease reclaim (server/services/workQueueLease.ts, docs/work-queue-lease-contract.md)",
      dedupe: "enqueueJob dedupeKey enforced by partial unique index on work_queue.dedupe_key",
      pauseDrain: "server/services/queueDrainControl.ts — persisted queue_drain_state pause/rate-limit + cancelPendingJobs, audited in admin_setting_audit",
      crossInstanceLocks: "server/services/crossInstanceLock.ts — PG advisory-lock singleton helpers (withWorkerSingletonLock)",
      backlogAlerts: "queueDrainBacklogAlerts / queueStarvationAlerts / leaseChurnAlerts schedulers watch queue health",
      shutdown: "server/boot/shutdown.ts trackTimer + isGracefulShutdown gates deferred scheduler ticks",
    },
  };
}

export function generate(repoRoot: string = process.cwd()): InventoryDocument {
  return buildDocument({
    generator: "scripts/generate-async-topology-inventory.ts",
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
    label: "async-topology-inventory",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(cliMain());
}
