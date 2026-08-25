/**
 * Canonical Import Write Policy (Task #755, refined by Task #920A).
 *
 * Single source of truth for what an import / sync surface is allowed to do
 * when it encounters an entity. Imports may NEVER silently create authoritative
 * client-scoped entities (clients, client_locations, client_contacts,
 * products/services). However, a *link* row that connects two already-
 * configured authoritative entities (e.g. a `semrush_location_campaigns` row
 * binding an existing `client_locations` row to a SEMrush campaign) is not the
 * same as creating a new authoritative entity — it is a relationship between
 * operator-created entities, and imports may create that link directly.
 *
 * Allowed outcomes:
 *  - allow_update_existing  → entity exists in source-of-truth; update is fine
 *  - allow_link_existing    → safe to create a link row between two already-
 *                             configured authoritative entities (the link row
 *                             itself need not pre-exist)
 *  - allow_raw_ingest_create → safe to create non-authoritative ingest record
 *  - allow_review_suggestion → safe to create a review/suggestion record
 *  - drop_unknown            → silently skip, do not write
 *  - flag_warning            → skip + emit a warning surface to caller
 *  - reject_write            → fail loudly (used as last-line guard)
 *
 * Decision table for SEMrush `location_mapping` candidates (Task #920A):
 *
 *   surface              | entityKind        | entityExists | decision
 *   ---------------------+-------------------+--------------+--------------------------
 *   semrush_inventory    | location_mapping  | true         | allow_link_existing
 *   semrush_inventory    | location_mapping  | false        | allow_review_suggestion
 *   local_dominance_sync | location_mapping  | true         | allow_link_existing
 *   local_dominance_sync | location_mapping  | false        | allow_review_suggestion
 *   semrush_inventory    | (other kinds)     | n/a          | flag_warning (unchanged)
 *   matcher              | (any)             | n/a          | reject_write (unchanged)
 *
 * Before Task #920A, configured `location_mapping` candidates from SEMrush
 * surfaces returned `allow_review_suggestion`, which forced even
 * already-configured links to sit in the review queue forever. The corrected
 * rule treats a configured (clientId, locationId) pair as a green light to
 * write the link row directly — only unconfigured candidates remain in review.
 *
 * The helper returns a structured decision object so callers can branch and
 * surface warnings instead of relying on opaque booleans.
 */

import {
  ENTRY_TRACKED_IMPORT_METRICS,
  importMetricWasParsed,
  type EntryTrackedImportSection,
  type ImportFieldConfidenceMap,
} from "@shared/importMetricPresence";

export type ImportSurface =
  | "pdf_import"
  | "front_enrichment"
  | "front_apply"
  | "semrush_inventory"
  | "local_dominance_sync"
  | "matcher";

export type ImportEntityKind =
  | "client"
  | "client_field"
  | "client_contact"
  | "client_location"
  | "location_mapping"
  | "product"
  | "category"
  | "raw_ingest"
  | "review_suggestion";

export type ImportWriteAction = "create" | "update";

export type ImportWriteDecision =
  | "allow_update_existing"
  | "allow_link_existing"
  | "allow_raw_ingest_create"
  | "allow_review_suggestion"
  | "drop_unknown"
  | "flag_warning"
  | "reject_write";

export interface ImportWriteContext {
  /** True if the candidate entity already exists in the configured source-of-truth. */
  entityExists?: boolean;
  /** Optional human-readable identifier for logs/warnings. */
  candidateLabel?: string;
  /** Optional reason override (used by callers for richer warning text). */
  reason?: string;
}

export interface ImportWriteOutcome {
  decision: ImportWriteDecision;
  surface: ImportSurface;
  entityKind: ImportEntityKind;
  action: ImportWriteAction;
  reason: string;
  /** True when the caller MUST NOT perform the write. */
  blocked: boolean;
  /** Suggested log/warning string ready to surface in import logs. */
  warning?: string;
}

function decisionBlocks(d: ImportWriteDecision): boolean {
  return d === "drop_unknown" || d === "flag_warning" || d === "reject_write";
}

/**
 * Decide what an import surface is allowed to do for one (entityKind, action)
 * candidate. Callers pass `context.entityExists=true` when they have already
 * verified the candidate exists in the source-of-truth model; otherwise the
 * default policy is to refuse authoritative creates.
 */
export function evaluateImportWrite(
  surface: ImportSurface,
  entityKind: ImportEntityKind,
  action: ImportWriteAction,
  context: ImportWriteContext = {},
): ImportWriteOutcome {
  const label = context.candidateLabel ? ` (${context.candidateLabel})` : "";
  const baseReason = context.reason || "";

  // Raw ingest records (raw_communication_records etc.) are always allowed.
  if (entityKind === "raw_ingest") {
    return mk(surface, entityKind, action, "allow_raw_ingest_create", baseReason || "raw ingest is always allowed");
  }

  // Review/suggestion records are always allowed — they are explicitly non-authoritative.
  if (entityKind === "review_suggestion") {
    return mk(surface, entityKind, action, "allow_review_suggestion", baseReason || "review/suggestion records are non-authoritative");
  }

  // Updates against an existing authoritative entity are allowed for *most*
  // import surfaces. Two narrow exceptions:
  //   - matcher must NEVER write authoritative tables (read-only).
  //   - pdf_import must NEVER mutate authoritative client_field values
  //     (Task #755 explicitly removed averageCaseValue side-effects; the
  //     policy locks down the broader category).
  if (action === "update") {
    if (surface === "matcher") {
      return mk(surface, entityKind, action, "reject_write",
        baseReason || `matcher must never update authoritative ${entityKind}${label}`);
    }
    if (surface === "pdf_import" && entityKind === "client_field") {
      return mk(surface, entityKind, action, "flag_warning",
        baseReason || `pdf import: refusing to mutate authoritative client_field${label}; surface as warning instead`);
    }
    if (context.entityExists) {
      return mk(surface, entityKind, action, "allow_update_existing", baseReason || `update existing ${entityKind}${label}`);
    }
    return mk(
      surface,
      entityKind,
      action,
      "flag_warning",
      baseReason || `import surface '${surface}' tried to update a non-existent ${entityKind}${label}`,
    );
  }

  // Authoritative CREATE of a client-scoped entity from an import surface is
  // never allowed. Different surfaces map "create" to different safe outcomes:
  //   - pdf_import          → drop_unknown for products/categories,
  //                           flag_warning for client_field/contact/location.
  //   - front_enrichment    → allow_review_suggestion for contacts,
  //                           flag_warning otherwise.
  //   - semrush_inventory   → allow_link_existing for location_mapping when
  //                           the parent (clientId, locationId) is configured;
  //                           allow_review_suggestion when unconfigured;
  //                           flag_warning for other entity kinds.
  //   - matcher             → reject_write for everything (matchers must be
  //                           strictly read-only against authoritative tables).
  switch (surface) {
    case "matcher":
      return mk(
        surface,
        entityKind,
        action,
        "reject_write",
        baseReason || `matcher must never create authoritative ${entityKind}${label}`,
      );

    case "front_enrichment":
    case "front_apply":
      if (entityKind === "client_contact") {
        return mk(
          surface,
          entityKind,
          action,
          "allow_review_suggestion",
          baseReason || `front import: candidate contact${label} routed to review suggestions instead of authoritative create`,
        );
      }
      return mk(
        surface,
        entityKind,
        action,
        "flag_warning",
        baseReason || `front import: refusing to create authoritative ${entityKind}${label}`,
      );

    case "semrush_inventory":
    case "local_dominance_sync":
      if (entityKind === "location_mapping") {
        // Task #920A: A `location_mapping` (semrush_location_campaigns) row is
        // a *link* between two already-authoritative entities — a configured
        // `client_locations` row and a SEMrush campaign. When the parent
        // location is configured (`entityExists === true`) the import surface
        // is allowed to create the link row directly; this is not the same as
        // creating a new authoritative entity. When the parent location is
        // NOT configured, the candidate is routed to the review queue so an
        // operator can configure the location first.
        if (context.entityExists) {
          return mk(
            surface,
            entityKind,
            action,
            "allow_link_existing",
            baseReason || `semrush sync: linking configured location to campaign${label}`,
          );
        }
        return mk(
          surface,
          entityKind,
          action,
          "allow_review_suggestion",
          baseReason || `semrush sync: candidate location mapping${label} routed to review suggestions (parent location not configured)`,
        );
      }
      return mk(
        surface,
        entityKind,
        action,
        "flag_warning",
        baseReason || `semrush sync: refusing to create authoritative ${entityKind}${label}`,
      );

    case "pdf_import":
      if (entityKind === "product" || entityKind === "category") {
        return mk(
          surface,
          entityKind,
          action,
          "drop_unknown",
          baseReason || `pdf import: dropping unknown ${entityKind}${label}`,
        );
      }
      return mk(
        surface,
        entityKind,
        action,
        "flag_warning",
        baseReason || `pdf import: refusing to create authoritative ${entityKind}${label}`,
      );

    default:
      return mk(
        surface,
        entityKind,
        action,
        "reject_write",
        baseReason || `unknown import surface '${surface}' attempting to create ${entityKind}${label}`,
      );
  }
}

function mk(
  surface: ImportSurface,
  entityKind: ImportEntityKind,
  action: ImportWriteAction,
  decision: ImportWriteDecision,
  reason: string,
): ImportWriteOutcome {
  const blocked = decisionBlocks(decision);
  return {
    decision,
    surface,
    entityKind,
    action,
    reason,
    blocked,
    warning: decision === "flag_warning" ? `[ImportWritePolicy] ${reason}` : undefined,
  };
}

/**
 * Convenience guard for surfaces that just need a hard yes/no on whether they
 * may perform an authoritative write. Returns `true` when the policy
 * explicitly allows the write to proceed (update-existing, link-existing, or
 * raw-ingest). Callers that need to distinguish *which* allowed outcome was
 * returned (e.g. to choose between an UPDATE and an INSERT) should branch on
 * `outcome.decision` directly rather than relying on this helper.
 */
export function canImportWrite(outcome: ImportWriteOutcome): boolean {
  return outcome.decision === "allow_update_existing"
      || outcome.decision === "allow_link_existing"
      || outcome.decision === "allow_raw_ingest_create";
}

/**
 * Task #3772 — "absent stays absent" on import section writes.
 *
 * The PDF parser defaults every numeric metric to 0 and records a
 * `fieldConfidence["<section>.<field>"]` entry only when a label actually
 * matched. An import surface that writes an intake/sales section wholesale
 * (the `system:pdf-webhook` route) MUST therefore write a `noDataFlags`
 * object alongside the values: every entry-tracked numeric metric the parser
 * did NOT find is flagged No-Data so the public report renders "No Data"
 * instead of a fabricated healthy-looking "0". Parsed metrics (including a
 * genuinely parsed 0) stay unflagged — an unflagged 0 in an entry-tracked
 * section deliberately means "entered 0" (`shared/reportMetrics.ts`).
 *
 * The returned object's key set exactly matches the report form's
 * `noDataFlags` state for the section, so the form loads, edits, and saves
 * the flags an import wrote without any translation.
 */
export function buildImportedSectionNoDataFlags(
  fieldConfidence: ImportFieldConfidenceMap,
  sectionKey: EntryTrackedImportSection,
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const field of ENTRY_TRACKED_IMPORT_METRICS[sectionKey]) {
    flags[field] = !importMetricWasParsed(fieldConfidence, sectionKey, field);
  }
  return flags;
}
