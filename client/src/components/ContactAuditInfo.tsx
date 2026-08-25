import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import { History } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export type ContactAuditSummary = {
  contactId: string;
  action: string;
  createdAt: string | null;
  actorUserId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorEmail: string | null;
  source: string | null;
  reason: string | null;
};

export type ContactAuditEntry = ContactAuditSummary & {
  oldName: string | null;
  newName: string | null;
  oldRoleTitle: string | null;
  newRoleTitle: string | null;
  oldIsPrimary: boolean | null;
  newIsPrimary: boolean | null;
  oldEmails: string[] | null;
  newEmails: string[] | null;
  oldPhones: string[] | null;
  newPhones: string[] | null;
};

export function actorLabel(row: Pick<ContactAuditSummary, "actorFirstName" | "actorLastName" | "actorEmail" | "source">): string {
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

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

function diffSummary(entry: ContactAuditEntry): string[] {
  if (entry.action === "insert") return ["Contact created"];
  if (entry.action === "delete") return ["Contact deleted"];
  const changes: string[] = [];
  if ((entry.oldName ?? "") !== (entry.newName ?? "")) {
    changes.push(`Name: "${entry.oldName ?? ""}" → "${entry.newName ?? ""}"`);
  }
  if ((entry.oldRoleTitle ?? "") !== (entry.newRoleTitle ?? "")) {
    changes.push(`Role: "${entry.oldRoleTitle ?? ""}" → "${entry.newRoleTitle ?? ""}"`);
  }
  if (entry.oldIsPrimary !== entry.newIsPrimary) {
    changes.push(`Primary: ${entry.oldIsPrimary ? "yes" : "no"} → ${entry.newIsPrimary ? "yes" : "no"}`);
  }
  if (!arraysEqual(entry.oldEmails, entry.newEmails)) {
    changes.push(`Emails: [${(entry.oldEmails ?? []).join(", ")}] → [${(entry.newEmails ?? []).join(", ")}]`);
  }
  if (!arraysEqual(entry.oldPhones, entry.newPhones)) {
    changes.push(`Phones: [${(entry.oldPhones ?? []).join(", ")}] → [${(entry.newPhones ?? []).join(", ")}]`);
  }
  if (changes.length === 0) changes.push("No visible changes");
  return changes;
}

export function ContactAuditInfo({
  clientId,
  contactId,
  contactName,
  audit,
}: {
  clientId: string;
  contactId: string;
  contactName: string;
  audit: ContactAuditSummary | undefined;
}) {
  const [open, setOpen] = useState(false);

  const { data: history = [], isLoading } = useQuery<ContactAuditEntry[]>({
    queryKey: [`/api/clients/${clientId}/contacts/${contactId}/audit`],
    enabled: open,
  });

  if (!audit) {
    return (
      <span
        className="text-[10px] text-muted-foreground"
        data-testid={`text-contact-audit-${contactId}`}
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
        data-testid={`button-contact-audit-${contactId}`}
      >
        <History className="w-2.5 h-2.5" />
        Last {verb} by {who} {when}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-testid={`dialog-contact-history-${contactId}`}>
          <DialogHeader>
            <DialogTitle>Edit history — {contactName}</DialogTitle>
          </DialogHeader>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid={`text-contact-history-empty-${contactId}`}>
              No edit history recorded for this contact.
            </p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              <p
                className="text-[11px] text-muted-foreground border-l-2 border-muted pl-2"
                data-testid={`text-contact-history-prune-notice-${contactId}`}
              >
                Older edits may have been pruned by the audit retention policy.
                The most recent edits are always kept. Admins can change the
                window in Audit Retention Settings.
              </p>
              {history.map((entry, idx) => (
                <div
                  key={`${entry.createdAt ?? "na"}-${idx}`}
                  className="border rounded p-2 text-xs"
                  data-testid={`row-contact-history-${contactId}-${idx}`}
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
