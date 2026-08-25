// Task #4002 — shared department-membership editor dialog.
//
// Used by Service Desk Settings (Departments tab) and the Role Assignments
// console. Opens as a dialog right where the operator clicked — the old
// settings implementation toggled a panel rendered below the entire
// departments table (15+ rows in production), far off-screen, so "Manage
// members" looked like a no-op.
//
// - Members are listed with names/emails (joined client-side from /api/users);
//   raw UUIDs only appear as a fallback for unknown users.
// - Adding a member is a searchable people picker over NoBull users (current
//   active members excluded; inactive ones re-appear and re-adding
//   reactivates them). The ClickUp identity is auto-resolved server-side from
//   the user's connected ClickUp account; a manual override field stays
//   available for people without one.
// - Membership changes invalidate the departments list (member counts), the
//   department's member list, and the coverage grid so role pickers reflect
//   the change immediately — no page reload.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, UserPlus } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface NoBullUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
}

interface SdDepartmentMember {
  id: string;
  departmentId: string;
  userId: string;
  clickupUserId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MembersDialogDepartment {
  id: string;
  name: string;
  assignmentScope?: "per_client" | "company";
  defaultPrimaryUserId?: string | null;
  defaultCheckerUserId?: string | null;
  roleCapabilities?: {
    checker: boolean;
  };
}

function userLabel(u: NoBullUser | undefined, fallbackId: string): string {
  if (!u) return fallbackId;
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
}

// ── Component ────────────────────────────────────────────────────────────────

export function DepartmentMembersDialog({
  department,
  onOpenChange,
  showRoleDefaults = false,
  apiScope = "service-desk",
}: {
  /** The department being managed; null renders nothing (dialog closed). */
  department: MembersDialogDepartment | null;
  onOpenChange: (open: boolean) => void;
  /**
   * Show the Doer/Checker default-holder controls (Task #4171 —
   * saved via the team-lead PUT /departments/:id/role-defaults endpoint).
   * Service Desk Settings turns this on; the Role Assignments console keeps
   * it hidden because its Company & defaults tab already edits the same
   * slots.
   */
  showRoleDefaults?: boolean;
  /** Universal console uses the neutral assignment API; legacy settings keep
   * the Service Desk compatibility paths. */
  apiScope?: "service-desk" | "universal";
}) {
  // Keyed remount per department so per-department state (drafts, pending
  // pick) never leaks between departments and needs no sync effects.
  if (!department) return null;
  return (
    <MembersDialogInner
      key={department.id}
      department={department}
      onOpenChange={onOpenChange}
      showRoleDefaults={showRoleDefaults}
      apiScope={apiScope}
    />
  );
}

function MembersDialogInner({
  department,
  onOpenChange,
  showRoleDefaults,
  apiScope,
}: {
  department: MembersDialogDepartment;
  onOpenChange: (open: boolean) => void;
  showRoleDefaults: boolean;
  apiScope: "service-desk" | "universal";
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const membersPath =
    apiScope === "universal"
      ? `/api/admin/role-assignments/departments/${department.id}/members`
      : `/api/service-desk/departments/${department.id}/members`;
  const roleDefaultsPath =
    apiScope === "universal"
      ? `/api/admin/role-assignments/departments/${department.id}`
      : `/api/service-desk/departments/${department.id}/role-defaults`;
  const coverageQueryKey =
    apiScope === "universal" ? "/api/admin/role-assignments" : "/api/service-desk/coverage";

  const membersQuery = useQuery<{ members: SdDepartmentMember[] }>({
    queryKey: [membersPath],
    queryFn: async () => {
      const res = await apiRequest("GET", membersPath);
      return res.json();
    },
  });

  const usersQuery = useQuery<NoBullUser[]>({
    queryKey: ["/api/users"],
    staleTime: 60_000,
  });

  const allUsers = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const userById = useMemo(() => new Map(allUsers.map((u) => [u.id, u])), [allUsers]);
  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data]);

  // Picker candidates: everyone who is not already an ACTIVE member. Inactive
  // members stay pickable — re-adding them reactivates the membership.
  const activeMemberIds = useMemo(
    () => new Set(members.filter((m) => m.active).map((m) => m.userId)),
    [members],
  );
  const candidates = useMemo(
    () =>
      allUsers
        .filter((u) => !activeMemberIds.has(u.id))
        .map((u) => ({ user: u, label: userLabel(u, u.id), haystack: `${userLabel(u, u.id)} ${u.email ?? ""} ${u.id}`.toLowerCase() }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [allUsers, activeMemberIds],
  );

  // The users list can be thousands of rows; cmdk renders (and re-scores)
  // every CommandItem, so we filter ourselves (shouldFilter={false}) and cap
  // what's rendered. Typing narrows the match set server-free.
  const [memberSearch, setMemberSearch] = useState("");
  const PICKER_CAP = 50;
  const { visibleCandidates, matchCount } = useMemo(() => {
    const needle = memberSearch.trim().toLowerCase();
    const matches = needle
      ? candidates.filter((c) => c.haystack.includes(needle))
      : candidates;
    return { visibleCandidates: matches.slice(0, PICKER_CAP), matchCount: matches.length };
  }, [candidates, memberSearch]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [clickupOverride, setClickupOverride] = useState("");
  // Task #4171 — supported department-level role slots (defaults for
  // per-client departments; THE company-wide holders for company scope).
  const [defaultsDraft, setDefaultsDraft] = useState({
    primary: department.defaultPrimaryUserId ?? "",
    checker: department.defaultCheckerUserId ?? "",
  });
  const [savingDefaults, setSavingDefaults] = useState(false);
  const isCompanyScope = (department.assignmentScope ?? "per_client") === "company";
  const checkerCapable = department.roleCapabilities?.checker === true;

  const pendingUser = pendingUserId ? userById.get(pendingUserId) : undefined;
  const pendingReactivation = pendingUserId
    ? members.some((m) => m.userId === pendingUserId && !m.active)
    : false;

  function invalidateMembershipData() {
    // Prefix-invalidates the departments list (member counts) AND every
    // per-department members query; coverage feeds the role pickers.
    void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] });
    void queryClient.invalidateQueries({ queryKey: [coverageQueryKey] });
  }

  const addMember = useMutation({
    mutationFn: async ({ userId, clickupUserId }: { userId: string; clickupUserId: string | null }) => {
      const res = await apiRequest("POST", membersPath, {
        userId,
        clickupUserId,
      });
      return res.json() as Promise<{
        member: SdDepartmentMember;
        clickupResolution: "manual" | "connected" | "none";
      }>;
    },
    onSuccess: (data) => {
      invalidateMembershipData();
      const name = userLabel(userById.get(data.member.userId), data.member.userId);
      const description =
        data.clickupResolution === "connected"
          ? `${name} — ClickUp account linked automatically.`
          : data.clickupResolution === "manual"
            ? `${name} — manual ClickUp ID saved.`
            : `${name} added. No connected ClickUp account found — set a ClickUp ID manually if they need ClickUp task assignment.`;
      toast({ title: "Member added", description });
      setPendingUserId(null);
      setClickupOverride("");
    },
    onError: (err: any) =>
      toast({ title: "Failed to add member", description: err?.message, variant: "destructive" }),
  });

  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      const res = await apiRequest(
        "DELETE",
        `${membersPath}/${memberId}`,
      );
      return res.json() as Promise<{
        success: boolean;
        clearedAssignments?: { clientId: string; clearedPrimary: boolean; clearedChecker: boolean }[];
        clearedDepartmentSlots?: { clearedPrimary: boolean; clearedChecker: boolean };
      }>;
    },
    onSuccess: (data) => {
      invalidateMembershipData();
      const cleared = data?.clearedAssignments ?? [];
      const slots = data?.clearedDepartmentSlots;
      const clearedSlotNames = [
        slots?.clearedPrimary ? "Doer" : null,
        slots?.clearedChecker ? "Checker" : null,
      ].filter(Boolean) as string[];
      const slotNote =
        clearedSlotNames.length > 0
          ? ` They were also this department's ${isCompanyScope ? "company-wide" : "default"} ${clearedSlotNames.join(
              " and ",
            )} — that slot is now empty.`
          : "";
      if (cleared.length > 0 || clearedSlotNames.length > 0) {
        toast({
          title: "Member removed — assignments cleared",
          description:
            (cleared.length > 0
              ? `${cleared.length} client assignment${cleared.length === 1 ? "" : "s"} referenced this member and now need${cleared.length === 1 ? "s" : ""} a new owner. Check the Coverage panel.`
              : "") + slotNote,
        });
      } else {
        toast({ title: "Member removed" });
      }
    },
    onError: (err: any) =>
      toast({ title: "Failed to remove member", description: err?.message, variant: "destructive" }),
  });

  async function saveRoleDefaults() {
    setSavingDefaults(true);
    try {
      const res = await apiRequest("PUT", roleDefaultsPath, {
        defaultPrimaryUserId: defaultsDraft.primary || null,
        ...(checkerCapable ? { defaultCheckerUserId: defaultsDraft.checker || null } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Save failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] });
      await queryClient.invalidateQueries({ queryKey: [coverageQueryKey] });
      toast({ title: isCompanyScope ? "Company roles saved" : "Department defaults saved" });
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSavingDefaults(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto" data-testid="dialog-dept-members">
        <DialogHeader>
          <DialogTitle>Members — {department.name}</DialogTitle>
          <DialogDescription>
            People in this department are selectable for its supported roles.
          </DialogDescription>
        </DialogHeader>

        {showRoleDefaults && (
          <div className="space-y-2" data-testid="dept-role-defaults-section">
            <p className="text-xs text-muted-foreground">
              {isCompanyScope
                ? "Company-wide role holders cover every client for this department."
                : "Department defaults — used for any client without an explicit person, and pre-filled when adding a client."}
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              {([
                ["primary", "Doer", "select-dept-default-primary"],
                ...(checkerCapable
                  ? [["checker", "Checker", "select-dept-default-checker"] as const]
                  : []),
              ] as Array<["primary" | "checker", string, string]>).map(([key, label, testId]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">
                    {isCompanyScope ? `Company ${label}` : `Default ${label}`}
                  </Label>
                  <Select
                    value={defaultsDraft[key] || SELECT_NONE_VALUE}
                    onValueChange={(v) =>
                      setDefaultsDraft((prev) => ({ ...prev, [key]: v === SELECT_NONE_VALUE ? "" : v }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs w-44" data-testid={testId}>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_NONE_VALUE}>None</SelectItem>
                      {members
                        .filter((m) => m.active)
                        .map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {userLabel(userById.get(m.userId), m.userId)}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={saveRoleDefaults}
                disabled={savingDefaults}
                data-testid="button-save-dept-default-primary"
              >
                {savingDefaults ? "Saving…" : isCompanyScope ? "Save company roles" : "Save defaults"}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {members.filter((m) => m.active).length} active member
              {members.filter((m) => m.active).length === 1 ? "" : "s"}
            </p>
            <Popover
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) setMemberSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-add-member">
                  <UserPlus className="h-3.5 w-3.5 mr-1" />
                  Add member
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-80" align="end" data-testid="popover-add-member">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search people…"
                    value={memberSearch}
                    onValueChange={setMemberSearch}
                    data-testid="input-member-search"
                  />
                  <CommandList className="max-h-56">
                    <CommandEmpty>
                      {usersQuery.isLoading ? "Loading people…" : "No matching people."}
                    </CommandEmpty>
                    <CommandGroup>
                      {visibleCandidates.map(({ user: u, label }) => (
                        <CommandItem
                          key={u.id}
                          value={u.id}
                          onSelect={() => {
                            setPendingUserId(u.id);
                            setClickupOverride("");
                            setPickerOpen(false);
                            setMemberSearch("");
                          }}
                          data-testid={`option-add-member-${u.id}`}
                        >
                          <div className="min-w-0">
                            <div className="text-sm truncate">{label}</div>
                            {u.email && <div className="text-xs text-muted-foreground truncate">{u.email}</div>}
                          </div>
                        </CommandItem>
                      ))}
                      {matchCount > PICKER_CAP && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="text-picker-truncated">
                          Showing {PICKER_CAP} of {matchCount} — keep typing to narrow down.
                        </div>
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {pendingUser && (
            <div className="rounded-md border border-dashed p-3 space-y-2" data-testid="pending-add-member">
              <div className="text-sm">
                Adding <span className="font-medium">{userLabel(pendingUser, pendingUser.id)}</span>
                {pendingUser.email && <span className="text-muted-foreground"> · {pendingUser.email}</span>}
                {pendingReactivation && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    Reactivates previous membership
                  </Badge>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground" htmlFor="clickup-override">
                  ClickUp user ID (optional override)
                </Label>
                <Input
                  id="clickup-override"
                  className="h-8 text-xs"
                  placeholder="Auto-detected from their connected ClickUp account"
                  value={clickupOverride}
                  onChange={(e) => setClickupOverride(e.target.value)}
                  data-testid="input-member-clickup-override"
                />
                <p className="text-[11px] text-muted-foreground">
                  Leave blank to link their connected ClickUp account automatically.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={addMember.isPending}
                  onClick={() =>
                    addMember.mutate({
                      userId: pendingUser.id,
                      clickupUserId: clickupOverride.trim() || null,
                    })
                  }
                  data-testid="button-confirm-add-member"
                >
                  {addMember.isPending ? "Adding…" : "Add to department"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPendingUserId(null);
                    setClickupOverride("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {membersQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-members">
              No members yet. Add people so they can be assigned Doer/Checker roles for this
              department's clients.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>ClickUp ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const u = userById.get(m.userId);
                  return (
                    <TableRow key={m.id} data-testid={`row-member-${m.id}`}>
                      <TableCell>
                        {u ? (
                          <div className="min-w-0">
                            <div className="text-sm">{userLabel(u, m.userId)}</div>
                            {u.email && <div className="text-xs text-muted-foreground truncate">{u.email}</div>}
                          </div>
                        ) : (
                          <span className="font-mono text-xs" title="Unknown user (not in the users list)">
                            {m.userId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.clickupUserId ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={m.active ? "default" : "secondary"}>
                          {m.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          disabled={removeMember.isPending}
                          aria-label="Remove member"
                          data-testid={`button-remove-member-${m.id}`}
                          onClick={() => removeMember.mutate(m.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
