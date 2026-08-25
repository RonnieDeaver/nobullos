/**
 * Task #5156 — ClickUp role projection vendor adapter.
 *
 * Company-token projection primitives: GET task with abort timeout, validate
 * owning list, validate People custom-field shape and one-person cardinality,
 * compare current IDs, set/clear minimum delta, direct read-back.
 *
 * HTTP status classification:
 *   - 429 → rate_limited (retryable, ambiguous)
 *   - 5xx → vendor_5xx (retryable, ambiguous)
 *   - timeout/abort → timeout (retryable, ambiguous)
 *   - pre-connect network error → retryable (not ambiguous)
 *   - 401 / 403 → auth (terminal, non-retryable)
 *   - 404 → not_found (terminal, non-retryable, caller decides)
 *   - Other 4xx → terminal (non-retryable, bad request)
 *
 * Uses company token (resolveClickUpCompanyToken). Never personal OAuth.
 * Wraps outbound calls in externalCallAudit when the switch is enabled.
 * Does NOT retry the fetch if the audit wrapper itself throws.
 *
 * Production list constant: 901417549202 — sandbox MUST fail closed if the
 * resolved owning list matches this ID and environment is not "production".
 *
 * Cardinality violation (>1 user in field): nonretryable, must NOT overwrite.
 *
 * Desired ClickUp user ID must be digits-only (no spaces, letters, or dashes).
 */

import { resolveClickUpCompanyToken } from "./clickUpCompanyToken";
import { auditOutboundCall, isAuditEnabled } from "./externalCallAudit";
import { clickUpProjectionRawRequest } from "./clickUpClient";
import type { CuRoleProjectionErrorCode } from "@shared/models/clickUpRoleProjection";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";

// ─── Constants ────────────────────────────────────────────────────────────────

// Vendor host ownership: all projection HTTP is routed through the sole owning
// adapter (clickUpClient.ts) via clickUpProjectionRawRequest. The vendor
// hostname/base URL lives ONLY in that adapter — never here.

/** The canonical production Ads OS list. Sandbox must fail closed against this. */
export { CANONICAL_PRODUCTION_LIST_ID };

/** Abort timeout for each individual vendor call (ms). */
const CALL_TIMEOUT_MS = 15_000;

/** Digits-only validator for ClickUp user IDs. */
export function isValidClickUpUserId(id: string): boolean {
  return /^\d+$/.test(id);
}

// ─── Vendor call outcome ──────────────────────────────────────────────────────

export type VendorCallOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      retryable: boolean;
      status?: number;
      error: string;
      ambiguous?: boolean;
      errorCode?: CuRoleProjectionErrorCode;
    };

function classifyHttpError(status: number, body: string): VendorCallOutcome {
  if (status === 429) {
    return {
      ok: false,
      retryable: true,
      status,
      error: `Rate limited (429)`,
      ambiguous: true,
      errorCode: "rate_limited",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      retryable: true,
      status,
      error: `Server error (${status}): ${body.slice(0, 200)}`,
      ambiguous: true,
      errorCode: "vendor_5xx",
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      retryable: false,
      status,
      error: `Auth error (${status}): ${body.slice(0, 200)}`,
      errorCode: "auth",
    };
  }
  if (status === 404) {
    return { ok: false, retryable: false, status, error: `Not found (404)` };
  }
  return {
    ok: false,
    retryable: false,
    status,
    error: `Client error (${status}): ${body.slice(0, 200)}`,
  };
}

function classifyNetworkError(err: unknown): VendorCallOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) {
    return {
      ok: false,
      retryable: true,
      error: `Network timeout: ${msg.slice(0, 200)}`,
      ambiguous: true,
      errorCode: "timeout",
    };
  }
  // Pre-connect network failure (safe to retry, NOT ambiguous).
  return { ok: false, retryable: true, error: `Network error: ${msg.slice(0, 200)}` };
}

// ─── Raw call helper ──────────────────────────────────────────────────────────

/**
 * The owning-adapter request function. Defaults to clickUpClient's confined
 * primitive; a test-only seam can substitute an in-memory implementation so the
 * confinement path can be exercised WITHOUT a real vendor host or fetch.
 */
type RawRequestFn = typeof clickUpProjectionRawRequest;
let rawRequestImpl: RawRequestFn = clickUpProjectionRawRequest;

/** TEST-ONLY: override the owning-adapter raw request; returns a restore fn. */
export function __test_setProjectionRawRequest(fn: RawRequestFn | null): () => void {
  const prev = rawRequestImpl;
  rawRequestImpl = fn ?? clickUpProjectionRawRequest;
  return () => {
    rawRequestImpl = prev;
  };
}

/**
 * Single vendor call with abort timeout. Does NOT retry (the owning adapter's
 * rate-limit/breaker handling applies underneath). Routes through the sole
 * owning ClickUp adapter (clickUpProjectionRawRequest) so no vendor hostname or
 * raw host fetch lives in this projection module.
 * If the audit wrapper throws, propagates directly (does NOT re-call doFetch).
 */
async function cuProjectionCall(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<VendorCallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  const doFetch = async (): Promise<VendorCallOutcome> => {
    try {
      const res = await rawRequestImpl({
        token,
        method,
        path,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return classifyHttpError(res.status, res.text);
      }
      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch {
        data = res.text;
      }
      return { ok: true, data };
    } catch (err: unknown) {
      if ((err as any)?.name === "AbortError") {
        return {
          ok: false,
          retryable: true,
          error: `Request aborted after ${CALL_TIMEOUT_MS}ms`,
          ambiguous: true,
          errorCode: "timeout",
        };
      }
      return classifyNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
  };

  if (!isAuditEnabled()) {
    return doFetch();
  }

  // Wrap in audit. If the audit wrapper itself throws, propagate — do NOT fall back to doFetch.
  return auditOutboundCall<VendorCallOutcome>(
    {
      integration: "clickup",
      endpoint: path,
      method: method.toUpperCase(),
    },
    async () => {
      const result = await doFetch();
      return {
        value: result,
        statusCode: result.ok ? 200 : (result as any).status,
      };
    },
  );
}

// ─── Resolve company token ────────────────────────────────────────────────────

async function getToken(): Promise<{ token: string } | { error: string }> {
  const resolved = await resolveClickUpCompanyToken();
  if (!resolved.token) {
    return { error: "No ClickUp company token configured" };
  }
  return { token: resolved.token };
}

// ─── People field shape ───────────────────────────────────────────────────────

export interface PeopleFieldValue {
  /** ClickUp user ID strings currently in the field. */
  userIds: string[];
}

/**
 * Extract People field value from a ClickUp task's custom_fields array.
 * Returns null if the field is absent or malformed.
 */
export function extractPeopleField(
  task: any,
  peopleFieldId: string,
): PeopleFieldValue | null {
  const fields: unknown[] = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  const field = fields.find(
    (f: any) => typeof f?.id === "string" && f.id === peopleFieldId,
  );
  if (!field) return null;
  const value = (field as any).value;
  if (!value || !Array.isArray(value)) return { userIds: [] };
  const ids = value
    .map((u: any) => (typeof u?.id !== "undefined" ? String(u.id) : null))
    .filter((id): id is string => id !== null && id !== "");
  return { userIds: ids };
}

/**
 * Validate that the People field shape is correct (present, correct type).
 * Returns an error string if invalid, null if valid.
 */
export function validatePeopleFieldShape(task: any, peopleFieldId: string): string | null {
  const fields: unknown[] = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  const field = fields.find(
    (f: any) => typeof f?.id === "string" && f.id === peopleFieldId,
  );
  if (!field) {
    return `People field ${peopleFieldId} not found on task ${task?.id}`;
  }
  const type = (field as any).type;
  if (type !== "users" && type !== "people") {
    return `Field ${peopleFieldId} is type "${type}", expected "users"/"people"`;
  }
  return null;
}

/**
 * Validate one-person cardinality: the field must have at most maxPeople entries.
 * Returns an error string if violated, null if valid.
 */
export function validateOnePerson(people: PeopleFieldValue, maxPeople = 1): string | null {
  if (people.userIds.length > maxPeople) {
    return `People field has ${people.userIds.length} users, expected at most ${maxPeople}`;
  }
  return null;
}

// ─── Task GET with owning-list validation ─────────────────────────────────────

export interface ProjectionTaskFetch {
  ok: true;
  task: any;
  ownedByList: string;
}

export type ProjectionTaskFetchResult =
  | ProjectionTaskFetch
  | {
      ok: false;
      retryable: boolean;
      error: string;
      ambiguous?: boolean;
      status?: number;
      errorCode?: CuRoleProjectionErrorCode;
    };

/**
 * Fetch a ClickUp task and validate its owning list matches expectedListId.
 * Fails closed if the resolved owning list is the canonical production list
 * and the caller is in sandbox mode.
 */
export async function fetchProjectionTask(
  taskId: string,
  expectedListId: string,
  options: { sandboxMode?: boolean } = {},
): Promise<ProjectionTaskFetchResult> {
  const tok = await getToken();
  if ("error" in tok) {
    return { ok: false, retryable: false, error: tok.error, errorCode: "auth" };
  }

  const outcome = await cuProjectionCall(tok.token, "GET", `/task/${encodeURIComponent(taskId)}`);
  if (!outcome.ok) return outcome as ProjectionTaskFetchResult;

  const task = outcome.data as any;
  const resolvedListId = String(task?.list?.id ?? "");

  // Sandbox must fail closed if the resolved list is the canonical production list.
  if (options.sandboxMode && resolvedListId === CANONICAL_PRODUCTION_LIST_ID) {
    return {
      ok: false,
      retryable: false,
      error: `Sandbox safety: task ${taskId} belongs to canonical production list ${CANONICAL_PRODUCTION_LIST_ID}; refusing sandbox write`,
      errorCode: "list_mismatch",
    };
  }

  // Validate owning list.
  if (resolvedListId !== expectedListId) {
    return {
      ok: false,
      retryable: false,
      error: `Task ${taskId} owns list "${resolvedListId}", expected "${expectedListId}"`,
      errorCode: "list_mismatch",
    };
  }

  return { ok: true, task, ownedByList: resolvedListId };
}

// ─── People field compare + set/clear ────────────────────────────────────────

export interface ProjectionWriteResult {
  ok: true;
  action: "set" | "clear" | "noop";
  previousIds: string[];
  desiredId: string | null;
}

export type ProjectionWriteOutcome =
  | ProjectionWriteResult
  | {
      ok: false;
      retryable: boolean;
      error: string;
      ambiguous?: boolean;
      status?: number;
      errorCode?: CuRoleProjectionErrorCode;
      /** True when cardinality >1 was found — caller must NOT write to fix */
      cardinalityViolation?: boolean;
    };

/**
 * Compare current People field against desired, then apply minimum delta:
 * - If current already matches desired → noop.
 * - If desired is null/empty → clear the field.
 * - Otherwise → set field to exactly [desiredClickupUserId].
 *
 * CARDINALITY RULE: If field has >1 users (cardinality violation), returns
 * a nonretryable error WITHOUT writing. The caller must never overwrite a
 * multi-user field — this is treated as invalid_cardinality.
 *
 * Returns the write outcome. Does NOT read back — caller must call
 * readBackProjectionField to verify.
 */
export async function applyProjectionDelta(args: {
  taskId: string;
  expectedListId: string;
  peopleFieldId: string;
  desiredClickupUserId: string | null;
  sandboxMode?: boolean;
}): Promise<ProjectionWriteOutcome> {
  const fetchResult = await fetchProjectionTask(args.taskId, args.expectedListId, {
    sandboxMode: args.sandboxMode,
  });
  if (!fetchResult.ok) return fetchResult as ProjectionWriteOutcome;

  const { task } = fetchResult;

  // Validate field shape.
  const shapeErr = validatePeopleFieldShape(task, args.peopleFieldId);
  if (shapeErr) {
    return {
      ok: false,
      retryable: false,
      error: shapeErr,
      errorCode: "invalid_field",
    };
  }

  const people = extractPeopleField(task, args.peopleFieldId);
  if (!people) {
    return {
      ok: false,
      retryable: false,
      error: `People field ${args.peopleFieldId} extraction failed`,
      errorCode: "invalid_field",
    };
  }

  // CARDINALITY VIOLATION: nonretryable, must NOT overwrite.
  const cardinalityErr = validateOnePerson(people);
  if (cardinalityErr) {
    return {
      ok: false,
      retryable: false,
      error: `Cardinality violation: ${cardinalityErr} — refusing to overwrite`,
      errorCode: "invalid_cardinality",
      cardinalityViolation: true,
    };
  }

  const previousIds = people.userIds;
  const desiredSingle = args.desiredClickupUserId ?? null;

  // Check if already matches.
  if (desiredSingle === null) {
    if (previousIds.length === 0) {
      return { ok: true, action: "noop", previousIds, desiredId: null };
    }
  } else {
    if (previousIds.length === 1 && previousIds[0] === desiredSingle) {
      return { ok: true, action: "noop", previousIds, desiredId: desiredSingle };
    }
  }

  const tok = await getToken();
  if ("error" in tok) {
    return { ok: false, retryable: false, error: tok.error, errorCode: "auth" };
  }

  if (desiredSingle === null) {
    // Clear field.
    const delOutcome = await cuProjectionCall(
      tok.token,
      "DELETE",
      `/task/${encodeURIComponent(args.taskId)}/field/${encodeURIComponent(args.peopleFieldId)}`,
    );
    if (!delOutcome.ok) return delOutcome as ProjectionWriteOutcome;
    return { ok: true, action: "clear", previousIds, desiredId: null };
  } else {
    // Set field to exactly [desiredSingle]. ClickUp People field value is an array of user IDs.
    const setOutcome = await cuProjectionCall(
      tok.token,
      "POST",
      `/task/${encodeURIComponent(args.taskId)}/field/${encodeURIComponent(args.peopleFieldId)}`,
      { value: [parseInt(desiredSingle, 10)] },
    );
    if (!setOutcome.ok) return setOutcome as ProjectionWriteOutcome;
    return { ok: true, action: "set", previousIds, desiredId: desiredSingle };
  }
}

// ─── Read-back verification ───────────────────────────────────────────────────

export interface ProjectionReadBack {
  ok: true;
  currentIds: string[];
  matchesDesired: boolean;
}

export type ProjectionReadBackResult =
  | ProjectionReadBack
  | {
      ok: false;
      retryable: boolean;
      error: string;
      ambiguous?: boolean;
      status?: number;
      errorCode?: CuRoleProjectionErrorCode;
    };

/**
 * Read back the People field after a write to confirm the exact desired state.
 * Returns matchesDesired=true only if currentIds exactly matches [desiredId]
 * (or both are empty for a clear operation).
 * Never declares synced without this confirmation.
 */
export async function readBackProjectionField(args: {
  taskId: string;
  expectedListId: string;
  peopleFieldId: string;
  desiredClickupUserId: string | null;
  sandboxMode?: boolean;
}): Promise<ProjectionReadBackResult> {
  const fetchResult = await fetchProjectionTask(args.taskId, args.expectedListId, {
    sandboxMode: args.sandboxMode,
  });
  if (!fetchResult.ok) return fetchResult as ProjectionReadBackResult;

  const { task } = fetchResult;
  const people = extractPeopleField(task, args.peopleFieldId);
  if (!people) {
    return {
      ok: false,
      retryable: false,
      error: `People field ${args.peopleFieldId} absent on read-back`,
      errorCode: "invalid_field",
    };
  }

  const currentIds = people.userIds;
  const desiredSingle = args.desiredClickupUserId;

  let matchesDesired: boolean;
  if (desiredSingle === null) {
    matchesDesired = currentIds.length === 0;
  } else {
    matchesDesired = currentIds.length === 1 && currentIds[0] === desiredSingle;
  }

  return { ok: true, currentIds, matchesDesired };
}
