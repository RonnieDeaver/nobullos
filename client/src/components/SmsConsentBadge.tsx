/**
 * Task #4336 — SMS consent state surfaces.
 *
 * Small presentational badge + query hooks for the per-phone consent ledger.
 * Human 1:1 console sends deliberately bypass the automated-send gate, so
 * these surfaces exist to put the recipient's consent state in front of the
 * sender everywhere a phone number is shown (Conversation Hub header,
 * composer, client contacts).
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";

export type SmsConsentState = "opted_in" | "opted_out" | "unknown";

export interface SmsConsentStatus {
  phone: string;
  phoneMatchKey: string | null;
  state: SmsConsentState;
  exists: boolean;
  source: string | null;
  evidence: string | null;
  timezone: string | null;
  optedInAt: string | null;
  optedOutAt: string | null;
  updatedAt: string | null;
}

export function useSmsConsentStatus(phone: string | null | undefined) {
  return useQuery<SmsConsentStatus>({
    queryKey: ["/api/sms-consent/status", phone ?? "none"],
    enabled: Boolean(phone),
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/sms-consent/status?phone=${encodeURIComponent(phone!)}`,
      );
      return res.json();
    },
  });
}

/** Batch lookup keyed by the exact phone strings passed in. */
export function useSmsConsentStatusBatch(phones: string[]) {
  const unique = [...new Set(phones.filter(Boolean))];
  return useQuery<Record<string, SmsConsentStatus>>({
    queryKey: ["/api/sms-consent/status-batch", unique.slice().sort().join(",") || "none"],
    enabled: unique.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/sms-consent/status-batch", {
        phones: unique.slice(0, 200),
      });
      const body = (await res.json()) as { statuses: Record<string, SmsConsentStatus> };
      return body.statuses;
    },
  });
}

const STATE_STYLES: Record<SmsConsentState, { classes: string; label: string; short: string }> = {
  opted_in: {
    classes: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/25",
    label: "SMS opt-in",
    short: "Opt-in",
  },
  opted_out: {
    classes: "text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/25",
    label: "SMS opted out",
    short: "Opted out",
  },
  unknown: {
    classes: "text-gray-600 bg-gray-100",
    label: "SMS consent unknown",
    short: "Consent ?",
  },
};

function StateIcon({ state, className }: { state: SmsConsentState; className?: string }) {
  if (state === "opted_in") return <ShieldCheck className={className} />;
  if (state === "opted_out") return <ShieldOff className={className} />;
  return <ShieldQuestion className={className} />;
}

function describe(status: SmsConsentStatus): string {
  const parts: string[] = [];
  if (status.state === "opted_out") {
    parts.push("This number opted out of SMS (STOP). Twilio blocks sends until they text START.");
  } else if (status.state === "opted_in") {
    parts.push("This number opted in to SMS.");
  } else {
    parts.push("No consent has been expressed for this number yet.");
  }
  if (status.source) parts.push(`Source: ${status.source}`);
  if (status.evidence) parts.push(status.evidence);
  return parts.join(" — ");
}

export function SmsConsentBadge({
  status,
  compact = false,
}: {
  status: SmsConsentStatus | undefined;
  compact?: boolean;
}) {
  if (!status) return null;
  const style = STATE_STYLES[status.state] ?? STATE_STYLES.unknown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-center gap-1 text-caption font-medium px-1.5 py-0.5 rounded ${style.classes}`}
          data-testid={`badge-sms-consent-${status.state}`}
        >
          <StateIcon state={status.state} className="w-3 h-3" />
          {compact ? style.short : style.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{describe(status)}</TooltipContent>
    </Tooltip>
  );
}

/** Convenience wrapper that fetches + renders for a single phone. */
export function SmsConsentBadgeForPhone({
  phone,
  compact = false,
}: {
  phone: string | null | undefined;
  compact?: boolean;
}) {
  const { data } = useSmsConsentStatus(phone);
  if (!phone || !data) return null;
  return <SmsConsentBadge status={data} compact={compact} />;
}
