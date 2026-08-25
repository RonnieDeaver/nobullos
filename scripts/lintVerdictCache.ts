/**
 * lintVerdictCache.ts — Task #4531: exact-input memoization of GREEN lint
 * verdicts for the heavyweight repo-tree lints (async-correctness ~166s,
 * react-hooks ~80s), so the merge gate and the full-set suites stop paying
 * a full typed rescan when not one input byte changed.
 *
 * Contract (approved in the Task #4531 L3 Architecture Impact Review):
 *   - GREEN VERDICTS ONLY. A red/failed/error outcome is never cached; the
 *     cache can therefore never hide a violation — at worst it re-runs.
 *   - The key is a sha256 over the exact content of every input that can
 *     change the verdict: each scanned/type-program file's (path,
 *     content-hash) pair plus the lint script, this module, baseline files,
 *     tsconfigs, package-lock.json and the Node major version. Any byte
 *     change anywhere ⇒ different key ⇒ full scan. No TTL, no staleness
 *     class (AIR pressure question P7: there are no stale readers because
 *     identity, not time, is the invalidation).
 *   - Every hash/read/store error falls open to running the real scan.
 *   - Store: .local/state/lint-verdict-cache/<name>.json — per-environment,
 *     gitignored, atomic write (tmp+rename), single latest entry per lint.
 *   - Kill switch: LINT_VERDICT_CACHE=0 disables reads AND writes.
 *   - HONEST REPORTING (governor rule): on a hit, callers must say
 *     "reused cached green verdict", never "ran"/"scanned".
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const STORE_DIR = ".local/state/lint-verdict-cache";
const SCHEMA_VERSION = 1;

export function verdictCacheEnabled(): boolean {
  return process.env.LINT_VERDICT_CACHE !== "0";
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash a file list into a single digest: sorted, de-duplicated
 * `<relPath>\0<contentSha>` lines. A missing/unreadable file folds in as a
 * MISSING marker — it still rotates the key, so deleting a scanned file
 * invalidates just like editing one.
 */
export function hashFileListForKey(repoRoot: string, paths: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(repoRoot, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let contentHash: string;
    try {
      contentHash = sha256(readFileSync(abs));
    } catch {
      contentHash = "MISSING";
    }
    lines.push(`${abs}\u0000${contentHash}`);
  }
  lines.sort();
  return sha256(lines.join("\n"));
}

export function computeVerdictKey(input: {
  label: string;
  repoRoot: string;
  files: string[];
  extra?: string[];
}): string {
  const fileDigest = hashFileListForKey(input.repoRoot, input.files);
  return sha256(
    [
      `schema:${SCHEMA_VERSION}`,
      `label:${input.label}`,
      `files:${fileDigest}`,
      `node:${process.version.split(".")[0]}`,
      ...(input.extra ?? []).map((e) => `extra:${e}`),
    ].join("\n"),
  );
}

interface StoredVerdict<M> {
  schemaVersion: number;
  key: string;
  cachedAt: string;
  meta: M;
}

export interface VerdictCacheHit<M> {
  meta: M;
  cachedAt: string;
}

function storePath(repoRoot: string, name: string): string {
  return resolve(repoRoot, join(STORE_DIR, `${name}.json`));
}

/** Read the latest cached GREEN verdict; null on miss, mismatch, disablement
 * or ANY error (fall open to executing). */
export function readGreenVerdict<M>(
  repoRoot: string,
  name: string,
  key: string,
): VerdictCacheHit<M> | null {
  if (!verdictCacheEnabled()) return null;
  try {
    const raw = readFileSync(storePath(repoRoot, name), "utf8");
    const parsed = JSON.parse(raw) as StoredVerdict<M>;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof parsed.key !== "string" || parsed.key !== key) return null;
    if (typeof parsed.cachedAt !== "string" || !parsed.meta) return null;
    return { meta: parsed.meta, cachedAt: parsed.cachedAt };
  } catch {
    return null;
  }
}

/** Persist a GREEN verdict (callers must only invoke on ok === true).
 * Atomic tmp+rename; failures warn and are otherwise ignored — a lost write
 * only costs a future rescan. */
export function writeGreenVerdict<M>(
  repoRoot: string,
  name: string,
  key: string,
  meta: M,
): void {
  if (!verdictCacheEnabled()) return;
  try {
    const target = storePath(repoRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    const payload: StoredVerdict<M> = {
      schemaVersion: SCHEMA_VERSION,
      key,
      cachedAt: new Date().toISOString(),
      meta,
    };
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    console.warn(
      `[lint-verdict-cache] could not persist green verdict for ${name}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
