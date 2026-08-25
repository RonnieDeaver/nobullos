import {
  REPORT_STATUS_GLYPHS,
  type ReportStatusLevel,
} from './reportTokens';

/**
 * Squared status tag (§8.4) — the report's replacement for pill chips.
 *
 * - Squared corners (3px via `.report-status-tag`), never rounded-full.
 * - Glyph redundancy: ▲ / — / ▼ accompanies the color so status is
 *   never communicated by color alone.
 * - `solid` = status fill under white text (AA on every level; the ONLY
 *   variant allowed on dark surfaces).
 * - `soft` = 10% tint + status-colored text; light surfaces only (the
 *   status inks don't clear 4.5:1 against charcoal).
 */
const SOLID_CLASSES: Record<ReportStatusLevel, string> = {
  healthy: 'bg-report-healthy text-white',
  watch: 'bg-report-watch text-white',
  attention: 'bg-report-attention text-white',
  critical: 'bg-report-critical text-white',
  neutral: 'bg-report-neutral text-white',
};

const SOFT_CLASSES: Record<ReportStatusLevel, string> = {
  healthy:
    'bg-report-healthy/10 text-report-healthy border border-report-healthy/30',
  watch: 'bg-report-watch/10 text-report-watch border border-report-watch/30',
  attention:
    'bg-report-attention/10 text-report-attention border border-report-attention/30',
  critical:
    'bg-report-critical/10 text-report-critical border border-report-critical/30',
  neutral:
    'bg-report-neutral/10 text-report-neutral border border-report-neutral/30',
};

export interface ReportStatusTagProps {
  level: ReportStatusLevel;
  label: string;
  /** `solid` (default) works on any surface; `soft` is light-surface only. */
  variant?: 'solid' | 'soft';
  /** Set false only when an adjacent element already carries the glyph. */
  glyph?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function ReportStatusTag({
  level,
  label,
  variant = 'solid',
  glyph = true,
  className,
  'data-testid': testId,
}: ReportStatusTagProps) {
  const variantClasses =
    variant === 'solid' ? SOLID_CLASSES[level] : SOFT_CLASSES[level];
  return (
    <span
      className={`report-status-tag ${variantClasses}${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      <span aria-hidden="true">{REPORT_STATUS_GLYPHS[level]}</span>
      {label}
    </span>
  );
}
