import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import { History } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export type LocationAuditSummary = {
  locationId: string;
  action: string;
  createdAt: string | null;
  actorUserId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorEmail: string | null;
  source: string | null;
  reason: string | null;
};

export type LocationAuditEntry = LocationAuditSummary & {
  oldName: string | null;
  newName: string | null;
  oldAddress: string | null;
  newAddress: string | null;
  oldCity: string | null;
  newCity: string | null;
  oldState: string | null;
  newState: string | null;
  oldLat: number | null;
  newLat: number | null;
  oldLng: number | null;
  newLng: number | null;
  oldIsActive: boolean | null;
  newIsActive: boolean | null;
};

function actorLabel(row: Pick<LocationAuditSummary, "actorFirstName" | "actorLastName" | "actorEmail" | "source">): string {
  const name = [row.actorFirstName, row.actorLastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (row.actorEmail) return row.actorEmail;
  if (row.source && row.source !== "operator_ui") return `system (${row.source})`;
  return "Unknown";
}

function relativeOrDash(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "—";
  }
}

function actionVerb(action: string): string {
  switch (action) {
    case "insert": return "created";
    case "update": return "edited";
    case "delete": return "deleted";
    default: return action;
  }
}

function diffSummary(entry: LocationAuditEntry): string[] {
  if (entry.action === "insert") return ["Location created"];
  if (entry.action === "delete") return ["Location deleted"];
  const changes: string[] = [];
  if ((entry.oldName ?? "") !== (entry.newName ?? "")) {
    changes.push(`Name: "${entry.oldName ?? ""}" → "${entry.newName ?? ""}"`);
  }
  if ((entry.oldAddress ?? "") !== (entry.newAddress ?? "")) {
    changes.push(`Address: "${entry.oldAddress ?? ""}" → "${entry.newAddress ?? ""}"`);
  }
  if ((entry.oldCity ?? "") !== (entry.newCity ?? "") || (entry.oldState ?? "") !== (entry.newState ?? "")) {
    const oldLoc = [entry.oldCity, entry.oldState].filter(Boolean).join(", ");
    const newLoc = [entry.newCity, entry.newState].filter(Boolean).join(", ");
    changes.push(`City/State: "${oldLoc}" → "${newLoc}"`);
  }
  if (entry.oldIsActive !== entry.newIsActive) {
    changes.push(`Active: ${entry.oldIsActive ? "yes" : "no"} → ${entry.newIsActive ? "yes" : "no"}`);
  }
  if (changes.length === 0) changes.push("No visible changes");
  return changes;
}

export function LocationAuditInfo({
  clientId,
  locationId,
  locationName,
  audit,
}: {
  clientId: string;
  locationId: string | number;
  locationName: string;
  audit: LocationAuditSummary | undefined;
}) {
  const [open, setOpen] = useState(false);

  const { data: history = [], isLoading } = useQuery<LocationAuditEntry[]>({
    queryKey: [`/api/clients/${clientId}/locations/${locationId}/audit`],
    enabled: open,
  });

  if (!audit) {
    return (
      <span
        className="text-[10px] text-muted-foreground"
        data-testid={`text-location-audit-${locationId}`}
      >
        Last edited: —
      </span>
    );
  }

  const who = actorLabel(audit);
  const when = relativeOrDash(audit.createdAt);
  const verb = actionVerb(audit.action);
  const tooltip = audit.createdAt
    ? `${verb} by ${who} on ${format(new Date(audit.createdAt), "PPpp")}`
    : `${verb} by ${who}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
        title={tooltip}
        data-testid={`button-location-audit-${locationId}`}
      >
        <History className="w-2.5 h-2.5" />
        Last {verb} by {who} {when}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-testid={`dialog-location-history-${locationId}`}>
          <DialogHeader>
            <DialogTitle>Edit history — {locationName}</DialogTitle>
          </DialogHeader>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid={`text-location-history-empty-${locationId}`}>
              No edit history recorded for this location.
            </p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {history.map((entry, idx) => (
                <div
                  key={`${entry.createdAt ?? "na"}-${idx}`}
                  className="border rounded p-2 text-xs"
                  data-testid={`row-location-history-${locationId}-${idx}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {entry.action}
                      </Badge>
                      <span className="font-medium">{actorLabel(entry)}</span>
                    </div>
                    <span
                      className="text-muted-foreground"
                      title={entry.createdAt ? format(new Date(entry.createdAt), "PPpp") : ""}
                    >
                      {relativeOrDash(entry.createdAt)}
                    </span>
                  </div>
                  <ul className="mt-1 list-disc list-inside text-muted-foreground space-y-0.5">
                    {diffSummary(entry).map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                  {entry.source && entry.source !== "operator_ui" && (
                    <div className="text-[10px] text-muted-foreground mt-1">Source: {entry.source}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
