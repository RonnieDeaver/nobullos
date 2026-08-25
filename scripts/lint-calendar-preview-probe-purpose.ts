/**
 * Task #2403 — Call-site guard so a route handler can't accidentally drop the
 * non-authoritative `calendarRefreshPurpose: "probe"` tag from a Google
 * Calendar availability PREVIEW, and so a booking WRITE path can't accidentally
 * tag itself non-authoritative.
 *
 * Background (durable rules:
 *   .agents/memory/oauth-probe-refresh-no-wipe.md,
 *   .agents/memory/credential-detection-absent-vs-unknown.md):
 * Google Calendar is per-user OAuth with a rotating refresh token. Tasks
 * #2286 / #2358 made every terminal-disconnect decision flow through
 * `isAuthoritativeRefreshPurpose(purpose)` (in
 * `server/services/oauthRefresh.ts`): a refresh tagged with a NON-authoritative
 * purpose (e.g. `"probe"`) that hits a terminal `invalid_grant` from a
 * rotation race must NOT durably disconnect the still-valid calendar, while an
 * authoritative on-demand write path SHOULD surface the disconnect.
 *
 * The availability-PREVIEW routes (read-only slot listings) must therefore tag
 * their busy lookup `probe`, and the booking-saga WRITE path
 * (`isSlotAvailable`) must NOT — it is the authoritative confirm-the-slot read.
 *
 * The behavior test (`tests/booking-calendar-probe-purpose.test.ts`) infers the
 * purpose indirectly from whether a disconnect was written; the sibling
 * `lint-probe-refresh-purpose` enforces the integration-side invariants. This
 * lint closes the remaining gap by asserting the invariant LITERALLY at the
 * call site, so a regression is caught even if the behavioral seam changes:
 *
 *   PREVIEW sites — every `computeAvailableSlots(...)` call in
 *     `server/routes/booking.ts` MUST pass a `calendarRefreshPurpose` whose
 *     value is a string literal the real classifier treats as
 *     NON-authoritative (forgetting the tag, passing a dynamic value the lint
 *     can't verify, or passing an authoritative value all fail). At least
 *     `PREVIEW_MIN_CALLS` such calls must exist, so deleting/renaming a route
 *     can't silently pass the guard.
 *
 *   WRITE sites — every `isSlotAvailable(...)` call in
 *     `server/services/bookingScheduler.ts` MUST NOT pass a non-authoritative
 *     `calendarRefreshPurpose`: it may omit the option entirely (preferred) or
 *     pass an authoritative literal. A non-authoritative or dynamic value
 *     fails. At least `WRITE_MIN_CALLS` such calls must exist.
 *
 * The real `isAuthoritativeRefreshPurpose` is imported so this guard's notion
 * of "authoritative" can never drift from production behavior.
 *
 * Exit codes: 0 ok, 1 if any rule is violated.
 *
 * Usage: npx tsx scripts/lint-calendar-preview-probe-purpose.ts
 */
import { readFileSync } from "node:fs";
import { isAuthoritativeRefreshPurpose } from "../server/services/oauthRefresh";

// Scope intentionally fixed (Task #2846): this lint checks an enumerated set
// of known preview/authoritative call sites (specs below), not a repo-wide
// scan; new call sites must be added to the spec lists deliberately.
const PURPOSE_KEY = "calendarRefreshPurpose";

/**
 * PREVIEW (read-only) availability call sites. Every call to `fn` in `file`
 * must pass a NON-authoritative `calendarRefreshPurpose` string literal.
 */
export interface PreviewSpec {
  file: string;
  fn: string;
  minCalls: number;
}

/**
 * WRITE (authoritative) availability call sites. Every call to `fn` in `file`
 * must NOT pass a non-authoritative `calendarRefreshPurpose` (omit it, or pass
 * an authoritative literal).
 */
export interface WriteSpec {
  file: string;
  fn: string;
  minCalls: number;
}

export const PREVIEW_SPECS: readonly PreviewSpec[] = [
  // The three booking availability-preview routes (AM preview, public booking
  // page, parameterized slot preview). Read-only — must tag `probe`.
  { file: "server/routes/booking.ts", fn: "computeAvailableSlots", minCalls: 3 },
];

export const WRITE_SPECS: readonly WriteSpec[] = [
  // The booking saga re-validates the slot twice (pre-lock + post-lock TOCTOU
  // guard) just before insert. This is the authoritative confirm read — it
  // must NOT tag itself non-authoritative.
  { file: "server/services/bookingScheduler.ts", fn: "isSlotAvailable", minCalls: 2 },
];

export interface Violation {
  file: string;
  reason: string;
}

/**
 * Returns the index just past the `(` that opens the argument list of `fn` at
 * each call site, paired with the index of the matching `)`. String, template,
 * and comment content is skipped so braces/parens inside them don't confuse the
 * balancer.
 */
function findCallArgs(src: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1; // index of '('
    const close = matchParen(src, open);
    if (close < 0) continue;
    out.push(src.slice(open + 1, close));
    re.lastIndex = close + 1;
  }
  return out;
}

/**
 * Given the index of an opening `(`, returns the index of the matching `)`,
 * skipping string/template/comment content. Returns -1 if unbalanced.
 */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // Line comment.
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    // Block comment.
    if (ch === "/" && src[i + 1] === "*") {
      const endC = src.indexOf("*/", i + 2);
      if (endC < 0) return -1;
      i = endC + 2;
      continue;
    }
    // String / template literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i, ch);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Given the index of an opening quote `q`, returns the index just past the
 * closing quote. Handles backslash escapes; for template literals it does NOT
 * recurse into `${...}` (good enough — purpose values are plain string
 * literals, not template interpolations).
 */
function skipString(src: string, start: number, q: string): number {
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === q) return i + 1;
    i++;
  }
  return n;
}

/**
 * Extracts the `calendarRefreshPurpose` value from an argument-list slice.
 * Returns:
 *   - { present: false } if the key is absent.
 *   - { present: true, literal: "<value>" } if it's a string literal.
 *   - { present: true, literal: null } if present but NOT a plain string
 *     literal (dynamic — a variable, ternary, function call, etc.).
 */
function readPurpose(args: string): { present: boolean; literal: string | null } {
  const keyRe = new RegExp(`${PURPOSE_KEY}\\s*:`);
  if (!keyRe.test(args)) return { present: false, literal: null };
  const litRe = new RegExp(`${PURPOSE_KEY}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`);
  const m = litRe.exec(args);
  if (m) return { present: true, literal: m[1] };
  return { present: true, literal: null };
}

/**
 * Core, importable for tests. Scans the configured call sites and returns every
 * violation. Pure aside from filesystem reads of the configured files.
 */
export function runLint(opts?: {
  previewSpecs?: readonly PreviewSpec[];
  writeSpecs?: readonly WriteSpec[];
  readFile?: (file: string) => string;
}): { ok: boolean; checked: number; violations: Violation[] } {
  const previewSpecs = opts?.previewSpecs ?? PREVIEW_SPECS;
  const writeSpecs = opts?.writeSpecs ?? WRITE_SPECS;
  const read = opts?.readFile ?? ((f: string) => readFileSync(f, "utf8"));

  const violations: Violation[] = [];
  let checked = 0;

  for (const spec of previewSpecs) {
    let src: string;
    try {
      src = read(spec.file);
    } catch {
      violations.push({
        file: spec.file,
        reason: `PREVIEW spec points at a file that cannot be read — fix the path in lint-calendar-preview-probe-purpose.ts.`,
      });
      continue;
    }
    const calls = findCallArgs(src, spec.fn);
    if (calls.length < spec.minCalls) {
      violations.push({
        file: spec.file,
        reason:
          `expected at least ${spec.minCalls} \`${spec.fn}(...)\` preview call(s) but found ${calls.length}. ` +
          `If a preview route was removed/renamed, update PREVIEW_SPECS and re-verify the busy lookups still tag a non-authoritative ${PURPOSE_KEY}.`,
      });
    }
    calls.forEach((args, idx) => {
      checked++;
      const p = readPurpose(args);
      if (!p.present) {
        violations.push({
          file: spec.file,
          reason:
            `\`${spec.fn}(...)\` preview call #${idx + 1} does not pass ${PURPOSE_KEY}. ` +
            `A non-authoritative read MUST tag its calendar busy lookup (e.g. ${PURPOSE_KEY}: "probe") ` +
            `so a transient auth blip can't durably disconnect a still-valid calendar.`,
        });
        return;
      }
      if (p.literal === null) {
        violations.push({
          file: spec.file,
          reason:
            `\`${spec.fn}(...)\` preview call #${idx + 1} passes a non-literal ${PURPOSE_KEY} — ` +
            `the guard can't statically prove it is non-authoritative. Use a string literal (e.g. "probe").`,
        });
        return;
      }
      if (isAuthoritativeRefreshPurpose(p.literal)) {
        violations.push({
          file: spec.file,
          reason:
            `\`${spec.fn}(...)\` preview call #${idx + 1} passes ${PURPOSE_KEY}: "${p.literal}", which ` +
            `isAuthoritativeRefreshPurpose() classifies AUTHORITATIVE — a preview read must use a ` +
            `non-authoritative purpose (e.g. one containing "probe" or "proactive").`,
        });
      }
    });
  }

  for (const spec of writeSpecs) {
    let src: string;
    try {
      src = read(spec.file);
    } catch {
      violations.push({
        file: spec.file,
        reason: `WRITE spec points at a file that cannot be read — fix the path in lint-calendar-preview-probe-purpose.ts.`,
      });
      continue;
    }
    const calls = findCallArgs(src, spec.fn);
    if (calls.length < spec.minCalls) {
      violations.push({
        file: spec.file,
        reason:
          `expected at least ${spec.minCalls} \`${spec.fn}(...)\` write call(s) but found ${calls.length}. ` +
          `If the saga re-check changed, update WRITE_SPECS and re-verify the write path stays authoritative.`,
      });
    }
    calls.forEach((args, idx) => {
      checked++;
      const p = readPurpose(args);
      if (!p.present) return; // omitting the option is the authoritative default — good.
      if (p.literal === null) {
        violations.push({
          file: spec.file,
          reason:
            `\`${spec.fn}(...)\` write call #${idx + 1} passes a non-literal ${PURPOSE_KEY} — ` +
            `the authoritative write path must not risk a non-authoritative tag. Omit the option, or pass an authoritative string literal.`,
        });
        return;
      }
      if (!isAuthoritativeRefreshPurpose(p.literal)) {
        violations.push({
          file: spec.file,
          reason:
            `\`${spec.fn}(...)\` write call #${idx + 1} passes ${PURPOSE_KEY}: "${p.literal}", which is ` +
            `NON-authoritative. The booking-saga confirm read is authoritative — omit ${PURPOSE_KEY} ` +
            `(preferred) or pass an authoritative purpose so a real disconnect surfaces.`,
        });
      }
    });
  }

  return { ok: violations.length === 0, checked, violations };
}

export function cliMain(): number {
  const { ok, checked, violations } = runLint();
  if (ok) {
    console.log(
      `lint-calendar-preview-probe-purpose: OK (${checked} call site(s) checked, ` +
        `${PREVIEW_SPECS.length} preview spec(s), ${WRITE_SPECS.length} write spec(s))`,
    );
    return 0;
  }
  console.error(
    `lint-calendar-preview-probe-purpose: ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error(
    `\nSee the header of scripts/lint-calendar-preview-probe-purpose.ts and ` +
      `server/services/oauthRefresh.ts (isAuthoritativeRefreshPurpose).`,
  );
  return 1;
}

// Only run when invoked directly (not when imported by the test).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /lint-calendar-preview-probe-purpose\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  process.exit(cliMain());
}
