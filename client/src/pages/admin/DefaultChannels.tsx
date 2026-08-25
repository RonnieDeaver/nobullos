import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Hash, Save, Users, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PageHeader } from "@/components/admin/PageHeader";

interface CommsChannel {
  id: string;
  name: string | null;
  slug: string | null;
  type: string;
  visibility?: string;
  clientId?: string | null;
}

interface ApplyExistingResult {
  usersProcessed: number;
  membershipsAdded: number;
  alreadyMembers: number;
  channelsApplied: Array<{ channelId: string; added: number }>;
  channelsSkipped: Array<{ channelId: string; reason: string }>;
}

interface ApplyRun {
  id: string;
  actorName: string | null;
  timestamp: string;
  usersProcessed: number | null;
  membershipsAdded: number | null;
  alreadyMembers: number | null;
  channelsSkipped: number;
}

interface DefaultChannelsResponse {
  channelIds: string[];
  channels: Array<{
    id: string;
    name: string | null;
    slug: string | null;
    visibility: string | null;
    archivedAt: string | null;
  }>;
}

interface StaffUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export default function DefaultChannels() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyMode, setApplyMode] = useState<"all" | "selected">("all");
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());

  const { data: current, isLoading: loadingCurrent } =
    useQuery<DefaultChannelsResponse>({
      queryKey: ["/api/comms/default-channels"],
      queryFn: () =>
        apiRequest("GET", "/api/comms/default-channels").then((r) => r.json()),
    });

  const { data: allChannels = [], isLoading: loadingChannels } = useQuery<
    CommsChannel[]
  >({
    queryKey: ["/api/comms/channels/public"],
    queryFn: () =>
      apiRequest("GET", "/api/comms/channels/public").then((r) => r.json()),
  });

  // Server-side PUT validation rejects client-bound channels; hide them here
  // so operators can't select an option that would fail on save.
  const channels = allChannels.filter((ch) => !ch.clientId);

  const { data: runsData, isLoading: loadingRuns } = useQuery<{
    runs: ApplyRun[];
  }>({
    queryKey: ["/api/comms/default-channels/apply-runs"],
    queryFn: () =>
      apiRequest("GET", "/api/comms/default-channels/apply-runs").then((r) =>
        r.json(),
      ),
  });
  const runs = runsData?.runs ?? [];

  useEffect(() => {
    if (current && !dirty) {
      setSelected(new Set(current.channelIds));
    }
  }, [current, dirty]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/comms/default-channels", {
        channelIds: Array.from(selected),
      }).then((r) => r.json()),
    onSuccess: (data: { channelIds: string[] }) => {
      qc.setQueryData(["/api/comms/default-channels"], (prev: any) => ({
        ...(prev ?? {}),
        channelIds: data.channelIds,
      }));
      void qc.invalidateQueries({ queryKey: ["/api/comms/default-channels"] }); // fire-and-forget: cache refresh only
      setDirty(false);
      toast({ title: "Default channels saved" });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to save default channels",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    },
  });

  const { data: staffUsers = [], isLoading: loadingUsers } = useQuery<
    StaffUser[]
  >({
    queryKey: ["/api/users"],
    queryFn: () => apiRequest("GET", "/api/users").then((r) => r.json()),
    enabled: applyOpen,
  });

  const applyMutation = useMutation({
    mutationFn: (userIds?: string[]) =>
      apiRequest(
        "POST",
        "/api/comms/default-channels/apply-existing",
        userIds ? { userIds } : {},
      ).then((r) => r.json() as Promise<ApplyExistingResult>),
    onSuccess: (data, userIds) => {
      setApplyOpen(false);
      void qc.invalidateQueries({
        queryKey: ["/api/comms/default-channels/apply-runs"],
      }); // fire-and-forget: cache refresh only
      toast({
        title: userIds
          ? `Default channels applied to ${data.usersProcessed} selected team member${data.usersProcessed === 1 ? "" : "s"}`
          : "Default channels applied to existing team members",
        description:
          data.membershipsAdded > 0
            ? `${data.membershipsAdded} membership(s) added across ${data.channelsApplied.filter((c) => c.added > 0).length} channel(s). ${data.alreadyMembers} already-member(s) untouched.`
            : userIds
              ? "Everyone selected was already a member — nothing to change."
              : "Everyone was already a member — nothing to change.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to apply default channels",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    },
  });

  const toggle = (id: string) => {
    setDirty(true);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isLoading = loadingCurrent || loadingChannels;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Default Channels for New Team Members"
        icon={Hash}
        backHref="/"
        backLabel="Dashboard"
        titleTestId="text-default-channels-title"
        actions={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Button
            variant="outline"
            disabled={
              dirty ||
              applyMutation.isPending ||
              (current?.channelIds.length ?? 0) === 0
            }
            onClick={() => {
              setApplyMode("all");
              setSelectedUsers(new Set());
              setApplyOpen(true);
            }}
            data-testid="button-apply-existing-users"
          >
            {applyMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Users className="h-4 w-4 mr-2" />
            )}
            Apply to existing team members
          </Button>
          <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
            <DialogContent data-testid="dialog-apply-existing-confirm">
              <DialogHeader>
                <DialogTitle>
                  Add existing team members to the default channels
                </DialogTitle>
                <DialogDescription>
                  Chosen team members will be joined to the{" "}
                  {current?.channelIds.length ?? 0} saved default channel
                  {(current?.channelIds.length ?? 0) === 1 ? "" : "s"}. People
                  who are already members are left untouched, and archived or
                  client channels are skipped. This action is recorded in the
                  activity log.
                </DialogDescription>
              </DialogHeader>
              <RadioGroup
                value={applyMode}
                onValueChange={(v) => setApplyMode(v as "all" | "selected")}
                className="space-y-1"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="all"
                    id="apply-mode-all"
                    data-testid="radio-apply-mode-all"
                  />
                  <Label htmlFor="apply-mode-all" className="cursor-pointer">
                    Everyone (all current team members)
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="selected"
                    id="apply-mode-selected"
                    data-testid="radio-apply-mode-selected"
                  />
                  <Label htmlFor="apply-mode-selected" className="cursor-pointer">
                    Only specific people
                  </Label>
                </div>
              </RadioGroup>
              {applyMode === "selected" && (
                <div
                  className="max-h-56 overflow-y-auto border rounded-md divide-y"
                  data-testid="list-apply-user-picker"
                >
                  {loadingUsers ? (
                    <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading team
                      members…
                    </div>
                  ) : staffUsers.length === 0 ? (
                    <p
                      className="p-3 text-sm text-muted-foreground"
                      data-testid="text-no-users"
                    >
                      No team members found.
                    </p>
                  ) : (
                    staffUsers.map((u) => {
                      const name =
                        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
                        u.email ||
                        u.id;
                      return (
                        <label
                          key={u.id}
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50"
                          data-testid={`row-apply-user-${u.id}`}
                        >
                          <Checkbox
                            checked={selectedUsers.has(u.id)}
                            onCheckedChange={() =>
                              setSelectedUsers((prev) => {
                                const next = new Set(prev);
                                if (next.has(u.id)) next.delete(u.id);
                                else next.add(u.id);
                                return next;
                              })
                            }
                            data-testid={`checkbox-apply-user-${u.id}`}
                          />
                          <span className="text-sm">{name}</span>
                          {u.email && name !== u.email && (
                            <span className="ml-auto text-xs text-muted-foreground">
                              {u.email}
                            </span>
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setApplyOpen(false)}
                  data-testid="button-apply-existing-cancel"
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    applyMutation.isPending ||
                    (applyMode === "selected" && selectedUsers.size === 0)
                  }
                  onClick={() =>
                    applyMutation.mutate(
                      applyMode === "selected"
                        ? Array.from(selectedUsers)
                        : undefined,
                    )
                  }
                  data-testid="button-apply-existing-confirm"
                >
                  {applyMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {applyMode === "selected"
                    ? `Add ${selectedUsers.size} member${selectedUsers.size === 1 ? "" : "s"}`
                    : "Add all members"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            data-testid="button-save-default-channels"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </div>
        }
      />

      <p className="text-sm text-muted-foreground">
        New team members are automatically added to the channels checked below
        the moment their account is created. Changing this list does not affect
        existing users automatically — use "Apply to existing team members" to
        bulk-join current staff. Client channels and archived channels cannot
        be defaults.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading channels…
        </div>
      ) : channels.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-channels">
          No public channels exist yet.
        </p>
      ) : (
        <div className="space-y-1 border rounded-md divide-y">
          {channels.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50"
              data-testid={`row-default-channel-${c.id}`}
            >
              <Checkbox
                checked={selected.has(c.id)}
                onCheckedChange={() => toggle(c.id)}
                data-testid={`checkbox-default-channel-${c.id}`}
              />
              <span className="flex items-center gap-1 text-sm">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                {c.name ?? c.slug ?? c.id}
              </span>
              {selected.has(c.id) && (
                <Badge variant="secondary" className="ml-auto">
                  default
                </Badge>
              )}
            </label>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold" data-testid="text-apply-runs-title">
            Recent bulk-add runs
          </h2>
        </div>
        {loadingRuns ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading run history…
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-apply-runs">
            No bulk-add runs yet. Use "Apply to existing team members" to run
            the first one.
          </p>
        ) : (
          <div className="border rounded-md divide-y">
            {runs.map((run) => (
              <div
                key={run.id}
                className="px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1"
                data-testid={`row-apply-run-${run.id}`}
              >
                <span className="font-medium" data-testid={`text-apply-run-actor-${run.id}`}>
                  {run.actorName ?? "Unknown user"}
                </span>
                <span
                  className="text-muted-foreground"
                  data-testid={`text-apply-run-time-${run.id}`}
                >
                  {new Date(run.timestamp).toLocaleString()}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <Badge variant="secondary" data-testid={`badge-apply-run-added-${run.id}`}>
                    {run.membershipsAdded ?? 0} added
                  </Badge>
                  <Badge variant="outline" data-testid={`badge-apply-run-already-${run.id}`}>
                    {run.alreadyMembers ?? 0} already members
                  </Badge>
                  {run.channelsSkipped > 0 && (
                    <Badge
                      variant="outline"
                      className="text-amber-600"
                      data-testid={`badge-apply-run-skipped-${run.id}`}
                    >
                      {run.channelsSkipped} channel
                      {run.channelsSkipped === 1 ? "" : "s"} skipped
                    </Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
