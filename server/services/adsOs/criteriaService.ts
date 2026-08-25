/**
 * Ads OS — per-client criteria (port of backend/app/keyword_intel/criteria.py
 * + the geo-derivation queries from keyword_intel/queries.py).
 *
 * The team edits criteria in the app (spec §6.11); this module is the
 * read/write layer over the `ads_os_clients_criteria` store plus the logic
 * that pre-fills sensible defaults (business name from the account, service
 * area from the campaigns' geo targeting) so downstream consumers work even
 * before anyone has saved anything.
 *
 * Phase 2 consumer: budget pacing (schedule_days drives the schedule-aware
 * GAds math; lsa_schedule_days drives the LSA math). The analyzer/keyword
 * tools consume the rest in a later phase.
 */

import { getCriteria, putCriteria } from "./store";
import { adsOsGaqlSearch } from "./googleAdsClient";
import {
  ClickUpHttpError,
  directoryHealth,
  getClientDirectory,
  replacePracticeAreasForCid,
} from "./clickUpDirectory";
import { ClickUpPracticeAreaContractError } from "./clickUpPracticeAreaContract";

// ---------------------------------------------------------------------------
// Types (port of ClientCriteria / DerivedDefaults pydantic models)
// ---------------------------------------------------------------------------

export interface ClientCriteria {
  business_name: string; // protected; also the brand context
  website: string;
  practice_areas: string[]; // selected from the fixed list (intent signal)
  service_area: string; // cities/neighborhoods/counties/states served — geo-protected
  services_offered: string; // practice areas / services — protected words
  services_not_offered: string; // things to negate when they show up (NOT protected)
  competitors: string; // known competitor names — hints for the model
  extra_protected_terms: string; // any extra words to never negate
  notes: string; // freeform extra context for the model
  // Budget pacing (central criteria): weekdays ads run, e.g. ["Mon","Tue",...].
  // schedule_days is the GOOGLE ADS schedule — the name predates the LSA split
  // and stays as-is so saved JSONB docs remain valid. lsa_schedule_days is the
  // LSA schedule; old docs load with it empty, meaning every day (LSA's
  // original pace-over-all-days behavior).
  // Budgets themselves are NOT stored here — the budget source seam is the
  // single source of truth (the bundle removed per-account overrides 2026-07;
  // stored docs may still carry them and we ignore the extra keys on load).
  schedule_days: string[];
  lsa_schedule_days: string[];
}

export interface DerivedDefaults {
  business_name: string; // account descriptive name
  service_area: string; // joined geo-targeting location names
}

export interface CriteriaLoadResult {
  criteria: ClientCriteria;
  /** Strictly persisted document before the ClickUp effective-read overlay.
   * Kept server-side; route responses explicitly select public fields. */
  persistedCriteria: ClientCriteria;
  hasSaved: boolean;
  updatedAt: string | null;
  practiceAreaOptions: string[];
  practiceAreaSyncAvailable: boolean;
  practiceAreaSyncReason: string | null;
}

interface PracticeAreaProjection {
  options: string[];
  selection: string[];
  hasProjection: boolean;
  available: boolean;
  reason: string | null;
}

function projectPracticeAreas(
  directory: Awaited<ReturnType<typeof getClientDirectory>>,
  cid: string,
): PracticeAreaProjection {
  const options = directory.practiceAreaOptions.map((option) => option.label);
  const parentTaskIds = directory.cidParentTaskIds[cid] ?? [];
  const hasProjectedSelection = Object.prototype.hasOwnProperty.call(
    directory.cidPracticeAreas,
    cid,
  );
  const hasContract =
    directory.practiceAreaField !== null && options.length > 0;
  const hasProjection =
    hasContract && hasProjectedSelection && parentTaskIds.length === 1;
  const health = directoryHealth();
  const available = hasProjection && health.live;

  let reason: string | null = null;
  if (!health.live) {
    reason =
      health.reason ??
      "ClickUp practice areas are unavailable until the client directory loads successfully.";
  } else if (!hasContract) {
    reason =
      "ClickUp practice areas are unavailable until the client directory loads successfully.";
  } else if (parentTaskIds.length > 1) {
    reason =
      "This account maps to multiple ClickUp parent clients. Practice areas cannot be edited until the duplicate mapping is fixed.";
  } else if (!hasProjectedSelection || parentTaskIds.length === 0) {
    reason =
      "This account is not mapped to a live parent client in ClickUp. Practice areas cannot be edited here.";
  }

  return {
    options,
    selection: hasProjection ? [...directory.cidPracticeAreas[cid]] : [],
    hasProjection,
    available,
    reason,
  };
}

export class CriteriaRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** True when ClickUp committed a new authoritative selection even though
     * the strict local mirror failed. The route must invalidate every
     * criteria-dependent cache before returning this error. */
    public readonly criteriaAuthorityChanged = false,
  ) {
    super(message);
    this.name = "CriteriaRequestError";
  }
}

export function emptyCriteria(): ClientCriteria {
  return {
    business_name: "",
    website: "",
    practice_areas: [],
    service_area: "",
    services_offered: "",
    services_not_offered: "",
    competitors: "",
    extra_protected_terms: "",
    notes: "",
    schedule_days: [],
    lsa_schedule_days: [],
  };
}

const STRING_FIELDS = [
  "business_name",
  "website",
  "service_area",
  "services_offered",
  "services_not_offered",
  "competitors",
  "extra_protected_terms",
  "notes",
] as const;

const LIST_FIELDS = ["practice_areas", "schedule_days", "lsa_schedule_days"] as const;

/** Stored doc -> ClientCriteria, dropping unknown/legacy keys (pydantic-style). */
export function toCriteria(stored: Record<string, any> | null | undefined): ClientCriteria {
  const out = emptyCriteria();
  if (!stored) return out;
  for (const f of STRING_FIELDS) {
    const v = stored[f];
    if (typeof v === "string") out[f] = v;
  }
  for (const f of LIST_FIELDS) {
    const v = stored[f];
    if (Array.isArray(v)) out[f] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

const UPDATED_AT = "updated_at"; // store metadata key (matches bundle _UPDATED_AT)

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function normCid(customerId: string): string {
  return customerId.replace(/[^0-9]/g, "");
}

export async function loadCriteria(
  customerId: string,
): Promise<CriteriaLoadResult> {
  const cid = normCid(customerId);
  const stored = await getCriteria(cid);
  let updatedAt: string | null = null;
  if (stored && typeof stored[UPDATED_AT] === "string") {
    // Keep as ISO string (the API serializes it straight out).
    const t = Date.parse(stored[UPDATED_AT]);
    updatedAt = Number.isFinite(t) ? stored[UPDATED_AT] : null;
  }
  const persistedCriteria = toCriteria(stored);
  const criteria = {
    ...persistedCriteria,
    practice_areas: [...persistedCriteria.practice_areas],
  };
  const directory = await getClientDirectory();
  const projection = projectPracticeAreas(directory, cid);

  // ClickUp is the effective read authority whenever one unambiguous parent
  // projection is available. This overlay is central so every existing
  // consumer (analyzer, Pyramid, alerts, dashboards and pacing) sees the same
  // value without adding integration logic of its own.
  if (projection.hasProjection) {
    criteria.practice_areas = projection.selection;
  }

  return {
    criteria,
    persistedCriteria,
    hasSaved: !!stored,
    updatedAt,
    practiceAreaOptions: projection.options,
    practiceAreaSyncAvailable: projection.available,
    practiceAreaSyncReason: projection.reason,
  };
}

/** Save criteria; returns the new updated_at ISO string. */
export async function saveCriteria(customerId: string, criteria: ClientCriteria): Promise<string> {
  const cid = normCid(customerId);
  const updatedAt = new Date().toISOString();
  await putCriteria(cid, { ...criteria, [UPDATED_AT]: updatedAt });
  return updatedAt;
}

function sameLabels(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((label, index) => label === right[index])
  );
}

function canonicalizePracticeAreas(
  requested: unknown,
  options: string[],
): string[] {
  if (
    !Array.isArray(requested) ||
    requested.some((label) => typeof label !== "string")
  ) {
    throw new CriteriaRequestError(
      "Practice areas must be an array of ClickUp option labels.",
      400,
    );
  }
  const requestedSet = new Set(requested);
  const unknown = [...requestedSet].filter((label) => !options.includes(label));
  if (unknown.length) {
    throw new CriteriaRequestError(
      `Unknown ClickUp practice-area option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Reload criteria and choose from the current list.`,
      400,
    );
  }
  return options.filter((label) => requestedSet.has(label));
}

function practiceAreaWriteFailure(err: unknown): CriteriaRequestError {
  const detail = err instanceof Error ? err.message : String(err);
  if (/Unknown canonical Practice Area label/i.test(detail)) {
    return new CriteriaRequestError(
      "ClickUp practice-area options changed while this form was open. Reload criteria and choose from the current list.",
      409,
    );
  }
  if (
    err instanceof ClickUpPracticeAreaContractError ||
    (err instanceof ClickUpHttpError &&
      (err.status === 429 || err.status >= 500))
  ) {
    return new CriteriaRequestError(
      `ClickUp practice areas are temporarily unavailable. No Ads OS criteria were changed. ${detail} Retry Save after ClickUp recovers.`,
      503,
    );
  }
  return new CriteriaRequestError(
    `ClickUp did not accept the practice-area update. No Ads OS criteria were changed. ${detail} Reload criteria or retry Save.`,
    502,
  );
}

export interface CriteriaSaveResult {
  updatedAt: string;
  before: ClientCriteria;
  criteria: ClientCriteria;
}

/**
 * Save the complete criteria document while preserving ClickUp as the Practice
 * Area authority. A changed selection is validated and replaced in ClickUp
 * first; only the canonical labels returned by that operation reach the local
 * document. Unchanged selections never make unrelated edits depend on ClickUp.
 */
export async function saveCriteriaWithPracticeAreaSync(
  customerId: string,
  submitted: ClientCriteria,
  expectedPracticeAreas?: readonly string[],
): Promise<CriteriaSaveResult> {
  const cid = normCid(customerId);
  const loaded = await loadCriteria(cid);
  let criteria = { ...submitted, practice_areas: [...submitted.practice_areas] };
  let criteriaAuthorityChanged = false;
  const expected = expectedPracticeAreas
    ? [...expectedPracticeAreas]
    : [...loaded.criteria.practice_areas];
  const submittedMatchesExpected = sameLabels(
    submitted.practice_areas,
    expected,
  );

  // A save always reconciles with a fresh vendor snapshot. The cached load
  // above represents what the editor most likely saw; it is not sufficient to
  // prove that ClickUp stayed unchanged while the form was open.
  const freshDirectory = await getClientDirectory({ force: true });
  const fresh = projectPracticeAreas(freshDirectory, cid);
  criteriaAuthorityChanged =
    fresh.hasProjection &&
    !sameLabels(fresh.selection, loaded.persistedCriteria.practice_areas);

  if (fresh.available) {
    if (submittedMatchesExpected) {
      // Unrelated edit: never write the form's potentially stale selection
      // back over a newer ClickUp value.
      criteria.practice_areas = fresh.selection;
    } else {
      const canonical = canonicalizePracticeAreas(
        submitted.practice_areas,
        fresh.options,
      );
      if (sameLabels(canonical, fresh.selection)) {
        // Idempotent retry after ClickUp succeeded but the strict local save
        // failed, or another actor already applied this exact selection.
        criteria.practice_areas = fresh.selection;
      } else if (!sameLabels(expected, fresh.selection)) {
        throw new CriteriaRequestError(
          "Practice areas changed in ClickUp while this form was open. No criteria were saved. Reload criteria, review the current selection, and try again.",
          409,
        );
      } else {
        try {
          const replaced = await replacePracticeAreasForCid(cid, canonical);
          criteria.practice_areas = [...replaced.labels];
          criteriaAuthorityChanged =
            criteriaAuthorityChanged || replaced.changed;
        } catch (err) {
          throw practiceAreaWriteFailure(err);
        }
      }
    }
  } else {
    if (!submittedMatchesExpected) {
      throw new CriteriaRequestError(
        `${fresh.reason ?? "ClickUp practice areas are unavailable."} The practice-area selection was not changed; reload criteria after ClickUp recovers. You can still save unrelated fields if this selection stays unchanged.`,
        503,
      );
    }
    criteria.practice_areas = fresh.hasProjection
      ? fresh.selection
      : [...loaded.persistedCriteria.practice_areas];
  }

  try {
    const updatedAt = await saveCriteria(cid, criteria);
    return { updatedAt, before: loaded.criteria, criteria };
  } catch {
    if (criteriaAuthorityChanged) {
      throw new CriteriaRequestError(
        "ClickUp was updated, but Ads OS could not finish saving the criteria document. Keep this form open and retry Save; the ClickUp update is idempotent and will not be duplicated.",
        503,
        true,
      );
    }
    throw new CriteriaRequestError(
      "Ads OS could not save the criteria document. Keep this form open and retry Save.",
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Derived defaults (account name + geo targeting)
// ---------------------------------------------------------------------------

export function deriveDefaults(accountName: string, geoLocationNames: string[]): DerivedDefaults {
  return {
    business_name: accountName || "",
    service_area: geoLocationNames.join(", "),
  };
}

/**
 * Criteria to actually run with: saved values win; empty fields fall back to
 * the auto-derived defaults so consumers are useful out of the box.
 */
export function effectiveCriteria(stored: ClientCriteria, derived: DerivedDefaults): ClientCriteria {
  const merged = { ...stored };
  if (!merged.business_name.trim()) merged.business_name = derived.business_name;
  if (!merged.service_area.trim()) merged.service_area = derived.service_area;
  return merged;
}

/**
 * Just the service-area location names — used to pre-fill the criteria form.
 * Two small queries, isolated so a partial-access account simply yields an
 * empty list (best-effort, mirrors the bundle). Read-only.
 */
export async function fetchGeoLocationNames(customerId: string): Promise<string[]> {
  const cid = normCid(customerId);
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      `SELECT campaign_criterion.location.geo_target_constant FROM campaign_criterion
       WHERE campaign_criterion.type = 'LOCATION'
         AND campaign_criterion.negative = FALSE
         AND campaign_criterion.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`,
    );
    const geoIds: string[] = [];
    for (const row of rows) {
      const res: string | undefined = row.campaignCriterion?.location?.geoTargetConstant;
      if (res && res.includes("/")) geoIds.push(res.slice(res.lastIndexOf("/") + 1));
    }
    if (geoIds.length === 0) return [];
    return await resolveGeoNames(cid, [...new Set(geoIds)].sort());
  } catch {
    return []; // best-effort: geo derivation must never sink the criteria form
  }
}

/** Look up human names for geo_target_constant ids (best-effort). */
async function resolveGeoNames(cid: string, geoIds: string[]): Promise<string[]> {
  const inClause = geoIds.map((gid) => `'${gid.replace(/[^0-9]/g, "")}'`).join(", ");
  const names: string[] = [];
  const seen = new Set<string>();
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      `SELECT geo_target_constant.name, geo_target_constant.target_type
       FROM geo_target_constant WHERE geo_target_constant.id IN (${inClause})`,
    );
    for (const row of rows) {
      const name: string | undefined = row.geoTargetConstant?.name;
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  } catch {
    return [];
  }
  return names;
}
