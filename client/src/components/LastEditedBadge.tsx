import { Clock } from "lucide-react";

export type LastEditedUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

export type LastEditedInfo = {
  updatedAt: string | null;
  updatedBy: LastEditedUser | null;
} | null | undefined;

function formatUserName(user: LastEditedUser | null | undefined): string {
  if (!user) return "system";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || user.id || "system";
}

function formatWhen(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export function LastEditedBadge({
  info,
  testId,
  emptyText = "Never edited",
  className = "",
}: {
  info: LastEditedInfo;
  testId?: string;
  emptyText?: string;
  className?: string;
}) {
  const base =
    "inline-flex items-center gap-1 text-xs text-muted-foreground mt-1 " + className;
  if (!info || (!info.updatedAt && !info.updatedBy)) {
    return (
      <span className={base} data-testid={testId}>
        <Clock className="w-3 h-3" />
        {emptyText}
      </span>
    );
  }
  return (
    <span className={base} data-testid={testId}>
      <Clock className="w-3 h-3" />
      Last edited by{" "}
      <span className="font-medium text-foreground" data-testid={testId ? `${testId}-by` : undefined}>
        {formatUserName(info.updatedBy)}
      </span>{" "}
      on{" "}
      <span data-testid={testId ? `${testId}-at` : undefined}>
        {formatWhen(info.updatedAt)}
      </span>
    </span>
  );
}
