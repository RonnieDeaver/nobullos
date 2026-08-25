// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

// Task #987: small inline helper used by the Queue Drain Control card.
// Keeps the row form state out of the main component so each keystroke
// doesn't re-render the whole HealthDashboard tree.
export function QueueDrainQuickAdd({
  onPause,
  onSetRate,
  pending,
}: {
  onPause: (queueName: string) => void;
  onSetRate: (queueName: string, jobsPerMinute: number | null) => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const queueName = name.trim();
  return (
    <div className="flex flex-wrap items-end gap-2 border rounded p-2 bg-muted/30" data-testid="block-queue-drain-quick-add">
      <div>
        <Label htmlFor="quick-add-queue-name" className="text-xs">Queue name</Label>
        <Input
          id="quick-add-queue-name"
          className="h-7 w-56"
          placeholder="e.g. retroactive_reprocess"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-quick-add-queue-name"
        />
      </div>
      <div>
        <Label htmlFor="quick-add-queue-rate" className="text-xs">Optional rate (jobs/min)</Label>
        <Input
          id="quick-add-queue-rate"
          className="h-7 w-32"
          type="number"
          min={1}
          placeholder="e.g. 30"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          data-testid="input-quick-add-queue-rate"
        />
      </div>
      <Button
        size="sm"
        variant="destructive"
        disabled={pending || queueName === ""}
        onClick={() => {
          if (queueName === "") return;
          onPause(queueName);
          setName("");
          setRate("");
        }}
        data-testid="button-quick-add-pause"
      >
        Pause queue
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || queueName === "" || rate.trim() === ""}
        onClick={() => {
          if (queueName === "") return;
          const n = Number.parseInt(rate, 10);
          if (!Number.isFinite(n) || n <= 0) return;
          onSetRate(queueName, n);
          setName("");
          setRate("");
        }}
        data-testid="button-quick-add-rate"
      >
        Apply rate cap
      </Button>
    </div>
  );
}
