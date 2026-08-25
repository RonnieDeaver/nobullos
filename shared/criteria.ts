/**
 * Task #4329 — shared criteria evaluator.
 *
 * ONE deterministic, property-based predicate engine powering rule tags and
 * segments today, and (deliberately) deal/lead scoring later. Pure module:
 * no DB, no IO, no Date.now() — evaluation depends only on (criteria,
 * record), so the sweep, the on-write path, and any UI preview all agree.
 *
 * Shape: a CriteriaSet is groups of conditions —
 *   set.combinator ("and"|"or") over groups; group.combinator over its
 *   conditions. Two levels is exactly what HubSpot-style "match ALL of /
 *   match ANY of" builders need; deeper nesting is a deliberate non-goal.
 *
 * Fields come from a closed per-entity registry (criteriaFieldRegistry).
 * Records are plain snake_case-keyed objects produced by the server's
 * extraction helpers (server/services/tagSegmentEngine.ts). Unknown fields
 * or operator/type mismatches are REJECTED at validation time
 * (validateCriteriaSet); at evaluation time they conservatively evaluate
 * false rather than throwing (total function — bad stored data can never
 * take the sweep down).
 *
 * Determinism rules:
 *   - string comparisons are case-insensitive (trimmed)
 *   - missing/null values fail every operator except is_not_set
 *   - date operands are ISO strings (YYYY-MM-DD accepted) compared by
 *     epoch; unparseable dates evaluate false
 *   - number operands must be finite; NaN comparisons evaluate false
 */
import { z } from "zod";

// ── Entity types ─────────────────────────────────────────────────────────────

/** Entities tags may attach to. */
export const tagEntityTypes = ["deal", "client"] as const;
export type TagEntityType = (typeof tagEntityTypes)[number];

/** Entities segments may select over. */
export const segmentEntityTypes = ["client", "contact"] as const;
export type SegmentEntityType = (typeof segmentEntityTypes)[number];

/** Every entity the criteria engine knows how to describe. */
export const criteriaEntityTypes = ["deal", "client", "contact"] as const;
export type CriteriaEntityType = (typeof criteriaEntityTypes)[number];

// ── Field registry ───────────────────────────────────────────────────────────

export type CriteriaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "string_array";

export interface CriteriaFieldDef {
  /** snake_case record key — MUST match the server extraction helpers. */
  key: string;
  label: string;
  type: CriteriaFieldType;
}

/**
 * Closed per-entity field vocabulary. Extending it is a schema decision:
 * add the field here AND to the matching extraction helper in
 * server/services/tagSegmentEngine.ts together (they are asserted in
 * tests/tags-segments.test.ts).
 */
export const criteriaFieldRegistry: Record<
  CriteriaEntityType,
  readonly CriteriaFieldDef[]
> = {
  deal: [
    { key: "name", label: "Deal name", type: "string" },
    { key: "amount", label: "Amount", type: "number" },
    { key: "stage_name", label: "Stage name", type: "string" },
    { key: "expected_close_date", label: "Expected close date", type: "date" },
    { key: "lost_reason", label: "Lost reason", type: "string" },
    { key: "has_client", label: "Has linked client", type: "boolean" },
    { key: "is_archived", label: "Archived", type: "boolean" },
    { key: "created_at", label: "Created", type: "date" },
  ],
  client: [
    { key: "firm_name", label: "Firm name", type: "string" },
    { key: "contact_name", label: "Primary contact name", type: "string" },
    { key: "contact_email", label: "Primary contact email", type: "string" },
    { key: "consult_type", label: "Consult type", type: "string" },
    { key: "practice_areas", label: "Practice areas", type: "string_array" },
    { key: "products", label: "Products", type: "string_array" },
    { key: "average_case_value", label: "Average case value", type: "number" },
    { key: "monthly_review_target", label: "Monthly review target", type: "number" },
    { key: "is_demo", label: "Demo client", type: "boolean" },
    { key: "is_archived", label: "Archived", type: "boolean" },
    { key: "client_start_date", label: "Client start date", type: "date" },
    { key: "created_at", label: "Created", type: "date" },
  ],
  contact: [
    { key: "name", label: "Contact name", type: "string" },
    { key: "emails", label: "Emails", type: "string_array" },
    { key: "phones", label: "Phones", type: "string_array" },
    { key: "role_title", label: "Role / title", type: "string" },
    { key: "is_primary", label: "Primary contact", type: "boolean" },
    { key: "created_at", label: "Created", type: "date" },
  ],
};

// ── Operators ────────────────────────────────────────────────────────────────

export const criteriaOperators = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "is_true",
  "is_false",
  "includes",
  "not_includes",
  "is_set",
  "is_not_set",
] as const;
export type CriteriaOperator = (typeof criteriaOperators)[number];

/** Operators legal per field type (validation-time contract). */
export const operatorsByFieldType: Record<
  CriteriaFieldType,
  readonly CriteriaOperator[]
> = {
  string: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "is_set",
    "is_not_set",
  ],
  number: ["equals", "not_equals", "gt", "gte", "lt", "lte", "is_set", "is_not_set"],
  boolean: ["is_true", "is_false"],
  date: ["before", "after", "is_set", "is_not_set"],
  string_array: ["includes", "not_includes", "is_set", "is_not_set"],
};

/** Operators that take NO value operand. */
export const valuelessOperators: readonly CriteriaOperator[] = [
  "is_true",
  "is_false",
  "is_set",
  "is_not_set",
];

export const criteriaOperatorLabels: Record<CriteriaOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  before: "is before",
  after: "is after",
  is_true: "is true",
  is_false: "is false",
  includes: "includes",
  not_includes: "does not include",
  is_set: "is set",
  is_not_set: "is not set",
};

// ── Criteria shape ───────────────────────────────────────────────────────────

export const criteriaCombinators = ["and", "or"] as const;
export type CriteriaCombinator = (typeof criteriaCombinators)[number];

export interface CriteriaCondition {
  field: string;
  operator: CriteriaOperator;
  /** Omitted/null for valueless operators. */
  value?: string | number | null;
}

export interface CriteriaGroup {
  combinator: CriteriaCombinator;
  conditions: CriteriaCondition[];
}

export interface CriteriaSet {
  combinator: CriteriaCombinator;
  groups: CriteriaGroup[];
}

/** Bounds keep stored criteria (and sweep CPU) small by construction. */
export const CRITERIA_MAX_GROUPS = 5;
export const CRITERIA_MAX_CONDITIONS_PER_GROUP = 10;
export const CRITERIA_MAX_VALUE_LENGTH = 200;

/** Shape-only schema; pair with validateCriteriaSet for field/operator
 * semantics (needs the entity type). */
export const criteriaSetSchema = z.object({
  combinator: z.enum(criteriaCombinators),
  groups: z
    .array(
      z.object({
        combinator: z.enum(criteriaCombinators),
        conditions: z
          .array(
            z.object({
              field: z.string().min(1).max(80),
              operator: z.enum(criteriaOperators),
              value: z
                .union([
                  z.string().max(CRITERIA_MAX_VALUE_LENGTH),
                  z.number().finite(),
                ])
                .nullable()
                .optional(),
            }),
          )
          .min(1)
          .max(CRITERIA_MAX_CONDITIONS_PER_GROUP),
      }),
    )
    .min(1)
    .max(CRITERIA_MAX_GROUPS),
});

/**
 * Semantic validation against the entity's field registry. Returns a list
 * of human-readable problems; empty = valid. Routes 400 with these.
 */
export function validateCriteriaSet(
  entityType: CriteriaEntityType,
  set: CriteriaSet,
): string[] {
  const problems: string[] = [];
  const fields = new Map(criteriaFieldRegistry[entityType].map((f) => [f.key, f]));
  set.groups.forEach((group, gi) => {
    group.conditions.forEach((cond, ci) => {
      const where = `group ${gi + 1}, condition ${ci + 1}`;
      const field = fields.get(cond.field);
      if (!field) {
        problems.push(`${where}: unknown ${entityType} field "${cond.field}"`);
        return;
      }
      if (!operatorsByFieldType[field.type].includes(cond.operator)) {
        problems.push(
          `${where}: operator "${cond.operator}" is not valid for ${field.type} field "${cond.field}"`,
        );
        return;
      }
      const valueless = valuelessOperators.includes(cond.operator);
      const hasValue = cond.value !== undefined && cond.value !== null;
      if (valueless && hasValue) {
        problems.push(`${where}: operator "${cond.operator}" takes no value`);
        return;
      }
      if (!valueless && !hasValue) {
        problems.push(`${where}: operator "${cond.operator}" requires a value`);
        return;
      }
      if (!valueless) {
        if (field.type === "number" && typeof cond.value !== "number") {
          problems.push(`${where}: field "${cond.field}" needs a numeric value`);
        }
        if (
          (field.type === "string" || field.type === "string_array") &&
          typeof cond.value !== "string"
        ) {
          problems.push(`${where}: field "${cond.field}" needs a string value`);
        }
        if (field.type === "date") {
          if (typeof cond.value !== "string" || !isParseableDate(cond.value)) {
            problems.push(
              `${where}: field "${cond.field}" needs an ISO date value (YYYY-MM-DD)`,
            );
          }
        }
      }
    });
  });
  return problems;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Values the extraction helpers may put on a record. */
export type CriteriaRecordValue =
  | string
  | number
  | boolean
  | Date
  | string[]
  | null
  | undefined;
export type CriteriaRecord = Record<string, CriteriaRecordValue>;

function isParseableDate(v: string): boolean {
  return Number.isFinite(new Date(v).getTime());
}

function toEpoch(v: CriteriaRecordValue): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function norm(v: string): string {
  return v.trim().toLowerCase();
}

function isUnset(v: CriteriaRecordValue): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Total, deterministic single-condition evaluation (never throws). */
export function evaluateCondition(
  cond: CriteriaCondition,
  record: CriteriaRecord,
): boolean {
  const raw = record[cond.field];
  switch (cond.operator) {
    case "is_set":
      return !isUnset(raw);
    case "is_not_set":
      return isUnset(raw);
    case "is_true":
      return raw === true;
    case "is_false":
      return raw === false;
    default:
      break;
  }
  if (isUnset(raw)) return false;
  const value = cond.value;

  switch (cond.operator) {
    case "equals":
    case "not_equals": {
      let match: boolean;
      if (typeof value === "number") {
        const n =
          typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
        match = Number.isFinite(n) && n === value;
      } else if (typeof value === "string") {
        match = typeof raw === "string" && norm(raw) === norm(value);
      } else {
        return false;
      }
      return cond.operator === "equals" ? match : !match;
    }
    case "contains":
    case "not_contains": {
      if (typeof value !== "string" || typeof raw !== "string") return false;
      const match = norm(raw).includes(norm(value));
      return cond.operator === "contains" ? match : !match;
    }
    case "starts_with":
      return (
        typeof value === "string" &&
        typeof raw === "string" &&
        norm(raw).startsWith(norm(value))
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof value !== "number") return false;
      const n =
        typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return false;
      if (cond.operator === "gt") return n > value;
      if (cond.operator === "gte") return n >= value;
      if (cond.operator === "lt") return n < value;
      return n <= value;
    }
    case "before":
    case "after": {
      if (typeof value !== "string") return false;
      const recordT = toEpoch(raw);
      const valueT = toEpoch(value);
      if (recordT === null || valueT === null) return false;
      return cond.operator === "before" ? recordT < valueT : recordT > valueT;
    }
    case "includes":
    case "not_includes": {
      if (typeof value !== "string" || !Array.isArray(raw)) return false;
      const needle = norm(value);
      const match = raw.some((el) => typeof el === "string" && norm(el) === needle);
      return cond.operator === "includes" ? match : !match;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a full criteria set against one record. Empty groups/sets are
 * rejected by the schema; defensively, an empty set matches nothing.
 */
export function evaluateCriteriaSet(
  set: CriteriaSet,
  record: CriteriaRecord,
): boolean {
  if (!set || !Array.isArray(set.groups) || set.groups.length === 0) return false;
  const groupResults = set.groups.map((group) => {
    if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
      return false;
    }
    return group.combinator === "or"
      ? group.conditions.some((c) => evaluateCondition(c, record))
      : group.conditions.every((c) => evaluateCondition(c, record));
  });
  return set.combinator === "or"
    ? groupResults.some(Boolean)
    : groupResults.every(Boolean);
}
