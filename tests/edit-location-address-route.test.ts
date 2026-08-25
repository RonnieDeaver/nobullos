/* test-registration
{
  "name": "Edit-location-address route re-check + save (Task #2444)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/geocodeLocationTextSetup.mjs",
    "--import",
    "./tests/helpers/fipsLookupSetup.mjs",
    "--import",
    "./tests/helpers/onLocationChangedSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2444 — Editing a location's address re-checks and saves it, at the
 * route layer.
 *
 * Task #2419 pinned the SUCCESS path for *creating* a location
 * (`POST /api/clients/:clientId/locations`, covered in
 * `tests/add-stale-location-route.test.ts`). The sibling *update* path —
 * `PATCH /api/clients/:clientId/locations/:locationId` — re-geocodes a changed
 * address through a DIFFERENT helper (`geocodeAddress`, NOT
 * `geocodeLocationText`), parses city/state from the returned
 * `formattedAddress`, looks up FIPS via `getFipsForLocation`, persists through
 * `storage.updateClientLocation`, and on success also calls
 * `onLocationChanged()`. None of that branching was covered by a route test.
 * This pins it directly:
 *
 *   1. Too-short address  → 400 "A valid full address is required", BEFORE the
 *      geocoder is ever consulted.
 *   2. Address that geocodes to `success:false`  → 400 "Could not validate
 *      address" (geocoder WAS consulted; no write happens).
 *   3. Geocoder THROWS  → 400 "Could not validate address" (the route's
 *      try/catch around `geocodeAddress` maps the fault to the same operator
 *      message; no write happens).
 *   4. A good address that geocodes to real coordinates → 200 with the updated
 *      location body carrying the re-parsed city/state and NEW coords, AND
 *      `storage.updateClientLocation` is called with the geocoded fields +
 *      operator-UI audit metadata, AND `onLocationChanged()` fired once.
 *
 * `geocodeAddress` is reached through a dynamic `await import("../mcu/geocoding")`
 * and `getFipsForLocation` through a dynamic `await import("../mcu/fips")`;
 * ESM named exports can't be monkey-patched, so both are swapped via
 * resolve-hook redirects to in-memory stubs (registered through
 * `--import ./tests/helpers/geocodeLocationTextSetup.mjs` and
 * `--import ./tests/helpers/fipsLookupSetup.mjs`). `storage` client/user
 * lookups are swapped for in-memory stubs so the whole test runs with zero DB
 * dependency.
 *
 * Branches 1–3 return before any location write, so the MCU recompute timer
 * never arms. The success path DOES write and calls `onLocationChanged()`
 * (server/mcu/worker.ts), which arms a 30s `setTimeout` that would keep the
 * process alive (a drain hang the run-all harness scores as a SIGKILL). We
 * neutralize it with the same resolve-hook trick as #2419: a redirect of
 * `server/mcu/worker` to `tests/helpers/onLocationChangedStub.mjs` (registered
 * through `--import ./tests/helpers/onLocationChangedSetup.mjs`) turns
 * `onLocationChanged` into a counting no-op.
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
  __setGeocodeAddress,
  __resetGeocodeAddress,
} from "./helpers/geocodeLocationTextStub.mjs";
import {
  __setGetFipsForLocation,
  __resetGetFipsForLocation,
} from "./helpers/fipsLookupStub.mjs";
import {
  __getOnLocationChangedCalls,
  __resetOnLocationChangedCalls,
} from "./helpers/onLocationChangedStub.mjs";

const CLIENT_ID = "client-2444";
const LOCATION_ID = "loc-2444";
const USER_ID = "user-2444-am";

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

/** Number of times the (stubbed) geocoder / FIPS lookup were invoked. */
let geocodeCalls = 0;
let fipsCalls = 0;

function installStubs(): void {
  saveOriginal("getClient");
  s.getClient = async (id: string) =>
    id === CLIENT_ID ? { id: CLIENT_ID, ownerId: USER_ID, isDemo: false } : undefined;

  saveOriginal("getUser");
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2444@test.local",
          firstName: "Edit",
          lastName: "Location",
          role: "account_manager",
        }
      : undefined;

  // Guard: branches 1–3 must return before any write. If a pre-write
  // validation branch ever reached updateClientLocation that is a regression
  // in the route's ordering — fail loudly. The success test overrides this.
  saveOriginal("updateClientLocation");
  s.updateClientLocation = async () => {
    throw new Error(
      "updateClientLocation must NOT be called for the short-address / geocode-failure / geocode-throws branches",
    );
  };

  // No real users row is seeded (fully DB-free); pre-register the acting id so
  // requireAuth admits it from the profile instead of JIT-provisioning a
  // public row / firing the comms auto-join side effect.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2444@test.local",
    firstName: "Edit",
    lastName: "Location",
    role: "account_manager",
  });
}

function restoreStubs(): void {
  for (const [name, fn] of Object.entries(originals)) {
    s[name] = fn;
  }
  __test_resetReconciledUsers();
  __resetGeocodeAddress();
  __resetGetFipsForLocation();
  __resetOnLocationChangedCalls();
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
    // authenticates as that user id. This suite stubs storage.getUser (the
    // role source for the client routes) but seeds NO real users row, so the
    // acting identity is pre-registered via __test_markUserReconciled to keep
    // requireAuth from JIT-provisioning a public row / firing the auto-join.
    (req as any).__test_clerkUserId = USER_ID;
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

async function patchLocation(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(
    `${baseUrl}/api/clients/${CLIENT_ID}/locations/${LOCATION_ID}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON body is itself a failure the asserts will catch */
  }
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// 1. Too-short address → 400 clear required message, no geocode call
// ---------------------------------------------------------------------------
async function testShortAddress(): Promise<void> {
  console.log("\n— 1. Too-short address returns the clear required message —");
  geocodeCalls = 0;
  __setGeocodeAddress(async () => {
    geocodeCalls++;
    throw new Error("geocoder must not be consulted when the address is too short");
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await patchLocation(baseUrl, { address: "too short" });
    check("short address → 400", status === 400, `status=${status}`);
    check(
      "short address → clear 'valid full address is required' message",
      typeof json?.error === "string" && /valid full address is required/i.test(json.error),
      json?.error,
    );
    check(
      "short address never consults the geocoder",
      geocodeCalls === 0,
      `geocodeCalls=${geocodeCalls}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. geocodeAddress returns success:false → 400 "Could not validate address"
// ---------------------------------------------------------------------------
async function testGeocodeFailure(): Promise<void> {
  console.log("\n— 2. Unvalidatable address (success:false) → 400 —");
  geocodeCalls = 0;
  __setGeocodeAddress(async () => {
    geocodeCalls++;
    return { lat: 0, lng: 0, formattedAddress: "", success: false, failureReason: "not_found" };
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await patchLocation(baseUrl, {
      address: "123 Nowhere St, Nulltown, ZZ 00000",
    });
    check("geocode failure → 400", status === 400, `status=${status}`);
    check("geocode failure consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check(
      "geocode failure → 'Could not validate address' message",
      typeof json?.error === "string" && /could not validate address/i.test(json.error),
      json?.error,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. geocodeAddress throws → 400 "Could not validate address"
// ---------------------------------------------------------------------------
async function testGeocodeThrows(): Promise<void> {
  console.log("\n— 3. Geocoder throws → 400 (same operator message) —");
  geocodeCalls = 0;
  __setGeocodeAddress(async () => {
    geocodeCalls++;
    throw new Error("provider exploded");
  });
  await withApp(async (baseUrl) => {
    const { status, json } = await patchLocation(baseUrl, {
      address: "123 Main St, Dallas, TX 75201",
    });
    check("geocode throws → 400", status === 400, `status=${status}`);
    check("geocode throws consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check(
      "geocode throws → 'Could not validate address' message",
      typeof json?.error === "string" && /could not validate address/i.test(json.error),
      json?.error,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Valid address → 200 with re-parsed city/state + new coords, audited write
// ---------------------------------------------------------------------------
async function testSuccess(): Promise<void> {
  console.log("\n— 4. Valid address re-geocodes and saves → 200 updated —");
  geocodeCalls = 0;
  fipsCalls = 0;
  __resetOnLocationChangedCalls();

  const geocoded = {
    lat: 32.7791,
    lng: -96.7986,
    formattedAddress: "123 Main St, Dallas, TX 75201, USA",
    success: true as const,
  };
  __setGeocodeAddress(async (addr: string) => {
    geocodeCalls++;
    check("geocodeAddress received the trimmed address", addr === "123 Main St, Dallas, TX 75201", `addr=${addr}`);
    return geocoded;
  });

  const fips = { stateFips: "48", countyFips: "48113" };
  __setGetFipsForLocation(async (loc: any) => {
    fipsCalls++;
    check(
      "getFipsForLocation received the geocoded coords",
      loc?.lat === geocoded.lat && loc?.lng === geocoded.lng,
      `lat=${loc?.lat} lng=${loc?.lng}`,
    );
    return fips;
  });

  // Capture exactly what the route persists, and return an updated row the way
  // the real storage layer would (merge of existing row + the update patch).
  let captured: { id: string; data: any; audit: any } | null = null;
  s.updateClientLocation = async (id: string, data: any, audit: any) => {
    captured = { id, data, audit };
    return { id, clientId: CLIENT_ID, isActive: true, ...data };
  };

  await withApp(async (baseUrl) => {
    const { status, json } = await patchLocation(baseUrl, {
      address: "  123 Main St, Dallas, TX 75201  ",
    });

    check("valid address → 200", status === 200, `status=${status}`);
    check("valid address consulted the geocoder", geocodeCalls === 1, `geocodeCalls=${geocodeCalls}`);
    check("valid address looked up FIPS", fipsCalls === 1, `fipsCalls=${fipsCalls}`);

    check(
      "200 body is the updated location (id echoed back)",
      json?.id === LOCATION_ID,
      `id=${json?.id}`,
    );
    check(
      "200 body carries the re-parsed city/state",
      json?.city === "Dallas" && json?.state === "TX",
      `city=${json?.city} state=${json?.state}`,
    );
    check(
      "200 body carries the NEW geocoded coordinates",
      json?.lat === geocoded.lat && json?.lng === geocoded.lng,
      `lat=${json?.lat} lng=${json?.lng}`,
    );

    const d = (captured as any)?.data;
    check("updateClientLocation was called", captured !== null);
    check(
      "updateClientLocation got the correct locationId",
      (captured as any)?.id === LOCATION_ID,
      `id=${(captured as any)?.id}`,
    );
    check(
      "updateClientLocation got the formatted address + re-parsed city/state",
      d?.address === geocoded.formattedAddress && d?.city === "Dallas" && d?.state === "TX",
      `address=${d?.address} city=${d?.city} state=${d?.state}`,
    );
    check(
      "updateClientLocation got the new coords + FIPS",
      d?.lat === geocoded.lat &&
        d?.lng === geocoded.lng &&
        d?.stateFips === fips.stateFips &&
        d?.countyFips === fips.countyFips,
      `lat=${d?.lat} lng=${d?.lng} stateFips=${d?.stateFips} countyFips=${d?.countyFips}`,
    );
    check(
      "updateClientLocation stamped a fresh geocodedAt",
      d?.geocodedAt instanceof Date,
      `geocodedAt=${d?.geocodedAt}`,
    );

    const a = (captured as any)?.audit;
    check(
      "updateClientLocation got the operator-UI audit metadata",
      a?.actorUserId === USER_ID &&
        a?.source === "operator_ui" &&
        typeof a?.reason === "string" &&
        a.reason.includes(`/api/clients/${CLIENT_ID}/locations/${LOCATION_ID}`),
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
  try {
    await testShortAddress();
    await testGeocodeFailure();
    await testGeocodeThrows();
    await testSuccess();
  } finally {
    restoreStubs();
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
  // client sockets are active handles that pin the event loop. Close all three
  // pools explicitly so this suite exits deterministically regardless of how
  // it's launched (idempotent; safe even if the beforeExit hook also fires).
  await closeDbPools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
