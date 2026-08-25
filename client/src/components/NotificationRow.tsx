/**
 * Task #4473 — Shared notification row for the bell dropdown and the
 * /notifications inbox page.
 *
 * After Task #4365 both surfaces shared the type icon/tone/label + relative
 * time helpers (client/src/lib/notificationTypeMeta.ts) but each kept its own
 * copy of the row JSX (icon chip, title, unread dot, body, meta line), so an
 * edit to one surface could silently drift the other. This component is the
 * single source of that markup, mirroring the house pattern used for the
 * shared comms message components (client/src/components/comms/).
 *
 * Variants:
 * - `full`    — the /notifications page rows: <li> with the larger icon chip,
 *               deep-link title, action-button column, and the wrapping meta
 *               line ("Archived", "latest of N").
 * - `compact` — the bell dropdown rows: whole-row clickable <div> with the
 *               smaller icon chip, line-clamped body, and single-line meta.
 *
 * Both variants share one tone contract: `unreadTone` drives the row tint and
 * the unread dot (primary for personal items, warn for system alerts), and
 * the icon chip always renders through NOTIFICATION_TONE_CLASSES.
 *
 * Callers own data fetching, mutations, and data-testids (passed via
 * `testIds` so each surface keeps its existing test contract).
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  NOTIFICATION_TONE_CLASSES,
  notificationRelativeTime,
  notificationTypeMeta,
} from "@/lib/notificationTypeMeta";

export type NotificationRowVariant = "full" | "compact";

/** Task #4513 — resolve the client-page href from a notification row's raw
 *  metadata. Returns `/clients/<clientId>` when metadata carries a non-empty
 *  string clientId, else null (segment stays plain text / absent). */
export function notificationClientHref(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "clientId" in metadata) {
    const id = (metadata as Record<string, unknown>).clientId;
    if (typeof id === "string" && id.length > 0) {
      return `/clients/${encodeURIComponent(id)}`;
    }
  }
  return null;
}

/** Unread accent: personal items use primary, system alerts use warn. */
export type NotificationUnreadTone = "primary" | "warn";

const UNREAD_ROW_TINT: Record<NotificationUnreadTone, string> = {
  primary: "bg-primary/5",
  warn: "bg-status-warn/5",
};

const UNREAD_DOT_CLASS: Record<NotificationUnreadTone, string> = {
  primary: "bg-primary",
  warn: "bg-status-warn",
};

export interface NotificationRowTestIds {
  root?: string;
  icon?: string;
  title?: string;
  deepLink?: string;
  dot?: string;
  count?: string;
  body?: string;
  meta?: string;
  client?: string;
}

export interface NotificationRowProps {
  variant: NotificationRowVariant;
  /** Notification category — resolved to icon/tone/label via notificationTypeMeta. */
  category: string;
  title: string;
  body?: string | null;
  /** ISO timestamp rendered as relative time in the meta line. */
  timestamp: string;
  unread: boolean;
  unreadTone: NotificationUnreadTone;
  /** Bundle repeat count; the ×N chip and "latest of N" only render when > 1. */
  count?: number;
  /** Display-ready client name appended to the meta line when present (Task #4472). */
  clientName?: string | null;
  /** Task #4513 — when present, the client name renders as a link to this
   *  href (the client's page). Clicks stop propagation so they never trigger
   *  the compact variant's whole-row deep-link navigation. */
  clientHref?: string | null;
  /** Full variant only: renders the title as a wouter Link. */
  deepLink?: string | null;
  /** Full variant only: click handler for the deep-link title. */
  onDeepLinkClick?: () => void;
  /** Full variant only: appends "· Archived" to the meta line. */
  archived?: boolean;
  /** Full variant only: right-hand action button column. */
  actions?: ReactNode;
  /** Compact variant only: whole-row click handler. */
  onRowClick?: () => void;
  testIds?: NotificationRowTestIds;
}

export function NotificationRow({
  variant,
  category,
  title,
  body,
  timestamp,
  unread,
  unreadTone,
  count,
  clientName,
  clientHref,
  deepLink,
  onDeepLinkClick,
  archived,
  actions,
  onRowClick,
  testIds,
}: NotificationRowProps) {
  const typeMeta = notificationTypeMeta(category);
  const TypeIcon = typeMeta.icon;
  const rowTint = unread ? UNREAD_ROW_TINT[unreadTone] : "";
  const dotClass = UNREAD_DOT_CLASS[unreadTone];
  const titleWeight = unread
    ? "font-semibold text-foreground"
    : "text-muted-foreground";
  const showCount = (count ?? 0) > 1;

  // Task #4513 — client segment links to the client page when the caller
  // resolved an href from metadata.clientId; stopPropagation keeps the
  // inner link from also firing the row's own click navigation.
  const clientSegment = clientName ? (
    clientHref ? (
      <Link
        href={clientHref}
        onClick={(e) => e.stopPropagation()}
        className="hover:underline hover:text-foreground"
        data-testid={testIds?.client}
      >
        {clientName}
      </Link>
    ) : (
      <span data-testid={testIds?.client}>{clientName}</span>
    )
  ) : null;

  if (variant === "compact") {
    const titleContent = (
      <>
        {title}
        {unread && (
          <span
            aria-hidden="true"
            className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-pill ${dotClass} align-middle`}
            data-testid={testIds?.dot}
          />
        )}
      </>
    );
    return (
      <div
        role="button"
        tabIndex={0}
        className={`flex items-start gap-2.5 p-3 border-b last:border-b-0 cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 ${rowTint}`}
        onClick={onRowClick}
        // Keyboard parity for the whole-row click target (Task #4659). Guarded
        // to the row itself so Enter on the inner client <a> keeps navigating
        // without also firing the row action (mirrors the click-side
        // stopPropagation contract asserted in notification-row-client-link).
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRowClick?.();
          }
        }}
        data-testid={testIds?.root}
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center ${NOTIFICATION_TONE_CLASSES[typeMeta.tone]}`}
          data-testid={testIds?.icon}
        >
          <TypeIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          {showCount ? (
            <div className="flex items-start gap-1.5">
              <p className={`min-w-0 flex-1 text-body ${titleWeight}`} data-testid={testIds?.title}>
                {titleContent}
              </p>
              <span
                className="bg-muted px-1 py-0.5 shrink-0 font-mono text-caption text-muted-foreground"
                data-testid={testIds?.count}
              >
                ×{count}
              </span>
            </div>
          ) : (
            <p className={`text-body ${titleWeight}`} data-testid={testIds?.title}>
              {titleContent}
            </p>
          )}
          {body && (
            <p className="mt-0.5 text-caption text-muted-foreground line-clamp-2" data-testid={testIds?.body}>
              {body}
            </p>
          )}
          <p className="mt-0.5 text-caption text-muted-foreground" data-testid={testIds?.meta}>
            {notificationRelativeTime(timestamp)} · {typeMeta.label}
            {clientSegment && <> · {clientSegment}</>}
          </p>
        </div>
      </div>
    );
  }

  // ── Full variant (the /notifications page) ──
  const titleEl = (
    <div
      className={`${showCount ? "min-w-0 flex-1 " : ""}text-body ${titleWeight}`}
      data-testid={testIds?.title}
    >
      {deepLink ? (
        <Link
          href={deepLink}
          onClick={onDeepLinkClick}
          className="hover:underline"
          data-testid={testIds?.deepLink}
        >
          {title}
        </Link>
      ) : (
        title
      )}
      {unread && (
        <span
          aria-hidden="true"
          className={`ml-2 inline-block h-1.5 w-1.5 rounded-pill ${dotClass} align-middle`}
          data-testid={testIds?.dot}
        />
      )}
    </div>
  );

  return (
    <li
      className={`flex items-start gap-3 px-4 py-3 ${rowTint}`}
      data-testid={testIds?.root}
      data-unread={unread ? "true" : "false"}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center ${NOTIFICATION_TONE_CLASSES[typeMeta.tone]}`}
        data-testid={testIds?.icon}
      >
        <TypeIcon className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        {showCount ? (
          <div className="flex items-start gap-2">
            {titleEl}
            <span
              className="mt-0.5 shrink-0 bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
              data-testid={testIds?.count}
            >
              ×{count}
            </span>
          </div>
        ) : (
          titleEl
        )}
        {body && (
          <div className="text-body text-muted-foreground mt-0.5" data-testid={testIds?.body}>
            {body}
          </div>
        )}
        <div
          className="mt-1 flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground"
          data-testid={testIds?.meta}
        >
          <span>{notificationRelativeTime(timestamp)}</span>
          <span aria-hidden="true">·</span>
          <span>{typeMeta.label}</span>
          {clientSegment && (
            <>
              <span aria-hidden="true">·</span>
              {clientSegment}
            </>
          )}
          {archived && (
            <>
              <span aria-hidden="true">·</span>
              <span className="italic">Archived</span>
            </>
          )}
          {showCount && (
            <>
              <span aria-hidden="true">·</span>
              <span>latest of {count}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">{actions}</div>
    </li>
  );
}
