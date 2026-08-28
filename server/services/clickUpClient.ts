/**
 * Task #2927 — Full ClickUp REST client (v2 + v3).
 *
 * Absorbs the former thin client (Task #2785) while preserving the existing
 * hygiene-alert push surface (getClickUpApiToken / isClickUpConfigured /
 * createClickUpTask / getClickUpTask) unchanged for callers.
 *
 * New: per-user token support, rate-limit pacing (proactive header + reactive
 * 429), per-user auth breaker, v2+v3 endpoints for workspaces, spaces,
 * folders, lists, tasks, comments, checklists, time tracking, goals, docs,
 * webhooks, and attachments.
 *
 * API refs reviewed 2026-07-16:
 *   developer.clickup.com/docs/rate-limits          (100/min Business, Reset=epoch-s)
 *   developer.clickup.com/docs/authentication        (bare Authorization header)
 *   developer.clickup.com/docs/webhooks             (HMAC-SHA256, wildcard events)
 *   developer.clickup.com/docs/general-v2-v3-api    (v3 for docs/attachments)
 *   developer.clickup.com/llms.txt                  (endpoint index)
 *
 * @bounded-cache-safe: rateLimitState is keyed by 8-char token suffix; the
 * token population is a handful of configured ClickUp tokens (system + a few
 * per-user), so the key space is inherently bounded.
 */

import crypto from "crypto";

const CLICKUP_V2 = "https://api.clickup.com/api/v2";
const CLICKUP_V3 = "https://api.clickup.com/api/v3";

// ─── Shared personal-token path (backwards compat for hygiene alerts) ─────────

import {
  getClickUpCompanyTokenSnapshot,
  resolveClickUpCompanyToken,
} from "./clickUpCompanyToken";

/**
 * Task #3662: the company token now routes through the runtime-rotatable
 * accessor (DB override via Integrations Hub → CLICKUP_API_TOKEN env
 * fallback). This sync helper serves cheap configured-gates from the
 * last-known snapshot; the actual task calls below resolve async so a
 * rotation reaches the leaf fetches without a restart.
 */
export function getClickUpApiToken(): string | null {
  return getClickUpCompanyTokenSnapshot().token || null;
}

export function getClickUpListId(): string | null {
  return process.env.CLICKUP_LIST_ID || null;
}

export function isClickUpConfigured(): boolean {
  return !!(getClickUpApiToken() && getClickUpListId());
}

export interface ClickUpTask {
  id: string;
  name: string;
  status: "open" | "in_progress" | "closed" | "unknown";
  url: string | null;
}

export interface ClickUpUnconfigured {
  configured: false;
  reason: string;
}

export type ClickUpResult<T> = ({ configured: true } & T) | ClickUpUnconfigured;

function normalizeStatus(raw: any): ClickUpTask["status"] {
  const s = String(raw?.status?.status || raw?.status || "").toLowerCase().trim();
  if (s === "closed" || s === "complete" || s === "done") return "closed";
  if (s.includes("progress") || s.includes("active") || s === "in progress") return "in_progress";
  if (s === "open" || s === "to do" || s === "todo") return "open";
  if (!s) return "unknown";
  return "open";
}

// ─── Rate-limit pacing ────────────────────────────────────────────────────────
// Per-token budget: 100/min Business (default). X-RateLimit-Reset is epoch
// seconds (not delta). Proactive gate at remaining < 20% of window.

const rateLimitState = new Map<
  string,
  { remaining: number; limit: number; resetEpochMs: number; delayUntilMs: number }
>();

function updateRateLimit(token: string, headers: Headers): void {
  const remaining = parseInt(headers.get("X-RateLimit-Remaining") ?? "100", 10);
  const limit = parseInt(headers.get("X-RateLimit-Limit") ?? "100", 10);
  const resetSec = parseInt(headers.get("X-RateLimit-Reset") ?? "0", 10);
  const resetEpochMs = resetSec > 0 ? resetSec * 1000 : Date.now() + 60_000;
  const tokenKey = token.slice(-8);

  let delayUntilMs = 0;
  if (limit > 0 && remaining < limit * 0.2) {
    const timeToReset = Math.max(0, resetEpochMs - Date.now());
    const perRequest = remaining > 0 ? Math.min(10_000, Math.ceil(timeToReset / remaining)) : 10_000;
    delayUntilMs = Date.now() + perRequest;
  }
  rateLimitState.set(tokenKey, { remaining, limit, resetEpochMs, delayUntilMs });

  // Evict entries whose reset window has already passed to keep the map bounded.
  const now = Date.now();
  for (const [k, v] of rateLimitState) {
    if (k !== tokenKey && v.resetEpochMs < now) rateLimitState.delete(k);
  }
}

function waitWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function proactiveRateLimitDelay(
  token: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const tokenKey = token.slice(-8);
  const state = rateLimitState.get(tokenKey);
  if (!state) return;
  const now = Date.now();
  if (state.delayUntilMs > now) {
    await waitWithSignal(state.delayUntilMs - now, signal);
  }
}

// ─── Per-user auth breakers ───────────────────────────────────────────────────

const authBreakerOpen = new Map<string, { since: number; reason: string }>();

// ─── Auth breaker persistence hooks ──────────────────────────────────────────
// Registered by clickUpBreakerPersistence.ts at boot. The hook fires once
// per new streak (not on every subsequent 401 while the breaker stays open)
// and on explicit clear — so consumers see trip/clear pairs only.
let _onBreakerTrip: ((tokenKey: string, reason: string) => void) | null = null;
let _onBreakerClear: ((tokenKey: string) => void) | null = null;

export function registerClickUpBreakerPersistenceHooks(hooks: {
  onTrip: (tokenKey: string, reason: string) => void;
  onClear: (tokenKey: string) => void;
}): void {
  _onBreakerTrip = hooks.onTrip;
  _onBreakerClear = hooks.onClear;
}

/**
 * Hydrates the in-memory breaker state at boot from persisted entries.
 * Only restores entries still within the 10-min auto-clear TTL and does NOT
 * overwrite a newer in-process trip (local-trip grace window).
 */
export function loadClickUpBreakerState(
  entries: Array<{ tokenKey: string; since: number; reason: string }>,
): void {
  const now = Date.now();
  const TTL_MS = 10 * 60 * 1000;
  for (const e of entries) {
    if (now - e.since < TTL_MS) {
      const existing = authBreakerOpen.get(e.tokenKey);
      if (!existing || existing.since < e.since) {
        authBreakerOpen.set(e.tokenKey, { since: e.since, reason: e.reason });
      }
    }
  }
}

export function isClickUpAuthBreakerOpen(tokenKey: string): boolean {
  const b = authBreakerOpen.get(tokenKey);
  if (!b) return false;
  if (Date.now() - b.since > 10 * 60 * 1000) {
    authBreakerOpen.delete(tokenKey);
    return false;
  }
  return true;
}

export function tripClickUpAuthBreaker(tokenKey: string, reason: string): void {
  const existing = authBreakerOpen.get(tokenKey);
  const now = Date.now();
  // A new streak begins when there is no existing entry or the existing entry
  // has already expired (auto-clear threshold). Keep the original `since` for a
  // continuing streak so the TTL counts from the first trip of this streak.
  const isNewStreak = !existing || now - existing.since > 10 * 60 * 1000;
  authBreakerOpen.set(tokenKey, {
    since: isNewStreak ? now : existing!.since,
    reason,
  });
  if (isNewStreak) {
    _onBreakerTrip?.(tokenKey, reason);
  }
}

export function clearClickUpAuthBreaker(tokenKey: string): void {
  authBreakerOpen.delete(tokenKey);
  _onBreakerClear?.(tokenKey);
}

// ─── Core fetch helper ────────────────────────────────────────────────────────

async function cuFetch(
  token: string,
  url: string,
  opts: RequestInit = {},
  rateLimitRetries = 0,
): Promise<Response> {
  const tokenKey = token.slice(-8);
  if (isClickUpAuthBreakerOpen(tokenKey)) {
    throw new Error("ClickUp auth breaker open — token appears invalid");
  }
  await proactiveRateLimitDelay(token, opts.signal);

  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(url, { ...opts, headers });
  updateRateLimit(token, res.headers);

  if (res.status === 429 && rateLimitRetries < 1) {
    const resetSec = parseInt(res.headers.get("X-RateLimit-Reset") ?? "0", 10);
    const waitMs = resetSec > 0
      ? Math.min(30_000, Math.max(1000, resetSec * 1000 - Date.now()))
      : 10_000;
    await waitWithSignal(waitMs, opts.signal);
    return cuFetch(token, url, opts, rateLimitRetries + 1);
  }

  if (res.status === 401 || res.status === 403) {
    tripClickUpAuthBreaker(tokenKey, `HTTP ${res.status}`);
  }

  return res;
}

async function cuGet<T>(token: string, path: string, base = CLICKUP_V2): Promise<T> {
  const res = await cuFetch(token, `${base}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp GET ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function cuPost<T>(
  token: string,
  path: string,
  body: unknown,
  base = CLICKUP_V2,
): Promise<T> {
  const res = await cuFetch(token, `${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp POST ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function cuPut<T>(
  token: string,
  path: string,
  body: unknown,
  base = CLICKUP_V2,
): Promise<T> {
  const res = await cuFetch(token, `${base}${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp PUT ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function cuDelete(token: string, path: string, base = CLICKUP_V2): Promise<void> {
  const res = await cuFetch(token, `${base}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp DELETE ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

// ─── Low-level company-token request primitive (Task #5156) ───────────────────
// The ClickUp role-projection adapter (clickUpRoleProjectionClient.ts) needs
// fine-grained status/body classification (429 vs 5xx vs 401/403 vs 404 vs 4xx)
// and its own external-call audit wrapping, so it cannot use the throw-on-error
// cuGet/cuPost helpers. This primitive is the ONLY sanctioned way for it to reach
// the vendor host: it routes through cuFetch (so the per-token auth breaker and
// rate-limit pacing apply exactly as for every other caller), accepts an explicit
// token/method/path/body plus an optional abort signal, and returns the RAW
// outcome (status + body text, no throw on non-2xx) for the caller to classify.
// The vendor hostname stays confined to this owning adapter.
export interface ClickUpRawResponse {
  ok: boolean;
  status: number;
  text: string;
}

export async function clickUpCompanyRawRequest(args: {
  token: string;
  method: string;
  /** Path beneath the v2 base, e.g. `/task/123`. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<ClickUpRawResponse> {
  const opts: RequestInit = {
    method: args.method,
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const res = await cuFetch(args.token, `${CLICKUP_V2}${args.path}`, opts);
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}

/** Backwards-compatible projection-specific name for the shared raw boundary. */
export const clickUpProjectionRawRequest = clickUpCompanyRawRequest;

// ─── Backwards-compat: shared-token task helpers ──────────────────────────────
// Routed through cuPost/cuGet so that rate-limit pacing and the per-token
// auth breaker apply on the same code path as the full per-user client.

export async function createClickUpTask(opts: {
  name: string;
  description?: string;
  listId?: string;
}): Promise<ClickUpResult<{ task: ClickUpTask }>> {
  const token = (await resolveClickUpCompanyToken()).token || null;
  const listId = opts.listId || getClickUpListId();
  if (!token) return { configured: false, reason: "No ClickUp company token is configured (env or admin override)" };
  if (!listId) return { configured: false, reason: "CLICKUP_LIST_ID is not set" };

  const json = await cuPost<any>(
    token,
    `/list/${encodeURIComponent(listId)}/task`,
    { name: opts.name, description: opts.description ?? "" },
  );
  return {
    configured: true,
    task: {
      id: String(json.id || ""),
      name: String(json.name || opts.name),
      status: normalizeStatus(json),
      url: json.url ?? null,
    },
  };
}

export async function getClickUpTask(
  taskId: string,
): Promise<ClickUpResult<{ task: ClickUpTask }>> {
  const token = (await resolveClickUpCompanyToken()).token || null;
  if (!token) return { configured: false, reason: "No ClickUp company token is configured (env or admin override)" };

  const json = await cuGet<any>(token, `/task/${encodeURIComponent(taskId)}`);
  return {
    configured: true,
    task: {
      id: String(json.id || taskId),
      name: String(json.name || ""),
      status: normalizeStatus(json),
      url: json.url ?? null,
    },
  };
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

export async function getWorkspaces(token: string): Promise<any[]> {
  const data = await cuGet<{ teams: any[] }>(token, "/team");
  return data.teams ?? [];
}

export async function getAuthorizedUser(token: string): Promise<any> {
  const data = await cuGet<{ user: any }>(token, "/user");
  return data.user;
}

// ─── Spaces ───────────────────────────────────────────────────────────────────

export async function getSpaces(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ spaces: any[] }>(token, `/team/${workspaceId}/space?archived=false`);
  return data.spaces ?? [];
}

export async function getSpace(token: string, spaceId: string): Promise<any> {
  return cuGet(token, `/space/${spaceId}`);
}

// ─── Folders ──────────────────────────────────────────────────────────────────

export async function getFolders(token: string, spaceId: string): Promise<any[]> {
  const data = await cuGet<{ folders: any[] }>(token, `/space/${spaceId}/folder?archived=false`);
  return data.folders ?? [];
}

export async function getFolder(token: string, folderId: string): Promise<any> {
  return cuGet(token, `/folder/${folderId}`);
}

// ─── Lists ────────────────────────────────────────────────────────────────────

export async function getListsInFolder(token: string, folderId: string): Promise<any[]> {
  const data = await cuGet<{ lists: any[] }>(token, `/folder/${folderId}/list?archived=false`);
  return data.lists ?? [];
}

export async function getListsInSpace(token: string, spaceId: string): Promise<any[]> {
  const data = await cuGet<{ lists: any[] }>(token, `/space/${spaceId}/list?archived=false`);
  return data.lists ?? [];
}

export async function getList(token: string, listId: string): Promise<any> {
  return cuGet(token, `/list/${listId}`);
}

export async function getCustomFields(token: string, listId: string): Promise<any[]> {
  const data = await cuGet<{ fields: any[] }>(token, `/list/${listId}/field`);
  return data.fields ?? [];
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface GetTasksOpts {
  page?: number;
  orderBy?: string;
  reverse?: boolean;
  subtasks?: boolean;
  statuses?: string[];
  includeMarkdownDescription?: boolean;
  dueDate?: number;
  assignees?: string[];
  tags?: string[];
  /** include_timl=true surfaces tasks whose home list is elsewhere (badged in UI) */
  includeTiml?: boolean;
}

export async function getTasksInList(
  token: string,
  listId: string,
  opts: GetTasksOpts = {},
): Promise<{ tasks: any[]; last_page: boolean }> {
  const params = new URLSearchParams();
  params.set("page", String(opts.page ?? 0));
  if (opts.orderBy) params.set("order_by", opts.orderBy);
  if (opts.reverse) params.set("reverse", "true");
  if (opts.subtasks) params.set("subtasks", "true");
  if (opts.includeMarkdownDescription) params.set("include_markdown_description", "true");
  if (opts.includeTiml) params.set("include_timl", "true");
  if (opts.statuses?.length) opts.statuses.forEach((s) => params.append("statuses[]", s));
  if (opts.assignees?.length) opts.assignees.forEach((a) => params.append("assignees[]", a));
  if (opts.tags?.length) opts.tags.forEach((t) => params.append("tags[]", t));
  if (opts.dueDate != null) params.set("due_date", String(opts.dueDate));
  return cuGet(token, `/list/${listId}/task?${params}`);
}

export async function getTask(token: string, taskId: string): Promise<any> {
  return cuGet(token, `/task/${taskId}?include_markdown_description=true`);
}

export async function createTask(
  token: string,
  listId: string,
  body: {
    name: string;
    description?: string;
    markdown_description?: string;
    status?: string;
    priority?: number;
    due_date?: number;
    start_date?: number;
    assignees?: string[];
    tags?: string[];
    parent?: string;
    custom_fields?: Array<{ id: string; value: any }>;
  },
): Promise<any> {
  return cuPost(token, `/list/${listId}/task`, body);
}

export async function updateTask(
  token: string,
  taskId: string,
  body: Partial<{
    name: string;
    description: string;
    markdown_description: string;
    status: string;
    priority: number | null;
    due_date: number | null;
    start_date: number | null;
    assignees: { add: string[]; rem: string[] };
    watchers: { add: number[]; rem: number[] };
    archived: boolean;
  }>,
): Promise<any> {
  return cuPut(token, `/task/${taskId}`, body);
}

export async function deleteTask(token: string, taskId: string): Promise<void> {
  return cuDelete(token, `/task/${taskId}`);
}

export async function setCustomFieldValue(
  token: string,
  taskId: string,
  fieldId: string,
  value: any,
): Promise<void> {
  await cuPost(token, `/task/${taskId}/field/${fieldId}`, { value });
}

/**
 * Remove (clear) a custom field value from a task.
 * Ref: DELETE /api/v2/task/{task_id}/field/{field_id}
 */
export async function removeCustomFieldValue(
  token: string,
  taskId: string,
  fieldId: string,
): Promise<void> {
  await cuDelete(token, `/task/${taskId}/field/${fieldId}`);
}

/**
 * Get custom task types (custom items) for a workspace.
 * Ref: GET /api/v2/team/{team_id}/custom_item
 * Returns an array of custom task type objects with { id, name, description, avatar }.
 */
export async function getCustomTaskTypes(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ custom_items: any[] }>(token, `/team/${workspaceId}/custom_item`);
  return data.custom_items ?? [];
}

/**
 * Get accessible custom fields for a folder.
 * Ref: GET /api/v2/folder/{folder_id}/field
 */
export async function getCustomFieldsForFolder(token: string, folderId: string): Promise<any[]> {
  const data = await cuGet<{ fields: any[] }>(token, `/folder/${folderId}/field`);
  return data.fields ?? [];
}

/**
 * Get accessible custom fields for a space.
 * Ref: GET /api/v2/space/{space_id}/field
 */
export async function getCustomFieldsForSpace(token: string, spaceId: string): Promise<any[]> {
  const data = await cuGet<{ fields: any[] }>(token, `/space/${spaceId}/field`);
  return data.fields ?? [];
}

/**
 * Get accessible custom fields for a workspace (team).
 * Ref: GET /api/v2/team/{team_id}/field
 */
export async function getCustomFieldsForWorkspace(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ fields: any[] }>(token, `/team/${workspaceId}/field`);
  return data.fields ?? [];
}

// ─── Checklists ───────────────────────────────────────────────────────────────

export async function createChecklist(token: string, taskId: string, name: string): Promise<any> {
  return cuPost(token, `/task/${taskId}/checklist`, { name });
}

export async function createChecklistItem(
  token: string,
  checklistId: string,
  body: { name: string; assignee?: string | number },
): Promise<any> {
  return cuPost(token, `/checklist/${checklistId}/checklist_item`, body);
}

export async function updateChecklistItem(
  token: string,
  checklistId: string,
  checklistItemId: string,
  body: { name?: string; resolved?: boolean; assignee?: string },
): Promise<any> {
  return cuPut(token, `/checklist/${checklistId}/checklist_item/${checklistItemId}`, body);
}

export async function deleteChecklist(token: string, checklistId: string): Promise<void> {
  return cuDelete(token, `/checklist/${checklistId}`);
}

// ─── Comments ─────────────────────────────────────────────────────────────────
//
// API refs (reviewed 2026-07-16):
//   GET  /task/{taskId}/comment         → GetTaskComments (newest→oldest, 25/page)
//   POST /task/{taskId}/comment         → CreateTaskComment
//   GET  /comment/{commentId}/reply     → GetThreadedComments (parent NOT included)
//   POST /comment/{commentId}/reply     → CreateThreadedComment
//   PUT  /comment/{commentId}           → UpdateComment (content, assignee, resolved)
//   DELETE /comment/{commentId}         → DeleteComment
//   GET  /list/{listId}/comment         → GetListComments (same start/start_id pagination)
//   POST /list/{listId}/comment         → CreateListComment
//
// Pagination: oldest pages use BOTH start (epoch-ms of last comment.date) AND
// start_id (id of last comment) together — missing either causes the API to
// return the first page again.
//
// Comment block format: { comment: [{ text: string, attributes?: { bold, italic,
//   underline, strikethrough, code, link, mention: { user: { id, username } } } }] }
// UpdateComment also accepts `assignee` (ClickUp user ID string or null to unassign).

export async function getTaskComments(
  token: string,
  taskId: string,
  opts: { start?: number; start_id?: string } = {},
): Promise<{ comments: any[] }> {
  const params = new URLSearchParams();
  if (opts.start != null) params.set("start", String(opts.start));
  if (opts.start_id) params.set("start_id", opts.start_id);
  const qs = params.toString() ? `?${params}` : "";
  const data = await cuGet<{ comments: any[] }>(token, `/task/${taskId}/comment${qs}`);
  return { comments: data.comments ?? [] };
}

export async function createTaskComment(
  token: string,
  taskId: string,
  body: {
    comment_text?: string;
    comment?: any[];
    assignee?: string;
    notify_all?: boolean;
  },
): Promise<any> {
  return cuPost(token, `/task/${taskId}/comment`, body);
}

/** GetThreadedComments — parent comment is NOT included in the response. */
export async function getThreadedComments(token: string, commentId: string): Promise<any[]> {
  const data = await cuGet<{ comments: any[] }>(token, `/comment/${commentId}/reply`);
  return data.comments ?? [];
}

/** CreateThreadedComment — reply to an existing comment. */
export async function createThreadedComment(
  token: string,
  commentId: string,
  body: {
    comment_text?: string;
    comment?: any[];
    notify_all?: boolean;
  },
): Promise<any> {
  return cuPost(token, `/comment/${commentId}/reply`, body);
}

export async function updateComment(
  token: string,
  commentId: string,
  body: {
    comment_text?: string;
    comment?: any[];
    resolved?: boolean;
    assignee?: string | null;
  },
): Promise<void> {
  await cuPut(token, `/comment/${commentId}`, body);
}

export async function deleteComment(token: string, commentId: string): Promise<void> {
  return cuDelete(token, `/comment/${commentId}`);
}

/** GetListComments — list-level comment stream, same start/start_id pagination. */
export async function getListComments(
  token: string,
  listId: string,
  opts: { start?: number; start_id?: string } = {},
): Promise<{ comments: any[] }> {
  const params = new URLSearchParams();
  if (opts.start != null) params.set("start", String(opts.start));
  if (opts.start_id) params.set("start_id", opts.start_id);
  const qs = params.toString() ? `?${params}` : "";
  const data = await cuGet<{ comments: any[] }>(token, `/list/${listId}/comment${qs}`);
  return { comments: data.comments ?? [] };
}

/** CreateListComment — create a comment at the list level. */
export async function createListComment(
  token: string,
  listId: string,
  body: {
    comment_text?: string;
    comment?: any[];
    assignee?: string;
    notify_all?: boolean;
  },
): Promise<any> {
  return cuPost(token, `/list/${listId}/comment`, body);
}

// ─── Attachments ──────────────────────────────────────────────────────────────
// Prefer v3 attachments API per task spec.
//
// API refs (reviewed 2026-07-16):
//   GET  /api/v3/task/{task_id}/attachment         → GetParentEntityAttachments (task)
//   GET  /api/v3/entity/{entity_id}/attachment     → GetParentEntityAttachments (CF entity)
//   POST /api/v3/task/{task_id}/attachment         → PostEntityAttachment (task)
//   POST /api/v3/entity/{entity_id}/attachment     → PostEntityAttachment (CF entity)
//
// Attachment shape: { id, name, url, url_w_query, url_w_host, mimetype, size,
//   date, extension, thumbnail_large, thumbnail_medium, thumbnail_small }

export interface ClickUpAttachment {
  id: string;
  name: string;
  url: string;
  url_w_query?: string;
  url_w_host?: string;
  mimetype: string;
  size: number;
  date: string;
  extension?: string;
  thumbnail_large?: string;
  thumbnail_medium?: string;
  thumbnail_small?: string;
}

/** List attachments for a task via v3 GetParentEntityAttachments. */
export async function listTaskAttachments(
  token: string,
  taskId: string,
): Promise<ClickUpAttachment[]> {
  const res = await cuFetch(token, `${CLICKUP_V3}/task/${taskId}/attachment`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp list attachments failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  // v3 wraps in { data: { attachments: [...] } } or { data: [...] }
  return (
    data?.data?.attachments ??
    (Array.isArray(data?.data) ? data.data : null) ??
    data?.attachments ??
    []
  );
}

/** List attachments for a file-type custom field entity via v3. */
export async function listEntityAttachments(
  token: string,
  entityId: string,
): Promise<ClickUpAttachment[]> {
  const res = await cuFetch(token, `${CLICKUP_V3}/entity/${entityId}/attachment`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp list entity attachments failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  return (
    data?.data?.attachments ??
    (Array.isArray(data?.data) ? data.data : null) ??
    data?.attachments ??
    []
  );
}

/**
 * Fetch a ClickUp attachment for server-side proxy streaming.
 * Validates the URL is hosted on a ClickUp attachment domain before fetching.
 * Returns the raw Response for the caller to pipe.
 */
export async function fetchAttachmentForProxy(
  token: string,
  attachmentUrl: string,
): Promise<Response> {
  // Validate URL is a ClickUp-owned domain to prevent SSRF
  let parsed: URL;
  try {
    parsed = new URL(attachmentUrl);
  } catch {
    throw new Error("Invalid attachment URL");
  }
  const allowedHosts = [
    "attachments.clickup.com",
    "attachments-public.clickup.com",
    "t.clickup.com",
    "app.clickup.com",
  ];
  const isAllowed = allowedHosts.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
  );
  if (!isAllowed) {
    throw new Error(`Attachment URL host not allowed: ${parsed.hostname}`);
  }

  const tokenKey = token.slice(-8);
  if (isClickUpAuthBreakerOpen(tokenKey)) {
    throw new Error("ClickUp auth breaker open");
  }
  const res = await fetch(attachmentUrl, {
    headers: { Authorization: token },
  });
  updateRateLimit(token, res.headers);
  return res;
}

/** Shared multipart upload helper — used by uploadAttachment and uploadEntityAttachment. */
async function doMultipartUpload(
  token: string,
  uploadUrl: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<any> {
  const boundary = `----FormBoundary${crypto.randomBytes(8).toString("hex")}`;
  const safeName = filename.replace(/["\\\r\n]/g, "_");
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="attachment"; filename="${safeName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, "utf8"),
    fileBuffer,
    Buffer.from(footer, "utf8"),
  ]);

  const tokenKey = token.slice(-8);
  if (isClickUpAuthBreakerOpen(tokenKey)) {
    throw new Error("ClickUp auth breaker open");
  }
  await proactiveRateLimitDelay(token);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  updateRateLimit(token, res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp attachment upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Upload to a task via v3 PostEntityAttachment. */
export async function uploadAttachment(
  token: string,
  taskId: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<any> {
  return doMultipartUpload(
    token,
    `${CLICKUP_V3}/task/${taskId}/attachment`,
    filename,
    fileBuffer,
    mimeType,
  );
}

/**
 * Upload to a file-type custom field entity via v3 PostEntityAttachment.
 * After uploading, callers should call setCustomFieldValue to associate the file.
 */
export async function uploadEntityAttachment(
  token: string,
  entityId: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<any> {
  return doMultipartUpload(
    token,
    `${CLICKUP_V3}/entity/${entityId}/attachment`,
    filename,
    fileBuffer,
    mimeType,
  );
}

/**
 * Delete an attachment by ID (v2 DELETE /attachment/{id}).
 * ClickUp does not guarantee this endpoint exists for all plan levels;
 * callers should surface the error gracefully rather than hard-failing.
 */
export async function deleteAttachment(token: string, attachmentId: string): Promise<void> {
  return cuDelete(token, `/attachment/${attachmentId}`);
}

// ─── Time tracking ────────────────────────────────────────────────────────────

export async function getTimeEntries(
  token: string,
  workspaceId: string,
  opts: { task_id?: string; assignee?: string; start?: number; end?: number } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.task_id) params.set("task_id", opts.task_id);
  if (opts.assignee) params.set("assignee", opts.assignee);
  if (opts.start) params.set("start_date", String(opts.start));
  if (opts.end) params.set("end_date", String(opts.end));
  const data = await cuGet<{ data: any[] }>(
    token,
    `/team/${workspaceId}/time_entries?${params}`,
  );
  return data.data ?? [];
}

export async function startTimer(
  token: string,
  workspaceId: string,
  taskId: string,
  description?: string,
): Promise<any> {
  return cuPost(token, `/team/${workspaceId}/time_entries/start`, {
    tid: taskId,
    description: description ?? "",
  });
}

export async function stopTimer(token: string, workspaceId: string): Promise<any> {
  return cuPost(token, `/team/${workspaceId}/time_entries/stop`, {});
}

export async function createTimeEntry(
  token: string,
  workspaceId: string,
  body: {
    tid?: string;
    description?: string;
    start: number;
    duration: number;
    billable?: boolean;
  },
): Promise<any> {
  return cuPost(token, `/team/${workspaceId}/time_entries`, body);
}

export async function updateTimeEntry(
  token: string,
  workspaceId: string,
  timeEntryId: string,
  body: Partial<{ description: string; start: number; duration: number; billable: boolean }>,
): Promise<any> {
  return cuPut(token, `/team/${workspaceId}/time_entries/${timeEntryId}`, body);
}

export async function deleteTimeEntry(
  token: string,
  workspaceId: string,
  timeEntryId: string,
): Promise<void> {
  return cuDelete(token, `/team/${workspaceId}/time_entries/${timeEntryId}`);
}

export async function getRunningTimer(token: string, workspaceId: string): Promise<any | null> {
  const data = await cuGet<{ data: any }>(token, `/team/${workspaceId}/time_entries/current`);
  return data.data ?? null;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

export async function getGoals(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ goals: any[] }>(token, `/team/${workspaceId}/goal`);
  return data.goals ?? [];
}

export async function getGoal(token: string, goalId: string): Promise<any> {
  const data = await cuGet<{ goal: any }>(token, `/goal/${goalId}`);
  return data.goal;
}

export async function updateGoal(
  token: string,
  goalId: string,
  body: Partial<{ name: string; due_date: number; description: string; color: string }>,
): Promise<any> {
  return cuPut(token, `/goal/${goalId}`, body);
}

export async function updateKeyResult(
  token: string,
  goalId: string,
  keyResultId: string,
  body: Partial<{ steps_current: number; note: string; name: string }>,
): Promise<any> {
  return cuPut(token, `/goal/${goalId}/key_result/${keyResultId}`, body);
}

// Goals CRUD (Task #2980)
// API refs consulted 2026-07-16:
//   developer.clickup.com/reference/creategoal   POST /team/{team_id}/goal
//   developer.clickup.com/reference/updategoal   PUT  /goal/{goal_id}
//   developer.clickup.com/reference/deletegoal   DELETE /goal/{goal_id}
//   developer.clickup.com/reference/createkeyresult  POST /goal/{goal_id}/key_result
//   developer.clickup.com/reference/editkeyresult    PUT  /goal/{goal_id}/key_result/{kr_id}
//   developer.clickup.com/reference/deletekeyresult  DELETE /goal/{goal_id}/key_result/{kr_id}
//
// Goal owners: user numeric IDs.
// UpdateGoal uses add_owners/rem_owners (arrays of numeric IDs).
// Key result types: "number" | "currency" | "boolean" | "percentage" | "automatic"
//   automatic = task-based (tracks task completion); uses task_ids and list_ids.
//   number/currency/percentage: steps_start, steps_end, unit.
//   boolean: steps_start/end ignored (0/1).

export async function createGoal(
  token: string,
  workspaceId: string,
  body: {
    name: string;
    due_date?: number | null;
    description?: string;
    multiple_owners?: boolean;
    owners?: number[];
    color?: string;
  },
): Promise<any> {
  const data = await cuPost<{ goal: any }>(token, `/team/${workspaceId}/goal`, body);
  return data.goal ?? data;
}

export async function updateGoalFull(
  token: string,
  goalId: string,
  body: Partial<{
    name: string;
    due_date: number | null;
    description: string;
    add_owners: number[];
    rem_owners: number[];
    color: string;
    is_archived: boolean;
  }>,
): Promise<any> {
  return cuPut(token, `/goal/${goalId}`, body);
}

export async function deleteGoal(token: string, goalId: string): Promise<void> {
  return cuDelete(token, `/goal/${goalId}`);
}

export async function createKeyResult(
  token: string,
  goalId: string,
  body: {
    name: string;
    type: "number" | "currency" | "boolean" | "percentage" | "automatic";
    owners?: number[];
    steps_start?: number;
    steps_end?: number;
    unit?: string;
    task_ids?: string[];
    list_ids?: string[];
  },
): Promise<any> {
  const data = await cuPost<{ key_result: any }>(token, `/goal/${goalId}/key_result`, body);
  return data.key_result ?? data;
}

export async function deleteKeyResult(
  token: string,
  goalId: string,
  keyResultId: string,
): Promise<void> {
  return cuDelete(token, `/goal/${goalId}/key_result/${keyResultId}`);
}

// ─── Docs (v3) ────────────────────────────────────────────────────────────────
// v3 Docs API: workspaces/{team_id}/docs

export async function getDocs(
  token: string,
  workspaceId: string,
  opts: { parent_type?: number; parent_id?: string } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.parent_type != null) params.set("parent_type", String(opts.parent_type));
  if (opts.parent_id) params.set("parent_id", opts.parent_id);
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/docs${params.toString() ? `?${params}` : ""}`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

export async function getDocPages(token: string, workspaceId: string, docId: string): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/docs/${docId}/pages`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

export async function getDocPage(
  token: string,
  workspaceId: string,
  docId: string,
  pageId: string,
): Promise<any> {
  return cuGet(token, `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, CLICKUP_V3);
}

export async function updateDocPage(
  token: string,
  workspaceId: string,
  docId: string,
  pageId: string,
  body: { content: string; content_format?: string },
): Promise<any> {
  return cuPut(token, `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, body, CLICKUP_V3);
}

/**
 * Search Docs across a workspace by free-text query. SearchDocsPublic.
 * Ref: GET /api/v3/workspaces/{workspace_id}/docs?query=<q>
 * Reviewed 2026-07-16: developer.clickup.com/reference/searchdocspublic
 */
export async function searchDocs(
  token: string,
  workspaceId: string,
  query: string,
): Promise<any[]> {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/docs${params.toString() ? `?${params}` : ""}`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/**
 * Get a single Doc by ID. GetDocPublic.
 * Ref: GET /api/v3/workspaces/{workspace_id}/docs/{doc_id}
 * Reviewed 2026-07-16: developer.clickup.com/reference/getdocpublic
 */
export async function getDoc(
  token: string,
  workspaceId: string,
  docId: string,
): Promise<any> {
  return cuGet(token, `/workspaces/${workspaceId}/docs/${docId}`, CLICKUP_V3);
}

/**
 * Get the page listing (flat list with parent_page_id for tree reconstruction).
 * GetDocPageListingPublic.
 * Ref: GET /api/v3/workspaces/{workspace_id}/docs/{doc_id}/pageListing
 * Reviewed 2026-07-16: developer.clickup.com/reference/getdocpagelistingpublic
 */
export async function getDocPageListing(
  token: string,
  workspaceId: string,
  docId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/docs/${docId}/pageListing`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/**
 * Create a new Doc in the workspace. CreateDocPublic.
 * Ref: POST /api/v3/workspaces/{workspace_id}/docs
 * Reviewed 2026-07-16: developer.clickup.com/reference/createdocpublic
 *
 * parent.type: 7=workspace, 4=space, 6=folder, 5=list
 * create_page: whether to create an initial blank page (default true)
 */
export async function createDoc(
  token: string,
  workspaceId: string,
  body: {
    name: string;
    parent?: { id: string; type: number };
    visibility?: "PRIVATE" | "PUBLIC";
    create_page?: boolean;
  },
): Promise<any> {
  return cuPost(token, `/workspaces/${workspaceId}/docs`, body, CLICKUP_V3);
}

/**
 * Create a new page within a Doc. CreatePagePublic.
 * Ref: POST /api/v3/workspaces/{workspace_id}/docs/{doc_id}/pages
 * Reviewed 2026-07-16: developer.clickup.com/reference/createpagepublic
 *
 * parent_page_id: set to another page ID for sub-pages; omit for top-level pages.
 * content_format: "text/md" for markdown (preferred).
 */
export async function createDocPage(
  token: string,
  workspaceId: string,
  docId: string,
  body: {
    name: string;
    content?: string;
    content_format?: string;
    parent_page_id?: string;
  },
): Promise<any> {
  return cuPost(
    token,
    `/workspaces/${workspaceId}/docs/${docId}/pages`,
    body,
    CLICKUP_V3,
  );
}

// ─── Task relationship operations (Epic 4/16) ─────────────────────────────────
// API refs consulted 2026-07-16:
//   developer.clickup.com/docs/tasks  (AddDependency / DeleteDependency)
//   developer.clickup.com/reference/addtasklink  (AddTaskLink / DeleteTaskLink)
//   developer.clickup.com/reference/mergetasks   (MergeTasks)
//
// Subtasks: created via createTask with `parent` field; fetched via
//   getTask(taskId)?include_subtasks=true or GetTasksInList?subtasks=true
// Watchers: managed through updateTask body `watchers: { add, rem }`

// Fetch a task with subtasks and TIML secondary-list memberships.
export async function getTaskWithSubtasks(token: string, taskId: string): Promise<any> {
  return cuGet(
    token,
    `/task/${taskId}?include_markdown_description=true&include_subtasks=true&include_timl=true`,
  );
}

// ─── Move Task / Tasks in Multiple Lists (Epic 5/16) ──────────────────────────
//
// API refs consulted 2026-07-16:
//   developer.clickup.com/reference/movetask       — POST /list/{listId}/task/{taskId}
//   developer.clickup.com/docs/move-a-task-to-a-new-list
//   developer.clickup.com/reference/addtasktorelationship — AddTaskToList
//   developer.clickup.com/reference/removetaskfromlist    — RemoveTaskFromList
//   developer.clickup.com/reference/gettasks       — include_timl param
//
// MoveTask:          POST /list/{newListId}/task/{taskId}      — changes home list.
// AddTaskToList:     POST /list/{listId}/task/{taskId}         — TIML add; same endpoint,
//                    different intent; ClickApp must be enabled.
// RemoveTaskFromList: DELETE /list/{listId}/task/{taskId}      — TIML remove; cannot remove
//                    home list (ClickUp returns a specific error).
//
// ClickApp-disabled error: ClickUp returns HTTP 400 with an error message containing
// "Tasks in Multiple Lists" when the TIML ClickApp is off. Callers should surface
// this with a clear explanation rather than a raw API error.

/**
 * Move a task to a new home List.
 * Uses POST /list/{newListId}/task/{taskId} — ClickUp's dedicated MoveTask endpoint.
 * With TIML disabled this changes the home list; with TIML enabled it moves the home list
 * (per the ClickUp guide: "for Tasks in Multiple Lists it only moves the home List").
 */
export async function moveTask(token: string, taskId: string, newListId: string): Promise<any> {
  return cuPost<any>(
    token,
    `/list/${encodeURIComponent(newListId)}/task/${encodeURIComponent(taskId)}`,
    {},
  );
}

/**
 * Add a task to an additional List (Tasks in Multiple Lists).
 * Requires the TIML ClickApp to be enabled on the workspace.
 * If disabled, ClickUp returns HTTP 400 — callers should check isTiMlDisabledError().
 */
export async function addTaskToList(token: string, taskId: string, listId: string): Promise<any> {
  return cuPost<any>(
    token,
    `/list/${encodeURIComponent(listId)}/task/${encodeURIComponent(taskId)}`,
    {},
  );
}

/**
 * Remove a task from an additional List (Tasks in Multiple Lists).
 * The home List cannot be removed via this endpoint — ClickUp will return an error.
 * If TIML ClickApp is disabled, ClickUp returns HTTP 400.
 */
export async function removeTaskFromList(
  token: string,
  taskId: string,
  listId: string,
): Promise<void> {
  return cuDelete(
    token,
    `/list/${encodeURIComponent(listId)}/task/${encodeURIComponent(taskId)}`,
  );
}

/**
 * Classify whether an error from addTaskToList / removeTaskFromList is caused by the
 * Tasks in Multiple Lists ClickApp being disabled (rather than a transient error).
 * Callers should surface a user-friendly explanation in this case.
 */
export function isTiMlDisabledError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes("tasks in multiple lists") ||
    msg.includes("timl") ||
    msg.includes("clickapp") ||
    (msg.includes("400") && msg.includes("list"))
  );
}

// Dependencies — `depends_on`: this task waits on the given task.
//                `dependency_of`: this task is blocking the given task.
export async function addDependency(
  token: string,
  taskId: string,
  opts: { depends_on?: string; dependency_of?: string },
): Promise<void> {
  await cuPost(token, `/task/${taskId}/dependency`, opts);
}

export async function deleteDependency(
  token: string,
  taskId: string,
  opts: { depends_on?: string; dependency_of?: string },
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.depends_on) params.set("depends_on", opts.depends_on);
  if (opts.dependency_of) params.set("dependency_of", opts.dependency_of);
  await cuDelete(token, `/task/${taskId}/dependency?${params}`);
}

// Task links (plain bidirectional links, not dependencies).
export async function addTaskLink(
  token: string,
  taskId: string,
  linksTo: string,
): Promise<void> {
  await cuPost(token, `/task/${taskId}/link/${encodeURIComponent(linksTo)}`, {});
}

export async function deleteTaskLink(
  token: string,
  taskId: string,
  linksTo: string,
): Promise<void> {
  await cuDelete(token, `/task/${taskId}/link/${encodeURIComponent(linksTo)}`);
}

// Merge: merges source task_ids into the target task (targetTaskId).
export async function mergeTasks(
  token: string,
  targetTaskId: string,
  sourceTaskIds: string[],
): Promise<void> {
  await cuPost(token, `/task/${targetTaskId}/merge`, { task_ids: sourceTaskIds });
}

// Workspace-level task search — simple query wrapper used by task pickers.
export async function searchWorkspaceTasks(
  token: string,
  workspaceId: string,
  query: string,
): Promise<any[]> {
  const params = new URLSearchParams({ query, page: "0" });
  const data = await cuGet<{ tasks: any[] }>(
    token,
    `/team/${workspaceId}/task?${params}`,
  );
  return data.tasks ?? [];
}

// ─── Workspace-wide filtered task search (GetFilteredTeamTasks) ───────────────
//
// Ref: developer.clickup.com/docs/get-filtered-team-tasks
//   GET /team/{team_id}/task
//   100 tasks per page; page is 0-indexed.
//   custom_fields: JSON-encoded array of { field_id, operator, value }
//   Operators (text/dropdown): =, !=, <, >, <=, >=, is null, is not null,
//     contains, not contains, starts with, ends with
//   Range (date/number): use { operator: "RANGE", value: { lower, upper } }
//   Dates are epoch milliseconds strings; numbers are plain strings.

export type CUCustomFieldFilter =
  | { field_id: string; operator: "=" | "!=" | "<" | ">" | "<=" | ">=" | "contains" | "not contains" | "starts with" | "ends with" | "is null" | "is not null"; value?: string }
  | { field_id: string; operator: "RANGE"; value: { lower: string; upper: string } };

export interface GetFilteredTeamTasksOpts {
  /** Free-text search (matched against task name + description) */
  query?: string;
  page?: number;
  orderBy?: string;
  reverse?: boolean;
  subtasks?: boolean;
  includeClosed?: boolean;
  /** Space IDs to scope the search */
  spaceIds?: string[];
  /** Folder (project) IDs to scope */
  folderIds?: string[];
  /** List IDs to scope */
  listIds?: string[];
  statuses?: string[];
  assignees?: string[];
  tags?: string[];
  /** epoch-ms — tasks due after this */
  dueDateGt?: number;
  /** epoch-ms — tasks due before this */
  dueDateLt?: number;
  /** epoch-ms — tasks starting after this */
  startDateGt?: number;
  /** epoch-ms — tasks starting before this */
  startDateLt?: number;
  /** 1=urgent 2=high 3=normal 4=low */
  priorities?: number[];
  customFields?: CUCustomFieldFilter[];
  includeMarkdownDescription?: boolean;
}

export async function getFilteredTeamTasks(
  token: string,
  workspaceId: string,
  opts: GetFilteredTeamTasksOpts = {},
): Promise<{ tasks: any[]; last_page: boolean }> {
  const params = new URLSearchParams();
  params.set("page", String(opts.page ?? 0));
  if (opts.orderBy) params.set("order_by", opts.orderBy);
  if (opts.reverse) params.set("reverse", "true");
  if (opts.subtasks) params.set("subtasks", "true");
  if (opts.includeClosed) params.set("include_closed", "true");
  if (opts.includeMarkdownDescription) params.set("include_markdown_description", "true");
  if (opts.query) params.set("text_field", opts.query);

  if (opts.spaceIds?.length) opts.spaceIds.forEach((id) => params.append("space_ids[]", id));
  if (opts.folderIds?.length) opts.folderIds.forEach((id) => params.append("project_ids[]", id));
  if (opts.listIds?.length) opts.listIds.forEach((id) => params.append("list_ids[]", id));
  if (opts.statuses?.length) opts.statuses.forEach((s) => params.append("statuses[]", s));
  if (opts.assignees?.length) opts.assignees.forEach((a) => params.append("assignees[]", a));
  if (opts.tags?.length) opts.tags.forEach((t) => params.append("tags[]", t));
  if (opts.priorities?.length) opts.priorities.forEach((p) => params.append("priority[]", String(p)));

  if (opts.dueDateGt != null) params.set("due_date_gt", String(opts.dueDateGt));
  if (opts.dueDateLt != null) params.set("due_date_lt", String(opts.dueDateLt));
  if (opts.startDateGt != null) params.set("start_date_gt", String(opts.startDateGt));
  if (opts.startDateLt != null) params.set("start_date_lt", String(opts.startDateLt));

  if (opts.customFields?.length) {
    params.set("custom_fields", JSON.stringify(opts.customFields));
  }

  return cuGet(token, `/team/${workspaceId}/task?${params}`);
}

// ─── Space Tags ───────────────────────────────────────────────────────────────
// API refs (2026-07-16):
//   GET    /api/v2/space/{space_id}/tag               — GetSpaceTags
//   POST   /api/v2/space/{space_id}/tag               — CreateSpaceTag
//   PUT    /api/v2/space/{space_id}/tag/{tag_name}    — EditSpaceTag
//   DELETE /api/v2/space/{space_id}/tag/{tag_name}    — DeleteSpaceTag
//   POST   /api/v2/task/{task_id}/tag/{tag_name}      — AddTagToTask
//   DELETE /api/v2/task/{task_id}/tag/{tag_name}      — RemoveTagFromTask
//
// Tags are Space-scoped. Removing a tag from a task does not delete it from the Space.
// Tag names are URL-encoded when used in path segments.

export interface SpaceTag {
  name: string;
  tag_fg: string;
  tag_bg: string;
  creator?: number;
}

export async function getSpaceTags(token: string, spaceId: string): Promise<SpaceTag[]> {
  const data = await cuGet<{ tags: SpaceTag[] }>(token, `/space/${spaceId}/tag`);
  return data.tags ?? [];
}

export async function createSpaceTag(
  token: string,
  spaceId: string,
  body: { name: string; tag_fg?: string; tag_bg?: string },
): Promise<void> {
  await cuPost(token, `/space/${spaceId}/tag`, body);
}

export async function editSpaceTag(
  token: string,
  spaceId: string,
  tagName: string,
  body: { name?: string; tag_fg?: string; tag_bg?: string },
): Promise<void> {
  await cuPut(token, `/space/${spaceId}/tag/${encodeURIComponent(tagName)}`, body);
}

export async function deleteSpaceTag(
  token: string,
  spaceId: string,
  tagName: string,
): Promise<void> {
  await cuDelete(token, `/space/${spaceId}/tag/${encodeURIComponent(tagName)}`);
}

export async function addTagToTask(
  token: string,
  taskId: string,
  tagName: string,
): Promise<void> {
  await cuPost(token, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {});
}

export async function removeTagFromTask(
  token: string,
  taskId: string,
  tagName: string,
): Promise<void> {
  await cuDelete(token, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`);
}

// ─── Members ──────────────────────────────────────────────────────────────────

export async function getWorkspaceMembers(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ team: { members: any[] } }>(token, `/team/${workspaceId}`);
  return data.team?.members ?? [];
}

// ─── Space management ─────────────────────────────────────────────────────────
// Refs: developer.clickup.com/reference/createspace
//       developer.clickup.com/reference/updatespace
//       developer.clickup.com/reference/deletespace

export async function createSpace(
  token: string,
  workspaceId: string,
  body: {
    name: string;
    multiple_assignees?: boolean;
    features?: Record<string, { enabled: boolean }>;
  },
): Promise<any> {
  return cuPost(token, `/team/${workspaceId}/space`, body);
}

export async function updateSpace(
  token: string,
  spaceId: string,
  body: Partial<{
    name: string;
    color: string | null;
    private: boolean;
    admin_can_manage: boolean;
    multiple_assignees: boolean;
    features: Record<string, { enabled: boolean } | boolean>;
  }>,
): Promise<any> {
  return cuPut(token, `/space/${spaceId}`, body);
}

export async function deleteSpace(token: string, spaceId: string): Promise<void> {
  return cuDelete(token, `/space/${spaceId}`);
}

// ─── Folder management ────────────────────────────────────────────────────────
// Refs: developer.clickup.com/reference/createfolder
//       developer.clickup.com/reference/updatefolder
//       developer.clickup.com/reference/deletefolder

export async function createFolder(token: string, spaceId: string, name: string): Promise<any> {
  return cuPost(token, `/space/${spaceId}/folder`, { name });
}

export async function updateFolder(
  token: string,
  folderId: string,
  body: Partial<{ name: string; override_statuses: boolean }>,
): Promise<any> {
  return cuPut(token, `/folder/${folderId}`, body);
}

export async function deleteFolder(token: string, folderId: string): Promise<void> {
  return cuDelete(token, `/folder/${folderId}`);
}

// ─── List management ──────────────────────────────────────────────────────────
// Refs: developer.clickup.com/reference/createlist (in folder)
//       developer.clickup.com/reference/createfolderlesslist (in space)
//       developer.clickup.com/reference/updatelist
//       developer.clickup.com/reference/deletelist

export type ListBody = Partial<{
  name: string;
  content: string;
  due_date: number | null;
  due_date_time: boolean;
  priority: number | null;
  assignee: string | null;
  status: string;
  color: string | null;
}>;

export async function createListInFolder(
  token: string,
  folderId: string,
  body: { name: string } & ListBody,
): Promise<any> {
  return cuPost(token, `/folder/${folderId}/list`, body);
}

export async function createFolderlessList(
  token: string,
  spaceId: string,
  body: { name: string } & ListBody,
): Promise<any> {
  return cuPost(token, `/space/${spaceId}/list`, body);
}

export async function updateList(
  token: string,
  listId: string,
  body: ListBody,
): Promise<any> {
  return cuPut(token, `/list/${listId}`, body);
}

export async function deleteList(token: string, listId: string): Promise<void> {
  return cuDelete(token, `/list/${listId}`);
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export async function getWebhooks(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ webhooks: any[] }>(token, `/team/${workspaceId}/webhook`);
  return data.webhooks ?? [];
}

export async function createWebhook(
  token: string,
  workspaceId: string,
  endpoint: string,
  events: string[] = ["*"],
  location?: {
    type: "space" | "folder" | "list";
    id: string;
  },
): Promise<any> {
  const body: any = { endpoint, events };
  if (location) body[`${location.type}_id`] = location.id;
  return cuPost(token, `/team/${workspaceId}/webhook`, body);
}

export async function deleteWebhook(token: string, webhookId: string): Promise<void> {
  return cuDelete(token, `/webhook/${webhookId}`);
}

// ─── Views ─────────────────────────────────────────────────────────────────────
//
// API refs consulted 2026-07-16:
//   developer.clickup.com/docs/views            (view types overview)
//   developer.clickup.com/reference/getteamviews   GET  /team/{id}/view
//   developer.clickup.com/reference/createteamview  POST /team/{id}/view
//   developer.clickup.com/reference/getspaceviews  GET  /space/{id}/view
//   developer.clickup.com/reference/getfolderviews GET  /folder/{id}/view
//   developer.clickup.com/reference/getlistviews   GET  /list/{id}/view (+ required_views)
//   developer.clickup.com/reference/getview        GET  /view/{id}
//   developer.clickup.com/reference/updateview     PUT  /view/{id}
//   developer.clickup.com/reference/deleteview     DELETE /view/{id}
//   developer.clickup.com/reference/getviewtasks   GET  /view/{id}/task?page=N (100/page)
//
// View types: list, board, calendar, table, timeline, workload, activity, map, chat, gantt
// NoBull renders natively: list, board, table, calendar
// Unsupported (deep-link only): timeline, workload, gantt, map, activity, chat

export interface ClickUpView {
  id: string;
  name: string;
  type: string;
  parent?: { id: string; type: number };
  url?: string;
  grouping?: { field?: string; dir?: number };
  sorting?: { fields?: Array<{ field: string; idx?: number }> };
  filters?: { show_closed?: boolean; assignees?: any[]; fields?: any[] };
  columns?: { fields?: any[] };
  settings?: any;
}

/** GetTeamViews — views at the "Everything" (workspace) level. */
export async function getTeamViews(token: string, workspaceId: string): Promise<ClickUpView[]> {
  const data = await cuGet<{ views: ClickUpView[] }>(token, `/team/${workspaceId}/view`);
  return data.views ?? [];
}

/** CreateTeamView — create a view at workspace level. */
export async function createTeamView(
  token: string,
  workspaceId: string,
  body: { name: string; type?: string },
): Promise<ClickUpView> {
  const data = await cuPost<{ view: ClickUpView }>(token, `/team/${workspaceId}/view`, {
    name: body.name,
    type: body.type ?? "list",
  });
  return data.view;
}

/** GetSpaceViews — views within a space. */
export async function getSpaceViews(token: string, spaceId: string): Promise<ClickUpView[]> {
  const data = await cuGet<{ views: ClickUpView[] }>(token, `/space/${spaceId}/view`);
  return data.views ?? [];
}

/** CreateSpaceView — create a view within a space. */
export async function createSpaceView(
  token: string,
  spaceId: string,
  body: { name: string; type?: string },
): Promise<ClickUpView> {
  const data = await cuPost<{ view: ClickUpView }>(token, `/space/${spaceId}/view`, {
    name: body.name,
    type: body.type ?? "list",
  });
  return data.view;
}

/** GetFolderViews — views within a folder. */
export async function getFolderViews(token: string, folderId: string): Promise<ClickUpView[]> {
  const data = await cuGet<{ views: ClickUpView[] }>(token, `/folder/${folderId}/view`);
  return data.views ?? [];
}

/** CreateFolderView — create a view within a folder. */
export async function createFolderView(
  token: string,
  folderId: string,
  body: { name: string; type?: string },
): Promise<ClickUpView> {
  const data = await cuPost<{ view: ClickUpView }>(token, `/folder/${folderId}/view`, {
    name: body.name,
    type: body.type ?? "list",
  });
  return data.view;
}

/**
 * GetListViews — views within a list.
 * Returns both user-created views and system required_views.
 */
export async function getListViews(
  token: string,
  listId: string,
): Promise<{ views: ClickUpView[]; required_views: ClickUpView[] }> {
  const data = await cuGet<{ views: ClickUpView[]; required_views: ClickUpView[] }>(
    token,
    `/list/${listId}/view`,
  );
  return { views: data.views ?? [], required_views: data.required_views ?? [] };
}

/** CreateListView — create a view within a list. */
export async function createListView(
  token: string,
  listId: string,
  body: { name: string; type?: string },
): Promise<ClickUpView> {
  const data = await cuPost<{ view: ClickUpView }>(token, `/list/${listId}/view`, {
    name: body.name,
    type: body.type ?? "list",
  });
  return data.view;
}

/** GetView — fetch a single view by ID. */
export async function getView(token: string, viewId: string): Promise<ClickUpView> {
  const data = await cuGet<{ view: ClickUpView }>(token, `/view/${viewId}`);
  return data.view;
}

/**
 * UpdateView — rename, change grouping, sorting, filters, columns, or settings.
 * Only the provided keys are changed.
 */
export async function updateView(
  token: string,
  viewId: string,
  body: Partial<{
    name: string;
    grouping: { field?: string; dir?: number };
    sorting: { fields?: Array<{ field: string; idx?: number }> };
    filters: { show_closed?: boolean; assignees?: any[]; fields?: any[] };
    columns: { fields?: any[] };
    settings: any;
  }>,
): Promise<ClickUpView> {
  const data = await cuPut<{ view: ClickUpView }>(token, `/view/${viewId}`, body);
  return data.view;
}

/** DeleteView — permanently removes the view from ClickUp. */
export async function deleteView(token: string, viewId: string): Promise<void> {
  return cuDelete(token, `/view/${viewId}`);
}

/**
 * GetViewTasks — all visible tasks in a view, paginated.
 * Page is 0-indexed; ClickUp returns up to 100 tasks per page.
 */
export async function getViewTasks(
  token: string,
  viewId: string,
  page = 0,
): Promise<{ tasks: any[]; last_page: boolean }> {
  return cuGet(token, `/view/${viewId}/task?page=${page}`);
}

// ─── Templates ────────────────────────────────────────────────────────────────
//
// API refs consulted 2026-07-16:
//   developer.clickup.com/reference/gettasktemplates       GET  /team/{id}/taskTemplate
//   developer.clickup.com/reference/getlisttemplates       GET  /team/{id}/listTemplate
//   developer.clickup.com/reference/getfoldertemplates     GET  /team/{id}/folderTemplate
//   developer.clickup.com/reference/createtaskfromtemplate POST /list/{id}/taskTemplate/{tplId}
//   developer.clickup.com/reference/createfolderlistfromtemplate POST /folder/{id}/listTemplate/{tplId}
//   developer.clickup.com/reference/createspacelistfromtemplate  POST /space/{id}/listTemplate/{tplId}
//   developer.clickup.com/reference/createfolderfromtemplate     POST /space/{id}/folderTemplate/{tplId}
//
// Notes:
//   - Only templates that have been added to the workspace library appear in GET results.
//   - Creating or editing template definitions is NOT exposed by the ClickUp public API.
//   - `return_immediately` (List/Folder templates): when true the API returns before all
//     nested assets are created; the caller must schedule a targeted sub-tree refresh.
//     On sync timeout ClickUp continues creating objects past the timeout window.

export interface CUTemplate {
  id: string;
  name: string;
  content?: string;
}

/** GetTaskTemplates — workspace task templates. */
export async function getTaskTemplates(token: string, workspaceId: string): Promise<CUTemplate[]> {
  const data = await cuGet<{ templates: CUTemplate[] }>(token, `/team/${workspaceId}/taskTemplate`);
  return data.templates ?? [];
}

/** GetListTemplates — workspace list templates. */
export async function getListTemplates(token: string, workspaceId: string): Promise<CUTemplate[]> {
  const data = await cuGet<{ templates: CUTemplate[] }>(token, `/team/${workspaceId}/listTemplate`);
  return data.templates ?? [];
}

/** GetFolderTemplates — workspace folder templates. */
export async function getFolderTemplates(token: string, workspaceId: string): Promise<CUTemplate[]> {
  const data = await cuGet<{ templates: CUTemplate[] }>(
    token,
    `/team/${workspaceId}/folderTemplate`,
  );
  return data.templates ?? [];
}

/** CreateTaskFromTemplate — creates a task in a List from a task template. */
export async function createTaskFromTemplate(
  token: string,
  listId: string,
  templateId: string,
  body: { name?: string } = {},
): Promise<any> {
  return cuPost(
    token,
    `/list/${encodeURIComponent(listId)}/taskTemplate/${encodeURIComponent(templateId)}`,
    body,
  );
}

// ─── Time tracking completeness (Epic 9/16) ───────────────────────────────────
//
// API refs consulted 2026-07-16:
//   developer.clickup.com/reference/gettimeentrieswithinadaterange
//     (defaults last 30 days; ONE location filter at a time; negative duration = running)
//   developer.clickup.com/reference/getsingulartimeentry
//   developer.clickup.com/reference/gettimeentryhistory
//   developer.clickup.com/reference/getalltagsfortimeentries
//   developer.clickup.com/reference/addtagsfromtimeentries
//   developer.clickup.com/reference/removetagsfromtimeentries
//   developer.clickup.com/reference/changetagnamesfromtimeentries
//   developer.clickup.com/reference/updatetimeestimatesbyuser
//   developer.clickup.com/reference/gettasktimeinstatus
//   developer.clickup.com/reference/getbulktasktimeinstatus
//   developer.clickup.com/docs/apis-available-by-plan
//     (unlimited tags, entries not tied to tasks, assignee for others: Business Plus+)
//     (time estimates per user: Business plan+)

/**
 * Returns true when the ClickUp error text indicates a plan-limitation.
 * Callers should surface this as a "requires upgrade" notice, never a raw error.
 */
export function isPlanLimitError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("upgrade") ||
    lower.includes("business plus") ||
    lower.includes("not available on your plan") ||
    lower.includes("feature is not available") ||
    lower.includes("plan does not include") ||
    (lower.includes("plan") && lower.includes("feature"))
  );
}

/** GetSingularTimeEntry — fetch a single entry by ID. */
export async function getSingleTimeEntry(
  token: string,
  workspaceId: string,
  timerId: string,
): Promise<any> {
  const data = await cuGet<{ data: any }>(
    token,
    `/team/${workspaceId}/time_entries/${timerId}`,
  );
  return data.data ?? data;
}

/** GetTimeEntryHistory — change history for a single entry. */
export async function getTimeEntryHistory(
  token: string,
  workspaceId: string,
  timerId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/team/${workspaceId}/time_entries/${timerId}/history`,
  );
  return data.data ?? [];
}

/** GetAllTagsForTimeEntries — all tag names used in a workspace. */
export async function getTimeEntryTags(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/team/${workspaceId}/time_entries/tags`,
  );
  return data.data ?? [];
}

/**
 * AddTagsFromTimeEntries — add named tags to a specific time entry.
 * Requires Business Plus plan for tags on entries not tied to a task.
 */
export async function addTagsToTimeEntry(
  token: string,
  workspaceId: string,
  timerId: string,
  tags: Array<{ name: string }>,
): Promise<void> {
  await cuPost(
    token,
    `/team/${workspaceId}/time_entries/${timerId}/tag`,
    { tags },
  );
}

/**
 * CreateFolderListFromTemplate — creates a List in a Folder from a list template.
 * Pass `return_immediately: true` for async creation (large templates).
 */
export async function createListFromTemplateInFolder(
  token: string,
  folderId: string,
  templateId: string,
  body: { name?: string; return_immediately?: boolean } = {},
): Promise<any> {
  return cuPost(
    token,
    `/folder/${encodeURIComponent(folderId)}/listTemplate/${encodeURIComponent(templateId)}`,
    body,
  );
}

/**
 * CreateSpaceListFromTemplate — creates a List in a Space from a list template.
 * Pass `return_immediately: true` for async creation (large templates).
 */
export async function createListFromTemplateInSpace(
  token: string,
  spaceId: string,
  templateId: string,
  body: { name?: string; return_immediately?: boolean } = {},
): Promise<any> {
  return cuPost(
    token,
    `/space/${encodeURIComponent(spaceId)}/listTemplate/${encodeURIComponent(templateId)}`,
    body,
  );
}

/**
 * CreateFolderFromTemplate — creates a Folder with all nested assets from a folder template.
 * Pass `return_immediately: true` for async creation (large templates).
 */
export async function createFolderFromTemplate(
  token: string,
  spaceId: string,
  templateId: string,
  body: { name?: string; return_immediately?: boolean } = {},
): Promise<any> {
  return cuPost(
    token,
    `/space/${encodeURIComponent(spaceId)}/folderTemplate/${encodeURIComponent(templateId)}`,
    body,
  );
}

// ─── Chat (v3) ────────────────────────────────────────────────────────────────
//
// API refs consulted 2026-07-16:
//   developer.clickup.com/reference/getchatchannels         GET  /v3/workspaces/{wId}/chat/channels
//   developer.clickup.com/reference/createchatchannel       POST /v3/workspaces/{wId}/chat/channels
//   developer.clickup.com/reference/createlocationchatchannel POST /v3/workspaces/{wId}/chat/channels/location
//   developer.clickup.com/reference/createdirectmessagechatchannel POST /v3/workspaces/{wId}/chat/channels/dm
//   developer.clickup.com/reference/getchatchannel          GET  /v3/workspaces/{wId}/chat/channels/{channelId}
//   developer.clickup.com/reference/updatechatchannel       PATCH /v3/workspaces/{wId}/chat/channels/{channelId}
//   developer.clickup.com/reference/deletechatchannel       DELETE /v3/workspaces/{wId}/chat/channels/{channelId}
//   developer.clickup.com/reference/getchatchannelfollowers GET  /v3/workspaces/{wId}/chat/channels/{channelId}/followers
//   developer.clickup.com/reference/getchatchannelmembers   GET  /v3/workspaces/{wId}/chat/channels/{channelId}/members
//   developer.clickup.com/reference/getchatmessages         GET  /v3/workspaces/{wId}/chat/channels/{channelId}/messages
//   developer.clickup.com/reference/createchatmessage       POST /v3/workspaces/{wId}/chat/channels/{channelId}/messages
//   developer.clickup.com/reference/patchchatmessage        PATCH /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}
//   developer.clickup.com/reference/deletechatmessage       DELETE /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}
//   developer.clickup.com/reference/getchatmessagereplies   GET  /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/replies
//   developer.clickup.com/reference/createreplymessage      POST /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/replies
//   developer.clickup.com/reference/getchatreactions        GET  /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/reactions
//   developer.clickup.com/reference/createchatreaction      POST /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/reactions
//   developer.clickup.com/reference/deletechatreaction      DELETE /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/reactions/{reactionId}
//   developer.clickup.com/reference/getchatmessagetaggedusers GET /v3/workspaces/{wId}/chat/channels/{channelId}/messages/{messageId}/tagged
//   developer.clickup.com/reference/getsubtypes             GET  /v3/workspaces/{wId}/chat/subtypes
//
// ClickUp notes:
//   - The Chat API is marked EXPERIMENTAL by ClickUp.
//   - All Chat endpoints use v3 base URL.
//   - Reactions use lowercase emoji names (e.g. "thumbsup", "heart").
//   - CreateChatChannel and CreateDirectMessageChatChannel return the
//     existing channel if one already exists with that name / those members.
//   - CreateChatMessage supports type: "post" with a subtype_id from GetSubtypes.
//   - Subtype IDs are workspace-unique.

async function cuPatch<T>(
  token: string,
  path: string,
  body: unknown,
  base = CLICKUP_V2,
): Promise<T> {
  const res = await cuFetch(token, `${base}${path}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp PATCH ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/** GetSubtypes — workspace-unique post subtypes for chat messages of type "post". */
export async function getChatSubtypes(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/subtypes`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/** GetChatChannels — list all chat channels in a workspace (workspace-level + location-bound). */
export async function getChatChannels(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/channels`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/**
 * CreateChatChannel — create a workspace-level channel.
 * Returns the existing channel if one already exists with that name.
 */
export async function createChatChannel(
  token: string,
  workspaceId: string,
  body: { name: string; description?: string; is_private?: boolean },
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/**
 * CreateLocationChatChannel — create a channel bound to a Space, Folder, or List.
 * Returns the existing channel if one already exists at that location.
 */
export async function createLocationChatChannel(
  token: string,
  workspaceId: string,
  body: {
    name: string;
    description?: string;
    location_type: "space" | "folder" | "list";
    location_id: string;
  },
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/location`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/**
 * CreateDirectMessageChatChannel — create a DM channel (up to 15 users).
 * Returns the existing channel if one already exists with those members.
 */
export async function createDirectMessageChannel(
  token: string,
  workspaceId: string,
  userIds: string[],
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/dm`,
    { user_ids: userIds },
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** GetChatChannel — fetch a single channel by ID. */
export async function getChatChannel(
  token: string,
  workspaceId: string,
  channelId: string,
): Promise<any> {
  const data = await cuGet<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}`,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** UpdateChatChannel — update name, description, or privacy. */
export async function updateChatChannel(
  token: string,
  workspaceId: string,
  channelId: string,
  body: { name?: string; description?: string; is_private?: boolean },
): Promise<any> {
  const data = await cuPatch<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** DeleteChatChannel — permanently delete a channel. */
export async function deleteChatChannel(
  token: string,
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await cuDelete(token, `/workspaces/${workspaceId}/chat/channels/${channelId}`, CLICKUP_V3);
}

/** GetChatChannelFollowers — list followers of a channel. */
export async function getChatChannelFollowers(
  token: string,
  workspaceId: string,
  channelId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/followers`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/** GetChatChannelMembers — list members of a channel. */
export async function getChatChannelMembers(
  token: string,
  workspaceId: string,
  channelId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/members`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/**
 * GetChatMessages — list messages in a channel.
 * Supports cursor-based pagination via next_cursor.
 */
export async function getChatMessages(
  token: string,
  workspaceId: string,
  channelId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ data: any[]; next_cursor?: string }> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  return cuGet<{ data: any[]; next_cursor?: string }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages${qs}`,
    CLICKUP_V3,
  );
}

/**
 * CreateChatMessage — post a message to a channel.
 * Set type: "post" with a subtype_id to create announcement/discussion/idea/update posts.
 */
export async function createChatMessage(
  token: string,
  workspaceId: string,
  channelId: string,
  body: {
    content: string;
    type?: "message" | "post";
    subtype_id?: string;
  },
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** PatchChatMessage — edit a message's content. */
export async function patchChatMessage(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
  body: { content: string },
): Promise<any> {
  const data = await cuPatch<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** DeleteChatMessage — delete a message. */
export async function deleteChatMessage(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await cuDelete(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}`,
    CLICKUP_V3,
  );
}

/**
 * GetChatMessageReplies — list thread replies for a message.
 * The parent message itself is NOT included in the response.
 */
export async function getChatMessageReplies(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ data: any[]; next_cursor?: string }> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  return cuGet<{ data: any[]; next_cursor?: string }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/replies${qs}`,
    CLICKUP_V3,
  );
}

/** CreateReplyMessage — post a threaded reply to a message. */
export async function createChatReply(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
  body: { content: string },
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/replies`,
    body,
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** GetChatReactions — list reactions on a message. */
export async function getChatReactions(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/reactions`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}

/**
 * CreateChatReaction — add an emoji reaction to a message.
 * Emoji names must be lowercase (e.g. "thumbsup", "heart", "tada").
 */
export async function createChatReaction(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<any> {
  const data = await cuPost<{ data: any }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/reactions`,
    { emoji },
    CLICKUP_V3,
  );
  return data.data ?? data;
}

/** DeleteChatReaction — remove an emoji reaction from a message. */
export async function deleteChatReaction(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const res = await cuFetch(
    token,
    `${CLICKUP_V3}/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/reactions`,
    {
      method: "DELETE",
      body: JSON.stringify({ emoji }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp DELETE reaction failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** GetChatMessageTaggedUsers — list users tagged/mentioned in a message. */
export async function getChatMessageTaggedUsers(
  token: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
): Promise<any[]> {
  const data = await cuGet<{ data: any[] }>(
    token,
    `/workspaces/${workspaceId}/chat/channels/${channelId}/messages/${messageId}/tagged`,
    CLICKUP_V3,
  );
  return data.data ?? [];
}


/**
 * RemoveTagsFromTimeEntries — remove named tags from a specific time entry.
 * The ClickUp API uses DELETE with a JSON body.
 */
export async function removeTagsFromTimeEntry(
  token: string,
  workspaceId: string,
  timerId: string,
  tags: Array<{ name: string }>,
): Promise<void> {
  const res = await cuFetch(
    token,
    `${CLICKUP_V2}/team/${workspaceId}/time_entries/${timerId}/tag`,
    {
      method: "DELETE",
      body: JSON.stringify({ tags }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ClickUp remove time entry tags failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
}

/**
 * ChangeTagNamesFromTimeEntries — rename a tag workspace-wide.
 * Affects all time entries that carry this tag name.
 */
export async function renameTimeEntryTag(
  token: string,
  workspaceId: string,
  name: string,
  newName: string,
): Promise<void> {
  await cuPut(token, `/team/${workspaceId}/time_entries/tags`, { name, new_name: newName });
}

/**
 * Extended GetTimeEntriesWithinADateRange.
 * The existing getTimeEntries() only supports task_id / assignee filtering.
 * This version exposes all supported query params including date range, location
 * filters (ONE of space_id | folder_id | list_id | task_id), and tag filters.
 * Negative duration entries are running timers.
 */
export async function getTimeEntriesRange(
  token: string,
  workspaceId: string,
  opts: {
    start_date?: number;
    end_date?: number;
    assignee?: string;
    space_id?: string;
    folder_id?: string;
    list_id?: string;
    task_id?: string;
    tags?: string[];
    include_location_names?: boolean;
  } = {},
): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.start_date) params.set("start_date", String(opts.start_date));
  if (opts.end_date) params.set("end_date", String(opts.end_date));
  if (opts.assignee) params.set("assignee", opts.assignee);
  // Exactly ONE location filter at a time per API contract
  if (opts.task_id) params.set("task_id", opts.task_id);
  else if (opts.list_id) params.set("list_id", opts.list_id);
  else if (opts.folder_id) params.set("folder_id", opts.folder_id);
  else if (opts.space_id) params.set("space_id", opts.space_id);
  if (opts.tags?.length) opts.tags.forEach((t) => params.append("tags[]", t));
  if (opts.include_location_names) params.set("include_location_names", "true");
  const data = await cuGet<{ data: any[] }>(
    token,
    `/team/${workspaceId}/time_entries?${params}`,
  );
  return data.data ?? [];
}

/**
 * UpdateTimeEstimatesByUser — add/update per-assignee time estimates (Business plan+).
 * Up to 10 estimates per request. user_id can be "unassigned".
 */
export async function updateTimeEstimateForUser(
  token: string,
  taskId: string,
  userId: string,
  estimates: Array<{ duration: number }>,
): Promise<any> {
  return cuPut(
    token,
    `/task/${taskId}/time_estimates/user/${userId}`,
    { estimates },
  );
}

/** GetTaskTimeInStatus — how long a single task has spent in each status. */
export async function getTaskTimeInStatus(token: string, taskId: string): Promise<any> {
  return cuGet(token, `/task/${taskId}/time_in_status`);
}

/**
 * GetBulkTasksTimeInStatus — time-in-status for multiple tasks in one call.
 * All task IDs must belong to the same workspace.
 */
export async function getBulkTasksTimeInStatus(
  token: string,
  workspaceId: string,
  taskIds: string[],
): Promise<any> {
  const params = new URLSearchParams();
  taskIds.forEach((id) => params.append("task_ids[]", id));
  return cuGet(token, `/team/${workspaceId}/tasks_time_in_status?${params}`);
}

// ─── Members (explicit access only) ──────────────────────────────────────────
//
// API refs (reviewed 2026-07-16):
//   GetTaskMembers:  GET /api/v2/task/{task_id}/member
//   GetListMembers:  GET /api/v2/list/{list_id}/member
//
// IMPORTANT: These return ONLY members with explicit access — members who
// inherited access via team membership or location are NOT included.
// Display must communicate this caveat to the user.

export async function getTaskMembers(token: string, taskId: string): Promise<any[]> {
  const data = await cuGet<{ members: any[] }>(token, `/task/${taskId}/member`);
  return data.members ?? [];
}

export async function getListMembers(token: string, listId: string): Promise<any[]> {
  const data = await cuGet<{ members: any[] }>(token, `/list/${listId}/member`);
  return data.members ?? [];
}

// ─── Custom Roles ─────────────────────────────────────────────────────────────
//
// API ref (reviewed 2026-07-16):
//   GetCustomRoles: GET /api/v2/team/{team_id}/customroles
//
// Returns the custom roles defined for the workspace. The `team_id` param in
// ClickUp's API is the workspace ID (not a user-group ID).

export async function getCustomRoles(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ custom_roles: any[] }>(
    token,
    `/team/${workspaceId}/customroles`,
  );
  return data.custom_roles ?? [];
}

// ─── Shared Hierarchy ────────────────────────────────────────────────────────
//
// API ref (reviewed 2026-07-16):
//   SharedHierarchy: GET /api/v2/team/{team_id}/shared
//
// Returns all tasks, lists, and folders explicitly shared with the acting user.

export async function getSharedHierarchy(
  token: string,
  workspaceId: string,
): Promise<{ tasks: any[]; lists: any[]; folders: any[] }> {
  const data = await cuGet<{ shared: { tasks?: any[]; lists?: any[]; folders?: any[] } }>(
    token,
    `/team/${workspaceId}/shared`,
  );
  return {
    tasks: data.shared?.tasks ?? [],
    lists: data.shared?.lists ?? [],
    folders: data.shared?.folders ?? [],
  };
}

// ─── User Groups (Teams in v2 terminology) ────────────────────────────────────
//
// API refs (reviewed 2026-07-16):
//   GetGroups:    GET /api/v2/group?team_id={workspaceId}
//   CreateGroup:  POST /api/v2/group
//   UpdateGroup:  PUT  /api/v2/group/{group_id}
//   DeleteGroup:  DELETE /api/v2/group/{group_id}
//
// Note: In ClickUp's API, `group_id` refers to a User Group; `team_id` refers
// to the Workspace. User Groups were formerly called "Teams" in the UI but are
// now called "User Groups" to avoid confusion with the Workspace ("team").

export async function getGroups(token: string, workspaceId: string): Promise<any[]> {
  const data = await cuGet<{ groups: any[] }>(token, `/group?team_id=${workspaceId}`);
  return data.groups ?? [];
}

export async function createGroup(
  token: string,
  body: { name: string; team_id: string; members?: Array<{ id: number }> },
): Promise<any> {
  const data = await cuPost<{ group: any }>(token, `/group`, body);
  return data.group ?? data;
}

export async function updateGroup(
  token: string,
  groupId: string,
  body: Partial<{
    name: string;
    add_users: Array<{ id: number }>;
    rem_users: Array<{ id: number }>;
  }>,
): Promise<any> {
  const data = await cuPut<{ group: any }>(token, `/group/${groupId}`, body);
  return data.group ?? data;
}

export async function deleteGroup(token: string, groupId: string): Promise<void> {
  await cuDelete(token, `/group/${groupId}`);
}

// ─── Privacy / ACL (PublicPatchAcl) ──────────────────────────────────────────
//
// API ref (reviewed 2026-07-16):
//   PublicPatchAcl: POST /api/v2/team/{team_id}/acl
//
// Updates the privacy and access settings of an object (task, list, folder, etc.).
// WARNING: Sharing an item may incur charges — always surface the API's own
// warning to the user before applying this call.
//
// Body fields:
//   type      — object type: 1=task, 4=list, 6=folder, 5=space
//   id        — object ID
//   private   — boolean; when true, restricts access to explicit members only

export async function updateAcl(
  token: string,
  workspaceId: string,
  body: {
    type: number;
    id: string;
    private?: boolean;
    users?: Array<{ id: number; permission_level?: string }>;
  },
): Promise<any> {
  return cuPost(token, `/team/${workspaceId}/acl`, body);
}

// ─── Workspace Seats ─────────────────────────────────────────────────────────
//
// API ref (reviewed 2026-07-16):
//   GetWorkspaceSeats: GET /api/v2/team/{team_id}/seats
//
// Returns seat usage: { members: { used, total }, guests: { used, total } }

export async function getWorkspaceSeats(
  token: string,
  workspaceId: string,
): Promise<any> {
  return cuGet(token, `/team/${workspaceId}/seats`);
}

// ─── Workspace Plan ──────────────────────────────────────────────────────────
//
// API ref (reviewed 2026-07-16):
//   GetWorkspacePlan: GET /api/v2/team/{team_id}/plan
//
// Returns the current plan details: { plan: { name: string } }
// Plan name is stored in the clickup_workspaces mirror to drive plan-gating
// notices elsewhere in the module without additional API calls.

export async function getWorkspacePlan(
  token: string,
  workspaceId: string,
): Promise<{ plan: { name: string } }> {
  return cuGet(token, `/team/${workspaceId}/plan`);
}

// ─── Webhook signature verification ──────────────────────────────────────────

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signatureHeader, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
