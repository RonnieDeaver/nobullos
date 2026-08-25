/**
 * Server-side renderer for a standalone, self-contained HTML audit report
 * (port of backend/app/report_html.py).
 *
 * Produces a single HTML document (inline CSS + inline SVG, no external
 * requests, no JavaScript) that opens in any browser, prints to PDF cleanly,
 * and can be attached to client comms. Everything is shown expanded — it's a
 * static report. Every user-supplied string is HTML-escaped, so campaign/
 * ad-group names can't break the markup. Shared by the GAds audit and the LSA
 * hygiene report.
 */

import type { AuditReport, CategoryResult, CheckResult } from "./audit/models";

// --- palette (mirrors the web app / NBM brand) ---
const GREEN = "#16a34a";
const YELLOW = "#ca8a04";
const ORANGE = "#ea7317";
const RED = "#b91c1c";
const MUTED = "#b0aca6";
const BRAND = "#524b3a"; // olive
const MAROON = "#8b292f";
const INK = "#3a3a36";
const MUTED_INK = "#8b7355";
const BORDER = "#e5e7eb";

// NBM logo (inline so the exported file stays fully self-contained).
const LOGO_SVG =
  '<svg viewBox="0 0 19.21 5.46" height="26" xmlns="http://www.w3.org/2000/svg"><g> <g id="Group_1"> <path id="Path_1" fill="#524b3a" d="M10.47,2.03c-0.22-0.15-0.48-0.24-0.74-0.26c0.2-0.04,0.39-0.11,0.56-0.23 c0.2-0.13,0.33-0.35,0.33-0.59c0.02-0.27-0.11-0.53-0.34-0.68C10.05,0.12,9.7,0.05,9.23,0.05H7.21L7.19,0.41l0.42,0.14 c0.02,0.11,0.03,0.22,0.03,0.33c0.01,0.2,0.01,0.42,0.01,0.67v0.77c0,0.26,0,0.49-0.01,0.69c0,0.11-0.01,0.22-0.03,0.33L7.19,3.45 l0.02,0.37h1.87c0.55,0,0.98-0.1,1.28-0.29c0.29-0.17,0.46-0.49,0.45-0.83C10.81,2.44,10.68,2.19,10.47,2.03 M8.72,1.2 c0-0.19,0-0.35,0-0.49c0-0.14,0.01-0.22,0.01-0.27h0.12c0.22,0,0.37,0.06,0.47,0.17c0.1,0.12,0.15,0.28,0.14,0.44 c0.01,0.16-0.04,0.33-0.14,0.46C9.2,1.63,9.03,1.69,8.87,1.67c-0.03,0-0.06,0-0.1,0l-0.05,0L8.72,1.2z M9.5,3.24 C9.39,3.35,9.23,3.4,9.08,3.4c-0.06,0-0.13-0.01-0.19-0.02c-0.05-0.01-0.1-0.02-0.15-0.04c0-0.06-0.01-0.14-0.01-0.25 c0-0.11-0.01-0.25-0.01-0.41V2.14c0.02,0,0.04,0,0.06,0c0.05,0,0.09,0,0.12,0c0.27,0,0.46,0.05,0.58,0.16s0.17,0.28,0.17,0.51 C9.66,2.97,9.6,3.12,9.5,3.24"></path> <path id="Path_2" fill="#8b292f" d="M4.18,0.05H2.73L2.71,0.41l0.45,0.12c0.02,0.07,0.03,0.15,0.03,0.22C3.2,0.88,3.2,1.04,3.2,1.21 c0,0.18,0,0.36,0,0.53V2.1L1.16,0.05H0.07L0.05,0.41l0.41,0.12c0,0.03,0.01,0.1,0.02,0.2c0.01,0.1,0.01,0.2,0.02,0.31 C0.5,1.15,0.5,1.23,0.5,1.28v0.68c0,0.19,0,0.38-0.01,0.58c0,0.19-0.01,0.36-0.02,0.5c0,0.08-0.01,0.17-0.02,0.25L0.05,3.41 l0.02,0.36h1.48l0.02-0.36L1.11,3.29C1.09,3.22,1.08,3.13,1.08,3.05C1.07,2.92,1.07,2.76,1.06,2.57c0-0.19,0-0.39,0-0.61V1.47 l2.22,2.35h0.45c0-0.15,0-0.3,0-0.46c0-0.16,0-0.35,0-0.59V1.75c0-0.18,0-0.36,0-0.54c0-0.18,0.01-0.33,0.02-0.45 c0-0.07,0.01-0.15,0.03-0.22l0.41-0.12L4.18,0.05z"></path> <path id="Path_3" fill="#524b3a" d="M9.06,5.04L9.06,5.04L8.8,4.61H8.63v0.78H8.8V4.94h0.01L9.02,5.3h0.05l0.22-0.36H9.3v0.45h0.17 V4.61H9.31L9.06,5.04z"></path> <path id="Path_4" fill="#524b3a" d="M10.25,4.61L9.89,5.39h0.18l0.07-0.16h0.36l0.07,0.16h0.19L10.4,4.61H10.25z M10.2,5.09 l0.12-0.28h0.01l0.12,0.28H10.2z"></path> <path id="Path_5" fill="#524b3a" d="M11.92,4.86c0-0.06-0.02-0.12-0.06-0.16c-0.06-0.06-0.15-0.09-0.23-0.08h-0.43v0.78h0.17V5.11 h0.23l0.16,0.29h0.2l-0.18-0.31C11.85,5.05,11.91,4.96,11.92,4.86 M11.64,4.96h-0.28v-0.2h0.27c0.03,0,0.07,0.01,0.09,0.03 c0.02,0.02,0.03,0.04,0.03,0.07C11.74,4.92,11.7,4.96,11.64,4.96C11.64,4.96,11.64,4.96,11.64,4.96"></path> <path id="Path_6" fill="#524b3a" d="M13.15,4.61h-0.21l-0.36,0.34V4.61H12.4v0.78h0.17V5.15l0.13-0.12l0.29,0.36h0.22l-0.38-0.47 L13.15,4.61z"></path> <path id="Path_7" fill="#524b3a" d="M13.78,5.06h0.29V4.91h-0.29V4.76h0.48V4.61h-0.65v0.78h0.68V5.25h-0.51V5.06z"></path> <path id="Path_8" fill="#524b3a" d="M14.65,4.76h0.28v0.63h0.17V4.76h0.28V4.61h-0.74V4.76z"></path> <rect id="Rectangle_5" x="15.83" y="4.61" fill="#524b3a" width="0.17" height="0.78"></rect> <path id="Path_9" fill="#524b3a" d="M17.08,5.1L17.08,5.1l-0.4-0.48h-0.15v0.78h0.17V4.91h0l0.4,0.48h0.15V4.61h-0.17L17.08,5.1z"></path> <path id="Path_10" fill="#524b3a" d="M18.12,5.09h0.24v0.13c-0.06,0.04-0.13,0.05-0.2,0.05c-0.15,0-0.26-0.12-0.26-0.27 c0-0.14,0.11-0.26,0.25-0.26c0.09,0,0.18,0.04,0.26,0.1l0.11-0.11c-0.1-0.09-0.23-0.14-0.37-0.14c-0.23-0.01-0.42,0.17-0.43,0.4 c-0.01,0.23,0.17,0.42,0.4,0.43c0.01,0,0.02,0,0.04,0c0.13,0,0.26-0.05,0.36-0.12V4.94h-0.4L18.12,5.09z"></path> <path id="Path_11" fill="#524b3a" d="M15.45,0.79c0.01,0.09,0.04,1.54,0.04,1.54c0,0.08,0,0.19-0.01,0.33c0,0.14-0.01,0.28-0.02,0.41 c-0.01,0.13-0.01,0.23-0.02,0.3l-0.42,0.1l0.02,0.35h1.92l0.02-0.35l-0.42-0.1c-0.01-0.13-0.02-0.25-0.02-0.38 c0-0.2-0.01-0.47-0.01-0.8c0-0.5,0.01-1.34,0.02-1.51s0.01-0.34,0.03-0.51l-0.21-0.13L14.96,0.4l0.01,0.33L15.45,0.79z"></path> <path id="Path_12" fill="#524b3a" d="M18.75,3.38c-0.01-0.13-0.02-0.25-0.02-0.38c0-0.2-0.01-0.47-0.01-0.8 c0-0.5,0.01-1.34,0.02-1.51c0-0.17,0.01-0.34,0.03-0.51l-0.21-0.13L17.13,0.4l0.01,0.33l0.48,0.06c0.01,0.09,0.04,1.54,0.04,1.54 c0,0.08,0,0.19-0.01,0.33c0,0.14-0.01,0.28-0.02,0.41c-0.01,0.13-0.01,0.23-0.02,0.3l-0.42,0.1l0.02,0.35h1.92l0.02-0.35 L18.75,3.38z"></path> <path id="Path_13" fill="#8b292f" d="M7,1.58C6.87,1.37,6.69,1.2,6.47,1.08C6.23,0.95,5.96,0.89,5.69,0.9 c-0.27,0-0.53,0.06-0.77,0.17c-0.24,0.11-0.45,0.29-0.6,0.51C4.16,1.82,4.08,2.11,4.09,2.41c0,0.26,0.07,0.51,0.2,0.74 c0.14,0.22,0.33,0.39,0.56,0.5C5.1,3.77,5.38,3.83,5.66,3.83c0.27,0,0.54-0.07,0.77-0.2C6.66,3.5,6.85,3.31,6.98,3.09 c0.14-0.23,0.21-0.5,0.21-0.76C7.19,2.06,7.13,1.81,7,1.58 M6.05,3.01C6.04,3.1,6,3.19,5.94,3.27C5.88,3.32,5.81,3.35,5.73,3.35 C5.62,3.35,5.52,3.29,5.46,3.19C5.37,3.06,5.3,2.92,5.27,2.76c-0.05-0.2-0.07-0.4-0.07-0.6C5.19,1.96,5.22,1.75,5.3,1.56 c0.07-0.15,0.16-0.22,0.28-0.22c0.16,0,0.28,0.11,0.38,0.34c0.1,0.29,0.15,0.59,0.14,0.89C6.09,2.72,6.08,2.86,6.05,3.01"></path> <path id="Path_14" fill="#524b3a" d="M13.73,3.53c0.02-0.13-0.01-0.25,0.06-0.37l0,0c0.05-0.07,0.11-0.14,0.17-0.2 c0.09-0.1,0.16-0.21,0.2-0.34c0.04-0.14,0.04-0.28,0.08-0.42c0.01-0.03,0.02-0.05,0.02-0.08c0.16,0.11,0.36,0.15,0.55,0.09 l-0.34-0.36c0,0,0,0,0,0c0.04-0.02,0.08-0.04,0.12-0.06c0.03-0.02,0.07-0.05,0.1-0.08c0.03-0.03,0.05-0.06,0.07-0.1 c0.04-0.07,0.06-0.15,0.07-0.22c0.01-0.07,0.01-0.14-0.01-0.21c-0.01-0.05-0.02-0.11-0.04-0.16c-0.01-0.02-0.02-0.05-0.03-0.07 c0-0.01-0.01-0.01-0.01-0.02c-0.01-0.01-0.01-0.01-0.02-0.01c-0.01,0-0.01-0.01-0.02-0.01c-0.01,0-0.02,0-0.02,0 c-0.02,0-0.03,0.01-0.04,0.02c-0.01,0-0.01,0.01-0.01,0.02c0,0.01-0.01,0.01-0.01,0.02c0,0-0.01,0.03-0.02,0.07 c-0.02,0.05-0.04,0.1-0.06,0.15c-0.03,0.06-0.07,0.11-0.11,0.16c-0.04,0.05-0.1,0.08-0.16,0.1c-0.03,0.01-0.07,0.02-0.11,0.02 s-0.08,0.01-0.13,0.02c-0.05,0-0.09,0.01-0.14,0.01c-0.05,0-0.1,0.01-0.15,0.01c-0.25,0.01-0.46,0.22-0.45,0.47l0,0.15 c0,0.26-0.1,0.51-0.28,0.7c-0.07,0.08-0.19,0.08-0.27,0.01c0,0,0,0-0.01-0.01c-0.18-0.19-0.28-0.44-0.28-0.7l0-0.15 c0-0.06-0.01-0.12-0.03-0.18c-0.02-0.06-0.06-0.11-0.1-0.15c-0.08-0.09-0.2-0.14-0.32-0.14c-0.05,0-0.1,0-0.15-0.01 c-0.05,0-0.09-0.01-0.14-0.01c-0.05,0-0.09-0.01-0.13-0.02s-0.08-0.01-0.11-0.02c-0.06-0.02-0.12-0.05-0.16-0.1 c-0.04-0.05-0.08-0.1-0.11-0.16c-0.02-0.05-0.05-0.1-0.06-0.15c-0.01-0.04-0.02-0.07-0.02-0.07c0-0.01,0-0.01-0.01-0.02 c0-0.01-0.01-0.01-0.01-0.02c-0.01,0-0.01-0.01-0.02-0.01c-0.01,0-0.01,0-0.02-0.01c-0.01,0-0.02,0-0.02,0 c-0.01,0-0.01,0-0.02,0.01c-0.01,0.01-0.02,0.02-0.03,0.03c0,0-0.01,0.03-0.03,0.07c-0.02,0.05-0.03,0.11-0.04,0.16 c-0.01,0.07-0.01,0.14-0.01,0.21c0.01,0.08,0.03,0.16,0.07,0.22c0.02,0.04,0.04,0.07,0.07,0.1c0.03,0.03,0.06,0.06,0.1,0.08 c0.04,0.02,0.08,0.05,0.12,0.06c0,0,0,0,0,0l-0.34,0.36c0.07,0.02,0.14,0.03,0.21,0.02l0.12-0.18l0.04,0.14 c0.06-0.02,0.12-0.05,0.17-0.08c0.01,0.03,0.02,0.05,0.02,0.08c0.07,0.24,0.05,0.49,0.22,0.7c0.05,0.06,0.12,0.11,0.17,0.17h0 c0.11,0.13,0.09,0.3,0.12,0.46c0.04,0.2,0.22,0.26,0.42,0.28c0.12,0.25,0.43,0.35,0.67,0.22c0.06-0.03,0.12-0.08,0.17-0.14 c0.02-0.03,0.04-0.06,0.05-0.09C13.52,3.79,13.7,3.73,13.73,3.53 M13.21,3.79c-0.01,0.01-0.02,0.02-0.03,0.03 C13,3.99,12.72,3.98,12.55,3.8c0,0-0.01-0.01-0.01-0.02c-0.08-0.09-0.11-0.22-0.08-0.33c0.05,0.23,0.27,0.38,0.5,0.33 c0.06-0.01,0.12-0.04,0.18-0.08c0.08-0.07,0.14-0.16,0.16-0.26C13.32,3.57,13.29,3.69,13.21,3.79"></path> </g> </g></svg>';

export const STATUS: Record<string, [string, string]> = {
  good: [GREEN, "Good"],
  okay: [YELLOW, "Okay"],
  bad: [ORANGE, "Bad"],
  critical: [RED, "Critical"],
  na: [MUTED, "N/A"],
};

/** html.escape equivalent (quote=True): &, <, >, ", '. */
function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function scoreColor(score: number): string {
  if (score >= 75) return GREEN;
  if (score >= 60) return YELLOW;
  if (score >= 40) return ORANGE;
  return RED;
}

function fmtId(cid: string): string {
  return cid.length === 10 ? `${cid.slice(0, 3)}-${cid.slice(3, 6)}-${cid.slice(6)}` : cid;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO timestamp -> "Jul 27, 2026 14:02 UTC" (strftime "%b %d, %Y %H:%M UTC"). */
function fmtGenerated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** Semicircular gauge as inline SVG (no JS). */
function gaugeSvg(score: number): string {
  const r = 120;
  const cx = 150;
  const cy = 150;
  const circ = Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = circ * pct;
  const color = scoreColor(score);
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return `
    <svg viewBox="0 0 300 175" width="280" height="164" xmlns="http://www.w3.org/2000/svg">
      <path d="${arc}" fill="none" stroke="#eef0f2" stroke-width="22" stroke-linecap="round"/>
      <path d="${arc}" fill="none" stroke="${color}" stroke-width="22" stroke-linecap="round"
            stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"/>
      <text x="${cx}" y="${cy - 16}" text-anchor="middle" font-size="50" font-weight="800"
            fill="${color}">${Math.round(score)}</text>
    </svg>`;
}

function checkHtml(chk: CheckResult): string {
  const [color, label] = STATUS[chk.status] ?? [MUTED, chk.status];
  const scoreTxt = chk.score === null ? "N/A" : String(Math.round(chk.score));
  let rows = "";
  if (chk.evidence.length) {
    const items = chk.evidence
      .map(
        (e) =>
          `<li><span class='evn'>${esc(e.name)}</span>` +
          `${e.detail ? `<span class=evd>${esc(e.detail)}</span>` : ""}` +
          `${e.id ? `<span class=evi>#${esc(e.id)}</span>` : ""}</li>`,
      )
      .join("");
    rows = `<ul class='ev'>${items}</ul>`;
  }
  const rec = chk.recommendation
    ? `<div class='rec'><b>Fix:</b> ${esc(chk.recommendation)}</div>`
    : "";
  return `
    <div class="chk" style="border-left-color:${color}">
      <div class="chk-head">
        <span class="chk-id">${esc(chk.id)}</span>
        <span class="chk-name">${esc(chk.name)}</span>
        <span class="chk-val">${esc(chk.value)}</span>
        <span class="chk-impact impact-${chk.impact}">${esc(chk.impact)}</span>
        <span class="chk-score" style="color:${color}">${scoreTxt}</span>
        <span class="chk-status" style="color:${color}">${label}</span>
      </div>
      ${rec}${rows}
    </div>`;
}

function categoryHtml(cat: CategoryResult): string {
  const color = scoreColor(cat.score);
  const scored = cat.checks.filter((c) => c.score !== null);
  const na = cat.checks.length - scored.length;
  const sumW = scored.reduce((s, c) => s + c.weight, 0);
  const sumWs = scored.reduce((s, c) => s + c.weight * (c.score ?? 0), 0);
  const recomputed = sumW ? sumWs / sumW : 0.0;
  const checks = cat.checks.map(checkHtml).join("");
  return `
    <section class="cat">
      <div class="cat-head">
        <span class="cat-code">${esc(cat.code)}</span>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-w">${Math.round(cat.weight * 100)}% of total</span>
        <span class="cat-score" style="color:${color}">${Math.round(cat.score)}</span>
      </div>
      <div class="cat-track"><div class="cat-fill" style="width:${cat.score}%;background:${color}"></div></div>
      <div class="cat-meta">${scored.length} scored${na ? ` · ${na} N/A (excluded)` : ""} · weighted avg = <b>${recomputed.toFixed(1)}</b></div>
      ${checks}
    </section>`;
}

function nextStepsHtml(report: AuditReport): string {
  const ns = report.next_steps;
  if (!ns.critical.length && !ns.easy_wins.length && !ns.long_term.length) {
    return "<div class='ai-clear'>&#10003; Nothing flagged — this account is in good shape.</div>";
  }

  const tiers: Array<[string, string, string, string, typeof ns.critical]> = [
    ["Fix ASAP", "Serving-impacting — do these first", "#fdecea", "&#9940;", ns.critical],
    ["Easy wins", "Low effort, high return", "#eaf7f0", "&#9889;", ns.easy_wins],
    ["Schedule for this week", "Plan into this week's work", "#f5f3ee", "&#128200;", ns.long_term],
  ];
  let out = "";
  for (const [label, blurb, bg, badge, items] of tiers) {
    if (!items.length) continue;
    let rows = "";
    for (const s of items) {
      let pts = "";
      if (s.points && s.points.length) {
        pts = "<ul class='step-points'>" + s.points.map((p) => `<li>${esc(p)}</li>`).join("") + "</ul>";
      }
      const src = s.source ? `<span class='ai-src'>${esc(s.source)}</span>` : "";
      const detail = s.detail ? `<div class='ai-detail'>${esc(s.detail)}</div>` : "";
      rows += `<li class='step'><div class='step-title'>${esc(s.title)} ${src}</div>${detail}${pts}</li>`;
    }
    out += `
        <div class="tier">
          <div class="tier-head" style="background:${bg}"><span class="badge">${badge}</span>
            <b>${label}</b> <span class="muted">${blurb}</span>
            <span class="tier-count">${items.length}</span></div>
          <ul class="step-list">${rows}</ul>
        </div>`;
  }
  return out;
}

function gateBannerHtml(report: AuditReport): string {
  const gates = report.gates_triggered;
  if (!gates.length) return "";
  const cap = gates[0].cap; // all issues share the effective (dynamic) cap
  const binding = report.final_score < report.raw_score;
  const n = gates.length;
  const plural = n === 1 ? "issue" : "issues";
  const lis = gates.map((g) => `<li>${esc(g.reason)} (${esc(g.source)})</li>`).join("");
  if (binding) {
    const head =
      `Computed score ${Math.round(report.raw_score)} — capped at ` +
      `${Math.round(report.final_score)} · ${n} critical ${plural}`;
    return `<div class='banner red'><b>${head}</b><ul>${lis}</ul></div>`;
  }
  const head = `&#9888; ${n} critical ${plural} (would cap at ${Math.round(cap)})`;
  return `<div class='banner amber'><b>${head}</b><ul>${lis}</ul></div>`;
}

/** "hygiene-<safe-name>-<date>.html" file-name-safe account name. */
export function safeFileName(accountName: string, cid: string): string {
  const safe = Array.from(accountName)
    .filter((c) => /[\p{L}\p{N} \-_]/u.test(c))
    .join("")
    .trim();
  return safe || cid;
}

export function renderReportHtml(report: AuditReport): string {
  const bandColor = scoreColor(report.final_score);
  const generated = fmtGenerated(report.generated_at);
  const categories = report.categories.map(categoryHtml).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Hygiene Audit — ${esc(report.account_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: ${INK}; margin: 0; background: #fff; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 24px 48px; }
  .top { display: flex; align-items: center; gap: 14px; border-bottom: 1px solid ${BORDER}; padding-bottom: 14px; }
  .top .divider { width: 1px; height: 30px; background: ${BORDER}; }
  h1 { font-size: 22px; margin: 2px 0; color: ${BRAND}; }
  .muted { color: ${MUTED_INK}; font-size: 13px; }
  .hero { text-align: center; padding: 14px 0 4px; }
  .band { font-size: 17px; font-weight: 700; color: ${bandColor}; margin-top: -8px; }
  .banner { border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 13px; }
  .banner.red { background: #fef2f2; color: #8a1f1f; border: 1px solid #f4c9c9; }
  .banner.amber { background: #fdf6e7; color: #7a5a12; border: 1px solid #ecdca8; }
  .banner ul { margin: 6px 0 0; padding-left: 18px; }
  h2 { font-size: 15px; margin: 24px 0 10px; color: ${BRAND}; }
  .ai-src { font-size: 10px; font-weight: 700; color: #8b7355; background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 5px; margin-left: 6px; }
  .ai-detail { font-size: 13px; color: #8b7355; margin-top: 2px; }
  .ai-clear { color: ${GREEN}; font-weight: 600; }
  .tier { border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 12px; overflow: hidden; break-inside: avoid; }
  .tier-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  .tier-count { margin-left: auto; font-weight: 800; font-size: 12px; color: #8b7355; background: rgba(0,0,0,.05); border-radius: 99px; padding: 1px 9px; }
  .step-list { list-style: none; margin: 0; padding: 8px 12px; display: flex; flex-direction: column; gap: 9px; }
  .step-title { font-weight: 700; font-size: 14px; }
  .step-points { margin: 5px 0 0; padding-left: 18px; }
  .step-points li { font-size: 13px; margin-bottom: 3px; }
  .cat { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; break-inside: avoid; }
  .cat-head { display: flex; align-items: center; gap: 8px; }
  .cat-code { font-weight: 700; font-size: 11px; color: #8b7355; background: #f0eee9; padding: 2px 6px; border-radius: 5px; }
  .cat-name { flex: 1; font-weight: 700; }
  .cat-w { font-size: 11px; color: #b0aca6; }
  .cat-score { font-weight: 800; font-size: 18px; }
  .cat-track { height: 8px; background: #eef0f2; border-radius: 99px; overflow: hidden; margin: 8px 0; }
  .cat-fill { height: 100%; border-radius: 99px; }
  .cat-meta { font-size: 12px; color: #8b7355; margin-bottom: 8px; }
  .chk { border: 1px solid #e5e7eb; border-left: 4px solid #b0aca6; border-radius: 8px; padding: 9px 12px; margin: 6px 0; break-inside: avoid; }
  .chk-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chk-id { font-size: 11px; font-weight: 700; color: #8b7355; min-width: 50px; }
  .chk-name { font-weight: 600; font-size: 13px; min-width: 150px; }
  .chk-val { flex: 1; color: #8b7355; font-size: 13px; }
  .chk-impact { font-size: 10px; font-weight: 700; text-transform: capitalize; padding: 2px 7px; border-radius: 999px; }
  .impact-critical { background: #fceeef; color: ${MAROON}; }
  .impact-high { background: #fcefe2; color: #b4631a; }
  .impact-medium { background: #f5f3ee; color: ${MUTED_INK}; }
  .impact-low { background: #f0eee9; color: ${MUTED}; }
  .chk-score { font-weight: 800; min-width: 30px; text-align: right; }
  .chk-status { font-size: 11px; font-weight: 700; min-width: 52px; text-align: right; }
  .rec { font-size: 13px; margin: 7px 0 4px; }
  .ev { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .ev li { display: flex; gap: 10px; align-items: baseline; background: #f9fafb; padding: 5px 9px; border-radius: 6px; font-size: 12px; }
  .evn { font-weight: 600; }
  .evd { color: #8b7355; flex: 1; }
  .evi { color: #b0aca6; font-size: 11px; }
  footer { margin-top: 28px; font-size: 11px; color: #b0aca6; text-align: center; }
  @media print { .cat, .chk, .ai-row { break-inside: avoid; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body><div class="wrap">
  <div class="top">
    ${LOGO_SVG}
    <div class="divider"></div>
    <div>
      <h1>${esc(report.account_name)}</h1>
      <div class="muted">Ads Hygiene Audit · ${fmtId(report.customer_id)} · last ${report.lookback_days} days · generated ${generated}</div>
    </div>
  </div>

  ${
    report.band === "Inactive"
      ? `<div class="hero"><div class="band" style="color:${MUTED_INK};margin-top:8px">Inactive</div><div class="muted">${esc(report.scope_note ?? "No active labeled campaigns in scope.")}</div></div>`
      : `<div class="hero">${gaugeSvg(report.final_score)}<div class="band">${esc(report.band)}</div></div>
  ${gateBannerHtml(report)}`
  }

  <h2>Next steps</h2>
  ${nextStepsHtml(report)}

  <h2>Category breakdown <span class="muted">(worst first)</span></h2>
  ${categories}

  <footer>Read-only Google Ads hygiene audit · NoBull Marketing · ${generated}</footer>
</div></body></html>`;
}
