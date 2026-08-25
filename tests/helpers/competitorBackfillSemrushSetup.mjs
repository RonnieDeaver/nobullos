// Entry passed via `tsx --import` so the resolve hook in
// `competitorBackfillSemrushLoader.mjs` is registered before
// `tests/competitor-structured-location-backfill-converge.test.ts`
// evaluates its static import of `getTopCompetitors` (through
// `competitorStructuredLocationBackfill` → `competitorLocationBackfill` →
// `semrushApi`).
import { register } from "node:module";

register("./competitorBackfillSemrushLoader.mjs", import.meta.url);
