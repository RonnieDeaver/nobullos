/**
 * lint-vendor-confinement.ts (Task #4180 — Architecture Governor first-wave
 * guard #3, activation approved per audits/architecture-governor-hardening-
 * epic-approval.md).
 *
 * Vendor SDK imports must stay behind owning adapters. The current direct
 * importers (OpenAI alone had 17) are FROZEN in
 * scripts/vendor-importer-baseline.json — grandfathered, no forced refactor.
 * This guard blocks NET-NEW direct importers: new code must route vendor
 * calls through the vendor's designated adapter (or an existing baseline
 * file), or obtain explicit owner approval (L3 — increasing a frozen debt
 * baseline) to add itself to the baseline.
 *
 * Detection: line-level scan of server/, shared/, scripts/, tests/ for
 * import / export-from / require() / dynamic import() of the vendor package
 * name or any subpath. Type-only imports count too — unsafe vendor types in
 * core logic are exactly what adapters are meant to contain.
 *
 * Task #4193 — fetch-based vendors (Front, Zoom) have no npm SDK to scan
 * for, so an import-based guard can't see them. For vendors declaring
 * `detection: "host"` + `hosts: [...]`, the scan instead looks for the
 * vendor's API host substrings in CODE (comments masked — doc URLs like
 * dev.frontapp.com appear in comments everywhere and are not vendor calls;
 * strings/templates kept — that's where fetch targets live). Any file that
 * builds a URL against the vendor host outside the frozen baseline fails,
 * which confines raw-fetch vendor calls to the owning adapter exactly like
 * SDK imports.
 *
 * Task #4249 — some vendors build their URLs from environment variables
 * (Slack webhooks, LiveKit REST) so no literal host ever appears and host
 * detection cannot see a direct caller. Vendors may declare `envVars:
 * [...]`: any file referencing one of those env-var names in code
 * (comments masked, same boundary rules as hosts) counts as a caller too,
 * ON TOP of the vendor's import/host detection. This confines
 * process.env-built vendor URLs to the owning adapter with the same
 * frozen-baseline ratchet.
 *
 * Task #5008 — the baseline itself is a frozen ratchet, but regeneration
 * used to be able to silently absorb net-new offenders (a 2026-08-18 merge
 * regenerated the baseline and quietly grew the clickup/google-ads caller
 * sets, flipping a verified red to a false green). Every baseline entry
 * (each `files` path, each `hosts` host, each `envVars` name) must now
 * carry an explicit per-entry approval record in the vendor's `approvals`
 * map (key `file:<path>` / `host:<host>` / `env:<NAME>` → non-empty
 * owner-approval reference). GROWING the baseline without adding the
 * matching approval fails the lint — so a regenerated baseline that
 * absorbed new offenders is rejected until each addition is explicitly
 * blessed (L3, owner approval). SHRINKS stay free: removing an entry
 * requires removing its approval too (an orphan approval is stale and
 * fails), so approvals never outlive their entries.
 *
 * Checks:
 *   1. No file outside the vendor's frozen baseline imports its SDK
 *      (or, for host-mode vendors, references its API host in code; or,
 *      for vendors declaring envVars, references a vendor URL env var).
 *   2. No stale baseline entries: a listed file that no longer imports the
 *      SDK / references the host (or was deleted) must be removed
 *      (shrink-only, no approval needed) so the ratchet never rots
 *      (memory: ratchet-frozen-snapshot-pattern).
 *   3. Growth approval (Task #5008): every files/hosts/envVars entry has a
 *      non-empty approval record; every approval record matches a live
 *      entry. Unapproved growth and orphan approvals both fail.
 *
 * Exit 0 = confined; 1 = net-new importer, stale baseline, or unapproved
 * baseline growth.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { maskComments } from "./lint-work-queue-producer-handlers";
import {
  computeVerdictKey,
  readGreenVerdict,
  verdictCacheEnabled,
  writeGreenVerdict,
} from "./lintVerdictCache";

const BASELINE_PATH = "scripts/vendor-importer-baseline.json";
const SCAN_ROOTS = ["server", "shared", "scripts", "tests"];
const SCAN_EXTS = [".ts", ".tsx", ".mts", ".mjs"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERDICT_CACHE_NAME = "lint-vendor-confinement";

export const REMEDIATION =
  "Route the vendor call through the vendor's owning adapter (see the " +
  "'adapter' field in scripts/vendor-importer-baseline.json) instead of " +
  "importing the SDK directly or fetching the vendor API host directly. " +
  "Adding a file to the frozen baseline requires " +
  "explicit owner approval (L3): every baseline entry must carry a matching " +
  'per-entry approval record in the vendor\'s "approvals" map ' +
  '(key "file:<path>" / "host:<host>" / "env:<NAME>" -> owner-approval ' +
  "reference), so regenerated growth can never land silently. Remove " +
  "baseline entries (and their approval records) for files that no " +
  "longer import the SDK (shrink-only, no approval needed).";

export interface VendorBaseline {
  vendors: Record<
    string,
    {
      adapter: string | null;
      files: string[];
      /** "import" (default) = SDK package import scan; "host" = API host substring scan (fetch-based vendors, Task #4193). */
      detection?: "import" | "host";
      /** Required when detection === "host": vendor API host substrings (matched in comment-masked source). */
      hosts?: string[];
      /**
       * Optional (Task #4249): vendor-URL env-var names (e.g. the Slack
       * webhook URL variable). A file referencing one of these names in
       * comment-masked code counts as a direct vendor caller IN ADDITION
       * to the vendor's import/host detection — env-built vendor URLs
       * never contain a literal host, so host mode alone cannot see them.
       */
      envVars?: string[];
      /**
       * Optional per-vendor scan roots (Task #4223). Defaults to the global
       * SCAN_ROOTS. Vendors whose API is called from the browser (e.g.
       * MapTiler) add "client/src" so client-side callers are confined too.
       */
      scanRoots?: string[];
      /**
       * Required per-entry growth approvals (Task #5008). Every entry in
       * `files` / `hosts` / `envVars` must have a matching key here
       * (`file:<path>`, `host:<host>`, `env:<NAME>`) whose value is a
       * non-empty owner-approval reference. Growing the baseline without
       * the matching approval fails the lint; an approval whose entry was
       * removed is stale and fails too (shrinks remove both).
       */
      approvals?: Record<string, string>;
    }
  >;
}

export interface VendorConfinementLintResult {
  ok: boolean;
  vendorCount: number;
  scannedFileCount: number;
  problems: string[];
}

/** True when `source` contains an import/require of `pkg` or a subpath. */
export function importsPackage(source: string, pkg: string): boolean {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // from "pkg" | from "pkg/sub" | import("pkg") | require("pkg") | import "pkg"
  const re = new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|^\\s*import\\s+)["'\`]${esc}(?:/[^"'\`]*)?["'\`]`,
    "m",
  );
  return re.test(source);
}

/**
 * True when comment-masked `source` references vendor API `host` in code
 * (string/template literals, i.e. where fetch URLs are built). Boundary
 * guards prevent false positives on look-alike domains ("myfrontapp.com",
 * "frontapp.community") while still matching subdomains ("api2.frontapp.com")
 * and paths ("zoom.us/oauth/token").
 */
export function referencesHost(source: string, host: string): boolean {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`);
  return re.test(maskComments(source));
}

/**
 * True when comment-masked `source` references env-var `name` in code
 * (identifier or string form — `process.env.X`, `env["X"]`, indirection via
 * a string constant all count). Boundary guards prevent false positives on
 * longer names that merely contain `name` as a substring.
 */
export function referencesEnvVar(source: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`);
  return re.test(maskComments(source));
}

export function discoverScanFiles(
  roots: string[] = SCAN_ROOTS,
  cwd: string = process.cwd(),
): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(cwd, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    const stack = [absoluteRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules") continue;
          stack.push(full);
        } else if (
          ent.isFile() &&
          SCAN_EXTS.some((e) => ent.name.endsWith(e)) &&
          !ent.name.endsWith(".d.ts")
        ) {
          out.push(path.relative(cwd, full).split(path.sep).join("/"));
        }
      }
    }
  }
  return out.sort();
}

export interface VendorConfinementLintOptions {
  /** Repository root for the real-tree scan. Defaults to process.cwd(). */
  cwd?: string;
  baselinePath?: string;
  baseline?: VendorBaseline;
  files?: { path: string; source: string }[];
}

/** Pure core, unit-testable via injected baseline/files. */
export function runLint(options?: VendorConfinementLintOptions): VendorConfinementLintResult {
  const problems: string[] = [];
  const cwd = options?.cwd ?? process.cwd();

  let baseline: VendorBaseline | null = options?.baseline ?? null;
  if (!baseline) {
    const baselinePath = options?.baselinePath ?? BASELINE_PATH;
    const absoluteBaselinePath = path.resolve(cwd, baselinePath);
    if (!fs.existsSync(absoluteBaselinePath)) {
      problems.push(`${baselinePath} is missing.`);
      return { ok: false, vendorCount: 0, scannedFileCount: 0, problems };
    }
    try {
      baseline = JSON.parse(fs.readFileSync(absoluteBaselinePath, "utf-8")) as VendorBaseline;
    } catch {
      problems.push(`${(options?.baselinePath ?? BASELINE_PATH)} is not valid JSON.`);
      return { ok: false, vendorCount: 0, scannedFileCount: 0, problems };
    }
  }
  if (!baseline.vendors || typeof baseline.vendors !== "object") {
    problems.push(`vendor baseline has no "vendors" object.`);
    return { ok: false, vendorCount: 0, scannedFileCount: 0, problems };
  }

  // Union of the global roots and every vendor's extra scanRoots; each
  // vendor then only sees files under ITS roots (default = SCAN_ROOTS).
  const allRoots = Array.from(
    new Set([
      ...SCAN_ROOTS,
      ...Object.values(baseline.vendors).flatMap((v) => v.scanRoots ?? []),
    ]),
  );
  const files =
    options?.files ??
    discoverScanFiles(allRoots, cwd).map((p) => ({
      path: p,
      source: fs.readFileSync(path.resolve(cwd, p), "utf-8"),
    }));

  const vendors = Object.keys(baseline.vendors);
  for (const vendor of vendors) {
    const entry = baseline.vendors[vendor];
    const allowed = new Set(entry.files);
    const roots = entry.scanRoots ?? SCAN_ROOTS;
    const vendorFiles = files.filter((f) =>
      roots.some((r) => f.path === r || f.path.startsWith(`${r}/`)),
    );
    const hostMode = entry.detection === "host";
    if (hostMode && (!Array.isArray(entry.hosts) || entry.hosts.length === 0)) {
      problems.push(`vendor "${vendor}" declares detection "host" but has no "hosts" list.`);
      continue;
    }
    const envVars = entry.envVars ?? [];
    const importers = new Set<string>();
    /** files that hit ONLY via an env-var reference (for message clarity) */
    const envOnly = new Set<string>();
    for (const f of vendorFiles) {
      const baseHit = hostMode
        ? entry.hosts!.some((h) => referencesHost(f.source, h))
        : importsPackage(f.source, vendor);
      const envHit = envVars.some((n) => referencesEnvVar(f.source, n));
      if (baseHit || envHit) importers.add(f.path);
      if (envHit && !baseHit) envOnly.add(f.path);
    }
    // 1. Net-new importers / host callers.
    for (const f of importers) {
      if (!allowed.has(f)) {
        problems.push(
          envOnly.has(f)
            ? `NET-NEW reader of the "${vendor}" vendor-URL env var(s) (${envVars.join(", ")}): ${f} — ` +
                `env-built vendor URLs are confined to the frozen baseline` +
                `${entry.adapter ? ` (owning adapter: ${entry.adapter})` : ""}.`
            : hostMode
            ? `NET-NEW caller of the "${vendor}" API host (${entry.hosts!.join(", ")}): ${f} — ` +
                `raw vendor-host calls are confined to the frozen baseline` +
                `${entry.adapter ? ` (owning adapter: ${entry.adapter})` : ""}.`
            : `NET-NEW direct importer of "${vendor}": ${f} — vendor SDK imports are confined to ` +
                `the frozen baseline${entry.adapter ? ` (owning adapter: ${entry.adapter})` : ""}.`,
        );
      }
    }
    // 2. Stale baseline entries.
    for (const f of entry.files) {
      if (!importers.has(f)) {
        problems.push(
          `stale baseline entry for "${vendor}": ${f} no longer ` +
            `${hostMode ? "references the vendor API host" : "imports the SDK"}` +
            `${envVars.length ? " or its vendor-URL env var(s)" : ""} (or was deleted) — ` +
            `remove it from scripts/vendor-importer-baseline.json (shrink-only, no approval needed).`,
        );
      }
    }
    // 3. Growth approval (Task #5008): every entry needs a per-entry
    // approval record; every approval record needs a live entry. This makes
    // baseline GROWTH mechanically loud — a regenerated baseline that
    // absorbed a net-new caller fails here until the addition is blessed
    // with an explicit owner-approval reference — while SHRINKS stay free
    // (removing an entry just also removes its approval line).
    const approvals = entry.approvals ?? {};
    const liveKeys = new Set<string>([
      ...entry.files.map((f) => `file:${f}`),
      ...(entry.hosts ?? []).map((h) => `host:${h}`),
      ...envVars.map((n) => `env:${n}`),
    ]);
    for (const key of liveKeys) {
      const reason = approvals[key];
      if (typeof reason !== "string" || reason.trim() === "") {
        problems.push(
          `UNAPPROVED baseline entry for "${vendor}": ${key} — growing a frozen vendor ` +
            `baseline is L3 (owner approval). Add approvals["${key}"] = "<owner-approval ` +
            `reference>" to the vendor's entry in scripts/vendor-importer-baseline.json, ` +
            `or (preferred) remove the direct vendor reference and route through the ` +
            `owning adapter${entry.adapter ? ` (${entry.adapter})` : ""}.`,
        );
      }
    }
    for (const key of Object.keys(approvals)) {
      if (!liveKeys.has(key)) {
        problems.push(
          `stale approval record for "${vendor}": ${key} matches no files/hosts/envVars ` +
            `entry — remove it from the vendor's "approvals" map (shrink-only).`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    vendorCount: vendors.length,
    scannedFileCount: files.length,
    problems,
  };
}

interface CachedVendorConfinementVerdictMeta {
  vendorCount: number;
  scannedFileCount: number;
  inputFileCount: number;
}

export type CachedVendorConfinementLintResult = VendorConfinementLintResult & {
  fromCache?: boolean;
};

/**
 * Exact inputs for the default full-tree lint. The baseline controls both
 * vendor rules and extra scan roots, so it is parsed before discovering files;
 * a malformed/unreadable baseline falls open rather than reusing a prior
 * green. Directory membership is included through the discovered file list:
 * adding or deleting a scanned file changes the list digest.
 */
export function collectVendorConfinementVerdictInputs(cwd: string = process.cwd()): string[] | null {
  try {
    const baselinePath = path.resolve(cwd, BASELINE_PATH);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as VendorBaseline;
    if (!baseline.vendors || typeof baseline.vendors !== "object") return null;
    const roots = Array.from(
      new Set([
        ...SCAN_ROOTS,
        ...Object.values(baseline.vendors).flatMap((vendor) => vendor.scanRoots ?? []),
      ]),
    );
    return [
      ...discoverScanFiles(roots, cwd).map((file) => path.resolve(cwd, file)),
      baselinePath,
      // The scanner's own implementation, its only local helper, cache
      // contract, and Node/package metadata can all change its verdict.
      path.resolve(ROOT, "scripts/lint-vendor-confinement.ts"),
      path.resolve(ROOT, "scripts/lint-work-queue-producer-handlers.ts"),
      path.resolve(ROOT, "scripts/lintVerdictCache.ts"),
      path.resolve(cwd, "package.json"),
      path.resolve(cwd, "package-lock.json"),
      path.resolve(cwd, "tsconfig.json"),
    ];
  } catch {
    return null;
  }
}

/**
 * Memoizes only a GREEN full-tree vendor-confinement result. Fixture and
 * injected-baseline callers intentionally use runLint() directly. Every cache
 * read, write, hash, or baseline-discovery error falls open to that real scan.
 */
export function runLintCached(
  options: Pick<VendorConfinementLintOptions, "cwd"> = {},
): CachedVendorConfinementLintResult {
  const cwd = options.cwd ?? process.cwd();
  let key: string | null = null;
  let inputFileCount = 0;
  if (verdictCacheEnabled()) {
    const inputs = collectVendorConfinementVerdictInputs(cwd);
    if (inputs) {
      inputFileCount = inputs.length;
      key = computeVerdictKey({
        label: VERDICT_CACHE_NAME,
        repoRoot: cwd,
        files: inputs,
      });
    }
  }
  if (key) {
    const hit = readGreenVerdict<CachedVendorConfinementVerdictMeta>(
      cwd,
      VERDICT_CACHE_NAME,
      key,
    );
    if (hit) {
      return {
        ok: true,
        vendorCount: hit.meta.vendorCount,
        scannedFileCount: hit.meta.scannedFileCount,
        problems: [],
        fromCache: true,
      };
    }
  }

  const result = runLint({ cwd });
  if (key && result.ok) {
    writeGreenVerdict<CachedVendorConfinementVerdictMeta>(cwd, VERDICT_CACHE_NAME, key, {
      vendorCount: result.vendorCount,
      scannedFileCount: result.scannedFileCount,
      inputFileCount,
    });
  }
  return result;
}

export function cliMain(): number {
  const result = runLintCached();
  if (!result.ok) {
    console.error("");
    console.error("✗ lint-vendor-confinement: vendor SDK import boundary violated");
    console.error("");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("");
    console.error(`  Remediation: ${REMEDIATION}`);
    console.error("");
    return 1;
  }
  if (result.fromCache) {
    console.log(
      `lint-vendor-confinement: reused cached green verdict — all ${result.scannedFileCount} ` +
        `scanned source inputs, the frozen baseline, scanner implementation, helper, package metadata, ` +
        `and Node major are byte-identical to the prior green scan. No source scan was run. ` +
        `LINT_VERDICT_CACHE=0 forces a real scan.`,
    );
    return 0;
  }
  console.log(
    `lint-vendor-confinement: OK (${result.vendorCount} vendor boundaries (SDK-import + fetch-host) ` +
      `confined to their frozen baselines across ${result.scannedFileCount} scanned files)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-vendor-confinement.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
