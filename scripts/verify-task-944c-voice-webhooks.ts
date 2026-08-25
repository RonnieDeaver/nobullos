/**
 * Task #944C verification harness.
 *
 * End-to-end verification of the browser-outbound voice chain:
 *
 *   1. Each hop returns HTTP 200 + a valid `<Response>...</Response>` so
 *      Twilio never plays its default error voice.
 *   2. The `[Twilio Voice] entry|exit` log lines added in 944C are emitted
 *      for each hop with the expected shape (callSid, signature result,
 *      status code, elapsedMs, hop-specific tail tags).
 *   3. The chain has the expected DB side effects:
 *        a. voice-twiml-browser → recordBrowserOutboundCall inserts a
 *           twilio_calls row keyed by twilio_sid.
 *        b. voice-twiml-browser-dial-status → handleCallStatus updates
 *           that row's status + duration.
 *        c. recording-status writes recording_sid / recording_url /
 *           recording_status / recording_duration / recording_channels
 *           and hands off to the archive pipeline (archive_status moves
 *           past the initial 'pending').
 *   4. The negative-signature path (bogus X-Twilio-Signature against the
 *      configured token) returns HTTP 200 + the friendly fallback TwiML
 *      and logs `fallback_twiml=true category=invalid_signature ...`.
 *
 * Setup is fully self-cleaning: the script snapshots the prior values of
 * `twilio_account_sid` / `twilio_auth_token` / `twilio_phone_numbers`,
 * installs a fake config (so getTwilioConfig returns non-null and signs
 * succeed), then restores the snapshot on exit.
 *
 * Run: `tsx scripts/verify-task-944c-voice-webhooks.ts` with the dev
 * server up on PORT 5000.
 */
import { sql } from "drizzle-orm";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

import { db } from "../server/db";
import { systemSettings, twilioCalls, users } from "@shared/schema";
import { eq } from "drizzle-orm";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:5000";
const FAKE_TOKEN = "verify_944c_temporary_token";
const FAKE_SID = "ACverify944ctemporaryaccountsid000";
// Mirrors the URL the server's signature middleware reconstructs:
//   `${x-forwarded-proto || 'https'}://${host}${originalUrl}`.
const SIG_URL_BASE = "https://localhost:5000";

interface HopResult {
  label: string;
  hop: string;
  statusCode: number;
  bodyExcerpt: string;
  ok: boolean;
}

interface AssertionResult {
  name: string;
  ok: boolean;
  detail: string;
}
const assertions: AssertionResult[] = [];
function assert(name: string, ok: boolean, detail: string) {
  assertions.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} :: ${detail}`);
}

function signedHeaders(targetUrl: string, params: Record<string, string>): Record<string, string> {
  const expected = getExpectedTwilioSignature(FAKE_TOKEN, targetUrl, params);
  return { "X-Twilio-Signature": expected };
}

async function postForm(
  label: string,
  hopPath: string,
  body: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<HopResult> {
  const params = new URLSearchParams(body);
  const res = await fetch(`${BASE}${hopPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: params.toString(),
  });
  const text = await res.text();
  return {
    label,
    hop: hopPath,
    statusCode: res.status,
    bodyExcerpt: text.replace(/\s+/g, " ").trim().slice(0, 1500),
    ok: res.status === 200 && text.includes("<Response"),
  };
}

async function setSystemSetting(key: string, value: string) {
  await db.execute(sql`
    INSERT INTO system_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}
async function deleteSystemSetting(key: string) {
  await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`);
}
async function readSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return rows[0]?.value ?? null;
}

async function run(): Promise<void> {
  const startMs = Date.now();
  const callSid = `CAVERIFY944C${startMs}`;
  const recordingSid = `RE944C${startMs}`;
  console.log(`\nVerification CallSid=${callSid} RecordingSid=${recordingSid}\n`);

  // Snapshot + install fake config so getTwilioConfig returns non-null and
  // the signature middleware actually validates (lets us prove the
  // healthy-path entry log shows signature="valid").
  const snapshot = {
    sid: await readSetting("twilio_account_sid"),
    token: await readSetting("twilio_auth_token"),
    phones: await readSetting("twilio_phone_numbers"),
  };
  await setSystemSetting("twilio_account_sid", FAKE_SID);
  await setSystemSetting("twilio_auth_token", FAKE_TOKEN);
  await setSystemSetting("twilio_phone_numbers", JSON.stringify(["+15550000000"]));

  // Pick any real user id so recordBrowserOutboundCall doesn't trip the FK.
  const [realUserRow] = await db.select({ id: users.id }).from(users).limit(1);
  const realUserId = realUserRow?.id;
  if (!realUserId) throw new Error("No users in DB to back the test From=client:<userId>");
  console.log(`  using real user id ${realUserId} as test caller\n`);

  const sign = (hopPath: string, params: Record<string, string>) =>
    signedHeaders(`${SIG_URL_BASE}${hopPath}`, params);

  const hops: HopResult[] = [];

  try {
    console.log("=== Healthy path (signed) ===\n");

    // 1. voice-twiml-browser → inserts twilio_calls row + returns <Dial> TwiML.
    {
      const p = "/api/twilio/webhooks/voice-twiml-browser";
      const body = { To: "+15558675309", From: `client:${realUserId}`, CallSid: callSid };
      hops.push(await postForm("voice-twiml-browser (healthy)", p, body, sign(p, body)));
    }
    // 2. voice-whisper → disclosure <Say>.
    {
      const p = "/api/twilio/webhooks/voice-whisper";
      const body = { CallSid: `${callSid}.child`, ParentCallSid: callSid, To: "+15558675309", From: "+15550000000" };
      hops.push(await postForm("voice-whisper (healthy)", p, body, sign(p, body)));
    }
    // 3. dial-status → updates parent twilio_calls row.
    {
      const p = "/api/twilio/webhooks/voice-twiml-browser-dial-status";
      const body = { CallSid: callSid, DialCallStatus: "completed", DialCallDuration: "42" };
      hops.push(await postForm("dial-status (healthy)", p, body, sign(p, body)));
    }
    // 4. recording-status → populates recording fields + enqueues archive.
    {
      const p = "/api/twilio/webhooks/recording-status";
      const body = {
        CallSid: callSid,
        RecordingSid: recordingSid,
        RecordingStatus: "completed",
        RecordingDuration: "42",
        RecordingChannels: "2",
        RecordingUrl: "https://api.twilio.com/test/recording.wav",
      };
      hops.push(await postForm("recording-status (healthy)", p, body, sign(p, body)));
    }

    console.log("\n=== Negative path: missing required field (signed) ===\n");

    // 5. voice-twiml-browser missing To → safe TwiML, reason=missing_to.
    {
      const p = "/api/twilio/webhooks/voice-twiml-browser";
      const body = { From: "client:test-user", CallSid: `${callSid}.no-to` };
      hops.push(await postForm("voice-twiml-browser missing To", p, body, sign(p, body)));
    }
    // 6. dial-status with empty body → still 200 + <Hangup/>.
    {
      const p = "/api/twilio/webhooks/voice-twiml-browser-dial-status";
      const body: Record<string, string> = {};
      hops.push(await postForm("dial-status empty body", p, body, sign(p, body)));
    }

    console.log("\n=== Negative path: invalid X-Twilio-Signature (forces fallback) ===\n");

    // 7+8. Bogus signature against the live token → fallback TwiML +
    //      `fallback_twiml=true category=invalid_signature` log line.
    hops.push(
      await postForm(
        "voice-twiml-browser bad sig",
        "/api/twilio/webhooks/voice-twiml-browser",
        { To: "+15558675309", From: "client:test-user", CallSid: `${callSid}.badsig` },
        { "X-Twilio-Signature": "ZmFrZS1zaWduYXR1cmU=" },
      ),
    );
    hops.push(
      await postForm(
        "voice-whisper bad sig",
        "/api/twilio/webhooks/voice-whisper",
        { CallSid: `${callSid}.child.badsig`, ParentCallSid: `${callSid}.badsig` },
        { "X-Twilio-Signature": "ZmFrZS1zaWduYXR1cmU=" },
      ),
    );

    // Let fire-and-forget archive enqueue land.
    await new Promise((r) => setTimeout(r, 2000));

    console.log("\n=== Per-hop HTTP results ===\n");
    for (const r of hops) {
      const tag = r.ok ? "OK" : "FAIL";
      console.log(`[${tag}] ${r.label.padEnd(40)} status=${r.statusCode}`);
      console.log(`       body: ${r.bodyExcerpt}`);
      assert(`HTTP 200 + <Response> :: ${r.label}`, r.ok, `status=${r.statusCode}`);
    }

    // Stricter: each hop's TwiML body must match the expected role for that
    // hop. (HTTP-200-with-fallback-TwiML still passes the basic check, so
    // we tag the labelled-as-healthy hops separately.)
    const expectedBodyContains: Record<string, RegExp> = {
      "voice-twiml-browser (healthy)": /<Dial[^>]*>[\s\S]*<Number/,
      "voice-whisper (healthy)": /quality assurance and compliance/,
      "dial-status (healthy)": /<Hangup\s*\/>/,
      "recording-status (healthy)": /<Response><\/Response>/,
      "voice-twiml-browser missing To": /No destination number/,
      "dial-status empty body": /<Hangup\s*\/>/,
      "voice-twiml-browser bad sig": /could not be connected/,
      "voice-whisper bad sig": /could not be connected/,
    };
    for (const r of hops) {
      const expected = expectedBodyContains[r.label];
      if (!expected) continue;
      assert(
        `TwiML body shape :: ${r.label}`,
        expected.test(r.bodyExcerpt),
        `expected /${expected.source}/ in body`,
      );
    }

    console.log("\n=== DB side-effect assertions ===\n");

    const callRows = await db.select().from(twilioCalls).where(eq(twilioCalls.twilioSid, callSid));
    const callRow = callRows[0];
    assert(
      "voice-twiml-browser inserted twilio_calls row",
      !!callRow,
      callRow
        ? `id=${callRow.id} status=${callRow.status} from=${callRow.fromNumber} to=${callRow.toNumber}`
        : "no row",
    );
    if (callRow) {
      assert(
        "dial-status updated status='completed' + duration=42",
        callRow.status === "completed" && callRow.duration === 42,
        `status=${callRow.status} duration=${callRow.duration}`,
      );
      assert(
        "recording-status populated recording_sid/url/status/duration/channels",
        callRow.recordingSid === recordingSid &&
          callRow.recordingUrl === "https://api.twilio.com/test/recording.wav" &&
          callRow.recordingStatus === "completed" &&
          callRow.recordingDuration === 42 &&
          callRow.recordingChannels === 2,
        `recordingSid=${callRow.recordingSid} status=${callRow.recordingStatus} dur=${callRow.recordingDuration} ch=${callRow.recordingChannels}`,
      );
      assert(
        "archive pipeline took ownership (archive_status advanced past 'pending')",
        callRow.archiveStatus !== null && callRow.archiveStatus !== "pending",
        `archive_status=${callRow.archiveStatus} archive_attempts=${callRow.archiveAttempts}`,
      );
    }

    // Log-line shape assertions are performed *outside* this script — the
    // dev server's stdout goes to the controlling TTY, not to a file we
    // can tail from a child process. The orchestrator triggers a fresh
    // `refresh_all_logs` snapshot after this script exits and greps for:
    //   [Twilio Voice] entry hop=<hop> ... callSid="<CALLSID>" signature="valid"
    //   [Twilio Voice] exit  hop=<hop> status=200 elapsedMs=<n> ...
    //   [Twilio Webhook][<hop>] fallback_twiml=true category=invalid_signature ...
    // The CallSid and RecordingSid printed at the top of this script's
    // output are the keys for that grep.
    console.log(`\nGrep keys for log verification: callSid=${callSid} recordingSid=${recordingSid}`);
  } finally {
    // --- Cleanup: remove test row + restore settings snapshot.
    console.log("\n=== Cleanup ===\n");
    const callRows = await db.select().from(twilioCalls).where(eq(twilioCalls.twilioSid, callSid));
    const callRow = callRows[0];
    if (callRow) {
      if (callRow.rawCommunicationRecordId) {
        await db.execute(
          sql`DELETE FROM raw_communication_records WHERE id = ${callRow.rawCommunicationRecordId}`,
        );
      }
      await db.execute(sql`DELETE FROM twilio_calls WHERE id = ${callRow.id}`);
      console.log(`  removed twilio_calls row id=${callRow.id}`);
    }
    for (const [key, prev] of Object.entries({
      twilio_account_sid: snapshot.sid,
      twilio_auth_token: snapshot.token,
      twilio_phone_numbers: snapshot.phones,
    })) {
      if (prev === null) await deleteSystemSetting(key);
      else await setSystemSetting(key, prev);
    }
    console.log("  restored twilio_account_sid / twilio_auth_token / twilio_phone_numbers");
  }

  console.log("\n=== Summary ===\n");
  const failed = assertions.filter((a) => !a.ok);
  console.log(`  passed: ${assertions.length - failed.length}/${assertions.length}`);
  if (failed.length) {
    console.log("\n  FAILURES:");
    for (const f of failed) console.log(`    - ${f.name} :: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
  process.exit(0);
}

run().catch((err) => {
  console.error("verify-task-944c failed:", err);
  process.exit(1);
});
