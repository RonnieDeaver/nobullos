/**
 * One-off operator probe for task work: list every ClickUp client with a
 * "Paid Search Client Log" URL and check whether the Sheets service account
 * can read the sheet (shared vs no_access). Read-only; prints a checklist.
 *
 * Usage: npx tsx scripts/probe-log-sheet-access.ts
 */
import { getClientDirectory } from "../server/services/adsOs/clickUpDirectory";
import { getSheetsAccessToken } from "../server/services/googleDriveIntegration";
import { sheetIdFromUrl } from "../server/services/adsOs/clientLog";

async function main() {
  const dir = await getClientDirectory({ forceRefresh: true });
  const clients = Object.values(dir.clients).filter((c: any) => c.log_url);
  console.log(`Clients with a log_url: ${clients.length}`);
  const token = await getSheetsAccessToken();

  const results: { name: string; url: string; status: string }[] = [];
  for (const c of clients as any[]) {
    const id = sheetIdFromUrl(c.log_url);
    if (!id) {
      results.push({ name: c.name, url: c.log_url, status: "bad_url" });
      continue;
    }
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    let status: string;
    if (res.ok) status = "shared_ok";
    else if (res.status === 403) status = "no_access";
    else if (res.status === 404) status = "not_found";
    else status = `http_${res.status}`;
    results.push({ name: c.name, url: c.log_url, status });
  }

  const ok = results.filter((r) => r.status === "shared_ok");
  const bad = results.filter((r) => r.status !== "shared_ok");
  console.log(`\nShared OK (${ok.length}):`);
  for (const r of ok) console.log(`  ✓ ${r.name}`);
  console.log(`\nNeeds sharing / problem (${bad.length}):`);
  for (const r of bad) console.log(`  ✗ [${r.status}] ${r.name} — ${r.url}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
