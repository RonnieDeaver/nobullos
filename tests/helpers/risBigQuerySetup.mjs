// Entry passed via `tsx --import` so the resolve hook in
// `risBigQueryLoader.mjs` is registered before
// `tests/ris-auto-pull-safety.test.ts` evaluates its static import of
// `runRisAutoPull` (which statically imports from `bigQueryClient`).
import { register } from "node:module";

register("./risBigQueryLoader.mjs", import.meta.url);
