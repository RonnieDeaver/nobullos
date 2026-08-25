import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";

interface EditorUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

interface SectionAuditInfoProps {
  reportId: string | null | undefined;
  sectionKey: string;
  lastEditedBy?: string | null;
  lastEditSource?: string | null;
  lastEditAt?: string | Date | null;
  lastEditedByUser?: EditorUser | null;
}

interface HistoryEntry {
  id: string;
  reportId: string;
  sectionKey: string;
  previousData: unknown;
  newData: unknown;
  dataChanged: boolean;
  editedBy: string;
  editSource: string;
  webhookImportLogId: string | null;
  createdAt: string;
  editorUser?: EditorUser | null;
}

function formatEditor(
  editedBy: string | null | undefined,
  editorUser: EditorUser | null | undefined,
): string {
  if (!editedBy && !editorUser) return "unknown";
  return formatEditorAttribution(
    { changedBy: editedBy ?? null, changedByUser: editorUser ?? null },
    "unknown",
  );
}

const SOURCE_LABELS: Record<string, string> = {
  pdf_webhook: "PDF webhook",
  manual_pdf_upload: "Manual PDF upload",
  ui_edit: "Manual edit",
  ai_format: "AI format",
  curated_library: "Curated copy library",
  api: "API",
  system: "System",
  migration_seed: "Backfill (seed)",
  unknown: "Unknown",
};

function previewJson(value: unknown, max = 220): string {
  if (value === null || value === undefined) return "—";
  let str: string;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    str = String(value);
  }
  if (str.length > max) str = str.slice(0, max) + "…";
  return str;
}

function HistoryRow({
  entry,
  sectionKey,
}: {
  entry: HistoryEntry;
  sectionKey: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="rounded border border-border bg-card p-2 text-[11px]"
      data-testid={`row-history-${sectionKey}-${entry.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="text-muted-foreground">{formatTimestamp(entry.createdAt)}</span>
        <span
          className="text-foreground font-medium"
          data-testid={`text-history-editor-${sectionKey}-${entry.id}`}
        >
          {formatEditor(entry.editedBy, entry.editorUser)}
        </span>
        <span className="text-muted-foreground">via</span>
        <span>{SOURCE_LABELS[entry.editSource] || entry.editSource}</span>
        {!entry.dataChanged && (
          <span className="rounded bg-muted px-1 text-muted-foreground">no data change</span>
        )}
        {entry.webhookImportLogId && (
          <span className="text-muted-foreground">log {entry.webhookImportLogId.slice(0, 8)}</span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-blue-600 hover:underline"
          data-testid={`button-toggle-diff-${sectionKey}-${entry.id}`}
        >
          {open ? "Hide diff" : "Show diff"}
        </button>
      </div>
      {open && (
        <div
          className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2"
          data-testid={`panel-diff-${sectionKey}-${entry.id}`}
        >
          <div>
            <div className="mb-1 font-medium text-muted-foreground">Previous</div>
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-caption text-foreground"
              data-testid={`text-prev-${sectionKey}-${entry.id}`}
            >
              {previewJson(entry.previousData)}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-medium text-muted-foreground">New</div>
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-caption text-foreground"
              data-testid={`text-new-${sectionKey}-${entry.id}`}
            >
              {previewJson(entry.newData)}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

function formatTimestamp(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export default function SectionAuditInfo({
  reportId,
  sectionKey,
  lastEditedBy,
  lastEditSource,
  lastEditAt,
  lastEditedByUser,
}: SectionAuditInfoProps) {
  const [expanded, setExpanded] = useState(false);

  const { data: history, isLoading, error } = useQuery<HistoryEntry[]>({
    queryKey: ["/api/reports", reportId, "sections", sectionKey, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${reportId}/sections/${sectionKey}/history`, {
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 403) return [];
        throw new Error("Failed to load history");
      }
      return res.json();
    },
    enabled: !!reportId && expanded,
  });

  if (!reportId) return null;

  const source = lastEditSource || "unknown";
  const sourceLabel = SOURCE_LABELS[source] || source;
  const editorLabel = formatEditor(lastEditedBy ?? null, lastEditedByUser ?? null);

  return (
    <div
      className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground mb-3"
      data-testid={`audit-info-${sectionKey}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left hover:text-foreground"
        data-testid={`button-toggle-history-${sectionKey}`}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3 w-3" />
        <span>
          Last edited by{" "}
          <span className="font-medium" data-testid={`text-last-editor-${sectionKey}`}>
            {editorLabel}
          </span>{" "}
          on{" "}
          <span data-testid={`text-last-edit-at-${sectionKey}`}>
            {formatTimestamp(lastEditAt ?? null)}
          </span>{" "}
          via{" "}
          <span className="font-medium" data-testid={`text-last-source-${sectionKey}`}>
            {sourceLabel}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 border-t border-border pt-2" data-testid={`panel-history-${sectionKey}`}>
          {isLoading && <div className="text-muted-foreground">Loading history…</div>}
          {error && <div className="text-red-500">Failed to load history.</div>}
          {!isLoading && !error && (!history || history.length === 0) && (
            <div className="text-muted-foreground">No audit history available.</div>
          )}
          {!isLoading && !error && history && history.length > 0 && (
            <ul className="space-y-2 max-h-72 overflow-y-auto">
              {history.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  sectionKey={sectionKey}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
