// Ads Status chip with the morning verification mark — built for the AM Dashboard and
// placed here so the client profile's account list can share it later (follow-up).
//
// The chip's WORD is ClickUp's claim (the Ads Status dropdown); the MARK is whether the
// account's real state agreed when the morning check last ran (statusCheck.ts):
//   ✓  no campaign of THIS PRODUCT can serve — the claim holds
//   ✗  campaigns are still enabled although ClickUp says Paused/Off — either the Ads
//      Status is stale or the account is spending when it shouldn't be
// No mark = never checked, or the check couldn't reach the account — never a stale or
// guessed verdict. On (and blank = On) accounts show no chip; running is the norm.
//
// Wording is PRODUCT-scoped on purpose: one CID can host both a Search and an LSA
// campaign (Paxton Law), and the check only looks at its own product's campaigns —
// claiming "nothing is enabled in the account" would be false on such accounts.

import { useEffect, useRef, useState } from "react";
import type { AdsStatus, StatusCheck } from "../lib/types";

function day(iso: string | undefined): string {
  if (!iso) return "";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return ` — checked ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

// Plain-English explanation shown in the dropdown body (and kept as the title
// attribute for accessibility / existing tests). Mirrors the original tooltip text
// so the morning AM-chip render tests continue to pass without change.
function explain(
  status: "paused" | "off",
  check: StatusCheck | null | undefined,
  side: string,
): string {
  const base =
    status === "paused"
      ? "Paused in ClickUp (Ads Status)"
      : "Switched off in ClickUp (long-term pause) — not monitored; its spend still counts while it has any";

  if (check?.matches === true) {
    return `${base}. ✓ Verified: no ${side} campaigns can serve in this account${day(check.checked_at)}.`;
  }
  if (check?.matches === false) {
    const n = check.enabled_campaigns ?? 0;
    // Name the offenders: one still-serving flight between five ended ones reads as a
    // false alarm until the tooltip says WHICH campaign trips the ✗ (O'Brien Law was
    // the live case — "Commercial August 2026" hiding in a wall of "Ended" rows).
    const names = check.enabled_campaign_names ?? [];
    const shown = names.slice(0, 3).map((x) => `\u201c${x}\u201d`).join(", ");
    const who = shown ? `: ${shown}${n > 3 ? ` +${n - 3} more` : ""}` : "";
    return (
      `${base}. ✗ MISMATCH: ${n} ${side} campaign${n === 1 ? "" : "s"} can still serve${who}` +
      ` — either the Ads Status is set incorrectly or the account is running when it should be paused` +
      `${day(check.checked_at)}.`
    );
  }
  if (check?.error) {
    return `${base}. The morning check couldn't reach this account (its CID may be wrong in ClickUp or not under the MCC)${day(check.checked_at)} — no mark rather than a guess.`;
  }
  return `${base}. Not verified yet — checked each morning (~6am ET), or on demand from the AM Dashboard's Refresh.`;
}

export function AdsStatusChip({
  status,
  check,
  product,
  accountName,
  interactive = true,
}: {
  status: AdsStatus;
  check?: StatusCheck | null;
  product: "gads" | "lsa";
  accountName?: string;
  /**
   * When false the chip renders as a plain <span> with a title tooltip —
   * use this whenever the chip sits inside another interactive element (e.g.
   * the AM Dashboard's <a> account launch card) to avoid nesting a <button>
   * inside an anchor. Defaults to true.
   */
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status !== "paused" && status !== "off") return null;

  const word = status === "paused" ? "Paused" : "Off";
  const side = product === "gads" ? "Google Ads" : "LSA";
  const isVerified = check?.matches === true;
  const isMismatch = check?.matches === false;
  const mark =
    isVerified ? " ✓" : isMismatch ? " ✗" : "";
  const verdictClass = isVerified ? " verified" : isMismatch ? " mismatch" : "";
  const titleText = explain(status, check, side);

  // Non-interactive mode: plain <span> with title tooltip. Used by the AM
  // Dashboard where the chip sits inside an <a> launch card — nesting a
  // <button> inside an <a> is invalid HTML.
  if (!interactive) {
    return (
      <span
        className={`cp-status ${status}${verdictClass}`}
        title={titleText}
      >
        {word}{mark}
      </span>
    );
  }

  return (
    <span className="cp-status-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`cp-status ${status}${verdictClass}`}
        title={titleText}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {word}{mark}
      </button>
      {open && (
        <div className="cp-status-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="cp-status-menu-row">
            <span className={`cmb-tag ${product === "gads" ? "g" : "l"}`}>
              {product === "gads" ? "GAds" : "LSA"}
            </span>
            {accountName && <span className="cp-status-menu-acct">{accountName}</span>}
          </div>
          <p className="cp-status-menu-desc">{titleText}</p>
        </div>
      )}
    </span>
  );
}
