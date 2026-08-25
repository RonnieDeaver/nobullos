import { useState, useEffect } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  Plus, Pin, PinOff, Pencil, Archive, Search, Filter, ChevronDown, ChevronUp,
  Lightbulb, MessageSquare, Users, Eye, Globe, Heart, AlertTriangle, Target,
  FileCheck, BookOpen, CalendarCheck, Bell, Trophy, TrendingUp, X, ClipboardList
} from "lucide-react";

const ENTRY_TYPE_OPTIONS: { value: string; label: string; icon: any; color: string }[] = [
  { value: "strategy_insight", label: "Strategy Insight", icon: Lightbulb, color: "bg-purple-100 text-purple-800" },
  { value: "client_preference", label: "Client Preference", icon: Users, color: "bg-green-100 text-green-800" },
  { value: "meeting_takeaway", label: "Meeting Takeaway", icon: MessageSquare, color: "bg-blue-100 text-blue-800" },
  { value: "goal_change", label: "Goal Change", icon: Target, color: "bg-indigo-100 text-indigo-800" },
  { value: "risk", label: "Risk", icon: AlertTriangle, color: "bg-red-100 text-red-800" },
  { value: "opportunity", label: "Opportunity", icon: TrendingUp, color: "bg-emerald-100 text-emerald-800" },
  { value: "relationship_note", label: "Relationship Note", icon: Heart, color: "bg-pink-100 text-pink-800" },
  { value: "internal_observation", label: "Internal Observation", icon: Eye, color: "bg-cyan-100 text-cyan-800" },
  { value: "competitive_context", label: "Competitive Context", icon: Globe, color: "bg-orange-100 text-orange-800" },
  { value: "escalation", label: "Escalation", icon: Bell, color: "bg-red-100 text-red-800" },
  { value: "win_progress", label: "Win Progress", icon: Trophy, color: "bg-yellow-100 text-yellow-800" },
  { value: "priority_shift", label: "Priority Shift", icon: CalendarCheck, color: "bg-teal-100 text-teal-800" },
  { value: "budget_context", label: "Budget Context", icon: FileCheck, color: "bg-amber-100 text-amber-800" },
  { value: "product_context", label: "Product Context", icon: BookOpen, color: "bg-violet-100 text-violet-800" },
];

// Status filter options. "draft" was retired (Task #3713): notes publish
// immediately on create, so the only views are published ("approved" is the
// stored value — unchanged in the DB) and archived.
const STATUS_OPTIONS = [
  { value: "approved", label: "Published" },
  { value: "archived", label: "Archived" },
];

type IntelligenceFeedEntry = {
  id: string;
  clientId: string;
  createdBy: string;
  entryType: string;
  title: string;
  body: string | null;
  tags: string[] | null;
  sourceReferences: any;
  aiConfidence: string | null;
  status: string;
  pinned: boolean;
  linkedActionLogIds: string[] | null;
  linkedCommandPanelFields: string[] | null;
  createdAt: string;
  updatedAt: string;
};

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

function getEntryTypeMeta(type: string) {
  return ENTRY_TYPE_OPTIONS.find(o => o.value === type) || ENTRY_TYPE_OPTIONS[0];
}

function EntryCard({
  entry,
  users,
  currentUser,
  onEdit,
  onTogglePin,
  onArchive,
  onPromote,
  onNavigateToActionLog,
}: {
  entry: IntelligenceFeedEntry;
  users: User[];
  currentUser: User;
  onEdit: (entry: IntelligenceFeedEntry) => void;
  onTogglePin: (entry: IntelligenceFeedEntry) => void;
  onArchive: (entry: IntelligenceFeedEntry) => void;
  onPromote?: (entry: IntelligenceFeedEntry) => void;
  onNavigateToActionLog?: (actionLogId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const typeMeta = getEntryTypeMeta(entry.entryType);
  const TypeIcon = typeMeta.icon;
  const author = users.find(u => u.id === entry.createdBy);
  const authorName = author ? `${author.firstName || ""} ${author.lastName || ""}`.trim() || author.email : "Unknown";
  const canEdit = currentUser.role === "ceo" || currentUser.role === "team_lead" ||
    (currentUser.role === "account_manager" && entry.createdBy === currentUser.id);

  return (
    <Card
      // Task #4372 (audit P2-14): shared Card accent — pinned rides the gold
      // "warn" ink, regular entries the brand-primary stripe.
      accent={entry.pinned ? "warn" : "primary"}
      className={entry.pinned ? "bg-amber-50/30" : "bg-card"}
      data-testid={`card-intelligence-entry-${entry.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge className={`${typeMeta.color} text-xs`} data-testid={`badge-entry-type-${entry.id}`}>
                <TypeIcon className="w-3 h-3 mr-1" />
                {typeMeta.label}
              </Badge>
              {entry.status === "archived" && (
                <Badge variant="outline" className="text-xs" data-testid={`badge-entry-status-${entry.id}`}>
                  Archived
                </Badge>
              )}
              {entry.pinned && (
                <Pin className="w-3 h-3 text-amber-500" />
              )}
            </div>
            <h4 className="font-semibold text-sm text-foreground mt-1" data-testid={`text-entry-title-${entry.id}`}>{entry.title}</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {authorName} &middot; {format(new Date(entry.createdAt), "MMM d, yyyy h:mm a")}
            </p>
            {entry.body && (
              <>
                <div
                  className={`text-sm text-foreground/90 mt-2 ${expanded ? "" : "line-clamp-2"}`}
                  data-testid={`text-entry-body-${entry.id}`}
                >
                  {entry.body}
                </div>
                {entry.body.length > 150 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-primary-ink p-0 h-auto mt-1"
                    onClick={() => setExpanded(!expanded)}
                    data-testid={`button-expand-entry-${entry.id}`}
                  >
                    {expanded ? <><ChevronUp className="w-3 h-3 mr-1" />Show less</> : <><ChevronDown className="w-3 h-3 mr-1" />Show more</>}
                  </Button>
                )}
              </>
            )}
            {entry.tags && entry.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {entry.tags.map(tag => (
                  <span key={tag} className="px-1.5 py-0.5 bg-surface-warm-1 rounded text-xs text-muted-foreground" data-testid={`tag-${entry.id}-${tag}`}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          {canEdit && (
            <div className="flex gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onTogglePin(entry)}
                title={entry.pinned ? "Unpin" : "Pin"}
                data-testid={`button-pin-entry-${entry.id}`}
              >
                {entry.pinned ? <PinOff className="w-4 h-4 text-amber-500" /> : <Pin className="w-4 h-4 text-muted-foreground" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onEdit(entry)}
                data-testid={`button-edit-entry-${entry.id}`}
              >
                <Pencil className="w-4 h-4 text-muted-foreground" />
              </Button>
              {entry.status !== "archived" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => onArchive(entry)}
                  data-testid={`button-archive-entry-${entry.id}`}
                >
                  <Archive className="w-4 h-4 text-muted-foreground" />
                </Button>
              )}
              {onPromote && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-primary-ink"
                  onClick={() => onPromote(entry)}
                  title="Promote to Command Panel"
                  data-testid={`button-promote-entry-${entry.id}`}
                >
                  <TrendingUp className="w-3 h-3 mr-1" />
                  Promote
                </Button>
              )}
            </div>
          )}
        </div>
        {entry.linkedActionLogIds && entry.linkedActionLogIds.length > 0 && onNavigateToActionLog && (
          <div className="mt-2 pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground mb-1">Linked Actions:</p>
            <div className="flex flex-wrap gap-1">
              {entry.linkedActionLogIds.map(id => (
                <Button
                  key={id}
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs text-blue-600 border-blue-200 hover:bg-blue-50"
                  onClick={() => onNavigateToActionLog(id)}
                  data-testid={`link-action-log-${id}`}
                >
                  <ClipboardList className="w-3 h-3 mr-1" />
                  View Action
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function IntelligenceFeed({
  clientId,
  currentUser,
  onPromoteToCommandPanel,
  onNavigateToActionLog,
  scrollToEntryId,
}: {
  clientId: string;
  currentUser: User;
  onPromoteToCommandPanel?: (entry: IntelligenceFeedEntry) => void;
  onNavigateToActionLog?: (actionLogId: string) => void;
  scrollToEntryId?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<IntelligenceFeedEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPinnedOnly, setFilterPinnedOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const [formData, setFormData] = useState({
    entryType: "strategy_insight",
    title: "",
    body: "",
    tags: "",
    pinned: false,
  });

  const { data: entries = [], isLoading } = useQuery<IntelligenceFeedEntry[]>({
    queryKey: ["/api/clients", clientId, "intelligence-feed"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/intelligence-feed`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch intelligence entries");
      return res.json();
    },
  });

  useEffect(() => {
    if (scrollToEntryId && !isLoading) {
      setTimeout(() => {
        const el = document.querySelector(`[data-testid="card-intelligence-entry-${scrollToEntryId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
          el.classList.add("ring-2", "ring-purple-400", "ring-offset-2");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-purple-400", "ring-offset-2");
          }, 3000);
        }
      }, 300);
    }
  }, [scrollToEntryId, isLoading]);

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/clients/${clientId}/intelligence-feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create entry");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "intelligence-feed"] }); // fire-and-forget: cache refresh only
      toast({ title: "Intelligence entry created" });
      resetForm();
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await fetch(`/api/clients/${clientId}/intelligence-feed/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update entry");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "intelligence-feed"] }); // fire-and-forget: cache refresh only
      toast({ title: "Intelligence entry updated" });
      resetForm();
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const pinMutation = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await fetch(`/api/clients/${clientId}/intelligence-feed/${id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error("Failed to toggle pin");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "intelligence-feed"] }); // fire-and-forget: cache refresh only
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/intelligence-feed/${id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to archive entry");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "intelligence-feed"] }); // fire-and-forget: cache refresh only
      toast({ title: "Entry archived" });
    },
  });

  const resetForm = () => {
    setDialogOpen(false);
    setEditingEntry(null);
    setFormData({
      entryType: "strategy_insight",
      title: "",
      body: "",
      tags: "",
      pinned: false,
    });
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (entry: IntelligenceFeedEntry) => {
    setEditingEntry(entry);
    setFormData({
      entryType: entry.entryType,
      title: entry.title,
      body: entry.body || "",
      tags: entry.tags?.join(", ") || "",
      pinned: entry.pinned,
    });
    setDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // No status field: creates publish immediately via the server-side
    // "approved" default; edits leave the entry's existing status untouched
    // (archived entries stay archived when edited).
    const payload = {
      entryType: formData.entryType,
      title: formData.title,
      body: formData.body || null,
      tags: formData.tags ? formData.tags.split(",").map(t => t.trim()).filter(Boolean) : null,
      pinned: formData.pinned,
    };
    if (editingEntry) {
      updateMutation.mutate({ id: editingEntry.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleTogglePin = (entry: IntelligenceFeedEntry) => {
    pinMutation.mutate({ id: entry.id, pinned: !entry.pinned });
  };

  // Task #4621: archiving confirms through the shared ConfirmActionDialog
  // (controlled mode — archive lives inside entry cards, not a wrappable
  // trigger). Same endpoint, same guards as the old confirm().
  const [pendingArchive, setPendingArchive] = useState<IntelligenceFeedEntry | null>(null);
  const handleArchive = (entry: IntelligenceFeedEntry) => {
    setPendingArchive(entry);
  };

  const canCreate = currentUser.role === "ceo" || currentUser.role === "team_lead" || currentUser.role === "account_manager";

  let filteredEntries = entries;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredEntries = filteredEntries.filter(e =>
      e.title.toLowerCase().includes(q) || (e.body || "").toLowerCase().includes(q)
    );
  }
  if (filterType !== "all") {
    filteredEntries = filteredEntries.filter(e => e.entryType === filterType);
  }
  if (filterStatus !== "all") {
    // "Published" means anything not archived: a legacy row that somehow
    // still carries the retired "draft" status (pre-migration data) must
    // surface as a published note, never be stranded out of both views.
    filteredEntries = filteredEntries.filter(e =>
      filterStatus === "approved" ? e.status !== "archived" : e.status === filterStatus
    );
  }
  if (filterPinnedOnly) {
    filteredEntries = filteredEntries.filter(e => e.pinned);
  }

  const pinnedEntries = filteredEntries.filter(e => e.pinned);
  const unpinnedEntries = filteredEntries.filter(e => !e.pinned);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground p-4">Loading intelligence entries...</p>;
  }

  return (
    <div className="space-y-4">
      <ConfirmActionDialog
        open={!!pendingArchive}
        onOpenChange={(open) => { if (!open) setPendingArchive(null); }}
        title={`Archive "${pendingArchive?.title ?? ""}"?`}
        description="The entry moves out of the published feed into the archived view. It is not deleted and can still be found under the Archived filter."
        confirmLabel="Archive entry"
        testId="dialog-confirm-archive-entry"
        onConfirm={() => {
          if (pendingArchive) archiveMutation.mutate(pendingArchive.id);
          setPendingArchive(null);
        }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search title and body..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-intelligence-search"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          data-testid="button-intelligence-filters"
        >
          <Filter className="w-4 h-4 mr-1" />
          Filters
        </Button>
        {canCreate && (
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90"
            onClick={openCreate}
            data-testid="button-create-intelligence-entry"
          >
            <Plus className="w-4 h-4 mr-1" />
            New Entry
          </Button>
        )}
      </div>

      {showFilters && (
        <div className="flex gap-3 flex-wrap p-3 bg-surface-warm-1 rounded-lg" data-testid="intelligence-filter-bar">
          <div className="min-w-[150px]">
            <Label className="text-xs">Entry Type</Label>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-filter-entry-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {ENTRY_TYPE_OPTIONS.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[120px]">
            <Label className="text-xs">Status</Label>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {STATUS_OPTIONS.map(s => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              variant={filterPinnedOnly ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs"
              onClick={() => setFilterPinnedOnly(!filterPinnedOnly)}
              data-testid="button-filter-pinned-only"
            >
              <Pin className="w-3 h-3 mr-1" />
              Pinned Only
            </Button>
          </div>
        </div>
      )}

      {filteredEntries.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground" data-testid="intelligence-empty-state">
          <Lightbulb className="w-10 h-10 mx-auto mb-3 text-primary/30" />
          <p className="text-sm font-medium">No intelligence entries yet</p>
          <p className="text-xs mt-1">
            {canCreate
              ? "Start building your client's intelligence feed by adding strategic insights, meeting notes, and more."
              : "Intelligence entries will appear here once team members add them."
            }
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pinnedEntries.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wider flex items-center gap-1">
                <Pin className="w-3 h-3" /> Pinned
              </p>
              {pinnedEntries.map(entry => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  users={users}
                  currentUser={currentUser}
                  onEdit={openEdit}
                  onTogglePin={handleTogglePin}
                  onArchive={handleArchive}
                  onPromote={onPromoteToCommandPanel}
                  onNavigateToActionLog={onNavigateToActionLog}
                />
              ))}
            </div>
          )}
          {unpinnedEntries.length > 0 && (
            <div className="space-y-2">
              {pinnedEntries.length > 0 && (
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-4">Recent</p>
              )}
              {unpinnedEntries.map(entry => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  users={users}
                  currentUser={currentUser}
                  onEdit={openEdit}
                  onTogglePin={handleTogglePin}
                  onArchive={handleArchive}
                  onPromote={onPromoteToCommandPanel}
                  onNavigateToActionLog={onNavigateToActionLog}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={v => { if (!v) resetForm(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingEntry ? "Edit Intelligence Entry" : "New Intelligence Entry"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Entry Type *</Label>
              <Select value={formData.entryType} onValueChange={v => setFormData(p => ({ ...p, entryType: v }))}>
                <SelectTrigger data-testid="select-entry-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTRY_TYPE_OPTIONS.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Title *</Label>
              <Input
                value={formData.title}
                onChange={e => setFormData(p => ({ ...p, title: e.target.value }))}
                placeholder="Brief descriptive title"
                data-testid="input-entry-title"
              />
            </div>
            <div>
              <Label>Body</Label>
              <textarea
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[120px]"
                value={formData.body}
                onChange={e => setFormData(p => ({ ...p, body: e.target.value }))}
                placeholder="Detailed narrative..."
                data-testid="input-entry-body"
              />
            </div>
            <div>
              <Label>Tags (comma-separated)</Label>
              <Input
                value={formData.tags}
                onChange={e => setFormData(p => ({ ...p, tags: e.target.value }))}
                placeholder="strategy, growth, retention"
                data-testid="input-entry-tags"
              />
            </div>
            <div className="flex gap-4">
              <div className="flex items-end">
                <Button
                  type="button"
                  variant={formData.pinned ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFormData(p => ({ ...p, pinned: !p.pinned }))}
                  data-testid="button-toggle-pin"
                >
                  <Pin className="w-4 h-4 mr-1" />
                  {formData.pinned ? "Pinned" : "Pin"}
                </Button>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={resetForm} data-testid="button-cancel-entry">
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-primary hover:bg-primary/90"
                disabled={!formData.title.trim() || createMutation.isPending || updateMutation.isPending}
                data-testid="button-save-entry"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingEntry ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
