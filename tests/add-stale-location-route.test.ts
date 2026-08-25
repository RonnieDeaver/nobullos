/* test-registration
{
  "name": "Add-stale-location route error contract + success (Tasks #2411 / #2419)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/geocodeLocationTextSetup.mjs",
    "--import",
    "./tests/helpers/onLocationChangedSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2411 — "Add to Command Panel" from a stale report row, end-to-end at
 * the route layer.
 *
 * Task #2408 shipped a pure unit test for the geocode failure CLASSIFIER
 * (`tests/geocode-failure-classification.test.ts`), but the operator-facing
 * error contract of the route that consumes it —
 * `POST /api/clients/:clientId/locations` — was only typecheck/code-review
 * verified, because the live stale-row UI needed specific client/report data
 * to reproduce. This pins that contract directly:
 *
 *   1. Missing / too-short address  → 400 with the clear "full street address
 *      is required" message, BEFORE the geocoder is ever consulted.
 *   2. Address that geocodes to ZERO_RESULTS (failureReason "not_found")
 *      → 400 "We couldn't find that address" (operator should fix their input).
 *   3. A system geocode fault (failureReason "system": quota / denied key /
 *      provider error) → 503 system message (NOT the operator's address).
 *
 * Task #2419 adds the SUCCESS path the above three only covered indirectly:
 *
 *   4. A good address that geocodes to real coordinates → 201 with the created
 *      location body, AND `storage.createClientLocation` is called with the
 *      geocoded fields plus the operator-UI audit metadata
 *      (actorUserId / source / reason).
 *
 * The geocoder is stubbed via a resolve-hook redirect of `server/mcu/geocoding`
 * to `tests/helpers/geocodeLocationTextStub.mjs` (registered through
 * `--import ./tests/helpers/geocodeLocationTextSetup.mjs`), because the route
 * reaches it through a dynamic `await import("../mcu/geocoding")` and ESM named
 * exports cannot be monkey-patched. `storage` client/user lookups are swapped
 * for in-memory stubs so the whole test runs with zero DB dependency.
 *
 * The first three asserted branches return before any location write, so the
 * MCU recompute timer never arms. The success path DOES write and would call
 * `onLocationChanged()` (server/mcu/worker.ts), which arms a 30s `setTimeout`
 * that would keep the process alive (a drain hang the run-all harness scores
 * as a SIGKILL). We neutralize it with the same resolve-hook trick: a redirect
 * of `server/mcu/worker` to `tests/helpers/onLocationChangedStub.mjs`
 * (registered through `--import ./tests/helpers/onLocationChangedSetup.mjs`)
 * turns `onLocationChanged` into a counting no-op, so the success test can
 * still prove the side effect fired without arming the real timer.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import { registerClientRoutes } from "../server/routes/clients";
import { storage } from "../server/storage";
import { closeDbPools } from "../server/db";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import {
  __setGeocodeLocationText,
  __resetGeocodeLocationText,
} from "./helpers/geocodeLocationTextStub.mjs";
import {
  __getOnLocationChangedCalls,
  __resetOnLocationChangedCalls,
} from "./helpers/onLocationChangedStub.mjs";

const CLIENT_ID = "client-2411";
const USER_ID = "user-2411-am";

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

// ---------------------------------------------------------------------------
// In-memory storage stubs — a real client owned by an account_manager so the
// access check passes with zero DB dependency.
// ---------------------------------------------------------------------------
const s = storage as any;
const originals: Record<string, any> = {};

function saveOriginal(name: string): void {
  if (!(name in originals)) originals[name] = s[name];
}

/** Number of times the (stubbed) geocoder was actually invoked. */
let geocodeCalls = 0;

function installStubs(): void {
  saveOriginal("getClient");
  s.getClient = async (id: string) =>
    id === CLIENT_ID ? { id: CLIENT_ID, ownerId: USER_ID, isDemo: false } : undefined;

  saveOriginal("getUser");
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2411@test.local",
          firstName: "Add",
          lastName: "Location",
          role: "account_manager",
        }
      : undefined;

  // Guard: if any asserted branch ever reached the location write, that would
  // be a regression in the route's pre-write validation order — fail loudly.
  saveOriginal("createClientLocation");
  s.createClientLocation = async () => {
    throw new Error(
      "createClientLocation must NOT be called for the missing-address / not_found / system branches",
    );
  };
}

function restoreStubs(): void {
  for (const [name, fn] of Object.entries(originals)) {
    s[name] = fn;
  }
  __resetGeocodeLocationText();
  __resetOnLocationChangedCalls();
}

/** A successful `GeocodedLocationData` with populated, real-looking coords. */
function successGeocode() {
  return {
    name: "Acme Law",
    address: "123 Main St, Dallas, TX 75201, USA",
    city: "Dallas",
    state: "TX",
    lat: 32.7791,
    lng: -96.7986,
    stateFips: "48",
    countyFips: "48113",
    geocodedAt: new Date("2026-06-09T00:00:00.000Z"),
    geocodeWarning: null,
    geocodeFailureReason: null,
  };
}

/** A failed `GeocodedLocationData` (no coordinates) with the given reason. */
function failedGeocode(reason: "not_found" | "system") {
  return {
    name: "Acme Law",
    address: null,
    city: null,
    state: null,
    lat: null,
    lng: null,
    stateFips: null,
    countyFips: null,
    geocodedAt: null,
    geocodeWarning: "Geocoding failed",
    geocodeFailureReason: reason,
  };
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------
async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    req.__test_clerkUserId = USER_ID;
    next();
  });
  registerClientRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postLocation(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/clients/${CLIENT_ID}/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON body is itself a failure the asserts will catch */
  }
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// 1. Missing / too-short address → 400 clear required message, no geocode call
// ---------------------------------------------------------------------------
async function testMissingAddress(): Promise<void> {
  console.log("\n— 1. Missing address returns the clear required message —");
  geocodeCalls = 0;
  __setGeocodeLocationText(async () => {
    geocodeCalls++;
    throw new Error("geocoder must not be consulted when address is missing");
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await postLocation(baseUrl, { name: "Acme Law" });
    check("missing address → 400", status === 400, `status=${status}`);
    check(
      "missing address → clear 'full street address is required' message",
      typeof json?.error === "string" &&
        /full street address is required/i.test(json.error),
      json?.error,
    );
    check(
      "missing address never consults the geocoder",
      geocodeCalls === 0,
      `geocodeCalls=${geocodeCalls}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. ZERO_RESULTS (not_found) → 400 "We couldn't find that address"
// ---------------------------------------------------------------------------
async function testNotFoundAddress(): Promise<void> {
  console.log("\n— 2. Unfindable address (ZERO_RESULTS) → 400 fix-your-input —");
  geocodeCalls = 0;
  __setGeocodeLocationText(async () => {
    geocodeCalls++;
    return failedGeocode("not_found");
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await postLocation(baseUrl, {
      name: "Acme Law",
      address: "123 Nowhere St, Nulltown, ZZ 00000",
    });
    check("not_found → 400", status === 400, `status=${status}`);
    check("not_found consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check(
      "not_found → operator-correctable \"couldn't find that address\" message",
      typeof json?.error === "string" && /couldn't find that address/i.test(json.error),
      json?.error,
    );
    check(
      "not_found does NOT use the system-fault wording",
      !(typeof json?.error === "string" && /system issue/i.test(json.error)),
      json?.error,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. System fault → 503 "system issue (not your address)"
// ---------------------------------------------------------------------------
async function testSystemFault(): Promise<void> {
  console.log("\n— 3. System geocode fault → 503 not-your-address —");
  geocodeCalls = 0;
  __setGeocodeLocationText(async () => {
    geocodeCalls++;
    return failedGeocode("system");
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await postLocation(baseUrl, {
      name: "Acme Law",
      address: "123 Main St, Dallas, TX 75201",
    });
    check("system fault → 503", status === 503, `status=${status}`);
    check("system fault consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check(
      "system fault → system-issue message (explicitly NOT the operator's address)",
      typeof json?.error === "string" &&
        /system issue/i.test(json.error) &&
        /not your address/i.test(json.error),
      json?.error,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Valid address → 201 with created body, audited write, no timer armed
// ---------------------------------------------------------------------------
async function testSuccess(): Promise<void> {
  console.log("\n— 4. Valid address geocodes and saves → 201 created —");
  geocodeCalls = 0;
  __resetOnLocationChangedCalls();

  const geocoded = successGeocode();
  __setGeocodeLocationText(async () => {
    geocodeCalls++;
    return geocoded;
  });

  // Capture exactly what the route persists, and return a created row (with a
  // db-assigned id) the way the real storage layer would.
  let captured: { data: any; audit: any } | null = null;
  const createdRow = { id: "loc-2419-created", isActive: true, ...{} };
  s.createClientLocation = async (data: any, audit: any) => {
    captured = { data, audit };
    return { ...data, id: createdRow.id };
  };

  await withApp(async (baseUrl) => {
    const { status, json } = await postLocation(baseUrl, {
      name: "Acme Law",
      address: "123 Main St, Dallas, TX 75201",
    });

    check("valid address → 201", status === 201, `status=${status}`);
    check("valid address consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check(
      "201 body is the created location (db-assigned id echoed back)",
      json?.id === createdRow.id,
      `id=${json?.id}`,
    );
    check(
      "201 body carries the geocoded coordinates",
      json?.lat === geocoded.lat && json?.lng === geocoded.lng,
      `lat=${json?.lat} lng=${json?.lng}`,
    );

    const d = (captured as any)?.data;
    check("createClientLocation was called", captured !== null);
    check(
      "createClientLocation got the geocoded name/address/city/state",
      d?.name === geocoded.name &&
        d?.address === geocoded.address &&
        d?.city === geocoded.city &&
        d?.state === geocoded.state,
      `name=${d?.name} address=${d?.address} city=${d?.city} state=${d?.state}`,
    );
    check(
      "createClientLocation got the geocoded coords + FIPS",
      d?.lat === geocoded.lat &&
        d?.lng === geocoded.lng &&
        d?.stateFips === geocoded.stateFips &&
        d?.countyFips === geocoded.countyFips,
      `lat=${d?.lat} lng=${d?.lng} stateFips=${d?.stateFips} countyFips=${d?.countyFips}`,
    );
    check(
      "createClientLocation got the route's clientId + isActive default",
      d?.clientId === CLIENT_ID && d?.isActive === true,
      `clientId=${d?.clientId} isActive=${d?.isActive}`,
    );

    const a = (captured as any)?.audit;
    check(
      "createClientLocation got the operator-UI audit metadata",
      a?.actorUserId === USER_ID &&
        a?.source === "operator_ui" &&
        typeof a?.reason === "string" &&
        a.reason.includes(`/api/clients/${CLIENT_ID}/locations`),
      `actorUserId=${a?.actorUserId} source=${a?.source} reason=${a?.reason}`,
    );

    check(
      "success path fired onLocationChanged() (timer neutralized by stub)",
      __getOnLocationChangedCalls() === 1,
      `calls=${__getOnLocationChangedCalls()}`,
    );
  });
}

async function main(): Promise<void> {
  installStubs();
  // requireAuth resolves the acting identity against its ambient public-schema
  // `db` import; this suite seeds users only in the in-memory storage stub, so
  // pre-register the profile in the module registry to keep the real middleware
  // in the loop without a JIT-provisioned public row.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2411@test.local",
    firstName: "Add",
    lastName: "Location",
    role: "account_manager",
  });
  try {
    await testMissingAddress();
    await testNotFoundAddress();
    await testSystemFault();
    await testSuccess();
  } finally {
    restoreStubs();
    __test_resetReconciledUsers();
  }

  // The local-server route fetches above go through Node's global `undici`
  // dispatcher, which keeps ref'd keep-alive sockets open to 127.0.0.1 after
  // each request. Those linger past `server.close()` and would keep the event
  // loop alive (a drain hang the run-all harness scores as a timeout SIGKILL).
  // Close the dispatcher so the process exits naturally once pools drain.
  try {
    const undici = await import("undici");
    await undici.getGlobalDispatcher().close();
  } catch {
    /* best-effort: fall through to natural drain */
  }

  // Importing `storage`/the route module graph warms the pg pools, whose idle
  // client sockets (and, when this file is run WITHOUT an ambient
  // NODE_ENV=test set before db.ts evaluates, the ref'd idle-reaper timer) are
  // active handles that pin the event loop. The run-all harness always sets
  // NODE_ENV=test so the loop drains on its own, but to make this suite exit
  // deterministically regardless of how it's launched we explicitly close all
  // three pools here (idempotent; safe even if the beforeExit hook also fires).
  await closeDbPools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
