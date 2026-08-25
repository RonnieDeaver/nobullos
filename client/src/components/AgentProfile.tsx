import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Brain, Plus, Trash2, ArrowUpCircle, RefreshCw, Zap, Shield, BookOpen, Pencil } from "lucide-react";

type MemoryEntry = {
  id: string;
  clientId: string;
  identifierType: string;
  identifierValue: string;
  source: string;
  confidenceWeight: number;
  usageCount: number;
  manuallyAdded: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

type AgentStats = {
  totalDecisions: number;
  claimedCount: number;
  correctedCount: number;
  avgConfidence: number;
  totalIdentifiers: number;
  seededCount: number;
  learnedCount: number;
  manualCount: number;
};

const TYPE_LABELS: Record<string, string> = {
  email: "Email", domain: "Domain", phone: "Phone",
  slack_channel: "Slack Channel", slack_name: "Slack Name",
  zoom_participant: "Zoom Participant", keyword: "Keyword",
  phrase: "Phrase", alias: "Alias",
  signature_fragment: "Signature", semantic_pattern_reference: "Semantic Pattern",
};

const IDENTIFIER_TYPES = Object.keys(TYPE_LABELS);

const SOURCE_COLORS: Record<string, string> = {
  seeded: "bg-blue-100 text-blue-800",
  learned: "bg-green-100 text-green-800",
  manual: "bg-purple-100 text-purple-800",
};

export default function AgentProfile({ clientId }: { clientId: string }) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editItem, setEditItem] = useState<MemoryEntry | null>(null);
  const [editForm, setEditForm] = useState({ identifierValue: "", confidenceWeight: "1.0" });
  const [addForm, setAddForm] = useState({ identifierType: "email", identifierValue: "", confidenceWeight: "1.0" });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: memory = [] } = useQuery<MemoryEntry[]>({
    queryKey: [`/api/clients/${clientId}/agent-memory`],
  });

  const { data: stats } = useQuery<AgentStats>({
    queryKey: [`/api/clients/${clientId}/agent-stats`],
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/agent-memory/seed`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-memory`] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-stats`] }); // fire-and-forget: cache refresh only
      toast({ title: `Seeded ${data.seeded} identifiers` });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/clients/${clientId}/agent-memory`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-memory`] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-stats`] }); // fire-and-forget: cache refresh only
      setShowAddDialog(false);
      toast({ title: "Identifier added" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/agent-memory/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-memory`] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-stats`] }); // fire-and-forget: cache refresh only
      toast({ title: "Identifier removed" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { identifierValue?: string; confidenceWeight?: number } }) => {
      const res = await fetch(`/api/clients/${clientId}/agent-memory/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-memory`] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-stats`] }); // fire-and-forget: cache refresh only
      setShowEditDialog(false);
      setEditItem(null);
      toast({ title: "Identifier updated" });
    },
  });

  const openEdit = (item: MemoryEntry) => {
    setEditItem(item);
    setEditForm({ identifierValue: item.identifierValue, confidenceWeight: String(item.confidenceWeight) });
    setShowEditDialog(true);
  };

  const promoteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/agent-memory/${id}/promote`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-memory`] }); // fire-and-forget: cache refresh only
      toast({ title: "Promoted to trusted signal" });
    },
  });

  const retroactiveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/agent-engine/retroactive/${clientId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxItems: 50 }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Reprocessed ${data.processed} items, claimed ${data.claimed}` });
    },
  });

  const grouped = IDENTIFIER_TYPES.reduce((acc, type) => {
    const items = memory.filter(m => m.identifierType === type);
    if (items.length > 0) acc[type] = items;
    return acc;
  }, {} as Record<string, MemoryEntry[]>);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4" /> Matching Agent
        </CardTitle>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => seedMutation.mutate()} disabled={seedMutation.isPending} data-testid="button-seed-agent">
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${seedMutation.isPending ? "animate-spin" : ""}`} /> Seed
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowAddDialog(true)} data-testid="button-add-identifier">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {stats && (
          <div className="grid grid-cols-4 gap-2 mb-4">
            <div className="text-center p-2 rounded bg-muted/50">
              <div className="text-lg font-semibold" data-testid="stat-total-identifiers">{stats.totalIdentifiers}</div>
              <div className="text-xs text-muted-foreground">Identifiers</div>
            </div>
            <div className="text-center p-2 rounded bg-muted/50">
              <div className="text-lg font-semibold" data-testid="stat-claimed">{stats.claimedCount}</div>
              <div className="text-xs text-muted-foreground">Claims</div>
            </div>
            <div className="text-center p-2 rounded bg-muted/50">
              <div className="text-lg font-semibold" data-testid="stat-corrections">{stats.correctedCount}</div>
              <div className="text-xs text-muted-foreground">Corrections</div>
            </div>
            <div className="text-center p-2 rounded bg-muted/50">
              <div className="text-lg font-semibold" data-testid="stat-avg-confidence">{(stats.avgConfidence * 100).toFixed(0)}%</div>
              <div className="text-xs text-muted-foreground">Avg Confidence</div>
            </div>
          </div>
        )}

        <div className="flex gap-2 mb-3">
          <Badge variant="outline" className="text-xs">
            <Shield className="h-3 w-3 mr-1" /> Seeded: {stats?.seededCount || 0}
          </Badge>
          <Badge variant="outline" className="text-xs">
            <BookOpen className="h-3 w-3 mr-1" /> Learned: {stats?.learnedCount || 0}
          </Badge>
          <Badge variant="outline" className="text-xs">
            <Zap className="h-3 w-3 mr-1" /> Manual: {stats?.manualCount || 0}
          </Badge>
        </div>

        <Tabs defaultValue="identifiers">
          <TabsList className="w-full">
            <TabsTrigger value="identifiers" className="flex-1">Identifiers</TabsTrigger>
            <TabsTrigger value="actions" className="flex-1">Actions</TabsTrigger>
          </TabsList>

          <TabsContent value="identifiers" className="mt-3">
            {Object.keys(grouped).length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-identifiers">No identifiers yet. Click "Seed" to initialize from client data.</p>
            ) : (
              <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {Object.entries(grouped).map(([type, items]) => (
                  <div key={type}>
                    <div className="text-xs font-medium text-muted-foreground mb-1">{TYPE_LABELS[type] || type}</div>
                    <div className="space-y-1">
                      {items.map(item => (
                        <div key={item.id} className="flex items-center justify-between text-xs p-1.5 rounded border" data-testid={`memory-item-${item.id}`}>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate font-mono">{item.identifierValue}</span>
                            <Badge variant="secondary" className={`text-[10px] ${SOURCE_COLORS[item.source] || ""}`}>
                              {item.source}
                            </Badge>
                            <span className="text-muted-foreground whitespace-nowrap">w:{item.confidenceWeight.toFixed(1)}</span>
                          </div>
                          <div className="flex gap-0.5 ml-2">
                            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => openEdit(item)} title="Edit" data-testid={`button-edit-memory-${item.id}`}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                            {item.source === "learned" && (
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => promoteMutation.mutate(item.id)} title="Promote to trusted" data-testid={`button-promote-${item.id}`}>
                                <ArrowUpCircle className="h-3 w-3" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteMutation.mutate(item.id)} aria-label="Delete memory" data-testid={`button-delete-memory-${item.id}`}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="actions" className="mt-3 space-y-2">
            <Button variant="outline" size="sm" className="w-full" onClick={() => retroactiveMutation.mutate()} disabled={retroactiveMutation.isPending} data-testid="button-retroactive-reprocess">
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${retroactiveMutation.isPending ? "animate-spin" : ""}`} />
              Re-check Unmatched Communications
            </Button>
            <p className="text-xs text-muted-foreground">
              Re-evaluates historical unmatched items against this agent's current memory. Auto-claims items that exceed 95% confidence.
            </p>
          </TabsContent>
        </Tabs>

        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Identifier</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Type</Label>
                <Select value={addForm.identifierType} onValueChange={v => setAddForm(f => ({ ...f, identifierType: v }))}>
                  <SelectTrigger data-testid="select-identifier-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {IDENTIFIER_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Value</Label>
                <Input value={addForm.identifierValue} onChange={e => setAddForm(f => ({ ...f, identifierValue: e.target.value }))} placeholder="Enter value..." data-testid="input-identifier-value" />
              </div>
              <div>
                <Label>Confidence Weight (0-1)</Label>
                <Input type="number" step="0.1" min="0" max="1" value={addForm.confidenceWeight} onChange={e => setAddForm(f => ({ ...f, confidenceWeight: e.target.value }))} data-testid="input-confidence-weight" />
              </div>
              <Button onClick={() => addMutation.mutate({
                identifierType: addForm.identifierType,
                identifierValue: addForm.identifierValue,
                confidenceWeight: parseFloat(addForm.confidenceWeight) || 1.0,
                usageCount: 0,
              })} disabled={!addForm.identifierValue.trim()} className="w-full" data-testid="button-submit-identifier">
                Add Identifier
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Identifier</DialogTitle>
            </DialogHeader>
            {editItem && (
              <div className="space-y-3">
                <div>
                  <Label>Type</Label>
                  <Input value={TYPE_LABELS[editItem.identifierType] || editItem.identifierType} disabled className="bg-muted" />
                </div>
                <div>
                  <Label>Value</Label>
                  <Input value={editForm.identifierValue} onChange={e => setEditForm(f => ({ ...f, identifierValue: e.target.value }))} data-testid="input-edit-identifier-value" />
                </div>
                <div>
                  <Label>Confidence Weight (0-1)</Label>
                  <Input type="number" step="0.1" min="0" max="1" value={editForm.confidenceWeight} onChange={e => setEditForm(f => ({ ...f, confidenceWeight: e.target.value }))} data-testid="input-edit-confidence-weight" />
                </div>
                <Button onClick={() => editMutation.mutate({
                  id: editItem.id,
                  data: {
                    identifierValue: editForm.identifierValue,
                    confidenceWeight: parseFloat(editForm.confidenceWeight) || 1.0,
                  },
                })} disabled={!editForm.identifierValue.trim()} className="w-full" data-testid="button-save-edit-identifier">
                  Save Changes
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
