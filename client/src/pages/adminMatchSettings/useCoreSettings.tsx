// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { useAuth } from "@/hooks/use-auth";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { GuardrailAcknowledgementRequiredError, evaluateGuardrailWarnings, rowKey } from "./guardrails";
import { type CustomWindowUnit, GUARDRAIL_IMPACT_WINDOWS, type GuardrailImpactResponse, type GuardrailWarning, type ImpactResponse, type ResolvedRow, type Scope, type SettingsResponse, WINDOW_CHOICES, ZOOM_GUARDRAIL_KEYS, computeCustomWindowMs } from "./model";

type UseCoreSettingsDeps = {
  user: ReturnType<typeof useAuth>["user"];
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
  commonFirstNamesAnchorAuditId: string | null;
};

export function useCoreSettings({
  user,
  qc,
  toast,
  commonFirstNamesAnchorAuditId,
}: UseCoreSettingsDeps) {
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [impactKeyByScope, setImpactKeyByScope] = useState<Record<Scope, string>>({
    default: "__latest__",
    zoom: "__latest__",
  });
  const [flashRowKey, setFlashRowKey] = useState<string | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) {
        clearTimeout(flashTimeoutRef.current);
        flashTimeoutRef.current = null;
      }
    };
  }, []);

  const focusGuardrailRow = (key: string, scope: Scope = "zoom") => {
    const targetKey = rowKey(scope, key);
    if (typeof document !== "undefined") {
      const selector = `[data-row-key="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(targetKey) : targetKey}"]`;
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      }
    }
    setFlashRowKey(targetKey);
    if (flashTimeoutRef.current !== null) {
      clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = setTimeout(() => {
      flashTimeoutRef.current = null;
      setFlashRowKey((prev) => (prev === targetKey ? null : prev));
    }, 2200);
  };

  const { data, isLoading, error } = useQuery<SettingsResponse>({
    queryKey: ["/api/admin/match-settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/match-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch match settings");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  // Task #1714 — Stage D: The legacy `/api/legacy-notifications` reader
  // and its derived "recent threshold changes by other admins" banner +
  // row-highlight visuals were retired. The legacy notifications table
  // no longer receives new rows post Stages B/C, so the banner only
  // surfaced aging legacy data. Admins now consume notifications via
  // the per-user bell + `/notifications` inbox.

  const impactWindowStorageKey = user?.id
    ? `admin.matchSettings.impactWindowId.${user.id}`
    : null;
  const validImpactWindow = (v: unknown): v is string =>
    typeof v === "string" && WINDOW_CHOICES.some(c => c.id === v);
  const [impactWindowId, setImpactWindowId] = usePersistentState<string>(
    impactWindowStorageKey,
    "since-change",
    validImpactWindow,
  );
  const [customWindowValue, setCustomWindowValue] = useState<string>("48");
  const [customWindowUnit, setCustomWindowUnit] = useState<CustomWindowUnit>("h");
  const customWindowMs = useMemo(
    () => computeCustomWindowMs(customWindowValue, customWindowUnit),
    [customWindowValue, customWindowUnit],
  );
  const selectedWindowMs = useMemo(() => {
    if (impactWindowId === "custom") return customWindowMs;
    return WINDOW_CHOICES.find(c => c.id === impactWindowId)?.ms ?? null;
  }, [impactWindowId, customWindowMs]);

  const customWindowInvalid = impactWindowId === "custom" && customWindowMs === null;
  const { data: impact } = useQuery<ImpactResponse>({
    queryKey: ["/api/admin/match-settings/impact", selectedWindowMs],
    queryFn: async () => {
      const url = selectedWindowMs
        ? `/api/admin/match-settings/impact?windowMs=${selectedWindowMs}`
        : "/api/admin/match-settings/impact";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch impact");
      return res.json();
    },
    enabled: !!user && user.role === "ceo" && !customWindowInvalid,
  });

  const guardrailImpactWindowStorageKey = user?.id
    ? `admin.matchSettings.guardrailImpactWindow.${user.id}`
    : null;
  const validGuardrailImpactWindow = (v: unknown): v is string =>
    typeof v === "string" && GUARDRAIL_IMPACT_WINDOWS.some(c => c.value === v);
  const [guardrailImpactWindow, setGuardrailImpactWindow] = usePersistentState<string>(
    guardrailImpactWindowStorageKey,
    "7",
    validGuardrailImpactWindow,
  );

  const guardrailImpactQuery = useQuery<GuardrailImpactResponse>({
    queryKey: [
      "/api/admin/zoom/guardrail-impact",
      guardrailImpactWindow,
      commonFirstNamesAnchorAuditId,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (guardrailImpactWindow !== "all") params.set("windowDays", guardrailImpactWindow);
      if (commonFirstNamesAnchorAuditId) {
        params.set("commonFirstNamesAnchorAuditId", commonFirstNamesAnchorAuditId);
      }
      const url = `/api/admin/zoom/guardrail-impact${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch guardrail impact");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const guardrailImpact = guardrailImpactQuery.data;

  const [pendingConfirm, setPendingConfirm] = useState<
    | null
    | { scope: Scope; key: string; value: number | null; warnings: GuardrailWarning[]; restoreFromHistoryId?: string | null }
  >(null);

  const updateMutation = useMutation({
    mutationFn: async (params: { scope: Scope; key: string; value: number | null; acknowledgeWarnings?: boolean; restoreFromHistoryId?: string | null }) => {
      const res = await fetch("/api/admin/match-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: params.scope,
          key: params.key,
          value: params.value,
          acknowledgeWarnings: params.acknowledgeWarnings === true,
          ...(params.restoreFromHistoryId
            ? { restoreFromHistoryId: params.restoreFromHistoryId }
            : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 400 && err?.requiresAcknowledgement && Array.isArray(err.warnings)) {
          throw new GuardrailAcknowledgementRequiredError(
            err.error || "Guardrail warnings",
            err.warnings as GuardrailWarning[],
            {
              scope: params.scope,
              key: params.key,
              value: params.value,
              restoreFromHistoryId: params.restoreFromHistoryId ?? null,
            },
          );
        }
        throw new Error(err?.error || "Failed to update");
      }
      return res.json();
    },
    onError: (err: unknown) => {
      if (err instanceof GuardrailAcknowledgementRequiredError) {
        setPendingConfirm({
          scope: err.pending.scope,
          key: err.pending.key,
          value: err.pending.value,
          warnings: err.warnings,
          restoreFromHistoryId: err.pending.restoreFromHistoryId ?? null,
        });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/history"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/impact"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/guardrail-impact"] }); // fire-and-forget: cache refresh only
      setSavingKey(null);
    },
  });

  const guardrailEffectiveByScope = useMemo(() => {
    const out: Record<Scope, Record<string, number>> = { default: {}, zoom: {} };
    if (!data) return out;
    for (const r of data.rows) {
      if ((ZOOM_GUARDRAIL_KEYS as readonly string[]).includes(r.key)) {
        out[r.scope][r.key] = r.effectiveValue;
      }
    }
    return out;
  }, [data]);

  const currentSavedWarnings = useMemo<GuardrailWarning[]>(() => {
    if (!data) return [];
    const zoomEff = guardrailEffectiveByScope.zoom;
    const required: (typeof ZOOM_GUARDRAIL_KEYS)[number][] = [
      "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
      "ZOOM_SHORT_TOKEN_MAX_LEN",
    ];
    for (const k of required) {
      if (typeof zoomEff[k] !== "number" || !Number.isFinite(zoomEff[k])) return [];
    }
    return evaluateGuardrailWarnings({
      ZOOM_STRONG_SIGNAL_MIN_WEIGHT: zoomEff.ZOOM_STRONG_SIGNAL_MIN_WEIGHT,
      ZOOM_SHORT_TOKEN_MAX_LEN: zoomEff.ZOOM_SHORT_TOKEN_MAX_LEN,
    }).map(w => ({ ...w, effectiveScope: "zoom" as Scope }));
  }, [data, guardrailEffectiveByScope]);

  const currentRiskyKeys = useMemo(() => {
    const set = new Set<string>();
    for (const w of currentSavedWarnings) {
      for (const k of w.involvedKeys) set.add(k);
    }
    return set;
  }, [currentSavedWarnings]);

  const persistedZoomKeys = useMemo(() => {
    const set = new Set<string>();
    if (!data) return set;
    for (const r of data.rows) {
      if (r.scope === "zoom" && r.persistedScope === "zoom" && r.persistedValue !== null) {
        set.add(r.key);
      }
    }
    return set;
  }, [data]);

  const computeRowWarnings = (scope: Scope, key: string, draft: string): GuardrailWarning[] => {
    if (!(ZOOM_GUARDRAIL_KEYS as readonly string[]).includes(key)) return [];
    if (draft === "") return [];
    const numeric = Number(draft);
    if (!Number.isFinite(numeric)) return [];

    const evalScopes: Scope[] = scope === "default" ? ["default", "zoom"] : ["zoom"];
    const dedup = new Map<string, GuardrailWarning>();
    for (const evalScope of evalScopes) {
      const base = guardrailEffectiveByScope[evalScope];
      const editAffectsEvalScope =
        scope === evalScope ||
        (scope === "default" && evalScope === "zoom" && !persistedZoomKeys.has(key));
      const projected = {
        ZOOM_STRONG_SIGNAL_MIN_WEIGHT: base.ZOOM_STRONG_SIGNAL_MIN_WEIGHT,
        ZOOM_SHORT_TOKEN_MAX_LEN: base.ZOOM_SHORT_TOKEN_MAX_LEN,
      };
      if (editAffectsEvalScope) {
        (projected as Record<string, number>)[key] = numeric;
      }
      for (const w of evaluateGuardrailWarnings(projected)) {
        const tagged = { ...w, effectiveScope: evalScope };
        const existing = dedup.get(w.code);
        if (!existing) dedup.set(w.code, tagged);
        else if (existing.effectiveScope !== scope && evalScope === scope) dedup.set(w.code, tagged);
      }
    }
    return Array.from(dedup.values());
  };

  const rowsByScope = useMemo(() => {
    const map = new Map<Scope, ResolvedRow[]>();
    if (!data) return map;
    for (const r of data.rows) {
      const list = map.get(r.scope) || [];
      list.push(r);
      map.set(r.scope, list);
    }
    return map;
  }, [data]);
  return {
    draftValues,
    setDraftValues,
    savingKey,
    setSavingKey,
    impactKeyByScope,
    setImpactKeyByScope,
    flashRowKey,
    setFlashRowKey,
    flashTimeoutRef,
    focusGuardrailRow,
    data,
    isLoading,
    error,
    impactWindowStorageKey,
    validImpactWindow,
    impactWindowId,
    setImpactWindowId,
    customWindowValue,
    setCustomWindowValue,
    customWindowUnit,
    setCustomWindowUnit,
    customWindowMs,
    selectedWindowMs,
    customWindowInvalid,
    impact,
    guardrailImpactWindowStorageKey,
    validGuardrailImpactWindow,
    guardrailImpactWindow,
    setGuardrailImpactWindow,
    guardrailImpactQuery,
    guardrailImpact,
    pendingConfirm,
    setPendingConfirm,
    updateMutation,
    guardrailEffectiveByScope,
    currentSavedWarnings,
    currentRiskyKeys,
    persistedZoomKeys,
    computeRowWarnings,
    rowsByScope,
  };
}

export type CoreSettingsBag = ReturnType<typeof useCoreSettings>;
