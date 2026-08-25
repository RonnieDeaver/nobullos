/**
 * Task #4365 — Notification type → icon/tone/label mapping (audit P2-11).
 *
 * One source of truth for how a notification category renders across the
 * bell dropdown and the /notifications inbox: which icon leads the row,
 * which tone the icon chip carries, and the human label the meta line
 * shows as the source. Presentation only — the category set itself is
 * owned by the server (`userNotificationCategories` in shared/schema).
 *
 * Tone discipline (kit README / StatusPill): red only for actionable-now,
 * so nothing here defaults to critical. Comms arrivals = info; direct-to-you
 * items (mention/assignment) = primary; confirmed-good moments (booking) =
 * ok; operational alert families (system/queue_health) = warn, matching the
 * System tab's existing amber language; everything else stays neutral.
 */
import {
  Activity,
  AlertTriangle,
  AtSign,
  Bell,
  Bot,
  Briefcase,
  CalendarCheck,
  ClipboardList,
  LifeBuoy,
  Lightbulb,
  MessageSquare,
  Phone,
  Voicemail,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/** Icon-chip tones — the status tokens plus `primary` for direct-to-you items. */
export type NotificationTone = "neutral" | "ok" | "warn" | "info" | "primary";

export interface NotificationTypeMeta {
  icon: LucideIcon;
  tone: NotificationTone;
  /** Human source label for meta lines and the category filter. */
  label: string;
}

/** Token-only classes for the leading icon chip (square per the OS contract). */
export const NOTIFICATION_TONE_CLASSES: Record<NotificationTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  ok: "bg-status-ok/10 text-status-ok",
  warn: "bg-status-warn/10 text-status-warn",
  info: "bg-status-info/10 text-status-info",
  primary: "bg-primary/10 text-primary",
};

const TYPE_META: Record<string, NotificationTypeMeta> = {
  "comms.sms": { icon: MessageSquare, tone: "info", label: "SMS" },
  "comms.call": { icon: Phone, tone: "info", label: "Call" },
  "comms.voicemail": { icon: Voicemail, tone: "info", label: "Voicemail" },
  booking: { icon: CalendarCheck, tone: "ok", label: "Booking" },
  mention: { icon: AtSign, tone: "primary", label: "Mention" },
  assignment: { icon: ClipboardList, tone: "primary", label: "Assignment" },
  agent: { icon: Bot, tone: "neutral", label: "Agent" },
  feedback: { icon: Lightbulb, tone: "neutral", label: "Feedback" },
  service_desk: { icon: LifeBuoy, tone: "neutral", label: "Service desk" },
  crm: { icon: Briefcase, tone: "neutral", label: "CRM" },
  system: { icon: AlertTriangle, tone: "warn", label: "System" },
  queue_health: { icon: Activity, tone: "warn", label: "Queue health" },
};

const FALLBACK_META: NotificationTypeMeta = {
  icon: Bell,
  tone: "neutral",
  label: "Notification",
};

/**
 * Meta for a category. Unknown categories fall back to a neutral bell with
 * a prettified label so a new server-side category never renders raw
 * `snake_case` in operator-facing copy.
 */
export function notificationTypeMeta(
  category: string | null | undefined,
): NotificationTypeMeta {
  if (!category) return FALLBACK_META;
  const known = TYPE_META[category];
  if (known) return known;
  const pretty = category.replace(/[._-]+/g, " ").trim();
  return pretty
    ? { ...FALLBACK_META, label: pretty.charAt(0).toUpperCase() + pretty.slice(1) }
    : FALLBACK_META;
}

/** Relative "3 hours ago" timestamp; empty string on unparseable input. */
export function notificationRelativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}
