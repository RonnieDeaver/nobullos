import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bell } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  messageId: string;
  open: boolean;
  onClose: () => void;
}

interface Preset {
  label: string;
  getDate: () => Date;
}

function nextWeekday(hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysUntilMonday);
  d.setHours(9, 0, 0, 0);
  return d;
}

const PRESETS: Preset[] = [
  { label: "In 15 minutes", getDate: () => new Date(Date.now() + 15 * 60 * 1000) },
  { label: "In 1 hour", getDate: () => new Date(Date.now() + 60 * 60 * 1000) },
  { label: "In 3 hours", getDate: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
  { label: "Tomorrow at 9 am", getDate: () => nextWeekday(9) },
  { label: "Next week Monday", getDate: () => nextMonday() },
];

export function ReminderDialog({ messageId, open, onClose }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [customDate, setCustomDate] = useState("");
  // Task #4346 — field validation is inline (FormField), never a toast.
  const [dateError, setDateError] = useState<string | null>(null);
  const [mode, setMode] = useState<"presets" | "custom">("presets");

  const create = useMutation({
    mutationFn: (remindAt: Date) =>
      apiRequest("POST", `/api/comms/messages/${messageId}/reminders`, {
        remindAt: remindAt.toISOString(),
        note: note.trim() || undefined,
      }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/reminders"] }); // fire-and-forget: cache refresh only
      toast({ title: "Reminder set" });
      setNote("");
      setCustomDate("");
      setDateError(null);
      setMode("presets");
      onClose();
    },
    onError: () => {
      toast({ title: "Could not set reminder", variant: "destructive" });
    },
  });

  const setCustom = () => {
    if (!customDate) return;
    const d = new Date(customDate);
    if (isNaN(d.getTime())) {
      setDateError("Enter a valid date and time.");
      return;
    }
    if (d <= new Date()) {
      setDateError("Pick a time in the future.");
      return;
    }
    setDateError(null);
    create.mutate(d);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm" data-testid="reminder-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Set a reminder
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">
              Optional note
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Follow up on this"
              className="text-sm"
              data-testid="reminder-note-input"
            />
          </div>

          {mode === "presets" ? (
            <div className="space-y-1">
              {PRESETS.map((p) => (
                <Button
                  key={p.label}
                  variant="outline"
                  className="w-full justify-start text-sm h-8"
                  onClick={() => create.mutate(p.getDate())}
                  disabled={create.isPending}
                  data-testid={`reminder-preset-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  {p.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                className="w-full justify-start text-xs text-muted-foreground h-8"
                onClick={() => setMode("custom")}
                data-testid="reminder-custom-toggle"
              >
                Pick a custom time…
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <FormField
                label="Remind me at"
                htmlFor="reminder-custom-datetime"
                labelClassName="text-xs text-muted-foreground"
                error={dateError}
                className="space-y-1"
              >
                <Input
                  type="datetime-local"
                  value={customDate}
                  onChange={(e) => {
                    setCustomDate(e.target.value);
                    setDateError(null);
                  }}
                  className="text-sm"
                  data-testid="reminder-custom-datetime"
                />
              </FormField>
              <div className="flex gap-2">
                <Button
                  className="flex-1 text-sm"
                  onClick={setCustom}
                  disabled={create.isPending || !customDate}
                  data-testid="reminder-custom-confirm"
                >
                  Set reminder
                </Button>
                <Button
                  variant="ghost"
                  className="text-sm"
                  onClick={() => {
                    setDateError(null);
                    setMode("presets");
                  }}
                  data-testid="reminder-back-presets"
                >
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
