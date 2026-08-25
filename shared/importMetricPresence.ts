/**
 * Task #3772 — single source of truth for "did the PDF parser actually FIND a
 * numeric intake/sales metric?".
 *
 * The parser (`server/services/pdfImportParser.ts`) defaults every numeric
 * field to 0 and records a `fieldConfidence["<section>.<field>"]` entry ONLY
 * when a label actually matched in the extracted text. Key PRESENCE — never
 * the 0 value itself — is therefore the parse-evidence contract. Before this
 * module existed, both import write paths and the import review dialog read
 * the bare 0 and stamped/showed it as if an operator had entered a real zero,
 * which is how "Time to Human Answer" PDFs produced fabricated
 * "0s · Healthy" intake cards instead of "No Data".
 *
 * Consumers:
 *  - `server/services/importWritePolicy.ts` → `buildImportedSectionNoDataFlags`
 *    (webhook import section writes flag unparsed metrics as No-Data).
 *  - `client/src/pages/ReportForm.tsx` → import review dialog ("not found"
 *    state, default-unchecked) and apply-time No-Data flagging.
 *
 * Deliberately NOT changed here: `shared/reportMetrics.ts` display presence
 * rules — an unflagged 0 in an entry-tracked section still means "operator
 * entered 0". The fix is that import surfaces stop fabricating such zeros.
 *
 * Marketing (Task #3858): the marketing rows are COMPOSITE objects
 * (googleAds/lsa/webinar/...) with no per-metric noDataFlags state, so they
 * get their own key set (`COMPOSITE_IMPORT_METRIC_KEYS`) with composite
 * semantics: evidence = a fieldConfidence entry for the key itself OR any
 * dotted descendant (the parser records e.g. `marketing.lsa.uniqueLeads`),
 * and value = any non-zero numeric leaf anywhere in the object. Without this,
 * an all-zero parser-defaulted composite counted as "has value" (its nested
 * leadQuality object is truthy) and was PRE-CHECKED in the review dialog —
 * defaulting first uploads into stamping fabricated $0 spend / 0-lead
 * marketing figures.
 */

/**
 * The numeric intake/sales metrics that are entry-tracked on the report form,
 * keyed by section. These lists MUST match the form's `noDataFlags` state
 * shape in `client/src/pages/ReportForm.tsx` (intake: 3 keys, sales: 8 keys)
 * — the flags object an import writes is the same object the form loads,
 * edits, and saves back.
 */
export const ENTRY_TRACKED_IMPORT_METRICS = {
  intake: ["totalConsults", "avgTimeToAnswer", "qualityScore"],
  sales: [
    "totalCases",
    "averageCaseValue",
    "noShowRate",
    "avgFollowUps",
    "qualityScore",
    "dealTouchDensity",
    "avgAgeOpenMatters",
    "pipelineMomentumScore",
  ],
} as const;

export type EntryTrackedImportSection = keyof typeof ENTRY_TRACKED_IMPORT_METRICS;

/** Shape of the parser's per-field confidence map (loosely typed on purpose). */
export type ImportFieldConfidenceMap = Record<string, unknown> | null | undefined;

/**
 * True when the parser recorded evidence for `<sectionKey>.<field>` — i.e. a
 * label for the metric actually matched in the PDF text. A missing map (older
 * logs, stubbed parses) means NO field has parse evidence.
 */
export function importMetricWasParsed(
  fieldConfidence: ImportFieldConfidenceMap,
  sectionKey: EntryTrackedImportSection,
  field: string,
): boolean {
  return !!fieldConfidence
    && Object.prototype.hasOwnProperty.call(fieldConfidence, `${sectionKey}.${field}`);
}

/**
 * All dotted parsed-payload keys the import review dialog must treat as
 * "numeric metric" rows: the entry-tracked fields above plus the two numeric
 * metrics without a No-Data flag (`intake.missedCallRate` is derived from
 * lead evidence at display time; `sales.revenue` only feeds averageCaseValue).
 * Honesty about "not found" matters for those too, even though no flag exists.
 */
export const NUMERIC_IMPORT_METRIC_KEYS: ReadonlySet<string> = new Set([
  ...Object.entries(ENTRY_TRACKED_IMPORT_METRICS).flatMap(([sectionKey, fields]) =>
    fields.map((field) => `${sectionKey}.${field}`),
  ),
  "intake.missedCallRate",
  "sales.revenue",
]);

/**
 * Task #3858 — the COMPOSITE marketing rows of the import review dialog.
 * These are objects, not scalars, so `importMetricNotFound` applies composite
 * semantics to them: evidence may live on any dotted descendant key, and a
 * "real value" is any non-zero numeric leaf. `marketing.gbpLocations` is
 * deliberately excluded (array of name-bearing rows — a location with a real
 * name and zero counts is still real data), as is `marketing.totalLeads`
 * (reference-only row, always force-unchecked upstream).
 */
export const COMPOSITE_IMPORT_METRIC_KEYS: ReadonlySet<string> = new Set([
  "marketing.googleAds",
  "marketing.lsa",
  "marketing.googleAds.leadQuality",
  "marketing.lsa.leadQuality",
  "marketing.webinar",
  "marketing.reviewGeneration",
  "marketing.otherLeads",
]);

/**
 * Task #3868 — the scalar numeric sub-fields inside each gated composite,
 * for SUB-FIELD-grain evidence checks. Task #3858 gated whole composites,
 * but a partially-parsed composite (e.g. LSA uniqueLeads found via the
 * quality table while adSpend stayed a parser-defaulted 0) is evidence-
 * backed at the ROW grain and still shipped the fabricated $0 sub-value on
 * apply — overwriting a real saved spend. Consumers use
 * `importCompositeSubFieldNotFound` per sub-field to preserve the current
 * form value instead. `leadQuality` breakdowns are objects handled by their
 * own dotted rows, and `webinar.hotTransfers` may be sourced from
 * `webinar.leads` — callers pass both as evidence candidates.
 */
export const COMPOSITE_NUMERIC_SUBFIELDS: Readonly<Record<string, readonly string[]>> = {
  "marketing.googleAds": ["uniqueLeads", "adSpend"],
  "marketing.lsa": ["uniqueLeads", "adSpend"],
  "marketing.webinar": ["registrants", "attendees", "hotTransfers"],
};

/**
 * True when a numeric SUB-FIELD of a composite marketing row is a fabricated
 * zero: no fieldConfidence entry for `<compositeKey>.<subField>` AND the
 * parsed value at that path is 0/absent. Deliberately does NOT count a
 * confidence entry on the composite key itself as sub-field evidence — the
 * parser records the composite key for partial finds too (e.g. a leads-only
 * label), which is exactly the shape that fabricates the sibling $0. A real
 * non-zero parsed sub-value is always evidence enough (mirrors the reimport
 * merge, which preserves saved values into the payload without confidence
 * entries).
 */
export function importCompositeSubFieldNotFound(
  parsed: { fieldConfidence?: ImportFieldConfidenceMap } | null | undefined,
  compositeKey: string,
  subField: string,
): boolean {
  if (!parsed) return false;
  if (!COMPOSITE_IMPORT_METRIC_KEYS.has(compositeKey)) return false;
  const fc = parsed.fieldConfidence;
  if (fc && Object.prototype.hasOwnProperty.call(fc, `${compositeKey}.${subField}`)) {
    return false;
  }
  let value: unknown = parsed;
  for (const part of [...compositeKey.split("."), subField]) {
    if (value == null || typeof value !== "object") {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return !(typeof value === "number" && value !== 0);
}

/** Any non-zero numeric leaf anywhere inside the value? */
function anyNonZeroNumberDeep(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(anyNonZeroNumberDeep);
  }
  return false;
}

/**
 * True when a numeric metric in a parsed import payload is a FABRICATED zero:
 * no parse evidence for the key AND no real (non-zero) value at the path.
 * Composite marketing keys (see COMPOSITE_IMPORT_METRIC_KEYS) use the same
 * contract with descendant-evidence and deep-value semantics.
 *
 * The value check matters on the reimport path: the server merge preserves
 * existing report values (e.g. totalConsults) into the parsed payload without
 * adding confidence entries — a non-zero merged value is real data, not a
 * fabrication, so it still renders as a normal row. Only evidence-less zeros
 * are hidden behind the "not found" state.
 *
 * Non-numeric-metric keys always return false — this predicate never affects
 * text/object fields (commonIssues, lead quality breakdowns, GBP rows, ...).
 */
export function importMetricNotFound(
  parsed: { fieldConfidence?: ImportFieldConfidenceMap } | null | undefined,
  dottedKey: string,
): boolean {
  if (!parsed) return false;
  const isComposite = COMPOSITE_IMPORT_METRIC_KEYS.has(dottedKey);
  if (!isComposite && !NUMERIC_IMPORT_METRIC_KEYS.has(dottedKey)) return false;
  const fc = parsed.fieldConfidence;
  if (fc) {
    if (Object.prototype.hasOwnProperty.call(fc, dottedKey)) return false;
    if (isComposite) {
      const prefix = `${dottedKey}.`;
      for (const key of Object.keys(fc)) {
        if (key.startsWith(prefix)) return false;
      }
    }
  }
  let value: unknown = parsed;
  for (const part of dottedKey.split(".")) {
    if (value == null || typeof value !== "object") {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[part];
  }
  if (isComposite) return !anyNonZeroNumberDeep(value);
  return !(typeof value === "number" && value !== 0);
}
