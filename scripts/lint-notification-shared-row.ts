/**
 * Drift guard: the bell dropdown and the /notifications page must keep
 * rendering the SHARED NotificationRow (Task #4514, guarding the Task #4473
 * consolidation).
 *
 * Background
 * ----------
 * The bell dropdown (client/src/components/NotificationBell.tsx) and the
 * /notifications inbox page (client/src/pages/Notifications.tsx) once kept
 * separate copies of the notification row JSX and drifted visually. Task
 * #4473 extracted the shared NotificationRow component
 * (client/src/components/NotificationRow.tsx) so both surfaces render the
 * exact same markup. Nothing structural prevents a future edit from
 * re-declaring a local NotificationRow inside either surface — or dropping
 * the shared import — and silently re-opening the parity gap. This is the
 * sibling of scripts/lint-comms-shared-message-components.ts for the
 * notification surfaces.
 *
 * What this lint asserts
 * ----------------------
 *   1. Both surface files import NotificationRow from
 *      "@/components/NotificationRow".
 *   2. Both surface files actually RENDER the shared binding (a
 *      `<NotificationRow` JSX usage after comment stripping) — a retained
 *      but unused import with a differently-named local replacement fails.
 *   3. Neither surface declares a local component/value named
 *      NotificationRow (function/const/let/var/class declarations, or an
 *      import binding of that name from any other module, including alias
 *      renames like `X as NotificationRow` and namespace imports).
 *   4. The shared component file still exists (so a rename can't silently
 *      strand this guard).
 *
 * Exit code:
 *   0 — both surfaces use the shared NotificationRow exclusively.
 *   1 — drift detected; the message names the offending line(s).
 *
 * Emergency escape hatch:
 *   Set LINT_NOTIFICATION_SHARED_ROW_SKIP=1 to skip entirely. Use only for
 *   an intentional, reviewed restructuring of the shared component.
 */
import { existsSync, readFileSync } from "node:fs";

const GUARDED_NAME = "NotificationRow";
const SHARED_MODULE = "@/components/NotificationRow";
const SHARED_FILE = "client/src/components/NotificationRow.tsx";

/** Surfaces that must render the shared row. */
export const SURFACE_FILES = [
  "client/src/components/NotificationBell.tsx",
  "client/src/pages/Notifications.tsx",
] as const;

interface ImportBinding {
  module: string;
  line: number;
}

/**
 * Strip comments so declarations inside them don't trip the guard. String
 * contents are left alone — the declaration regexes anchor on keywords
 * followed by the exact identifier, which won't match inside JSX text or
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
 * Find import statements that bind NotificationRow locally, whether as a
 * named import (`import { NotificationRow } from ...`), an aliased named
 * import (`import { Foo as NotificationRow } from ...`), a default import
 * (`import NotificationRow from ...`), or a namespace import
 * (`import * as NotificationRow from ...`).
 */
export function findGuardedImports(source: string): ImportBinding[] {
  const found: ImportBinding[] = [];
  const importRe = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const clause = m[1];
    const module = m[2];
    const line = lineOf(source, m.index);
    // default import: `import NotificationRow from ...`
    const defaultRe = new RegExp(`^\\s*${GUARDED_NAME}\\s*(,|$)`);
    // named import (direct or via alias): `{ NotificationRow }` / `{ X as NotificationRow }`
    const namedRe = new RegExp(`\\{[^}]*(^|[\\s{,])${GUARDED_NAME}\\s*[,}]`);
    const aliasRe = new RegExp(`\\bas\\s+${GUARDED_NAME}\\s*[,}]`);
    // namespace import: `import * as NotificationRow from ...`
    const nsRe = new RegExp(`\\*\\s*as\\s+${GUARDED_NAME}\\b`);
    if (
      defaultRe.test(clause) ||
      namedRe.test(clause) ||
      aliasRe.test(clause) ||
      nsRe.test(clause)
    ) {
      found.push({ module, line });
    }
  }
  return found;
}

interface LocalDeclaration {
  kind: string;
  line: number;
}

/** Find local declarations of NotificationRow (function/const/let/var/class). */
export function findLocalDeclarations(source: string): LocalDeclaration[] {
  const found: LocalDeclaration[] = [];
  const declRe = new RegExp(
    `\\b(function|const|let|var|class)\\s+${GUARDED_NAME}\\b`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    found.push({ kind: m[1], line: lineOf(source, m.index) });
  }
  return found;
}

interface LintResult {
  ok: boolean;
  errors: string[];
}

export interface LintOptions {
  /** Fixture mode: lint these source texts (keyed by surface path) instead of reading from disk. */
  sourceOverrides?: Partial<Record<(typeof SURFACE_FILES)[number], string>>;
  /** Fixture mode: skip the shared-file existence check. */
  skipSharedFileCheck?: boolean;
}

export function runLint(opts: LintOptions = {}): LintResult {
  const errors: string[] = [];

  if (!opts.skipSharedFileCheck) {
    if (!existsSync(SHARED_FILE)) {
      errors.push(
        `${SHARED_FILE} is missing — the shared notification row component was moved or deleted. ` +
          `Update this lint AND both consumers (NotificationBell.tsx + Notifications.tsx) together.`,
      );
    }
  }

  for (const surface of SURFACE_FILES) {
    let raw: string;
    const override = opts.sourceOverrides?.[surface];
    if (override !== undefined) {
      raw = override;
    } else {
      try {
        raw = readFileSync(surface, "utf8");
      } catch (err) {
        errors.push(`could not read ${surface}: ${(err as Error).message}`);
        continue;
      }
    }

    const source = stripComments(raw);
    const imports = findGuardedImports(source);

    // 1. Required shared import present.
    const hit = imports.find((i) => i.module === SHARED_MODULE);
    if (!hit) {
      errors.push(
        `${surface} no longer imports ${GUARDED_NAME} from "${SHARED_MODULE}" — ` +
          `the bell dropdown and the /notifications page must render the SAME shared row.`,
      );
    }

    // 2. The shared binding is actually RENDERED — a retained-but-unused
    // import with a differently named local replacement must fail.
    const rendersShared = new RegExp(`<${GUARDED_NAME}[\\s/>]`).test(source);
    if (hit && !rendersShared) {
      errors.push(
        `${surface} imports ${GUARDED_NAME} but never renders <${GUARDED_NAME}> — ` +
          `the rows must be rendered THROUGH the shared component, not a local replacement.`,
      );
    }

    // 3. No NotificationRow bound from a non-shared module.
    for (const imp of imports) {
      if (imp.module !== SHARED_MODULE) {
        errors.push(
          `${surface} line ${imp.line}: "${GUARDED_NAME}" is imported from "${imp.module}" — ` +
            `NotificationRow must only come from ${SHARED_MODULE}.`,
        );
      }
    }

    // 4. No local re-declarations.
    for (const decl of findLocalDeclarations(source)) {
      errors.push(
        `${surface} line ${decl.line}: local \`${decl.kind} ${GUARDED_NAME}\` declaration — ` +
          `this re-opens the bell-vs-page drift bug. Extend the shared component in ` +
          `${SHARED_FILE} instead.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function cliMain(): number {
  if (process.env.LINT_NOTIFICATION_SHARED_ROW_SKIP === "1") {
    console.log(
      "lint-notification-shared-row: SKIPPED (LINT_NOTIFICATION_SHARED_ROW_SKIP=1)",
    );
    return 0;
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-notification-shared-row: a notification surface drifted from the shared NotificationRow",
    );
    console.error("");
    console.error(
      "  The bell dropdown and /notifications must render the SAME NotificationRow",
    );
    console.error(
      `  from ${SHARED_FILE} (the Task #4473 consolidation). Findings:`,
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (intentional reviewed restructuring only): LINT_NOTIFICATION_SHARED_ROW_SKIP=1.",
    );
    console.error("");
    return 1;
  }

  console.log(
    "lint-notification-shared-row: OK (NotificationBell.tsx + Notifications.tsx import the shared NotificationRow; no local declarations)",
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-notification-shared-row.ts");

if (isMain) {
  process.exit(cliMain());
}
