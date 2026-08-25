// Stub for `server/services/pdfImportParser` used by the import-path Common
// Issues formatting integration test
// (`tests/import-common-issues-formatting.test.ts`).
//
// The webhook auto-draft import route reaches the PDF parser through a STATIC
// `import { parseReportPdf } from "../services/pdfImportParser"` in
// `server/routes/reports.ts`. ESM named exports are immutable, so we cannot
// monkey-patch `parseReportPdf` at runtime; instead the companion resolve hook
// (`parseReportPdfLoader.mjs`) redirects every import of `pdfImportParser` to
// THIS module.
//
// We re-export the REAL module untouched (so `isEmptySectionBody`,
// `isAiRewrittenMissingDataSourceFinding`, `resolveCommonIssuesOnReimport`,
// and every other binding any importer in the process needs — including the
// shared `commonIssuesFormatter` placeholder guards — keep their real
// implementations) and override ONLY `parseReportPdf` with a test-configurable
// impl. The loader passes through the stub's own re-export of the real module
// (it keys on `context.parentURL`) so this does not redirect onto itself.
//
// The test file imports THIS path directly to configure the impl; the
// production code path resolves to the same singleton via the hook, so the
// configured parsed payload is observed by the webhook import route.
export * from "../../server/services/pdfImportParser";

let impl = null;

export async function parseReportPdf(buffer) {
  if (typeof impl !== "function") {
    throw new Error(
      "[parseReportPdfStub] parseReportPdf called but no impl configured — call __setParseReportPdf first",
    );
  }
  return impl(buffer);
}

/**
 * Set the function backing the stubbed `parseReportPdf`. It receives the raw
 * PDF buffer and must resolve to a parsed-report payload (at minimum
 * `{ intake, sales, marketing }`).
 */
export function __setParseReportPdf(fn) {
  impl = fn;
}

export function __resetParseReportPdf() {
  impl = null;
}
