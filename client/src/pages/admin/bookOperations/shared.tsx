/**
 * Small UI primitives shared across the Book Operations console tabs.
 * Kept here to avoid prop-drilling and to keep each tab file focused.
 */
import { capitalize } from "./utils";

// ─── Status badge ─────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "").toLowerCase().replace(/_/g, " ");
  const cls =
    s === "completed" || s === "fulfilled" || s === "payment captured" || s === "active"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
      : s === "pending" || s === "processing" || s === "fulfillment queued"
        ? "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
        : s === "failed" || s === "error" || s === "dead letter"
          ? "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300"
          : s === "refunded" || s === "partially refunded" || s === "revoked" || s === "cancelled"
            ? "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-300"
            : s === "unknown" || s === "reconciliation needed"
              ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-300";
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {capitalize(status ?? "")}
    </span>
  );
}

// ─── Exception source badge ───────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  checkout_payment: "Checkout",
  payment_event: "Payment",
  ghl_outbox: "GHL Outbox",
  analytics_delivery: "Analytics",
  delivery_audit: "Delivery",
};

export function ExcSourceBadge({ source }: { source: string }) {
  const label = SOURCE_LABEL[source] ?? capitalize(source);
  const cls =
    source === "ghl_outbox"
      ? "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300"
      : source === "checkout_payment" || source === "payment_event"
        ? "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300"
        : source === "analytics_delivery"
          ? "bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300"
          : source === "delivery_audit"
            ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
            : "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-300";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

// ─── Detail field ─────────────────────────────────────────────────────────────

export function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 ${mono ? "font-mono text-xs break-all" : "text-sm"} text-slate-800 dark:text-slate-200`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
