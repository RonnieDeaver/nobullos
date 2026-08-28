/* test-registration
{
  "name": "Front webhook fail-closed verification + health surfacing (audit A-003)",
  "regression": true,
  "sweepOnlyReason": "Route-level suite that mounts the full integrations router and exercises real ingestion writes against the test DB; too heavy for the routine TEST_SMOKE gate. Runs in the full suite and the nightly --regression sweep.",
  "tier": "medium"
}
test-registration */
/**
 * Audit A-003 — the Front webhook route must fail closed in production when
 * FRONT_WEBHOOK_SECRET is missing or blank, rejecting BEFORE any DB mutation
 * or downstream ingestion.
 *
 * Proves:
 *   1. NODE_ENV=production + missing secret → 503, and no source_event_log
 *      row is written for the delivery's dedupe key.
 *   2. NODE_ENV=production + blank/whitespace secret → 503 (blank is NOT
 *      "configured").
 *   3. NODE_ENV=production + configured secret + INVALID signature → 401,
 *      no ingestion row (existing 401 path intact).
 *   4. NODE_ENV=production + configured secret + VALID signature +
 *      url_validation → 200 challenge echo (valid signed deliveries pass the
 *      gate in production; challenge handling intact; no ingestion needed).
 *   5. Non-production + missing secret → delivery still accepted (the
 *      explicit, tested non-production allowance).
 *   6. Configured secret + valid signature (non-production env) → accepted
 *      and ingested; an identical replayed delivery reports deduplicated:true
 *      and leaves exactly one source_event_log row (dedupe second line
 *      intact).
 *   7. Health surfacing: FrontStatusValue.webhookSecretConfigured reflects
 *      presence-only state, and the committed value never contains
 *      secret-derived material. Also unit-covers
 *      isFrontWebhookSecretConfigured for missing/blank/set.
 *
 * Env vars (NODE_ENV, FRONT_WEBHOOK_SECRET) are pinned per-case and restored
 * in finally. Ingestion rows created by accept-path cases are deleted in
 * finally (workerDb writes bypass any tx sandbox, so cleanup is explicit).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const RUN_ID = `t_a003_${process.pid}_${Date.now().toString(36)}`;
const TEST_SECRET = `front_secret_${RUN_ID}`;

const PREV_NODE_ENV = process.env.NODE_ENV;
const PREV_SECRET = process.env.FRONT_WEBHOOK_SECRET;

function restoreEnv(): void {
  if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PREV_NODE_ENV;
  if (PREV_SECRET === undefined) delete process.env.FRONT_WEBHOOK_SECRET;
  else process.env.FRONT_WEBHOOK_SECRET = PREV_SECRET;
}

// Task #3992 — Front application webhooks sign the timestamp-prefixed body:
// base64(HMAC-SHA256(`${x-front-request-timestamp}:${rawBody}`, signing key)).
function signFront(rawBody: string, secret: string, timestampMs: number): string {
  return crypto
    .createHmac("sha256", secret)
    .update(Buffer.from(`${timestampMs}:${rawBody}`))
    .digest("base64");
}

/** Webhook payload with a unique, queryable dedupe key. */
function makePayload(suffix: string) {
  const convId = `cnv_${RUN_ID}_${suffix}`;
  const msgId = `msg_${RUN_ID}_${suffix}`;
  return {
    payload: {
      type: "inbound",
      payload: {
        conversation: { id: convId, subject: "A-003 test" },
        message: { id: msgId, body: "hello", is_inbound: true, created_at: Date.now() / 1000 },
      },
    },
    // buildDedupeKey: `front:webhook:${convId}:${msgId}:${eventType}`
    dedupeKey: `front:webhook:${convId}:${msgId}:inbound`,
  };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postFront(
  baseUrl: string,
  rawBody: string,
  signature?: string,
  timestampMs?: number,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["x-front-signature"] = signature;
  if (timestampMs !== undefined)
    headers["x-front-request-timestamp"] = String(timestampMs);
  const r = await fetch(`${baseUrl}/api/integrations/front/webhook`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
}

async function main(): Promise<void> {
  const { registerIntegrationRoutes } = await import("../server/routes/integrations");
  const { workerDb } = await import("../server/db");
  const { isFrontWebhookSecretConfigured } = await import(
    "../server/services/frontWebhookIngestion"
  );

  const countRows = async (dedupeKey: string): Promise<number> => {
    const result: any = await workerDb.execute(
      sql`SELECT COUNT(*)::int AS n FROM source_event_log WHERE dedupe_key = ${dedupeKey}`,
    );
    return Number(result.rows[0]?.n ?? 0);
  };

  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  registerIntegrationRoutes(app);
  const { server, baseUrl } = await listen(app);

  const createdDedupeKeys: string[] = [];
  let passed = 0;

  try {
    // ---- Group 1: production + missing secret → 503, no DB row ----------
    {
      process.env.NODE_ENV = "production";
      delete process.env.FRONT_WEBHOOK_SECRET;
      const p = makePayload("g1");
      const raw = JSON.stringify(p.payload);
      const ts = Date.now();
      const r = await postFront(baseUrl, raw, signFront(raw, "whatever", ts), ts);
      assert.equal(r.status, 503, `prod+missing secret → 503 (got ${r.status})`);
      assert.ok(
        !JSON.stringify(r.json).toLowerCase().includes("secret_"),
        "response contains no secret material",
      );
      assert.equal(await countRows(p.dedupeKey), 0, "no ingestion row written");
      passed++;
    }

    // ---- Group 2: production + blank secret → 503 ------------------------
    {
      process.env.NODE_ENV = "production";
      for (const blank of ["", "   "]) {
        process.env.FRONT_WEBHOOK_SECRET = blank;
        const p = makePayload(`g2_${blank.length}`);
        const raw = JSON.stringify(p.payload);
        const ts = Date.now();
        const r = await postFront(baseUrl, raw, signFront(raw, blank || "x", ts), ts);
        assert.equal(r.status, 503, `prod+blank(${blank.length}) secret → 503`);
        assert.equal(await countRows(p.dedupeKey), 0, "no ingestion row written");
      }
      passed++;
    }

    // ---- Group 3: production + configured + invalid signature → 401 ------
    {
      process.env.NODE_ENV = "production";
      process.env.FRONT_WEBHOOK_SECRET = TEST_SECRET;
      const p = makePayload("g3");
      const raw = JSON.stringify(p.payload);
      const ts = Date.now();
      const bad = await postFront(baseUrl, raw, signFront(raw, "wrong-secret", ts), ts);
      assert.equal(bad.status, 401, "invalid signature → 401");
      const missing = await postFront(baseUrl, raw, undefined, ts); // no signature header
      assert.equal(missing.status, 401, "missing signature header → 401");
      assert.equal(await countRows(p.dedupeKey), 0, "no ingestion row written");
      passed++;
    }

    // ---- Group 4: production + configured + valid sig + url_validation ---
    {
      process.env.NODE_ENV = "production";
      process.env.FRONT_WEBHOOK_SECRET = TEST_SECRET;
      const challenge = `ch_${RUN_ID}`;
      const raw = JSON.stringify({ type: "url_validation", challenge });
      const ts = Date.now();
      const r = await postFront(baseUrl, raw, signFront(raw, TEST_SECRET, ts), ts);
      assert.equal(r.status, 200, "valid signed url_validation passes gate in production");
      assert.equal(r.json?.challenge, challenge, "challenge echoed");
      passed++;
    }

    // ---- Group 5: non-production + missing secret → explicitly allowed ---
    {
      restoreEnv();
      delete process.env.FRONT_WEBHOOK_SECRET;
      const p = makePayload("g5");
      createdDedupeKeys.push(p.dedupeKey);
      const raw = JSON.stringify(p.payload);
      const r = await postFront(baseUrl, raw); // unsigned
      assert.equal(r.status, 200, "non-production missing-secret delivery accepted");
      assert.equal(r.json?.ok, true);
      assert.equal(await countRows(p.dedupeKey), 1, "ingested exactly once");
      passed++;
    }

    // ---- Group 6: valid signed delivery + replay dedupe -------------------
    {
      restoreEnv();
      process.env.FRONT_WEBHOOK_SECRET = TEST_SECRET;
      const p = makePayload("g6");
      createdDedupeKeys.push(p.dedupeKey);
      const raw = JSON.stringify(p.payload);
      const ts = Date.now();
      const sig = signFront(raw, TEST_SECRET, ts);
      const first = await postFront(baseUrl, raw, sig, ts);
      assert.equal(first.status, 200, "valid signed delivery accepted");
      assert.equal(first.json?.deduplicated, false, "first delivery not deduplicated");
      const replay = await postFront(baseUrl, raw, sig, ts);
      assert.equal(replay.status, 200, "replayed delivery still 200");
      assert.equal(replay.json?.deduplicated, true, "replay reports deduplicated:true");
      assert.equal(await countRows(p.dedupeKey), 1, "still exactly one ingestion row");
      passed++;
    }

    // ---- Group 7: health surfacing --------------------------------------
    {
      restoreEnv();
      // Unit coverage of the shared predicate.
      delete process.env.FRONT_WEBHOOK_SECRET;
      assert.equal(isFrontWebhookSecretConfigured(), false, "missing → false");
      process.env.FRONT_WEBHOOK_SECRET = "   ";
      assert.equal(isFrontWebhookSecretConfigured(), false, "blank → false");
      process.env.FRONT_WEBHOOK_SECRET = TEST_SECRET;
      assert.equal(isFrontWebhookSecretConfigured(), true, "set → true");

      // Loader-level: with no Front tokens stored the probe is network-free
      // (`unauthorized`/`no_tokens_stored`) and the loader commits a value.
      delete process.env.FRONT_WEBHOOK_SECRET;
      const { frontStatusLoader } = await import(
        "../server/services/integrationStatusLoaders"
      );
      const outcome: any = await frontStatusLoader();
      assert.equal(outcome.outcome, "commit", "loader commits a status value");
      assert.equal(
        outcome.value.webhookSecretConfigured,
        false,
        "missing secret surfaces webhookSecretConfigured:false",
      );
      const serialized = JSON.stringify(outcome.value);
      assert.ok(!serialized.includes(TEST_SECRET), "no secret material in status value");
      assert.ok(!serialized.includes("front_secret_"), "no secret fragments in status value");

      process.env.FRONT_WEBHOOK_SECRET = TEST_SECRET;
      const outcome2: any = await frontStatusLoader();
      assert.equal(outcome2.outcome, "commit");
      assert.equal(
        outcome2.value.webhookSecretConfigured,
        true,
        "configured secret surfaces webhookSecretConfigured:true",
      );
      assert.ok(
        !JSON.stringify(outcome2.value).includes(TEST_SECRET),
        "configured state never includes the secret itself",
      );
      passed++;
    }

    console.log(`front-webhook-fail-closed: ${passed} groups passed`);
  } finally {
    restoreEnv();
    server.close();
    // Cleanup ingestion litter (source_event_log + enqueued normalize jobs).
    try {
      for (const key of createdDedupeKeys) {
        const rows: any = await workerDb.execute(
          sql`DELETE FROM source_event_log WHERE dedupe_key = ${key} RETURNING id`,
        );
        for (const row of rows.rows ?? []) {
          await workerDb.execute(
            sql`DELETE FROM work_queue WHERE dedupe_key = ${"normalize:" + row.id}`,
          );
        }
      }
    } catch (cleanupErr) {
      console.error("[front-webhook-fail-closed] cleanup failed:", cleanupErr);
    }
  }
}

main().catch((err) => {
  restoreEnv();
  console.error("FATAL:", err);
  process.exitCode = 1;
});
