/**
 * DocShareDialog — manage per-user access grants for a NoBull Docs document
 * (Task #4053). Mirrors the Sheets ShareDialog, minus role-level grants and
 * the "owner" grant level: a grantee is a viewer (read-only) or an editor.
 *
 * Only owners (and CEO) can open this dialog — the server enforces it too.
 *
 * Calls:
 *   GET    /api/docs/documents/:id/permissions
 *   PUT    /api/docs/documents/:id/permissions
 *   DELETE /api/docs/documents/:id/permissions/:userId
 */

import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, UserPlus } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DocPermission {
  id: string;
  documentId: string;
  userId: string;
  role: "viewer" | "editor";
  grantedBy: string | null;
}

interface User {
  id: string;
  username: string | null;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  documentId: string;
  documentName: string;
  /** The document owner — excluded from the grantee picker. */
  ownerId: string;
}

const ACCESS_LEVELS: { value: "viewer" | "editor"; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

function roleBadgeColor(role: string) {
  if (role === "editor") return "bg-blue-50 text-blue-700";
  return "bg-gray-100 text-gray-600";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DocShareDialog({ open, onClose, documentId, documentName, ownerId }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [newUserId, setNewUserId] = useState("");
  const [newUserRole, setNewUserRole] = useState<"viewer" | "editor">("viewer");

  const permsKey = `/api/docs/documents/${documentId}/permissions`;

  const permissionsQuery = useQuery<{ permissions: DocPermission[] }>({
    queryKey: [permsKey],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
  });

  // /api/users is team-lead-gated and returns raw rows; the docs roster
  // route is AM-accessible and wraps minimal fields as { users }.
  const usersQuery = useQuery<{ users: User[] }>({
    queryKey: ["/api/docs/team-roster"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
  });

  const permissions = permissionsQuery.data?.permissions ?? [];
  const users = usersQuery.data?.users ?? [];

  function invalidate() {
    // void: fire-and-forget cache refresh; errors surface via query state.
    void queryClient.invalidateQueries({ queryKey: [permsKey] });
  }

  const upsertMut = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await apiRequest("PUT", permsKey, { userId, role });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to grant access");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setNewUserId("");
      toast({ title: "Access granted" });
    },
    onError: (err: any) => {
      toast({ title: "Could not grant access", description: err?.message, variant: "destructive" });
    },
  });

  const revokeMut = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("DELETE", `${permsKey}/${userId}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to remove access");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Access removed" });
    },
    onError: (err: any) => {
      toast({ title: "Could not remove access", description: err?.message, variant: "destructive" });
    },
  });

  function handleAddUser(e: FormEvent) {
    e.preventDefault();
    if (!newUserId) return;
    upsertMut.mutate({ userId: newUserId, role: newUserRole });
  }

  const userMap = new Map(users.map((u) => [u.id, u]));

  function displayUser(userId: string) {
    const u = userMap.get(userId);
    if (!u) return userId;
    const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    return full || u.email || u.username || userId;
  }

  // Users eligible for a new grant: not the owner, not already granted.
  const grantedIds = new Set(permissions.map((p) => p.userId));
  const candidates = users.filter((u) => u.id !== ownerId && !grantedIds.has(u.id));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-share-document">
        <DialogHeader>
          <DialogTitle>Share "{documentName}"</DialogTitle>
          <DialogDescription>
            Give specific teammates viewer (read-only) or editor access to this
            document. The CEO always has full access.
          </DialogDescription>
        </DialogHeader>

        {permissionsQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* ── Existing grants ─────────────────────────────────────────── */}
            <div>
              <Label className="text-xs text-gray-500 mb-2 block">People with access</Label>
              {permissions.length === 0 ? (
                <p className="text-sm text-gray-400" data-testid="share-empty">
                  Not shared with anyone yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {permissions.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                      data-testid={`share-row-${p.userId}`}
                    >
                      <span className="truncate text-sm">{displayUser(p.userId)}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge className={`text-xs ${roleBadgeColor(p.role)}`}>
                          {p.role === "editor" ? "Editor" : "Viewer"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => revokeMut.mutate(p.userId)}
                          disabled={revokeMut.isPending}
                          data-testid={`btn-revoke-${p.userId}`}
                          aria-label={`Remove access for ${displayUser(p.userId)}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── Add grant form ──────────────────────────────────────────── */}
            <form onSubmit={handleAddUser} className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <Label className="text-xs text-gray-500 mb-1 block">Teammate</Label>
                <Select value={newUserId} onValueChange={setNewUserId}>
                  <SelectTrigger className="h-8 text-xs" data-testid="select-share-user">
                    <SelectValue placeholder="Choose a teammate…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {displayUser(u.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-28 shrink-0">
                <Label className="text-xs text-gray-500 mb-1 block">Access</Label>
                <Select
                  value={newUserRole}
                  onValueChange={(v) => setNewUserRole(v as "viewer" | "editor")}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid="select-share-access">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCESS_LEVELS.map((l) => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                size="sm"
                className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                disabled={!newUserId || upsertMut.isPending}
                data-testid="btn-add-share"
              >
                {upsertMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" />
                )}
              </Button>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
