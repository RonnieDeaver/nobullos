// Stub for server/services/googleDriveIntegration.ts (see ads-os-p6-hooks.mjs).
// The client-log reader imports getSheetsAccessToken; a pure stub keeps the
// Google JWT/token-exchange path out of the test graph. Throwing simulates
// "no Google credentials". (The module is Sheets-only since Task #4084.)

const g = (): any => ((globalThis as any).__p6 ??= {});

export async function getSheetsAccessToken(): Promise<string> {
  if (g().tokenError) throw new Error(String(g().tokenError));
  return g().sheetsToken ?? "p6-test-token";
}
