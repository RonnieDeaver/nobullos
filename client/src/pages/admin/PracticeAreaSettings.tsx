import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ArrowLeft, Save, RotateCcw, Search, Pencil, Check, X } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/admin/PageHeader";

type PracticeAreaSetting = {
  id: string | null;
  practiceArea: string;
  searchTerm: string;
  monthlyData: number[] | null;
  isActive: boolean;
  isDefault: boolean;
};

type SettingsResponse = {
  settings: PracticeAreaSetting[];
  defaults: PracticeAreaSetting[];
};

export default function PracticeAreaSettings() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [editingArea, setEditingArea] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [searchFilter, setSearchFilter] = useState("");

  const { data, isLoading } = useQuery<SettingsResponse>({
    queryKey: ["/api/admin/practice-area-settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/practice-area-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "admin"),
  });

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ practiceArea, searchTerm }: { practiceArea: string; searchTerm: string }) => {
      const res = await fetch("/api/admin/practice-area-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ practiceArea, searchTerm }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/practice-area-settings"] }); // fire-and-forget: cache refresh only
      setEditingArea(null);
      setEditValue("");
      toast({ title: "Search term saved" });
    },
    onError: () => {
      toast({ title: "Failed to save", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/practice-area-settings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/practice-area-settings"] }); // fire-and-forget: cache refresh only
      toast({ title: "Reset to default" });
    },
    onError: () => {
      toast({ title: "Failed to reset", variant: "destructive" });
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "admin")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600">Access Denied</h1>
        <p className="text-muted-foreground">Admin access required</p>
        <Link href="/">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  const allSettings = [...(data?.settings || []), ...(data?.defaults || [])];
  const filteredSettings = allSettings.filter(s => 
    s.practiceArea.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.searchTerm.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const startEditing = (area: string, currentTerm: string) => {
    setEditingArea(area);
    setEditValue(currentTerm);
  };

  const saveEdit = (practiceArea: string) => {
    if (editValue.trim()) {
      saveMutation.mutate({ practiceArea, searchTerm: editValue.trim() });
    }
  };

  const cancelEdit = () => {
    setEditingArea(null);
    setEditValue("");
  };

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-muted/50">
      <div className="max-w-4xl mx-auto p-6">
        <PageHeader
          title="Practice Area Settings"
          subtitle="Configure default search terms for trend analysis"
          backHref="/"
          className="mb-6"
        />


        <div className="bg-card rounded-lg shadow-sm border p-6">
          <div className="flex items-center gap-2 mb-6">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Filter practice areas..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="max-w-xs"
              data-testid="input-search-filter"
            />
          </div>

          {isLoading ? (
            <div className="py-12 text-center">
              <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
            </div>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_2fr_auto] gap-4 px-4 py-2 text-sm font-medium text-muted-foreground border-b">
                <div>Practice Area</div>
                <div>Search Term</div>
                <div className="w-24">Actions</div>
              </div>

              {filteredSettings.map((setting) => (
                <div 
                  key={setting.practiceArea}
                  className={`grid grid-cols-[1fr_2fr_auto] gap-4 px-4 py-3 rounded-lg hover:bg-muted/50 ${
                    !setting.isDefault ? 'bg-blue-50/50' : ''
                  }`}
                  data-testid={`row-setting-${setting.practiceArea.replace(/\s+/g, '-').toLowerCase()}`}
                >
                  <div className="font-medium text-foreground flex items-center gap-2">
                    {setting.practiceArea}
                    {!setting.isDefault && (
                      <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full">
                        Custom
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center">
                    {editingArea === setting.practiceArea ? (
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(setting.practiceArea);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        data-testid="input-edit-search-term"
                      />
                    ) : (
                      <span className="text-muted-foreground text-sm">{setting.searchTerm}</span>
                    )}
                  </div>
                  
                  <div className="w-24 flex items-center gap-1">
                    {editingArea === setting.practiceArea ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => saveEdit(setting.practiceArea)}
                          disabled={saveMutation.isPending}
                          aria-label={`Save search term for ${setting.practiceArea}`}
                          data-testid="button-save-edit"
                        >
                          <Check className="w-4 h-4 text-green-600" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          aria-label={`Cancel editing ${setting.practiceArea}`}
                          data-testid="button-cancel-edit"
                        >
                          <X className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEditing(setting.practiceArea, setting.searchTerm)}
                          aria-label={`Edit search term for ${setting.practiceArea}`}
                          data-testid={`button-edit-${setting.practiceArea.replace(/\s+/g, '-').toLowerCase()}`}
                        >
                          <Pencil className="w-4 h-4 text-muted-foreground" />
                        </Button>
                        {!setting.isDefault && setting.id && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(setting.id!)}
                            disabled={deleteMutation.isPending}
                            title="Reset to default"
                            aria-label={`Reset ${setting.practiceArea} to default`}
                            data-testid={`button-reset-${setting.practiceArea.replace(/\s+/g, '-').toLowerCase()}`}
                          >
                            <RotateCcw className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {filteredSettings.length === 0 && (
                <div className="py-8 text-center text-muted-foreground">
                  No practice areas found matching your filter
                </div>
              )}
            </div>
          )}

          <div className="mt-6 pt-4 border-t text-sm text-muted-foreground">
            <p>These search terms are used when generating trend analysis charts for client reports. Custom values override the defaults.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
