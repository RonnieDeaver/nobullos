import { ChangeHistoryCard } from "../adminMatchSettings/changeHistoryCard";
import { CommonFirstNamesSection } from "../adminMatchSettings/commonFirstNamesSection";
import { CoreSettingsTables, GuardrailWarningsBanner, WarningConfirmDialog } from "../adminMatchSettings/coreSettingsSection";
import { HeatmapCoverageCard } from "../adminMatchSettings/heatmapCoverageCard";
import { HistoryRestoreDialog } from "../adminMatchSettings/historyRestoreDialog";
import { createRetryToastHelpers } from "../adminMatchSettings/retryAlerts";
import { useChangeHistory } from "../adminMatchSettings/useChangeHistory";
import { useCommonFirstNames } from "../adminMatchSettings/useCommonFirstNames";
import { useCoreSettings } from "../adminMatchSettings/useCoreSettings";
import { useHeatmapCoverage } from "../adminMatchSettings/useHeatmapCoverage";
import { ResetSavedViewButton } from "@/components/ResetSavedViewButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { SectionNav, type SectionNavItem } from "@/components/admin/SectionNav";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sliders } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

export { ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS, ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET } from "../adminMatchSettings/model";
export { RoutedToReviewSparkline, DismissReasonDelta } from "../adminMatchSettings/trendVisuals";

/**
 * Task #4355 — SectionNav registry for the match-settings monolith (audit
 * §6.1-E: 6,384px of dense thresholds + change history). The impact-preview
 * and thresholds anchors render inside CoreSettingsTables; the rest are
 * page-level sections below.
 */
const MATCH_SETTINGS_SECTIONS: SectionNavItem[] = [
  { id: "heatmap-coverage", label: "Heatmap coverage" },
  { id: "impact-preview", label: "Impact preview" },
  { id: "thresholds", label: "Threshold tables" },
  { id: "common-first-names", label: "Common first names" },
  { id: "change-history", label: "Change history" },
];

export default function MatchSettings() {
  const { user, isLoading: authLoading } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [commonFirstNamesAnchorAuditId, setCommonFirstNamesAnchorAuditId] = useState<string | null>(null);
  const [retryingHistoryId, setRetryingHistoryId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null);
  const { showRetrySuccessToast, showRetryErrorToast } = createRetryToastHelpers(toast);
  const core = useCoreSettings({ user, qc, toast, commonFirstNamesAnchorAuditId });
  const { data, error, guardrailImpactWindowStorageKey, impactWindowStorageKey, isLoading, setGuardrailImpactWindow, setImpactWindowId } = core;
  const heatmap = useHeatmapCoverage({ user, qc, toast });
  const names = useCommonFirstNames({ user, qc, toast, commonFirstNamesAnchorAuditId, setCommonFirstNamesAnchorAuditId, setRetryError, setRetryingHistoryId, showRetrySuccessToast, showRetryErrorToast });
  const { namesTrendWindowMs } = names;
  const historyDomain = useChangeHistory({ user, qc, toast, namesTrendWindowMs, setRetryError, setRetryingHistoryId, showRetrySuccessToast, showRetryErrorToast });
  const persistedViewKeys = useMemo(
    () =>
      [
        impactWindowStorageKey,
        guardrailImpactWindowStorageKey,
      ].filter((k): k is string => Boolean(k)),
    [
      impactWindowStorageKey,
      guardrailImpactWindowStorageKey,
    ],
  );
  const handleResetSavedView = () => {
    setImpactWindowId("since-change");
    setGuardrailImpactWindow("7");
  };
  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || user.role !== "ceo") {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600" data-testid="text-access-denied">Access Denied</h1>
        <p className="text-gray-600">CEO access required to manage matching thresholds.</p>
        <Link href="/">
          <Button variant="outline" data-testid="button-back-dashboard">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Task #4355 — Pattern-A refit onto the shared PageHeader (audit §6.1-B / P1-4). */}
        <PageHeader
          title="Matching Thresholds"
          icon={Sliders}
          backHref="/"
          className="mb-6"
          actions={
            <ResetSavedViewButton
              storageKeys={persistedViewKeys}
              onReset={handleResetSavedView}
              testId="button-reset-saved-view-match-settings"
            />
          }
        />

        <p className="text-gray-600 mb-6" data-testid="text-description">
          Tune the auto-claim thresholds the matching engine uses. Resolution order is{" "}
          <span className="font-medium">persisted</span> → <span className="font-medium">env</span> →{" "}
          <span className="font-medium">code default</span>. Zoom overrides apply to Zoom items only;
          other sources read from Default.
        </p>

        {/* Task #4355 — SectionNav wayfinding shell (audit §6.1-E). */}
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <section id="heatmap-coverage" className="scroll-mt-16">
              <HeatmapCoverageCard heatmap={heatmap} core={core} />
            </section>
            {isLoading && (
              <div className="flex items-center justify-center py-12" data-testid="status-loading">
                <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700" data-testid="status-error">
                Failed to load match settings: {(error as Error).message}
              </div>
            )}

            {data && (
              <div className="space-y-6">
                {data.envFallbackUsed && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800" data-testid="status-env-fallback">
                    One or more values are coming from environment variables. Persisting a value here
                    will override them without requiring a deploy.
                  </div>
                )}

                <GuardrailWarningsBanner core={core} />
                <CoreSettingsTables core={core} />
                <section id="common-first-names" className="scroll-mt-16">
                  <CommonFirstNamesSection names={names} historyDomain={historyDomain} core={core} commonFirstNamesAnchorAuditId={commonFirstNamesAnchorAuditId} retryError={retryError} retryingHistoryId={retryingHistoryId} setCommonFirstNamesAnchorAuditId={setCommonFirstNamesAnchorAuditId} setRetryError={setRetryError} setRetryingHistoryId={setRetryingHistoryId} toast={toast} />
                </section>
                <section id="change-history" className="scroll-mt-16">
                  <ChangeHistoryCard historyDomain={historyDomain} core={core} retryError={retryError} retryingHistoryId={retryingHistoryId} setRetryError={setRetryError} setRetryingHistoryId={setRetryingHistoryId} />
                </section>
              </div>
            )}
          </div>
          <SectionNav
            sections={MATCH_SETTINGS_SECTIONS}
            className="hidden xl:block w-56 shrink-0"
          />
        </div>
      </div>

      <WarningConfirmDialog core={core} toast={toast} />
      <HistoryRestoreDialog historyDomain={historyDomain} core={core} toast={toast} />
    </div>
  );
}
