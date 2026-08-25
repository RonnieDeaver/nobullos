// @db-pool-intent: ambient
/**
 * Task #5157 — Prod-action domain module: "Import Paid Search roles".
 *
 * One bounded, resumable, audited one-time prod action.
 *
 * Rules:
 *  - MANUAL LEVER (deliberate individual choice; Apply-all never fires it;
 *    self-heal not eligible). manualLever and humanGate are mutually exclusive
 *    in the kernel, so this action uses manualLever only — the CEO reviews the
 *    preview endpoint out-of-band before pressing Apply. Its status therefore
 *    never feeds the CEO badge (a lever is availability, not pending work).
 *  - One press processes max 500 parents / 1000 role slots.
 *  - Durable per-parent/role dispositions in ps_role_import_audit keyed by
 *    stable ClickUp parent task ID + role. ONLY imported/unchanged are TERMINAL
 *    (skipped on repeat presses). conflict/blank/ineligible are durable EVIDENCE
 *    but NON-terminal: they are re-evaluated every press so correcting the
 *    underlying data lets a later Apply advance the slot (Task #5157 fix 5).
 *    Every evaluated slot is also appended to ps_role_import_attempts so later
 *    retries cannot overwrite prior evidence or actor/timestamp attribution.
 *    Successful assignments + imported evidence share one locked DB
 *    transaction; evidence failure rolls the assignment back.
 *  - Import only preview-eligible rows (exact mappings, one People ID, etc.).
 *  - Never overwrites a non-null explicit role with a different user (conflict).
 *  - Uses setClientDepartmentAssignmentNoProjection — a NoBull-only write that
 *    shares the interactive path's lock/eligibility/upsert but stages ZERO
 *    projection commands and makes ZERO ClickUp vendor calls (Task #5157 fix 1).
 *    The import reads FROM ClickUp and never projects back OUT — structurally
 *    zero egress, independent of any destination/approval state.
 *  - Idempotent; no guesses.
 */

import { type ProdAction, type ProdActionDomain } from "./kernel";
import {
  getImportAuditSummary,
  runPaidSearchRoleImport,
} from "../adsOs/paidSearchRoleCutover";

const ACTION_ID = "import_paid_search_roles";

export const importPaidSearchRolesAction: ProdAction = {
  id: ACTION_ID,
  title: "Import Paid Search Roles",
  description:
    "One-shot bounded import of ClickUp Paid Search Doer/Checker assignments into NoBull. " +
    "Processes at most 500 parents / 1000 role slots per press. " +
    "Skips terminal rows (imported, unchanged) and re-evaluates non-terminal rows (conflict, blank, ineligible) on repeat presses. " +
    "Never overwrites a non-null role assignment with a different user. " +
    "Preview the /api/ads-os/admin/paid-search-role-cutover endpoint before applying.",
  change:
    "Writes per-client Doer/Checker assignments to sd_client_dept_assignments for the Paid Search department. " +
    "NoBull-only: stages NO projection commands and makes NO ClickUp vendor calls (reads FROM ClickUp, never projects back OUT). " +
    "Persists current per-parent/role resume state in ps_role_import_audit and immutable attempt history in ps_role_import_attempts.",
  convergence: { kind: "converging" },
  // MANUAL LEVER: Apply-all never fires this; self-heal never fires this.
  // Mutually exclusive with humanGate — the CEO reviews the preview endpoint
  // out-of-band before pressing Apply.
  manualLever: true,

  async status(_actorId) {
    // A manual lever's status never returns "pending" (its status must not
    // feed the CEO badge). We report the durable audit summary as
    // not-needed / applied / error only.
    try {
      const summary = await getImportAuditSummary();
      const imported = summary.imported;
      const conflict = summary.conflict;
      const total = summary.total;

      if (total === 0) {
        return {
          state: "not-needed",
          detail:
            "No import has run yet. Review the preview endpoint, then press Apply when ready.",
        };
      }

      const detail = [
        `${imported} imported`,
        `${summary.unchanged} unchanged`,
        `${conflict} conflict(s)`,
        `${summary.blank} blank`,
        `${summary.ineligible} ineligible`,
      ].join(", ");

      // Only imported/unchanged are terminal (Task #5157 fix 5). Non-terminal
      // dispositions (conflict/blank/ineligible) will be re-evaluated on the
      // next press. If anything was imported, report applied; otherwise report
      // not-needed. Conflicts are surfaced in the detail either way.
      if (imported > 0) {
        return { state: "applied", detail };
      }
      return { state: "not-needed", detail };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Status check failed: ${err?.message ?? err}`,
      };
    }
  },

  async apply(actorId) {
    try {
      const result = await runPaidSearchRoleImport(actorId ?? null);

      if (!result.ok) {
        // Missing department / unreachable ClickUp are configuration gaps, not
        // execution errors — surface them as blocked so the operator fixes the
        // prerequisite rather than reading it as a code failure.
        return {
          state: "blocked",
          detail: result.error ?? "Import blocked with unknown reason.",
        };
      }

      const detail = [
        `Processed ${result.processed} parents`,
        `${result.imported} imported`,
        `${result.unchanged} unchanged`,
        `${result.conflict} conflicts (not overwritten)`,
        `${result.blank} blank`,
        `${result.ineligible} ineligible`,
        `${result.skippedTerminal} skipped (terminal — imported/unchanged from prior press)`,
        result.retryable > 0 ? `${result.retryable} retryable (transient write failure)` : "",
        result.truncated ? `(more parents remain — press Apply again)` : "",
      ]
        .filter(Boolean)
        .join("; ");

      return {
        state: result.imported > 0 || result.unchanged > 0 ? "applied" : "not-needed",
        detail,
        rowsAffected: result.imported,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Import failed: ${err?.message ?? err}`,
      };
    }
  },

  async servedPurpose() {
    try {
      const summary = await getImportAuditSummary();
      // Served when at least one role has been imported and no conflicts remain.
      if (summary.imported > 0 && summary.conflict === 0) {
        return {
          served: true,
          note: `${summary.imported} role(s) imported, no conflicts.`,
        };
      }
      return { served: false };
    } catch {
      return { served: false };
    }
  },
};

export const paidSearchRoleImportDomain: ProdActionDomain = {
  name: "paidSearchRoleImport",
  actions: [importPaidSearchRolesAction],
};
