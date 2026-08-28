// Entry passed via `--import` so the resolve hook in
// `onboarding-e2e-loader.mjs` is registered before bookingScheduler's
// static `import * as zoom from "./zoomIntegration"` and
// `import * as googleCalendar from "./googleCalendarIntegration"` evaluate
// (Task #5298, stage 4 of the New Client Onboarding epic).

import { register } from "node:module";

register("./onboarding-e2e-loader.mjs", import.meta.url);
