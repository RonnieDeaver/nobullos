/* test-registration
{
  "name": "Zoom webhook replay-window enforcement (audit A-004)",
  "regression": true,
  "sweepOnlyReason": "Route-level suite that mounts the full integrations router and exercises the Zoom webhook endpoint against the test DB; too heavy for the routine TEST_SMOKE gate. Runs in the full suite and the nightly --regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Audit A-004 — the Zoom webhook must reject validly-signed requests whose
 * HMAC-bound `x-zm-request-timestamp` falls outside a bounded past+future
 * window (ZOOM_WEBHOOK_REPLAY_WINDOW_MS, inclusive boundary).
 *
 * Proves (unit level, deterministic clock):
 *   1. Exact boundary drift (past and future) is accepted; one ms beyond is
 *      rejected; malformed timestamps are rejected.
 *
 * Proves (route level, real signatures):
 *   2. Valid signature + fresh timestamp is accepted (benign unsupported
 *      event type → 200 "ignored"; no ingestion side effects).
 *   3. Invalid signature → 401 (signature stays the first-line control).
 *   4. Valid signature + stale timestamp (> window in the past) → 401.
 *   5. Valid signature + future timestamp (> window ahead) → 401.
 *   6. CRC `endpoint.url_validation` challenge still works.
 *
 * Task #3982 dual-secret overlap (legacy + S2S app secrets both configured):
 *   7. Event signed with the SECONDARY (S2S) secret is accepted.
 *   8. CRC signed with the secondary secret answers with the secondary HMAC.
 *   9. Unsigned CRC (no signature headers) falls back to the primary HMAC.
 *
 * ZOOM_WEBHOOK_SECRET_TOKEN / ZOOM_S2S_WEBHOOK_SECRET_TOKEN are pinned to
 * test-only values for the process (the verifier reads them per-call) and
 * restored afterwards.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

const TEST_SECRET = `zm_a004_${process.pid}_${Date.now().toString(36)}`;
const TEST_S2S_SECRET = `zm_s2s_${process.pid}_${Date.now().toString(36)}`;
const PREV_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const PREV_S2S_SECRET = process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN;
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = TEST_SECRET;
process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN = TEST_S2S_SECRET;

function signZoomWith(secret: string, timestamp: string, rawBody: string): string {
  const message = `v0:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return `v0=${hash}`;
}

function signZoom(timestamp: string, rawBody: string): string {
  return signZoomWith(TEST_SECRET, timestamp, rawBody);
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postZoom(
  baseUrl: string,
  bodyObj: unknown,
  opts: { timestamp: string; signature?: string },
): Promise<{ status: number; json: any }> {
  // The route recomputes rawBody as JSON.stringify(req.body); sending the
  // exact JSON.stringify output keeps the signature stable.
  const raw = JSON.stringify(bodyObj);
  const r = await fetch(`${baseUrl}/api/integrations/zoom/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zm-request-timestamp": opts.timestamp,
      "x-zm-signature": opts.signature ?? signZoom(opts.timestamp, raw),
    },
    body: raw,
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON response */
  }
  return { status: r.status, json };
}

async function main(): Promise<void> {
  const {
    isZoomWebhookTimestampWithinWindow,
    ZOOM_WEBHOOK_REPLAY_WINDOW_MS,
  } = await import("../server/services/zoomIntegration");
  const { registerIntegrationRoutes } = await import("../server/routes/integrations");

  let passed = 0;

  // ---- Group 1: deterministic boundary unit tests -------------------------
  {
    const tsSec = 1_800_000_000; // fixed epoch seconds
    const tsMs = tsSec * 1000;
    const W = ZOOM_WEBHOOK_REPLAY_WINDOW_MS;
    assert.equal(W, 5 * 60 * 1000, "window constant is 5 minutes");
    // Past drift: now is AFTER the timestamp.
    assert.equal(isZoomWebhookTimestampWithinWindow(String(tsSec), tsMs + W), true, "exact past boundary accepted");
    assert.equal(isZoomWebhookTimestampWithinWindow(String(tsSec), tsMs + W + 1), false, "1ms past boundary rejected");
    // Future drift: now is BEFORE the timestamp.
    assert.equal(isZoomWebhookTimestampWithinWindow(String(tsSec), tsMs - W), true, "exact future boundary accepted");
    assert.equal(isZoomWebhookTimestampWithinWindow(String(tsSec), tsMs - W - 1), false, "1ms future boundary rejected");
    // Zero drift.
    assert.equal(isZoomWebhookTimestampWithinWindow(String(tsSec), tsMs), true, "zero drift accepted");
    // Malformed inputs.
    assert.equal(isZoomWebhookTimestampWithinWindow("", tsMs), false, "empty timestamp rejected");
    assert.equal(isZoomWebhookTimestampWithinWindow("abc", tsMs), false, "non-numeric rejected");
    assert.equal(isZoomWebhookTimestampWithinWindow("-5", tsMs), false, "negative rejected");
    assert.equal(isZoomWebhookTimestampWithinWindow("1.5e9", tsMs), false, "exponent form rejected");
    passed++;
  }

  // ---- Route-level groups --------------------------------------------------
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  registerIntegrationRoutes(app);
  const { server, baseUrl } = await listen(app);

  const nowSec = () => Math.floor(Date.now() / 1000);
  // Benign event type the handler explicitly ignores — no ingestion writes.
  const benignBody = () => ({
    event: "meeting.started",
    payload: { object: { id: `t_a004_${Date.now()}` } },
  });

  try {
    // Group 2: valid signature + fresh timestamp → accepted (ignored event).
    {
      const r = await postZoom(baseUrl, benignBody(), { timestamp: String(nowSec()) });
      assert.equal(r.status, 200, `fresh valid request accepted (got ${r.status}: ${JSON.stringify(r.json)})`);
      passed++;
    }

    // Group 3: invalid signature → 401 (first-line control unchanged).
    {
      const ts = String(nowSec());
      const r = await postZoom(baseUrl, benignBody(), { timestamp: ts, signature: "v0=deadbeef" });
      assert.equal(r.status, 401, "invalid signature rejected");
      assert.equal(r.json?.error, "Invalid signature");
      passed++;
    }

    // Group 4: valid signature, stale timestamp (6 min old) → 401.
    {
      const ts = String(nowSec() - 6 * 60);
      const r = await postZoom(baseUrl, benignBody(), { timestamp: ts });
      assert.equal(r.status, 401, "stale timestamp rejected");
      assert.equal(r.json?.error, "Timestamp outside allowed window");
      passed++;
    }

    // Group 5: valid signature, future timestamp (6 min ahead) → 401.
    {
      const ts = String(nowSec() + 6 * 60);
      const r = await postZoom(baseUrl, benignBody(), { timestamp: ts });
      assert.equal(r.status, 401, "future timestamp rejected");
      assert.equal(r.json?.error, "Timestamp outside allowed window");
      passed++;
    }

    // Group 6: CRC endpoint.url_validation challenge intact.
    {
      const plainToken = `crc_${Date.now().toString(36)}`;
      const body = { event: "endpoint.url_validation", payload: { plainToken } };
      const raw = JSON.stringify(body);
      const ts = String(nowSec());
      const r = await fetch(`${baseUrl}/api/integrations/zoom/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-zm-request-timestamp": ts,
          "x-zm-signature": signZoom(ts, raw),
        },
        body: raw,
      });
      const json: any = await r.json();
      assert.equal(r.status, 200, "CRC challenge returns 200");
      assert.equal(json.plainToken, plainToken, "CRC echoes plainToken");
      const expected = crypto.createHmac("sha256", TEST_SECRET).update(plainToken).digest("hex");
      assert.equal(json.encryptedToken, expected, "CRC encryptedToken matches HMAC of plainToken");
      passed++;
    }

    // Group 7 (Task #3982): event signed with the SECONDARY (S2S) secret is
    // accepted — both Marketplace apps deliver during the cutover overlap.
    {
      const ts = String(nowSec());
      const bodyObj = benignBody();
      const raw = JSON.stringify(bodyObj);
      const r = await postZoom(baseUrl, bodyObj, {
        timestamp: ts,
        signature: signZoomWith(TEST_S2S_SECRET, ts, raw),
      });
      assert.equal(r.status, 200, `secondary-signed request accepted (got ${r.status}: ${JSON.stringify(r.json)})`);
      passed++;
    }

    // Group 8 (Task #3982): CRC signed with the secondary secret must be
    // answered with the SECONDARY HMAC — Zoom validates the S2S app's
    // endpoint against the S2S app's own Secret Token.
    {
      const plainToken = `crc_s2s_${Date.now().toString(36)}`;
      const body = { event: "endpoint.url_validation", payload: { plainToken } };
      const raw = JSON.stringify(body);
      const ts = String(nowSec());
      const r = await fetch(`${baseUrl}/api/integrations/zoom/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-zm-request-timestamp": ts,
          "x-zm-signature": signZoomWith(TEST_S2S_SECRET, ts, raw),
        },
        body: raw,
      });
      const json: any = await r.json();
      assert.equal(r.status, 200, "secondary CRC challenge returns 200");
      const expected = crypto.createHmac("sha256", TEST_S2S_SECRET).update(plainToken).digest("hex");
      assert.equal(json.encryptedToken, expected, "CRC encryptedToken uses the secondary secret when the request is signed with it");
      passed++;
    }

    // Group 9 (Task #3982): unsigned CRC (no signature headers) falls back
    // to the PRIMARY secret — the pre-#3982 behavior stays intact.
    {
      const plainToken = `crc_unsigned_${Date.now().toString(36)}`;
      const body = { event: "endpoint.url_validation", payload: { plainToken } };
      const r = await fetch(`${baseUrl}/api/integrations/zoom/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: any = await r.json();
      assert.equal(r.status, 200, "unsigned CRC challenge returns 200");
      const expected = crypto.createHmac("sha256", TEST_SECRET).update(plainToken).digest("hex");
      assert.equal(json.encryptedToken, expected, "unsigned CRC falls back to the primary secret");
      passed++;
    }

    console.log(`zoom-webhook-replay-window: ${passed} groups passed`);
  } finally {
    server.close();
    if (PREV_SECRET === undefined) delete process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    else process.env.ZOOM_WEBHOOK_SECRET_TOKEN = PREV_SECRET;
    if (PREV_S2S_SECRET === undefined) delete process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN;
    else process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN = PREV_S2S_SECRET;
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
