/**
 * Drift guard: /comms must keep rendering the SHARED message components
 * (Task #3440, guarding the Task #3319 consolidation).
 *
 * Background
 * ----------
 * The chat page (client/src/pages/Comms.tsx) and the chat popups
 * (CommsPopupManager) once drifted apart because Comms.tsx kept LOCAL copies
 * of the message-rendering components. Task #3319 confirmed both surfaces now
 * render the exact same shared components from client/src/components/comms/
 * (MessagePane, MessageItem, Composer). Nothing structural prevents a future
 * change from re-declaring a local MessageItem/MessagePane/Composer inside
 * Comms.tsx — or dropping the shared imports — and silently re-opening the
 * parity gap.
 *
 * What this lint asserts
 * ----------------------
 *   1. client/src/pages/Comms.tsx imports MessagePane from
 *      "@/components/comms/MessagePane" and Composer from
 *      "@/components/comms/Composer". (MessageItem is rendered internally by
 *      the shared MessagePane, so a direct import is not required.)
 *   2. Comms.tsx declares NO local component/value named MessagePane,
 *      MessageItem, or Composer (function/const/let/var/class declarations,
 *      import-alias renames like `X as MessagePane` from a non-shared module,
 *      or a re-implementation imported from anywhere outside
 *      @/components/comms/).
 *   3. The shared component files still exist (so a rename can't silently
 *      strand this guard).
 *
 * Exit code:
 *   0 — Comms.tsx uses the shared components exclusively.
 *   1 — drift detected; the message names the offending line(s).
 *
 * Emergency escape hatch:
 *   Set LINT_COMMS_SHARED_MESSAGE_COMPONENTS_SKIP=1 to skip entirely. Use
 *   only for an intentional, reviewed restructuring of the shared components.
 */
import { existsSync, readFileSync } from "node:fs";

const COMMS_PAGE = "client/src/pages/Comms.tsx";
const SHARED_DIR = "client/src/components/comms/";
const GUARDED_NAMES = ["MessagePane", "MessageItem", "Composer"] as const;
type GuardedName = (typeof GUARDED_NAMES)[number];

/** Imports Comms.tsx MUST keep (name -> required shared module specifier). */
const REQUIRED_IMPORTS: ReadonlyArray<{ name: GuardedName; module: string }> = [
  { name: "MessagePane", module: "@/components/comms/MessagePane" },
  { name: "Composer", module: "@/components/comms/Composer" },
];

/** Shared files that must keep existing. */
const SHARED_FILES = [
  `${SHARED_DIR}MessagePane.tsx`,
  `${SHARED_DIR}MessageItem.tsx`,
  `${SHARED_DIR}Composer.tsx`,
];

interface ImportBinding {
  /** Local binding name introduced into Comms.tsx scope. */
  local: GuardedName;
  /** Module specifier it came from. */
  module: string;
  line: number;
}

/**
 * Strip comments so declarations inside them don't trip the guard. String
 * contents are left alone — the declaration regexes anchor on keywords
 * followed by an exact identifier, which won't match inside JSX text or
 * ordinary string literals in practice, and masking strings would risk the
 * regex-literal pitfall documented in the source-scanner memory.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) =>
      `${p1}${" ".repeat(m.length - (p1 as string).length)}`,
    );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * Find import statements that bind any guarded name locally, whether as a
 * named import (`import { MessagePane } from ...`), an aliased named import
 * (`import { Foo as MessagePane } from ...`), or a default/namespace import
 * (`import MessagePane from ...`).
 */
export function findGuardedImports(source: string): ImportBinding[] {
  const found: ImportBinding[] = [];
  const importRe =
    /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const clause = m[1];
    const module = m[2];
    const line = lineOf(source, m.index);
    for (const name of GUARDED_NAMES) {
      // default import: `import MessagePane from ...`
      const defaultRe = new RegExp(`^\\s*${name}\\s*(,|$)`);
      // named import (direct or via alias): `{ MessagePane }` / `{ X as MessagePane }`
      const namedRe = new RegExp(`\\{[^}]*(^|[\\s{,])${name}\\s*[,}]`);
      const aliasRe = new RegExp(`\\bas\\s+${name}\\s*[,}]`);
      // namespace import: `import * as MessagePane from ...`
      const nsRe = new RegExp(`\\*\\s*as\\s+${name}\\b`);
      if (
        defaultRe.test(clause) ||
        namedRe.test(clause) ||
        aliasRe.test(clause) ||
        nsRe.test(clause)
      ) {
        found.push({ local: name, module, line });
      }
    }
  }
  return found;
}

interface LocalDeclaration {
  name: GuardedName;
  kind: string;
  line: number;
}

/** Find local declarations of any guarded name (function/const/let/var/class). */
export function findLocalDeclarations(source: string): LocalDeclaration[] {
  const found: LocalDeclaration[] = [];
  for (const name of GUARDED_NAMES) {
    const declRe = new RegExp(
      `\\b(function|const|let|var|class)\\s+${name}\\b`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(source)) !== null) {
      found.push({ name: name as GuardedName, kind: m[1], line: lineOf(source, m.index) });
    }
  }
  return found;
}

interface LintResult {
  ok: boolean;
  errors: string[];
}

export interface LintOptions {
  /** Fixture mode: lint this source text instead of reading COMMS_PAGE. */
  sourceOverride?: string;
  /** Fixture mode: skip the shared-file existence check. */
  skipSharedFileCheck?: boolean;
}

export function runLint(opts: LintOptions = {}): LintResult {
  const errors: string[] = [];

  if (!opts.skipSharedFileCheck) {
    for (const f of SHARED_FILES) {
      if (!existsSync(f)) {
        errors.push(
          `${f} is missing — the shared comms message components were moved or deleted. ` +
            `Update this lint AND every consumer (Comms.tsx + CommsPopupManager) together.`,
        );
      }
    }
  }

  let raw: string;
  if (opts.sourceOverride !== undefined) {
    raw = opts.sourceOverride;
  } else {
    try {
      raw = readFileSync(COMMS_PAGE, "utf8");
    } catch (err) {
      return {
        ok: false,
        errors: [
          ...errors,
          `could not read ${COMMS_PAGE}: ${(err as Error).message}`,
        ],
      };
    }
  }

  const source = stripComments(raw);
  const imports = findGuardedImports(source);

  // 1. Required shared imports present.
  for (const req of REQUIRED_IMPORTS) {
    const hit = imports.find(
      (i) => i.local === req.name && i.module === req.module,
    );
    if (!hit) {
      errors.push(
        `${COMMS_PAGE} no longer imports ${req.name} from "${req.module}" — ` +
          `the chat page must render the SAME shared component as the chat popups.`,
      );
    }
  }

  // 2. No guarded name bound from a non-shared module.
  for (const imp of imports) {
    if (!imp.module.startsWith("@/components/comms/")) {
      errors.push(
        `${COMMS_PAGE} line ${imp.line}: "${imp.local}" is imported from "${imp.module}" — ` +
          `MessagePane/MessageItem/Composer must only come from @/components/comms/.`,
      );
    }
  }

  // 3. No local re-declarations.
  for (const decl of findLocalDeclarations(source)) {
    errors.push(
      `${COMMS_PAGE} line ${decl.line}: local \`${decl.kind} ${decl.name}\` declaration — ` +
        `this re-opens the page-vs-popup drift bug. Extend the shared component in ` +
        `client/src/components/comms/${decl.name}.tsx instead.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

export function cliMain(): number {
  if (process.env.LINT_COMMS_SHARED_MESSAGE_COMPONENTS_SKIP === "1") {
    console.log(
      "lint-comms-shared-message-components: SKIPPED (LINT_COMMS_SHARED_MESSAGE_COMPONENTS_SKIP=1)",
    );
    return 0;
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-comms-shared-message-components: the chat page drifted from the shared comms message components",
    );
    console.error("");
    console.error(
      "  /comms and the chat popups must render the SAME MessagePane/MessageItem/Composer",
    );
    console.error(
      "  from client/src/components/comms/ (the Task #3319 consolidation). Findings:",
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (intentional reviewed restructuring only): LINT_COMMS_SHARED_MESSAGE_COMPONENTS_SKIP=1.",
    );
    console.error("");
    return 1;
  }

  console.log(
    "lint-comms-shared-message-components: OK (Comms.tsx imports shared MessagePane/Composer; no local MessagePane/MessageItem/Composer declarations)",
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-comms-shared-message-components.ts");

if (isMain) {
  process.exit(cliMain());
}
