/* test-registration
{
  "name": "Reports JSONB corruption operator alert — emission, per-boundary dedupe, PII-free body (Task #4197)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4197: a malformed reports JSONB row must surface as a deduped operator alert (dedupeKey prefix report_jsonb_malformed:<boundary>), naming the boundary and a sample report/section id, with NO stored-value preview or client content in the body, and no dispatch at all for valid rows. Dispatcher fully stubbed, DB-free, milliseconds. A drift here re-opens the silent-corruption class the alert exists to catch (empty sections / missing analyses no one notices).",
  "tier": "small"
}
test-registration */
/**
 * Task #4197 — the reportJsonbAccessors malformed-event seam is wired into
 * the shared notification dispatcher via
 * server/services/reportJsonbCorruptionAlerts.ts (mirror of the ATS suite,
 * tests/ats-jsonb-corruption-alerts.test.ts).
 *
 * Pins:
 *   1. A malformed boundary read triggers exactly one notifyByType call with
 *      the registered id and dedupeKey `report_jsonb_malformed:<boundary>`.
 *   2. The alert body names the boundary and the sample row ids from the
 *      call site's context, and NEVER includes the stored value (which can
 *      carry client content) — the preview stays in the console.warn line.
 *   3. Per-boundary dedupe: repeated malformed reads of the SAME boundary
 *      within the re-alert window dispatch nothing further; a DIFFERENT
 *      boundary alerts independently.
 *   4. Valid / null / missing values never touch the dispatcher.
 *   5. Under NODE_ENV=test with no injected stub the handler is inert.
 *   6. The alert id is registered in the canonical registry.
 */
import assert from "node:assert/strict";

import {
  readMarketingSection,
  readCeoPulseAiAnalysis,
  setReportJsonbMalformedListener,
} from "../server/lib/reportJsonbAccessors";
import {
  REPORT_JSONB_ALERT_NOTIFICATION_ID,
  REPORT_JSONB_ALERT_DEDUPE_PREFIX,
  installReportJsonbCorruptionAlerts,
  handleReportJsonbMalformedEvent,
  __setReportJsonbAlertNotifyForTest,
  __resetReportJsonbCorruptionAlertsForTest,
  __drainReportJsonbAlertsForTest,
} from "../server/services/reportJsonbCorruptionAlerts";
import { NOTIFICATION_REGISTRY } from "../server/services/notifications/registry";

// A malformed stored value carrying a sentinel that must NEVER reach the
// alert body (stored report data can contain client-supplied content).
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
  const entry = NOTIFICATION_REGISTRY.find((e) => e.id === REPORT_JSONB_ALERT_NOTIFICATION_ID);
  assert.ok(entry, "infra.reports.jsonb_malformed is registered");
  assert.equal(entry!.implemented, true, "registry entry is marked implemented");
  assert.equal(entry!.ownerService, "reportJsonbCorruptionAlerts");

  // ── 5. Inert by default under NODE_ENV=test (no injected stub) ─────────
  __resetReportJsonbCorruptionAlertsForTest();
  installReportJsonbCorruptionAlerts();
  {
    const { warns } = silencingWarns(() => readMarketingSection("not-an-object", { sectionId: "sec-inert" }));
    assert.equal(warns.length, 1, "malformed read still logs its console warning");
    await __drainReportJsonbAlertsForTest();
    // Nothing observable to assert beyond "no crash / no dispatcher import":
    // the stub was never installed, so there is nowhere for a call to land.
  }

  // ── 1 + 2. Emission with registered id, dedupeKey, sample ids, no PII ──
  __resetReportJsonbCorruptionAlertsForTest();
  __setReportJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    const { result, warns } = silencingWarns(() =>
      readMarketingSection(PII_SENTINEL, { reportId: "rep-1111", sectionId: "sec-2222", clientId: "cli-3333" }),
    );
    assert.deepEqual(result, {}, "malformed section data still falls back to {} (behavior unchanged)");
    assert.equal(warns.length, 1);
    await __drainReportJsonbAlertsForTest();

    assert.equal(captured.length, 1, "exactly one dispatch for the first malformed read");
    const call = captured[0];
    assert.equal(call.id, REPORT_JSONB_ALERT_NOTIFICATION_ID);
    assert.equal(
      call.options.dedupeKey,
      `${REPORT_JSONB_ALERT_DEDUPE_PREFIX}report_sections.data[marketing]`,
      "dedupeKey is prefix + boundary",
    );
    assert.equal(call.options.triggerSource, "alert_service");
    assert.ok(call.payload.text.includes("report_sections.data[marketing]"), "alert names the boundary");
    assert.ok(call.payload.text.includes("rep-1111"), "alert names the sample report id");
    assert.ok(call.payload.text.includes("sec-2222"), "alert names the sample section id");
    assert.ok(call.payload.text.includes("cli-3333"), "alert names the sample client id");
    const serialized = JSON.stringify(call);
    assert.ok(!serialized.includes(PII_SENTINEL), "stored value / PII never reaches the alert payload or metadata");
    const metadata = call.options.metadata as Record<string, unknown>;
    assert.equal(metadata.sampleReportId, "rep-1111");
    assert.equal(metadata.boundary, "report_sections.data[marketing]");
  }

  // ── 3a. Same boundary again within the window → no second dispatch ─────
  {
    silencingWarns(() => readMarketingSection(42, { sectionId: "sec-4444" }));
    silencingWarns(() => readMarketingSection([], { sectionId: "sec-5555" }));
    await __drainReportJsonbAlertsForTest();
    assert.equal(captured.length, 1, "repeated malformed reads of the same boundary are deduped in-process");
  }

  // ── 3b. Different boundary → independent alert ──────────────────────────
  {
    const { warns } = silencingWarns(() => readCeoPulseAiAnalysis("garbage", { ceoPulseId: "pulse-6666" }));
    assert.equal(warns.length, 1);
    await __drainReportJsonbAlertsForTest();
    assert.equal(captured.length, 2, "a different boundary alerts independently");
    const call = captured[1];
    assert.equal(call.options.dedupeKey, `${REPORT_JSONB_ALERT_DEDUPE_PREFIX}ceo_pulses.ai_analysis`);
    assert.ok(call.payload.text.includes("pulse-6666"), "alert names the sample ceo pulse id");
  }

  // ── 2b. Missing context degrades to an explicit pointer, not a crash ───
  __resetReportJsonbCorruptionAlertsForTest();
  __setReportJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    silencingWarns(() => readMarketingSection("bad"));
    await __drainReportJsonbAlertsForTest();
    assert.equal(captured.length, 1);
    assert.ok(
      captured[0].payload.text.includes("row id not captured"),
      "context-less events point the operator at the server log",
    );
  }

  // ── 4. Valid / null / missing values never dispatch ─────────────────────
  __resetReportJsonbCorruptionAlertsForTest();
  __setReportJsonbAlertNotifyForTest(notifyStub);
  captured = [];
  {
    const valid = { totalLeads: 12 };
    const { result, warns } = silencingWarns(() => readMarketingSection(valid, { sectionId: "sec-ok" }));
    assert.equal(result, valid, "valid rows come back by reference, unchanged");
    silencingWarns(() => readMarketingSection(null));
    silencingWarns(() => readMarketingSection(undefined));
    silencingWarns(() => readCeoPulseAiAnalysis(null));
    assert.equal(warns.length, 0);
    await __drainReportJsonbAlertsForTest();
    assert.equal(captured.length, 0, "no dispatch for valid, null, or missing values");
  }

  // ── Listener throw-safety: a broken listener never breaks the accessor ──
  {
    setReportJsonbMalformedListener(() => {
      throw new Error("listener bug");
    });
    const { result } = silencingWarns(() => readMarketingSection("bad"));
    assert.deepEqual(result, {}, "accessor fallback survives a throwing listener");
    // restore the real handler for any sibling suite in the same process
    setReportJsonbMalformedListener(handleReportJsonbMalformedEvent);
  }

  __resetReportJsonbCorruptionAlertsForTest();
  console.log("report-jsonb-corruption-alerts: all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
