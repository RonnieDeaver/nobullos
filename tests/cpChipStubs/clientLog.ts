// Stub for server/services/adsOs/clientLog.ts (see ads-os-cp-chip-hooks.mjs):
// the profile builder only calls sheetIdFromUrl (pure); stubbing keeps the
// real module's Drive/OpenAI import chain out of the test process.

export function sheetIdFromUrl(url: string | null | undefined): string | null {
  const m = String(url ?? "").match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
