/**
 * lint-gate-workflow-drift.ts
 *
 * Hard topology guard for repository-managed Replit workflows. The canonical
 * gate already owns typecheck, every lint, and smoke validation, so .replit
 * must expose exactly three roles:
 *
 *   - Start application: the sole Run-button target and web application.
 *   - Validate: the routine console validation role, running `npm run gate`.
 *   - Long validation: the explicit operator-started control runner. It uses a
 *     request file and cannot alter the two normal application roles.
 *
 * Focused `npx tsx scripts/lint-*.ts` and `npm run check` commands remain
 * documented CLI tooling; they are intentionally not workflows. This guard
 * prevents configuration drift back to a partial per-lint palette or a parent
 * fan-out whose child status can mask a failed canonical gate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const APPLICATION_WORKFLOW = {
  name: "Start application",
  command: "BOOKING_FEATURE_FLAGS_CACHE_TTL_MS=200 npm run dev",
  outputType: "webview",
  waitForPort: 5000,
  owner: "NoBull OS Control Plane",
  purpose: "Primary interactive application runtime",
  retirementTrigger: "Replace only through an owner-approved runtime cutover",
  slotBudget: "runtime-1-of-3",
} as const;

export const VALIDATION_WORKFLOW = {
  name: "Validate",
  command: "npm run gate",
  isValidation: true,
  owner: "NoBull OS Control Plane",
  purpose: "Canonical routine validation gate",
  retirementTrigger: "Replace only through an owner-approved gate cutover",
  slotBudget: "control-2-of-3",
} as const;

export const LONG_VALIDATION_WORKFLOW = {
  name: "Long validation",
  command: "npm run validate:long -- --request .local/runs/long-validation-request.json",
  outputType: "console",
  owner: "NoBull OS Control Plane",
  purpose: "Explicit reviewed long-control runner",
  retirementTrigger: "Remove when long-control evidence is retired by owner decision",
  slotBudget: "control-3-of-3",
} as const;

export const REPOSITORY_WORKFLOW_CAPACITY = 3;
export const RESERVED_ARTIFACT_PORT = 23636;
const ARTIFACT_PREVIEW_PATH = "/__mockup/";
const ARTIFACT_SERVICE_NAME = "Component Preview Server";

const APPROVED_WORKFLOW_NAMES = new Set([
  APPLICATION_WORKFLOW.name,
  VALIDATION_WORKFLOW.name,
  LONG_VALIDATION_WORKFLOW.name,
]);

export interface WorkflowEntry {
  name: string;
  commands: string[];
  taskKinds: string[];
  outputType?: string;
  waitForPort?: number;
  isValidation: boolean;
  metadata: Record<string, string>;
}

export interface PortMapping {
  localPort: number;
  externalPort: number;
}

export interface WorkflowTopologySources {
  replitSource?: string;
  artifactSource?: string;
}

export function runLint(
  sources: WorkflowTopologySources = {},
): { ok: boolean; message: string } {
  const replitSource =
    sources.replitSource ?? readFileSync(resolve(ROOT, ".replit"), "utf8");
  const artifactSource =
    sources.artifactSource ??
    readFileSync(
      resolve(ROOT, "artifacts/mockup-sandbox/.replit-artifact/artifact.toml"),
      "utf8",
    );
  const { runButton, workflows, ports } = extractWorkflowTopology(replitSource);
  const violations: string[] = [];

  if (runButton !== APPLICATION_WORKFLOW.name) {
    violations.push(
      `runButton must target "${APPLICATION_WORKFLOW.name}", found ${formatValue(runButton)}`,
    );
  }

  if (workflows.length !== REPOSITORY_WORKFLOW_CAPACITY) {
    violations.push(
      `workflow capacity is ${REPOSITORY_WORKFLOW_CAPACITY} roles with 0 spare slots; found ${workflows.length} — use the canonical CLI/gate or retire an approved role through owner review`,
    );
  }

  const byName = new Map<string, WorkflowEntry>();
  for (const workflow of workflows) {
    if (byName.has(workflow.name)) {
      violations.push(`duplicate workflow role "${workflow.name}"`);
      continue;
    }
    byName.set(workflow.name, workflow);
    if (!APPROVED_WORKFLOW_NAMES.has(workflow.name)) {
      violations.push(
        `forbidden workflow "${workflow.name}" — focused commands belong in the CLI, not the workflow registry`,
      );
    }
    if (workflow.name.startsWith("lint-")) {
      violations.push(
        `forbidden per-lint workflow "${workflow.name}" — run it directly only for focused debugging`,
      );
    }
    if (workflow.waitForPort === RESERVED_ARTIFACT_PORT) {
      violations.push(
        `"${workflow.name}" attempts to use artifact-reserved port ${RESERVED_ARTIFACT_PORT} — the Mockup Sandbox owns it; keep control roles portless`,
      );
    }
  }

  verifyPortMappings(ports, violations);
  verifyArtifactPreview(artifactSource, violations);
  verifyApplicationWorkflow(byName.get(APPLICATION_WORKFLOW.name), violations);
  verifyValidationWorkflow(byName.get(VALIDATION_WORKFLOW.name), violations);
  verifyLongValidationWorkflow(byName.get(LONG_VALIDATION_WORKFLOW.name), violations);

  if (violations.length > 0) {
    return {
      ok: false,
      message:
        `lint-gate-workflow-drift: ${violations.length} topology violation(s):\n` +
        violations.map((violation) => `  ✗ ${violation}`).join("\n") +
        "\n\nFix: preserve the 3-role capacity budget (0 spare slots), restore each role's approved metadata and command, and run focused checks from the CLI rather than borrowing a runtime workflow.",
    };
  }

  return {
    ok: true,
    message:
      "lint-gate-workflow-drift: OK (3/3 role slots used; 0 spare slots; protected application and artifact-preview ports; Validate runs the canonical gate; Long validation is the explicit allowlisted control runner)",
  };
}

function verifyApplicationWorkflow(
  workflow: WorkflowEntry | undefined,
  violations: string[],
): void {
  if (!workflow) {
    violations.push(`missing required workflow "${APPLICATION_WORKFLOW.name}"`);
    return;
  }
  verifySingleShellCommand(workflow, APPLICATION_WORKFLOW.command, violations);
  if (workflow.outputType !== APPLICATION_WORKFLOW.outputType) {
    violations.push(
      `"${workflow.name}" outputType must be "${APPLICATION_WORKFLOW.outputType}", found ${formatValue(workflow.outputType)}`,
    );
  }
  if (workflow.waitForPort !== APPLICATION_WORKFLOW.waitForPort) {
    violations.push(
      `"${workflow.name}" waitForPort must be ${APPLICATION_WORKFLOW.waitForPort}, found ${formatValue(workflow.waitForPort)}`,
    );
  }
  if (workflow.isValidation) {
    violations.push(`"${workflow.name}" must not be marked as a validation workflow`);
  }
  verifyGovernanceMetadata(workflow, APPLICATION_WORKFLOW, violations);
}

function verifyValidationWorkflow(
  workflow: WorkflowEntry | undefined,
  violations: string[],
): void {
  if (!workflow) {
    violations.push(`missing required workflow "${VALIDATION_WORKFLOW.name}"`);
    return;
  }
  verifySingleShellCommand(workflow, VALIDATION_WORKFLOW.command, violations);
  if (!workflow.isValidation) {
    violations.push(`"${workflow.name}" must be marked as a validation workflow`);
  }
  if (workflow.outputType !== undefined || workflow.waitForPort !== undefined) {
    violations.push(
      `"${workflow.name}" must be a console validation role without webview port metadata`,
    );
  }
  verifyGovernanceMetadata(workflow, VALIDATION_WORKFLOW, violations);
}

function verifyLongValidationWorkflow(
  workflow: WorkflowEntry | undefined,
  violations: string[],
): void {
  if (!workflow) {
    violations.push(`missing required workflow "${LONG_VALIDATION_WORKFLOW.name}"`);
    return;
  }
  verifySingleShellCommand(workflow, LONG_VALIDATION_WORKFLOW.command, violations);
  if (workflow.isValidation) {
    violations.push(`"${workflow.name}" must not be marked as the routine validation workflow`);
  }
  if (workflow.outputType !== LONG_VALIDATION_WORKFLOW.outputType || workflow.waitForPort !== undefined) {
    violations.push(
      `"${workflow.name}" must be a portless "${LONG_VALIDATION_WORKFLOW.outputType}" console role`,
    );
  }
  verifyGovernanceMetadata(workflow, LONG_VALIDATION_WORKFLOW, violations);
}

function verifyGovernanceMetadata(
  workflow: WorkflowEntry,
  expected: {
    owner: string;
    purpose: string;
    retirementTrigger: string;
    slotBudget: string;
  },
  violations: string[],
): void {
  for (const key of ["owner", "purpose", "retirementTrigger", "slotBudget"] as const) {
    if (workflow.metadata[key] !== expected[key]) {
      violations.push(
        `"${workflow.name}" metadata.${key} must be ${JSON.stringify(expected[key])}, found ${formatValue(workflow.metadata[key])} — every workflow needs a named owner, purpose, retirement trigger, and slot-budget justification`,
      );
    }
  }
}

function verifyPortMappings(ports: PortMapping[], violations: string[]): void {
  const expected = new Map([
    [APPLICATION_WORKFLOW.waitForPort, 80],
    [RESERVED_ARTIFACT_PORT, 3000],
  ]);
  const seen = new Set<number>();
  for (const port of ports) {
    if (seen.has(port.localPort)) {
      violations.push(
        `duplicate local port mapping ${port.localPort} — protected ports may have one owner only`,
      );
    }
    seen.add(port.localPort);
    if (expected.get(port.localPort) !== port.externalPort) {
      violations.push(
        `local port ${port.localPort} must map to its approved owner mapping, found external ${port.externalPort} — do not share protected runtime ports`,
      );
    }
  }
  for (const [localPort, externalPort] of expected) {
    if (!ports.some((port) => port.localPort === localPort && port.externalPort === externalPort)) {
      violations.push(
        `missing protected port mapping ${localPort}→${externalPort} — restore the application or Mockup Sandbox mapping`,
      );
    }
  }
}

function verifyArtifactPreview(artifactSource: string, violations: string[]): void {
  const required = [
    [`previewPath = "${ARTIFACT_PREVIEW_PATH}"`, "preview path"],
    [`name = "${ARTIFACT_SERVICE_NAME}"`, "service name"],
    [`localPort = ${RESERVED_ARTIFACT_PORT}`, "reserved port"],
    ['run = "npm run dev"', "development command"],
    [`PORT = "${RESERVED_ARTIFACT_PORT}"`, "development PORT"],
    [`BASE_PATH = "${ARTIFACT_PREVIEW_PATH}"`, "development BASE_PATH"],
  ];
  for (const [needle, label] of required) {
    if (!artifactSource.includes(needle)) {
      violations.push(
        `Mockup Sandbox ${label} must remain ${needle} — artifact preview is protected and cannot become a validation or long-control fallback`,
      );
    }
  }
  if (artifactSource.includes("validate:long") || artifactSource.includes("npm run gate")) {
    violations.push(
      "Mockup Sandbox artifact command may not run validation or long-control commands — restore its preview-only npm run dev command",
    );
  }
}

function verifySingleShellCommand(
  workflow: WorkflowEntry,
  expectedCommand: string,
  violations: string[],
): void {
  if (
    workflow.taskKinds.length !== 1 ||
    workflow.taskKinds[0] !== "shell.exec" ||
    workflow.commands.length !== 1
  ) {
    violations.push(
      `"${workflow.name}" must contain exactly one shell.exec task, found ${workflow.taskKinds.length} task(s)`,
    );
    return;
  }
  if (workflow.commands[0] !== expectedCommand) {
    violations.push(
      `"${workflow.name}" command must be "${expectedCommand}", found ${formatValue(workflow.commands[0])}`,
    );
  }
}

function formatValue(value: unknown): string {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

export function extractWorkflowTopology(replitSource: string): {
  runButton?: string;
  workflows: WorkflowEntry[];
  ports: PortMapping[];
} {
  const runButton = replitSource.match(
    /^\s*runButton\s*=\s*"([^"]+)"\s*$/m,
  )?.[1];
  const workflowBlocks = replitSource
    .split(/^\s*\[\[workflows\.workflow\]\]\s*$/m)
    .slice(1);

  return {
    runButton,
    workflows: workflowBlocks.map(parseWorkflowBlock),
    ports: extractPortMappings(replitSource),
  };
}

function extractPortMappings(replitSource: string): PortMapping[] {
  return replitSource
    .split(/^\s*\[\[ports\]\]\s*$/m)
    .slice(1)
    .flatMap((block) => {
      const localPort = Number(block.match(/^\s*localPort\s*=\s*(\d+)\s*$/m)?.[1]);
      const externalPort = Number(block.match(/^\s*externalPort\s*=\s*(\d+)\s*$/m)?.[1]);
      return Number.isFinite(localPort) && Number.isFinite(externalPort)
        ? [{ localPort, externalPort }]
        : [];
    });
}

function parseWorkflowBlock(block: string): WorkflowEntry {
  const beforeFirstSection = block.split(/^\s*\[/m, 1)[0] ?? "";
  const name = beforeFirstSection.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
  const commands: string[] = [];
  const taskKinds: string[] = [];
  const taskBlocks = block
    .split(/^\s*\[\[workflows\.workflow\.tasks\]\]\s*$/m)
    .slice(1);

  for (const taskBlock of taskBlocks) {
    const task = taskBlock.match(/^\s*task\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const args = taskBlock.match(/^\s*args\s*=\s*"([^"]*)"\s*$/m)?.[1];
    if (task) taskKinds.push(task);
    if (args !== undefined) commands.push(args);
  }

  return {
    name,
    commands,
    taskKinds,
    outputType: block.match(/^\s*outputType\s*=\s*"([^"]+)"\s*$/m)?.[1],
    waitForPort: Number(
      block.match(/^\s*waitForPort\s*=\s*(\d+)\s*$/m)?.[1],
    ) || undefined,
    isValidation:
      block.match(/^\s*isValidation\s*=\s*true\s*$/m) !== null,
    metadata: {
      owner: block.match(/^\s*owner\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "",
      purpose: block.match(/^\s*purpose\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "",
      retirementTrigger:
        block.match(/^\s*retirementTrigger\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "",
      slotBudget: block.match(/^\s*slotBudget\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "",
    },
  };
}

export function cliMain(): number {
  const { ok, message } = runLint();
  console.log(message);
  return ok ? 0 : 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-gate-workflow-drift.ts") ?? false);

if (isMain) {
  process.exit(cliMain());
}