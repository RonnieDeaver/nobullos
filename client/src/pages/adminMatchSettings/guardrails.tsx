// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { type GuardrailWarning, type HistoryRow, type ResolutionSourceOfTruth, type Scope } from "./model";

function evaluateGuardrailWarnings(values: {
  ZOOM_STRONG_SIGNAL_MIN_WEIGHT: number;
  ZOOM_SHORT_TOKEN_MAX_LEN: number;
}): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const { ZOOM_SHORT_TOKEN_MAX_LEN: shortLen } = values;
  if (shortLen <= 1) {
    warnings.push({
      code: "short_token_len_too_small",
      message: `Short contact-name token length is ${shortLen}. Almost no real first names are this short, so common first names like "Tim" or "Sam" will no longer be routed to review and may auto-claim on weak evidence.`,
      involvedKeys: ["ZOOM_SHORT_TOKEN_MAX_LEN"],
    });
  }
  return warnings;
}

class GuardrailAcknowledgementRequiredError extends Error {
  readonly requiresAcknowledgement = true;
  readonly warnings: GuardrailWarning[];
  readonly pending: { scope: Scope; key: string; value: number | null; restoreFromHistoryId?: string | null };
  constructor(
    message: string,
    warnings: GuardrailWarning[],
    pending: { scope: Scope; key: string; value: number | null; restoreFromHistoryId?: string | null },
  ) {
    super(message);
    this.name = "GuardrailAcknowledgementRequiredError";
    this.warnings = warnings;
    this.pending = pending;
  }
}

const SCOPE_LABEL: Record<Scope, string> = {
  default: "Default (all sources)",
  zoom: "Zoom override",
};

const SOURCE_OF_TRUTH_BADGE: Record<ResolutionSourceOfTruth, string> = {
  persisted: "bg-emerald-100 text-emerald-700 border-emerald-200",
  env: "bg-amber-100 text-amber-700 border-amber-200",
  default: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number(n).toFixed(3);
}

function formatUser(row: HistoryRow): string {
  return formatEditorAttribution(row, "system");
}

function rowKey(scope: Scope, settingKey: string): string {
  return `${scope}::${settingKey}`;
}
export { evaluateGuardrailWarnings, GuardrailAcknowledgementRequiredError, SCOPE_LABEL, SOURCE_OF_TRUTH_BADGE, formatNumber, formatUser, rowKey };
