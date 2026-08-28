// Entry passed via `tsx --import` so the resolve hook in
// `googleAdsHygieneGaqlLoader.mjs` is registered before
// `tests/google-ads-hygiene-pacing-status-filter.test.ts` evaluates its
// static import of `computeBudgetPacing` / `fetchLsaDashboard` (which
// statically import from `googleAdsIntegration`).
import { register } from "node:module";

register("./googleAdsHygieneGaqlLoader.mjs", import.meta.url);
