/**
 * chrome — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 381–417, 498–526, 629–653 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { useState } from "react";
import { REPORT_COLORS } from './reportTokens';

export const phaseColors: Record<string, string> = {
  Peak: REPORT_COLORS.crimson,
  Hold: REPORT_COLORS.steel,
  Taper: REPORT_COLORS.gold,
  Soft: REPORT_COLORS.slate,
  Rebuild: REPORT_COLORS.sage,
};

export function highlightPhases(text: string): React.ReactNode[] {
  const phases = ['Peak', 'Hold', 'Taper', 'Soft', 'Rebuild'];
  const labels = ['Position', 'Amplitude', 'Concentration', 'Slope', 'Transition', 'Interaction'];
  const result: React.ReactNode[] = [];
  
  // First, check if text starts with a label (e.g., "Position: ...")
  const labelMatch = text.match(/^([A-Za-z]+):\s*/);
  let remainingText = text;
  
  if (labelMatch && labels.includes(labelMatch[1])) {
    result.push(<span key="label" className="font-bold">{labelMatch[1]}:</span>);
    result.push(" ");
    remainingText = text.slice(labelMatch[0].length);
  }
  
  // Only match exact phase names (case-sensitive), not verb forms like "holds"
  const phaseRegex = new RegExp(`\\b(${phases.join('|')})\\b`, 'g');
  const parts = remainingText.split(phaseRegex);
  
  parts.forEach((part, i) => {
    if (phases.includes(part)) {
      result.push(<span key={`phase-${i}`} className="font-bold text-report-crimson">{part}</span>);
    } else if (part) {
      result.push(part);
    }
  });
  
  return result;
}

export function EditableText({ 
  value, 
  isEditing, 
  className = ""
}: { 
  value: string | number; 
  isEditing: boolean; 
  className?: string;
}) {
  const [displayValue, setDisplayValue] = useState(String(value));
  const [hasEdited, setHasEdited] = useState(false);
  const currentValue = hasEdited ? displayValue : String(value);

  if (!isEditing) return <span className={className}>{currentValue}</span>;

  return (
    <span
      contentEditable
      suppressContentEditableWarning
      className={`${className} outline-none border-b-2 border-dashed border-current/50 focus:border-current px-1`}
      onBlur={(e) => {
        setDisplayValue(e.currentTarget.textContent || "");
        setHasEdited(true);
      }}
    >
      {currentValue}
    </span>
  );
}

export function PhaseBadge({ phase }: { phase: string }) {
  // Phase colors mirror REPORT_PHASE_COLORS; light fills (Taper/Soft)
  // carry ink text, dark fills carry white.
  const colors: Record<string, string> = {
    Peak: "bg-report-crimson text-white",
    Hold: "bg-report-steel text-white",
    Taper: "bg-report-gold text-report-ink",
    Soft: "bg-report-slate text-report-ink",
    Rebuild: "bg-report-sage text-white",
  };
  return (
    <span className={`px-4 py-1 rounded text-xs font-bold ${colors[phase] || "bg-report-neutral text-white"}`}>
      {phase}
    </span>
  );
}

export function StatusBadge({ status }: { status: "watch" | "healthy" | "scaling" | "needs_attention" }) {
  const styles = {
    watch: "bg-report-watch/10 text-report-watch border border-report-watch/30",
    healthy: "bg-report-healthy/10 text-report-healthy border border-report-healthy/30",
    scaling: "bg-report-liberty/10 text-report-liberty border border-report-liberty/30",
    needs_attention: "bg-report-attention/10 text-report-attention border border-report-attention/30",
  };
  const labels = { watch: "Watch", healthy: "Healthy", scaling: "Scaling", needs_attention: "Needs Attention" };
  return <span className={`report-status-tag ${styles[status]}`}>{labels[status]}</span>;
}
