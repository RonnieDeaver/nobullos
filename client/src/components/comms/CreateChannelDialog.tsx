/**
 * NoBull Comms page — create channel dialog.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * New-channel form.
 */

import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { type CommsChannel } from "./pageTypes";

// ─── Create channel dialog ────────────────────────────────────────────────────

export function CreateChannelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) { setError("Channel name is required"); return; }
    setLoading(true);
    setError("");
    try {
      const ch: CommsChannel = await apiRequest("POST", "/api/comms/channels", {
        name: name.trim(),
        visibility,
        topic: topic.trim() || undefined,
      }).then((r) => r.json());
      onCreated(ch.id);
      setName(""); setTopic("");
    } catch (e: any) {
      setError(e?.message ?? "Failed to create channel");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. marketing"
              className="mt-1"
              data-testid="new-channel-name-input"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Topic (optional)</label>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is this channel about?"
              className="mt-1"
              data-testid="new-channel-topic-input"
            />
          </div>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
                className="accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Public</div>
                <div className="text-xs text-muted-foreground">Anyone can join</div>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
                className="accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Private</div>
                <div className="text-xs text-muted-foreground">Invite only</div>
              </div>
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()} data-testid="create-channel-submit">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create channel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
