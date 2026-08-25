/**
 * Ads OS — ClickUp Client List directory (port of backend/app/clickup/directory.py).
 *
 * One cached fetch of the Client List (list 901417549202) builds the directory
 * bundle from spec §3.2:
 *   - clients:   norm name → { name, doer, checker, log_url }  (every live parent)
 *   - blocks:    [{ name, gads_cids, lsa_cids }]               (every live parent)
 *   - statuses:  cid → { gads?, lsa? }   explicit on/paused/off only
 *   - budgets:   cid → { gads?, lsa? }   monthly budgets
 *   - cidClient: cid → norm client name
 *   - lsaCities: cid → city (from the "(City)" suffix on LSA subtask names)
 *   - known:     { gads: Set<cid>, lsa: Set<cid> } — every CID ClickUp knows about,
 *                INCLUDING CIDs under offboarded clients. Healthy auto-mode
 *                migration unions use the cross-product union of these sets, so
 *                a stale label cannot invent a second product for a known CID.
 *
 * Semantics ported exactly:
 *   - Parents with an excluded status (default "offboarded") are dropped from
 *     clients/blocks, but their subtask CIDs still land in `known`.
 *   - Every live named parent gets a clients record AND a block, even with no
 *     subtasks (keeps the client profile URL working).
 *   - Per-task try/catch: one malformed task never sinks the whole directory.
 *   - Status conflicts keep the most-monitored value (on > paused > off).
 *   - Budgets assign, never accumulate; duplicate (product, CID) rows use
 *     deterministic list-order last-write-wins, including zero/blank clears.
 *   - Cache: 10-min TTL, 60s failure backoff serving stale, fetch OUTSIDE the
 *     lock, single-flight so concurrent cold reads fetch once. Never raises
 *     (empty bundle) except in `throwOnError` proof mode.
 *   - Liveness (`bundleIsLive`) is CURRENT health — the most recent completed
 *     fetch attempt succeeded — not "ever fetched". A post-success outage
 *     keeps serving the stale bundle for display but flips liveness false, so
 *     auto enrollment falls back to labels and the UI banner appears.
 */

import {
  resolveClickUpToken, clickUpTokenSource, CLICKUP_CLIENT_LIST_ID, CLICKUP_CLIENT_CID_FIELD_ID,
  CLICKUP_CLIENT_ADS_STATUS_FIELD_ID, CLICKUP_CLIENT_BUDGET_FIELD_ID,
  CLICKUP_DOER_FIELD_ID, CLICKUP_CHECKER_FIELD_ID, CLICKUP_CLIENT_LOG_FIELD_ID,
  CLICKUP_PRACTICE_AREA_FIELD_ID,
  getClickUpExcludedStatuses, isClickUpConfigured, CLICKUP_STALE_AFTER_MS,
} from "./config";
import type { ClickUpTokenSource } from "../clickUpCompanyToken";
import { clickUpCompanyRawRequest } from "../clickUpClient";
import { KeyedLocks } from "./singleflight";
import type { AdsStatus, Product } from "./types";
import {
  ClickUpPracticeAreaContractError,
  decodePracticeAreaSelection,
  resolvePracticeAreaFieldContract,
  type PracticeAreaFieldContract,
  type PracticeAreaOption,
} from "./clickUpPracticeAreaContract";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_DOER_FIELD_ID as EVIDENCE_DOER_FIELD_ID,
  CLICKUP_CHECKER_FIELD_ID as EVIDENCE_CHECKER_FIELD_ID,
} from "./paidSearchRoleContract";

const DIR_TTL_MS = 10 * 60 * 1000; // 10 min (spec §3.2)
const FAIL_BACKOFF_MS = 60_000;    // failed fetch: serve stale, retry after 60s
const CLICKUP_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The Paid Search cutover evidence is always pinned to the owner-approved
 * production contract. The operational directory can be overridden only in
 * non-production environments; deployed/production reads are pinned by config.
 */
const EVIDENCE_CANONICAL_LIST_ID = CANONICAL_PRODUCTION_LIST_ID;

// ---------------------------------------------------------------------------
// Raw API helpers
// ---------------------------------------------------------------------------

/** ClickUp API error carrying the HTTP status so diagnostics can show it. */
export class ClickUpHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ClickUpHttpError";
  }
}

async function clickUpGet(path: string, token: string): Promise<any> {
  const res = await clickUpCompanyRawRequest({
    token,
    method: "GET",
    path,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let body: any = {};
    try {
      body = JSON.parse(res.text || "{}");
    } catch {
      // Keep the failure credential-safe even when ClickUp returns non-JSON.
    }
    throw new ClickUpHttpError(
      `ClickUp GET ${path} → HTTP ${res.status}: ${body?.err || "unknown"}`,
      res.status,
    );
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`ClickUp GET ${path} returned malformed JSON.`);
  }
}

async function listTasksWithSubtasks(token: string, listId: string): Promise<any[]> {
  const tasks: any[] = [];
  let page = 0;
  while (true) {
    const resp = await clickUpGet(
      `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`,
      token,
    );
    const batch = resp?.tasks ?? [];
    tasks.push(...batch);
    if (resp?.last_page || !batch.length) break;
    page++;
    if (page > 50) break; // safety valve — no list is 5 000+ tasks
  }
  return tasks;
}

async function listCustomFields(token: string, listId: string): Promise<any[]> {
  const resp = await clickUpGet(`/list/${listId}/field`, token);
  if (!Array.isArray(resp?.fields)) {
    throw new ClickUpPracticeAreaContractError(
      `ClickUp list ${listId} custom-field response is malformed (fields must be an array).`,
    );
  }
  return resp.fields;
}

// ---------------------------------------------------------------------------
// Field value resolvers (directory.py helpers)
// ---------------------------------------------------------------------------

function normCid(value: any): string {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

/** Normalized client-name key: trimmed, lowercased, collapsed whitespace. */
export function normClientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Resolve a dropdown field's selected option NAME via type_config.options
 *  (matched by option id, else orderindex), lowercased. */
function dropdownName(field: any): string | null {
  if (!field || field.value === null || field.value === undefined) return null;
  const options: any[] = field?.type_config?.options ?? [];
  const byOrder: Record<number, string> = {};
  const byId: Record<string, string> = {};
  for (const o of options) {
    if (o.orderindex !== undefined) byOrder[o.orderindex] = o.name;
    if (o.id) byId[o.id] = o.name;
  }
  const val = field.value;
  if (typeof val === "string" && byId[val]) return byId[val].trim().toLowerCase();
  const iv = parseInt(String(val), 10);
  if (!isNaN(iv) && byOrder[iv] !== undefined) return byOrder[iv].trim().toLowerCase();
  return null;
}

function userName(field: any): string | null {
  const val = field?.value;
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
    return val[0]?.username ?? val[0]?.email ?? null;
  }
  return null;
}

/** Parse a budget amount: strip $/commas; blank → 0.0 (mirrors _parse_amount). */
function parseAmount(value: any): number {
  if (value === null || value === undefined) return 0.0;
  const v = parseFloat(String(value).replace(/[$,\s]/g, ""));
  return isNaN(v) ? 0.0 : v;
}

function subtaskProduct(name: string): Product | null {
  const n = (name ?? "").trim().toUpperCase();
  if (n.startsWith("LSA")) return "lsa";
  if (n.startsWith("GOOGLE ADS")) return "gads";
  return null;
}

function lsaCity(name: string): string | null {
  const n = (name ?? "").trim();
  if (!n.toUpperCase().startsWith("LSA")) return null;
  const found = n.match(/\(([^()]+)\)/g);
  if (!found?.length) return null;
  const city = found[0].replace(/[()]/g, "").trim();
  return city || null;
}

// ---------------------------------------------------------------------------
// Bundle shape (directory.py _build_directory)
// ---------------------------------------------------------------------------

export interface ClientRecord {
  name: string;          // display name (original casing)
  doer: string | null;
  checker: string | null;
  log_url: string | null;
  /** Canonical ClickUp Practice Area labels, in option order. */
  practice_areas: string[];
}

export interface ClientBlock {
  name: string;          // display name
  gads_cids: string[];
  lsa_cids: string[];
}

export interface DirectoryBundle {
  /** norm name → client record. Every live (non-excluded) named parent. */
  clients: Record<string, ClientRecord>;
  /** One block per live named parent, in list order. */
  blocks: ClientBlock[];
  /** cid → { gads?, lsa? } — explicit on/paused/off statuses only. */
  statuses: Record<string, { gads?: string; lsa?: string }>;
  /** cid → { gads?, lsa? } — monthly budgets. */
  budgets: Record<string, { gads?: number; lsa?: number }>;
  /** cid → norm client name (live clients only). */
  cidClient: Record<string, string>;
  /** LSA cid → city suffix. */
  lsaCities: Record<string, string>;
  /** Every CID ClickUp knows per product — INCLUDING offboarded clients' CIDs. */
  known: { gads: Set<string>; lsa: Set<string> };
  /** Launch URLs captured from subtask "Account Link" / "deep link" fields,
   *  per product+CID (AM Dashboard). http(s) only; last write wins. */
  deepLinks: { gads: Record<string, string>; lsa: Record<string, string> };
  /** Validated canonical field metadata and its complete ordered option set. */
  practiceAreaField: Omit<PracticeAreaFieldContract, "options"> | null;
  practiceAreaOptions: PracticeAreaOption[];
  /** CID → parent selection, copied to every associated GAds/LSA CID. */
  cidPracticeAreas: Record<string, string[]>;
  /** CID → live parent task IDs; writeback requires exactly one. */
  cidParentTaskIds: Record<string, string[]>;
  fetchedAt: number;
}

function emptyBundle(): DirectoryBundle {
  return {
    clients: {}, blocks: [], statuses: {}, budgets: {}, cidClient: {},
    lsaCities: {}, known: { gads: new Set(), lsa: new Set() },
    deepLinks: { gads: {}, lsa: {} },
    practiceAreaField: null, practiceAreaOptions: [],
    cidPracticeAreas: {}, cidParentTaskIds: {},
    fetchedAt: 0,
  };
}

// Status conflict rank: keep the most-monitored value (on > paused > off).
const STATUS_RANK: Record<string, number> = { on: 3, paused: 2, off: 1 };
const VALID_STATUSES = new Set(["on", "paused", "off"]);

function buildBundle(
  tasks: any[],
  practiceAreaContract: PracticeAreaFieldContract,
): DirectoryBundle {
  const excluded = getClickUpExcludedStatuses();
  const bundle = emptyBundle();
  bundle.practiceAreaField = {
    id: practiceAreaContract.id,
    name: practiceAreaContract.name,
    type: practiceAreaContract.type,
  };
  bundle.practiceAreaOptions = practiceAreaContract.options.map((option) => ({ ...option }));

  // Pass 0: split parents from subtasks.
  const parents: any[] = [];
  const subtasks: any[] = [];
  for (const t of tasks) {
    if (t?.parent) subtasks.push(t);
    else if (t) parents.push(t);
  }

  // Pass 1: parents. Skip unnamed; excluded-status parents are dropped from
  // clients/blocks but remembered so their subtask CIDs still reach `known`.
  const parentLive = new Map<
    string,
    { key: string; practiceAreas: string[] }
  >(); // parent id → live client metadata
  const parentExcluded = new Set<string>();
  const blockByNorm = new Map<string, ClientBlock>();

  for (const t of parents) {
    try {
      const name = String(t.name ?? "").trim();
      if (!name) continue;
      const status = String(t.status?.status ?? "").toLowerCase();
      if (excluded.has(status)) {
        parentExcluded.add(String(t.id));
        continue;
      }
      const key = normClientName(name);
      const fields: Record<string, any> = {};
      for (const f of t.custom_fields ?? []) fields[f.id] = f;
      const practiceAreas = decodePracticeAreaSelection(
        fields[CLICKUP_PRACTICE_AREA_FIELD_ID],
        practiceAreaContract,
        String(t.id),
      );
      // Every live parent gets a clients record AND a block, even with no accounts.
      if (!bundle.clients[key]) {
        bundle.clients[key] = {
          name,
          doer: userName(fields[CLICKUP_DOER_FIELD_ID]),
          checker: userName(fields[CLICKUP_CHECKER_FIELD_ID]),
          log_url: fields[CLICKUP_CLIENT_LOG_FIELD_ID]?.value ?? null,
          practice_areas: [...practiceAreas],
        };
      }
      if (!blockByNorm.has(key)) {
        const block: ClientBlock = { name, gads_cids: [], lsa_cids: [] };
        blockByNorm.set(key, block);
        bundle.blocks.push(block);
      }
      parentLive.set(String(t.id), { key, practiceAreas });
    } catch (err: any) {
      if (err instanceof ClickUpPracticeAreaContractError) throw err;
      console.warn("[AdsOs/ClickUp] skipping malformed parent task:", err?.message ?? err);
    }
  }

  // Pass 2: subtasks. Order matters: fields → cid (skip if none) → product;
  // `known` is fed even when the parent is excluded; everything else requires
  // a live parent.
  for (const t of subtasks) {
    try {
      const fields: Record<string, any> = {};
      for (const f of t.custom_fields ?? []) fields[f.id] = f;

      const cid = normCid(fields[CLICKUP_CLIENT_CID_FIELD_ID]?.value);
      if (!cid) continue;

      const product = subtaskProduct(t.name ?? "");
      // Every CID with a recognizable product is "known to ClickUp" — even under
      // an offboarded client (blocks auto-mode label union from resurrecting it).
      if (product) bundle.known[product].add(cid);

      const parent = parentLive.get(String(t.parent));
      if (!parent) continue; // excluded or unknown parent — not on any board
      const parentKey = parent.key;

      if (product === "lsa") {
        const city = lsaCity(t.name ?? "");
        if (city) bundle.lsaCities[cid] = city;
      }
      if (!product) continue;

      // Budget: assign (never accumulate), and let the last ClickUp row for a
      // duplicate (product, CID) win. Zero/blank is authoritative too: a
      // corrected later subtask must be able to clear an older positive.
      const amount = parseAmount(fields[CLICKUP_CLIENT_BUDGET_FIELD_ID]?.value);
      const b = bundle.budgets[cid] ?? (bundle.budgets[cid] = {});
      b[product] = amount;

      // Status: only explicit on/paused/off; conflicts keep the most-monitored.
      const statusName = dropdownName(fields[CLICKUP_CLIENT_ADS_STATUS_FIELD_ID]);
      if (statusName && VALID_STATUSES.has(statusName)) {
        const s = bundle.statuses[cid] ?? (bundle.statuses[cid] = {});
        const prev = s[product];
        if (!prev || (STATUS_RANK[statusName] ?? 0) > (STATUS_RANK[prev] ?? 0)) {
          s[product] = statusName;
        }
      }

      // Launch URL for the AM Dashboard: the subtask's "Account Link" URL field,
      // with "deep link" accepted as an alias. Matched by field NAME (substring,
      // case-insensitive), not a settings field id, so onboarding the field
      // needs no config change. Deep links can never be DERIVED from a CID
      // (Google's ocid is opaque) — only captured by a human and stored.
      // http(s) only: this value becomes an <a href> in every ads manager's
      // browser, and a pasted "javascript:" (or any other scheme) must never
      // ride a ClickUp text field into the app. Assignment (not setdefault) so
      // a corrected value on the LAST duplicate subtask wins — the same
      // last-write rule budgets use for ClickUp's duplicate/renamed subtrees.
      for (const f of t.custom_fields ?? []) {
        const fname = String(f?.name ?? "").toLowerCase();
        if ((fname.includes("account link") || fname.includes("deep link")) && f?.value) {
          const url = String(f.value).trim();
          const lower = url.toLowerCase();
          if (lower.startsWith("https://") || lower.startsWith("http://")) {
            bundle.deepLinks[product][cid] = url;
          }
        }
      }

      bundle.cidClient[cid] = parentKey;
      bundle.cidPracticeAreas[cid] = [...parent.practiceAreas];
      const parentTaskIds =
        bundle.cidParentTaskIds[cid] ?? (bundle.cidParentTaskIds[cid] = []);
      const parentTaskId = String(t.parent);
      if (!parentTaskIds.includes(parentTaskId)) parentTaskIds.push(parentTaskId);
      const block = blockByNorm.get(parentKey)!;
      const arr = product === "gads" ? block.gads_cids : block.lsa_cids;
      if (!arr.includes(cid)) arr.push(cid);
    } catch (err: any) {
      if (err instanceof ClickUpPracticeAreaContractError) throw err;
      console.warn("[AdsOs/ClickUp] skipping malformed subtask:", err?.message ?? err);
    }
  }

  bundle.fetchedAt = Date.now();
  return bundle;
}

// ---------------------------------------------------------------------------
// Cache (10-min TTL, 60s failure backoff, single-flight, never raises)
// ---------------------------------------------------------------------------

let _cache: DirectoryBundle | null = null;
let _cacheAt = 0;
let _failAt = 0;
/** Outcome of the most recent COMPLETED fetch attempt (null = none yet). */
let _lastAttemptOk: boolean | null = null;

/** Persisted detail of the most recent FAILED fetch attempt (null = last
 *  attempt succeeded / none yet). Makes the outage banner self-explanatory:
 *  "unreachable" always resolves to an HTTP status / error class + timestamp. */
export interface DirectoryFetchError {
  at: string;            // ISO timestamp of the failed attempt
  message: string;       // full error message (includes list + path)
  httpStatus: number | null; // HTTP status when ClickUp answered; null = network/timeout
  errorClass: string;    // error constructor name (ClickUpHttpError, TimeoutError, …)
  listId: string;        // which list the fetch targeted
}
let _lastError: DirectoryFetchError | null = null;
/** Epoch ms of the last SUCCESSFUL fetch (survives later failures; null = never). */
let _lastSuccessAt: number | null = null;
const _locks = new KeyedLocks();

// ---------------------------------------------------------------------------
// Directory fetch-outcome alert hooks (Task #3662)
//
// Every COMPLETED fetch attempt reports its outcome to the auth-dead alert
// module (clickUpDirectoryAlert.ts) — fire-and-forget so alerting can never
// slow or break the stale-serve path. The real module is loaded LAZILY on
// first dispatch; pure tests inject noop hooks up front so the dispatcher/DB
// import chain never loads.
// ---------------------------------------------------------------------------

export interface DirectoryAlertHooks {
  onSuccess: () => Promise<void>;
  onFailure: (info: {
    httpStatus: number | null;
    message: string;
    errorClass: string;
    listId: string;
  }) => Promise<void>;
}

let _alertHooks: DirectoryAlertHooks | null = null;
const _pendingAlertWork = new Set<Promise<unknown>>();

function dispatchDirectoryAlert(run: (h: DirectoryAlertHooks) => Promise<void>): void {
  const p = (async () => {
    try {
      if (!_alertHooks) {
        const m = await import("./clickUpDirectoryAlert");
        _alertHooks = {
          onSuccess: m.onClickUpDirectoryFetchSuccess,
          onFailure: m.onClickUpDirectoryFetchFailure,
        };
      }
      await run(_alertHooks);
    } catch (err: any) {
      console.warn(
        `[AdsOs/ClickUp] directory alert hook failed (non-fatal): ${err?.message ?? err}`,
      );
    }
  })();
  _pendingAlertWork.add(p);
  void p.finally(() => _pendingAlertWork.delete(p));
}

/** Test hook: inject alert hooks (noop for purity) or null to restore the
 *  lazy-loaded real module. */
export function __setDirectoryAlertHooksForTest(hooks: DirectoryAlertHooks | null): void {
  _alertHooks = hooks;
}

/** Test hook: await all in-flight fire-and-forget alert dispatches. */
export async function __test_drainDirectoryAlertWork(): Promise<void> {
  while (_pendingAlertWork.size) {
    await Promise.allSettled([..._pendingAlertWork]);
  }
}

interface DirectoryFetchOptions {
  force?: boolean;
  /** Proof mode: propagate fetch errors instead of degrading to stale/empty. */
  throwOnError?: boolean;
}

/**
 * Perform one canonical directory refresh while the caller owns the directory
 * lock. Writeback uses this directly so metadata, CID ownership, validation,
 * and the vendor mutation are serialized under one authority snapshot.
 */
async function refreshClientDirectoryLocked(
  opts?: DirectoryFetchOptions,
): Promise<DirectoryBundle> {
  // Task #3662: resolve the token at fetch time through the runtime-rotatable
  // accessor (DB override → env fallback) — an admin rotation takes effect
  // on the very next fetch, no restart/republish.
  const token = await resolveClickUpToken();
  if (!token) {
    if (opts?.throwOnError) {
      throw new Error("No ClickUp company token is configured (env or admin override).");
    }
    return _cache ?? emptyBundle(); // unconfigured: nothing to fetch with
  }
  try {
    const [tasks, fields] = await Promise.all([
      listTasksWithSubtasks(token, CLICKUP_CLIENT_LIST_ID),
      listCustomFields(token, CLICKUP_CLIENT_LIST_ID),
    ]);
    const practiceAreaContract = resolvePracticeAreaFieldContract(fields);
    const bundle = buildBundle(tasks, practiceAreaContract);
    _cache = bundle;
    _cacheAt = Date.now();
    _failAt = 0;
    _lastAttemptOk = true;
    _lastError = null;
    _lastSuccessAt = Date.now();
    dispatchDirectoryAlert((h) => h.onSuccess());
    return bundle;
  } catch (err: any) {
    const failure: DirectoryFetchError = {
      at: new Date().toISOString(),
      message: String(err?.message ?? err),
      httpStatus: err instanceof ClickUpHttpError ? err.status : null,
      errorClass: err?.name ?? err?.constructor?.name ?? "Error",
      listId: CLICKUP_CLIENT_LIST_ID,
    };
    _lastError = failure;
    // console.error (not warn) so the failure reliably lands in deployment logs.
    console.error(
      `[AdsOs/ClickUp] directory fetch failed (list ${CLICKUP_CLIENT_LIST_ID}, ` +
      `${failure.errorClass}${failure.httpStatus ? ` HTTP ${failure.httpStatus}` : ""}):`,
      failure.message,
    );
    _failAt = Date.now();
    _lastAttemptOk = false;
    dispatchDirectoryAlert((h) =>
      h.onFailure({
        httpStatus: failure.httpStatus,
        message: failure.message,
        errorClass: failure.errorClass,
        listId: failure.listId,
      }),
    );
    if (opts?.throwOnError) throw err; // proof mode: surface the real error
    return _cache ?? emptyBundle();
  }
}

export async function getClientDirectory(
  opts?: DirectoryFetchOptions,
): Promise<DirectoryBundle> {
  const fresh = () => {
    const now = Date.now();
    if (_cache && now - _cacheAt < DIR_TTL_MS) return _cache;
    if (!opts?.throwOnError && _failAt && now - _failAt < FAIL_BACKOFF_MS) {
      return _cache ?? emptyBundle(); // failure backoff: serve stale
    }
    return null;
  };

  if (!opts?.force) {
    const hit = fresh();
    if (hit) return hit;
  }

  return _locks.withLock("directory", async () => {
    if (!opts?.force) {
      const hit = fresh(); // double-checked: a sibling may have fetched while we waited
      if (hit) return hit;
    }
    return refreshClientDirectoryLocked(opts);
  });
}

/**
 * Side probe for the admin "Test connection" action (Task #3662): fetches the
 * Client List with the CANDIDATE token (or the currently active one when
 * omitted) and reports what it found. PURE — never touches the directory
 * cache, `_lastError`, liveness, or the alert streak, so probing a bad token
 * cannot flip banners or fire alerts. Throws the underlying error
 * (ClickUpHttpError for HTTP failures) so the route can surface the EXACT
 * ClickUp response to the admin.
 */
export async function probeClientList(
  tokenOverride?: string,
): Promise<{ clients: number; tasks: number }> {
  const token = (tokenOverride ?? "").trim() || (await resolveClickUpToken());
  if (!token) {
    throw new Error("No ClickUp company token is configured (env or admin override).");
  }
  const [tasks, fields] = await Promise.all([
    listTasksWithSubtasks(token, CLICKUP_CLIENT_LIST_ID),
    listCustomFields(token, CLICKUP_CLIENT_LIST_ID),
  ]);
  const bundle = buildBundle(tasks, resolvePracticeAreaFieldContract(fields));
  return { clients: bundle.blocks.length, tasks: tasks.length };
}

/**
 * Current-health liveness: ClickUp is configured, we hold a bundle, AND the
 * most recent completed fetch attempt SUCCEEDED. One signal drives BOTH
 * (1) ClickUp authority in `auto` enrollment mode and (2) the dashboards'
 * `clickup_live` flag (UI degradation banner) — so the banner and the
 * enrollment fallback can never disagree.
 *
 * DELIBERATE DIVERGENCE from the source bundle's `bundle_is_live()` ("at
 * least one fetch has succeeded; slightly-stale counts"): spec §2 requires
 * auto mode to fall back to labels "when ClickUp is unreachable", and with
 * ever-fetched semantics a post-success outage would report live forever —
 * hiding the banner and pinning enrollment to stale data. Liveness reflects
 * the last OBSERVED attempt; enrollment's resolve() refreshes the directory
 * first so the signal is current, and a TTL-fresh cache hit (no attempt)
 * correctly keeps the last outcome. The source's rationale still holds: this
 * is never keyed on "the set is empty", so a legitimately all-Off product
 * does not resurrect accounts via labels.
 */
export function bundleIsLive(): boolean {
  return isClickUpConfigured() && _cache !== null && _lastAttemptOk === true;
}

/**
 * Age of the cached directory bundle in ms since its successful fetch, or
 * null when no bundle has ever been fetched (or ClickUp isn't configured).
 * Surfaced on /api/ads-os/status so operators can see directory freshness.
 */
export function bundleAgeMs(): number | null {
  if (!isClickUpConfigured() || !_cache || !_cache.fetchedAt) return null;
  return Date.now() - _cache.fetchedAt;
}

/**
 * Staleness signal (Task #3608): when the served bundle is older than
 * CLICKUP_STALE_AFTER_MS (default 20 min — refreshes are due every 10), returns
 * the ISO timestamp of its last successful fetch; otherwise null. This covers
 * the slow/degraded case bundleIsLive() misses: repeated failed refreshes keep
 * serving the stale bundle silently, and a SLOW (not failed) ClickUp can hold
 * the fetch lock past the TTL. Independent of liveness on purpose — the UI
 * shows the outage banner when live=false and the stale banner otherwise.
 */
/**
 * Diagnostic snapshot of the directory's health: configuration, liveness,
 * last-success time and the persisted last-error detail. Drives the outage
 * banner's reason line, /api/ads-os/status and the cron health endpoint so
 * "unreachable" is never opaque. When ClickUp is UNCONFIGURED (no token in
 * this environment — the observed production failure mode: the deployment's
 * secret snapshot missing/stale) it says so explicitly, because in that case
 * no fetch is ever attempted and there is no error to show.
 */
export interface DirectoryHealth {
  configured: boolean;
  /** Where the active company token comes from: db (admin override) | env | none. */
  tokenSource: ClickUpTokenSource;
  live: boolean;
  lastSuccessAt: string | null;
  lastError: DirectoryFetchError | null;
  bundleAgeMs: number | null;
  /** One-line human reason when NOT live; null while healthy. */
  reason: string | null;
}

export function directoryHealth(): DirectoryHealth {
  const configured = isClickUpConfigured();
  const live = bundleIsLive();
  let reason: string | null = null;
  if (!configured) {
    reason =
      "No ClickUp company token is available (CLICKUP_API_TOKEN env unset and no admin override). " +
      "Paste a token in Integrations Hub → ClickUp → “Ads OS company token” — it takes effect within a minute, no republish.";
  } else if (!live) {
    if (_lastError) {
      reason =
        `Last fetch of list ${_lastError.listId} failed at ${_lastError.at}: ` +
        (_lastError.httpStatus
          ? `HTTP ${_lastError.httpStatus} — ${_lastError.message}`
          : `${_lastError.errorClass} — ${_lastError.message}`);
      if (_lastError.httpStatus === 401) {
        reason +=
          " Rotate the token in Integrations Hub → ClickUp → “Ads OS company token” (takes effect within a minute, no republish).";
      }
    } else {
      reason = "No directory fetch has completed yet in this process.";
    }
  }
  return {
    configured,
    tokenSource: clickUpTokenSource(),
    live,
    lastSuccessAt: _lastSuccessAt ? new Date(_lastSuccessAt).toISOString() : null,
    lastError: _lastError,
    bundleAgeMs: bundleAgeMs(),
    reason,
  };
}

export function bundleStaleSince(): string | null {
  const age = bundleAgeMs();
  if (age === null || age <= CLICKUP_STALE_AFTER_MS) return null;
  return new Date(_cache!.fetchedAt).toISOString();
}

/** Test hook: age the cached bundle by `ms` (simulates time passing). Also
 *  ages the failure backoff so "time passes after an outage" behaves as in
 *  production (a >60s-old failure no longer suppresses the next fetch). */
export function __testAgeBundle(ms: number): void {
  if (_cache) _cache.fetchedAt -= ms;
  _cacheAt -= ms;
  if (_failAt) _failAt -= ms;
}

/** Test hook: reset the module cache. */
export function __testResetDirectoryCache(): void {
  _cache = null;
  _cacheAt = 0;
  _failAt = 0;
  _lastAttemptOk = null;
  _lastError = null;
  _lastSuccessAt = null;
}

// ---------------------------------------------------------------------------
// Accessors (directory.py public API)
// ---------------------------------------------------------------------------

/** LSA city suffix for a CID, if the directory knows one. */
export async function lsaCityFor(cid: string): Promise<string | null> {
  const b = await getClientDirectory();
  return b.lsaCities[cid] ?? null;
}

/** Client record by (raw or normalized) name; null when not in the directory. */
export async function clientRecord(name: string): Promise<ClientRecord | null> {
  const b = await getClientDirectory();
  return b.clients[normClientName(name)] ?? null;
}

export interface PeopleInfo {
  client_name: string | null;
  doer: string | null;
  checker: string | null;
}

/** Doer/Checker + canonical client name for a monitored account (via cid). */
export async function peopleFor(_product: Product, cid: string): Promise<PeopleInfo> {
  const b = await getClientDirectory();
  const key = b.cidClient[cid];
  if (key && b.clients[key]) {
    const rec = b.clients[key];
    return { client_name: rec.name, doer: rec.doer, checker: rec.checker };
  }
  return { client_name: null, doer: null, checker: null };
}

/** People for a client NAME; fallback = the given name with null people. */
export async function peopleForClient(name: string): Promise<PeopleInfo> {
  const rec = await clientRecord(name);
  if (rec) return { client_name: rec.name, doer: rec.doer, checker: rec.checker };
  return { client_name: name, doer: null, checker: null };
}

/** cid → { gads?, lsa? } monthly budgets from ClickUp.
 *  `force` refreshes the owning directory once (used by rollout/fleet
 *  reconciliation); normal per-account reads reuse the existing cache. */
export async function clickUpBudgets(
  force = false,
): Promise<Record<string, { gads?: number; lsa?: number }>> {
  const b = await getClientDirectory({ force });
  return b.budgets;
}

/** Client blocks (live parents with their per-product CIDs, list order). */
export async function clientBlocks(): Promise<ClientBlock[]> {
  const b = await getClientDirectory();
  return b.blocks;
}

/** Explicit ClickUp Ads Status for (product, cid): "on"/"paused"/"off" or null (blank). */
export async function adsStatusFor(product: Product, cid: string): Promise<AdsStatus> {
  const b = await getClientDirectory();
  const s = b.statuses[cid]?.[product];
  return (s as AdsStatus) ?? null;
}

/** MONITORED CIDs for a product: every block CID whose status ≠ off (blank = on). */
export async function monitoredCids(product: Product): Promise<Set<string>> {
  const b = await getClientDirectory();
  const out = new Set<string>();
  for (const block of b.blocks) {
    for (const cid of product === "gads" ? block.gads_cids : block.lsa_cids) {
      const status = b.statuses[cid]?.[product];
      if (status !== "off") out.add(cid);
    }
  }
  return out;
}

/** ENROLLED CIDs for a product: every block CID incl. Off (profile/pacing reach). */
export async function enrolledCids(product: Product): Promise<Set<string>> {
  const b = await getClientDirectory();
  const out = new Set<string>();
  for (const block of b.blocks) {
    for (const cid of product === "gads" ? block.gads_cids : block.lsa_cids) {
      out.add(cid);
    }
  }
  return out;
}

/** Every CID ClickUp knows for a product — including offboarded clients'. */
export async function knownCids(product: Product): Promise<Set<string>> {
  const b = await getClientDirectory();
  return b.known[product];
}

/** Every CID ClickUp knows under either product — including offboarded clients'. */
export async function knownCidsAcrossProducts(): Promise<Set<string>> {
  const b = await getClientDirectory();
  return new Set([...b.known.gads, ...b.known.lsa]);
}

/** Launch URLs captured from ClickUp subtask "Account Link"/"deep link" fields,
 *  per product+CID (AM Dashboard). Empty maps when the directory is empty. */
export async function clickUpDeepLinks(): Promise<{
  gads: Record<string, string>;
  lsa: Record<string, string>;
}> {
  const b = await getClientDirectory();
  return b.deepLinks ?? { gads: {}, lsa: {} };
}

/** Canonical Practice Area labels for a CID, copied from its live parent. */
export async function practiceAreasForCid(cid: string): Promise<string[]> {
  const b = await getClientDirectory();
  return [...(b.cidPracticeAreas[normCid(cid)] ?? [])];
}

/**
 * Canonical-order Practice Area union for dashboard member CIDs.
 *
 * Dashboard payloads fail closed while the directory is degraded: unlike the
 * criteria projection above, they must not expose the stale last-good bundle.
 * `getClientDirectory()` reuses the existing TTL cache/single-flight, so this
 * accessor never creates a separate ClickUp request path.
 */
export async function dashboardPracticeAreasForCids(
  cids: Iterable<string>,
): Promise<string[]> {
  const b = await getClientDirectory();
  if (!bundleIsLive()) return [];

  const selected = new Set<string>();
  for (const cid of cids) {
    for (const label of b.cidPracticeAreas[normCid(cid)] ?? []) {
      selected.add(label);
    }
  }
  return b.practiceAreaOptions
    .filter((option) => selected.has(option.label))
    .map((option) => option.label);
}

export interface ReplacePracticeAreasResult {
  cid: string;
  parentTaskId: string;
  labels: string[];
  changed: boolean;
}

function practiceAreaWriteError(
  status: number,
  text: string,
): ClickUpHttpError {
  let detail = "";
  try {
    const parsed = JSON.parse(text || "{}");
    detail = String(parsed?.err ?? parsed?.error ?? "").trim();
  } catch {
    // Deliberately omit unstructured vendor bodies from errors/logs.
  }
  const kind =
    status === 401 || status === 403
      ? "authorization failed"
      : status === 429
        ? "rate limited"
        : status >= 500
          ? "temporarily unavailable"
          : "request rejected";
  return new ClickUpHttpError(
    `ClickUp Practice Area write ${kind} (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    status,
  );
}

async function writePracticeAreaIds(
  token: string,
  parentTaskId: string,
  optionIds: string[],
): Promise<void> {
  const path =
    `/task/${encodeURIComponent(parentTaskId)}/field/` +
    encodeURIComponent(CLICKUP_PRACTICE_AREA_FIELD_ID);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await _practiceAreaWriteRequest({
        token,
        method: "POST",
        path,
        body: { value: optionIds.map((id) => ({ id })) },
        signal: AbortSignal.timeout(CLICKUP_REQUEST_TIMEOUT_MS / 2),
      });
      if (response.ok) return;
      const error = practiceAreaWriteError(response.status, response.text);
      if (attempt === 0 && response.status >= 500 && response.status <= 599) {
        lastError = error;
        continue;
      }
      throw error;
    } catch (err: any) {
      if (err instanceof ClickUpHttpError) throw err;
      lastError = err;
      if (attempt === 0) continue;
    }
  }
  const errorClass =
    (lastError as any)?.name ?? (lastError as any)?.constructor?.name ?? "Error";
  throw new Error(
    `ClickUp Practice Area write timed out or failed twice (${errorClass}); cached directory data was not changed.`,
  );
}

type PracticeAreaWriteRequest = typeof clickUpCompanyRawRequest;
let _practiceAreaWriteRequest: PracticeAreaWriteRequest =
  clickUpCompanyRawRequest;

/** Test-only no-egress seam for the Practice Area write operation. */
export function __setPracticeAreaWriteRequestForTest(
  request: PracticeAreaWriteRequest | null,
): void {
  _practiceAreaWriteRequest = request ?? clickUpCompanyRawRequest;
}

/**
 * Replace one live parent client's complete Practice Area selection, addressed
 * by any associated GAds/LSA CID. Labels must exactly match the currently
 * fetched canonical option labels. Every operation forces a successful
 * directory+metadata refresh under the directory lock before validation, so a
 * stale display cache can never authorize a write. Re-applying the same
 * canonical set is a no-op. The in-memory projection is patched only after
 * ClickUp confirms success; ambiguous failures leave the last good bundle
 * untouched.
 */
export async function replacePracticeAreasForCid(
  rawCid: string,
  requestedLabels: string[],
): Promise<ReplacePracticeAreasResult> {
  const cid = normCid(rawCid);
  if (!cid) throw new Error("A valid Google Ads or LSA customer ID is required.");
  if (!Array.isArray(requestedLabels)) {
    throw new Error("Practice Area labels must be an array.");
  }

  return _locks.withLock("directory", async () => {
    const bundle = await refreshClientDirectoryLocked({
      force: true,
      throwOnError: true,
    });

    const parentTaskIds = bundle.cidParentTaskIds[cid] ?? [];
    if (parentTaskIds.length === 0) {
      throw new Error(
        `Customer ID ${cid} is not mapped to a live parent client in the canonical ClickUp Client List.`,
      );
    }
    if (parentTaskIds.length !== 1) {
      throw new Error(
        `Customer ID ${cid} maps to multiple live ClickUp parents; Practice Area write was not attempted.`,
      );
    }
    const parentTaskId = parentTaskIds[0];

    const optionByLabel = new Map(
      bundle.practiceAreaOptions.map((option) => [option.label, option] as const),
    );
    if (requestedLabels.some((label) => typeof label !== "string")) {
      throw new Error("Practice Area labels must be strings.");
    }
    const requested = [...requestedLabels];
    if (requested.some((label) => !label.trim())) {
      throw new Error("Practice Area labels cannot be blank.");
    }
    const requestedSet = new Set(requested);
    const unknown = [...requestedSet].filter((label) => !optionByLabel.has(label));
    if (unknown.length) {
      throw new Error(
        `Unknown canonical Practice Area label${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      );
    }

    const desiredOptions = bundle.practiceAreaOptions.filter((option) =>
      requestedSet.has(option.label),
    );
    const desiredLabels = desiredOptions.map((option) => option.label);
    const currentLabels = bundle.cidPracticeAreas[cid] ?? [];
    if (
      currentLabels.length === desiredLabels.length &&
      currentLabels.every((label, index) => label === desiredLabels[index])
    ) {
      return { cid, parentTaskId, labels: [...desiredLabels], changed: false };
    }

    const token = await resolveClickUpToken();
    if (!token) {
      throw new Error("No ClickUp company token is configured (env or admin override).");
    }
    await writePracticeAreaIds(
      token,
      parentTaskId,
      desiredOptions.map((option) => option.id),
    );

    // Patch every account under the same parent after success only.
    let parentClientKey: string | null = null;
    for (const [mappedCid, mappedParents] of Object.entries(bundle.cidParentTaskIds)) {
      if (!mappedParents.includes(parentTaskId)) continue;
      bundle.cidPracticeAreas[mappedCid] = [...desiredLabels];
      parentClientKey ??= bundle.cidClient[mappedCid] ?? null;
    }
    if (parentClientKey && bundle.clients[parentClientKey]) {
      bundle.clients[parentClientKey].practice_areas = [...desiredLabels];
    }

    return { cid, parentTaskId, labels: [...desiredLabels], changed: true };
  });
}

// ---------------------------------------------------------------------------
// Task #5157 — Evidence collection (separate from the directory bundle).
//
// Preserves EVERY canonical list parent with additional raw evidence needed
// for paid-search role cutover analysis. Pinned exclusively to the LITERAL
// canonical production list (901417549202) — NOT the env-overridable
// CLICKUP_CLIENT_LIST_ID. Never adds arbitrary list reads. Returns null when
// ClickUp is unconfigured/unreachable.
// ---------------------------------------------------------------------------

/** Raw People-field entry: exact ClickUp user ID + safe display metadata. */
export interface PeopleFieldEntry {
  /** Raw ClickUp user ID (string of digits). */
  clickupUserId: string;
  /** ClickUp username (safe to display; may be null if absent). */
  username: string | null;
  /** Display name from ClickUp (safe to display; may be null). */
  displayName: string | null;
  /** Email from ClickUp field data (safe to display; may be null). */
  email: string | null;
}

/** People field metadata from the custom_fields definition. */
export interface PeopleFieldMeta {
  id: string;
  name: string;
  type: string;
}

/** Evidence subtask entry (GAds or LSA CID row found under a parent). */
export interface EvidenceSubtask {
  subtaskId: string;
  subtaskName: string;
  product: "gads" | "lsa" | null;
  cid: string | null;
}

/** Per-parent evidence row. */
export interface ParentEvidence {
  /** Stable ClickUp task ID (never changes for the lifetime of the task). */
  taskId: string;
  /** Original display name from ClickUp (may contain duplicates across parents). */
  name: string;
  /** Normalized name key (for duplicate detection). */
  normName: string;
  /** Raw status string (lowercase). */
  status: string;
  /** Whether this parent is excluded (offboarded). */
  excluded: boolean;
  /** Raw all People IDs + safe display metadata for the Doer field. */
  doerPeople: PeopleFieldEntry[];
  /** Raw all People IDs + safe display metadata for the Checker field. */
  checkerPeople: PeopleFieldEntry[];
  /** People field metadata for the Doer field (id/name/type). */
  doerFieldMeta: PeopleFieldMeta | null;
  /** People field metadata for the Checker field (id/name/type). */
  checkerFieldMeta: PeopleFieldMeta | null;
  /** GAds and LSA subtask CID evidence found under this parent. */
  subtasks: EvidenceSubtask[];
  /** Whether any subtask has a GAds product CID. */
  hasGads: boolean;
  /** Whether any subtask has an LSA product CID. */
  hasLsa: boolean;
  /** Whether this parent has NO subtasks with a recognized product. */
  missingProduct: boolean;
  /** Provenance: other parents sharing the same normalized name (for duplicate detection). */
  duplicateNormNameTaskIds: string[];
}

export interface DirectoryEvidence {
  /** All canonical list parents (live + excluded), preserving list order. */
  parents: ParentEvidence[];
  /** Norm name → task IDs with that norm name (for duplicate detection). */
  normNameToTaskIds: Record<string, string[]>;
  fetchedAt: number;
}

/** Extract safe People entries from a raw ClickUp People custom field value. */
function extractPeopleEntries(field: any): PeopleFieldEntry[] {
  const val = field?.value;
  if (!Array.isArray(val) || val.length === 0) return [];
  return val
    .filter((v: any) => v && typeof v === "object")
    .map((v: any) => ({
      clickupUserId: String(v.id ?? v.user_id ?? ""),
      username: v.username ?? null,
      displayName: v.username ?? (v.initials ? null : null) ?? null,
      email: v.email ?? null,
    }))
    .filter((e) => e.clickupUserId);
}

/** Extract People field metadata (id/name/type) from a custom_field entry. */
function extractPeopleFieldMeta(field: any): PeopleFieldMeta | null {
  if (!field) return null;
  return {
    id: String(field.id ?? ""),
    name: String(field.name ?? ""),
    type: String(field.type ?? ""),
  };
}

function normCidEvidence(value: any): string | null {
  const s = String(value ?? "").replace(/[^0-9]/g, "");
  return s || null;
}

function subtaskProductEvidence(name: string): "gads" | "lsa" | null {
  const n = (name ?? "").trim().toUpperCase();
  if (n.startsWith("LSA")) return "lsa";
  if (n.startsWith("GOOGLE ADS")) return "gads";
  return null;
}

/**
 * Fetch the canonical list and build a rich evidence bundle for every parent
 * (live + excluded). Pinned to the LITERAL canonical Client List
 * (EVIDENCE_CANONICAL_LIST_ID = 901417549202), independent of the
 * env-overridable CLICKUP_CLIENT_LIST_ID used by the operational directory.
 *
 * Returns null when ClickUp is unconfigured or the fetch fails — callers must
 * treat null as "unavailable" and fail closed.
 *
 * This is a SEPARATE fetch path from the directory cache. It does NOT affect
 * the directory bundle, liveness, failure backoff, or alert hooks.
 */
export async function fetchDirectoryEvidence(): Promise<DirectoryEvidence | null> {
  const token = await resolveClickUpToken();
  if (!token) return null;
  let tasks: any[];
  try {
    // Pinned to the LITERAL canonical list — never the env-overridable
    // CLICKUP_CLIENT_LIST_ID (Task #5157 fix 7).
    tasks = await listTasksWithSubtasks(token, EVIDENCE_CANONICAL_LIST_ID);
  } catch (err: any) {
    console.error(
      `[AdsOs/ClickUp] evidence fetch failed: ${err?.message ?? err}`,
    );
    return null;
  }

  const excluded = getClickUpExcludedStatuses();

  // Split parents vs subtasks.
  const parents: any[] = [];
  const subtasksByParentId = new Map<string, any[]>();
  for (const t of tasks) {
    if (t?.parent) {
      const arr = subtasksByParentId.get(String(t.parent)) ?? [];
      arr.push(t);
      subtasksByParentId.set(String(t.parent), arr);
    } else if (t) {
      parents.push(t);
    }
  }

  // Build norm name → task IDs index for duplicate detection.
  const normNameToTaskIds: Record<string, string[]> = {};
  for (const t of parents) {
    const name = String(t.name ?? "").trim();
    if (!name) continue;
    const key = normClientName(name);
    if (!normNameToTaskIds[key]) normNameToTaskIds[key] = [];
    normNameToTaskIds[key].push(String(t.id));
  }

  const evidenceParents: ParentEvidence[] = [];

  for (const t of parents) {
    try {
      const name = String(t.name ?? "").trim();
      if (!name) continue;
      const taskId = String(t.id);
      const status = String(t.status?.status ?? "").toLowerCase();
      const isExcluded = excluded.has(status);
      const normName = normClientName(name);

      const fields: Record<string, any> = {};
      for (const f of t.custom_fields ?? []) {
        if (f?.id) fields[f.id] = f;
      }

      const doerField = fields[EVIDENCE_DOER_FIELD_ID] ?? null;
      const checkerField = fields[EVIDENCE_CHECKER_FIELD_ID] ?? null;

      const doerPeople = extractPeopleEntries(doerField);
      const checkerPeople = extractPeopleEntries(checkerField);
      const doerFieldMeta = extractPeopleFieldMeta(doerField);
      const checkerFieldMeta = extractPeopleFieldMeta(checkerField);

      // Build subtask evidence.
      const rawSubtasks = subtasksByParentId.get(taskId) ?? [];
      const subtasks: EvidenceSubtask[] = [];
      let hasGads = false;
      let hasLsa = false;

      for (const st of rawSubtasks) {
        try {
          const stFields: Record<string, any> = {};
          for (const f of st.custom_fields ?? []) {
            if (f?.id) stFields[f.id] = f;
          }
          const cid = normCidEvidence(stFields[CLICKUP_CLIENT_CID_FIELD_ID]?.value);
          const product = subtaskProductEvidence(st.name ?? "");
          subtasks.push({
            subtaskId: String(st.id),
            subtaskName: String(st.name ?? ""),
            product,
            cid,
          });
          if (product === "gads" && cid) hasGads = true;
          if (product === "lsa" && cid) hasLsa = true;
        } catch {
          // skip malformed subtask — per-task resilience
        }
      }

      const missingProduct = !hasGads && !hasLsa;

      // Duplicate provenance: other parent task IDs with same norm name.
      const allTaskIds = normNameToTaskIds[normName] ?? [];
      const duplicateNormNameTaskIds = allTaskIds.filter((id) => id !== taskId);

      evidenceParents.push({
        taskId,
        name,
        normName,
        status,
        excluded: isExcluded,
        doerPeople,
        checkerPeople,
        doerFieldMeta,
        checkerFieldMeta,
        subtasks,
        hasGads,
        hasLsa,
        missingProduct,
        duplicateNormNameTaskIds,
      });
    } catch (err: any) {
      console.warn(
        `[AdsOs/ClickUp] skipping malformed parent in evidence fetch: ${err?.message ?? err}`,
      );
    }
  }

  return {
    parents: evidenceParents,
    normNameToTaskIds,
    fetchedAt: Date.now(),
  };
}
