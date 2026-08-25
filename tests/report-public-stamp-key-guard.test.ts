/* test-registration
{
  "name": "Public report stamp-key guard — every section-data bookkeeping stamp constant is in the public strip list (Task #4509)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4509: the public strip list (server/services/reportPublicInternalKeys.ts) is the privacy boundary keeping internal backfill/convergence stamps on report_sections.data away from anonymous share/demo viewers. It was hand-maintained and had already drifted once (degenerateCopyRepairVersion leaked). This source-scan finds every exported stamp-key-shaped string constant under server/services and fails when one is neither in the strip list nor in the documented allow-list — the NEXT backfill stamp can't silently leak. Pure fs scan + one leaf-module import: fast, deterministic, no DB.",
  "scanPaths": [
    "server/services"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4509 — self-maintaining guard for the public report privacy boundary.
 *
 * Convention (documented in server/services/reportPublicInternalKeys.ts):
 * a section-data bookkeeping stamp is an exported string constant under
 * server/services that matches EITHER detector:
 *   - name-based:  `export const *_STAMP_KEY | *_OUTCOME_KEY | *_WARNING_KEY = "..."`
 *   - value-based: `export const X = "<camelCase key ending Version|Outcome|Warning>"`
 * Every detected key value must be covered by
 * PUBLIC_INTERNAL_SECTION_DATA_KEYS, or carry an explicit allow-list entry
 * below with a reason (the false-positive path). Allow-list hygiene follows
 * the frozen-snapshot/ratchet conventions:
 *   - an allow entry whose constant is no longer detected FAILS (stale entry —
 *     delete it);
 *   - an allow entry whose key IS in the strip list FAILS (contradictory —
 *     it is not a false positive any more);
 *   - a volume floor guards against the scan silently matching nothing
 *     (0-of-0 = skipped, not verified).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ── False-positive path: stamp-shaped constants NOT written to
// report_sections.data. Key = the constant's string VALUE; value = reason.
// Adding an entry here is an explicit, reviewed decision.
const ALLOWED_NON_SECTION_DATA_STAMPS: Record<string, string> = {
  demo_report_curation_v1:
    "DEMO_CURATION_STAMP_KEY (demoReportCuration.ts) is a system_settings " +
    "key gating the one-time demo curation prod action; it is never written " +
    "onto report_sections.data, so the public strip list does not apply.",
  link_preview_sanitize_backfill_done_v1:
    "LINK_PREVIEW_SANITIZE_STAMP_KEY (linkPreviewSanitizeBackfill.ts) is a " +
    "system_settings done-marker for the one-time link-preview sanitize " +
    "backfill (read/written via getSystemSetting/setSystemSetting); it is " +
    "never written onto report_sections.data.",
};

const SERVICES_DIR = "server/services";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Strip block + line comments so prose mentions can't trip the scan.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface DetectedStamp {
  file: string;
  constName: string;
  value: string;
}

function detectStamps(): DetectedStamp[] {
  const nameBased =
    /export\s+const\s+([A-Z0-9_]*(?:STAMP_KEY|OUTCOME_KEY|WARNING_KEY))\s*=\s*"([^"]+)"/g;
  const valueBased =
    /export\s+const\s+([A-Z0-9_]+)\s*=\s*"([a-z][A-Za-z0-9]*(?:Version|Outcome|Warning))"/g;
  const found = new Map<string, DetectedStamp>();
  for (const file of listTsFiles(SERVICES_DIR)) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const re of [nameBased, valueBased]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        found.set(`${file}:${m[1]}`, { file, constName: m[1], value: m[2] });
      }
    }
  }
  return [...found.values()];
}

async function main() {
  const { PUBLIC_INTERNAL_SECTION_DATA_KEYS } = await import(
    "../server/services/reportPublicInternalKeys"
  );
  const stripSet = new Set(PUBLIC_INTERNAL_SECTION_DATA_KEYS);

  const detected = detectStamps();

  // Volume floor: the corpus has 5 known stamp constants today (broken-source
  // warning, common-issues reformat, June lead-reparse pair, degenerate
  // repair) + the demo-curation allow entry. Fewer means the detectors or the
  // scan root broke — fail loudly rather than pass on an empty scan.
  assert.ok(
    detected.length >= 5,
    `stamp-key scan found only ${detected.length} constants under ${SERVICES_DIR} — detectors or scan root broke (expected ≥ 5)`,
  );

  // Core coverage: every detected stamp value is stripped or allow-listed.
  const uncovered = detected.filter(
    (d) => !stripSet.has(d.value) && !(d.value in ALLOWED_NON_SECTION_DATA_STAMPS),
  );
  assert.deepEqual(
    uncovered,
    [],
    "New section-data stamp-key constant(s) not covered by the public strip " +
      "list — anonymous share/demo viewers would see them. Either import the " +
      "constant into PUBLIC_INTERNAL_SECTION_DATA_KEYS " +
      "(server/services/reportPublicInternalKeys.ts) or, ONLY if the key is " +
      "never written to report_sections.data, add a reasoned entry to " +
      "ALLOWED_NON_SECTION_DATA_STAMPS in this test:\n" +
      uncovered.map((d) => `  ${d.file}: ${d.constName} = "${d.value}"`).join("\n"),
  );

  // Allow-list hygiene (shrink-only): entries must still exist and must not
  // also be in the strip list.
  const detectedValues = new Set(detected.map((d) => d.value));
  for (const [value, reason] of Object.entries(ALLOWED_NON_SECTION_DATA_STAMPS)) {
    assert.ok(
      detectedValues.has(value),
      `stale allow-list entry "${value}" — no matching exported constant under ${SERVICES_DIR}; delete the entry (reason was: ${reason})`,
    );
    assert.ok(
      !stripSet.has(value),
      `contradictory allow-list entry "${value}" — it IS in PUBLIC_INTERNAL_SECTION_DATA_KEYS; remove it from the allow-list`,
    );
    assert.ok(reason.trim().length >= 20, `allow-list entry "${value}" needs a real reason`);
  }

  // Known-key pinning: the boundary must keep covering today's stamps.
  for (const key of [
    "brokenSourceImportWarning",
    "commonIssuesReformatBackfillVersion",
    "juneLeadReparseVersion",
    "juneLeadReparseOutcome",
    "degenerateCopyRepairVersion",
    "gbpUnresolvedImports",
  ]) {
    assert.ok(stripSet.has(key), `strip list lost known internal key "${key}"`);
  }

  console.log(
    `report-public-stamp-key-guard: ${detected.length} stamp constants detected, ` +
      `${stripSet.size} strip-list keys, ${Object.keys(ALLOWED_NON_SECTION_DATA_STAMPS).length} allow-listed — OK`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
