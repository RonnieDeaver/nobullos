// Entry passed via `tsx --import` so the resolve hook in
// `parseReportPdfLoader.mjs` is registered before
// `tests/import-common-issues-formatting.test.ts` evaluates its static import
// chain through `server/routes/reports.ts` → `pdfImportParser`.
import { register } from "node:module";

register("./parseReportPdfLoader.mjs", import.meta.url);
