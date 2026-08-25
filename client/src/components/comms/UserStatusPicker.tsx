/**
 * UserStatusPicker — status selector for the current user.
 *
 * Shows a dropdown with Online / Away / Do Not Disturb / Appear Offline choices,
 * plus a custom status row (emoji + short text with optional expiry).
 *
 * Custom status dialog lets the user pick from emoji picker + type text,
 * choose an expiry (30 min, 1 hour, tomorrow, custom, never) and shows
 * recent custom statuses for one-click reuse.
 */

import { useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { EmojiPicker } from "./EmojiPicker";
import type { CommsManualStatus, CommsUserStatusResponse } from "./types";

// ─── Status display helpers ───────────────────────────────────────────────────

export const STATUS_LABELS: Record<CommsManualStatus, string> = {
  online: "Online",
  away: "Away",
  dnd: "Do Not Disturb",
  offline: "Appear Offline",
};

export const STATUS_DESCRIPTIONS: Record<CommsManualStatus, string> = {
  online: "Show as available",
  away: "Show as away",
  dnd: "Mute notifications",
  offline: "Hide your activity",
};

const STATUS_DOT_CLASSES: Record<
  "online" | "away" | "dnd" | "offline" | "auto_away",
  string
> = {
  online: "bg-green-500",
  away: "bg-yellow-400",
  dnd: "bg-red-500",
  offline: "bg-muted-foreground/40",
  auto_away: "bg-yellow-400",
};

export function StatusDot({
  status,
  className,
}: {
  status: CommsManualStatus | "auto_away";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full border border-background flex-shrink-0",
        STATUS_DOT_CLASSES[status] ?? "bg-muted-foreground/40",
        className,
      )}
      data-testid={`status-dot-${status}`}
    />
  );
}

// ─── DND expiry options ───────────────────────────────────────────────────────

type DndExpiry =
  | "30min"
  | "1hour"
  | "4hours"
  | "tomorrow"
  | "never";

function dndExpiryToDate(expiry: DndExpiry): Date | null {
  const now = new Date();
  switch (expiry) {
    case "30min": {
      const d = new Date(now);
      d.setMinutes(d.getMinutes() + 30);
      return d;
    }
    case "1hour": {
      const d = new Date(now);
      d.setHours(d.getHours() + 1);
      return d;
    }
    case "4hours": {
      const d = new Date(now);
      d.setHours(d.getHours() + 4);
      return d;
    }
    case "tomorrow": {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
    case "never":
      return null;
  }
}

// ─── Custom status expiry options ─────────────────────────────────────────────

type CustomExpiry = "30min" | "1hour" | "4hours" | "today" | "never";

const CUSTOM_EXPIRY_LABELS: Record<CustomExpiry, string> = {
  "30min": "30 minutes",
  "1hour": "1 hour",
  "4hours": "4 hours",
  today: "Today",
  never: "Don't clear",
};

function customExpiryToDate(expiry: CustomExpiry): Date | null {
  const now = new Date();
  switch (expiry) {
    case "30min": {
      const d = new Date(now);
      d.setMinutes(d.getMinutes() + 30);
      return d;
    }
    case "1hour": {
      const d = new Date(now);
      d.setHours(d.getHours() + 1);
      return d;
    }
    case "4hours": {
      const d = new Date(now);
      d.setHours(d.getHours() + 4);
      return d;
    }
    case "today": {
      const d = new Date(now);
      d.setHours(23, 59, 59, 999);
      return d;
    }
    case "never":
      return null;
  }
}

// ─── Custom status dialog ─────────────────────────────────────────────────────

interface CustomStatusDialogProps {
  open: boolean;
  onClose: () => void;
  current: { emoji: string | null; text: string | null } | null;
  recents: Array<{ emoji: string; text: string }>;
}

function CustomStatusDialog({
  open,
  onClose,
  current,
  recents,
}: CustomStatusDialogProps) {
  const qc = useQueryClient();
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [text, setText] = useState(current?.text ?? "");
  const [expiry, setExpiry] = useState<CustomExpiry>("never");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = useCallback(async () => {
    if (!text.trim() && !emoji) {
      setError("Add at least an emoji or text.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiRequest("PUT", "/api/comms/status/me/custom", {
        emoji: emoji || "💬",
        text: text.trim(),
        expiresAt: customExpiryToDate(expiry)?.toISOString() ?? null,
      });
      void qc.invalidateQueries({ queryKey: ["/api/comms/status/me"] }); // fire-and-forget: cache refresh only
      onClose();
    } catch {
      setError("Failed to save custom status.");
    } finally {
      setSaving(false);
    }
  }, [emoji, text, expiry, qc, onClose]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/comms/status/me/custom", { clear: true });
      void qc.invalidateQueries({ queryKey: ["/api/comms/status/me"] }); // fire-and-forget: cache refresh only
      onClose();
    } catch {
      setError("Failed to clear status.");
    } finally {
      setSaving(false);
    }
  }, [qc, onClose]);

  const handleClose = () => {
    setEmoji(current?.emoji ?? "");
    setText(current?.text ?? "");
    setExpiry("never");
    setError("");
    setShowEmojiPicker(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set a custom status</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-9 p-0 text-lg"
                  data-testid="custom-status-emoji-btn"
                >
                  {emoji || "😊"}
                </Button>
              </PopoverTrigger>
              <PopoverContent side="right" align="start" className="p-0 border-0 shadow-none w-auto">
                <EmojiPicker
                  onSelect={(e) => { setEmoji(e); setShowEmojiPicker(false); }}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </PopoverContent>
            </Popover>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What's your status?"
              className="flex-1"
              maxLength={100}
              data-testid="custom-status-text-input"
              autoFocus
            />
          </div>

          {recents.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Recent</p>
              <div className="flex flex-wrap gap-1.5">
                {recents.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => { setEmoji(r.emoji); setText(r.text); }}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-border hover:bg-muted transition-colors"
                    data-testid={`custom-status-recent-${i}`}
                  >
                    <span>{r.emoji}</span>
                    <span className="max-w-24 truncate">{r.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Clear after</p>
            <div className="grid grid-cols-3 gap-1">
              {(Object.entries(CUSTOM_EXPIRY_LABELS) as [CustomExpiry, string][]).map(
                ([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setExpiry(key)}
                    className={cn(
                      "text-xs px-2 py-1.5 rounded border transition-colors",
                      expiry === key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border hover:bg-muted",
                    )}
                    data-testid={`custom-status-expiry-${key}`}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" data-testid="custom-status-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-between gap-2 mt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={saving}
            data-testid="custom-status-clear-btn"
          >
            Clear status
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              data-testid="custom-status-save-btn"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main status picker ───────────────────────────────────────────────────────

interface UserStatusPickerProps {
  myStatus: CommsUserStatusResponse | null;
  children: React.ReactNode;
  align?: "end" | "start" | "center";
}

export function UserStatusPicker({
  myStatus,
  children,
  align = "end",
}: UserStatusPickerProps) {
  const qc = useQueryClient();
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [showDndMenu, setShowDndMenu] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [customDndDialogOpen, setCustomDndDialogOpen] = useState(false);
  // datetime-local value, e.g. "2026-07-20T14:00"
  const [customDndValue, setCustomDndValue] = useState("");

  const setStatusMutation = useMutation({
    mutationFn: async ({
      status,
      dndExpiresAt,
    }: {
      status: CommsManualStatus;
      dndExpiresAt?: string | null;
    }) => {
      await apiRequest("PUT", "/api/comms/status/me", { status, dndExpiresAt });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/status/me"] }); // fire-and-forget: cache refresh only
    },
  });

  const handleSetStatus = useCallback(
    (status: CommsManualStatus, dndExpiry?: DndExpiry) => {
      const dndExpiresAt =
        status === "dnd" && dndExpiry
          ? dndExpiryToDate(dndExpiry)?.toISOString() ?? null
          : null;
      setStatusMutation.mutate({ status, dndExpiresAt });
      setDropdownOpen(false);
    },
    [setStatusMutation],
  );

  const handleCustomDndApply = useCallback(() => {
    if (!customDndValue) return;
    const date = new Date(customDndValue);
    if (isNaN(date.getTime())) return;
    setStatusMutation.mutate({ status: "dnd", dndExpiresAt: date.toISOString() });
    setCustomDndDialogOpen(false);
    setCustomDndValue("");
  }, [customDndValue, setStatusMutation]);

  const effectiveStatus = myStatus?.effectiveStatus ?? "offline";
  const customText = myStatus?.customText;
  const customEmoji = myStatus?.customEmoji;

  return (
    <>
      {/* Custom DND expiry dialog */}
      <Dialog open={customDndDialogOpen} onOpenChange={(o) => { if (!o) { setCustomDndDialogOpen(false); setCustomDndValue(""); } }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Custom DND end time</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Do not disturb until</p>
              <Input
                type="datetime-local"
                value={customDndValue}
                onChange={(e) => setCustomDndValue(e.target.value)}
                min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                data-testid="dnd-custom-datetime-input"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => { setCustomDndDialogOpen(false); setCustomDndValue(""); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCustomDndApply} disabled={!customDndValue} data-testid="dnd-custom-apply-btn">
              Apply
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CustomStatusDialog
        open={showCustomDialog}
        onClose={() => setShowCustomDialog(false)}
        current={
          customEmoji || customText
            ? { emoji: customEmoji ?? null, text: customText ?? null }
            : null
        }
        recents={myStatus?.recentCustomStatuses ?? []}
      />

      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-56" data-testid="status-picker-dropdown">
          <div className="px-2 py-1.5">
            <p className="text-xs font-semibold text-muted-foreground">Set status</p>
          </div>
          <DropdownMenuSeparator />

          {(["online", "away", "offline"] as const).map((s) => (
            <DropdownMenuItem
              key={s}
              onClick={() => handleSetStatus(s)}
              data-testid={`status-option-${s}`}
              className="gap-2"
            >
              <StatusDot status={s} />
              <div>
                <div className="text-sm">{STATUS_LABELS[s]}</div>
                <div className="text-xs text-muted-foreground">{STATUS_DESCRIPTIONS[s]}</div>
              </div>
              {effectiveStatus === s && (
                <span className="ml-auto text-primary text-xs">✓</span>
              )}
            </DropdownMenuItem>
          ))}

          {/* DND with expiry sub-menu */}
          <DropdownMenu open={showDndMenu} onOpenChange={setShowDndMenu}>
            <DropdownMenuTrigger asChild>
              <div
                className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground gap-2"
                data-testid="status-option-dnd"
              >
                <StatusDot status="dnd" />
                <div className="flex-1">
                  <div className="text-sm">{STATUS_LABELS.dnd}</div>
                  <div className="text-xs text-muted-foreground">{STATUS_DESCRIPTIONS.dnd}</div>
                </div>
                {effectiveStatus === "dnd" && (
                  <span className="text-primary text-xs mr-1">✓</span>
                )}
                <span className="text-muted-foreground text-xs">›</span>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-44" data-testid="dnd-expiry-menu">
              <div className="px-2 py-1.5">
                <p className="text-xs font-semibold text-muted-foreground">Until…</p>
              </div>
              <DropdownMenuSeparator />
              {(
                [
                  ["30min", "30 minutes"],
                  ["1hour", "1 hour"],
                  ["4hours", "4 hours"],
                  ["tomorrow", "Tomorrow morning"],
                  ["never", "Until I change it"],
                ] as [DndExpiry, string][]
              ).map(([key, label]) => (
                <DropdownMenuItem
                  key={key}
                  onClick={() => { handleSetStatus("dnd", key); setShowDndMenu(false); }}
                  data-testid={`dnd-expiry-${key}`}
                >
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => { setShowDndMenu(false); setDropdownOpen(false); setCustomDndDialogOpen(true); }}
                data-testid="dnd-expiry-custom"
              >
                Custom date/time…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenuSeparator />

          {/* Custom status */}
          <DropdownMenuItem
            onClick={() => { setDropdownOpen(false); setShowCustomDialog(true); }}
            data-testid="status-custom-status-btn"
            className="gap-2"
          >
            {customEmoji ? (
              <span className="text-base leading-none">{customEmoji}</span>
            ) : (
              <span className="text-muted-foreground text-sm">😊</span>
            )}
            <span className="flex-1 truncate text-sm">
              {customText || customEmoji
                ? `${customEmoji ?? ""} ${customText ?? ""}`.trim()
                : "Set a custom status…"}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
