/* test-registration
{
  "name": "ATS JSONB corruption operator alert — emission, per-boundary dedupe, PII-free body (Task #4184)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4184: a malformed ATS JSONB row must surface as a deduped operator alert (dedupeKey prefix ats_jsonb_malformed:<table.column>), naming the boundary and a sample job/candidate id, with NO stored-value preview or candidate PII in the body, and no dispatch at all for valid rows. Dispatcher fully stubbed, DB-free, milliseconds. A drift here re-opens the silent-corruption class the alert exists to catch (missing scores / shorter assessments no one notices).",
  "tier": "small"
}
test-registration */
/**
 * Task #4184 — the atsJsonb malformed-event seam is wired into the shared
 * notification dispatcher via server/services/atsJsonbCorruptionAlerts.ts.
 *
 * Pins:
 *   1. A malformed boundary read triggers exactly one notifyByType call with
 *      the registered id and dedupeKey `ats_jsonb_malformed:<table.column>`.
 *   2. The alert body names the table.column and the sample job/candidate id
 *      from the call site's context, and NEVER includes the stored value
 *      (which can carry candidate-supplied content) — the preview stays in
 *      the console.warn log line only.
 *   3. Per-boundary dedupe: repeated malformed reads of the SAME boundary
 *      within the re-alert window dispatch nothing further (occurrence count
 *      still increments); a DIFFERENT boundary alerts independently.
 *   4. Valid / null / missing values never touch the dispatcher.
 *   5. Under NODE_ENV=test with no injected stub the handler is inert (no
 *      real dispatcher import), so sibling suites reading malformed fixtures
 *      can't write notification_deliveries rows.
 *   6. The alert id is registered (dispatcher would record skipped_unknown_id
 *      for an unregistered id — assert against the canonical registry).
 */
import assert from "node:assert/strict";

import { readAtsAiScore, readAtsAssessmentJson, setAtsJsonbMalformedListener } from "../server/services/atsJsonb";
import {
  ATS_JSONB_ALERT_NOTIFICATION_ID,
  ATS_JSONB_ALERT_DEDUPE_PREFIX,
  installAtsJsonbCorruptionAlerts,
  handleAtsJsonbMalformedEvent,
  __setAtsJsonbAlertNotifyForTest,
  __resetAtsJsonbCorruptionAlertsForTest,
  __drainAtsJsonbAlertsForTest,
} from "../server/services/atsJsonbCorruptionAlerts";
import { NOTIFICATION_REGISTRY } from "../server/services/notifications/registry";

// A malformed stored value carrying a sentinel that must NEVER reach the
// alert body (stored values can contain candidate-supplied content).
const PII_SENTINEL = "PII_SENTINEL_jane.doe@example.com";

interface CapturedNotify {
  id: string;
  payload: { text: string };
  options: Record<string, unknown>;
}

let captured: CapturedNotify[] = [];
const notifyStub = (async (id: any, payload: any, options?: any) => {
  captured.push({ id, payload, options: options ?? {} });
  return {
    attempted: true,
    delivered: true,
    skipped: false,
    status: "sent" as const,
  };
}) as any;

function silencingWarns<T>(fn: () => T): { result: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

async function main(): Promise<void> {
  // ── 6. Alert id is registered in the canonical registry ────────────────
  const entry = NOTIFICATION_REGISTRY.find((e) => e.id === ATS_JSONB_ALERT_NOTIFICATION_ID);
  assert.ok(entry, "infra.ats.jsonb_malformed is registered");
  assert.equal(entry!.implemented, true, "registry entry is marked implemented");
  assert.equal(entry!.ownerService, "atsJsonbCorruptionAlerts");

  // ── 5. Inert by default under NODE_ENV=test (no injected stub) ─────────
  __resetAtsJsonbCorruptionAlertsForTest();
  installAtsJsonbCorruptionAlerts();
  {
    const { warns } = silencingWarns(() => readAtsAiScore("not-an-object", { candidateId: "cand-inert" }));
    assert.equal(warns.length, 1, "malformed read still logs its console warning");
    await __drainAtsJsonbAlertsForTest();
    // Nothing observable to assert beyond "no crash / no dispatcher import":
    // the stub was never installed, so there is nowhere for a call to land.
  }

  // ── 1 + 2. Emission with registered id, dedupeKey, sample id, no PII ───
  __resetAtsJsonbCorruptionAlertsForTest();
  __setAtsJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    const { result, warns } = silencingWarns(() =>
      readAtsAiScore(PII_SENTINEL, { jobId: "job-1111", candidateId: "cand-2222" }),
    );
    assert.equal(result, null, "malformed ai_score_json still falls back to null (behavior unchanged)");
    assert.equal(warns.length, 1);
    await __drainAtsJsonbAlertsForTest();

    assert.equal(captured.length, 1, "exactly one dispatch for the first malformed read");
    const call = captured[0];
    assert.equal(call.id, ATS_JSONB_ALERT_NOTIFICATION_ID);
    assert.equal(
      call.options.dedupeKey,
      `${ATS_JSONB_ALERT_DEDUPE_PREFIX}ats_candidates.ai_score_json`,
      "dedupeKey is prefix + table.column",
    );
    assert.equal(call.options.triggerSource, "alert_service");
    assert.ok(call.payload.text.includes("ats_candidates.ai_score_json"), "alert names the table.column");
    assert.ok(call.payload.text.includes("cand-2222"), "alert names the sample candidate id");
    assert.ok(call.payload.text.includes("job-1111"), "alert names the sample job id");
    const serialized = JSON.stringify(call);
    assert.ok(!serialized.includes(PII_SENTINEL), "stored value / PII never reaches the alert payload or metadata");
    const metadata = call.options.metadata as Record<string, unknown>;
    assert.equal(metadata.sampleCandidateId, "cand-2222");
    assert.equal(metadata.boundary, "ats_candidates.ai_score_json");
  }

  // ── 3a. Same boundary again within the window → no second dispatch ─────
  {
    silencingWarns(() => readAtsAiScore(42, { candidateId: "cand-3333" }));
    silencingWarns(() => readAtsAiScore([], { candidateId: "cand-4444" }));
    await __drainAtsJsonbAlertsForTest();
    assert.equal(captured.length, 1, "repeated malformed reads of the same boundary are deduped in-process");
  }

  // ── 3b. Different boundary → independent alert ──────────────────────────
  {
    const { warns } = silencingWarns(() => readAtsAssessmentJson("garbage", { jobId: "job-5555" }));
    assert.equal(warns.length, 1);
    await __drainAtsJsonbAlertsForTest();
    assert.equal(captured.length, 2, "a different table.column boundary alerts independently");
    const call = captured[1];
    assert.equal(call.options.dedupeKey, `${ATS_JSONB_ALERT_DEDUPE_PREFIX}ats_jobs.assessment_json`);
    assert.ok(call.payload.text.includes("job-5555"), "alert names the sample job id");
  }

  // ── 2b. Missing context degrades to an explicit pointer, not a crash ───
  __resetAtsJsonbCorruptionAlertsForTest();
  __setAtsJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    silencingWarns(() => readAtsAiScore("bad"));
    await __drainAtsJsonbAlertsForTest();
    assert.equal(captured.length, 1);
    assert.ok(
      captured[0].payload.text.includes("row id not captured"),
      "context-less events point the operator at the server log",
    );
  }

  // ── 4. Valid / null / missing values never dispatch ─────────────────────
  __resetAtsJsonbCorruptionAlertsForTest();
  __setAtsJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    const valid = { final_score: 88 };
    const { result, warns } = silencingWarns(() => readAtsAiScore(valid, { candidateId: "cand-ok" }));
    assert.equal(result, valid, "valid rows come back by reference, unchanged");
    silencingWarns(() => readAtsAiScore(null));
    silencingWarns(() => readAtsAiScore(undefined));
    assert.equal(warns.length, 0);
    await __drainAtsJsonbAlertsForTest();
    assert.equal(captured.length, 0, "no dispatch for valid, null, or missing values");
  }

  // ── Listener throw-safety: a broken listener never breaks the accessor ──
  {
    setAtsJsonbMalformedListener(() => {
      throw new Error("listener bug");
    });
    const { result } = silencingWarns(() => readAtsAiScore("bad"));
    assert.equal(result, null, "accessor fallback survives a throwing listener");
    // restore the real handler for any sibling suite in the same process
    setAtsJsonbMalformedListener(handleAtsJsonbMalformedEvent);
  }

  __resetAtsJsonbCorruptionAlertsForTest();
  console.log("ats-jsonb-corruption-alerts: all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
