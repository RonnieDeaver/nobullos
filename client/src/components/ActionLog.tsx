import { useState, useEffect, useRef } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  Plus, Search, Filter, ChevronDown, ChevronUp, Pencil,
  Zap, DollarSign, Rocket, Pause, Globe, Crosshair, Palette,
  Settings, Wrench, BarChart3, RefreshCw, Truck,
  Link, Bell, Shield, Receipt, FileText, ClipboardList,
  PackagePlus, PackageMinus, PackageX, Video, AlertOctagon, MoreHorizontal, Lightbulb
} from "lucide-react";

const ACTION_TYPE_OPTIONS: { value: string; label: string; icon: any; color: string }[] = [
  { value: "campaign_launched", label: "Campaign Launched", icon: Rocket, color: "bg-blue-500" },
  { value: "campaign_paused", label: "Campaign Paused", icon: Pause, color: "bg-yellow-500" },
  { value: "budget_increased", label: "Budget Increased", icon: DollarSign, color: "bg-green-500" },
  { value: "budget_reduced", label: "Budget Reduced", icon: DollarSign, color: "bg-red-500" },
  { value: "geo_expansion", label: "Geo Expansion", icon: Globe, color: "bg-cyan-500" },
  { value: "geo_deprioritized", label: "Geo Deprioritized", icon: Globe, color: "bg-gray-500" },
  { value: "service_focus_changed", label: "Service Focus Changed", icon: Crosshair, color: "bg-indigo-500" },
  { value: "landing_page_launched", label: "Landing Page Launched", icon: FileText, color: "bg-purple-500" },
  { value: "intake_workflow_updated", label: "Intake Workflow Updated", icon: RefreshCw, color: "bg-teal-500" },
  { value: "tracking_changed", label: "Tracking Changed", icon: Settings, color: "bg-orange-500" },
  { value: "crm_workflow_changed", label: "CRM Workflow Changed", icon: Wrench, color: "bg-amber-500" },
  { value: "new_offer_introduced", label: "New Offer Introduced", icon: Zap, color: "bg-emerald-500" },
  { value: "creative_refreshed", label: "Creative Refreshed", icon: Palette, color: "bg-pink-500" },
  { value: "copy_refreshed", label: "Copy Refreshed", icon: FileText, color: "bg-violet-500" },
  { value: "review_generation_launched", label: "Review Gen Launched", icon: BarChart3, color: "bg-lime-500" },
  { value: "reporting_change", label: "Reporting Change", icon: BarChart3, color: "bg-sky-500" },
  { value: "product_added", label: "Product Added", icon: PackagePlus, color: "bg-green-600" },
  { value: "product_removed", label: "Product Removed", icon: PackageMinus, color: "bg-red-600" },
  { value: "product_paused", label: "Product Paused", icon: PackageX, color: "bg-yellow-600" },
  { value: "webinar_launched", label: "Webinar Launched", icon: Video, color: "bg-blue-600" },
  { value: "webinar_paused", label: "Webinar Paused", icon: Video, color: "bg-gray-600" },
  { value: "major_escalation_handled", label: "Major Escalation Handled", icon: AlertOctagon, color: "bg-red-700" },
  { value: "other", label: "Other", icon: MoreHorizontal, color: "bg-slate-500" },
];

const IMPACTED_SYSTEMS = [
  { value: "gbp", label: "GBP" },
  { value: "google_ads", label: "Google Ads" },
  { value: "lsa", label: "LSA" },
  { value: "webinar", label: "Webinars" },
  { value: "website", label: "Website" },
  { value: "crm", label: "CRM" },
  { value: "analytics", label: "Analytics" },
  { value: "reporting", label: "Reporting" },
  { value: "billing", label: "Billing" },
  { value: "communications", label: "Communications" },
  { value: "social_media", label: "Social Media" },
  { value: "email_marketing", label: "Email Marketing" },
  { value: "review_generation", label: "Review Generation" },
  { value: "call_tracking", label: "Call Tracking" },
];

type ActionLogEntry = {
  id: string;
  clientId: string;
  createdBy: string;
  actionType: string;
  title: string;
  whatChanged: string | null;
  whyChanged: string | null;
  impactedSystems: string[] | null;
  relatedObjective: string | null;
  relatedProductType: string | null;
  relatedCampaign: string | null;
  sourceReferences: any;
  rollbackNote: string | null;
  linkedIntelligenceEntryIds: string[] | null;
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

function getActionTypeMeta(type: string) {
  return ACTION_TYPE_OPTIONS.find(o => o.value === type) || ACTION_TYPE_OPTIONS[ACTION_TYPE_OPTIONS.length - 1];
}

function TimelineEntry({
  entry,
  users,
  currentUser,
  onEdit,
  onNavigateToIntelligence,
}: {
  entry: ActionLogEntry;
  users: User[];
  currentUser: User;
  onEdit: (entry: ActionLogEntry) => void;
  onNavigateToIntelligence?: (entryId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = getActionTypeMeta(entry.actionType);
  const Icon = meta.icon;
  const actor = users.find(u => u.id === entry.createdBy);
  const actorName = actor ? `${actor.firstName || ""} ${actor.lastName || ""}`.trim() || actor.email : "Unknown";
  const canEdit = currentUser.role === "ceo" || currentUser.role === "team_lead" ||
    (currentUser.role === "account_manager" && entry.createdBy === currentUser.id);

  return (
    <div className="flex gap-3" data-testid={`timeline-action-${entry.id}`}>
      <div className="flex flex-col items-center">
        <div className={`w-8 h-8 rounded-full ${meta.color} flex items-center justify-center shrink-0`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <div className="w-0.5 flex-1 bg-muted mt-1" />
      </div>
      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-xs bg-muted text-foreground" data-testid={`badge-action-type-${entry.id}`}>
                {meta.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {actorName} &middot; {format(new Date(entry.createdAt), "MMM d, yyyy h:mm a")}
              </span>
            </div>
            <h4 className="font-semibold text-sm text-foreground mt-1" data-testid={`text-action-title-${entry.id}`}>{entry.title}</h4>
            <div className={`mt-2 ${expanded ? "" : "line-clamp-2"}`}>
              {entry.whatChanged && (
                <p className="text-sm text-foreground/90">
                  <span className="font-medium text-foreground">What: </span>{entry.whatChanged}
                </p>
              )}
              {expanded && (
                <>
                  {entry.whyChanged && (
                    <p className="text-sm text-foreground/90 mt-1">
                      <span className="font-medium text-foreground">Why: </span>{entry.whyChanged}
                    </p>
                  )}
                  {entry.relatedObjective && (
                    <p className="text-sm text-foreground/90 mt-1">
                      <span className="font-medium text-foreground">Objective: </span>{entry.relatedObjective}
                    </p>
                  )}
                  {entry.relatedCampaign && (
                    <p className="text-sm text-foreground/90 mt-1">
                      <span className="font-medium text-foreground">Campaign: </span>{entry.relatedCampaign}
                    </p>
                  )}
                  {entry.rollbackNote && (
                    <p className="text-sm text-foreground/90 mt-1">
                      <span className="font-medium text-foreground">Rollback: </span>{entry.rollbackNote}
                    </p>
                  )}
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-primary-ink p-0 h-auto mt-1"
              onClick={() => setExpanded(!expanded)}
              data-testid={`button-expand-action-${entry.id}`}
            >
              {expanded ? <><ChevronUp className="w-3 h-3 mr-1" />Show less</> : <><ChevronDown className="w-3 h-3 mr-1" />Show more</>}
            </Button>
            {entry.impactedSystems && entry.impactedSystems.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {entry.impactedSystems.map(sys => {
                  const sysMeta = IMPACTED_SYSTEMS.find(s => s.value === sys);
                  return (
                    <span key={sys} className="px-1.5 py-0.5 bg-surface-warm-1 rounded text-xs text-muted-foreground" data-testid={`tag-system-${entry.id}-${sys}`}>
                      {sysMeta?.label || sys}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={() => onEdit(entry)}
              data-testid={`button-edit-action-${entry.id}`}
            >
              <Pencil className="w-4 h-4 text-muted-foreground" />
            </Button>
          )}
        </div>
        {entry.linkedIntelligenceEntryIds && entry.linkedIntelligenceEntryIds.length > 0 && onNavigateToIntelligence && (
          <div className="mt-2 pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground mb-1">Linked Intelligence:</p>
            <div className="flex flex-wrap gap-1">
              {entry.linkedIntelligenceEntryIds.map(id => (
                <Button
                  key={id}
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs text-purple-600 border-purple-200 hover:bg-purple-50"
                  onClick={() => onNavigateToIntelligence(id)}
                  data-testid={`link-intelligence-${id}`}
                >
                  <Lightbulb className="w-3 h-3 mr-1" />
                  View Insight
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ActionLog({
  clientId,
  currentUser,
  onNavigateToIntelligence,
  scrollToEntryId,
}: {
  clientId: string;
  currentUser: User;
  onNavigateToIntelligence?: (entryId: string) => void;
  scrollToEntryId?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ActionLogEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterSystem, setFilterSystem] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState({
    actionType: "campaign_launched",
    title: "",
    whatChanged: "",
    whyChanged: "",
    impactedSystems: [] as string[],
    relatedObjective: "",
    relatedProductType: "",
    relatedCampaign: "",
    rollbackNote: "",
  });

  const { data: entries = [], isLoading } = useQuery<ActionLogEntry[]>({
    queryKey: ["/api/clients", clientId, "action-log"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/action-log`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch action log entries");
      return res.json();
    },
  });

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => {
    if (scrollToEntryId && !isLoading) {
      setTimeout(() => {
        const el = document.querySelector(`[data-testid="timeline-action-${scrollToEntryId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
          el.classList.add("ring-2", "ring-blue-400", "ring-offset-2", "rounded-lg");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-blue-400", "ring-offset-2", "rounded-lg");
          }, 3000);
        }
      }, 300);
    }
  }, [scrollToEntryId, isLoading]);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/clients/${clientId}/action-log`, {
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
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "action-log"] }); // fire-and-forget: cache refresh only
      toast({ title: "Action log entry created" });
      resetForm();
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await fetch(`/api/clients/${clientId}/action-log/${id}`, {
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
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "action-log"] }); // fire-and-forget: cache refresh only
      toast({ title: "Action log entry updated" });
      resetForm();
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setDialogOpen(false);
    setEditingEntry(null);
    setFormData({
      actionType: "campaign_launched",
      title: "",
      whatChanged: "",
      whyChanged: "",
      impactedSystems: [],
      relatedObjective: "",
      relatedProductType: "",
      relatedCampaign: "",
      rollbackNote: "",
    });
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (entry: ActionLogEntry) => {
    setEditingEntry(entry);
    setFormData({
      actionType: entry.actionType,
      title: entry.title,
      whatChanged: entry.whatChanged || "",
      whyChanged: entry.whyChanged || "",
      impactedSystems: entry.impactedSystems || [],
      relatedObjective: entry.relatedObjective || "",
      relatedProductType: entry.relatedProductType || "",
      relatedCampaign: entry.relatedCampaign || "",
      rollbackNote: entry.rollbackNote || "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      actionType: formData.actionType,
      title: formData.title,
      whatChanged: formData.whatChanged || null,
      whyChanged: formData.whyChanged || null,
      impactedSystems: formData.impactedSystems.length > 0 ? formData.impactedSystems : null,
      relatedObjective: formData.relatedObjective || null,
      relatedProductType: formData.relatedProductType || null,
      relatedCampaign: formData.relatedCampaign || null,
      rollbackNote: formData.rollbackNote || null,
    };
    if (editingEntry) {
      updateMutation.mutate({ id: editingEntry.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const toggleImpactedSystem = (sys: string) => {
    setFormData(p => ({
      ...p,
      impactedSystems: p.impactedSystems.includes(sys)
        ? p.impactedSystems.filter(s => s !== sys)
        : [...p.impactedSystems, sys],
    }));
  };

  const canCreate = currentUser.role === "ceo" || currentUser.role === "team_lead" || currentUser.role === "account_manager";

  let filteredEntries = entries;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredEntries = filteredEntries.filter(e =>
      e.title.toLowerCase().includes(q) ||
      (e.whatChanged || "").toLowerCase().includes(q) ||
      (e.whyChanged || "").toLowerCase().includes(q)
    );
  }
  if (filterType !== "all") {
    filteredEntries = filteredEntries.filter(e => e.actionType === filterType);
  }
  if (filterSystem !== "all") {
    filteredEntries = filteredEntries.filter(e => e.impactedSystems?.includes(filterSystem));
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground p-4">Loading action log...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search actions..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-action-log-search"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          data-testid="button-action-log-filters"
        >
          <Filter className="w-4 h-4 mr-1" />
          Filters
        </Button>
        {canCreate && (
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90"
            onClick={openCreate}
            data-testid="button-create-action-log"
          >
            <Plus className="w-4 h-4 mr-1" />
            Log Action
          </Button>
        )}
      </div>

      {showFilters && (
        <div className="flex gap-3 flex-wrap p-3 bg-surface-warm-1 rounded-lg" data-testid="action-log-filter-bar">
          <div className="min-w-[150px]">
            <Label className="text-xs">Action Type</Label>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-filter-action-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {ACTION_TYPE_OPTIONS.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[150px]">
            <Label className="text-xs">Impacted System</Label>
            <Select value={filterSystem} onValueChange={setFilterSystem}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-filter-system">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Systems</SelectItem>
                {IMPACTED_SYSTEMS.map(s => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {filteredEntries.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground" data-testid="action-log-empty-state">
          <ClipboardList className="w-10 h-10 mx-auto mb-3 text-primary/30" />
          <p className="text-sm font-medium">No actions logged yet</p>
          <p className="text-xs mt-1">
            {canCreate
              ? "Start logging changes to build an auditable record of all actions taken for this client."
              : "Action log entries will appear here as changes are made to this client's account."
            }
          </p>
        </div>
      ) : (
        <div className="pl-1">
          {filteredEntries.map(entry => (
            <TimelineEntry
              key={entry.id}
              entry={entry}
              users={users}
              currentUser={currentUser}
              onEdit={openEdit}
              onNavigateToIntelligence={onNavigateToIntelligence}
            />
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={v => { if (!v) resetForm(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingEntry ? "Edit Action Log Entry" : "Log New Action"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Action Type *</Label>
              <Select value={formData.actionType} onValueChange={v => setFormData(p => ({ ...p, actionType: v }))}>
                <SelectTrigger data-testid="select-action-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_TYPE_OPTIONS.map(t => (
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
                placeholder="Brief action title"
                data-testid="input-action-title"
              />
            </div>
            <div>
              <Label>What Changed</Label>
              <textarea
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[80px]"
                value={formData.whatChanged}
                onChange={e => setFormData(p => ({ ...p, whatChanged: e.target.value }))}
                placeholder="Describe what was changed..."
                data-testid="input-action-what"
              />
            </div>
            <div>
              <Label>Why It Changed</Label>
              <textarea
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[80px]"
                value={formData.whyChanged}
                onChange={e => setFormData(p => ({ ...p, whyChanged: e.target.value }))}
                placeholder="Explain the reasoning..."
                data-testid="input-action-why"
              />
            </div>
            <div>
              <Label>Impacted Systems</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {IMPACTED_SYSTEMS.map(sys => (
                  <label
                    key={sys.value}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border cursor-pointer transition-colors ${
                      formData.impactedSystems.includes(sys.value)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card text-muted-foreground border-border hover:border-primary/50"
                    }`}
                    data-testid={`checkbox-system-${sys.value}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={formData.impactedSystems.includes(sys.value)}
                      onChange={() => toggleImpactedSystem(sys.value)}
                    />
                    {sys.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>Related Objective</Label>
              <Input
                value={formData.relatedObjective}
                onChange={e => setFormData(p => ({ ...p, relatedObjective: e.target.value }))}
                placeholder="e.g., Increase lead volume by 20%"
                data-testid="input-action-objective"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Related Product Type</Label>
                <Select value={formData.relatedProductType || "none"} onValueChange={v => setFormData(p => ({ ...p, relatedProductType: v === "none" ? "" : v }))}>
                  <SelectTrigger data-testid="select-action-product">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="gbp">GBP</SelectItem>
                    <SelectItem value="google_ads">Google Ads</SelectItem>
                    <SelectItem value="lsa">LSA</SelectItem>
                    <SelectItem value="webinar">Webinars</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Related Campaign</Label>
                <Input
                  value={formData.relatedCampaign}
                  onChange={e => setFormData(p => ({ ...p, relatedCampaign: e.target.value }))}
                  placeholder="Campaign name"
                  data-testid="input-action-campaign"
                />
              </div>
            </div>
            <div>
              <Label>Rollback Note</Label>
              <Input
                value={formData.rollbackNote}
                onChange={e => setFormData(p => ({ ...p, rollbackNote: e.target.value }))}
                placeholder="How to undo this change if needed"
                data-testid="input-action-rollback"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={resetForm} data-testid="button-cancel-action">
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-primary hover:bg-primary/90"
                disabled={
                  !formData.title.trim() ||
                  createMutation.isPending || updateMutation.isPending
                }
                data-testid="button-save-action"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingEntry ? "Update" : "Log Action"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
