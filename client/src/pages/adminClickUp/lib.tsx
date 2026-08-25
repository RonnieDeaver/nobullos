// ClickUp admin — shared formatting/proxy + custom-field helpers, PlanLimitedNotice.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { BarChart2, File, Plus } from "lucide-react";
import type { Attachment, CustomField } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function statusColor(status?: { color?: string; type?: string }): string {
  if (!status) return "bg-gray-100 text-gray-600";
  if (status.type === "done") return "bg-green-100 text-green-700";
  if (status.type === "in_progress") return "bg-blue-100 text-blue-700";
  if (status.type === "closed") return "bg-gray-200 text-gray-500";
  return "bg-amber-100 text-amber-700";
}

export function priorityLabel(p?: { priority: string } | null): string {
  if (!p) return "";
  return p.priority;
}

export function fmtMs(ms: number | null | undefined): string {
  if (!ms) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(Number(ts)).toLocaleDateString();
}

// ─── Helpers (continued) ─────────────────────────────────────────────────────

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Build the authenticated proxy URL for a ClickUp attachment. */
export function proxyUrl(att: Attachment, download = false): string {
  const raw = att.url_w_query || att.url;
  const base = `/api/clickup/attachments/proxy?url=${encodeURIComponent(raw)}`;
  if (download) return `${base}&download=1&filename=${encodeURIComponent(att.name)}`;
  return base;
}

/** Build the proxy URL for a thumbnail, falling back to the full attachment. */
export function thumbProxyUrl(att: Attachment): string {
  const thumb = att.thumbnail_medium || att.thumbnail_small || att.thumbnail_large;
  if (thumb) {
    return `/api/clickup/attachments/proxy?url=${encodeURIComponent(thumb)}`;
  }
  return proxyUrl(att);
}

// ─── Custom-field helpers ──────────────────────────────────────────────────────

export const CF_READ_ONLY = new Set(["formula", "rollup", "auto_progress", "manual_progress"]);

export function isApplicableToTask(field: CustomField, customItemId?: string | null): boolean {
  if (!field.applied_objects || field.applied_objects.length === 0) return true;
  // Field is scoped to specific task types; if this task has no custom_item_id it doesn't match.
  if (!customItemId) return false;
  return field.applied_objects.some((ao) => ao.object_type === 19 && ao.object_id === customItemId);
}

export function cfDisplayValue(field: CustomField): string {
  const val = field.value;
  if (val === null || val === undefined || val === "") return "—";
  switch (field.type) {
    case "checkbox":
      return val ? "Yes" : "No";
    case "date":
      return new Date(Number(val)).toLocaleDateString();
    case "currency": {
      const n = Number(val);
      const sym = field.type_config?.currency_type ?? "$";
      const prec = field.type_config?.precision ?? 2;
      return isNaN(n) ? String(val) : `${sym}${n.toFixed(prec)}`;
    }
    case "number": {
      const n = Number(val);
      const prec = field.type_config?.precision ?? 0;
      return isNaN(n) ? String(val) : n.toFixed(prec);
    }
    case "rating":
    case "emoji": {
      const n = Number(val);
      const max = field.type_config?.count ?? 5;
      return `${n} / ${max}`;
    }
    case "dropdown": {
      const opts = field.type_config?.options ?? [];
      const opt = opts.find((o) => o.id === val || String(o.orderindex) === String(val));
      return opt?.name ?? String(val);
    }
    case "labels": {
      if (!Array.isArray(val)) return String(val);
      const opts = field.type_config?.options ?? [];
      return val
        .map((v: any) => {
          if (typeof v === "object" && v !== null) {
            const opt = opts.find((o) => o.id === (v.id ?? v));
            return opt?.name ?? v.label ?? v.name ?? String(v.id ?? v);
          }
          const opt = opts.find((o) => o.id === String(v));
          return opt?.name ?? String(v);
        })
        .join(", ");
    }
    case "users": {
      if (!Array.isArray(val)) return String(val);
      return val.map((u: any) => u.username ?? u.email ?? String(u.id ?? u)).join(", ");
    }
    case "relationship": {
      if (!Array.isArray(val)) return String(val);
      return val.length > 0 ? `${val.length} linked task${val.length > 1 ? "s" : ""}` : "—";
    }
    case "file":
      return val ? "File attached" : "—";
    default:
      return Array.isArray(val) ? val.join(", ") : String(val);
  }
}

// ─── Plan-limit notice ────────────────────────────────────────────────────────

export function PlanLimitedNotice({ message }: { message?: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      data-testid="notice-plan-limited"
    >
      <BarChart2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
      <span>
        {message ??
          "This feature requires a Business Plus or higher ClickUp plan. Upgrade at app.clickup.com/settings/billing."}
      </span>
    </div>
  );
}

