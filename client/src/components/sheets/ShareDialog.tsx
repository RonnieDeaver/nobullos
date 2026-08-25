/**
 * ShareDialog — manage per-user and per-role access for a workbook.
 *
 * Only owners (and CEO) can open this dialog. It shows:
 *  - Current user-level grants (viewer / editor / owner) with remove button.
 *  - Current role-level grants (viewer / editor) with remove button.
 *  - A form to add a user by their user ID (or look up from user list).
 *  - A form to add a role grant.
 *
 * Calls:
 *   GET /api/sheets/workbooks/:id/permissions
 *   PUT /api/sheets/workbooks/:id/permissions
 *   DELETE /api/sheets/workbooks/:id/permissions/:userId
 *   GET /api/sheets/workbooks/:id/role-grants
 *   PUT /api/sheets/workbooks/:id/role-grants
 *   DELETE /api/sheets/workbooks/:id/role-grants/:role
 */

import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { humanizeQueryError } from "@/lib/queryErrorCopy";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, UserPlus, Users } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkbookPermission {
  id: string;
  workbookId: string;
  userId: string;
  role: "viewer" | "editor" | "owner";
  grantedBy: string | null;
}

interface WorkbookRoleGrant {
  id: string;
  workbookId: string;
  role: string;
  accessLevel: "viewer" | "editor";
  grantedBy: string | null;
}

interface User {
  id: string;
  username: string | null;
  email: string | null;
  role: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  workbookId: string;
  workbookName: string;
}

const APP_ROLES = [
  { value: "account_manager", label: "Account Managers" },
  { value: "team_lead", label: "Team Leads" },
  { value: "ceo", label: "CEO (always has access)" },
];

const ACCESS_LEVELS: { value: "viewer" | "editor"; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

const PERM_ROLES: { value: "viewer" | "editor" | "owner"; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "owner", label: "Owner" },
];

function roleBadgeColor(role: string) {
  if (role === "owner") return "bg-primary/10 text-primary";
  if (role === "editor") return "bg-status-info/10 text-status-info";
  return "bg-muted text-muted-foreground";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ShareDialog({ open, onClose, workbookId, workbookName }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // User grant form state
  const [newUserId, setNewUserId] = useState("");
  const [newUserRole, setNewUserRole] = useState<"viewer" | "editor" | "owner">("viewer");

  // Role grant form state
  const [newRole, setNewRole] = useState("account_manager");
  const [newRoleAccess, setNewRoleAccess] = useState<"viewer" | "editor">("viewer");

  // ── Queries ────────────────────────────────────────────────────────────────
  const permissionsQuery = useQuery<{ permissions: WorkbookPermission[] }>({
    queryKey: [`/api/sheets/workbooks/${workbookId}/permissions`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
  });

  const roleGrantsQuery = useQuery<{ roleGrants: WorkbookRoleGrant[] }>({
    queryKey: [`/api/sheets/workbooks/${workbookId}/role-grants`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
  });

  const usersQuery = useQuery<{ users: User[] }>({
    queryKey: ["/api/users"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
  });

  const permissions = permissionsQuery.data?.permissions ?? [];
  const roleGrants = roleGrantsQuery.data?.roleGrants ?? [];
  const users = usersQuery.data?.users ?? [];

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: [`/api/sheets/workbooks/${workbookId}/permissions`] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: [`/api/sheets/workbooks/${workbookId}/role-grants`] }); // fire-and-forget: cache refresh only
  }

  // ── User-level grant mutations ─────────────────────────────────────────────
  const upsertPermMut = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await apiRequest("PUT", `/api/sheets/workbooks/${workbookId}/permissions`, {
        userId,
        role,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setNewUserId("");
      toast({ title: "Access granted" });
    },
    onError: (err) => {
      toast({ title: "Couldn't grant access", description: humanizeQueryError(err, { kind: "mutation" }).description, variant: "destructive" });
    },
  });

  const revokePermMut = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/workbooks/${workbookId}/permissions/${userId}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Access removed" });
    },
    onError: (err) => {
      toast({ title: "Couldn't remove access", description: humanizeQueryError(err, { kind: "mutation" }).description, variant: "destructive" });
    },
  });

  // ── Role-level grant mutations ─────────────────────────────────────────────
  const upsertRoleGrantMut = useMutation({
    mutationFn: async ({ role, accessLevel }: { role: string; accessLevel: string }) => {
      const res = await apiRequest("PUT", `/api/sheets/workbooks/${workbookId}/role-grants`, {
        role,
        accessLevel,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Role access granted" });
    },
    onError: (err) => {
      toast({ title: "Couldn't grant role access", description: humanizeQueryError(err, { kind: "mutation" }).description, variant: "destructive" });
    },
  });

  const revokeRoleGrantMut = useMutation({
    mutationFn: async (role: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/workbooks/${workbookId}/role-grants/${role}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Role access removed" });
    },
    onError: (err) => {
      toast({ title: "Couldn't remove role access", description: humanizeQueryError(err, { kind: "mutation" }).description, variant: "destructive" });
    },
  });

  // ── Submit handlers ────────────────────────────────────────────────────────
  function handleAddUser(e: FormEvent) {
    e.preventDefault();
    const trimmed = newUserId.trim();
    if (!trimmed) return;
    upsertPermMut.mutate({ userId: trimmed, role: newUserRole });
  }

  function handleAddRoleGrant(e: FormEvent) {
    e.preventDefault();
    upsertRoleGrantMut.mutate({ role: newRole, accessLevel: newRoleAccess });
  }

  const isLoading = permissionsQuery.isLoading || roleGrantsQuery.isLoading;

  // Map userId → user info for display
  const userMap = new Map(users.map((u) => [u.id, u]));

  function displayUser(userId: string) {
    const u = userMap.get(userId);
    if (!u) return userId;
    return u.email || u.username || userId;
  }

  function displayRole(role: string) {
    return APP_ROLES.find((r) => r.value === role)?.label ?? role;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share "{workbookName}"</DialogTitle>
          <DialogDescription>
            Grant or remove access to this workbook. CEO users always have access.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* ── Current user grants ─────────────────────────────────────── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <UserPlus className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">User access</h3>
              </div>

              {permissions.length === 0 ? (
                <p className="text-xs text-muted-foreground italic mb-3">No user-level grants yet.</p>
              ) : (
                <ul className="mb-3 space-y-2" data-testid="permissions-list">
                  {permissions.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
                      data-testid={`perm-row-${p.userId}`}
                    >
                      <span className="truncate text-foreground min-w-0">{displayUser(p.userId)}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge className={`text-xs ${roleBadgeColor(p.role)}`} variant="secondary">
                          {p.role}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => revokePermMut.mutate(p.userId)}
                          disabled={revokePermMut.isPending}
                          data-testid={`btn-revoke-user-${p.userId}`}
                          aria-label={`Remove ${displayUser(p.userId)}'s access`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add user form */}
              <form onSubmit={handleAddUser} className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[10rem]">
                  <Label htmlFor="share-user-id" className="text-xs text-muted-foreground mb-1 block">
                    User ID or select from list
                  </Label>
                  <Select
                    value={newUserId}
                    onValueChange={setNewUserId}
                  >
                    <SelectTrigger
                      id="share-user-id"
                      className="h-8 text-xs"
                      data-testid="select-share-user"
                    >
                      <SelectValue placeholder="Select a user…" />
                    </SelectTrigger>
                    <SelectContent>
                      {users
                        .filter((u) => !permissions.some((p) => p.userId === u.id))
                        .map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.email || u.username || u.id}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-28 shrink-0">
                  <Label htmlFor="share-user-role" className="text-xs text-muted-foreground mb-1 block">
                    Access
                  </Label>
                  <Select
                    value={newUserRole}
                    onValueChange={(v) => setNewUserRole(v as any)}
                  >
                    <SelectTrigger id="share-user-role" className="h-8 text-xs" data-testid="select-share-user-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERM_ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                  disabled={!newUserId || upsertPermMut.isPending}
                  data-testid="btn-add-user-grant"
                >
                  {upsertPermMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </form>

              {/* Manual ID input as fallback */}
              <div className="mt-2">
                <Input
                  placeholder="Or paste user ID directly…"
                  aria-label="Paste user ID"
                  value={newUserId}
                  onChange={(e) => setNewUserId(e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-share-user-id"
                />
              </div>
            </div>

            {/* ── Current role grants ──────────────────────────────────────── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Users className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Role access</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Grant access to all users with a given role.
              </p>

              {roleGrants.length === 0 ? (
                <p className="text-xs text-muted-foreground italic mb-3">No role grants yet.</p>
              ) : (
                <ul className="mb-3 space-y-2" data-testid="role-grants-list">
                  {roleGrants.map((rg) => (
                    <li
                      key={rg.id}
                      className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
                      data-testid={`role-grant-row-${rg.role}`}
                    >
                      <span className="text-foreground">{displayRole(rg.role)}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge className={`text-xs ${roleBadgeColor(rg.accessLevel)}`} variant="secondary">
                          {rg.accessLevel}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => revokeRoleGrantMut.mutate(rg.role)}
                          disabled={revokeRoleGrantMut.isPending}
                          data-testid={`btn-revoke-role-${rg.role}`}
                          aria-label={`Remove ${displayRole(rg.role)} access`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add role grant form */}
              <form onSubmit={handleAddRoleGrant} className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[10rem]">
                  <Label htmlFor="share-role" className="text-xs text-muted-foreground mb-1 block">Role</Label>
                  <Select value={newRole} onValueChange={setNewRole}>
                    <SelectTrigger id="share-role" className="h-8 text-xs" data-testid="select-share-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {APP_ROLES.filter((r) => r.value !== "ceo").map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-28 shrink-0">
                  <Label htmlFor="share-role-access" className="text-xs text-muted-foreground mb-1 block">Access</Label>
                  <Select
                    value={newRoleAccess}
                    onValueChange={(v) => setNewRoleAccess(v as any)}
                  >
                    <SelectTrigger id="share-role-access" className="h-8 text-xs" data-testid="select-share-role-access">
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
                  className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground shrink-0 mt-[18px]"
                  disabled={upsertRoleGrantMut.isPending}
                  data-testid="btn-add-role-grant"
                >
                  {upsertRoleGrantMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </form>
            </div>

            {/* ── CEO note ───────────────────────────────────────────────── */}
            <p className="text-xs text-muted-foreground border-t pt-3">
              CEO users always have full access to all workbooks, regardless of grants.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
