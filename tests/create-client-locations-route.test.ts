/* test-registration
{
  "name": "Create-client locations require full address + per-location warnings (Task #2490)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2490 — `POST /api/clients` requires a full street address on every
 * draft location, geocodes it, and surfaces per-location failures as a
 * `locationWarnings` array instead of silently persisting coordinate-less rows.
 *
 * Task #2487 changed the create-client handler so each draft location must
 * carry a name + a full street address (>= 10 chars), is geocoded via
 * `geocodeLocationText(name, address)`, and — crucially — a per-location
 * failure does NOT abort the whole request or silently save a location with no
 * coordinates. Instead the client is still created (201) and every rejected
 * location is reported back in `locationWarnings` with a plain-English reason.
 * That contract was previously unverified, so a refactor reverting to name-only
 * geocoding or silently persisting coordinate-less rows would go unnoticed.
 *
 * This pins the loop directly at the route layer with a mix of entries:
 *
 *   1. Two GOOD addresses           → created WITH coordinates.
 *   2. A too-short address (< 10)   → NOT created, warning "full street address
 *      is required", and the geocoder is NEVER consulted (pre-geocode reject).
 *   3. An unfindable address        → geocode returns lat/lng null with
 *      failureReason "not_found"; NOT created, warning "couldn't find that
 *      address" (operator-correctable, NOT the system wording).
 *   4. A provider/system fault      → geocode returns lat/lng null with
 *      failureReason "system"; NOT created, warning "system issue (not your
 *      address)".
 *   5. (bonus) A geocoder EXCEPTION → the catch branch; NOT created, warning
 *      "system issue".
 *
 * Plus two focused follow-ups:
 *   - A location with an address but NO name → NOT created, name-required
 *     warning, geocoder never consulted.
 *   - An all-valid request → 201 body is the bare client with NO
 *     `locationWarnings` key at all.
 *
 * Determinism: the route reaches the geocoder through a dynamic
 * `await import("../mcu/geocoding")`, and ESM named exports cannot be
 * monkey-patched, so `geocodeLocationText` is driven through a resolve-hook
 * redirect of `server/mcu/geocoding` to `tests/helpers/geocodeLocationTextStub.mjs`
 * (registered via `--import ./tests/helpers/geocodeLocationTextSetup.mjs`). The
 * success path persists a location and calls `onLocationChanged()`
 * (server/mcu/worker.ts), which arms a 30s `setTimeout` that would keep the
 * process alive (a drain hang the run-all harness scores as a SIGKILL); it is
 * neutralized by a redirect of `server/mcu/worker` to
 * `tests/helpers/onLocationChangedStub.mjs` (via
 * `--import ./tests/helpers/onLocationChangedSetup.mjs`) into a counting no-op.
 * `storage` lookups/writes are swapped for in-memory stubs and the
 * client-create audit log is neutralized via the module's own
 * `__test_setInsertActivityLogsOverride` seam, so the whole test runs with zero
 * DB dependency.
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
import { __test_setInsertActivityLogsOverride } from "../server/storage/activityStorage";
import {
  __setGeocodeLocationText,
  __resetGeocodeLocationText,
} from "./helpers/geocodeLocationTextStub.mjs";
import {
  __getOnLocationChangedCalls,
  __resetOnLocationChangedCalls,
} from "./helpers/onLocationChangedStub.mjs";

const CLIENT_ID = "client-2490";
const USER_ID = "user-2490-am";

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
// In-memory storage stubs — an account_manager owner so the access check
// passes, a createClient that echoes an id, and a createClientLocation that
// records exactly what the route asked to persist (so we can prove invalid
// entries are NEVER written and valid ones carry coordinates).
// ---------------------------------------------------------------------------
const s = storage as any;
const originals: Record<string, any> = {};

function saveOriginal(name: string): void {
  if (!(name in originals)) originals[name] = s[name];
}

/** Geocoder invocation log — `{ rawText, explicitAddress }` per call. */
let geocodeArgs: { rawText: string; explicitAddress?: string }[] = [];
/** Everything the route handed to `storage.createClientLocation`. */
let createdLocations: any[] = [];

function installStubs(): void {
  saveOriginal("getUser");
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2490@test.local",
          firstName: "Create",
          lastName: "Client",
          role: "account_manager",
        }
      : undefined;

  saveOriginal("createClient");
  s.createClient = async (data: any) => ({
    id: CLIENT_ID,
    firmName: data?.firmName ?? null,
    products: data?.products ?? [],
    ...data,
  });

  saveOriginal("createClientLocation");
  s.createClientLocation = async (data: any) => {
    createdLocations.push(data);
    return { ...data, id: `loc-${createdLocations.length}` };
  };

  // Neutralize the best-effort client-create audit-log DB write (and the
  // failure-alert fan-out it would trigger against a non-existent user row)
  // via the activity-store's own test seam — keeps the test fully DB-free.
  __test_setInsertActivityLogsOverride(async () => {});

  // No real users row is seeded (fully DB-free); pre-register the acting id so
  // requireAuth admits it from the profile instead of JIT-provisioning a
  // public row / firing the comms auto-join side effect.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2490@test.local",
    firstName: "Create",
    lastName: "Client",
    role: "account_manager",
  });
}

function restoreStubs(): void {
  for (const [name, fn] of Object.entries(originals)) {
    s[name] = fn;
  }
  __test_setInsertActivityLogsOverride(null);
  __test_resetReconciledUsers();
  __resetGeocodeLocationText();
  __resetOnLocationChangedCalls();
}

/**
 * A successful `GeocodedLocationData` echoing the operator's name/address with
 * populated, real-looking coordinates.
 */
function successGeocode(name: string, address: string) {
  return {
    name,
    address,
    city: "Dallas",
    state: "TX",
    lat: 32.7791,
    lng: -96.7986,
    stateFips: "48",
    countyFips: "48113",
    geocodedAt: new Date("2026-06-13T00:00:00.000Z"),
    geocodeWarning: null,
    geocodeFailureReason: null,
  };
}

/** A failed `GeocodedLocationData` (no coordinates) with the given reason. */
function failedGeocode(reason: "not_found" | "system") {
  return {
    name: null,
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

/**
 * Drive the stubbed geocoder by address content so a single POST can exercise
 * every branch deterministically:
 *   - "nowhere" → not_found    - "fault" → system    - "throw" → exception
 *   - anything else            → success echoing the input name/address
 */
function installGeocoderRouter(): void {
  geocodeArgs = [];
  __setGeocodeLocationText(async ({ rawText, explicitAddress }: any) => {
    geocodeArgs.push({ rawText, explicitAddress });
    const addr = String(explicitAddress ?? "");
    if (/nowhere/i.test(addr)) return failedGeocode("not_found");
    if (/fault/i.test(addr)) return failedGeocode("system");
    if (/throw/i.test(addr)) throw new Error("simulated provider exception");
    return successGeocode(String(rawText ?? ""), addr);
  });
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

async function postClient(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/clients`, {
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

function warningFor(json: any, name: string): string | undefined {
  const w = Array.isArray(json?.locationWarnings)
    ? json.locationWarnings.find((x: any) => x?.name === name)
    : undefined;
  return w?.reason;
}

// ---------------------------------------------------------------------------
// 1. Mixed batch — valid created w/ coords, invalid not created + warned
// ---------------------------------------------------------------------------
async function testMixedLocations(): Promise<void> {
  console.log("\n— 1. Mixed locations: valid saved w/ coords, invalid warned —");
  createdLocations = [];
  __resetOnLocationChangedCalls();
  installGeocoderRouter();

  await withApp(async (baseUrl) => {
    const { status, json } = await postClient(baseUrl, {
      firmName: "NoBull Mixed Law",
      products: ["gbp"],
      locations: [
        { name: "Good Dallas", address: "123 Main St, Dallas, TX 75201" },
        { name: "Good Austin", address: "200 Congress Ave, Austin, TX 78701" },
        { name: "Tiny", address: "5 A St" }, // < 10 chars → pre-geocode reject
        { name: "Nowhere Office", address: "999 Nowhere St, Nulltown, ZZ 00000" },
        { name: "Provider Fault", address: "500 Fault Ave, Faulton, TX 75000" },
        { name: "Throws Office", address: "404 Throw Blvd, Crashville, TX 75000" },
      ],
    });

    check("client still created → 201", status === 201, `status=${status}`);

    // Valid locations: exactly the two good ones, each WITH coordinates.
    check(
      "exactly the 2 valid locations were created",
      createdLocations.length === 2,
      `created=${createdLocations.length}`,
    );
    const byName = Object.fromEntries(createdLocations.map((l) => [l.name, l]));
    check(
      "valid 'Good Dallas' created with coordinates + clientId + isActive",
      byName["Good Dallas"]?.lat === 32.7791 &&
        byName["Good Dallas"]?.lng === -96.7986 &&
        byName["Good Dallas"]?.clientId === CLIENT_ID &&
        byName["Good Dallas"]?.isActive === true,
      JSON.stringify(byName["Good Dallas"] ?? null),
    );
    check(
      "valid 'Good Austin' created with coordinates",
      byName["Good Austin"]?.lat != null && byName["Good Austin"]?.lng != null,
      JSON.stringify(byName["Good Austin"] ?? null),
    );

    // No coordinate-less / invalid row was ever persisted.
    check(
      "no invalid location was persisted (none missing coords)",
      createdLocations.every((l) => l.lat != null && l.lng != null),
      `created names=${createdLocations.map((l) => l.name).join(",")}`,
    );
    check(
      "invalid names never reached createClientLocation",
      !["Tiny", "Nowhere Office", "Provider Fault", "Throws Office"].some(
        (n) => n in byName,
      ),
    );

    // Each invalid entry appears in locationWarnings with the RIGHT reason.
    check(
      "response carries exactly 4 locationWarnings",
      Array.isArray(json?.locationWarnings) && json.locationWarnings.length === 4,
      `warnings=${json?.locationWarnings?.length}`,
    );
    check(
      "too-short address → 'full street address is required' reason",
      /full street address is required/i.test(warningFor(json, "Tiny") ?? ""),
      warningFor(json, "Tiny"),
    );
    check(
      "unfindable address → operator-correctable \"couldn't find that address\"",
      /couldn't find that address/i.test(
        warningFor(json, "Nowhere Office") ?? "",
      ) && !/system issue/i.test(warningFor(json, "Nowhere Office") ?? ""),
      warningFor(json, "Nowhere Office"),
    );
    check(
      "system fault → system-issue reason (explicitly NOT the operator's address)",
      /system issue/i.test(warningFor(json, "Provider Fault") ?? "") &&
        /not your address/i.test(warningFor(json, "Provider Fault") ?? ""),
      warningFor(json, "Provider Fault"),
    );
    check(
      "geocoder exception → system-issue reason",
      /system issue/i.test(warningFor(json, "Throws Office") ?? ""),
      warningFor(json, "Throws Office"),
    );

    // The geocoder must be consulted for every name+address>=10 entry (5), but
    // NEVER for the too-short one (rejected before geocoding).
    check(
      "geocoder consulted 5x (every long-address entry, not the too-short one)",
      geocodeArgs.length === 5,
      `geocodeCalls=${geocodeArgs.length}`,
    );
    check(
      "too-short address never consulted the geocoder",
      !geocodeArgs.some((a) => /5 A St/i.test(String(a.explicitAddress ?? ""))),
    );
    check(
      "geocoder was called with (name, address) — not name-only (Task #2487)",
      geocodeArgs.every((a) => typeof a.explicitAddress === "string" && a.explicitAddress.length > 0),
      JSON.stringify(geocodeArgs.map((a) => a.explicitAddress)),
    );

    // At least one location was created, so the MCU recompute side effect fired
    // exactly once (timer neutralized by the worker stub).
    check(
      "onLocationChanged() fired once (≥1 location created)",
      __getOnLocationChangedCalls() === 1,
      `calls=${__getOnLocationChangedCalls()}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Address present but NO name → name-required warning, no geocode, no write
// ---------------------------------------------------------------------------
async function testMissingName(): Promise<void> {
  console.log("\n— 2. Address with no name → name-required warning —");
  createdLocations = [];
  __resetOnLocationChangedCalls();
  installGeocoderRouter();

  await withApp(async (baseUrl) => {
    const address = "123 Main St, Dallas, TX 75201";
    const { status, json } = await postClient(baseUrl, {
      firmName: "NoBull NoName Law",
      products: ["gbp"],
      locations: [{ address }],
    });

    check("client still created → 201", status === 201, `status=${status}`);
    check("no location was created", createdLocations.length === 0, `created=${createdLocations.length}`);
    check(
      "missing-name entry never consulted the geocoder",
      geocodeArgs.length === 0,
      `geocodeCalls=${geocodeArgs.length}`,
    );
    // The route keys the warning by the address when the name is missing.
    check(
      "name-required warning surfaced",
      /location name is required/i.test(warningFor(json, address) ?? ""),
      warningFor(json, address),
    );
    check(
      "no location created → onLocationChanged() did NOT fire",
      __getOnLocationChangedCalls() === 0,
      `calls=${__getOnLocationChangedCalls()}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. All-valid request → 201 body is the bare client with NO locationWarnings
// ---------------------------------------------------------------------------
async function testAllValidNoWarnings(): Promise<void> {
  console.log("\n— 3. All-valid locations → no locationWarnings key —");
  createdLocations = [];
  __resetOnLocationChangedCalls();
  installGeocoderRouter();

  await withApp(async (baseUrl) => {
    const { status, json } = await postClient(baseUrl, {
      firmName: "NoBull Clean Law",
      products: ["gbp"],
      locations: [{ name: "Clean HQ", address: "1 Clean Way, Dallas, TX 75201" }],
    });

    check("client created → 201", status === 201, `status=${status}`);
    check("the one valid location was created", createdLocations.length === 1, `created=${createdLocations.length}`);
    check(
      "all-valid response has NO locationWarnings key",
      json?.locationWarnings === undefined,
      `locationWarnings=${JSON.stringify(json?.locationWarnings)}`,
    );
    check(
      "201 body echoes the created client (id + firmName)",
      json?.id === CLIENT_ID && json?.firmName === "NoBull Clean Law",
      `id=${json?.id} firmName=${json?.firmName}`,
    );
  });
}

async function main(): Promise<void> {
  installStubs();
  try {
    await testMixedLocations();
    await testMissingName();
    await testAllValidNoWarnings();
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
  // pools so this suite exits deterministically regardless of how it's launched
  // (idempotent; safe even if the beforeExit hook also fires).
  await closeDbPools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
