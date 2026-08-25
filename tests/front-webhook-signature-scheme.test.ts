/* test-registration
{
  "name": "Front webhook timestamp-prefixed signature scheme + handshake ordering (Task #3992)",
  "smoke": true,
  "smokeReason": "Guards the Front application-webhook auth contract: known-vector HMAC fixtures, reserialization-failure proof, inclusive 5-minute timestamp window edges, and the sync/url_validation handshake gating order. Ingestion-free (handshake echoes never write), fast route-level checks only.",
  "tier": "small"
}
test-registration */
/**
 * Task #3992 — Front application webhooks sign
 * `base64(HMAC-SHA256("{x-front-request-timestamp}:" + rawBody, application
 * signing key))`. This suite pins:
 *
 *   1. Known-vector fixture: exact timestamp + exact raw bytes + known key →
 *      the exact expected Base64 HMAC verifies; any altered byte fails.
 *   2. Reserialization proof: signing the pretty-printed / re-stringified
 *      body (semantically identical JSON, different bytes) does NOT verify
 *      against the original raw bytes — the verifier must consume the exact
 *      captured request bytes.
 *   3. Timestamp window edges: inclusive ±5-minute boundary (exactly at the
 *      boundary accepted, 1 ms beyond rejected), missing/malformed/negative/
 *      non-numeric rejected; values are MILLISECONDS (no seconds scaling).
 *   4. Handshake ordering at the route: the Front `type:'sync'` save-time
 *      validation (challenge in the x-front-challenge HEADER, echoed as
 *      `{"challenge": ...}`) and the legacy body-borne `url_validation` echo
 *      BOTH run only after secret-presence + timestamp + signature pass —
 *      an unsigned or stale-timestamped sync request is rejected before any
 *      handler.
 *
 * Env vars are pinned per-case and restored in finally. No ingestion rows
 * are ever written (handshake echoes return before ingestion).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

const PREV_NODE_ENV = process.env.NODE_ENV;
const PREV_SECRET = process.env.FRONT_WEBHOOK_SECRET;

function restoreEnv(): void {
  if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PREV_NODE_ENV;
  if (PREV_SECRET === undefined) delete process.env.FRONT_WEBHOOK_SECRET;
  else process.env.FRONT_WEBHOOK_SECRET = PREV_SECRET;
}

function sign(raw: string, secret: string, tsMs: number | string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(Buffer.from(`${tsMs}:${raw}`))
    .digest("base64");
}

async function main(): Promise<void> {
  const {
    verifyFrontWebhookSignature,
    isFrontWebhookTimestampWithinWindow,
    FRONT_WEBHOOK_REPLAY_WINDOW_MS,
  } = await import("../server/services/frontWebhookIngestion");

  let passed = 0;

  // ---- 1. Known-vector fixture -------------------------------------------
  {
    // Pinned vector (computed once, independently, at task time). If the
    // scheme drifts (prefix separator, digest encoding, key handling), this
    // exact-vector assert fails even when sign/verify drift together.
    const FIXTURE_SECRET = "fixture_signing_key_3992";
    const FIXTURE_TS = "1754500000000"; // Unix ms
    const FIXTURE_RAW =
      '{"type":"inbound","payload":{"conversation":{"id":"cnv_fixture"},"message":{"id":"msg_fixture","is_inbound":true}}}';
    const FIXTURE_EXPECTED_B64 = "PepYI2R/lEU38vtm03h83///gl2xkbV3jDkRVs+ijr8=";

    assert.equal(
      sign(FIXTURE_RAW, FIXTURE_SECRET, FIXTURE_TS),
      FIXTURE_EXPECTED_B64,
      "signing helper reproduces the pinned Base64 vector",
    );
    assert.equal(
      verifyFrontWebhookSignature(
        Buffer.from(FIXTURE_RAW),
        FIXTURE_EXPECTED_B64,
        FIXTURE_TS,
        FIXTURE_SECRET,
      ),
      true,
      "pinned vector verifies",
    );
    // Altered body byte fails.
    assert.equal(
      verifyFrontWebhookSignature(
        Buffer.from(FIXTURE_RAW.replace("msg_fixture", "msg_fixturX")),
        FIXTURE_EXPECTED_B64,
        FIXTURE_TS,
        FIXTURE_SECRET,
      ),
      false,
      "altered body byte fails verification",
    );
    // Altered timestamp fails (timestamp is HMAC-bound).
    assert.equal(
      verifyFrontWebhookSignature(
        Buffer.from(FIXTURE_RAW),
        FIXTURE_EXPECTED_B64,
        "1754500000001",
        FIXTURE_SECRET,
      ),
      false,
      "altered timestamp fails verification",
    );
    // Wrong key fails; missing signature/timestamp fail.
    assert.equal(
      verifyFrontWebhookSignature(Buffer.from(FIXTURE_RAW), FIXTURE_EXPECTED_B64, FIXTURE_TS, "other_key"),
      false,
    );
    assert.equal(
      verifyFrontWebhookSignature(Buffer.from(FIXTURE_RAW), undefined, FIXTURE_TS, FIXTURE_SECRET),
      false,
    );
    assert.equal(
      verifyFrontWebhookSignature(Buffer.from(FIXTURE_RAW), FIXTURE_EXPECTED_B64, undefined, FIXTURE_SECRET),
      false,
    );

    // Reserialization proof: JSON.stringify(JSON.parse(raw), null, 2) is the
    // same JSON but different bytes — a verifier fed reserialized bytes must
    // NOT accept a signature computed over the original raw bytes.
    const reserialized = JSON.stringify(JSON.parse(FIXTURE_RAW), null, 2);
    assert.notEqual(reserialized, FIXTURE_RAW, "reserialized bytes differ");
    assert.equal(
      verifyFrontWebhookSignature(
        Buffer.from(reserialized),
        FIXTURE_EXPECTED_B64,
        FIXTURE_TS,
        FIXTURE_SECRET,
      ),
      false,
      "signature over original bytes fails against reserialized bytes",
    );
    passed++;
  }

  // ---- 2. Timestamp window edges (inclusive, milliseconds) ----------------
  {
    const now = 1754500000000;
    const W = FRONT_WEBHOOK_REPLAY_WINDOW_MS;
    assert.equal(W, 5 * 60 * 1000, "house replay window is 5 minutes");
    assert.equal(isFrontWebhookTimestampWithinWindow(String(now), now), true);
    assert.equal(isFrontWebhookTimestampWithinWindow(String(now - W), now), true, "exactly stale boundary accepted (inclusive)");
    assert.equal(isFrontWebhookTimestampWithinWindow(String(now + W), now), true, "exactly future boundary accepted (inclusive)");
    assert.equal(isFrontWebhookTimestampWithinWindow(String(now - W - 1), now), false, "1ms past stale boundary rejected");
    assert.equal(isFrontWebhookTimestampWithinWindow(String(now + W + 1), now), false, "1ms past future boundary rejected");
    // Milliseconds, not seconds: the same instant expressed in seconds is
    // ancient when read as ms and must be rejected.
    assert.equal(isFrontWebhookTimestampWithinWindow(String(Math.floor(now / 1000)), now), false, "seconds-scale value rejected (header is ms)");
    for (const bad of [undefined, "", "  ", "abc", "12.5", "-1754500000000", "17545e9", "1754500000000extra"]) {
      assert.equal(isFrontWebhookTimestampWithinWindow(bad as any, now), false, `malformed timestamp rejected: ${JSON.stringify(bad)}`);
    }
    passed++;
  }

  // ---- 3. Route handshake ordering ----------------------------------------
  {
    const { registerIntegrationRoutes } = await import("../server/routes/integrations");
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
    registerIntegrationRoutes(app);
    const server: Server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const SECRET = `sig_scheme_secret_${process.pid}`;
    const post = async (raw: string, headers: Record<string, string>) => {
      const r = await fetch(`${baseUrl}/api/integrations/front/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: raw,
      });
      let json: any = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    };

    try {
      process.env.NODE_ENV = "production";
      process.env.FRONT_WEBHOOK_SECRET = SECRET;

      const syncRaw = JSON.stringify({ type: "sync", authorization: { id: "auth_123" } });
      const challenge = `ch_sync_${Date.now().toString(36)}`;

      // (a) Valid signed sync → 200 with the HEADER challenge echoed in JSON.
      {
        const ts = Date.now();
        const r = await post(syncRaw, {
          "x-front-request-timestamp": String(ts),
          "x-front-signature": sign(syncRaw, SECRET, ts),
          "x-front-challenge": challenge,
        });
        assert.equal(r.status, 200, "valid signed sync accepted");
        assert.equal(r.json?.challenge, challenge, "header challenge echoed as JSON {challenge}");
      }

      // (b) Unsigned sync → 401 (handshake runs only after the gate).
      {
        const ts = Date.now();
        const r = await post(syncRaw, {
          "x-front-request-timestamp": String(ts),
          "x-front-challenge": challenge,
        });
        assert.equal(r.status, 401, "unsigned sync rejected before handshake");
        assert.notEqual(r.json?.challenge, challenge, "challenge not leaked on rejection");
      }

      // (c) Correctly signed but STALE-timestamped sync → 401 (timestamp
      // gate precedes handlers; signature was computed over the stale ts so
      // the ordering assert is on the timestamp check specifically).
      {
        const stale = Date.now() - (5 * 60 * 1000 + 1);
        const r = await post(syncRaw, {
          "x-front-request-timestamp": String(stale),
          "x-front-signature": sign(syncRaw, SECRET, stale),
          "x-front-challenge": challenge,
        });
        assert.equal(r.status, 401, "stale-timestamped sync rejected");
      }

      // (d) Missing timestamp header entirely → 401 even with a signature.
      {
        const r = await post(syncRaw, {
          "x-front-signature": sign(syncRaw, SECRET, Date.now()),
          "x-front-challenge": challenge,
        });
        assert.equal(r.status, 401, "missing timestamp header rejected");
      }

      // (e) Legacy url_validation echo still works — and only when signed.
      {
        const legacyChallenge = `ch_legacy_${Date.now().toString(36)}`;
        const legacyRaw = JSON.stringify({ type: "url_validation", challenge: legacyChallenge });
        const ts = Date.now();
        const ok = await post(legacyRaw, {
          "x-front-request-timestamp": String(ts),
          "x-front-signature": sign(legacyRaw, SECRET, ts),
        });
        assert.equal(ok.status, 200, "signed legacy url_validation accepted");
        assert.equal(ok.json?.challenge, legacyChallenge, "legacy body challenge echoed");

        const unsigned = await post(legacyRaw, {
          "x-front-request-timestamp": String(ts),
        });
        assert.equal(unsigned.status, 401, "unsigned legacy url_validation rejected");
      }
      passed++;
    } finally {
      restoreEnv();
      server.close();
    }
  }

  console.log(`front-webhook-signature-scheme: ${passed} groups passed`);
}

main().catch((err) => {
  restoreEnv();
  console.error("FATAL:", err);
  process.exitCode = 1;
});
