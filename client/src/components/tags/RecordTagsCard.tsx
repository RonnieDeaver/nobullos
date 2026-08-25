import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Tags as TagsIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { TagChip, tagTextColor, type TagChipData } from "./TagChip";

interface RecordTagRow {
  id: string;
  name: string;
  color: string;
  description: string | null;
  criteria: unknown;
  source: "manual" | "rule";
}

interface TagOption {
  id: string;
  name: string;
  color: string;
  criteria: unknown;
}

/**
 * Task #4329 — detail-page tag card for one deal or client. Chips render
 * both sources; only manual chips are removable here (rule chips are
 * engine-owned — the server answers 409 and we surface why). The picker
 * adds any of the entity type's tags as a manual application.
 */
export function RecordTagsCard({
  entityType,
  recordId,
}: {
  entityType: "deal" | "client";
  recordId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const base = entityType === "deal" ? "/api/deals" : "/api/clients";
  const recordTagsKey = [`${base}/${recordId}/tags`] as const;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  const recordTagsQuery = useQuery<RecordTagRow[]>({ queryKey: [...recordTagsKey] });
  const allTagsQuery = useQuery<{ tags: TagOption[] }>({
    queryKey: [`/api/tags?entityType=${entityType}`],
    enabled: pickerOpen,
  });

  const applied = useMemo(() => recordTagsQuery.data ?? [], [recordTagsQuery.data]);
  const appliedIds = useMemo(() => new Set(applied.map((t) => t.id)), [applied]);
  const available = useMemo(() => {
    const all = allTagsQuery.data?.tags ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (t) => !appliedIds.has(t.id) && (!q || t.name.toLowerCase().includes(q)),
    );
  }, [allTagsQuery.data, appliedIds, search]);

  const applyMutation = useMutation({
    mutationFn: (tagId: string) =>
      apiRequest("POST", `${base}/${recordId}/tags`, { tagId }).then(
        (r) => r.json() as Promise<RecordTagRow[]>,
      ),
    onSuccess: (rows) => {
      queryClient.setQueryData([...recordTagsKey], rows);
      setSearch("");
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't apply tag",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (tagId: string) =>
      apiRequest("DELETE", `${base}/${recordId}/tags/${tagId}`).then(
        (r) => r.json() as Promise<RecordTagRow[]>,
      ),
    onSuccess: (rows) => {
      queryClient.setQueryData([...recordTagsKey], rows);
    },
    onError: (err: Error) => {
      const isRuleProtected = err.message.startsWith("409");
      toast({
        title: isRuleProtected ? "Applied by rule" : "Couldn't remove tag",
        description: isRuleProtected
          ? "This tag is applied by its rule and will re-apply while the record matches. Edit the tag's criteria to remove it."
          : err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Card data-testid={`card-${entityType}-tags`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TagsIcon className="h-4 w-4" />
          Tags
        </CardTitle>
      </CardHeader>
      <CardContent>
        {recordTagsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {applied.map((t) => (
              <TagChip
                key={t.id}
                tag={t as TagChipData}
                onRemove={
                  t.source === "manual"
                    ? () => removeMutation.mutate(t.id)
                    : undefined
                }
              />
            ))}
            {applied.length === 0 && (
              <span className="text-sm text-muted-foreground" data-testid={`text-no-tags-${recordId}`}>
                No tags yet
              </span>
            )}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 rounded-full px-2 text-xs"
                  data-testid={`button-add-tag-${recordId}`}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="start">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tags…"
                  className="mb-2 h-8 text-sm"
                  data-testid="input-tag-search"
                />
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {allTagsQuery.isLoading ? (
                    <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                  ) : available.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      {allTagsQuery.data?.tags.length === 0
                        ? "No tags defined yet. Team leads can create them under Tags & Segments."
                        : "No matching tags."}
                    </div>
                  ) : (
                    available.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                        disabled={applyMutation.isPending}
                        onClick={() => applyMutation.mutate(t.id)}
                        data-testid={`option-tag-${t.id}`}
                      >
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                          style={{ backgroundColor: t.color, color: tagTextColor(t.color) }}
                        />
                        <span className="truncate">{t.name}</span>
                        {t.criteria != null && (
                          <span className="ml-auto shrink-0 text-caption text-muted-foreground">rule</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
