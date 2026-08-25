import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Task #1941 — Generic audit-history popover. Mirrors the
// DeleteRestoreHistoryPopover shape from Task #1912 (UserManagement.tsx)
// but parameterized by entity ("client" | "product") so the same
// component can render history for any entity wired to
// /api/audit-history.
export type AuditEvent = {
  id: string;
  actionType: string;
  actorId: string | null;
  actorName: string | null;
  timestamp: string;
  actionDetail: string | null;
  metadata: Record<string, any> | null;
};

export type AuditHistoryEntity = "client" | "product";

const ACTION_LABELS: Record<string, { label: string; tone: "added" | "removed" | "edited" }> = {
  client_created: { label: "Created", tone: "added" },
  client_updated: { label: "Edited", tone: "edited" },
  client_deleted: { label: "Deleted", tone: "removed" },
  product_added: { label: "Added", tone: "added" },
  product_removed: { label: "Removed", tone: "removed" },
};

function formatHistoryDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export function useAuditHistory(entity: AuditHistoryEntity, ids: string[]) {
  const key = ids.slice().sort().join(",");
  return useQuery<Record<string, AuditEvent[]>>({
    queryKey: ["/api/audit-history", entity, key],
    enabled: ids.length > 0,
    queryFn: async () => {
      const params = new URLSearchParams({ entity, ids: key });
      const res = await fetch(`/api/audit-history?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch audit history");
      return res.json();
    },
  });
}

export function AuditHistoryPopover({
  entity,
  targetId,
  events,
  title,
  testIdSuffix,
  size = "sm",
}: {
  entity: AuditHistoryEntity;
  targetId: string;
  events: AuditEvent[] | undefined;
  title?: string;
  testIdSuffix?: string;
  size?: "xs" | "sm";
}) {
  if (!events || events.length === 0) return null;
  const suffix = testIdSuffix ?? targetId;
  const heading = title ?? (entity === "product" ? "Product history" : "Client history");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={
            size === "xs"
              ? "h-6 px-1.5 text-[11px] text-primary-ink hover:bg-primary/10"
              : "h-7 px-2 text-xs text-primary-ink hover:bg-primary/10"
          }
          data-testid={`button-audit-history-${entity}-${suffix}`}
        >
          <History className={size === "xs" ? "w-3 h-3 mr-1" : "w-3.5 h-3.5 mr-1"} />
          History
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3 max-h-96 overflow-y-auto"
        data-testid={`popover-audit-history-${entity}-${suffix}`}
      >
        <p className="text-xs font-medium text-foreground mb-2">{heading}</p>
        <ol className="space-y-2">
          {events.map((ev) => {
            const meta = ACTION_LABELS[ev.actionType] ?? { label: ev.actionType, tone: "edited" as const };
            const toneClasses =
              meta.tone === "added"
                ? "bg-green-50 text-green-700 border border-green-200"
                : meta.tone === "removed"
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-700 border border-amber-200";
            return (
              <li
                key={ev.id}
                className="text-xs text-foreground flex gap-2"
                data-testid={`history-event-${ev.id}`}
              >
                <span
                  className={
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0 " +
                    toneClasses
                  }
                >
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p>
                    by{" "}
                    <span className="font-medium">{ev.actorName || "System"}</span>
                  </p>
                  <p className="text-muted-foreground">{formatHistoryDate(ev.timestamp)}</p>
                  {ev.actionDetail && (
                    <p className="text-muted-foreground truncate" title={ev.actionDetail}>
                      {ev.actionDetail}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
