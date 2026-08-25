import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientAlertItem } from "../lib/types";
import {
  clientAlertCounts,
  clientNeedsAttention,
  sortedClientAlertItems,
  type ClientAlertSummaryLike,
} from "../lib/alerts";

type Variant = "profile" | "card" | "row";

function severityLabel(severity: string | null): string {
  if (severity === "critical") return "Critical";
  if (severity === "high") return "High";
  if (severity === "medium") return "Medium";
  return "Alert";
}

/** Only render links that cannot execute script in the current page. */
export function safeAlertDeepLink(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ClientAlertItems({
  summary,
  label,
}: {
  summary: ClientAlertSummaryLike;
  label: string;
}) {
  const items = sortedClientAlertItems(summary);
  if (items.length === 0) {
    return (
      <div className="cp-alerts-empty muted" role="status">
        Alert details are unavailable.
      </div>
    );
  }
  return (
    <div className="cp-alerts-menu-list" role="list" aria-label={label}>
      {items.map((item, index) => (
        <ClientAlertItemView item={item} key={`${item.product}:${item.customer_id}:${item.title}:${index}`} />
      ))}
      {(summary?.items_truncated ?? 0) > 0 && (
        <div className="cp-alerts-more muted">
          +{summary?.items_truncated} more alert{summary?.items_truncated === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function ClientAlertItemView({ item }: { item: ClientAlertItem }) {
  const href = safeAlertDeepLink(item.deep_link);
  const severity = severityLabel(item.severity);
  return (
    <div className="cp-alert-item" role="listitem">
      <span className={`dot ${item.severity ?? "unknown"}`} aria-hidden="true" />
      <div className="body">
        <span className={`severity ${item.severity ?? "unknown"}`}>{severity}</span>
        <b className="t">{item.title}</b>
        <span className="who">
          <span className={`cmb-tag ${item.product === "gads" ? "g" : "l"}`}>
            {item.product === "gads" ? "Google Ads" : "LSA"}
          </span>
          <span>{item.account}</span>
        </span>
        {item.detail && <span className="d">{item.detail}</span>}
        {href && (
          <a className="dl" href={href} target="_blank" rel="noopener noreferrer">
            Open account ↗
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * One disclosure pattern for Main, profile and AM client-level alerts.
 * Variants change only the compact trigger treatment; behavior and details stay
 * identical, including outside-click/Escape dismissal and safe links.
 */
export function ClientAlertMenu({
  summary,
  client,
  variant,
  testId,
}: {
  summary: ClientAlertSummaryLike;
  client: string;
  variant: Variant;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const counts = clientAlertCounts(summary);
  const attention = clientNeedsAttention(summary);
  const hasKnownState =
    !!summary &&
    (
      typeof summary.critical === "number" ||
      typeof summary.high === "number" ||
      typeof summary.medium === "number" ||
      typeof summary.total === "number" ||
      typeof summary.needs_attention === "boolean" ||
      Array.isArray(summary.items)
    );

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        wrapRef.current &&
        !wrapRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, variant]);

  useEffect(() => {
    if (!open || variant !== "row" || !portalRoot) return;
    function placeMenu() {
      const trigger = wrapRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!trigger || !menu) return;
      const gap = 8;
      const edge = 12;
      const roomBelow = window.innerHeight - trigger.bottom - edge;
      const openAbove = roomBelow < menu.height && trigger.top > roomBelow;
      setMenuPosition({
        left: Math.max(edge, Math.min(trigger.left, window.innerWidth - menu.width - edge)),
        top: openAbove
          ? Math.max(edge, trigger.top - menu.height - gap)
          : Math.min(window.innerHeight - menu.height - edge, trigger.bottom + gap),
      });
    }
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open, portalRoot, variant]);

  if (counts.total === 0) {
    if (!hasKnownState) {
      return variant === "profile"
        ? <span className="cp-okchip unknown">Alert status unavailable</span>
        : null;
    }
    if (attention) {
      const unavailableLabel = `Needs attention for ${client} — alert details unavailable`;
      const unavailableClass =
        variant === "card"
          ? "amd-alert attn unavailable"
          : variant === "row"
            ? "cmb-client-alert attn unavailable"
            : "cp-okchip bad";
      return (
        <span
          className={unavailableClass}
          role="status"
          aria-label={unavailableLabel}
          title={unavailableLabel}
          data-testid={testId}
        >
          {variant === "profile" ? "Needs attention · details unavailable" : "⚠ details"}
        </span>
      );
    }
    return variant === "profile" ? <span className="cp-okchip">No active alerts</span> : null;
  }

  const visibleCount = attention
    ? counts.attention || counts.total
    : counts.medium || counts.total;
  const label = attention
    ? `${visibleCount} alert${visibleCount === 1 ? "" : "s"} need${visibleCount === 1 ? "s" : ""} attention`
    : `${visibleCount} minor alert${visibleCount === 1 ? "" : "s"}`;
  const wrapClass =
    variant === "card"
      ? "cp-alerts-wrap amd-alerts-wrap"
      : variant === "row"
        ? "cp-alerts-wrap cmb-client-alerts-wrap"
        : "cp-alerts-wrap";
  const buttonClass =
    variant === "card"
      ? `amd-alert ${attention ? "attn" : "minor"}`
      : variant === "row"
        ? `cmb-client-alert ${attention ? "attn" : "minor"}`
        : `cp-okchip cp-okchip-btn ${attention ? "bad" : "warn"}`;
  const menu = open ? (
    <div
      ref={menuRef}
      id={menuId}
      className={`cp-alerts-menu${variant === "card" ? " amd-alerts-menu" : ""}${variant === "row" ? " cmb-client-alerts-menu is-fixed" : ""}`}
      style={
        variant === "row"
          ? menuPosition
            ? { left: menuPosition.left, top: menuPosition.top }
            : { left: 0, top: 0, visibility: "hidden" }
          : undefined
      }
    >
      <ClientAlertItems summary={summary} label={`Alerts for ${client}`} />
    </div>
  ) : null;

  return (
    <span
      className={wrapClass}
      ref={wrapRef}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        onClick={() => {
          if (!open && variant === "row") {
            setMenuPosition(null);
            setPortalRoot(wrapRef.current?.closest(".ads-os") ?? document.body);
          }
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={menuId}
        aria-label={`${label} for ${client}`}
        title={label}
        data-testid={testId}
      >
        {variant === "profile" ? (
          <>
            {label} <span className="cp-chip-caret" aria-hidden="true">{open ? "▴" : "▾"}</span>
          </>
        ) : (
          <>
            <span aria-hidden="true">⚠</span> {visibleCount}
          </>
        )}
      </button>
      {variant === "row" && portalRoot && menu ? createPortal(menu, portalRoot) : menu}
    </span>
  );
}