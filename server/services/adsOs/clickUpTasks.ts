/**
 * Ads OS — ClickUp ticket creation + status tracking for account alerts.
 * Port of backend/app/clickup/client.py (thin REST client) and
 * backend/app/clickup/service.py (idempotent per-alert task flow).
 *
 * One ClickUp task per open {product}:{cid}:{alert_code}. Creating twice while
 * the first is open returns the same ref (idempotent); once the task is closed
 * or deleted in ClickUp, the button reverts to Create. Open-state checks are
 * cached ~90s so dashboards don't hammer the ClickUp API; the cron/Refresh
 * path re-checks every open ref authoritatively (refreshTaskStates).
 *
 * Only outbound write in this module: POST /list/{id}/task. The token is never
 * logged; absent token disables the whole feature (routes 503, button hidden).
 */

import type { AlertRunResult } from "./alertsEngine";
import { normClientName, peopleFor } from "./clickUpDirectory";
import {
  CLICKUP_CLIENT_FIELD_ID,
  CLICKUP_GADS_LIST_ID,
  CLICKUP_LSA_LIST_ID,
  isClickUpConfiguredAsync,
  resolveClickUpToken,
} from "./config";
import { KeyedLocks } from "./singleflight";
import { getAlerts, getClickupTaskDoc, putClickupTaskDoc } from "./store";
import { Alert, Product } from "./types";

const CLICKUP_V2 = "https://api.clickup.com/api/v2";
const TIMEOUT_MS = 15_000;

// ClickUp status "type" values that mean the task no longer needs work.
const CLOSED_TYPES = new Set(["closed", "done"]);

export class ClickUpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ClickUpError";
    this.status = status;
  }
}

/** Raised when the alert an operator clicked no longer exists in the store. */
export class AlertNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertNotFoundError";
  }
}

async function clickUpRequest(method: string, path: string, body?: object): Promise<any> {
  // Task #3662: resolve per-request through the runtime-rotatable accessor
  // (DB override → env) so an admin rotation reaches ticket pushes too.
  const token = await resolveClickUpToken();
  if (!token) throw new ClickUpError("ClickUp API token not configured", 503);
  const res = await fetch(`${CLICKUP_V2}${path}`, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data && typeof data.err === "string" ? data.err : `HTTP ${res.status}`;
    throw new ClickUpError(detail, res.status);
  }
  return data;
}

function listIdFor(product: Product): string {
  return product === "lsa" ? CLICKUP_LSA_LIST_ID : CLICKUP_GADS_LIST_ID;
}

// ---------------------------------------------------------------------------
// Open-state cache (~90s) — dashboards verify "still open?" cheaply.
// ---------------------------------------------------------------------------

interface TaskState {
  open: boolean;
  status: string;
  url: string | null;
}

const STATE_TTL_MS = 90_000;
const _stateCache = new Map<string, { at: number; state: TaskState }>();

/** GET /task/{id} -> open/closed + status. null = deleted (404). Throws on other errors. */
export async function getTaskState(taskId: string): Promise<TaskState | null> {
  try {
    const data = await clickUpRequest("GET", `/task/${encodeURIComponent(taskId)}`);
    const status = data?.status ?? {};
    return {
      open: !CLOSED_TYPES.has(String(status.type ?? "").toLowerCase()),
      status: String(status.status ?? ""),
      url: typeof data?.url === "string" ? data.url : null,
    };
  } catch (err) {
    if (err instanceof ClickUpError && err.status === 404) return null; // deleted
    throw err;
  }
}

/** Cached open-state check. A transient ClickUp error counts as "still open"
 *  (and is cached) so a blip never flips buttons back to Create. */
async function openState(taskId: string, refStatus: string): Promise<TaskState> {
  const hit = _stateCache.get(taskId);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  let state: TaskState;
  try {
    const s = await getTaskState(taskId);
    state = s ?? { open: false, status: "deleted", url: null };
  } catch {
    state = { open: true, status: refStatus, url: null };
  }
  _stateCache.set(taskId, { at: Date.now(), state });
  return state;
}

/** Test hook: reset the open-state cache. */
export function __testResetClickUpStateCache(): void {
  _stateCache.clear();
}

// ---------------------------------------------------------------------------
// Client dropdown matching
// ---------------------------------------------------------------------------

// Dashboard client names that differ from the ClickUp Tickets-space Client
// dropdown spellings (normalized dashboard name -> dropdown spelling).
const CLIENT_ALIASES: Record<string, string> = {
  "shields & boris law": "Shields & Borris Law",
  "wanta thome": "Wanta Thome Law",
};

interface DropdownOption {
  id: string;
  name: string;
}

/** The Client dropdown's options on a Tickets list (space-level field). */
export async function listDropdownOptions(listId: string, fieldId: string): Promise<DropdownOption[]> {
  const data = await clickUpRequest("GET", `/list/${encodeURIComponent(listId)}/field`);
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  for (const f of fields) {
    if (String(f?.id ?? "") !== fieldId) continue;
    const options = Array.isArray(f?.type_config?.options) ? f.type_config.options : [];
    return options
      .map((o: any) => ({ id: String(o?.id ?? ""), name: String(o?.name ?? "") }))
      .filter((o: DropdownOption) => o.id && o.name);
  }
  return [];
}

/** Match the client's dashboard name to a dropdown option id (alias-aware). */
export function matchClientOption(options: DropdownOption[], clientName: string | null): string | null {
  if (!clientName) return null;
  let want = normClientName(clientName);
  const alias = CLIENT_ALIASES[want];
  if (alias) want = normClientName(alias);
  for (const opt of options) {
    if (normClientName(opt.name) === want) return opt.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idempotent create + attach + reconcile
// ---------------------------------------------------------------------------

export interface TaskRef {
  task_id: string;
  url: string | null;
}

// Serialize load-modify-save of an account's task map across the network call.
const _locks = new KeyedLocks();

/**
 * Create (or return the existing open) ClickUp task for one alert.
 * Idempotent while the previous ticket is open; a closed/deleted ticket makes
 * the next click create a fresh one.
 */
export async function createTaskForAlert(product: Product, cid: string, code: string): Promise<TaskRef> {
  if (!(await isClickUpConfiguredAsync())) throw new ClickUpError("ClickUp API token not configured", 503);
  return _locks.withLock(`${product}:${cid}`, async () => {
    // Strict read: a failed store read must throw (never silently treat the map
    // as empty — that would double-create tickets).
    const doc = (await getClickupTaskDoc(product, cid)) ?? {};

    const existing = doc[code];
    if (existing && existing.open && existing.task_id) {
      const state = await openState(String(existing.task_id), String(existing.status ?? ""));
      if (state.open) {
        return { task_id: String(existing.task_id), url: existing.url ?? null };
      }
      // Since closed/deleted — record it, fall through to create a fresh task.
      existing.open = false;
      existing.status = state.status;
      existing.checked_at = new Date().toISOString();
    }

    const alertsDoc = (await getAlerts(product, cid)) ?? {};
    const alerts: Alert[] = Array.isArray(alertsDoc.alerts) ? alertsDoc.alerts : [];
    const alert = alerts.find((a) => a.code === code);
    if (!alert) {
      throw new AlertNotFoundError(`alert ${code} not found for ${product}:${cid} — refresh alerts and retry`);
    }
    const accountName = String(alertsDoc.account_name ?? cid);

    // Description: detail + account footer (+ deep link when present) + origin note.
    let description = alert.detail || alert.title;
    description += `\n\nAccount: ${accountName}`;
    if (alert.deep_link) description += `\nOpen in Google Ads: ${alert.deep_link}`;
    description += "\n\nRaised from an NBM Ads OS dashboard alert.";

    // Best-effort Client dropdown match — an unmatched client still gets a task,
    // just with the field unset (the alias table covers known spelling drift).
    const listId = listIdFor(product);
    let clientOptionId: string | null = null;
    try {
      const { client_name } = await peopleFor(product, cid);
      const options = await listDropdownOptions(listId, CLICKUP_CLIENT_FIELD_ID);
      clientOptionId = matchClientOption(options, client_name);
    } catch (err: any) {
      console.warn(`[AdsOsV2] clickup client-field match failed for ${product}:${cid}: ${err?.message ?? err}`);
    }

    // Due today (date-only). ClickUp wants epoch ms; noon UTC avoids timezone
    // edge-days when it renders the date.
    const now = new Date();
    const dueMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0);

    const body: Record<string, any> = {
      name: alert.title.slice(0, 250),
      description,
      due_date: dueMs,
      due_date_time: false,
    };
    if (clientOptionId) {
      body.custom_fields = [{ id: CLICKUP_CLIENT_FIELD_ID, value: clientOptionId }];
    }

    const created = await clickUpRequest("POST", `/list/${encodeURIComponent(listId)}/task`, body);
    const taskId = String(created?.id ?? "");
    if (!taskId) throw new ClickUpError("ClickUp create returned no task id", 502);
    const url = typeof created?.url === "string" ? created.url : null;
    const nowIso = new Date().toISOString();
    doc[code] = {
      task_id: taskId,
      url,
      open: true,
      status: String(created?.status?.status ?? ""),
      created_at: nowIso,
      checked_at: nowIso,
    };
    await putClickupTaskDoc(product, cid, doc);
    _stateCache.set(taskId, { at: Date.now(), state: { open: true, status: doc[code].status, url } });
    return { task_id: taskId, url };
  });
}

/**
 * Overlay each alert's open ClickUp ticket ref (if any) for dashboards and the
 * client profile. Verifies "still open?" through the ~90s cache; a ticket found
 * closed is persisted as such (button reverts to Create). Best-effort: any
 * store/API hiccup leaves the alerts unmodified.
 */
export async function attachTaskRefs(product: Product, cid: string, alerts: Alert[]): Promise<Alert[]> {
  if (!alerts.length || !(await isClickUpConfiguredAsync())) return alerts;
  try {
    const doc = await getClickupTaskDoc(product, cid);
    if (!doc) return alerts;
    let changed = false;
    for (const a of alerts) {
      const ref = doc[a.code];
      if (!ref || !ref.open || !ref.task_id) continue;
      const state = await openState(String(ref.task_id), String(ref.status ?? ""));
      if (state.open) {
        a.clickup_task = { task_id: String(ref.task_id), url: ref.url ?? null };
      } else {
        ref.open = false;
        ref.status = state.status;
        ref.checked_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await putClickupTaskDoc(product, cid, doc);
  } catch (err: any) {
    console.warn(`[AdsOsV2] clickup attach refs failed for ${product}:${cid}: ${err?.message ?? err}`);
  }
  return alerts;
}

/**
 * Reconcile every open ticket ref for the accounts in an alerts run — the
 * cron/Refresh path. Authoritative (bypasses the 90s cache): a closed or
 * deleted ticket flips open=false so the dashboard button reverts to Create.
 * Transient per-task errors are skipped (ref stays open, retried next run).
 */
export async function refreshTaskStates(results: AlertRunResult[]): Promise<void> {
  if (!(await isClickUpConfiguredAsync())) return;
  for (const [cid, , product, alerts] of results) {
    if (alerts === null) continue; // failed run — leave its refs alone
    try {
      const doc = await getClickupTaskDoc(product, cid);
      if (!doc) continue;
      let changed = false;
      for (const [code, ref] of Object.entries<any>(doc)) {
        if (!ref || typeof ref !== "object" || !ref.open || !ref.task_id) continue;
        let state: TaskState | null;
        try {
          state = await getTaskState(String(ref.task_id));
        } catch {
          continue; // transient — keep it open, retry next run
        }
        const s = state ?? { open: false, status: "deleted", url: null };
        _stateCache.set(String(ref.task_id), { at: Date.now(), state: s });
        if (!s.open) {
          ref.open = false;
          ref.status = s.status;
          ref.checked_at = new Date().toISOString();
          doc[code] = ref;
          changed = true;
        }
      }
      if (changed) await putClickupTaskDoc(product, cid, doc);
    } catch (err: any) {
      console.warn(`[AdsOsV2] clickup refresh failed for ${product}:${cid}: ${err?.message ?? err}`);
    }
  }
}
