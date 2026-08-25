import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { format } from "date-fns";

interface ConflictConversation {
  id: string;
  clientId: string | null;
  contactPhone: string | null;
  twilioPhoneNumber: string | null;
  conversationType: string | null;
  status: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

interface ConflictGroup {
  key: string;
  contactPhoneKey: string;
  twilioPhoneKey: string;
  conflictingClientIds: string[];
  conversations: ConflictConversation[];
}

interface ConflictListResponse {
  groups: ConflictGroup[];
  clients: Record<string, { id: string; firmName: string }>;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  try {
    return format(new Date(value), "yyyy-MM-dd HH:mm");
  } catch {
    return value;
  }
}

export default function ConversationDedupeConflicts() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isFetching, refetch, error } =
    useQuery<ConflictListResponse>({
      queryKey: ["/api/admin/conversation-dedupe-conflicts"],
      queryFn: async () => {
        const res = await apiRequest("GET", "/api/admin/conversation-dedupe-conflicts");
        return res.json();
      },
    });

  const [picks, setPicks] = useState<
    Record<string, { survivorId?: string; clientId?: string }>
  >({});

  const resolveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: {
      key: string;
      survivorConversationId: string;
      targetClientId: string;
    }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/conversation-dedupe-conflicts/resolve",
        vars,
      );
      return res.json();
    },
    onSuccess: (result, vars) => {
      if (result?.status === "no_conflict") {
        toast({
          title: "Already resolved",
          description: `Group ${vars.key} is no longer in conflict (${result.reason}).`,
        });
      } else {
        toast({
          title: "Conflict resolved",
          description: `Merged ${result?.entry?.mergedConversationIds?.length ?? 0} duplicate row(s) into survivor ${result?.entry?.survivorConversationId ?? "?"}.`,
        });
      }
      void qc.invalidateQueries({ queryKey: ["/api/admin/conversation-dedupe-conflicts"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Resolve failed",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    },
  });

  const groups = useMemo(() => data?.groups ?? [], [data?.groups]);
  const clients = data?.clients ?? {};

  const sortedGroups = useMemo(
    () =>
      [...groups].sort((a, b) => a.key.localeCompare(b.key)),
    [groups],
  );

  return (
    <div className="container mx-auto max-w-6xl py-6 space-y-4" data-testid="page-conversation-dedupe-conflicts">
      <PageHeader
        title="Conversation dedupe — client conflicts"
        subtitle="Duplicate direct-thread groups where the duplicate rows link to different clients. Pick the survivor and the correct client to merge in one click."
        backHref="/admin/system-health"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading conflicts…
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-6 text-destructive" data-testid="text-error">
            Failed to load conflicts: {(error as Error).message}
          </CardContent>
        </Card>
      ) : sortedGroups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-empty">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-600" />
            No open client conflicts. The dedupe merge has nothing skipped.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedGroups.map((g) => {
            const pick = picks[g.key] ?? {};
            const canResolve = !!pick.survivorId && !!pick.clientId;
            const survivor = pick.survivorId
              ? g.conversations.find((c) => c.id === pick.survivorId)
              : undefined;
            return (
              <Card key={g.key} data-testid={`card-conflict-${g.key}`}>
                <CardHeader>
                  <CardTitle className="text-base font-mono break-all" data-testid={`text-key-${g.key}`}>
                    {g.key}
                  </CardTitle>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">Twilio: {g.twilioPhoneKey}</Badge>
                    <Badge variant="outline">Contact: {g.contactPhoneKey}</Badge>
                    <Badge variant="destructive">
                      {g.conflictingClientIds.length} clients in conflict
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b">
                          <th className="py-1 pr-2">Survivor</th>
                          <th className="py-1 pr-2">Conversation ID</th>
                          <th className="py-1 pr-2">Client</th>
                          <th className="py-1 pr-2">Messages</th>
                          <th className="py-1 pr-2">Created</th>
                          <th className="py-1 pr-2">Last message</th>
                          <th className="py-1 pr-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.conversations.map((c) => {
                          const clientName = c.clientId
                            ? clients[c.clientId]?.firmName ?? c.clientId
                            : "(unlinked)";
                          return (
                            <tr key={c.id} className="border-b last:border-0">
                              <td className="py-1 pr-2">
                                <input
                                  type="radio"
                                  name={`survivor-${g.key}`}
                                  checked={pick.survivorId === c.id}
                                  onChange={() =>
                                    setPicks((p) => ({
                                      ...p,
                                      [g.key]: { ...p[g.key], survivorId: c.id },
                                    }))
                                  }
                                  data-testid={`radio-survivor-${c.id}`}
                                />
                              </td>
                              <td className="py-1 pr-2 font-mono text-xs break-all" data-testid={`text-conv-id-${c.id}`}>
                                {c.id}
                              </td>
                              <td className="py-1 pr-2" data-testid={`text-conv-client-${c.id}`}>
                                {clientName}
                              </td>
                              <td className="py-1 pr-2" data-testid={`text-conv-messages-${c.id}`}>
                                {c.messageCount}
                              </td>
                              <td className="py-1 pr-2">{fmtDate(c.createdAt)}</td>
                              <td className="py-1 pr-2">{fmtDate(c.lastMessageAt)}</td>
                              <td className="py-1 pr-2">{c.status ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-end gap-3 pt-2 border-t">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground">
                        Correct client for the survivor
                      </label>
                      <Select
                        value={pick.clientId ?? ""}
                        onValueChange={(v) =>
                          setPicks((p) => ({
                            ...p,
                            [g.key]: { ...p[g.key], clientId: v },
                          }))
                        }
                      >
                        <SelectTrigger
                          className="w-72"
                          data-testid={`select-client-${g.key}`}
                        >
                          <SelectValue placeholder="Pick a client…" />
                        </SelectTrigger>
                        <SelectContent>
                          {g.conflictingClientIds.map((id) => (
                            <SelectItem
                              key={id}
                              value={id}
                              data-testid={`option-client-${id}`}
                            >
                              {clients[id]?.firmName ?? id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={() =>
                        resolveMutation.mutate({
                          key: g.key,
                          survivorConversationId: pick.survivorId!,
                          targetClientId: pick.clientId!,
                        })
                      }
                      disabled={!canResolve || resolveMutation.isPending}
                      data-testid={`button-resolve-${g.key}`}
                    >
                      {resolveMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : null}
                      Repoint survivor &amp; merge
                    </Button>
                    {survivor ? (
                      <span className="text-xs text-muted-foreground">
                        Will repoint {g.conversations.length} row(s) to the
                        chosen client, then merge {g.conversations.length - 1}{" "}
                        loser(s) into {survivor.id}.
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
