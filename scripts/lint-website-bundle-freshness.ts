/**
 * lint-website-bundle-freshness.ts (PR4)
 *
 * Freshness guard for the committed marketing website bundle.
 *
 * Background: website/public is a COMMITTED build artifact — website/generate.ts
 * renders the HTML pages and bundles website/src/home-client/main.ts into
 * public/assets/js/home.js, and script/build.ts only COPIES website/public to
 * dist/website at deploy time. Nothing regenerates or verifies the bundle, so
 * editing any generator input (website/src/**, website/content/**, the
 * generator itself, or the hand-authored assets hashed into the `?v=`
 * cache-buster) without re-running the generator silently ships stale JS/HTML
 * on the production lead-gen homepage (nobullmarketing.com).
 *
 * The generator stamps a deterministic fingerprint of its inputs into
 * website/public/build-manifest.json (see website/fingerprint.ts — the single
 * shared implementation). This lint recomputes the fingerprint from the
 * current tree and fails when it no longer matches the committed stamp,
 * naming exactly which inputs drifted and the command that fixes it:
 *
 *   npx tsx website/generate.ts
 *   then commit the regenerated website/public (including build-manifest.json).
 *
 * Exit 0 = stamp matches the inputs; 1 = stale (or stamp missing/corrupt).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeWebsiteInputManifest,
  WEBSITE_BUILD_MANIFEST_PATH,
  WEBSITE_REGEN_COMMAND,
} from "../website/fingerprint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const REMEDIATION =
  `Run \`${WEBSITE_REGEN_COMMAND}\` and commit the regenerated website/public ` +
  `bundle (including ${WEBSITE_BUILD_MANIFEST_PATH}).`;

export interface WebsiteFreshnessLintResult {
  ok: boolean;
  problems: string[];
  /** Fingerprint recomputed from the current tree. */
  freshFingerprint: string;
  /** Fingerprint recorded in the committed stamp (null when missing/corrupt). */
  committedFingerprint: string | null;
  inputCount: number;
}

function sample(label: string, items: string[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, 10).join(", ");
  return `${label} (${items.length}): ${shown}${items.length > 10 ? ", …" : ""}`;
}

/**
 * Pure core, unit-testable against fixture trees via `rootOverride`.
 * Compares the committed build-manifest stamp with a fresh recompute of the
 * generator-input fingerprint.
 */
export function runLint(rootOverride?: string): WebsiteFreshnessLintResult {
  const root = rootOverride ?? ROOT;
  const problems: string[] = [];

  const fresh = computeWebsiteInputManifest(root);
  const manifestAbs = path.join(root, WEBSITE_BUILD_MANIFEST_PATH);

  let committedFingerprint: string | null = null;
  let committedInputs: Record<string, string> | null = null;
  if (!fs.existsSync(manifestAbs)) {
    problems.push(
      `${WEBSITE_BUILD_MANIFEST_PATH} is missing — the bundle carries no freshness stamp. ${REMEDIATION}`,
    );
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestAbs, "utf8")) as {
        inputFingerprint?: unknown;
        inputs?: unknown;
      };
      if (typeof parsed.inputFingerprint === "string" && parsed.inputFingerprint) {
        committedFingerprint = parsed.inputFingerprint;
      } else {
        problems.push(
          `${WEBSITE_BUILD_MANIFEST_PATH} has no "inputFingerprint" string. ${REMEDIATION}`,
        );
      }
      if (
        typeof parsed.inputs === "object" &&
        parsed.inputs !== null &&
        !Array.isArray(parsed.inputs)
      ) {
        committedInputs = parsed.inputs as Record<string, string>;
      }
    } catch {
      problems.push(
        `${WEBSITE_BUILD_MANIFEST_PATH} is not valid JSON. ${REMEDIATION}`,
      );
    }
  }

  if (committedFingerprint && committedFingerprint !== fresh.inputFingerprint) {
    // Name exactly which inputs drifted so the failure is actionable even
    // before re-running the generator.
    const committedMap = committedInputs ?? {};
    const committedPaths = new Set(Object.keys(committedMap));
    const freshPaths = new Set(Object.keys(fresh.inputs));
    const changed = Object.keys(fresh.inputs).filter(
      (p) => committedPaths.has(p) && committedMap[p] !== fresh.inputs[p],
    );
    const added = Object.keys(fresh.inputs).filter((p) => !committedPaths.has(p));
    const removed = Object.keys(committedMap).filter((p) => !freshPaths.has(p));
    const details = [
      sample("edited since last generation", changed),
      sample("new inputs never generated from", added),
      sample("inputs deleted since last generation", removed),
    ].filter((d): d is string => d !== null);
    if (details.length === 0) {
      details.push(
        "input set matches but the recorded fingerprint disagrees — the stamp was edited by hand or produced by a divergent fingerprint implementation",
      );
    }
    problems.push(
      `website/public is STALE — the committed bundle was generated from different inputs ` +
        `(stamp ${committedFingerprint.slice(0, 12)}…, current inputs ${fresh.inputFingerprint.slice(0, 12)}…). ` +
        details.join("; ") +
        `. ${REMEDIATION}`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    freshFingerprint: fresh.inputFingerprint,
    committedFingerprint,
    inputCount: Object.keys(fresh.inputs).length,
  };
}

/** Gate worker-pool entry (Task #3789 cliMain contract): prints and returns the exit code. */
export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-website-bundle-freshness: committed marketing bundle is out of date",
    );
    console.error("");
    console.error(
      "  website/public is a committed build artifact served verbatim on the",
    );
    console.error(
      "  production lead-gen homepage; script/build.ts only copies it. An input",
    );
    console.error(
      "  edited without regenerating ships stale JS/HTML to nobullmarketing.com.",
    );
    console.error("");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("");
    console.error(`  Remediation: ${REMEDIATION}`);
    console.error("");
    return 1;
  }
  console.log(
    `lint-website-bundle-freshness: OK (${result.inputCount} inputs, fingerprint ${result.freshFingerprint.slice(0, 12)}… matches ${WEBSITE_BUILD_MANIFEST_PATH})`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-website-bundle-freshness.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
