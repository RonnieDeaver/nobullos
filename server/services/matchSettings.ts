import { storage } from "../storage";
import { PERF } from "../perfConfig";
import {
  agentMatchSettingKeys,
  agentMatchSettingSources,
  type AgentMatchSettingKey,
  type AgentMatchSettingSource,
} from "@shared/schema";
type Bounds = { min: number; max: number };

type SettingDescriptor = {
  key: AgentMatchSettingKey;
  label: string;
  envName: string;
  codeDefault: number;
  bounds: Bounds;
  description: string;
};

export const MATCH_SETTING_DESCRIPTORS: Record<AgentMatchSettingKey, SettingDescriptor> = {
  AGENT_CONFIDENCE_THRESHOLD: {
    key: "AGENT_CONFIDENCE_THRESHOLD",
    label: "Confidence Threshold (flat)",
    envName: "AGENT_CONFIDENCE_THRESHOLD",
    codeDefault: 0.78,
    bounds: { min: 0.5, max: 1.0 },
    description: "Default minimum score for an auto-claim when evidence-aware thresholds aren't applied.",
  },
  AGENT_AMBIGUITY_GAP: {
    key: "AGENT_AMBIGUITY_GAP",
    label: "Ambiguity Gap",
    envName: "AGENT_AMBIGUITY_GAP",
    codeDefault: 0.08,
    bounds: { min: 0.0, max: 0.5 },
    description: "Required score gap between top and second candidate to auto-claim.",
  },
  AGENT_THRESHOLD_EXACT: {
    key: "AGENT_THRESHOLD_EXACT",
    label: "Evidence Threshold — Exact Deterministic",
    envName: "AGENT_THRESHOLD_EXACT",
    codeDefault: 0.78,
    bounds: { min: 0.5, max: 1.0 },
    description: "Threshold for exact identifier matches (verified email/phone/slack channel).",
  },
  AGENT_THRESHOLD_DOMAIN: {
    key: "AGENT_THRESHOLD_DOMAIN",
    label: "Evidence Threshold — Unique Domain",
    envName: "AGENT_THRESHOLD_DOMAIN",
    codeDefault: 0.78,
    bounds: { min: 0.5, max: 1.0 },
    description: "Threshold when a unique-to-client domain is the dominant signal.",
  },
  AGENT_THRESHOLD_HEURISTIC: {
    key: "AGENT_THRESHOLD_HEURISTIC",
    label: "Evidence Threshold — Strong Heuristic",
    envName: "AGENT_THRESHOLD_HEURISTIC",
    codeDefault: 0.85,
    bounds: { min: 0.5, max: 1.0 },
    description: "Threshold for strong heuristic-only matches (no exact identifiers).",
  },
  AGENT_THRESHOLD_SEMANTIC: {
    key: "AGENT_THRESHOLD_SEMANTIC",
    label: "Evidence Threshold — Semantic Dominant",
    envName: "AGENT_THRESHOLD_SEMANTIC",
    codeDefault: 0.90,
    bounds: { min: 0.5, max: 1.0 },
    description: "Threshold when semantic reasoning dominates the evidence.",
  },
  AGENT_THRESHOLD_MIXED: {
    key: "AGENT_THRESHOLD_MIXED",
    label: "Evidence Threshold — Mixed",
    envName: "AGENT_THRESHOLD_MIXED",
    codeDefault: 0.82,
    bounds: { min: 0.5, max: 1.0 },
    description: "Threshold for mixed structured + semantic evidence.",
  },
  AGENT_REVIEW_FLOOR: {
    key: "AGENT_REVIEW_FLOOR",
    label: "Review Floor",
    envName: "AGENT_REVIEW_FLOOR",
    codeDefault: 1.0,
    bounds: { min: 0.0, max: 1.0 },
    description:
      "Lower bound for surfacing a candidate to the manual review queue. Top candidates scoring at or above the floor but below the auto-claim threshold are routed to review_required. Defaults to 1.0 (off); lower it via env or persisted setting to opt in.",
  },
  ZOOM_TRANSCRIPT_CONTEXT_BUDGET: {
    key: "ZOOM_TRANSCRIPT_CONTEXT_BUDGET",
    label: "Zoom Transcript Context Budget (chars)",
    envName: "ZOOM_TRANSCRIPT_CONTEXT_BUDGET",
    codeDefault: 5000,
    bounds: { min: 1500, max: 12000 },
    description:
      "Max characters of Zoom transcript context fed to the comparative semantic evaluator (assembled from opening, intros, keyword neighborhoods, and closing).",
  },
  ZOOM_SHORTLIST_MAX: {
    key: "ZOOM_SHORTLIST_MAX",
    label: "Zoom Shortlist Max Candidates",
    envName: "ZOOM_SHORTLIST_MAX",
    codeDefault: 8,
    bounds: { min: 2, max: 12 },
    description:
      "Max number of candidate clients passed to the Zoom comparative semantic evaluator (sorted by structured score).",
  },
  ZOOM_STRONG_SIGNAL_MIN_WEIGHT: {
    key: "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
    label: "Zoom Guardrail — Strong Signal Min Weight",
    envName: "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
    codeDefault: 0.5,
    bounds: { min: 0.0, max: 1.0 },
    description:
      "Minimum weight a unique-identifier signal (email/phone/slack/domain/client_code) must have to count as a 'strong' signal. Lowering accepts more matches; raising routes more to review.",
  },
  ZOOM_SHORT_TOKEN_MAX_LEN: {
    key: "ZOOM_SHORT_TOKEN_MAX_LEN",
    label: "Zoom Guardrail — Short Contact-Name Token Length",
    envName: "ZOOM_SHORT_TOKEN_MAX_LEN",
    codeDefault: 3,
    bounds: { min: 1, max: 6 },
    description:
      "Tokens this length or shorter are treated as weak contact-name tokens (e.g. 'Tim' at length 3). Used by Zoom contact-name-only routing.",
  },
};

export const MATCH_SETTING_KEYS: readonly AgentMatchSettingKey[] = agentMatchSettingKeys;
export const MATCH_SETTING_SOURCES: readonly AgentMatchSettingSource[] = agentMatchSettingSources;

export type ResolutionSourceOfTruth = "persisted" | "env" | "default";

export type ResolvedSetting = {
  key: AgentMatchSettingKey;
  scope: AgentMatchSettingSource;
  effectiveValue: number;
  sourceOfTruth: ResolutionSourceOfTruth;
  persistedValue: number | null;
  persistedScope: AgentMatchSettingSource | null;
  envValue: number | null;
  codeDefault: number;
  bounds: Bounds;
  label: string;
  description: string;
  envName: string;
};

type CacheEntry = { value: number };
type ScopedCache = Map<string /* key */, CacheEntry>;
type SettingsCache = Map<string /* source */, ScopedCache>;

let cache: SettingsCache | null = null;
let cacheLoading: Promise<void> | null = null;

export function isAgentMatchSettingKey(value: string): value is AgentMatchSettingKey {
  return (agentMatchSettingKeys as readonly string[]).includes(value);
}

export function isAgentMatchSettingSource(value: string): value is AgentMatchSettingSource {
  return (agentMatchSettingSources as readonly string[]).includes(value);
}

function readEnvValue(descriptor: SettingDescriptor): number | null {
  const raw = process.env[descriptor.envName];
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < descriptor.bounds.min || n > descriptor.bounds.max) return null;
  return n;
}

async function ensureCacheLoaded(): Promise<void> {
  if (cache) return;
  if (cacheLoading) {
    await cacheLoading;
    return;
  }
  cacheLoading = (async () => {
    const next: SettingsCache = new Map();
    try {
      const rows = await storage.listAgentMatchSettings();
      for (const row of rows) {
        if (!isAgentMatchSettingKey(row.settingKey)) continue;
        if (!isAgentMatchSettingSource(row.source)) continue;
        const scope = next.get(row.source) || new Map<string, CacheEntry>();
        scope.set(row.settingKey, { value: row.value });
        next.set(row.source, scope);
      }
      cache = next;
    } catch (err) {
      console.error("[matchSettings] Failed to load persisted settings; falling back to env/default.", err);
      cache = new Map();
    } finally {
      cacheLoading = null;
    }
  })();
  await cacheLoading;
}

function lookupPersisted(key: AgentMatchSettingKey, source: AgentMatchSettingSource): {
  value: number | null;
  scope: AgentMatchSettingSource | null;
} {
  if (!cache) return { value: null, scope: null };
  if (source !== "default") {
    const scoped = cache.get(source)?.get(key);
    if (scoped) return { value: scoped.value, scope: source };
  }
  const def = cache.get("default")?.get(key);
  if (def) return { value: def.value, scope: "default" };
  return { value: null, scope: null };
}

export function invalidateMatchSettingsCache(): void {
  cache = null;
}

/**
 * Synchronous resolver. Callers must have warmed the cache via `warmMatchSettings`
 * (called from server bootstrap) or `resolveMatchSettings`.
 */
export function resolveMatchSetting(
  key: AgentMatchSettingKey,
  source: AgentMatchSettingSource = "default",
): ResolvedSetting {
  const descriptor = MATCH_SETTING_DESCRIPTORS[key];
  const persisted = lookupPersisted(key, source);
  const envValue = readEnvValue(descriptor);

  let effectiveValue: number;
  let sourceOfTruth: ResolutionSourceOfTruth;

  if (persisted.value !== null) {
    effectiveValue = persisted.value;
    sourceOfTruth = "persisted";
  } else if (envValue !== null) {
    effectiveValue = envValue;
    sourceOfTruth = "env";
  } else {
    effectiveValue = descriptor.codeDefault;
    sourceOfTruth = "default";
  }

  return {
    key,
    scope: source,
    effectiveValue,
    sourceOfTruth,
    persistedValue: persisted.value,
    persistedScope: persisted.scope,
    envValue,
    codeDefault: descriptor.codeDefault,
    bounds: descriptor.bounds,
    label: descriptor.label,
    description: descriptor.description,
    envName: descriptor.envName,
  };
}

export function getMatchSettingValue(
  key: AgentMatchSettingKey,
  source?: string | null,
): number {
  const scope: AgentMatchSettingSource =
    source && isAgentMatchSettingSource(source) ? source : "default";
  return resolveMatchSetting(key, scope).effectiveValue;
}

export async function warmMatchSettingsCache(): Promise<void> {
  await ensureCacheLoaded();
}

export async function listEffectiveMatchSettings(): Promise<{
  scopes: AgentMatchSettingSource[];
  keys: AgentMatchSettingKey[];
  rows: ResolvedSetting[];
  envFallbackUsed: boolean;
}> {
  await ensureCacheLoaded();
  const rows: ResolvedSetting[] = [];
  for (const scope of MATCH_SETTING_SOURCES) {
    for (const key of MATCH_SETTING_KEYS) {
      rows.push(resolveMatchSetting(key, scope));
    }
  }
  const envFallbackUsed = rows.some(r => r.sourceOfTruth === "env");
  return {
    scopes: [...MATCH_SETTING_SOURCES],
    keys: [...MATCH_SETTING_KEYS],
    rows,
    envFallbackUsed,
  };
}

export type GuardrailWarningCode = "short_token_len_too_small";

export type GuardrailWarning = {
  code: GuardrailWarningCode;
  message: string;
  involvedKeys: AgentMatchSettingKey[];
  /**
   * Which effective scope this warning applies to. A default-scope edit can
   * cause warnings to fire on the Zoom-effective combination even when the
   * default-effective combination looks healthy (e.g. when Zoom has a partial
   * override on a paired key). The UI uses this to attribute the warning.
   */
  effectiveScope?: AgentMatchSettingSource;
};

const ZOOM_GUARDRAIL_KEYS: AgentMatchSettingKey[] = [
  "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
  "ZOOM_SHORT_TOKEN_MAX_LEN",
];

export function evaluateZoomGuardrailWarningsForValues(values: {
  ZOOM_STRONG_SIGNAL_MIN_WEIGHT: number;
  ZOOM_SHORT_TOKEN_MAX_LEN: number;
}): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const shortLen = values.ZOOM_SHORT_TOKEN_MAX_LEN;

  if (shortLen <= 1) {
    warnings.push({
      code: "short_token_len_too_small",
      message:
        `Short contact-name token length is ${shortLen}. Almost no real first names are this short, ` +
        `so the contact-name-only guardrail will stop routing common first names (e.g. "Tim", "Sam") ` +
        `to review and they may auto-claim on weak evidence.`,
      involvedKeys: ["ZOOM_SHORT_TOKEN_MAX_LEN"],
    });
  }

  return warnings;
}

function projectedEffectiveForScope(params: {
  evalScope: AgentMatchSettingSource;
  editScope: AgentMatchSettingSource;
  key: AgentMatchSettingKey;
  value: number | null;
}): Record<string, number> {
  const effective: Record<string, number> = {};
  for (const k of ZOOM_GUARDRAIL_KEYS) {
    effective[k] = resolveMatchSetting(k, params.evalScope).effectiveValue;
  }

  // Determine how this edit changes the effective value at evalScope:
  // - Editing the same scope: trivially overlay.
  // - Editing default while evaluating zoom: only affects zoom-effective if
  //   zoom does not have its own override on this key.
  const zoomHasOwnOverride = (() => {
    const r = resolveMatchSetting(params.key, "zoom");
    return r.persistedScope === "zoom";
  })();
  const editAffectsEvalScope =
    params.editScope === params.evalScope ||
    (params.editScope === "default" && params.evalScope === "zoom" && !zoomHasOwnOverride);

  if (!editAffectsEvalScope) return effective;

  if (params.value !== null && Number.isFinite(params.value)) {
    effective[params.key] = params.value;
  } else {
    // Cleared override at editScope: fall through to the next layer.
    const fallback = resolveMatchSetting(params.key, "default");
    effective[params.key] =
      params.editScope === "default"
        ? (fallback.envValue ?? fallback.codeDefault)
        : fallback.effectiveValue;
  }
  return effective;
}

/**
 * Evaluate cross-field guardrail warnings for a *proposed* change. Reads the
 * currently-effective values from the cache and overlays the proposed change.
 *
 * For default-scope edits we additionally check the resulting Zoom-effective
 * combination, because a default change can break Zoom-effective invariants
 * when Zoom has partial overrides on paired keys. Each warning is tagged with
 * the effective scope it applies to. Duplicates across scopes are deduped.
 */
export function evaluateZoomGuardrailWarningsForProposedChange(params: {
  source: AgentMatchSettingSource;
  key: AgentMatchSettingKey;
  value: number | null;
}): GuardrailWarning[] {
  if (!ZOOM_GUARDRAIL_KEYS.includes(params.key)) return [];

  const evalScopes: AgentMatchSettingSource[] =
    params.source === "default" ? ["default", "zoom"] : ["zoom"];

  const seen = new Map<string, GuardrailWarning>();
  for (const evalScope of evalScopes) {
    const projected = projectedEffectiveForScope({
      evalScope,
      editScope: params.source,
      key: params.key,
      value: params.value,
    });
    const warnings = evaluateZoomGuardrailWarningsForValues({
      ZOOM_STRONG_SIGNAL_MIN_WEIGHT: projected.ZOOM_STRONG_SIGNAL_MIN_WEIGHT,
      ZOOM_SHORT_TOKEN_MAX_LEN: projected.ZOOM_SHORT_TOKEN_MAX_LEN,
    });
    for (const w of warnings) {
      const tagged: GuardrailWarning = { ...w, effectiveScope: evalScope };
      // Prefer the warning attributed to the edited scope when both fire on
      // identical projected values; otherwise keep the first (which will be
      // "default" when editing default).
      const existing = seen.get(w.code);
      if (!existing) {
        seen.set(w.code, tagged);
      } else if (existing.effectiveScope !== params.source && evalScope === params.source) {
        seen.set(w.code, tagged);
      }
    }
  }
  return Array.from(seen.values());
}

export async function setPersistedMatchSetting(params: {
  source: AgentMatchSettingSource;
  key: AgentMatchSettingKey;
  value: number;
  updatedBy?: string | null;
  restoreFromHistoryId?: string | null;
  restoreFromChangedAt?: Date | null;
}): Promise<{ resolved: ResolvedSetting; previousValue: number | null; historyId: string }> {
  const descriptor = MATCH_SETTING_DESCRIPTORS[params.key];
  if (!Number.isFinite(params.value)) {
    throw new Error(`Value must be a finite number for ${params.key}.`);
  }
  if (params.value < descriptor.bounds.min || params.value > descriptor.bounds.max) {
    throw new Error(
      `Value ${params.value} out of bounds for ${params.key} (allowed: ${descriptor.bounds.min}..${descriptor.bounds.max}).`,
    );
  }

  const { previousValue, historyId } = await storage.upsertAgentMatchSetting({
    source: params.source,
    settingKey: params.key,
    value: params.value,
    updatedBy: params.updatedBy ?? null,
    restoreFromHistoryId: params.restoreFromHistoryId ?? null,
    restoreFromChangedAt: params.restoreFromChangedAt ?? null,
  });

  invalidateMatchSettingsCache();
  await ensureCacheLoaded();
  return { resolved: resolveMatchSetting(params.key, params.source), previousValue, historyId };
}

export async function clearPersistedMatchSetting(params: {
  source: AgentMatchSettingSource;
  key: AgentMatchSettingKey;
  updatedBy?: string | null;
  restoreFromHistoryId?: string | null;
  restoreFromChangedAt?: Date | null;
}): Promise<{ resolved: ResolvedSetting; previousValue: number | null; historyId: string | null }> {
  const result = await storage.deleteAgentMatchSetting({
    source: params.source,
    settingKey: params.key,
    changedBy: params.updatedBy ?? null,
    restoreFromHistoryId: params.restoreFromHistoryId ?? null,
    restoreFromChangedAt: params.restoreFromChangedAt ?? null,
  });

  invalidateMatchSettingsCache();
  await ensureCacheLoaded();
  return {
    resolved: resolveMatchSetting(params.key, params.source),
    previousValue: result?.previousValue ?? null,
    historyId: result?.historyId ?? null,
  };
}

// Eagerly initialize cache once perfConfig (and storage) are available.
// Safe no-op if storage isn't ready yet — first read will retry.
warmMatchSettingsCache().catch(() => {
  /* logged inside ensureCacheLoaded */
});

// Touch PERF so this module participates in the same env wiring lifecycle.
void PERF;
