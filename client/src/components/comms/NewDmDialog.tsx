/**
 * NoBull Comms page — new DM dialog.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * People picker for starting a direct message.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCommsContext } from "@/contexts/CommsContext";
import { Avatar } from "@/components/comms/helpers";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { X, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { type CommsChannel } from "./pageTypes";

// ─── People picker: new direct message ───────────────────────────────────────

interface TeamMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  email: string | null;
}

function memberDisplayName(u: TeamMember): string {
  if (u.firstName || u.lastName) {
    return [u.firstName, u.lastName].filter(Boolean).join(" ");
  }
  return u.email ?? u.id.slice(0, 8);
}

export function NewDmDialog({
  open,
  onClose,
  currentUserId,
  onlineUserIds,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  currentUserId: string;
  onlineUserIds: string[];
  onOpened: (channelId: string) => void;
}) {
  const { userStatuses } = useCommsContext();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const { data: users = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/comms/users"],
    queryFn: () => apiRequest("GET", "/api/comms/users").then((r) => r.json()),
    enabled: open,
  });

  const filtered = users.filter(
    (u) =>
      u.id !== currentUserId &&
      (search === "" ||
        `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(search.toLowerCase()) ||
        (u.email ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleOpen = async () => {
    if (selected.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const ch: CommsChannel = await apiRequest("POST", "/api/comms/dms", {
        userIds: selected,
      }).then((r) => r.json());
      setSelected([]);
      setSearch("");
      onOpened(ch.id);
    } catch (e: any) {
      setError(e?.message ?? "Failed to open conversation");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSelected([]);
    setSearch("");
    setError("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Search teammates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2"
          data-testid="new-dm-search-input"
        />
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2" data-testid="new-dm-selected-list">
            {selected.map((id) => {
              const u = users.find((m) => m.id === id);
              return (
                <Badge
                  key={id}
                  variant="secondary"
                  className="flex items-center gap-1 cursor-pointer"
                  onClick={() => toggleSelect(id)}
                  data-testid={`dm-selected-${id}`}
                >
                  {u ? memberDisplayName(u) : id.slice(0, 8)}
                  <X className="h-3 w-3" />
                </Badge>
              );
            })}
          </div>
        )}
        <ScrollArea className="max-h-64">
          <div className="space-y-0.5 pr-2">
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                {users.length === 0 ? "Loading teammates…" : "No results"}
              </p>
            )}
            {filtered.map((u) => {
              const isOnline = onlineUserIds.includes(u.id);
              const isSelected = selected.includes(u.id);
              const effectiveStatus = userStatuses.get(u.id)?.effectiveStatus ?? (isOnline ? "online" : "offline");
              const statusColor =
                effectiveStatus === "online" ? "text-green-500"
                : effectiveStatus === "away" ? "text-yellow-500"
                : effectiveStatus === "dnd" ? "text-red-500"
                : "text-muted-foreground/30";
              return (
                <button
                  key={u.id}
                  onClick={() => toggleSelect(u.id)}
                  data-testid={`dm-member-${u.id}`}
                  className={cn(
                    "w-full flex items-center gap-3 px-2 py-2 rounded-md text-left transition-colors",
                    isSelected ? "bg-primary/10 text-primary-ink" : "hover:bg-muted/50",
                  )}
                >
                  <Avatar
                    user={{
                      id: u.id,
                      firstName: u.firstName,
                      lastName: u.lastName,
                      profileImageUrl: u.profileImageUrl,
                    }}
                    online={isOnline}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{memberDisplayName(u)}</div>
                    {(() => {
                      const st = userStatuses.get(u.id);
                      const cText = st?.customText;
                      const cEmoji = st?.customEmoji;
                      if (cText) {
                        return (
                          <div className="text-xs text-muted-foreground truncate" data-testid={`dm-member-custom-status-${u.id}`}>
                            {cEmoji ? `${cEmoji} ${cText}` : cText}
                          </div>
                        );
                      }
                      return u.email ? (
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      ) : null;
                    })()}
                  </div>
                  <Circle
                    className={cn("h-2 w-2 flex-shrink-0 fill-current", statusColor)}
                    data-testid={`dm-member-status-${u.id}`}
                  />
                </button>
              );
            })}
          </div>
        </ScrollArea>
        {error && <p className="text-sm text-destructive mt-1">{error}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button
            onClick={handleOpen}
            disabled={selected.length === 0 || loading}
            data-testid="new-dm-open-button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Open"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
