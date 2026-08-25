/**
 * InsertDataDialog — choose a live NoBull data connector and insert a
 * refreshable data block into the active sheet.
 *
 * Opens as a Dialog. On submit it calls POST /api/sheets/workbooks/:id/blocks
 * and passes the new block back to the caller so it can reflect in the UI.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { humanizeQueryError } from "@/lib/queryErrorCopy";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Connector {
  id: string;
  label: string;
  description: string;
  params: ConnectorParamSpec[];
}

interface ConnectorParamSpec {
  key: string;
  label: string;
  type: "string" | "number" | "enum";
  required?: boolean;
  options?: string[];
  description?: string;
}

export interface SheetDataBlock {
  id: string;
  workbookId: string;
  sheetId: string;
  label: string;
  connectorId: string;
  connectorParams: Record<string, unknown>;
  startRow: number;
  startCol: number;
  rowCount: number;
  colCount: number;
  autoRefresh: boolean;
  lastRefreshedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InsertDataDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  workbookId: string;
  /** Univer sheet ID to target (first sheet if unknown). */
  sheetId: string;
  onBlockCreated?(block: SheetDataBlock): void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function InsertDataDialog({
  open,
  onOpenChange,
  workbookId,
  sheetId,
  onBlockCreated,
}: InsertDataDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Form state
  const [selectedConnector, setSelectedConnector] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  // ── Connectors list ──────────────────────────────────────────────────────────
  const { data: connectorsData, isLoading: connectorsLoading } = useQuery<{
    connectors: Connector[];
  }>({
    queryKey: ["/api/sheets/connectors"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const connectors = connectorsData?.connectors ?? [];
  const activeConnector = connectors.find((c) => c.id === selectedConnector);

  // ── Insert mutation ──────────────────────────────────────────────────────────
  const insertMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        `/api/sheets/workbooks/${workbookId}/blocks`,
        {
          label: label || (activeConnector?.label ?? "Data block"),
          connectorId: selectedConnector,
          connectorParams: paramValues,
          sheetId,
          startRow: 0,
          startCol: 0,
          autoRefresh,
        },
      );
      return (await res.json()) as { block: SheetDataBlock };
    },
    onSuccess: (data) => {
      toast({ title: "Data block inserted", description: "Refreshing data…" });
      void queryClient.invalidateQueries({
        queryKey: [`/api/sheets/workbooks/${workbookId}/blocks`],
      }); // fire-and-forget: cache refresh only
      onBlockCreated?.(data.block);
      handleClose();
    },
    onError: (err) => {
      const humanized = humanizeQueryError(err, { kind: "mutation" });
      toast({
        title: "Couldn't insert the data block",
        description: humanized.description,
        variant: "destructive",
      });
    },
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function handleClose() {
    onOpenChange(false);
    setSelectedConnector("");
    setLabel("");
    setAutoRefresh(false);
    setParamValues({});
  }

  function handleConnectorChange(id: string) {
    setSelectedConnector(id);
    setParamValues({});
    const c = connectors.find((x) => x.id === id);
    if (c) setLabel(c.label);
  }

  function handleParamChange(key: string, value: string) {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  }

  function canSubmit(): boolean {
    if (!selectedConnector || insertMutation.isPending) return false;
    if (!activeConnector) return false;
    for (const p of activeConnector.params) {
      if (p.required && !paramValues[p.key]) return false;
    }
    return true;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-md" data-testid="insert-data-dialog">
        <DialogHeader>
          <DialogTitle>Insert live data</DialogTitle>
          <DialogDescription>
            Embed a refreshable data block from a live NoBull connector into
            this sheet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Connector select */}
          <div className="space-y-1.5">
            <Label htmlFor="connector-select">Data source</Label>
            {connectorsLoading ? (
              <div className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading connectors…
              </div>
            ) : (
              <Select
                value={selectedConnector}
                onValueChange={handleConnectorChange}
              >
                <SelectTrigger
                  id="connector-select"
                  data-testid="connector-select"
                >
                  <SelectValue placeholder="Choose a connector…" />
                </SelectTrigger>
                <SelectContent>
                  {connectors.map((c) => (
                    <SelectItem key={c.id} value={c.id} data-testid={`connector-option-${c.id}`}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {activeConnector && (
              <p className="text-xs text-muted-foreground">
                {activeConnector.description}
              </p>
            )}
          </div>

          {/* Dynamic connector params */}
          {activeConnector &&
            activeConnector.params.map((p) => (
              <div key={p.key} className="space-y-1.5">
                <Label htmlFor={`param-${p.key}`}>
                  {p.label}
                  {p.required && (
                    <span className="ml-1 text-destructive">*</span>
                  )}
                </Label>
                {p.type === "enum" && p.options ? (
                  <Select
                    value={paramValues[p.key] ?? ""}
                    onValueChange={(v) => handleParamChange(p.key, v)}
                  >
                    <SelectTrigger
                      id={`param-${p.key}`}
                      data-testid={`param-select-${p.key}`}
                    >
                      <SelectValue placeholder={`Select ${p.label}…`} />
                    </SelectTrigger>
                    <SelectContent>
                      {p.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`param-${p.key}`}
                    data-testid={`param-input-${p.key}`}
                    type={p.type === "number" ? "number" : "text"}
                    placeholder={p.description ?? p.label}
                    value={paramValues[p.key] ?? ""}
                    onChange={(e) => handleParamChange(p.key, e.target.value)}
                  />
                )}
                {p.description && p.type !== "enum" && (
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                )}
              </div>
            ))}

          {/* Block label */}
          {activeConnector && (
            <div className="space-y-1.5">
              <Label htmlFor="block-label">Label</Label>
              <Input
                id="block-label"
                data-testid="input-block-label"
                placeholder={activeConnector.label}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shown above the data block in the sheet.
              </p>
            </div>
          )}

          {/* Auto-refresh toggle */}
          {activeConnector && (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="space-y-0.5">
                <Label htmlFor="auto-refresh-toggle" className="text-sm">
                  Daily auto-refresh
                </Label>
                <p className="text-xs text-muted-foreground">
                  Re-pull data once per day automatically.
                </p>
              </div>
              <Switch
                id="auto-refresh-toggle"
                data-testid="switch-auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={insertMutation.isPending}
            data-testid="btn-insert-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => insertMutation.mutate()}
            disabled={!canSubmit()}
            data-testid="btn-insert-confirm"
          >
            {insertMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Inserting…
              </>
            ) : (
              "Insert data"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
