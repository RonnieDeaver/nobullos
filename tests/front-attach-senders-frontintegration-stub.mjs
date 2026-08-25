// Stub for `server/services/frontIntegration` used ONLY by the batch
// domain-attach route test (Task #2536).
//
// The attach route (`POST /api/integrations/front/attach-senders-to-client`)
// reaches the per-row hard-match pipeline through
// `reEvaluateUnmatchedForTargets`. Driving that for real would require seeded
// clients/contacts + the full triage → hard-match → apply pipeline over real
// `front_sync_emails` rows. That is out of scope here: the GUARDRAILS the test
// pins (skip public/company domains, de-dupe already-present, report ONE
// combined total) all live in the route handler BEFORE / AROUND that call.
//
// So we re-export the real module verbatim (keeping every other binding intact
// for any transitive consumer) and override ONLY
// `reEvaluateUnmatchedForTargets` with a recording stub that:
//   - records the exact `targets` array it was handed (so the test can prove
//     public/company/invalid domains never reach re-eval), and
//   - returns a caller-configured combined `{ total, matched,
//     filterRuleHandled }` (so the test can prove the route surfaces ONE
//     combined total, not a per-domain sum).
//
// The loader (`front-attach-senders-loader.mjs`) redirects the route's
// dynamic `import("../services/frontIntegration")` here, and passes the stub's
// own `export *` re-export back through to the real module.

export * from "../server/services/frontIntegration";

export async function reEvaluateUnmatchedForTargets(targets) {
  const g =
    globalThis.__attachSendersReEval ??
    (globalThis.__attachSendersReEval = {
      calls: [],
      result: { total: 0, matched: 0, filterRuleHandled: 0 },
    });
  g.calls.push(targets);
  return g.result;
}
