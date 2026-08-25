// @db-pool-intent: ambient
/**
 * Paid Search role cutover — execution-time projection-write gate (leaf).
 *
 * This is a deliberately focused, cycle-free module. It reads the cutover
 * system setting FRESH (never cached) and re-identifies the unique live Paid
 * Search department so a toggle, rename/duplicate, or destination drift after
 * command claim is honored immediately before mutation.
 *
 * Why a separate module (not paidSearchRoleCutover.ts): the worker must not
 * pull in the heavy cutover service (ClickUp evidence fetch, assignment
 * boundary, preview). This module imports only storage, the DB identity lookup,
 * and literal contract constants, so there is no import cycle with the worker.
 */

import { storage } from "../../storage";
import { eq } from "drizzle-orm";
import { sdDepartments } from "@shared/schema";
import { getDb, withDbAttribution } from "../../db";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_DOER_FIELD_ID,
  CLICKUP_CHECKER_FIELD_ID,
  PAID_SEARCH_DEPT_NAME,
  canonicalPaidSearchFieldForResponsibility,
} from "./paidSearchRoleContract";

export const PAID_SEARCH_CUTOVER_SETTING_KEY = "paid_search_role_cutover_state";

/**
 * Minimal fresh read of the projection-write authorization derived from the
 * cutover setting. Reads via getSystemSettingFresh (bypasses any cache).
 * Fail closed: any parse/read error → not authorized.
 */
export interface CutoverProjectionAuthorization {
  /** True only when read approval + projection-write approval + writes enabled. */
  projectionWritesAuthorized: boolean;
  /** The exact Paid Search department id approved for writes (persisted on approval). */
  approvedDepartmentId: string | null;
}

export async function readCutoverProjectionAuthorizationFresh(): Promise<CutoverProjectionAuthorization> {
  try {
    const setting = await storage.getSystemSettingFresh(PAID_SEARCH_CUTOVER_SETTING_KEY);
    if (!setting?.value) {
      return { projectionWritesAuthorized: false, approvedDepartmentId: null };
    }
    const raw = JSON.parse(setting.value);
    const readApproved = raw?.readApproved === true;
    const projectionWriteApproved = raw?.projectionWriteApproved === true;
    const projectionWritesEnabled = raw?.projectionWritesEnabled === true;
    const approvedDepartmentId =
      typeof raw?.approvedDepartmentId === "string" && raw.approvedDepartmentId.length > 0
        ? raw.approvedDepartmentId
        : null;
    const authorized =
      readApproved &&
      projectionWriteApproved &&
      projectionWritesEnabled &&
      approvedDepartmentId !== null;
    return {
      projectionWritesAuthorized: authorized,
      approvedDepartmentId,
    };
  } catch {
    // Fail closed on any error.
    return { projectionWritesAuthorized: false, approvedDepartmentId: null };
  }
}

/**
 * Whether a given projection destination is the canonical Paid Search
 * production destination that this gate governs. A destination is governed iff
 * it targets the canonical production list AND uses one of the two canonical
 * People field IDs (Doer / Checker). Other responsibilities are not governed
 * because they have no approved Paid Search field.
 */
export function isGovernedPaidSearchDestination(args: {
  listId: string | null;
  peopleFieldId: string;
  environment: string;
}): boolean {
  if (args.environment !== "production") return false;
  if (args.listId !== CANONICAL_PRODUCTION_LIST_ID) return false;
  return (
    args.peopleFieldId === CLICKUP_DOER_FIELD_ID ||
    args.peopleFieldId === CLICKUP_CHECKER_FIELD_ID
  );
}

/**
 * The canonical People field for a Paid Search responsibility. Doer and Checker
 * are the ONLY governed responsibilities; anything else has no canonical field
 * and is never a governed Paid Search projection.
 */
function canonicalFieldForResponsibility(responsibility: string | null | undefined): string | null {
  return canonicalPaidSearchFieldForResponsibility(responsibility);
}

async function readPaidSearchDepartmentIdsFresh(): Promise<
  { ok: true; ids: string[] } | { ok: false }
> {
  try {
    const ids = await withDbAttribution(
      "paidSearchCutover:projectionGate:departmentScope",
      async () => {
        const db = getDb();
        return db
          .select({ id: sdDepartments.id })
          .from(sdDepartments)
          .where(eq(sdDepartments.name, PAID_SEARCH_DEPT_NAME));
      },
    );
    return { ok: true, ids: ids.map((row) => row.id) };
  } catch {
    return { ok: false };
  }
}

/**
 * Execution-time verdict for a Paid Search production destination. Department
 * identity is discovered independently of approval state: every destination in
 * the exact live Paid Search department is governed, including malformed legacy
 * destinations. Canonical-shaped or previously-approved destinations remain
 * governed defensively even after drift. Unrelated generic destinations pass.
 */
export async function evaluatePaidSearchProjectionGate(args: {
  listId: string | null;
  peopleFieldId: string;
  environment: string;
  departmentId: string | null;
  /**
   * The destination's responsibility. Optional so
   * callers/tests that only carry list/field/env still work; when present it is
   * enforced fail-closed against the canonical field mapping so a governed
   * destination cannot drift its People field to the wrong role's field.
   */
  responsibility?: string | null;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (args.environment !== "production") {
    // Sandbox destinations remain governed by the generic sandbox ownership
    // guard and are never restricted by the production cutover flag.
    return { allowed: true };
  }

  const [auth, departmentLookup] = await Promise.all([
    readCutoverProjectionAuthorizationFresh(),
    readPaidSearchDepartmentIdsFresh(),
  ]);
  if (!departmentLookup.ok) {
    return {
      allowed: false,
      reason:
        "Paid Search department scope could not be verified immediately before mutation — refusing production write",
    };
  }
  const paidSearchDepartmentIds = departmentLookup.ids;
  const hasApprovedDepartmentIdentity =
    auth.approvedDepartmentId !== null &&
    args.departmentId === auth.approvedDepartmentId;
  const hasCanonicalPaidSearchShape = isGovernedPaidSearchDestination(args);
  const belongsToPaidSearchDepartment =
    args.departmentId !== null &&
    paidSearchDepartmentIds.includes(args.departmentId);
  if (
    !belongsToPaidSearchDepartment &&
    !hasApprovedDepartmentIdentity &&
    !hasCanonicalPaidSearchShape
  ) {
    // Unrelated production destination. A previously-approved Paid Search
    // destination remains governed by department identity even if an operator
    // drifts its list or field after approval.
    return { allowed: true };
  }

  if (paidSearchDepartmentIds.length !== 1) {
    return {
      allowed: false,
      reason:
        `Paid Search department scope is not unique (found ${paidSearchDepartmentIds.length}) — refusing production write`,
    };
  }
  const currentPaidSearchDepartmentId = paidSearchDepartmentIds[0];
  if (args.departmentId !== currentPaidSearchDepartmentId) {
    return {
      allowed: false,
      reason:
        `Production Paid Search projection must belong to department ${currentPaidSearchDepartmentId}, not ${args.departmentId}`,
    };
  }

  // Governed destinations are fail-closed. Beyond the fresh authorization we
  // re-assert every invariant EXACTLY: canonical list, doer/checker only, the
  // exact corresponding People field, and (when supplied) a matching
  // responsibility. Any drift is denied even if writes are otherwise authorized.
  if (args.listId !== CANONICAL_PRODUCTION_LIST_ID) {
    return {
      allowed: false,
      reason: `Paid Search cutover destination list ${args.listId} is not the canonical production list ${CANONICAL_PRODUCTION_LIST_ID}`,
    };
  }
  const expectedField = canonicalFieldForResponsibility(args.responsibility);
  if (!expectedField) {
    return {
      allowed: false,
      reason: `Paid Search cutover responsibility "${args.responsibility}" is not governed (only doer/checker) — refusing governed production write`,
    };
  }
  if (args.peopleFieldId !== expectedField) {
    return {
      allowed: false,
      reason: `Paid Search cutover People field ${args.peopleFieldId} does not match the canonical field for responsibility ${args.responsibility}`,
    };
  }

  if (!auth.projectionWritesAuthorized) {
    return {
      allowed: false,
      reason:
        "Paid Search cutover projection writes not authorized (fresh state: requires read approval + projection-write approval + projectionWritesEnabled=true)",
    };
  }
  // The approved department must be present AND exactly equal to the
  // destination's department. A null approved department, a null destination
  // department, or any mismatch all fail closed — preserving the approved
  // department identity even across write-disable/revocation (a stale/absent
  // scope can never widen the blast radius).
  if (!auth.approvedDepartmentId) {
    return {
      allowed: false,
      reason:
        "Paid Search cutover has no approved department scope in the fresh state — refusing governed production write",
    };
  }
  if (!args.departmentId) {
    return {
      allowed: false,
      reason:
        "Governed Paid Search destination has no department id — refusing production write (department scope is required)",
    };
  }
  if (auth.approvedDepartmentId !== args.departmentId) {
    return {
      allowed: false,
      reason: `Paid Search cutover approval is scoped to department ${auth.approvedDepartmentId}, not destination department ${args.departmentId}`,
    };
  }
  return { allowed: true };
}
