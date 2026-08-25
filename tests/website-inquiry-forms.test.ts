/* test-registration
{
  "name": "Marketing website inquiry forms e2e — the shared inquiry contract drives the single protected homepage contact form and the independent unsubscribe utility while retired conversion routes redirect",
  "regression": true,
  "sweepOnlyReason": "Task #5031 size-tier migration: Chromium/browser suite (last green 3.0s) runs in the post-merge/nightly regression lane and is forced blocking when its import closure or declared website scan paths change.",
  "timeoutMs": 240000,
  "scanPaths": [
    "website/public",
    "website/src/client-shared/inquiry.ts",
    "website/src/home-client/main.ts",
    "website/src/site-client/main.ts"
  ],
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * End-to-end coverage for the unified inquiry-form contract (PR4 built the
 * two-contract baseline; PR5 converged both page classes onto ONE shared
 * source, website/src/client-shared/inquiry.ts, compiled into BOTH generated
 * bundles):
 *
 *   every form   form[data-nb-inquiry="contact"|"unsubscribe"]
 *                kind = attribute value; client-side required-field
 *                validation scoped to the canonical fields the form renders;
 *                [data-nb-form-msg] stamped BOTH ways (data-kind ok/err for
 *                home.css AND .ok/.err classes for site.css); per-form
 *                data-success copy; server errors render verbatim
 *
 *   homepage     one labeled protected contact form at #contact, wired by
 *                home.js, beside the compact #booking Calendly handoff
 *   subpages     wired by public/assets/js/site.js (website/src/site-client);
 *                only the unsubscribe utility currently renders an inquiry
 *                form outside the homepage
 *
 * All browser submissions POST to /api/website/inquiry (rate-limited
 * 6/min/IP — the browser pass uses exactly all 6 requests, after the focused
 * server-boundary pass resets the route's existing test-only limiter seam).
 * The suite mounts the REAL marketing-site middleware and
 * the REAL inquiry route in-process, drives the committed bundle through the
 * host-agnostic /website-preview path in headless Chromium, and asserts:
 *
 *   1. Homepage renders exactly one canonical contact form at #contact with
 *      visible labels, honeypot, reCAPTCHA, polite status, success copy, and
 *      a footer Contact fragment link. #booking includes the canonical
 *      Calendly event as a compact external handoff with a no-JS path.
 *   2. Homepage #contact empty submit → client-side error message, NO network
 *      call (home.js validation identical to the former booking-page path).
 *   3. Homepage #contact invalid email → passes client validation (non-empty),
 *      the server 400 renders verbatim in [data-nb-form-msg].err
 *      ("Please check the form fields and try again."), no row.
 *   4. Homepage #contact valid submit → row persisted via the real storage
 *      path (kind/fullName/email/phone/message/sourcePage/sourceHost/userAgent)
 *      + the form's data-success copy ("Thank you! …") in [data-nb-form-msg].ok.
 *   5. Homepage #contact honeypot fill → server answers {ok:true}, UI shows
 *      success, and NO row is persisted (bots learn nothing).
 *   6. Unsubscribe empty submit → client validation scoped to the fields the
 *      form RENDERS: "Please fill in your email." (email-only form), no POST.
 *   7. Unsubscribe valid submit → kind="unsubscribe" row persisted + that
 *      page's data-success copy.
 *   8. /book-free-demo/ and /contact/ permanently redirect (301) to
 *      /#booking and /#contact respectively; a direct homepage #contact load
 *      submits through home.js and persists a kind="contact" row attributed
 *      to the homepage (6th and final browser POST of the 6/min budget).
 *   9. The PR4 freshness stamp (/website-preview/build-manifest.json) stays
 *      an internal bundle file: direct requests 404.
 *
 * External hosts (Typekit/Calendly/Vimeo) are aborted via request
 * interception so the run is deterministic offline. Outcome waits poll for
 * the TERMINAL ok/err state (the shared module clears both classes when a
 * flight starts) with contention-sized budgets, so an unexpected server
 * error fails fast with the real visitor-facing message + response statuses
 * instead of an opaque timeout — a bare `npx tsx` run shares the dev DB
 * with concurrent load, where INSERTs stall for tens of seconds. prefers-reduced-motion
 * is emulated so the Revenue Engine section takes its static path; main.ts
 * wires the inquiry form unconditionally either way.
 *
 * DB writes are scoped per shared-DB conventions: unique ${TAG} marker in
 * every email, finally-cleanup deletes by marker.
 */

import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { like } from "drizzle-orm";
import {
  registerMarketingSite,
  MARKETING_PREVIEW_PATH,
} from "../server/website/marketingSite";
import {
  __resetWebsiteInquiryLimiterForTest,
  registerWebsiteRoutes,
} from "../server/routes/website";
import {
  __resetWebsiteInquirySlackStateForTest,
  buildWebsiteInquirySlackMessage,
  relayWebsiteInquiryToSlack,
  type WebsiteInquirySlackArgs,
  type WebsiteInquirySlackResult,
} from "../server/services/websiteInquirySlackRelay";
import {
  __resetSlackAuthBreakerForTest,
  postMessageOnce,
  setToken as setSlackToken,
} from "../server/services/slackIntegration";
import { verifyRecaptchaToken } from "../server/services/recaptcha";
import { getDb } from "../server/db";
import { websiteInquiries } from "@shared/schema";

const TAG = `nbinq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Budget for a POST round trip to reach its terminal ok/err UI state.
 * Hermetic harness runs (npm test -- --file=…) answer in milliseconds; a
 * bare `npx tsx` run shares the dev database with whatever else is using it
 * (dev server, a concurrent smoke run), where a single INSERT has been
 * observed to stall behind pool contention for tens of seconds. The budget
 * absorbs that honestly instead of reporting it as an opaque timeout. */
const POST_OUTCOME_TIMEOUT_MS = 90_000;
/** Client-side validation stamps its message synchronously inside the
 * submit handler — this wait only covers event dispatch under CPU load. */
const VALIDATION_OUTCOME_TIMEOUT_MS = 15_000;

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const p = execSync(`which ${bin}`, { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {
      /* not on PATH — try the next candidate */
    }
  }
  return null;
}

async function inquiriesByEmail(email: string) {
  return getDb()
    .select()
    .from(websiteInquiries)
    .where(like(websiteInquiries.email, email));
}

async function main(): Promise<void> {
  // Same skip posture as tests/api-smoke.test.ts / os-mobile-layout-sweep:
  // missing browser or DB is an environment gap, not a regression.
  const chromium = findChromium();
  if (!chromium) {
    console.log("website-inquiry-forms: SKIPPED (no chromium binary available)");
    process.exit(0);
  }
  if (!process.env.DATABASE_URL) {
    console.log("website-inquiry-forms: SKIPPED (no DATABASE_URL)");
    process.exit(0);
  }
  // Loud, not masking: a bare `npx tsx` run executes against whatever
  // DATABASE_URL points at (the SHARED dev DB) and competes with everything
  // else using it. The hermetic harness provisions a private DB and is the
  // authoritative way to run this suite.
  console.log(
    "website-inquiry-forms: DB-backed steps use DATABASE_URL — bare runs hit the shared dev DB (contention-sized latencies); prefer `npm test -- --file=tests/website-inquiry-forms.test.ts`",
  );

  // ---- bounded vendor-adapter contracts (all external calls stubbed) ----
  const verifyArgs = {
    token: "valid-token",
    remoteIp: "127.0.0.1",
    expectedHostnames: ["127.0.0.1"],
  };
  let recaptchaFetches = 0;
  const validVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => "test-site-key",
    getSecretKey: () => "test-secret-key",
    fetchImpl: async () => {
      recaptchaFetches += 1;
      return new Response(
        JSON.stringify({ success: true, hostname: "127.0.0.1" }),
        { status: 200 },
      );
    },
  });
  assert(
    validVerification.ok && recaptchaFetches === 1,
    "reCAPTCHA adapter accepts one stubbed successful verification",
  );
  const replayVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => "test-site-key",
    getSecretKey: () => "test-secret-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        }),
        { status: 200 },
      ),
  });
  assert(
    !replayVerification.ok &&
      replayVerification.reason === "invalid_or_expired",
    "reCAPTCHA adapter fails closed on expired/replayed tokens",
  );
  const invalidSecretVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => "test-site-key",
    getSecretKey: () => "test-secret-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["invalid-input-secret"],
        }),
        { status: 200 },
      ),
  });
  assert(
    !invalidSecretVerification.ok &&
      invalidSecretVerification.reason === "misconfigured",
    "reCAPTCHA adapter classifies a rejected secret key as operator configuration failure",
  );
  const hostnameMismatchVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => "test-site-key",
    getSecretKey: () => "test-secret-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ success: true, hostname: "attacker.example" }),
        { status: 200 },
      ),
  });
  assert(
    !hostnameMismatchVerification.ok &&
      hostnameMismatchVerification.reason === "hostname_mismatch",
    "reCAPTCHA adapter rejects a Google-verified hostname outside the configured deployment set",
  );
  let misconfiguredFetches = 0;
  const misconfiguredVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => null,
    getSecretKey: () => null,
    fetchImpl: async () => {
      misconfiguredFetches += 1;
      return new Response("{}", { status: 200 });
    },
  });
  assert(
    !misconfiguredVerification.ok &&
      misconfiguredVerification.reason === "misconfigured" &&
      misconfiguredFetches === 0,
    "reCAPTCHA adapter fails closed without making a request when configuration is missing",
  );
  const timeoutVerification = await verifyRecaptchaToken(verifyArgs, {
    getSiteKey: () => "test-site-key",
    getSecretKey: () => "test-secret-key",
    timeoutMs: 5,
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      })) as typeof fetch,
  });
  assert(
    !timeoutVerification.ok && timeoutVerification.reason === "timeout",
    "reCAPTCHA adapter aborts a timed-out verification and fails closed",
  );

  // The website relay has an at-most-once contract. Its transport must not
  // inherit the shared Slack 429 retry loop after an uncertain outcome.
  const originalFetch = global.fetch;
  let oneAttemptSlackCalls = 0;
  let oneAttemptSlackError = "";
  try {
    await setSlackToken(`xoxb-test-${TAG}`, undefined);
    __resetSlackAuthBreakerForTest();
    global.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.includes("slack.com/api/chat.postMessage")) {
        throw new Error(`Unexpected fetch in one-attempt Slack test: ${url}`);
      }
      oneAttemptSlackCalls += 1;
      return new Response(JSON.stringify({ ok: false }), {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }) as typeof fetch;
    try {
      await postMessageOnce("C-ONCE", "one attempt");
    } catch (error) {
      oneAttemptSlackError =
        error instanceof Error ? error.message : String(error);
    }
  } finally {
    global.fetch = originalFetch;
  }
  assert(
    oneAttemptSlackCalls === 1 &&
      oneAttemptSlackError.includes("rate_limited"),
    "Slack one-attempt transport surfaces 429 without retrying chat.postMessage",
  );

  const relayArgs: WebsiteInquirySlackArgs = {
    inquiryId: `relay-${TAG}`,
    fullName: "Relay <Tester>",
    email: `${TAG}-relay@example.com`,
    phone: "(555) 010-8888",
    message: "Please call about <@U123> & next steps.",
    sourcePage: "/",
    sourceHost: "nobullmarketing.com",
  };
  const formattedRelay = buildWebsiteInquirySlackMessage(relayArgs);
  assert(
    formattedRelay.includes(`Inquiry ID: \`${relayArgs.inquiryId}\``) &&
      formattedRelay.includes(relayArgs.email) &&
      formattedRelay.includes("&lt;@U123&gt;") &&
      !formattedRelay.includes("<@U123>"),
    "Slack relay message includes inquiry context and escapes visitor-controlled mentions",
  );

  __resetWebsiteInquirySlackStateForTest();
  const exactChannelPosts: Array<{ channel: string; text: string }> = [];
  const exactChannelResult = await relayWebsiteInquiryToSlack(relayArgs, {
    probeConnection: async () => ({ outcome: "connected" }),
    listChannels: async () => [
      {
        id: "C-GENERAL",
        name: "general",
        is_member: true,
        is_private: false,
        num_members: 10,
      },
      {
        id: "C-BACKUP",
        name: "sales-calls-backup",
        is_member: true,
        is_private: false,
        num_members: 2,
      },
      {
        id: "C-SALES",
        name: " Sales-Calls ",
        is_member: true,
        is_private: false,
        num_members: 4,
      },
    ],
    postMessage: async (channel, text) => {
      exactChannelPosts.push({ channel, text });
    },
  });
  assert(
    exactChannelResult.status === "delivered" &&
      exactChannelPosts.length === 1 &&
      exactChannelPosts[0]?.channel === "C-SALES",
    "Slack relay resolves only the exact normalized sales-calls channel and posts once",
  );

  __resetWebsiteInquirySlackStateForTest();
  let fallbackPosts = 0;
  const noMembershipResult = await relayWebsiteInquiryToSlack(relayArgs, {
    probeConnection: async () => ({ outcome: "connected" }),
    listChannels: async () => [
      {
        id: "C-GENERAL",
        name: "general",
        is_member: true,
        is_private: false,
        num_members: 10,
      },
      {
        id: "C-SALES-NO-MEMBER",
        name: "sales-calls",
        is_member: false,
        is_private: false,
        num_members: 4,
      },
    ],
    postMessage: async () => {
      fallbackPosts += 1;
    },
  });
  assert(
    noMembershipResult.status === "failed" && fallbackPosts === 0,
    "Slack relay does not fall back when the bot is not a sales-calls member",
  );

  __resetWebsiteInquirySlackStateForTest();
  let timeoutPostAttempts = 0;
  let timeoutSignalAborted = false;
  // The production timeout is deliberately unref'ed. Keep this test process
  // referenced until the awaited result settles so the remaining browser e2e
  // assertions cannot false-pass via natural Node exit.
  const timeoutTestKeepAlive = setInterval(() => {}, 25);
  let slackTimeoutResult: WebsiteInquirySlackResult;
  try {
    slackTimeoutResult = await relayWebsiteInquiryToSlack(relayArgs, {
      probeConnection: async () => ({ outcome: "connected" }),
      listChannels: async () => [
        {
          id: "C-SALES",
          name: "sales-calls",
          is_member: true,
          is_private: false,
          num_members: 4,
        },
      ],
      timeoutMs: 5,
      postMessage: (_channel, _text, signal) => {
        timeoutPostAttempts += 1;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              timeoutSignalAborted = true;
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    });
  } finally {
    clearInterval(timeoutTestKeepAlive);
  }
  assert(
    slackTimeoutResult.status === "failed" &&
      timeoutPostAttempts === 1 &&
      timeoutSignalAborted,
    "uncertain Slack timeout aborts one attempt and never retries",
  );

  // ---- in-process app: real marketing middleware + real inquiry route ----
  const verifiedTokens: string[] = [];
  const verifiedAllowedHostSets: Array<readonly string[]> = [];
  const slackKickCalls: WebsiteInquirySlackArgs[] = [];
  const slackStoredBeforeKick: boolean[] = [];
  const pendingSlackKicks: Promise<WebsiteInquirySlackResult>[] = [];
  const app = express();
  app.use(express.json());
  registerMarketingSite(app);
  registerWebsiteRoutes(app, {
    getRecaptchaSiteKey: () => "test-public-site-key",
    verifyRecaptcha: async ({ token, expectedHostnames }) => {
      verifiedTokens.push(token);
      verifiedAllowedHostSets.push([...expectedHostnames]);
      if (!token) return { ok: false, reason: "missing_token" };
      if (token === "expired-or-replayed-token") {
        return { ok: false, reason: "invalid_or_expired" };
      }
      if (token === "hostname-mismatch-token") {
        return { ok: false, reason: "hostname_mismatch" };
      }
      if (token === "timeout-token") {
        return { ok: false, reason: "timeout" };
      }
      if (token === "misconfigured-token") {
        return { ok: false, reason: "misconfigured" };
      }
      return { ok: true };
    },
    kickContactSlackRelay: (args) => {
      slackKickCalls.push(args);
      const pending = inquiriesByEmail(args.email).then((rows) => {
        slackStoredBeforeKick.push(
          rows.some((row) => row.id === args.inquiryId),
        );
        return { status: "delivered" as const, reason: null };
      });
      pendingSlackKicks.push(pending);
      return pending;
    },
  });
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const previewBase = `${base}${MARKETING_PREVIEW_PATH}`;
  const originalReplitDomains = process.env.REPLIT_DOMAINS;

  let browser: { close(): Promise<void> } | null = null;
  try {
    // ---- public configuration + server-side fail-closed boundaries ----
    const configResponse = await fetch(
      `${base}/api/website/inquiry/config`,
    );
    const configBody = (await configResponse.json()) as Record<string, unknown>;
    assert(
      configResponse.status === 200 &&
        JSON.stringify(Object.keys(configBody)) ===
          JSON.stringify(["recaptchaSiteKey"]) &&
        configBody.recaptchaSiteKey === "test-public-site-key" &&
        !JSON.stringify(configBody).toLowerCase().includes("secret"),
      "public inquiry configuration exposes only the bounded reCAPTCHA site key",
    );
    assert(
      String(configResponse.headers.get("cache-control")).includes("no-store"),
      "public reCAPTCHA configuration is not cached across deployments",
    );

    const postBoundaryInquiry = async (
      token: string | undefined,
      suffix: string,
      forwardedHost?: string,
    ): Promise<{ status: number; error: string }> => {
      const response = await fetch(`${base}/api/website/inquiry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(forwardedHost
            ? { "X-Forwarded-Host": forwardedHost }
            : {}),
        },
        body: JSON.stringify({
          kind: "contact",
          fullName: "reCAPTCHA Boundary Tester",
          email: `${TAG}-${suffix}@example.com`,
          phone: "(555) 010-2222",
          message: `reCAPTCHA boundary ${suffix} ${TAG}`,
          page: "/",
          website: "",
          ...(token === undefined ? {} : { recaptchaToken: token }),
        }),
      });
      const body = (await response.json()) as { error?: string };
      return { status: response.status, error: body.error ?? "" };
    };

    process.env.REPLIT_DOMAINS = [
      "Preview.Example.",
      originalReplitDomains || "",
    ].filter(Boolean).join(",");
    const missingBoundary = await postBoundaryInquiry(
      undefined,
      "missing-token",
    );
    const replayBoundary = await postBoundaryInquiry(
      "expired-or-replayed-token",
      "replayed-token",
    );
    const timeoutBoundary = await postBoundaryInquiry(
      "timeout-token",
      "timeout-token",
    );
    const misconfiguredBoundary = await postBoundaryInquiry(
      "misconfigured-token",
      "misconfigured-token",
    );
    const hostnameMismatchBoundary = await postBoundaryInquiry(
      "hostname-mismatch-token",
      "hostname-mismatch-token",
      "attacker.example",
    );
    assert(
      missingBoundary.status === 400 &&
        missingBoundary.error.includes("complete the security check"),
      `missing reCAPTCHA token fails closed with recovery copy (${missingBoundary.status}: ${missingBoundary.error})`,
    );
    assert(
      replayBoundary.status === 403 &&
        replayBoundary.error.includes("refresh it and try again"),
      `expired/replayed reCAPTCHA token fails closed (${replayBoundary.status}: ${replayBoundary.error})`,
    );
    assert(
      timeoutBoundary.status === 503 &&
        timeoutBoundary.error.includes("took too long"),
      `timed-out reCAPTCHA verification fails closed (${timeoutBoundary.status}: ${timeoutBoundary.error})`,
    );
    assert(
      misconfiguredBoundary.status === 503 &&
        misconfiguredBoundary.error.includes("temporarily unavailable"),
      `misconfigured reCAPTCHA verification fails closed (${misconfiguredBoundary.status}: ${misconfiguredBoundary.error})`,
    );
    assert(
      hostnameMismatchBoundary.status === 403 &&
        hostnameMismatchBoundary.error.includes("refresh it and try again"),
      `unapproved reCAPTCHA hostname fails closed (${hostnameMismatchBoundary.status}: ${hostnameMismatchBoundary.error})`,
    );
    const boundaryRows = await getDb()
      .select()
      .from(websiteInquiries)
      .where(like(websiteInquiries.email, `${TAG}-%token@example.com`));
    assert(
      boundaryRows.length === 0 && slackKickCalls.length === 0,
      "all reCAPTCHA failure boundaries create no inquiry and start no Slack relay",
    );
    assert(
      verifiedAllowedHostSets.length === 5 &&
        verifiedAllowedHostSets.every(
          (hostnames) =>
            hostnames.includes("preview.example") &&
            !hostnames.includes("preview.example.") &&
            !hostnames.includes("attacker.example"),
        ),
      "reCAPTCHA hostname trust set normalizes configured hosts and never trusts spoofable forwarded-host headers",
    );
    __resetWebsiteInquiryLimiterForTest();

    // ---- bundle serving sanity + PR4 stamp stays internal ----
    const home = await fetch(`${previewBase}/`);
    assert(home.status === 200, `preview homepage serves the committed bundle (${home.status})`);
    const homeHtml = await home.text();
    assert(
      (homeHtml.match(/data-nb-inquiry="contact"/g) ?? []).length === 1,
      "homepage renders exactly one canonical contact inquiry form",
    );
    assert(
      ['for="nb-contact-name"', 'for="nb-contact-email"', 'for="nb-contact-phone"', 'for="nb-contact-message"']
        .every((label) => homeHtml.includes(label)) &&
        ['name="fullName"', 'name="email"', 'name="phone"', 'name="message"']
          .every((field) => homeHtml.includes(field)),
      "homepage contact form keeps visible labels paired with all four required fields",
    );
    assert(
      homeHtml.includes('name="website"') &&
        homeHtml.includes("data-nb-captcha") &&
        homeHtml.includes('data-nb-form-msg role="status" aria-live="polite"'),
      "homepage contact form exposes the honeypot, reCAPTCHA mount, and polite live status",
    );
    assert(
      homeHtml.includes('href="#contact">Contact</a>'),
      "homepage footer Contact link targets the stable #contact destination",
    );
    assert(
      homeHtml.includes('id="booking"') &&
        homeHtml.includes('class="nb-booking-handoff"') &&
        /href="https:\/\/calendly\.com\/[^"]+" target="_blank" rel="noopener" aria-describedby="nb-booking-external">View Available Times/.test(homeHtml),
      "homepage booking destination uses a compact canonical external handoff",
    );
    assert(
      !homeHtml.includes("calendly-inline-widget") &&
        !homeHtml.includes("assets.calendly.com") &&
        homeHtml.includes(
          "JavaScript is off — that’s okay. The scheduling button above still works.",
        ),
      "homepage booking destination has no embedded scheduler dependency and keeps a no-JavaScript path",
    );
    const stampRes = await fetch(`${previewBase}/build-manifest.json`);
    assert(
      stampRes.status === 404,
      `build-manifest.json freshness stamp is an INTERNAL bundle file (got ${stampRes.status})`,
    );
    // Task #5092: retired /contact/ and /book-free-demo/ are excluded from
    // the sitemap manifest — they redirect to homepage anchors and must not
    // be indexed as standalone pages.
    const sitemapManifest = JSON.parse(
      fs.readFileSync("website/public/sitemap-pages.json", "utf8"),
    ) as Array<{ path: string }>;
    assert(
      !sitemapManifest.some((p) => p.path === "contact/"),
      "sitemap manifest excludes retired /contact/ (Task #5092)",
    );
    assert(
      !sitemapManifest.some((p) => p.path === "book-free-demo/"),
      "sitemap manifest excludes retired /book-free-demo/ (Task #5092)",
    );
    assert(
      !fs.existsSync("website/public/book-free-demo") &&
        !fs.existsSync("website/public/contact"),
      "retired conversion-page directories are absent from committed output",
    );

    // ---- headless chromium ----
    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const b = browser as Awaited<ReturnType<typeof puppeteer.launch>>;
    const page = await b.newPage();
    // tsx/esbuild-compiled evaluate callbacks reference an __name helper.
    await page.evaluateOnNewDocument("window.__name = (f) => f;");
    // Static Revenue Engine path — deterministic, no 144-frame fetch storm.
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);

    // Determinism: stub the reCAPTCHA browser API and abort every other
    // non-local request (Typekit, Calendly, Vimeo…). Count inquiry POSTs.
    let inquiryPosts = 0;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      let host = "";
      let pathname = "";
      try {
        const u = new URL(req.url());
        host = u.hostname;
        pathname = u.pathname;
      } catch {
        /* non-URL request (data:) — let it through */
      }
      if (
        host === "www.google.com" &&
        pathname === "/recaptcha/api.js"
      ) {
        void req.respond({
          status: 200,
          contentType: "application/javascript",
          body: `
            (() => {
              let activeCallback = null;
              let apiReady = false;
              window.grecaptcha = {
                ready(callback) {
                  setTimeout(() => {
                    apiReady = true;
                    callback();
                  }, 25);
                },
                render(element, options) {
                  if (!apiReady) throw new Error("render called before reCAPTCHA ready");
                  activeCallback = options.callback;
                  element.setAttribute("data-test-widget", "rendered");
                  return 0;
                },
                reset() {}
              };
              window.__nbCompleteRecaptcha = (token) => {
                if (activeCallback) activeCallback(token);
              };
            })();
          `,
        }).catch(() => {});
        return;
      }
      if (host && host !== "127.0.0.1") {
        req.abort().catch(() => {});
        return;
      }
      if (req.method() === "POST" && pathname === "/api/website/inquiry") {
        inquiryPosts += 1;
      }
      req.continue().catch(() => {});
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    // Raw statuses of every /api/website/inquiry response — surfaced in
    // outcome-assert failures (e.g. a 500 under DB contention).
    const inquiryResponses: string[] = [];
    page.on("response", (res) => {
      try {
        if (new URL(res.url()).pathname === "/api/website/inquiry") {
          inquiryResponses.push(String(res.status()));
        }
      } catch {
        /* non-URL response — ignore */
      }
    });

    // Terminal-state outcome reader: the shared module clears .ok/.err
    // synchronously when a flight starts ("Sending…" carries no class) and
    // stamps exactly one of them when it ends, on BOTH page classes. Reading
    // whichever state actually lands makes an unexpected server error fail
    // its assert with the real visitor-facing copy (plus raw response
    // statuses) instead of an opaque waitForFunction timeout.
    const waitForFormOutcome = async (
      msgSelector: string,
      timeoutMs: number,
    ): Promise<{ kind: "ok" | "err" | "none"; text: string }> => {
      try {
        await page.waitForFunction(
          (sel: string) => {
            const el = document.querySelector(sel);
            return (
              !!el &&
              (el.classList.contains("ok") || el.classList.contains("err")) &&
              (el.textContent || "").trim() !== ""
            );
          },
          { timeout: timeoutMs },
          msgSelector,
        );
      } catch {
        return {
          kind: "none",
          text: `<no terminal ok/err state within ${timeoutMs}ms; inquiry responses=[${inquiryResponses.join(",")}]>`,
        };
      }
      return page.$eval(msgSelector, (el) => ({
        kind: el.classList.contains("ok") ? ("ok" as const) : ("err" as const),
        text: (el.textContent || "").trim(),
      }));
    };
    const waitForRecaptcha = async (): Promise<void> => {
      await page.waitForSelector(
        '[data-nb-captcha][data-nb-captcha-ready="true"]',
        { timeout: 15_000 },
      );
    };
    const completeRecaptcha = async (token: string): Promise<void> => {
      await page.evaluate((value: string) => {
        (
          window as typeof window & {
            __nbCompleteRecaptcha?: (token: string) => void;
          }
        ).__nbCompleteRecaptcha?.(value);
      }, token);
    };

    // =====================================================================
    // Homepage #contact — form[data-nb-inquiry="contact"] via home.js.
    // /book-free-demo/ is now a retired route that 301-redirects to
    // /#booking; this block exercises the same shared-contract coverage
    // (validation, reCAPTCHA, persistence, honeypot) on the canonical
    // homepage form that replaced it.
    // =====================================================================
    console.log("\n— homepage #contact (home.js, shared contract, full coverage) —");
    await page.goto(`${previewBase}/#contact`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector('form[data-nb-inquiry="contact"] button[type=submit]', {
      timeout: 15000,
    });
    await waitForRecaptcha();
    const readyMessage = await page.$eval(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      (el) => (el.textContent || "").trim(),
    );
    assert(
      readyMessage === "",
      `homepage #contact clears the loading copy once reCAPTCHA is ready (got ${JSON.stringify(readyMessage)})`,
    );

    // 2. Empty submit → client-side validation, no network call.
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const demoEmpty = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      VALIDATION_OUTCOME_TIMEOUT_MS,
    );
    assert(
      demoEmpty.kind === "err" &&
        demoEmpty.text.includes("Please fill in your name, email, phone, and message."),
      `homepage #contact empty submit shows client-side validation (got ${demoEmpty.kind}: ${JSON.stringify(demoEmpty.text)})`,
    );
    assert(inquiryPosts === 0, `homepage #contact client-side validation makes NO network call (posts=${inquiryPosts})`);

    // 3. Invalid email → passes the non-empty client check, server zod 400
    //    renders verbatim in [data-nb-form-msg].err.
    await page.type('form[data-nb-inquiry="contact"] input[name="fullName"]', "PR5 Demo Tester");
    await page.type('form[data-nb-inquiry="contact"] input[name="email"]', "not-an-email");
    await page.type('form[data-nb-inquiry="contact"] input[name="phone"]', "(555) 010-6666");
    await page.type('form[data-nb-inquiry="contact"] textarea[name="message"]', `Demo err e2e ${TAG}`);
    await completeRecaptcha("valid-zod-token");
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const demoErr = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      demoErr.kind === "err" &&
        demoErr.text.includes("Please check the form fields and try again."),
      `server 400 renders verbatim on the homepage #contact form (got ${demoErr.kind}: ${JSON.stringify(demoErr.text)}; inquiry responses=[${inquiryResponses.join(",")}])`,
    );
    assert(inquiryPosts === 1, `invalid-email submit DID hit the server (posts=${inquiryPosts})`);

    // 4. A valid form without a completed challenge stays client-side.
    const demoEmail = `${TAG}-demo@example.com`;
    await page.$eval('form[data-nb-inquiry="contact"] input[name="email"]', (el) => {
      (el as HTMLInputElement).value = "";
    });
    await page.type('form[data-nb-inquiry="contact"] input[name="email"]', demoEmail);
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const missingChallenge = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      VALIDATION_OUTCOME_TIMEOUT_MS,
    );
    assert(
      missingChallenge.kind === "err" &&
        missingChallenge.text.includes("complete the security check"),
      `missing browser challenge shows recovery copy (got ${missingChallenge.kind}: ${JSON.stringify(missingChallenge.text)})`,
    );
    assert(
      inquiryPosts === 1,
      `missing browser challenge makes NO network call (posts=${inquiryPosts})`,
    );

    // 5. An expired/replayed token reaches the server, fails closed, stores
    //    nothing, and starts no Slack relay.
    await completeRecaptcha("expired-or-replayed-token");
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const replayedChallenge = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      replayedChallenge.kind === "err" &&
        replayedChallenge.text.includes("refresh it and try again"),
      `expired/replayed browser challenge renders server recovery copy (got ${replayedChallenge.kind}: ${JSON.stringify(replayedChallenge.text)})`,
    );
    assert(
      inquiryPosts === 2,
      `expired/replayed challenge POSTed exactly once (posts=${inquiryPosts})`,
    );
    assert(
      (await inquiriesByEmail(demoEmail)).length === 0 &&
        slackKickCalls.length === 0,
      "expired/replayed challenge stores no row and starts no Slack relay",
    );

    // 6-interim. Valid submit through the homepage form — persists a row
    //    attributed to the homepage; this is the first of the two homepage
    //    contact POSTs in this suite's 6/min budget.
    await completeRecaptcha("valid-demo-token");
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const demoOk = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      demoOk.kind === "ok" && demoOk.text.includes("Thank you!"),
      `valid homepage #contact submit renders data-success copy (got ${demoOk.kind}: ${JSON.stringify(demoOk.text)}; inquiry responses=[${inquiryResponses.join(",")}])`,
    );
    assert(inquiryPosts === 3, `homepage #contact valid submit POSTed (total posts=${inquiryPosts})`);
    const demoRows = await inquiriesByEmail(demoEmail);
    assert(demoRows.length === 1, `inquiry persisted exactly one row (${demoRows.length})`);
    assert(demoRows[0]?.kind === "contact", `kind is "contact" (${demoRows[0]?.kind})`);
    assert(
      demoRows[0]?.sourcePage === `${MARKETING_PREVIEW_PATH}/`,
      `sourcePage attributes the homepage (${demoRows[0]?.sourcePage})`,
    );
    assert(demoRows[0]?.fullName === "PR5 Demo Tester", "fullName round-trips");

    // 7. Honeypot → server plays along ({ok:true}), UI shows success, NO
    //    row. Reload the homepage to get a fresh form state.
    const honeyEmail = `${TAG}-honeypot@example.com`;
    await page.goto(`${previewBase}/#contact`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector('form[data-nb-inquiry="contact"] button[type=submit]', {
      timeout: 15000,
    });
    await waitForRecaptcha();
    await page.type('form[data-nb-inquiry="contact"] input[name="fullName"]', "PR5 Honeypot Bot");
    await page.type('form[data-nb-inquiry="contact"] input[name="email"]', honeyEmail);
    await page.type('form[data-nb-inquiry="contact"] input[name="phone"]', "(555) 010-5555");
    await page.type('form[data-nb-inquiry="contact"] textarea[name="message"]', `Honeypot e2e ${TAG}`);
    await page.$eval(
      'form[data-nb-inquiry="contact"] input[name="website"]',
      (el) => {
        (el as HTMLInputElement).value = "https://spam.example.com";
      },
    );
    const verificationsBeforeHoneypot = verifiedTokens.length;
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const honeyOutcome = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      honeyOutcome.kind === "ok",
      `honeypot submit renders success to the bot (got ${honeyOutcome.kind}: ${JSON.stringify(honeyOutcome.text)}; inquiry responses=[${inquiryResponses.join(",")}])`,
    );
    assert(inquiryPosts === 4, `honeypot submit still POSTs (bots see success) (posts=${inquiryPosts})`);
    const honeyRows = await inquiriesByEmail(honeyEmail);
    assert(honeyRows.length === 0, `honeypot submission is NOT persisted (${honeyRows.length} rows)`);
    assert(
      verifiedTokens.length === verificationsBeforeHoneypot &&
        slackKickCalls.length === 1,
      "honeypot bypasses reCAPTCHA verification and starts no Slack relay",
    );

    // =====================================================================
    // /unsubscribe/ — form[data-nb-inquiry="unsubscribe"] via site.js:
    // email-only form, so validation scopes to the fields it renders
    // =====================================================================
    console.log("\n— /unsubscribe/ (site.js, shared contract) —");
    await page.goto(`${previewBase}/unsubscribe/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector('form[data-nb-inquiry="unsubscribe"] button[type=submit]', {
      timeout: 15000,
    });

    // 8. Empty submit → validation names ONLY the email field.
    await page.click('form[data-nb-inquiry="unsubscribe"] button[type=submit]');
    const unsubEmpty = await waitForFormOutcome(
      'form[data-nb-inquiry="unsubscribe"] .form-msg',
      VALIDATION_OUTCOME_TIMEOUT_MS,
    );
    assert(
      unsubEmpty.kind === "err" && unsubEmpty.text.includes("Please fill in your email."),
      `unsubscribe empty submit validates only its rendered field (got ${unsubEmpty.kind}: ${JSON.stringify(unsubEmpty.text)})`,
    );
    assert(inquiryPosts === 4, `unsubscribe client-side validation makes NO network call (posts=${inquiryPosts})`);

    // 9. Valid submit → kind="unsubscribe" row + this page's data-success.
    const unsubEmail = `${TAG}-unsub@example.com`;
    await page.type('form[data-nb-inquiry="unsubscribe"] input[name="email"]', unsubEmail);
    await page.click('form[data-nb-inquiry="unsubscribe"] button[type=submit]');
    const unsubOk = await waitForFormOutcome(
      'form[data-nb-inquiry="unsubscribe"] .form-msg',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      unsubOk.kind === "ok" && unsubOk.text.includes("been unsubscribed"),
      `unsubscribe success renders that form's data-success copy (got ${unsubOk.kind}: ${JSON.stringify(unsubOk.text)}; inquiry responses=[${inquiryResponses.join(",")}])`,
    );
    assert(inquiryPosts === 5, `unsubscribe valid submit POSTed (total posts=${inquiryPosts}, within the 6/min rate limit)`);
    const unsubRows = await inquiriesByEmail(unsubEmail);
    assert(unsubRows.length === 1, `unsubscribe request persisted exactly one row (${unsubRows.length})`);
    assert(unsubRows[0]?.kind === "unsubscribe", `unsubscribe kind round-trips (${unsubRows[0]?.kind})`);

    // =====================================================================
    // Retired /book-free-demo/ and /contact/ redirect assertions (server
    // boundary, no browser navigation needed) + final homepage contact POST.
    // =====================================================================
    console.log("\n— retired route redirects + final homepage contact POST —");
    // 8a. /book-free-demo/ permanently redirects to /#booking (fetch follows
    //     redirects by default, so check via a no-redirect HEAD-alike approach
    //     using the already-running in-process server).
    const bookFreeRes = await fetch(`${previewBase}/book-free-demo/`, {
      redirect: "manual",
    });
    assert(
      bookFreeRes.status === 301,
      `/book-free-demo/ returns 301 on the preview path (got ${bookFreeRes.status})`,
    );
    assert(
      bookFreeRes.headers.get("location") === `${MARKETING_PREVIEW_PATH}/#booking`,
      `/book-free-demo/ redirects to preview /#booking (got ${bookFreeRes.headers.get("location")})`,
    );

    // 8b. /contact/ permanently redirects to /#contact.
    const contactRedirectRes = await fetch(`${previewBase}/contact/`, {
      redirect: "manual",
    });
    assert(
      contactRedirectRes.status === 301,
      `/contact/ returns 301 on the preview path (got ${contactRedirectRes.status})`,
    );
    assert(
      contactRedirectRes.headers.get("location") === `${MARKETING_PREVIEW_PATH}/#contact`,
      `/contact/ redirects to preview /#contact (got ${contactRedirectRes.headers.get("location")})`,
    );

    // 8c. Query strings precede the fragment in the redirect Location.
    const bookFreeQueryRes = await fetch(
      `${previewBase}/book-free-demo/?utm_source=test`,
      { redirect: "manual" },
    );
    assert(
      bookFreeQueryRes.headers.get("location") ===
        `${MARKETING_PREVIEW_PATH}/?utm_source=test#booking`,
      `/book-free-demo/?utm_source=test → query before fragment (got ${bookFreeQueryRes.headers.get("location")})`,
    );

    // 8d. Final homepage contact POST (6th and last of the 6/min budget).
    //     The page is already on the homepage from the honeypot reload above.
    await page.goto(`${previewBase}/#contact`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    assert(
      new URL(page.url()).hash === "#contact",
      `direct homepage fragment load retains #contact (landed on ${page.url()})`,
    );
    await page.waitForSelector('form[data-nb-inquiry="contact"] button[type=submit]', {
      timeout: 15000,
    });
    await waitForRecaptcha();
    const contactEmail = `${TAG}-homepage-contact@example.com`;
    await page.type('form[data-nb-inquiry="contact"] input[name="fullName"]', "Homepage Contact Tester");
    await page.type('form[data-nb-inquiry="contact"] input[name="email"]', contactEmail);
    await page.type('form[data-nb-inquiry="contact"] input[name="phone"]', "(555) 010-7777");
    await page.type('form[data-nb-inquiry="contact"] textarea[name="message"]', `Homepage contact e2e ${TAG}`);
    await completeRecaptcha("valid-contact-token");
    await page.click('form[data-nb-inquiry="contact"] button[type=submit]');
    const contactOk = await waitForFormOutcome(
      'form[data-nb-inquiry="contact"] [data-nb-form-msg]',
      POST_OUTCOME_TIMEOUT_MS,
    );
    assert(
      contactOk.kind === "ok" && contactOk.text.includes("Thank you!"),
      `homepage valid submit renders its data-success copy (got ${contactOk.kind}: ${JSON.stringify(contactOk.text)}; inquiry responses=[${inquiryResponses.join(",")}])`,
    );
    assert(
      inquiryPosts === 6,
      `homepage contact submit POSTed (total posts=${inquiryPosts} — exactly 6, at the production rate limit)`,
    );
    const contactRows = await inquiriesByEmail(contactEmail);
    assert(contactRows.length === 1, `homepage inquiry persisted exactly one row (${contactRows.length})`);
    assert(contactRows[0]?.kind === "contact", `homepage kind is "contact" (${contactRows[0]?.kind})`);
    assert(
      contactRows[0]?.sourcePage === `${MARKETING_PREVIEW_PATH}/`,
      `homepage sourcePage attributes the homepage (${contactRows[0]?.sourcePage})`,
    );
    await Promise.allSettled(pendingSlackKicks);
    assert(
      slackKickCalls.length === 2 &&
        slackStoredBeforeKick.length === 2 &&
        slackStoredBeforeKick.every(Boolean),
      "each valid contact starts exactly one asynchronous Slack relay after its inquiry is durable",
    );

    if (pageErrors.length > 0) {
      // Diagnostics only — the cinematic/static bundle may warn, but form
      // assertions above are the contract.
      console.log(`  (page errors observed: ${pageErrors.slice(0, 5).join(" | ")})`);
    }
  } finally {
    if (originalReplitDomains === undefined) {
      delete process.env.REPLIT_DOMAINS;
    } else {
      process.env.REPLIT_DOMAINS = originalReplitDomains;
    }
    try {
      if (browser) await browser.close();
    } catch {
      /* browser already gone */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await getDb()
        .delete(websiteInquiries)
        .where(like(websiteInquiries.email, `%${TAG}%`));
    } catch (err) {
      console.error("website-inquiry-forms: cleanup failed", err);
    }
  }

  console.log(`\nwebsite-inquiry-forms: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("website-inquiry-forms: fatal", err);
  process.exit(1);
});
