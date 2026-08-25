// Entry passed via `tsx --import` so the resolve hook in
// `atsUnifiedOpenAiLoader.mjs` is registered before
// `tests/ats-unified-reeval-failure-run.test.ts` (and its static import chain
// through `server/services/atsUnifiedScoring.ts`) resolves the OpenAI
// adapter module.
import { register } from "node:module";

register("./atsUnifiedOpenAiLoader.mjs", import.meta.url);
