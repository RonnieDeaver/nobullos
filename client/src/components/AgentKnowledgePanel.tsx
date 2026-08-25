import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Check, X, Pencil, Trash2, Plus, Brain, TrendingUp, AlertTriangle, MessageSquare, Target, Users, Eye, MessageSquareOff } from "lucide-react";

interface KnowledgeEntry {
  id: string;
  clientId: string;
  factCategory: string;
  factText: string;
  confidence: number;
  sourceAgent: string;
  sourceRecordId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  usageCount: number;
  isActive: boolean;
  createdAt: string | null;
}

interface FeedbackEntry {
  id: string;
  agentType: string;
  targetRecordId: string;
  targetRecordType: string;
  feedbackType: string;
  correctedValue: string | null;
  createdAt: string | null;
}

const CATEGORY_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  client_preference: { label: "Client Preference", icon: Target, color: "bg-blue-100 text-blue-800" },
  communication_pattern: { label: "Communication Pattern", icon: MessageSquare, color: "bg-purple-100 text-purple-800" },
  recurring_concern: { label: "Recurring Concern", icon: AlertTriangle, color: "bg-amber-100 text-amber-800" },
  strategic_context: { label: "Strategic Context", icon: TrendingUp, color: "bg-green-100 text-green-800" },
  relationship_insight: { label: "Relationship Insight", icon: Users, color: "bg-pink-100 text-pink-800" },
  behavioral_pattern: { label: "Behavioral Pattern", icon: Eye, color: "bg-indigo-100 text-indigo-800" },
};

const SOURCE_LABELS: Record<string, string> = {
  daily_judgment: "Daily Judgment",
  communication_analysis: "Comm Analysis",
  communication_enrichment: "Comm Enrichment",
  agent_chat: "Agent Chat",
  manual: "Manual Entry",
};

export default function AgentKnowledgePanel({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<KnowledgeEntry | null>(null);
  const [newFact, setNewFact] = useState({ factCategory: "client_preference", factText: "", confidence: 0.9 });

  const { data: knowledge = [], isLoading } = useQuery<KnowledgeEntry[]>({
    queryKey: ["/api/clients", clientId, "knowledge"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/knowledge`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch knowledge");
      return res.json();
    },
  });

  const { data: recentCommsData } = useQuery<{ count: number; days: number }>({
    queryKey: ["/api/clients", clientId, "recent-comms-count"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/recent-comms-count`, { credentials: "include" });
      if (!res.ok) return { count: -1, days: 30 };
      return res.json();
    },
  });

  const hasNoRecentComms = recentCommsData && recentCommsData.count === 0;

  const { data: feedback = [] } = useQuery<FeedbackEntry[]>({
    queryKey: ["/api/clients", clientId, "feedback"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/feedback?limit=10`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch feedback");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { factCategory: string; factText: string; confidence: number }) => {
      const res = await fetch(`/api/clients/${clientId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create entry");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "knowledge"] }); // fire-and-forget: cache refresh only
      setAddDialogOpen(false);
      setNewFact({ factCategory: "client_preference", factText: "", confidence: 0.9 });
      toast({ title: "Fact added to knowledge base" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await fetch(`/api/clients/${clientId}/knowledge/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update entry");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "knowledge"] }); // fire-and-forget: cache refresh only
      setEditEntry(null);
      toast({ title: "Knowledge entry updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/knowledge/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete entry");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "knowledge"] }); // fire-and-forget: cache refresh only
      toast({ title: "Knowledge entry removed" });
    },
  });

  const feedbackMutation = useMutation({
    mutationFn: async ({ targetRecordId, feedbackType, correctedValue }: { targetRecordId: string; feedbackType: string; correctedValue?: string }) => {
      const res = await fetch("/api/agent-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          agentType: "knowledge_base",
          targetRecordId,
          targetRecordType: "knowledge_base",
          clientId,
          feedbackType,
          correctedValue: correctedValue || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to submit feedback");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "knowledge"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "feedback"] }); // fire-and-forget: cache refresh only
      toast({ title: "Feedback recorded" });
    },
  });

  const filtered = categoryFilter === "all"
    ? knowledge
    : knowledge.filter((k) => k.factCategory === categoryFilter);

  const grouped = filtered.reduce((acc, entry) => {
    const cat = entry.factCategory;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(entry);
    return acc;
  }, {} as Record<string, KnowledgeEntry[]>);

  const activeCount = knowledge.filter((k) => k.isActive).length;

  return (
    <div className="space-y-4" data-testid="agent-knowledge-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Agent Memory</h2>
          <Badge variant="secondary" data-testid="text-knowledge-count">{activeCount} facts</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-category-filter">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => setAddDialogOpen(true)}
            className="bg-primary hover:bg-[#5A2533]"
            data-testid="button-add-knowledge"
          >
            <Plus className="w-4 h-4 mr-1" /> Add Fact
          </Button>
        </div>
      </div>

      {hasNoRecentComms && (
        <Card className="bg-amber-50 border-amber-200" data-testid="knowledge-no-comms-banner">
          <CardContent className="p-4 flex items-center gap-3">
            <MessageSquareOff className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800">No recent communications — fact extraction paused</p>
              <p className="text-xs text-amber-600 mt-0.5">
                This client has no matched communications in the last 30 days. Automatic fact extraction from daily judgments is paused until new communications are received.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading knowledge base...</div>
      ) : Object.keys(grouped).length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-8 text-center text-muted-foreground">
            No knowledge entries found. Facts will be automatically extracted as agents process communications and judgments.
          </CardContent>
        </Card>
      ) : (
        Object.entries(grouped).map(([category, entries]) => {
          const config = CATEGORY_CONFIG[category] || { label: category, icon: Brain, color: "bg-muted text-foreground" };
          const Icon = config.icon;
          return (
            <Card key={category} className="bg-card border-border" data-testid={`card-knowledge-${category}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Icon className="w-4 h-4" />
                  <span>{config.label}</span>
                  <Badge variant="outline" className="ml-auto">{entries.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border ${entry.isActive ? "bg-card border-border" : "bg-muted/50 border-border opacity-60"}`}
                    data-testid={`knowledge-entry-${entry.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{entry.factText}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge className={`text-[10px] ${getConfidenceBadge(entry.confidence)}`}>
                          {(entry.confidence * 100).toFixed(0)}% confidence
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {SOURCE_LABELS[entry.sourceAgent] || entry.sourceAgent}
                        </span>
                        {entry.lastSeenAt && (
                          <span className="text-[10px] text-muted-foreground">
                            Last seen: {new Date(entry.lastSeenAt).toLocaleDateString()}
                          </span>
                        )}
                        {entry.usageCount > 1 && (
                          <span className="text-[10px] text-muted-foreground">
                            Seen {entry.usageCount}x
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-green-600 hover:bg-green-50"
                        onClick={() => feedbackMutation.mutate({ targetRecordId: entry.id, feedbackType: "confirmed" })}
                        title="Confirm this fact"
                        data-testid={`button-confirm-${entry.id}`}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-amber-600 hover:bg-amber-50"
                        onClick={() => setEditEntry(entry)}
                        title="Edit / Correct"
                        data-testid={`button-edit-${entry.id}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-600 hover:bg-red-50"
                        onClick={() => deleteMutation.mutate(entry.id)}
                        title="Delete"
                        data-testid={`button-delete-${entry.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })
      )}

      {feedback.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Recent Feedback</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {feedback.map((fb) => (
                <div key={fb.id} className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`feedback-entry-${fb.id}`}>
                  <Badge variant={fb.feedbackType === "confirmed" ? "default" : fb.feedbackType === "corrected" ? "outline" : "destructive"} className="text-[10px]">
                    {fb.feedbackType}
                  </Badge>
                  <span>{fb.agentType}</span>
                  {fb.correctedValue && <span className="text-foreground">"{fb.correctedValue}"</span>}
                  {fb.createdAt && <span>{new Date(fb.createdAt).toLocaleDateString()}</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Knowledge Fact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Category</Label>
              <Select value={newFact.factCategory} onValueChange={(v) => setNewFact({ ...newFact, factCategory: v })}>
                <SelectTrigger data-testid="select-new-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Fact</Label>
              <Textarea
                value={newFact.factText}
                onChange={(e) => setNewFact({ ...newFact, factText: e.target.value })}
                placeholder="e.g., Client prefers not to be contacted on Fridays"
                data-testid="input-new-fact"
              />
            </div>
            <Button
              className="w-full bg-primary hover:bg-[#5A2533]"
              onClick={() => createMutation.mutate(newFact)}
              disabled={!newFact.factText.trim() || createMutation.isPending}
              data-testid="button-save-fact"
            >
              Save Fact
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editEntry} onOpenChange={(open) => !open && setEditEntry(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Knowledge Entry</DialogTitle>
          </DialogHeader>
          {editEntry && (
            <div className="space-y-4">
              <div>
                <Label>Category</Label>
                <Select value={editEntry.factCategory} onValueChange={(v) => setEditEntry({ ...editEntry, factCategory: v })}>
                  <SelectTrigger data-testid="select-edit-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                      <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Fact</Label>
                <Textarea
                  value={editEntry.factText}
                  onChange={(e) => setEditEntry({ ...editEntry, factText: e.target.value })}
                  data-testid="input-edit-fact"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1 bg-primary hover:bg-[#5A2533]"
                  onClick={() => {
                    updateMutation.mutate({
                      id: editEntry.id,
                      data: { factText: editEntry.factText, factCategory: editEntry.factCategory },
                    });
                    feedbackMutation.mutate({ targetRecordId: editEntry.id, feedbackType: "corrected", correctedValue: editEntry.factText });
                  }}
                  disabled={updateMutation.isPending}
                  data-testid="button-save-edit"
                >
                  Save Correction
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    feedbackMutation.mutate({ targetRecordId: editEntry.id, feedbackType: "dismissed" });
                    updateMutation.mutate({ id: editEntry.id, data: { isActive: false } });
                  }}
                  data-testid="button-dismiss-entry"
                >
                  <X className="w-4 h-4 mr-1" /> Dismiss
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getConfidenceBadge(confidence: number): string {
  if (confidence >= 0.8) return "bg-green-100 text-green-800";
  if (confidence >= 0.5) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}
