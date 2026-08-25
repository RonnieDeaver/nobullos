import { useMemo } from "react";
import { formatDistanceToNow, format } from "date-fns";
import { History } from "lucide-react";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";

export type CommandPanelHistoryEntry = {
  id: string;
  commandPanelId: string;
  clientId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  reason: string | null;
  createdAt: string;
};

type UserLite = { id: string; firstName?: string | null; lastName?: string | null; email?: string | null };

function userLabel(userId: string, allUsers: UserLite[]): string {
  const u = allUsers.find((u) => u.id === userId) ?? null;
  return formatEditorAttribution(
    { changedBy: userId, changedByUser: u },
    "Unknown",
  );
}

/**
 * Per-section "Last edited by X · 2h ago" affordance for Command Panel
 * cards. Filters the shared command_panel_history feed down to a fixed
 * set of fields and opens the existing ChangelogViewer pre-filtered to
 * the same set when clicked. (Task #999.)
 */
export function CommandPanelSectionAuditInfo({
  section,
  fields,
  history,
  allUsers,
  onOpenHistory,
}: {
  section: string;
  fields: string[];
  history: CommandPanelHistoryEntry[];
  allUsers: UserLite[];
  onOpenHistory?: (filterFields: string[]) => void;
}) {
  const latest = useMemo(() => {
    if (fields.length === 0) return undefined;
    const allowed = new Set(fields);
    let newest: CommandPanelHistoryEntry | undefined;
    for (const e of history) {
      if (!allowed.has(e.fieldName)) continue;
      if (!newest || (e.createdAt && newest.createdAt && e.createdAt > newest.createdAt)) {
        newest = e;
      }
    }
    return newest;
  }, [fields, history]);

  if (!latest) {
    return (
      <span
        className="text-[10px] text-muted-foreground"
        data-testid={`text-section-audit-${section}`}
      >
        Last edited: —
      </span>
    );
  }

  const who = userLabel(latest.changedBy, allUsers);
  const when = (() => {
    try {
      const d = new Date(latest.createdAt);
      if (Number.isNaN(d.getTime())) return "—";
      return formatDistanceToNow(d, { addSuffix: true });
    } catch { return "—"; }
  })();
  const tooltip = (() => {
    try {
      const d = new Date(latest.createdAt);
      return `Last edited by ${who} on ${format(d, "PPpp")}`;
    } catch { return `Last edited by ${who}`; }
  })();

  const inner = (
    <>
      <History className="w-2.5 h-2.5" />
      Last edited by {who} {when}
    </>
  );

  if (onOpenHistory) {
    return (
      <button
        type="button"
        onClick={() => onOpenHistory(fields)}
        title={tooltip}
        className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
        data-testid={`button-section-audit-${section}`}
      >
        {inner}
      </button>
    );
  }

  return (
    <span
      title={tooltip}
      className="text-[10px] text-muted-foreground inline-flex items-center gap-1"
      data-testid={`text-section-audit-${section}`}
    >
      {inner}
    </span>
  );
}
