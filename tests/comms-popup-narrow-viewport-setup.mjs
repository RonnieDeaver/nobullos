// Entry passed via `tsx --import` for tests/comms-popup-narrow-viewport.test.tsx.
// Registers:
//   1. the shared heavy-client loader to stub the popup's heavy children
//      (MessagePane, Composer) and the Radix tooltip wrapper — none of them
//      matter for the width/offset layout under test;
//   2. a dedicated loader that redirects `@/contexts/CommsContext` to a tiny
//      stub the test drives via a global.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      MessagePane: ["MessagePane"],
      Composer: ["Composer"],
      tooltip: ["Tooltip", "TooltipContent", "TooltipTrigger", "TooltipProvider"],
    },
  },
});

register("./comms-popup-narrow-viewport-loader.mjs", import.meta.url);
