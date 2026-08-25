// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Copy } from "lucide-react";

/**
 * Task #2135 / #2211 — the Front analytics-coverage trigger routes
 * return a plain-English `reason` alongside the raw machine `error` on a
 * calm 503 "blocked" response. `apiRequest` throws "<status>: <body>",
 * so the friendly sentence is embedded as JSON in the thrown message.
 * Pull it out when present, otherwise fall back to the raw message.
 */
export function extractBlockedReason(raw: string): string {
  const match = raw.match(/\{.*\}/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed.reason === "string" && parsed.reason) {
        return parsed.reason;
      }
    } catch {
      // fall back to the raw message
    }
  }
  return raw;
}

export function CopyIdButton({
  value,
  label,
  testId,
}: {
  value: string;
  label: string;
  testId: string;
}) {
  const { toast } = useToast();
  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: `Copied ${label}`, duration: 2000 });
    } catch {
      toast({ title: `Failed to copy ${label}`, variant: "destructive" });
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="ml-1 inline-flex items-center justify-center rounded p-0.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 align-middle"
      data-testid={testId}
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}

/**
 * Task #1767 — operator-readable error cell for the Front Analytics
 * coverage table. The persisted error from
 * `front_analytics_monthly_coverage.front_analytics_error` already
 * carries the HTTP status + body snippet captured by
 * `pullMonthlyMessageCountViaSearchFallback`, but the old
 * `max-w-[280px] truncate` + `title=` tooltip clipped the diagnostic
 * data so operators could not read the status / body snippet. This
 * cell keeps the compact inline preview, adds an inline View toggle
 * that expands the full text in-place, and exposes a Copy button so
 * the error can be pasted into Slack / a follow-up task without
 * having to dig through server logs. Sensitive payloads are never
 * stored in this field (see `safeReadBodySnippet` in
 * `server/services/frontAnalyticsClient.ts`), so the full text is
 * safe to expose to admins.
 */
export function FrontAnalyticsErrorCell({
  month,
  error,
  reasonHuman,
}: {
  month: string;
  error: string;
  reasonHuman?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(error);
      } else {
        const ta = document.createElement("textarea");
        ta.value = error;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: "Copied error", duration: 2000 });
    } catch {
      toast({ title: "Failed to copy error", variant: "destructive" });
    }
  };
  return (
    <div className="flex flex-col gap-0.5">
      {/* Task #1974 — plain-English reason (derived server-side via
          explainFrontAnalyticsError) is shown first; the raw error
          stays accessible via Copy / View so operators can still grab
          the structured payload when filing a bug. */}
      {reasonHuman ? (
        <div
          className="text-xs text-rose-800 font-medium"
          data-testid={`text-fa-error-reason-${month}`}
        >
          {reasonHuman}
        </div>
      ) : null}
      <div
        className={
          expanded
            ? "whitespace-pre-wrap break-words text-xs text-rose-700"
            : "max-w-[280px] truncate text-xs text-rose-700"
        }
        title={expanded ? undefined : error}
        data-testid={`text-fa-error-body-${month}`}
      >
        {error}
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="underline hover:text-gray-800"
          data-testid={`button-fa-error-toggle-${month}`}
        >
          {expanded ? "Hide" : "View"}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy error"
          title="Copy full error"
          className="inline-flex items-center gap-0.5 underline hover:text-gray-800"
          data-testid={`button-fa-error-copy-${month}`}
        >
          <Copy className="h-3 w-3" /> Copy
        </button>
      </div>
    </div>
  );
}
