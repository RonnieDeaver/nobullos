/* test-registration
{
  "name": "lint-website-bundle-freshness guard — fixture trees prove the marketing-bundle freshness lint passes when the committed stamp matches the generator inputs and fails naming the drifted file plus the exact regen command on edit/add/remove/missing/corrupt stamp; the real repo bundle is fresh; gate wiring stays in lockstep (PR4)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The freshness guard stops a stale committed website/public bundle from shipping to the production lead-gen homepage. The Validate workflow runs npm run gate, including this lint through gate.ts LINT_CHECKS; this always-core lint-*-named test proves the lint and workflow wiring. Pure fs fixtures, DB-free, fast.",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-website-bundle-freshness.ts (PR4).
 *
 * website/public is a COMMITTED build artifact (website/generate.ts renders
 * pages + bundles the client entries into assets/js/home.js + site.js;
 * script/build.ts only copies the directory). The lint compares the committed
 * website/public/build-manifest.json stamp against a fresh recompute of the
 * generator-input fingerprint (website/fingerprint.ts is the single shared
 * implementation). This test proves, on hermetic fixture trees:
 *
 *   1. A fresh stamp passes.
 *   2. Editing an input fails, naming the drifted file AND the exact
 *      regeneration command (`npx tsx website/generate.ts`).
 *   3. Adding a never-generated-from input fails (named as added).
 *   4. Deleting an input fails (named as removed).
 *   5. A missing or corrupt stamp fails with the regen command.
 *   6. Dotfiles (.DS_Store litter) do not affect the fingerprint.
 *   7. The fingerprint is deterministic across recomputes.
 *
 * …and on the real repo:
 *
 *   8. The committed bundle is currently FRESH (runLint() passes) — if this
 *      fires, someone edited website/src|content without regenerating.
 *   9. Wiring lockstep: the lint stays registered in scripts/gate.ts
 *      LINT_CHECKS and scripts/lint-gate-workflow-drift.ts defines
 *      `VALIDATION_WORKFLOW` with command `npm run gate`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeWebsiteInputManifest,
  renderWebsiteBuildManifest,
  WEBSITE_BUILD_MANIFEST_PATH,
  WEBSITE_REGEN_COMMAND,
} from "../website/fingerprint";
import { runLint, REMEDIATION } from "../scripts/lint-website-bundle-freshness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function writeFileEnsured(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Restamps the fixture the way website/generate.ts does. */
function stamp(root: string): void {
  writeFileEnsured(
    root,
    WEBSITE_BUILD_MANIFEST_PATH,
    renderWebsiteBuildManifest(computeWebsiteInputManifest(root)),
  );
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-website-freshness-"));
  writeFileEnsured(root, "website/src/pages/home.ts", "export const home = 1;\n");
  writeFileEnsured(root, "website/src/home-client/main.ts", "console.log('cinematic');\n");
  writeFileEnsured(root, "website/content/articles/sample.json", "{\"title\":\"a\"}\n");
  writeFileEnsured(root, "website/generate.ts", "// fixture generator stand-in\n");
  writeFileEnsured(root, "website/public/assets/css/site.css", "body{margin:0}\n");
  // Generated OUTPUTS — must never count as inputs (both bundled from
  // website/src by the generator; site.js since PR5).
  writeFileEnsured(root, "website/public/assets/js/home.js", "/* bundled */\n");
  writeFileEnsured(root, "website/public/assets/js/site.js", "(function(){})();\n");
  stamp(root);
  return root;
}

function problemsText(root: string): string {
  return runLint(root).problems.join("\n");
}

async function main(): Promise<void> {
  const fixtures: string[] = [];
  try {
    console.log("\n— fixture: fresh stamp passes —");
    const fresh = makeFixture();
    fixtures.push(fresh);
    const freshResult = runLint(fresh);
    assert(freshResult.ok, `fresh fixture passes (problems: ${freshResult.problems.join(" | ") || "none"})`);
    assert(freshResult.inputCount === 5, `fixture enumerates 5 inputs (src×2 + content + generate.ts + site.css), got ${freshResult.inputCount}`);
    const freshInputs = Object.keys(computeWebsiteInputManifest(fresh).inputs);
    assert(
      !freshInputs.some(
        (p) => p.endsWith("assets/js/home.js") || p.endsWith("assets/js/site.js"),
      ),
      "generated home.js AND site.js are EXCLUDED from the input set (both bundled from website/src since PR5)",
    );

    console.log("\n— fixture: edited input fails, naming file + regen command —");
    const edited = makeFixture();
    fixtures.push(edited);
    writeFileEnsured(edited, "website/src/pages/home.ts", "export const home = 2; // drifted\n");
    const editedResult = runLint(edited);
    const editedText = editedResult.problems.join("\n");
    assert(!editedResult.ok, "edited input fails the lint");
    assert(editedText.includes("website/src/pages/home.ts"), "failure names the drifted file");
    assert(editedText.includes(WEBSITE_REGEN_COMMAND), `failure names the regen command \`${WEBSITE_REGEN_COMMAND}\``);
    assert(editedText.includes("STALE"), "failure states the bundle is stale");

    console.log("\n— fixture: added input fails —");
    const added = makeFixture();
    fixtures.push(added);
    writeFileEnsured(added, "website/src/pages/new-page.ts", "export const p = 1;\n");
    const addedText = problemsText(added);
    assert(addedText.includes("website/src/pages/new-page.ts"), "failure names the added file");
    assert(addedText.includes("new inputs never generated from"), "added file is classified as never-generated-from");

    console.log("\n— fixture: removed input fails —");
    const removed = makeFixture();
    fixtures.push(removed);
    fs.rmSync(path.join(removed, "website/content/articles/sample.json"));
    const removedText = problemsText(removed);
    assert(removedText.includes("website/content/articles/sample.json"), "failure names the deleted file");
    assert(removedText.includes("deleted since last generation"), "deleted file is classified as removed");
    assert(removedText.includes(WEBSITE_REGEN_COMMAND), "removal failure still names the regen command");

    console.log("\n— fixture: missing / corrupt stamp fails —");
    const missing = makeFixture();
    fixtures.push(missing);
    fs.rmSync(path.join(missing, WEBSITE_BUILD_MANIFEST_PATH));
    const missingResult = runLint(missing);
    assert(!missingResult.ok, "missing stamp fails the lint");
    assert(
      missingResult.problems.join("\n").includes(WEBSITE_REGEN_COMMAND),
      "missing-stamp failure names the regen command",
    );
    const corrupt = makeFixture();
    fixtures.push(corrupt);
    writeFileEnsured(corrupt, WEBSITE_BUILD_MANIFEST_PATH, "not json{{{\n");
    const corruptResult = runLint(corrupt);
    assert(!corruptResult.ok, "corrupt stamp fails the lint");
    assert(corruptResult.problems.join("\n").includes("not valid JSON"), "corrupt stamp is called out as invalid JSON");

    console.log("\n— fixture: dotfile litter ignored + determinism —");
    const litter = makeFixture();
    fixtures.push(litter);
    writeFileEnsured(litter, "website/src/.DS_Store", "\u0000junk");
    assert(runLint(litter).ok, "dotfile litter under website/src does not change the fingerprint");
    const a = computeWebsiteInputManifest(litter).inputFingerprint;
    const b = computeWebsiteInputManifest(litter).inputFingerprint;
    assert(a === b, "fingerprint is deterministic across recomputes");

    console.log("\n— real repo: committed bundle is fresh —");
    const repo = runLint();
    assert(
      repo.ok,
      `committed website/public bundle is FRESH (${repo.problems.join(" | ") || "ok"}) — if this fails, ${REMEDIATION}`,
    );
    assert(repo.inputCount > 20, `real repo enumerates a plausible input set (${repo.inputCount} files)`);

    console.log("\n— wiring lockstep: gate + drift allow-list + self-check doc —");
    const gateSrc = fs.readFileSync(path.join(REPO_ROOT, "scripts/gate.ts"), "utf8");
    assert(
      gateSrc.includes('name: "lint-website-bundle-freshness"'),
      "scripts/gate.ts LINT_CHECKS registers lint-website-bundle-freshness",
    );
    const driftSrc = fs.readFileSync(
      path.join(REPO_ROOT, "scripts/lint-gate-workflow-drift.ts"),
      "utf8",
    );
    assert(
      /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(driftSrc),
      "scripts/lint-gate-workflow-drift.ts defines VALIDATION_WORKFLOW with command npm run gate",
    );
    const selfcheck = fs.readFileSync(path.join(REPO_ROOT, "TASK_SELFCHECK.md"), "utf8");
    assert(
      selfcheck.includes("lint-website-bundle-freshness"),
      "TASK_SELFCHECK.md documents the lint in the self-check table",
    );
  } finally {
    for (const root of fixtures) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`\nlint-website-bundle-freshness guard: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("lint-website-bundle-freshness guard: fatal", err);
  process.exit(1);
});
