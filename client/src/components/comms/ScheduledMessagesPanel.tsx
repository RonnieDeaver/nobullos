/**
 * ScheduledMessagesPanel — lists the current user's pending scheduled messages.
 * Allows cancellation and rescheduling of individual messages.
 * Shown in a collapsible section within the channel message pane or in its own panel.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock, Trash2, Loader2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommsScheduledMessage } from "./types";
import { renderContent, stripFormatting } from "./helpers";

function formatScheduledTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isTomorrow = d.toDateString() === new Date(now.getTime() + 86_400_000).toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SCHEDULE_PRESETS = [
  {
    label: "In 1 hour",
    make: () => {
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setSeconds(0, 0);
      return d;
    },
  },
  {
    label: "Tomorrow 9 am",
    make: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next Monday 9 am",
    make: () => {
      const d = new Date();
      const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
      d.setDate(d.getDate() + daysUntilMonday);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
] as const;

function RescheduleDialog({
  msg,
  open,
  onClose,
  onSaved,
}: {
  msg: CommsScheduledMessage;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(() => toDatetimeLocal(new Date(msg.scheduledFor)));
  const [saving, setSaving] = useState(false);
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleSave = async () => {
    const d = new Date(value);
    if (isNaN(d.getTime()) || d <= new Date()) return;
    setSaving(true);
    try {
      const resp = await apiRequest("PATCH", `/api/comms/scheduled-messages/${msg.id}`, {
        scheduledFor: d.toISOString(),
      });
      if (!resp.ok) throw new Error(await resp.text());
      onSaved();
      onClose();
    } catch {
      /* best-effort */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reschedule Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="text-sm text-muted-foreground line-clamp-2">{renderContent(msg.content ?? "")}</div>
          <div className="flex flex-wrap gap-2">
            {SCHEDULE_PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setValue(toDatetimeLocal(p.make()))}
                type="button"
                data-testid={`reschedule-preset-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="space-y-1">
            <input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={toDatetimeLocal(new Date())}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="reschedule-datetime-input"
            />
            <p className="text-xs text-muted-foreground">{tzName}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!value || new Date(value) <= new Date() || saving}
              data-testid="reschedule-confirm-button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Update"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduledMessagesPanel({
  channelId,
  className,
}: {
  channelId: string;
  className?: string;
}) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<CommsScheduledMessage | null>(null);

  const { data: messages = [], isLoading } = useQuery<CommsScheduledMessage[]>({
    queryKey: [`/api/comms/channels/${channelId}/scheduled-messages`],
    queryFn: () =>
      apiRequest("GET", `/api/comms/channels/${channelId}/scheduled-messages`).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
  });

  const pending = messages.filter((m) => m.status === "pending");

  const handleCancel = async (id: string) => {
    setCancelling(id);
    try {
      await apiRequest("DELETE", `/api/comms/scheduled-messages/${id}`);
      void qc.invalidateQueries({
        queryKey: [`/api/comms/channels/${channelId}/scheduled-messages`],
      });
      void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
    } catch {
      /* best-effort */
    } finally {
      setCancelling(null);
    }
  };

  const handleRescheduleSaved = () => {
    void qc.invalidateQueries({
      queryKey: [`/api/comms/channels/${channelId}/scheduled-messages`],
    });
    void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
  };

  if (isLoading || pending.length === 0) return null;

  return (
    <>
      <div className={cn("border border-border rounded-md bg-muted/30 overflow-hidden", className)}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            {pending.length} scheduled {pending.length === 1 ? "message" : "messages"}
          </span>
        </div>
        <div className="divide-y divide-border">
          {pending.map((msg) => (
            <div
              key={msg.id}
              className="flex items-start gap-3 px-3 py-2.5 group"
              data-testid={`scheduled-msg-${msg.id}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">
                  {formatScheduledTime(msg.scheduledFor)}
                </p>
                <p className="text-sm truncate">{stripFormatting(msg.content ?? "")}</p>
              </div>
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      onClick={() => setRescheduling(msg)}
                      aria-label="Reschedule message"
                      data-testid={`reschedule-scheduled-${msg.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reschedule</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:bg-red-100 hover:text-red-600"
                      onClick={() => handleCancel(msg.id)}
                      disabled={cancelling === msg.id}
                      aria-label="Cancel scheduled message"
                      data-testid={`cancel-scheduled-${msg.id}`}
                    >
                      {cancelling === msg.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel scheduled message</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      </div>
      {rescheduling && (
        <RescheduleDialog
          msg={rescheduling}
          open={!!rescheduling}
          onClose={() => setRescheduling(null)}
          onSaved={handleRescheduleSaved}
        />
      )}
    </>
  );
}

// ─── All-channel scheduled messages list (for /comms page) ───────────────────

export function AllScheduledMessagesPanel({ className }: { className?: string }) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<CommsScheduledMessage | null>(null);

  const { data: messages = [], isLoading } = useQuery<CommsScheduledMessage[]>({
    queryKey: ["/api/comms/scheduled-messages"],
    queryFn: () =>
      apiRequest("GET", "/api/comms/scheduled-messages").then((r) => r.json()),
    staleTime: 30_000,
  });

  const pending = messages.filter((m) => m.status === "pending");

  const handleCancel = async (msg: CommsScheduledMessage) => {
    setCancelling(msg.id);
    try {
      await apiRequest("DELETE", `/api/comms/scheduled-messages/${msg.id}`);
      void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({
        queryKey: [`/api/comms/channels/${msg.channelId}/scheduled-messages`],
      });
    } catch {
      /* best-effort */
    } finally {
      setCancelling(null);
    }
  };

  const handleRescheduleSaved = (msg: CommsScheduledMessage) => {
    void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({
      queryKey: [`/api/comms/channels/${msg.channelId}/scheduled-messages`],
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
        <Clock className="h-6 w-6" />
        <p className="text-sm">No scheduled messages</p>
      </div>
    );
  }

  return (
    <>
      <div className={cn("flex flex-col gap-0.5", className)}>
        {pending.map((msg) => (
          <div
            key={msg.id}
            className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted/60 group"
            data-testid={`all-scheduled-msg-${msg.id}`}
          >
            <Clock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {formatScheduledTime(msg.scheduledFor)}
                </span>
              </div>
              <p className="text-sm truncate mt-0.5">{stripFormatting(msg.content ?? "")}</p>
            </div>
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100"
                    onClick={() => setRescheduling(msg)}
                    aria-label="Reschedule message"
                    data-testid={`reschedule-all-scheduled-${msg.id}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reschedule</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:bg-red-100 hover:text-red-600"
                    onClick={() => handleCancel(msg)}
                    disabled={cancelling === msg.id}
                    aria-label="Cancel scheduled message"
                    data-testid={`cancel-all-scheduled-${msg.id}`}
                  >
                    {cancelling === msg.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Cancel scheduled message</TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
      {rescheduling && (
        <RescheduleDialog
          msg={rescheduling}
          open={!!rescheduling}
          onClose={() => setRescheduling(null)}
          onSaved={() => handleRescheduleSaved(rescheduling)}
        />
      )}
    </>
  );
}
