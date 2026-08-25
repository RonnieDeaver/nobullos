// Task #2120 — entry passed via `tsx --import` so the resolve hook in
// `frontAutoClosureEscalationRecoveryLoader.mjs` is registered before
// `tests/front-auto-closure-escalation-e2e.test.ts` evaluates the
// tick's dynamic import of `frontHistoricalRecovery`.

import { register } from "node:module";

register("./frontAutoClosureEscalationRecoveryLoader.mjs", import.meta.url);
