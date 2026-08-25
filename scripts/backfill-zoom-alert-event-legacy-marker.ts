/**
 * Task #1111 — Tag pre-#653 zoom-review alert events with `legacy: true`
 * so the admin UI can render a dedicated "No data — pre-#653" badge
 * instead of the generic fallback. Default dry-run; `--apply` writes.
 * Idempotent: events with channel data or an existing legacy marker
 * are skipped.
 */

import { storage } from "../server/storage";

const SETTING_KEY = "zoom_review_alert_event_history";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/backfill-zoom-alert-event-legacy-marker.ts [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

interface RawEvent {
  type?: unknown;
  at?: unknown;
  slack?: unknown;
  email?: unknown;
  inApp?: unknown;
  legacy?: unknown;
  [k: string]: unknown;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const row = await storage.getSystemSetting(SETTING_KEY);
  if (!row?.value) {
    console.log(`[backfill-zoom-alert-legacy] No '${SETTING_KEY}' setting found; nothing to do.`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch (err) {
    console.error(`[backfill-zoom-alert-legacy] Failed to parse '${SETTING_KEY}': ${errMessage(err)}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(
      `[backfill-zoom-alert-legacy] Expected an array under '${SETTING_KEY}', got ${typeof parsed}; refusing to mutate.`,
    );
    process.exit(1);
  }

  const arr = parsed as RawEvent[];
  const candidates: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || typeof e !== "object") continue;
    const hasChannelData = !!(e.slack || e.email || e.inApp);
    const alreadyLegacy = e.legacy === true;
    if (!hasChannelData && !alreadyLegacy) candidates.push(i);
  }

  console.log(
    `[backfill-zoom-alert-legacy] Scanned ${arr.length} event(s); ${candidates.length} need the legacy marker.`,
  );

  if (candidates.length === 0) {
    console.log(`[backfill-zoom-alert-legacy] Nothing to do.`);
    return;
  }

  for (const idx of candidates) {
    const e = arr[idx];
    const at = typeof e.at === "string" ? e.at : "(no timestamp)";
    const type = typeof e.type === "string" ? e.type : "(no type)";
    console.log(`  - [${idx}] ${type} @ ${at}`);
  }

  if (!args.apply) {
    console.log(
      `[backfill-zoom-alert-legacy] Dry-run. Would tag ${candidates.length} event(s). Re-run with --apply to write.`,
    );
    return;
  }

  for (const idx of candidates) {
    arr[idx].legacy = true;
  }

  await storage.setSystemSetting(SETTING_KEY, JSON.stringify(arr), "system");
  console.log(
    `[backfill-zoom-alert-legacy] Done. Tagged ${candidates.length} event(s) with legacy:true.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[backfill-zoom-alert-legacy] Fatal: ${errMessage(err)}`);
    process.exit(1);
  });
