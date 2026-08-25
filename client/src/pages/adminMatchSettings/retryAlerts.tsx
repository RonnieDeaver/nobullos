// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { useToast } from "@/hooks/use-toast";
import { type AlertDeliveryStatus } from "./model";

type BulkRetryRowResult = {
  id: string;
  status: "succeeded" | "failed" | "error";
  error?: string;
};

type RetryAlertResponse = {
  id: string;
  slackStatus: AlertDeliveryStatus | null;
  emailStatus: AlertDeliveryStatus | null;
  slackFailureReason?: string | null;
  emailFailureReason?: string | null;
  retried?: { slack?: boolean; email?: boolean };
};

class RetryAlertError extends Error {
  httpStatus: number;
  body: Record<string, unknown>;
  constructor(message: string, httpStatus: number, body: Record<string, unknown>) {
    super(message);
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

async function postRetryAlerts(url: string): Promise<RetryAlertResponse> {
  const res = await fetch(url, { method: "POST", credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (typeof body?.error === "string" && body.error) || "Failed to retry alerts";
    throw new RetryAlertError(message, res.status, body);
  }
  return body as RetryAlertResponse;
}

function describeChannelOutcome(
  label: string,
  status: AlertDeliveryStatus | null | undefined,
  failureReason?: string | null,
): string {
  if (status === "delivered") return `${label} delivered`;
  if (status === "skipped") return `${label} skipped`;
  if (status === "failed") {
    const reason = failureReason && failureReason.trim().length > 0
      ? failureReason
      : "no reason returned";
    return `${label} still failed: ${reason}`;
  }
  return `${label} ${status ?? "unknown"}`;
}

export function createRetryToastHelpers(toast: ReturnType<typeof useToast>["toast"]) {
  function showRetrySuccessToast(data: RetryAlertResponse) {
    const retried = data.retried ?? {};
    const parts: string[] = [];
    if (retried.slack) {
      parts.push(describeChannelOutcome("Slack", data.slackStatus, data.slackFailureReason));
    }
    if (retried.email) {
      parts.push(describeChannelOutcome("Email", data.emailStatus, data.emailFailureReason));
    }
    if (parts.length === 0) {
      // Fallback if server didn't include `retried` (shouldn't happen for new
      // responses, but keep the toast informative).
      if (data.slackStatus) {
        parts.push(describeChannelOutcome("Slack", data.slackStatus, data.slackFailureReason));
      }
      if (data.emailStatus) {
        parts.push(describeChannelOutcome("Email", data.emailStatus, data.emailFailureReason));
      }
    }
    const hasRetriedFlags = retried.slack !== undefined || retried.email !== undefined;
    const stillFailed = hasRetriedFlags
      ? (retried.slack && data.slackStatus === "failed") ||
        (retried.email && data.emailStatus === "failed")
      : data.slackStatus === "failed" || data.emailStatus === "failed";
    toast({
      title: stillFailed ? "Retry attempted — still failing" : "Alert re-sent",
      description: parts.join(" · ") || "Retry completed.",
      variant: stillFailed ? "destructive" : undefined,
      duration: 5000,
    });
  }

  function showRetryErrorToast(err: unknown) {
    if (err instanceof RetryAlertError) {
      if (err.httpStatus === 429) {
        const remainingMs =
          typeof err.body?.cooldownRemainingMs === "number"
            ? (err.body.cooldownRemainingMs as number)
            : null;
        const remainingText =
          remainingMs !== null
            ? ` Try again in ~${Math.max(1, Math.ceil(remainingMs / 1000))}s.`
            : "";
        toast({
          title: "Retry on cooldown",
          description: `${err.message}${remainingText}`,
          variant: "destructive",
          duration: 5000,
        });
        return;
      }
      if (err.httpStatus === 409) {
        toast({
          title: "Retry already in progress",
          description: err.message,
          variant: "destructive",
          duration: 5000,
        });
        return;
      }
    }
    const message = err instanceof Error ? err.message : "Failed to retry alerts";
    toast({
      title: "Retry failed",
      description: message,
      variant: "destructive",
      duration: 5000,
    });
  }
  return { showRetrySuccessToast, showRetryErrorToast };
}
export { RetryAlertError, postRetryAlerts, describeChannelOutcome, type BulkRetryRowResult, type RetryAlertResponse };
