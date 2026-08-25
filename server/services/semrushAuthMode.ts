/**
 * Task #3670 — SEMrush v4 API-key auth mode.
 *
 * SEMrush support pointed at v4 API-key authorization (`Authorization:
 * Apikey <KEY>`) as the replacement for the OAuth device-flow whose
 * unrefreshable 7-day tokens caused the weekly reconnect treadmill. A live
 * probe on Jul 31 2026 proved the key works on the Map Rank Tracker API
 * (docs claiming Bearer-only lag reality — see KEEP_ALIVE_RUNBOOK.md).
 *
 * When the `SEMRUSH_V4_API_KEY` secret is set, the app runs in **key mode**:
 *   - every SEMrush request authenticates with `Authorization: Apikey`;
 *   - the OAuth machinery (token reads/refreshes, device flow, keep-alive,
 *     auth-dead breaker, disconnect alert, paused_auth gating) is DORMANT so
 *     stale OAuth state can never fire "Reconnect Required";
 *   - a 401/403 surfaces as a KEY problem (invalid/revoked key), never an
 *     OAuth wipe or device-flow prompt.
 * When the secret is absent the legacy OAuth device-flow path applies
 * unchanged (dormant fallback).
 *
 * This module is dependency-light on purpose (settingsStorage only) so the
 * breaker / alert / scheduler modules can consult it without cycles.
 *
 * Test gating: automated tests pin OAuth-path behavior (breaker trips, probe
 * outcomes, badge fields) and run against a workspace env where the secret IS
 * set. Key mode is therefore disabled under `NODE_ENV=test` / `TEST_SMOKE`
 * unless a test explicitly opts in via `__setSemrushKeyModeOverrideForTest`.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

/** system_settings key recording the last successful key-mode API call (ISO). */
export const SEMRUSH_KEY_LAST_SUCCESS_SETTING = "semrush_api_key_last_success_at";

/** Test-only override: `true`/`false` forces the mode; `null` = use env. */
let keyModeOverrideForTest: boolean | null = null;

export function __setSemrushKeyModeOverrideForTest(v: boolean | null): void {
  keyModeOverrideForTest = v;
}

/** The raw v4 API key, or null when unset/blank. */
export function getSemrushV4ApiKey(): string | null {
  const raw = process.env.SEMRUSH_V4_API_KEY;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * True when SEMrush should authenticate with the v4 API key and keep the
 * OAuth machinery dormant.
 */
export function isSemrushKeyMode(): boolean {
  if (keyModeOverrideForTest !== null) return keyModeOverrideForTest;
  if (!getSemrushV4ApiKey()) return false;
  // Tests pin OAuth-path behavior; never let the workspace secret flip the
  // suite into key mode implicitly (opt in via the test override instead).
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) return false;
  return true;
}

// ── Last-successful-call tracking (key mode) ────────────────────────────────
// Hot path stays in-memory; the durable setting is written at most once per
// PERSIST_MIN_INTERVAL_MS so ordinary traffic doesn't churn system_settings.

let lastKeySuccessAtMs: number | null = null;
let lastPersistedAtMs = 0;
const PERSIST_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Record a successful key-authenticated SEMrush call (fire-and-forget persist). */
export function recordSemrushKeyModeSuccess(): void {
  const now = Date.now();
  lastKeySuccessAtMs = now;
  if (now - lastPersistedAtMs < PERSIST_MIN_INTERVAL_MS) return;
  lastPersistedAtMs = now;
  void setSystemSetting(
    SEMRUSH_KEY_LAST_SUCCESS_SETTING,
    new Date(now).toISOString(),
    "system",
  ).catch((err: any) => {
    console.warn(
      `[SemrushKeyMode] last-success persist failed (non-fatal): ${err?.message ?? err}`,
    );
  });
}

/**
 * Latest successful key-mode call, preferring the in-memory value (this
 * process) and falling back to the durable setting (another instance / a
 * previous boot). Null when never recorded.
 */
export async function getSemrushKeyModeLastSuccessAt(): Promise<string | null> {
  let stored: string | null = null;
  try {
    stored = (await getSystemSetting(SEMRUSH_KEY_LAST_SUCCESS_SETTING))?.value ?? null;
  } catch {
    /* best-effort */
  }
  if (lastKeySuccessAtMs === null) return stored;
  const inMem = new Date(lastKeySuccessAtMs).toISOString();
  if (!stored) return inMem;
  return stored > inMem ? stored : inMem;
}
