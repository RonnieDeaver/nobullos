/* test-registration
{
  "name": "Booking free/busy transport (Task #929D)",
  "tier": "medium"
}
test-registration */
/**
 * Task #929D — Google Calendar free/busy transport fix.
 *
 * Pins three protections so the failure mode described in the task
 * (every Slot Preview / readiness probe returning Google's generic
 * HTML 404 from `POST .../calendar/v3/freebusy`) cannot regress:
 *
 *   1. The outbound request URL uses Google's documented camelCase
 *      slug `freeBusy` — not the lowercase `freebusy` variant that
 *      hits Google's generic 404 landing page.
 *   2. The request method, Content-Type, Authorization header, and
 *      JSON body shape match Google's documented contract for
 *      `POST https://www.googleapis.com/calendar/v3/freeBusy`.
 *   3. A non-JSON HTML response from googleapis is reported as a
 *      structured `CalendarTransportError` with classification
 *      `endpoint_misrouted` (so 929E can render an admin-only
 *      diagnostic) and a single-line warning that includes the
 *      status, request URL, and a short body snippet — NOT the
 *      whole HTML page.
 */

// Ensure token encryption has a key BEFORE any module that touches it loads.
process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY || "test-929d-token-encryption-key";

import { storage } from "../server/storage";
import {
  getFreeBusy,
  CalendarTransportError,
} from "../server/services/googleCalendarIntegration";
import { encryptToken } from "../server/utils/tokenCrypto";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

const TEST_USER_ID = "test-user-929d";

async function withMocks(
  fetchImpl: typeof fetch,
  consoleSink: string[],
  fn: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const realGetCred = (storage as any).getGoogleCalendarCredential;
  const realUpdateCred = (storage as any).updateGoogleCalendarCredential;
  const realWarn = console.warn;
  globalThis.fetch = fetchImpl as typeof fetch;
  // Pretend the user has a fully-valid, in-memory credential so
  // getValidAccessToken returns the encoded access token without
  // touching the DB or the OAuth refresh flow.
  (storage as any).getGoogleCalendarCredential = async () => ({
    userId: TEST_USER_ID,
    status: "connected",
    accessTokenEncrypted: encodeAccess("test-access-token-929d"),
    refreshTokenEncrypted: encodeAccess("test-refresh-token-929d"),
    tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    calendarId: "primary",
    scopes: "",
  });
  (storage as any).updateGoogleCalendarCredential = async () => undefined;
  console.warn = (...args: unknown[]) => {
    consoleSink.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    (storage as any).getGoogleCalendarCredential = realGetCred;
    (storage as any).updateGoogleCalendarCredential = realUpdateCred;
    console.warn = realWarn;
  }
}

function encodeAccess(plain: string): string {
  return encryptToken(plain);
}

async function main(): Promise<void> {
  section("1. Outbound free/busy request matches Google's documented shape");
  {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const okBody = JSON.stringify({
      kind: "calendar#freeBusy",
      timeMin: "2026-05-08T00:00:00.000Z",
      timeMax: "2026-05-09T00:00:00.000Z",
      calendars: {
        primary: {
          busy: [{ start: "2026-05-08T15:00:00Z", end: "2026-05-08T16:00:00Z" }],
        },
      },
    });
    const fetchImpl = (async (input: any, init: any) => {
      calls.push({ url: String(input), init });
      return new Response(okBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    let busy: Array<{ startUtc: Date; endUtc: Date }> = [];
    await withMocks(fetchImpl, [], async () => {
      busy = await getFreeBusy(
        TEST_USER_ID,
        new Date("2026-05-08T00:00:00Z"),
        new Date("2026-05-09T00:00:00Z"),
        ["primary"],
      );
    });

    assert(calls.length === 1, "exactly one outbound HTTP call was made");
    const call = calls[0];
    assert(
      call.url === "https://www.googleapis.com/calendar/v3/freeBusy",
      `request URL is the camelCase Google freeBusy endpoint (got ${call.url})`,
    );
    assert(
      !call.url.includes("freebusy"),
      "request URL does NOT use the lowercase 'freebusy' variant that triggers Google's HTML 404",
    );
    assert(
      String(call.init.method || "GET").toUpperCase() === "POST",
      `request method is POST (got ${call.init.method})`,
    );
    const headers = call.init.headers as Record<string, string>;
    assert(
      typeof headers?.Authorization === "string" &&
        headers.Authorization.startsWith("Bearer "),
      "request includes a Bearer Authorization header",
    );
    assert(
      headers?.["Content-Type"] === "application/json",
      "request sets Content-Type: application/json",
    );
    const body = JSON.parse(String(call.init.body));
    assert(
      body.timeMin === "2026-05-08T00:00:00.000Z" &&
        body.timeMax === "2026-05-09T00:00:00.000Z",
      "request body carries ISO timeMin/timeMax",
    );
    assert(
      Array.isArray(body.items) &&
        body.items.length === 1 &&
        body.items[0].id === "primary",
      "request body carries items: [{ id: 'primary' }]",
    );
    assert(
      busy.length === 1 &&
        busy[0].startUtc.toISOString() === "2026-05-08T15:00:00.000Z" &&
        busy[0].endUtc.toISOString() === "2026-05-08T16:00:00.000Z",
      "parsed busy intervals round-trip from Google's JSON response",
    );
  }

  section("2. HTML 404 response surfaces as CalendarTransportError(endpoint_misrouted)");
  {
    const htmlBody = `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <title>Error 404 (Not Found)!!1</title>
  <p>The requested URL <code>/calendar/v3/freebusy</code> was not found on this server. <ins>That's all we know.</ins>
</html>`;
    const fetchImpl = (async () =>
      new Response(htmlBody, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    const warnings: string[] = [];
    let thrown: unknown = null;
    await withMocks(fetchImpl, warnings, async () => {
      try {
        await getFreeBusy(
          TEST_USER_ID,
          new Date("2026-05-08T00:00:00Z"),
          new Date("2026-05-09T00:00:00Z"),
          ["primary"],
        );
      } catch (err) {
        thrown = err;
      }
    });

    assert(
      thrown instanceof CalendarTransportError,
      "throws CalendarTransportError when Google returns HTML",
    );
    if (thrown instanceof CalendarTransportError) {
      assert(
        thrown.classification === "endpoint_misrouted",
        `classification is endpoint_misrouted (got ${thrown.classification})`,
      );
      assert(
        thrown.httpStatus === 404,
        `httpStatus is 404 (got ${thrown.httpStatus})`,
      );
      assert(
        thrown.requestUrl === "https://www.googleapis.com/calendar/v3/freeBusy",
        "requestUrl on the error is the actual outbound URL",
      );
      assert(
        thrown.bodySnippet.length <= 201 &&
          thrown.bodySnippet.includes("Error 404"),
        "bodySnippet is a short single-line excerpt of the HTML body, not the full page",
      );
      assert(
        !/\n/.test(thrown.bodySnippet),
        "bodySnippet contains no newlines (collapsed to single line)",
      );
    }
    assert(
      warnings.some(
        (w) =>
          w.includes("[GoogleCalendar] non-JSON response") &&
          w.includes("status=404") &&
          w.includes("url=https://www.googleapis.com/calendar/v3/freeBusy") &&
          w.includes("classification=endpoint_misrouted"),
      ),
      "single-line warning logs status, URL, and classification",
    );
    assert(
      warnings.every((w) => w.length < 600),
      "warning line stays bounded (< 600 chars) regardless of body size",
    );
    assert(
      warnings.every((w) => !/That's all we know\./.test(w)),
      "warning truncates the body before the trailing HTML — does not include full page",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("Test crashed:", err);
  process.exitCode = 1;
});
