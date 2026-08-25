/**
 * One-off operator verification for task work: confirm the AI client-log
 * summary actually loads (state ok / no_recent / empty — never no_access)
 * for every client with a log sheet, exercising the SAME path the profile's
 * /api/ads-os/client/log-summary endpoint uses.
 *
 * For each client with a log_url:
 *   1. Print the currently cached summary state (to spot stale no_access docs).
 *   2. Call getLogSummary(name, url, force=true) — real Sheets fetch + OpenAI
 *      summarize — and print the resulting state.
 *
 * Usage: npx tsx scripts/verify-log-summaries.ts
 * Exits non-zero when one or more clients returned a stale fallback or any
 * error state (no_access/fetch_failed/...), so callers can rely on exit code.
 */
import { getClientDirectory } from "../server/services/adsOs/clickUpDirectory";
import { getLogSummary, sheetIdFromUrl } from "../server/services/adsOs/clientLog";
import { getClientLogSummary } from "../server/services/adsOs/store";

async function main() {
  const dir = await getClientDirectory({ force: true });
  const clients = Object.values(dir.clients).filter((c: any) => c.log_url) as any[];
  console.log(`Clients with a log_url: ${clients.length}\n`);

  const rows: { name: string; before: string; after: string; extra: string }[] = [];
  for (const c of clients) {
    const id = sheetIdFromUrl(c.log_url);
    const cached = id ? await getClientLogSummary(id) : null;
    const before = cached?.state ?? "(no cache)";
    let after = "?";
    let extra = "";
    try {
      const out = await getLogSummary(c.name, c.log_url, true);
      after = out.state;
      if (out.state === "ok") extra = `${out.entries?.length ?? 0} entries`;
      // A stale fallback means the FORCED refresh failed (getLogSummary
      // returns the last good cache marked stale) — that is a failure for
      // this verification, whatever the returned state says.
      if (out.stale) after = `stale (refresh failed: ${out.refresh_error ?? "?"})`;
    } catch (e: any) {
      after = `THREW: ${e?.message ?? e}`;
    }
    rows.push({ name: c.name, before, after, extra });
    console.log(`  ${c.name}: cached=${before} → force=${after} ${extra}`);
  }

  const bad = rows.filter((r) => !["ok", "no_recent", "empty"].includes(r.after));
  console.log(`\nTotal: ${rows.length}; fresh & good (ok/no_recent/empty, non-stale): ${rows.length - bad.length}`);
  if (bad.length) {
    console.log(`PROBLEMS (${bad.length}):`);
    for (const r of bad) console.log(`  ✗ ${r.name}: ${r.after}`);
    process.exitCode = 1; // machine-detectable failure
  } else {
    console.log("All summaries loaded fresh and cleanly — no no_access or stale fallbacks anywhere.");
  }
}

// Preserve process.exitCode (set to 1 on verification failure above); an
// explicit exit(0) here would mask it.
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
