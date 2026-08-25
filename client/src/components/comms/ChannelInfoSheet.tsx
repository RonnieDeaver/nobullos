import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  X,
  Hash,
  Lock,
  Unlock,
  Archive,
  ArchiveRestore,
  Shield,
  ShieldMinus,
  UserMinus,
  Loader2,
  Check,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import type { CommsChannel } from "./types";

interface MemberWithUser {
  channelId: string;
  userId: string;
  role: string;
  joinedAt: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
    email: string | null;
  } | null;
}

function memberName(m: MemberWithUser): string {
  if (!m.user) return m.userId;
  return [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") || m.user.email || m.userId;
}

function isChannelAdmin(role: string): boolean {
  return role === "owner" || role === "channel_admin";
}

interface Props {
  channel: CommsChannel;
  currentUserId: string;
  onClose: () => void;
  onChannelUpdated: () => void;
}

export function ChannelInfoSheet({ channel, currentUserId, onClose, onChannelUpdated }: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const userRole = (user as any)?.dbUser?.role ?? "";
  const isTeamLead = userRole === "team_lead" || userRole === "ceo";

  const [editName, setEditName] = useState(channel.name ?? "");
  const [editTopic, setEditTopic] = useState(channel.topic ?? "");
  const [editDescription, setEditDescription] = useState(channel.description ?? "");
  const [editingField, setEditingField] = useState<"name" | "topic" | "description" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showPrivacyDialog, setShowPrivacyDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [privacyChanging, setPrivacyChanging] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const membersKey = `/api/comms/channels/${channel.id}/members`;
  const { data: members = [], isLoading: membersLoading, refetch: refetchMembers } = useQuery<MemberWithUser[]>({
    queryKey: [membersKey],
    queryFn: () => fetch(membersKey).then((r) => r.json()),
  });

  const statsKey = `/api/comms/channels/${channel.id}/stats`;
  const { data: stats } = useQuery<{ memberCount: number; messageCount: number }>({
    queryKey: [statsKey],
    queryFn: () => fetch(statsKey).then((r) => r.json()),
  });

  const currentUserMember = members.find((m) => m.userId === currentUserId);
  const currentUserIsAdmin = isTeamLead || (currentUserMember ? isChannelAdmin(currentUserMember.role) : false);

  const isChannelType = channel.type === "channel";

  const saveField = useCallback(
    async (field: "name" | "topic" | "description") => {
      setSaving(true);
      setError(null);
      try {
        const body: Record<string, string | null> = {};
        if (field === "name") body.name = editName.trim();
        if (field === "topic") body.topic = editTopic.trim() || null;
        if (field === "description") body.description = editDescription.trim() || null;

        const res = await apiRequest("PATCH", `/api/comms/channels/${channel.id}`, body);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Failed to save");
        } else {
          setEditingField(null);
          void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channel.id}`] }); // fire-and-forget: cache refresh only
          onChannelUpdated();
        }
      } catch {
        setError("Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [channel.id, editName, editTopic, editDescription, qc, onChannelUpdated],
  );

  const handlePrivacyToggle = async () => {
    setPrivacyChanging(true);
    setShowPrivacyDialog(false);
    try {
      const newVisibility = channel.visibility === "public" ? "private" : "public";
      const res = await apiRequest("PATCH", `/api/comms/channels/${channel.id}/privacy`, {
        visibility: newVisibility,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update privacy");
      } else {
        onChannelUpdated();
      }
    } catch {
      setError("Failed to update privacy");
    } finally {
      setPrivacyChanging(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    setShowArchiveDialog(false);
    try {
      const res = await apiRequest("DELETE", `/api/comms/channels/${channel.id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to archive");
      } else {
        onChannelUpdated();
        onClose();
      }
    } catch {
      setError("Failed to archive");
    } finally {
      setArchiving(false);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const res = await apiRequest("POST", `/api/comms/channels/${channel.id}/unarchive`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to restore");
      } else {
        onChannelUpdated();
      }
    } catch {
      setError("Failed to restore");
    } finally {
      setRestoring(false);
    }
  };

  // Task #4621: removal confirms through the shared ConfirmActionDialog
  // (controlled mode). Same endpoint, same guards as the old window.confirm.
  const [pendingKickUid, setPendingKickUid] = useState<string | null>(null);
  const handleKick = async (uid: string) => {
    try {
      const res = await apiRequest("DELETE", `/api/comms/channels/${channel.id}/members/${uid}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to remove member");
      } else {
        void refetchMembers(); // fire-and-forget: refetch only
      }
    } catch {
      setError("Failed to remove member");
    }
  };

  const handleRoleChange = async (uid: string, newRole: "channel_admin" | "member") => {
    try {
      const res = await apiRequest("PATCH", `/api/comms/channels/${channel.id}/members/${uid}/role`, {
        role: newRole,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update role");
      } else {
        void refetchMembers(); // fire-and-forget: refetch only
      }
    } catch {
      setError("Failed to update role");
    }
  };

  return (
    <div className="flex flex-col h-full border-l border-border bg-background" data-testid="channel-info-sheet">
      <ConfirmActionDialog
        open={!!pendingKickUid}
        onOpenChange={(open) => { if (!open) setPendingKickUid(null); }}
        title="Remove this member from the channel?"
        description="They immediately lose access to the channel and its history. They can be re-invited later; nothing they posted is deleted."
        confirmLabel="Remove member"
        testId="dialog-confirm-kick-member"
        onConfirm={() => {
          if (pendingKickUid) void handleKick(pendingKickUid);
          setPendingKickUid(null);
        }}
      />
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          {channel.visibility === "private" ? (
            <Lock className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Hash className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-semibold text-sm truncate max-w-[180px]">
            {channel.name ?? "Channel info"}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          data-testid="channel-info-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs" data-testid="channel-info-error">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {channel.archivedAt && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              This channel is archived. It is read-only and hidden from the sidebar.
            </div>
          )}

          {/* Channel name */}
          {isChannelType && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Channel name</span>
                {editingField !== "name" && !channel.archivedAt && (
                  <button
                    onClick={() => { setEditName(channel.name ?? ""); setEditingField("name"); }}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="edit-channel-name-btn"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              {editingField === "name" ? (
                <div className="space-y-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Channel name"
                    maxLength={80}
                    className="h-8 text-sm"
                    autoFocus
                    data-testid="channel-name-input"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => saveField("name")}
                      disabled={saving || !editName.trim()}
                      data-testid="channel-name-save"
                    >
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setEditingField(null)}
                      data-testid="channel-name-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm">{channel.name ?? <span className="text-muted-foreground italic">No name</span>}</p>
              )}
            </div>
          )}

          {/* Topic */}
          {isChannelType && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Topic</span>
                {editingField !== "topic" && !channel.archivedAt && (
                  <button
                    onClick={() => { setEditTopic(channel.topic ?? ""); setEditingField("topic"); }}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="edit-topic-btn"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              {editingField === "topic" ? (
                <div className="space-y-2">
                  <Input
                    value={editTopic}
                    onChange={(e) => setEditTopic(e.target.value)}
                    placeholder="What's this channel about?"
                    maxLength={500}
                    className="h-8 text-sm"
                    autoFocus
                    data-testid="channel-topic-input"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => saveField("topic")}
                      disabled={saving}
                      data-testid="channel-topic-save"
                    >
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setEditingField(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {channel.topic || <span className="italic">No topic set</span>}
                </p>
              )}
            </div>
          )}

          {/* Description */}
          {isChannelType && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Description</span>
                {editingField !== "description" && !channel.archivedAt && (
                  <button
                    onClick={() => { setEditDescription(channel.description ?? ""); setEditingField("description"); }}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="edit-description-btn"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              {editingField === "description" ? (
                <div className="space-y-2">
                  <Textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Describe this channel…"
                    maxLength={1000}
                    className="text-sm resize-none"
                    rows={3}
                    autoFocus
                    data-testid="channel-description-input"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => saveField("description")}
                      disabled={saving}
                      data-testid="channel-description-save"
                    >
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setEditingField(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {channel.description || <span className="italic">No description</span>}
                </p>
              )}
            </div>
          )}

          {/* Stats */}
          {stats && (
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span data-testid="channel-member-count">{stats.memberCount} member{stats.memberCount !== 1 ? "s" : ""}</span>
              <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
            </div>
          )}

          {/* Created-by metadata */}
          <div className="text-xs text-muted-foreground" data-testid="channel-created-info">
            {(() => {
              const creator = channel.createdBy
                ? members.find((m) => m.userId === channel.createdBy)
                : null;
              const creatorLabel = creator
                ? memberName(creator)
                : channel.createdBy ?? null;
              const dateLabel = new Date(channel.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              });
              return creatorLabel
                ? `Created by ${creatorLabel} · ${dateLabel}`
                : `Created ${dateLabel}`;
            })()}
          </div>

          {/* Privacy & admin actions */}
          {isChannelType && currentUserIsAdmin && (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Channel settings
              </span>
              <div className="flex flex-col gap-2">
                {!channel.archivedAt && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start gap-2 text-xs"
                    onClick={() => setShowPrivacyDialog(true)}
                    disabled={privacyChanging}
                    data-testid="toggle-privacy-btn"
                  >
                    {privacyChanging ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : channel.visibility === "public" ? (
                      <Lock className="h-3.5 w-3.5" />
                    ) : (
                      <Unlock className="h-3.5 w-3.5" />
                    )}
                    {channel.visibility === "public" ? "Make private" : "Make public"}
                  </Button>
                )}
                {channel.archivedAt ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start gap-2 text-xs"
                    onClick={handleRestore}
                    disabled={restoring}
                    data-testid="restore-channel-btn"
                  >
                    {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                    Restore channel
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start gap-2 text-xs text-destructive hover:text-destructive"
                    onClick={() => setShowArchiveDialog(true)}
                    disabled={archiving}
                    data-testid="archive-channel-btn"
                  >
                    {archiving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                    Archive channel
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Members */}
          <div>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Members
            </span>
            {membersLoading && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <div className="mt-2 space-y-1">
              {members.map((m) => {
                const isAdmin = isChannelAdmin(m.role);
                const isSelf = m.userId === currentUserId;
                return (
                  <div
                    key={m.userId}
                    className="flex items-center gap-2 py-1.5 group"
                    data-testid={`member-row-${m.userId}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-sm truncate", isSelf && "font-medium")}>
                          {memberName(m)}
                          {isSelf && <span className="text-muted-foreground text-xs ml-1">(you)</span>}
                        </span>
                        {isAdmin && (
                          <Badge variant="secondary" className="text-caption px-1 py-0 h-4">
                            Admin
                          </Badge>
                        )}
                      </div>
                      {m.user?.email && (
                        <p className="text-caption text-muted-foreground truncate">{m.user.email}</p>
                      )}
                    </div>
                    {currentUserIsAdmin && !isSelf && isChannelType && !channel.archivedAt && (
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleRoleChange(m.userId, isAdmin ? "member" : "channel_admin")}
                          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          title={isAdmin ? "Demote to member" : "Promote to admin"}
                          data-testid={`member-role-toggle-${m.userId}`}
                        >
                          {isAdmin ? <ShieldMinus className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={() => setPendingKickUid(m.userId)}
                          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                          title="Remove from channel"
                          data-testid={`member-kick-${m.userId}`}
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* Privacy conversion confirmation dialog */}
      <AlertDialog open={showPrivacyDialog} onOpenChange={setShowPrivacyDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {channel.visibility === "public" ? "Make channel private?" : "Make channel public?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {channel.visibility === "public"
                ? "Making this channel private means only current and explicitly added members can access it. This action cannot be undone without channel admin access."
                : "Making this channel public means any team member can find and read it. A system message will be posted announcing the change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePrivacyToggle} data-testid="privacy-confirm-btn">
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive confirmation dialog */}
      <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this channel?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived channels are hidden from the sidebar and become read-only. Message history is preserved and the channel can be restored later by a channel admin or team lead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="archive-confirm-btn"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
