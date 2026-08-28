/**
 * Task #5295 — Onboarding roster & default person (stage 1 of the New Client
 * Onboarding epic).
 *
 * Admin screen for marking which NoBull users handle new-client onboarding
 * calls and which single one is the default (first-choice) assignee. Modeled
 * on DepartmentMembersDialog's member-list + searchable add-picker pattern,
 * simplified for a flat company-wide roster (no per-department scoping, no
 * ClickUp identity resolution).
 *
 * Reachable from the app nav via QuicklinksBar's "Onboarding Roster" entry
 * (Team menu, team_lead+) as of Task #5298 (stage 4 of the epic).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/admin/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Trash2, UserPlus, Star } from "lucide-react";

interface NoBullUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
}

interface OnboardingAssignee {
  id: string;
  userId: string;
  active: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RosterResponse {
  members: OnboardingAssignee[];
  defaultUserId: string | null;
}

const ROSTER_PATH = "/api/admin/onboarding/roster";
const DEFAULT_PATH = "/api/admin/onboarding/default";

function userLabel(u: NoBullUser | undefined, fallbackId: string): string {
  if (!u) return fallbackId;
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
}

export default function OnboardingRoster() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const rosterQuery = useQuery<RosterResponse>({
    queryKey: [ROSTER_PATH],
    queryFn: async () => {
      const res = await apiRequest("GET", ROSTER_PATH);
      return res.json();
    },
  });
  const usersQuery = useQuery<NoBullUser[]>({
    queryKey: ["/api/users"],
    staleTime: 60_000,
  });

  const allUsers = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const userById = useMemo(() => new Map(allUsers.map((u) => [u.id, u])), [allUsers]);
  const members = useMemo(() => rosterQuery.data?.members ?? [], [rosterQuery.data]);
  const activeMembers = useMemo(() => members.filter((m) => m.active), [members]);
  const defaultUserId = rosterQuery.data?.defaultUserId ?? null;

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

  const [memberSearch, setMemberSearch] = useState("");
  const PICKER_CAP = 50;
  const { visibleCandidates, matchCount } = useMemo(() => {
    const needle = memberSearch.trim().toLowerCase();
    const matches = needle ? candidates.filter((c) => c.haystack.includes(needle)) : candidates;
    return { visibleCandidates: matches.slice(0, PICKER_CAP), matchCount: matches.length };
  }, [candidates, memberSearch]);
  const [pickerOpen, setPickerOpen] = useState(false);

  function invalidateRoster() {
    void queryClient.invalidateQueries({ queryKey: [ROSTER_PATH] });
  }

  const addMember = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("POST", ROSTER_PATH, { userId });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Failed to add");
      }
      return res.json() as Promise<{ member: OnboardingAssignee }>;
    },
    onSuccess: (data) => {
      invalidateRoster();
      toast({ title: `${userLabel(userById.get(data.member.userId), data.member.userId)} added to onboarding roster` });
      setPickerOpen(false);
      setMemberSearch("");
    },
    onError: (err: any) =>
      toast({ title: "Failed to add member", description: err?.message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await apiRequest("PUT", `${ROSTER_PATH}/${id}`, { active });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Failed to update");
      }
      return res.json() as Promise<{ member: OnboardingAssignee; clearedDefault: boolean }>;
    },
    onSuccess: (data) => {
      invalidateRoster();
      if (data.clearedDefault) {
        toast({
          title: "Member deactivated — default cleared",
          description: "They were the default onboarding assignee; set a new default so first-available resolution has one.",
        });
      } else {
        toast({ title: data.member.active ? "Member reactivated" : "Member deactivated" });
      }
    },
    onError: (err: any) =>
      toast({ title: "Failed to update member", description: err?.message, variant: "destructive" }),
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `${ROSTER_PATH}/${id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Failed to remove");
      }
      return res.json() as Promise<{ member: OnboardingAssignee; wasDefault: boolean }>;
    },
    onSuccess: (data) => {
      invalidateRoster();
      toast({
        title: "Member removed",
        description: data.wasDefault ? "They were the default onboarding assignee — set a new default." : undefined,
      });
    },
    onError: (err: any) =>
      toast({ title: "Failed to remove member", description: err?.message, variant: "destructive" }),
  });

  const setDefault = useMutation({
    mutationFn: async (userId: string | null) => {
      const res = await apiRequest("PUT", DEFAULT_PATH, { userId });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Failed to set default");
      }
      return res.json();
    },
    onSuccess: (_data, userId) => {
      invalidateRoster();
      toast({
        title: userId ? `${userLabel(userById.get(userId), userId)} is now the default` : "Default cleared",
      });
    },
    onError: (err: any) =>
      toast({ title: "Failed to set default", description: err?.message, variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <PageHeader
        title="Onboarding Roster"
        backHref="/admin"
        subtitle="Who handles new-client onboarding calls, and who's the default (first-choice) assignee."
      />

      <Card data-testid="card-onboarding-default">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="h-4 w-4" />
            Default assignee
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Later stages of the onboarding tool book new clients with the first available onboarding
            team member, prioritizing this person.
          </p>
          <Select
            value={defaultUserId ?? SELECT_NONE_VALUE}
            onValueChange={(v) => setDefault.mutate(v === SELECT_NONE_VALUE ? null : v)}
            disabled={setDefault.isPending}
          >
            <SelectTrigger className="h-8 text-xs w-64" data-testid="select-onboarding-default">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE_VALUE}>None</SelectItem>
              {activeMembers.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {userLabel(userById.get(m.userId), m.userId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card data-testid="card-onboarding-roster">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Onboarding assignees</CardTitle>
            <Popover
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) setMemberSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-add-onboarding-member">
                  <UserPlus className="h-3.5 w-3.5 mr-1" />
                  Add person
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-80" align="end" data-testid="popover-add-onboarding-member">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search people…"
                    value={memberSearch}
                    onValueChange={setMemberSearch}
                    data-testid="input-onboarding-member-search"
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
                          onSelect={() => addMember.mutate(u.id)}
                          data-testid={`option-add-onboarding-member-${u.id}`}
                        >
                          <div className="min-w-0">
                            <div className="text-sm truncate">{label}</div>
                            {u.email && <div className="text-xs text-muted-foreground truncate">{u.email}</div>}
                          </div>
                        </CommandItem>
                      ))}
                      {matchCount > PICKER_CAP && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="text-onboarding-picker-truncated">
                          Showing {PICKER_CAP} of {matchCount} — keep typing to narrow down.
                        </div>
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </CardHeader>
        <CardContent>
          {rosterQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-onboarding-members">
              No one is on the onboarding roster yet. Add people so a default can be set.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const u = userById.get(m.userId);
                  return (
                    <TableRow key={m.id} data-testid={`row-onboarding-member-${m.id}`}>
                      <TableCell>
                        {u ? (
                          <div className="min-w-0">
                            <div className="text-sm flex items-center gap-1.5">
                              {userLabel(u, m.userId)}
                              {m.isDefault && (
                                <Badge variant="outline" className="text-xs gap-1" data-testid={`badge-default-${m.id}`}>
                                  <Star className="h-2.5 w-2.5" />
                                  Default
                                </Badge>
                              )}
                            </div>
                            {u.email && <div className="text-xs text-muted-foreground truncate">{u.email}</div>}
                          </div>
                        ) : (
                          <span className="font-mono text-xs" title="Unknown user (not in the users list)">
                            {m.userId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.active ? "default" : "secondary"}>
                          {m.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={toggleActive.isPending}
                          onClick={() => toggleActive.mutate({ id: m.id, active: !m.active })}
                          data-testid={`button-toggle-active-${m.id}`}
                        >
                          {m.active ? "Deactivate" : "Reactivate"}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          disabled={removeMember.isPending}
                          aria-label="Remove from roster"
                          data-testid={`button-remove-onboarding-member-${m.id}`}
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
        </CardContent>
      </Card>
    </div>
  );
}
