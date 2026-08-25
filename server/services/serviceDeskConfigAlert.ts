/**
 * Task #3175 — In-app admin alert when a waiting-on transition can't persist
 * its metadata to ClickUp because the sd_list_mapping config is missing the
 * waiting-on custom-field UUIDs (fieldWaitingWhoId / fieldWaitingWhatId /
 * fieldWaitingWhenId).
 *
 * Task #3082 added a console.warn at the transition route, but nobody watches
 * deployment logs — this module surfaces the same condition through the
 * notification dispatcher (Slack + admin in-app inbox mirror) so whoever can
 * fix it in the /admin/service-desk setup wizard actually sees it.
 *
 * Design (mirrors semrushDisconnectAlert.ts):
 *   - Rate limit: AT MOST once per list per 24h. The hot path is a
 *     per-process lastFiredAt map keyed on listId; Task #3228 backs it with
 *     a persisted ledger in system_settings so restarts and sibling
 *     autoscale instances respect the same 24h window. The persisted read
 *     only happens when the in-memory map does NOT already suppress (the
 *     rare "about to fire" path), so steady-state suppression never touches
 *     the DB. The dispatcher's dedupeKey (`list:<listId>`) additionally
 *     suppresses repeats across the dispatcher's own 6h reminder window;
 *     the module-level 24h gate is the stricter, authoritative one.
 *   - Fire-and-forget: callers `void` this — a notification failure must
 *     never affect the transition request itself. A persisted-ledger
 *     read/write failure degrades to the in-process gate, never throws.
 *   - The notification body names the exact missing config keys and points
 *     at the setup wizard (/admin/service-desk).
 */
import { notifyByType } from "./notifications/dispatcher";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID =
  "workflow.service_desk.waiting_on_fields_missing";

/**
 * Task #3227 — generic "some other mapped custom-field UUID is missing from
 * sd_list_mapping so a ClickUp write was silently skipped" alert (e.g.
 * fieldDepartmentId on change-department, departmentOptionIds map gaps).
 */
export const SERVICE_DESK_CONFIG_FIELDS_NOTIFICATION_ID =
  "workflow.service_desk.config_fields_missing";

/** Once per list per day. */
export const SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-process rate-limit ledger: `${notificationId}:${listId}` → last fired
 * epoch ms. Keyed per notification id so the waiting-on alert and the generic
 * config alert rate-limit independently (each once per list per 24h).
 */
const lastFiredAtByList = new Map<string, number>();

/**
 * Persisted cross-instance ledger (Task #3228): a small JSON map
 * `{ [listId]: lastFiredEpochMs }` stored in system_settings. Entries older
 * than the 24h window are pruned on every write so the row stays tiny.
 */
export const SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY =
  "service_desk_waiting_fields_alert_ledger";

function parseLedger(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the persisted ledger. Returns {} on any failure — a store blip must
 * degrade to the in-process gate, never block the alert path.
 */
async function readPersistedLedger(): Promise<Record<string, number>> {
  try {
    const row = await getSystemSetting(SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY);
    return parseLedger(row?.value);
  } catch (err: any) {
    console.warn(
      `[ServiceDeskConfigAlert] Persisted ledger read failed (degrading to in-process gate): ${err?.message ?? err}`,
    );
    return {};
  }
}

/**
 * Write-through after a fire: re-read, merge our entry, prune expired
 * entries, persist. Best-effort — failure logs and moves on.
 */
async function persistLedgerEntry(scope: string, firedAt: number): Promise<void> {
  try {
    const ledger = await readPersistedLedger();
    ledger[scope] = Math.max(ledger[scope] ?? 0, firedAt);
    const cutoff = firedAt - SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS;
    for (const [k, v] of Object.entries(ledger)) {
      if (v < cutoff) delete ledger[k];
    }
    await setSystemSetting(
      SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY,
      JSON.stringify(ledger),
    );
  } catch (err: any) {
    console.warn(
      `[ServiceDeskConfigAlert] Persisted ledger write failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Injectable dispatcher reference. Tests swap this via
 * __setNotifyForTest to avoid ESM live-binding read-only errors.
 */
let _notifyByType: typeof notifyByType = notifyByType;

/**
 * Fire the admin alert for a waiting-on transition that could not write its
 * metadata to ClickUp because custom-field UUIDs are missing from the
 * sd_list_mapping config.
 *
 * Never throws; rate-limited to once per list per 24h in-process.
 *
 * @param listId - The ClickUp list id from the sd_list_mapping config (used
 *   as the rate-limit + dedupe scope). Falls back to "unknown" if absent.
 * @param missingFieldIds - The missing config keys, e.g. ["fieldWaitingWhoId"].
 * @param context - Optional triage context (task id, target status).
 */
export async function alertServiceDeskWaitingFieldsMissing(
  listId: string | null | undefined,
  missingFieldIds: string[],
  context?: { taskId?: string; toStatus?: string },
): Promise<void> {
  // NOTE: the dispatcher's admin in-app mirror truncates the body to 240
  // chars — the missing keys AND the /admin/service-desk wizard link MUST
  // appear up front so they survive truncation. Longer explanation follows.
  const text =
    `Service Desk misconfiguration — waiting-on details NOT saved to ClickUp. ` +
    `Missing sd_list_mapping key(s): ${missingFieldIds.join(", ")}. ` +
    `Fix: re-run the setup wizard at /admin/service-desk.\n` +
    (context?.toStatus ? `Transition target status: "${context.toStatus}".\n` : "") +
    (context?.taskId ? `Example affected ticket: ${context.taskId}.\n` : "") +
    `Re-running setup/verify captures the waiting-on custom-field UUIDs. ` +
    `Until then, "Waiting on" who/what/when details are silently dropped from ClickUp.`;

  await fireConfigAlert(
    SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID,
    listId,
    missingFieldIds,
    text,
    "waiting-on-fields-missing",
  );
}

/**
 * Task #3227 — fire the admin alert for any OTHER ClickUp custom-field write
 * that was silently skipped because a mapped UUID is missing from the
 * sd_list_mapping config (e.g. fieldDepartmentId on change-department, or a
 * departmentOptionIds map entry). Same pattern as the waiting-on alert:
 * fire-and-forget, never throws, rate-limited once per list per 24h
 * in-process (independently of the waiting-on alert's ledger entry).
 *
 * @param listId - The ClickUp list id (rate-limit + dedupe scope).
 * @param missingConfigKeys - The missing config keys, e.g.
 *   ["fieldDepartmentId"] or ["departmentOptionIds[<deptId>]"].
 * @param context - What was being written when the skip happened.
 */
export async function alertServiceDeskConfigFieldsMissing(
  listId: string | null | undefined,
  missingConfigKeys: string[],
  context?: { taskId?: string; action?: string },
): Promise<void> {
  // Missing keys + wizard link up front (mirror truncates at 240 chars).
  const text =
    `Service Desk misconfiguration — a ClickUp field write was skipped` +
    (context?.action ? ` (${context.action})` : "") +
    `. Missing sd_list_mapping key(s): ${missingConfigKeys.join(", ")}. ` +
    `Fix: re-run the setup wizard at /admin/service-desk.\n` +
    (context?.taskId ? `Example affected ticket: ${context.taskId}.\n` : "") +
    `Re-running setup/verify captures the custom-field UUIDs and option maps. ` +
    `Until then, these values are silently dropped from ClickUp.`;

  await fireConfigAlert(
    SERVICE_DESK_CONFIG_FIELDS_NOTIFICATION_ID,
    listId,
    missingConfigKeys,
    text,
    "config-fields-missing",
  );
}

/**
 * Shared core: 24h-per-list in-process rate limit + dispatcher call.
 * Never throws.
 */
async function fireConfigAlert(
  notificationId: string,
  listId: string | null | undefined,
  missingKeys: string[],
  text: string,
  alertName: string,
): Promise<void> {
  try {
    if (missingKeys.length === 0) return;
    const scope = listId?.trim() || "unknown";
    const ledgerKey = `${notificationId}:${scope}`;

    const last = lastFiredAtByList.get(ledgerKey);
    const now = Date.now();
    if (last !== undefined && now - last < SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS) {
      console.log(
        `[ServiceDeskConfigAlert] already alerted (${alertName}) for list ${scope} within 24h — suppressing repeat`,
      );
      return;
    }

    // Task #3228 — in-memory doesn't suppress (fresh boot or sibling
    // instance fired). Check the persisted ledger before firing so restarts
    // and other autoscale instances share the same 24h window. Adopt the
    // persisted timestamp into memory either way so subsequent calls stay
    // on the hot path. Keyed by `${notificationId}:${listId}` so the
    // waiting-on and generic config alerts rate-limit independently.
    const persisted = (await readPersistedLedger())[ledgerKey];
    if (persisted !== undefined) {
      lastFiredAtByList.set(ledgerKey, persisted);
      if (now - persisted < SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS) {
        console.log(
          `[ServiceDeskConfigAlert] persisted ledger shows list ${scope} alerted (${alertName}) within 24h — suppressing repeat`,
        );
        return;
      }
    }

    console.warn(
      `[ServiceDeskConfigAlert] Firing ${alertName} alert (list=${scope} missing=${missingKeys.join(",")})`,
    );

    await _notifyByType(
      notificationId,
      { text },
      {
        triggerSource: "alert_service",
        dedupeKey: `list:${scope}`,
        // In-app inbox rows deep-link straight to the setup wizard where
        // the missing UUIDs are fixed (not the generic notifications page).
        mirrorDeepLink: "/admin/service-desk",
      },
    );

    lastFiredAtByList.set(ledgerKey, now);
    await persistLedgerEntry(ledgerKey, now);
  } catch (err: any) {
    console.warn(
      `[ServiceDeskConfigAlert] Failed to fire alert (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/** Test-only: reset the per-process rate-limit ledger. */
export function __resetServiceDeskConfigAlertForTest(): void {
  lastFiredAtByList.clear();
}

/**
 * Test-only: swap the dispatcher function so tests can intercept calls
 * without the ESM live-binding read-only restriction.
 */
export function __setNotifyForTest(notify: typeof notifyByType): void {
  _notifyByType = notify;
}

/** Test-only: restore the real dispatcher reference. */
export function __resetNotifyForTest(): void {
  _notifyByType = notifyByType;
}
