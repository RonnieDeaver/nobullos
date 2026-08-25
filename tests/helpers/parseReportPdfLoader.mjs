// Node ESM resolve hook that redirects every import of
// `server/services/pdfImportParser` to the in-memory stub
// (`parseReportPdfStub.mjs`) so the import-path Common Issues formatting
// integration test can drive `parseReportPdf` deterministically without
// extracting a real PDF. Registered via
// `--import ./tests/helpers/parseReportPdfSetup.mjs` so it is active before
// the test file (and its static import chain through
// `server/routes/reports.ts` → `pdfImportParser`) evaluates.
//
// The stub itself re-exports the REAL `pdfImportParser`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./parseReportPdfStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/pdfImportParser\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
