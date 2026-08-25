/* test-registration
{
  "name": "Twilio real-time reply push channel e2e (Task #1279)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4110: the old ~31s runtime was one 30s statement_timeout stall (reconcileUserRow's ambient upsert blocking on a sandbox-uncommitted users row), fixed by committed user seeding; now ~3s, cheap enough to guard the webhook→SSE real-time push contract on every merge.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #1279: end-to-end test for the real-time reply push channel.
//
// The Conversation Hub relies on the SSE bridge at GET /api/twilio/events
// to render inbound replies in <1s instead of waiting on the next 5s poll.
// This test pins the contract end-to-end so a regression in any one of the
// moving pieces fails loudly:
//
//   inbound webhook  ->  handleInboundSms  ->  broadcastTwilioEvent
//                                                       |
//                                                       v
//                                           addTwilioEventSubscriber
//                                                       |
//                                                       v
//                                           GET /api/twilio/events stream
//
// What's verified:
//   1. An authenticated SSE connection to /api/twilio/events first
//      receives the `ready` priming event and registers itself
//      (twilioEventSubscriberCount() goes 0 -> 1).
//   2. A correctly-signed POST to /api/twilio/webhooks/sms triggers a
//      `message:new` SSE event delivered within ~1s, with a payload that
//      contains the expected message body and conversationPreview shape.
//   3. Closing the SSE client triggers the route's `close` cleanup so
//      twilioEventSubscriberCount() returns to 0 (no leaked subscriber,
//      no leaked heartbeat interval).
//
// Usage: tsx tests/twilio-events-sse-e2e.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import twilio from "twilio";
import { eq } from "drizzle-orm";

import { registerTwilioRoutes } from "../server/routes/twilio";
import { runInTxSandbox } from "./db-sandbox";
import { db, getDb } from "../server/db";
import { systemSettings, users } from "@shared/schema";
import {
  twilioEventSubscriberCount,
  __disableTwilioEventListenerForTest,
} from "../server/services/twilioEvents";

const { getExpectedTwilioSignature } = twilio as unknown as {
  getExpectedTwilioSignature: (
    token: string,
    url: string,
    params: Record<string, string>,
  ) => string;
};
if (typeof getExpectedTwilioSignature !== "function") {
  throw new Error(
    "twilio.getExpectedTwilioSignature not exported by SDK — cannot sign webhook fixtures",
  );
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// Auth shim — must run before registerTwilioRoutes so the real requireAuth
// + requireTwilioAccess middleware resolves the acting identity via the Clerk
// test seam. Webhook routes don't consult this; only /api/twilio/events does.
let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    req.__test_clerkUserId = currentUserId;
    next();
  });
  registerTwilioRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Raw http POST so we can override Host + x-forwarded-proto for stable
// Twilio signature URL reconstruction. (Same pattern as the existing
// signature e2e test.)
async function rawHttpPost(
  urlStr: string,
  body: string,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const u = new URL(urlStr);
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      ...extraHeaders,
    };
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    if (extraHeaders.host) req.setHeader("host", extraHeaders.host);
    req.on("error", reject);
    req.end(body);
  });
}

/** A minimal SSE client that exposes events as they arrive on the wire. */
type SseEvent = { event: string; data: string };
type SseClient = {
  events: SseEvent[];
  waitFor: (eventName: string, timeoutMs?: number) => Promise<SseEvent>;
  close: () => Promise<void>;
  statusCode: number;
};

async function openSse(urlStr: string): Promise<SseClient> {
  const u = new URL(urlStr);
  const events: SseEvent[] = [];
  const waiters: Array<{
    name: string;
    resolve: (e: SseEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  return await new Promise<SseClient>((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          // SSE events are separated by a blank line ("\n\n").
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of raw.split("\n")) {
              if (line.startsWith(":")) continue; // comment / heartbeat
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length === 0 && eventName === "message") continue;
            const ev: SseEvent = {
              event: eventName,
              data: dataLines.join("\n"),
            };
            events.push(ev);
            // Wake any matching waiters.
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].name === ev.event) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve(ev);
                waiters.splice(i, 1);
              }
            }
          }
        });
        res.on("error", (err) => {
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.reject(err);
          }
        });

        const client: SseClient = {
          events,
          statusCode: res.statusCode || 0,
          waitFor: (eventName, timeoutMs = 3000) =>
            new Promise<SseEvent>((res2, rej2) => {
              const existing = events.find((e) => e.event === eventName);
              if (existing) return res2(existing);
              const timer = setTimeout(() => {
                rej2(
                  new Error(
                    `timed out waiting ${timeoutMs}ms for SSE event '${eventName}'`,
                  ),
                );
              }, timeoutMs);
              waiters.push({ name: eventName, resolve: res2, reject: rej2, timer });
            }),
          close: () =>
            new Promise<void>((res2) => {
              res.on("close", () => res2());
              req.destroy();
              // Safety net: resolve even if 'close' never fires.
              setTimeout(() => res2(), 500);
            }),
        };
        resolve(client);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function nextTick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function testReplyPushChannelE2E(): Promise<void> {
  console.log(
    "\n— GET /api/twilio/events ⟷ POST /api/twilio/webhooks/sms — push channel (Task #1279) —",
  );

  await runInTxSandbox(async () => {
    const TOKEN = "test_auth_token_for_sse_push_e2e";
    const USER_ID = `u_sse_${Date.now().toString(36)}`;

    // Seed: auth token (signature middleware) + a team_lead user
    // (requireTwilioAccess gate on /api/twilio/events).
    await getDb()
      .insert(systemSettings)
      .values({ key: "twilio_auth_token", value: TOKEN })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: TOKEN },
      });
    // Task #4110: seed COMMITTED via the bare `db` import (which sidesteps
    // the tx-sandbox override). isAuthenticated's reconcileUserRow
    // (Task #2129) reads the users row through the AMBIENT pool; a
    // sandbox-only (uncommitted) row is invisible there, so it tried to
    // re-upsert the same id and blocked on the sandbox's row lock until the
    // 30s statement_timeout — the whole ~30s of this suite's old runtime.
    // Deleted in the finally below.
    await db
      .insert(users)
      .values({
        id: USER_ID,
        email: `${USER_ID}@test.local`,
        firstName: "SSE",
        lastName: "Tester",
        role: "team_lead",
      });

    // Sanity: auth token is visible inside the sandbox.
    const [tokenRow] = await getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "twilio_auth_token"));
    check("auth token visible inside tx sandbox", tokenRow?.value === TOKEN);

    currentUserId = USER_ID;
    try {
      await withApp(async (baseUrl) => {
        const baselineSubs = twilioEventSubscriberCount();

        // (1) Open the SSE stream and wait for the priming `ready` event.
        const sse = await openSse(`${baseUrl}/api/twilio/events`);
        check(
          "SSE connection accepted (HTTP 200)",
          sse.statusCode === 200,
          `got ${sse.statusCode}`,
        );

        try {
          const ready = await sse.waitFor("ready", 2000);
          check("received priming `ready` event", ready.event === "ready");

          // Subscriber should now be registered.
          const subsAfterOpen = twilioEventSubscriberCount();
          check(
            "subscriber count incremented after open",
            subsAfterOpen === baselineSubs + 1,
            `baseline=${baselineSubs}, after=${subsAfterOpen}`,
          );

          // (2) Post a signed inbound SMS. handleInboundSms should
          //     persist the message and call broadcastTwilioEvent.
          const SID = `SMsse${Date.now().toString(36)}`;
          const BODY = "real-time push reply (Task #1279)";
          const publicUrl = "https://public.example.com/api/twilio/webhooks/sms";
          const params: Record<string, string> = {
            From: "+15551112222",
            To: "+15553334444",
            Body: BODY,
            MessageSid: SID,
          };
          const sig = getExpectedTwilioSignature(TOKEN, publicUrl, params);
          const form = new URLSearchParams(params).toString();

          const t0 = Date.now();
          const post = await rawHttpPost(
            `${baseUrl}/api/twilio/webhooks/sms`,
            form,
            {
              "x-twilio-signature": sig,
              "x-forwarded-proto": "https",
              host: "public.example.com",
            },
          );
          check(
            "signed inbound SMS POST → 200",
            post.status === 200,
            `got ${post.status}`,
          );

          // (3) Wait for the `message:new` push event on the SSE channel.
          //     The Conversation Hub's <1s latency budget includes DB
          //     writes + broadcast; allow 3s here for CI jitter but
          //     report observed latency so a regression shows up in
          //     the log even when still under the timeout.
          const msgEvent = await sse.waitFor("message:new", 3000);
          const latencyMs = Date.now() - t0;
          check(
            "received `message:new` event after inbound webhook",
            msgEvent.event === "message:new",
            `latency=${latencyMs}ms`,
          );
          check(
            "push latency under 1500ms budget",
            latencyMs < 1500,
            `latency=${latencyMs}ms`,
          );

          // (4) Payload shape: must carry the persisted message + the
          //     conversationPreview the React Query merger needs.
          let payload: any = null;
          try {
            payload = JSON.parse(msgEvent.data);
          } catch (err) {
            check("payload is valid JSON", false, String(err));
          }
          if (payload) {
            check(
              "payload.type === 'message:new'",
              payload.type === "message:new",
              String(payload.type),
            );
            check(
              "payload.conversationId is a non-empty string",
              typeof payload.conversationId === "string" &&
                payload.conversationId.length > 0,
              String(payload.conversationId),
            );
            check(
              "payload.message.body matches POSTed body verbatim",
              payload.message?.body === BODY,
              String(payload.message?.body),
            );
            check(
              "payload.message.twilioSid matches MessageSid",
              payload.message?.twilioSid === SID,
              String(payload.message?.twilioSid),
            );
            check(
              "payload.message.direction === 'inbound'",
              payload.message?.direction === "inbound",
              String(payload.message?.direction),
            );
            check(
              "payload.message.fromNumber / toNumber preserved",
              payload.message?.fromNumber === params.From &&
                payload.message?.toNumber === params.To,
              `${payload.message?.fromNumber} -> ${payload.message?.toNumber}`,
            );
            check(
              "payload.conversationPreview.lastMessagePreview is BODY-prefixed",
              typeof payload.conversationPreview?.lastMessagePreview === "string" &&
                BODY.startsWith(payload.conversationPreview.lastMessagePreview),
              String(payload.conversationPreview?.lastMessagePreview),
            );
            check(
              "conversationPreview.unreadCountDelta is 0 (new direct conv)",
              payload.conversationPreview?.unreadCountDelta === 0,
              String(payload.conversationPreview?.unreadCountDelta),
            );
          }
        } finally {
          await sse.close();
        }

        // (5) Subscriber cleanup on client disconnect. Give the server
        //     a brief tick to process the socket close event.
        for (let i = 0; i < 20; i++) {
          if (twilioEventSubscriberCount() === baselineSubs) break;
          await nextTick(50);
        }
        const subsAfterClose = twilioEventSubscriberCount();
        check(
          "subscriber count returns to baseline after client disconnect",
          subsAfterClose === baselineSubs,
          `baseline=${baselineSubs}, after-close=${subsAfterClose}`,
        );
      });
    } finally {
      currentUserId = null;
      // Remove the committed seed row (see the seeding comment above).
      await db.delete(users).where(eq(users.id, USER_ID));
    }
  });
}

async function main(): Promise<void> {
  console.log("Twilio real-time reply push channel e2e (Task #1279)");

  try {
    await testReplyPushChannelE2E();
  } finally {
    // The SSE route lazily starts a dedicated pg LISTEN Client that lives
    // outside the managed pools, so closeDbPools can't reach it; left open it
    // keeps the event loop alive and the child can't drain (Task #2084). End it
    // here so the process exits on its own instead of needing a force-exit.
    __disableTwilioEventListenerForTest();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
