// Setup for tests/client/confirm-dialog-client-detail-delete-report.test.tsx
// (Task #4754). Registers the shared heavy-client loader to:
//   - stub the heavy feature panels ClientDetail statically imports
//     (CommandPanel is even forceMounted; several pull in maplibre-gl /
//     @uppy/* / react-pdf / .css side-effects the bare tsx/jsdom harness
//     can't evaluate) — same set as client-detail-tab-from-url-loader.mjs;
//   - shim the Radix AlertDialog the ConfirmActionDialog renders through
//     (its Portal+Presence pair never mounts in this raw jsdom harness, so
//     without the shim the dialog's confirm/cancel buttons are never
//     queryable). The real @radix-ui/react-dialog stays un-shimmed — no
//     Dialog content is under test — which also sidesteps the
//     "shimming dialog requires shimming alert-dialog" coupling.
//   - stub @clerk/react signed-in so the REAL use-auth hook fetches
//     /api/auth/user through this suite's fetch stub (role gating — the
//     team_lead-only delete button — stays genuine).
// Passed via `--import ./tests/client/confirm-dialog-client-detail-delete-report-setup.mjs`.

import { register } from "node:module";

// Classic-JSX resilience for bare `tsx --import` repros without
// TSX_TSCONFIG_PATH (see .agents/memory/batched-classic-jsx-primitives.md).
globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["alert-dialog"],
    stubComponents: {
      ClientSchedulingPanel: [],
      IntelligenceFeed: [],
      ActionLog: [],
      CommandPanel: [],
      RawCommunicationLog: [],
      LocalDominanceDashboard: [],
      AgentProfile: [],
      MatchDecisionAudit: [],
      ClientAgentChat: [],
      DailyJudgmentStream: [],
      AgentKnowledgePanel: [],
      BillingSection: [],
      ClientMessaging: [],
    },
    stubClerk: { signedIn: true },
    stubCss: true,
  },
});
