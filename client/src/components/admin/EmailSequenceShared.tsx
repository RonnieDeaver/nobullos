/**
 * Task #4335 — shared pieces for the email-sequences admin pages: the
 * step-list editor used by both the create-sequence dialog (list page) and
 * the edit-steps dialog (detail page), plus small formatting helpers.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, Sparkles, Trash2 } from "lucide-react";

export interface TemplateOption {
  id: string;
  name: string;
  archived?: boolean;
}

export type DelayUnit = "minutes" | "hours" | "days";

export interface StepDraft {
  templateId: string;
  delayValue: number;
  delayUnit: DelayUnit;
  /** Task #4478 — AI-personalize this step per contact; the draft always
   *  waits in the approval queue (auto-send stays template-only). */
  aiPersonalize: boolean;
}

const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export function toDelayMinutes(d: StepDraft): number {
  const value = Number.isFinite(d.delayValue) ? d.delayValue : 0;
  return Math.max(0, Math.round(value * UNIT_MINUTES[d.delayUnit]));
}

export function fromDelayMinutes(minutes: number): { delayValue: number; delayUnit: DelayUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { delayValue: minutes / 1440, delayUnit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { delayValue: minutes / 60, delayUnit: "hours" };
  return { delayValue: minutes, delayUnit: "minutes" };
}

export function formatDelay(minutes: number, stepOrder: number): string {
  const after = stepOrder <= 1 ? "after enrollment" : "after previous step";
  if (minutes <= 0) return `Immediately ${after}`;
  const { delayValue, delayUnit } = fromDelayMinutes(minutes);
  const unit = delayValue === 1 ? delayUnit.slice(0, -1) : delayUnit;
  return `${delayValue} ${unit} ${after}`;
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export const CANCEL_REASON_LABELS: Record<string, string> = {
  replied: "Replied",
  suppressed: "Suppressed",
  unsubscribed: "Unsubscribed",
  lifecycle_exit: "Became customer",
  manual: "Manually cancelled",
  sequence_archived: "Sequence archived",
};

/** Parse the useful detail out of apiRequest's thrown `${status}: ${body}`. */
export function apiErrorDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const idx = msg.indexOf(": ");
  if (idx > 0) {
    const body = msg.slice(idx + 2);
    try {
      const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown; outcome?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.detail === "string") return parsed.detail;
      if (typeof parsed.outcome === "string") return parsed.outcome;
      return body;
    } catch {
      return body;
    }
  }
  return msg;
}

export function SequenceStepsEditor({
  steps,
  templates,
  onChange,
}: {
  steps: StepDraft[];
  templates: TemplateOption[];
  onChange: (steps: StepDraft[]) => void;
}) {
  const activeTemplates = templates.filter((t) => !t.archived);
  const update = (i: number, patch: Partial<StepDraft>) => {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  return (
    <div className="space-y-3">
      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground">No steps yet — add the first email.</p>
      )}
      {steps.map((step, i) => (
        <div
          key={i}
          className="flex flex-wrap items-end gap-2 rounded-md border p-3"
          data-testid={`row-step-editor-${i}`}
        >
          <Badge variant="outline" className="mb-2">
            Step {i + 1}
          </Badge>
          <div className="min-w-48 flex-1 space-y-1">
            <Label className="text-xs">Template</Label>
            <Select
              value={step.templateId || undefined}
              onValueChange={(v) => update(i, { templateId: v })}
            >
              <SelectTrigger data-testid={`select-step-template-${i}`}>
                <SelectValue placeholder="Pick a template" />
              </SelectTrigger>
              <SelectContent>
                {activeTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-24 space-y-1">
            <Label className="text-xs">Delay</Label>
            <Input
              type="number"
              min={0}
              value={step.delayValue}
              onChange={(e) => update(i, { delayValue: Number(e.target.value) })}
              data-testid={`input-step-delay-${i}`}
            />
          </div>
          <div className="w-28">
            <Select
              value={step.delayUnit}
              onValueChange={(v) => update(i, { delayUnit: v as DelayUnit })}
            >
              <SelectTrigger data-testid={`select-step-delay-unit-${i}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
                <SelectItem value="days">days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor={`ai-step-${i}`} className="text-xs">
              AI personalize
            </Label>
            <Switch
              id={`ai-step-${i}`}
              checked={step.aiPersonalize}
              onCheckedChange={(v) => update(i, { aiPersonalize: v })}
              data-testid={`switch-step-ai-${i}`}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(steps.filter((_, idx) => idx !== i))}
            data-testid={`button-remove-step-${i}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Step 1 delay counts from enrollment; later steps count from the previous send. AI-personalized
        steps always wait in the approval queue — auto-send only applies to plain template steps.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...steps,
            {
              templateId: "",
              delayValue: steps.length === 0 ? 0 : 3,
              delayUnit: steps.length === 0 ? "minutes" : "days",
              aiPersonalize: false,
            },
          ])
        }
        data-testid="button-add-step"
      >
        <Plus className="mr-1 h-4 w-4" /> Add step
      </Button>
    </div>
  );
}
