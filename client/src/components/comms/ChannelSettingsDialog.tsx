/**
 * NoBull Comms page — channel settings dialog.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * Rename/archive/privacy controls for a channel.
 */

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { type CommsChannel } from "./pageTypes";

// ─── Channel settings dialog ─────────────────────────────────────────────────

export function ChannelSettingsDialog({
  channel,
  open,
  onClose,
}: {
  channel: CommsChannel;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(channel.name ?? "");
  const [unlink, setUnlink] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(channel.name ?? "");
      setUnlink(false);
      setError(null);
    }
  }, [open, channel.id, channel.name]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: { name?: string; clientId?: null } = {};
      if (trimmed !== (channel.name ?? "")) body.name = trimmed;
      if (unlink && channel.clientId) body.clientId = null;
      if (Object.keys(body).length > 0) {
        const resp = await fetch(`/api/comms/channels/${channel.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          setError(data.error ?? "Failed to update channel");
          return;
        }
        void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
      }
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update channel");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Channel settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">
              Channel name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Channel name"
              data-testid="channel-settings-name-input"
            />
          </div>

          {channel.clientId && (
            <div className="flex items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                id="unlink-client-toggle"
                checked={unlink}
                onChange={(e) => setUnlink(e.target.checked)}
                className="mt-0.5 h-4 w-4"
                data-testid="channel-settings-unlink-toggle"
              />
              <label htmlFor="unlink-client-toggle" className="text-sm cursor-pointer">
                <span className="font-medium text-foreground block">Unlink from client</span>
                <span className="text-muted-foreground">
                  Detaches this channel from its client. It moves to the Channels
                  section of the sidebar; message history is kept.
                </span>
              </label>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" data-testid="channel-settings-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} data-testid="channel-settings-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || saving}
              data-testid="channel-settings-save"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
