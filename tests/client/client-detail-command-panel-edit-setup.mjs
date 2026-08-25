// Setup for the ClientDetail → CommandPanel "Edit client details" regression
// mount. Keep the real ClientDetail, CommandPanel, edit dialog, and mutation;
// stub only unrelated heavy sibling panels and CommandPanel's PDF leaf.

import { register } from "node:module";

globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dialog", "alert-dialog"],
    stubComponents: {
      ClientSchedulingPanel: [],
      IntelligenceFeed: [],
      ActionLog: [],
      RawCommunicationLog: [],
      LocalDominanceDashboard: [],
      AgentProfile: [],
      MatchDecisionAudit: [],
      ClientAgentChat: [],
      DailyJudgmentStream: [],
      AgentKnowledgePanel: [],
      BillingSection: [],
      ClientMessaging: [],
      PdfPreviewWithSearch: [],
    },
    stubClerk: { signedIn: true },
    stubCss: true,
  },
});

// The edit flow must select a new Consult Type, so use the established
// interactive Select shim rather than the render-only shared Select shim.
register("../doc-share-dialog-loader.mjs", import.meta.url);