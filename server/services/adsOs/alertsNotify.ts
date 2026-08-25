/**
 * Ads OS — Slack delivery for the morning alert digest.
 * Port of backend/app/alerts/notify.py.
 *
 * Only-on-change: each account's notified fingerprint snapshot advances ONLY
 * once delivery succeeds, so an unset webhook or a Slack outage leaves fresh
 * alerts pending for the next run instead of silently swallowing them. An
 * account whose alerts cleared (empty list) always has its snapshot wiped
 * (silent self-heal); an account whose run failed (alerts null) is left
 * untouched. One consolidated message, paginated if huge; nothing new -> skip
 * (a clean book sends nothing). A Slack failure never breaks anything else —
 * badges and stores are already written by the time we get here.
 */

import type { AlertRunResult } from "./alertsEngine";
import { isSlackConfigured } from "./config";
import { postSlackMessage } from "./slackWebhook";
import { getNotified, putNotified } from "./store";
import { Alert, Product } from "./types";

const SEV_EMOJI: Record<string, string> = { critical: "🚨", high: "⚠️", medium: "🔸" };
const SLACK_NOTABLE = new Set(["critical", "high"]);
const MAX_BLOCKS = 48; // Slack's hard limit is 50; stay under (header + footer reserved)

/** Stable fingerprint for dedupe: code + campaign (account-level -> code only). */
function fp(a: Alert): string {
  return `${a.code}:${a.campaign_id || ""}`;
}

function esc(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface ProcessedAccount {
  cid: string;
  name: string;
  product: Product;
  curFps: Set<string>;
  fresh: Alert[];
}

type Section = readonly [string, Product, Alert[]];

/**
 * results: [cid, name, product, alerts|null] entries from runAlerts.
 *
 * Surface each account's critical/high alerts NOT already notified ("fresh").
 */
export async function sendAlertDigest(results: AlertRunResult[]): Promise<Record<string, any>> {
  // Pass 1 — per account: the current notable set + the not-yet-notified alerts.
  const processed: ProcessedAccount[] = [];
  for (const [cid, name, product, alerts] of results) {
    if (alerts === null) continue; // failed run — don't touch this account's snapshot
    const notable = alerts.filter((a) => SLACK_NOTABLE.has(a.severity));
    const curFps = new Set(notable.map(fp));
    const prev = await getNotified(product, cid);
    const fresh = notable.filter((a) => !prev.has(fp(a)));
    processed.push({ cid, name, product, curFps, fresh });
  }

  const commit = async (accts: ProcessedAccount[]): Promise<void> => {
    for (const p of accts) {
      await putNotified(p.product, p.cid, p.curFps);
    }
  };

  // Accounts with nothing new can advance now (wipes cleared fingerprints ->
  // self-heal; no-op otherwise). Accounts with fresh alerts only advance after
  // a successful send.
  const noFresh = processed.filter((p) => p.fresh.length === 0);
  const sections: Section[] = processed
    .filter((p) => p.fresh.length > 0)
    .map((p) => [p.name, p.product, p.fresh] as const);
  const newCount = processed.reduce((n, p) => n + p.fresh.length, 0);

  if (!sections.length) {
    await commit(noFresh); // == all processed; self-heal any cleared accounts
    console.log("[AdsOsV2] alerts digest: nothing new to send");
    return { sent: false, new_alerts: 0 };
  }

  if (!isSlackConfigured()) {
    await commit(noFresh); // keep fresh alerts pending until a webhook is configured
    console.log(`[AdsOsV2] alerts digest: SLACK_WEBHOOK_URL unset — ${newCount} new alert(s) not sent`);
    return { sent: false, new_alerts: newCount, reason: "no webhook configured" };
  }

  const pages = paginate(sections, newCount);
  const delivered: boolean[] = [];
  for (const page of pages) {
    const res = await postSlackMessage({ blocks: page });
    delivered.push(!!res.sent);
  }
  if (delivered.every(Boolean)) {
    await commit(processed); // everything delivered -> record all (no re-nag next run)
  } else {
    await commit(noFresh); // a page failed -> let every fresh alert retry next run
  }
  return {
    sent: delivered.some(Boolean),
    messages: delivered.filter(Boolean).length,
    new_alerts: newCount,
    accounts: sections.length,
  };
}

function accountBlocks(name: string, product: Product, alerts: Alert[]): Record<string, any>[] {
  const tag = product === "lsa" ? "LSA" : "Google Ads";
  const lines: string[] = [];
  for (const a of alerts) {
    let line = `${SEV_EMOJI[a.severity] ?? "•"} *${esc(a.title)}*`;
    if (a.detail) line += `\n${esc(a.detail)}`;
    if (a.deep_link) line += `\n<${a.deep_link}|Open in Google Ads>`;
    lines.push(line);
  }
  let body = `*${esc(name)}* · ${tag}\n\n` + lines.join("\n\n");
  if (body.length > 2900) {
    body = body.slice(0, 2890) + "\n… (truncated)";
  }
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: body } },
  ];
}

/** Pack account blocks into pages under Slack's block limit. */
export function paginate(sections: Section[], newCount: number): Record<string, any>[][] {
  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  const groups = sections.map(([name, product, alerts]) => accountBlocks(name, product, alerts));
  const footerText = `${newCount} new alert(s) across ${sections.length} account(s) · NBM Ads OS`;

  const pages: Record<string, any>[][] = [];
  let current: Record<string, any>[] = [];
  const capacity = MAX_BLOCKS - 2; // reserve header + footer
  for (const g of groups) {
    if (current.length && current.length + g.length > capacity) {
      pages.push(current);
      current = [];
    }
    current = current.concat(g);
  }
  pages.push(current);

  const out: Record<string, any>[][] = [];
  pages.forEach((page, i) => {
    const title = "Google Ads Pulse — " + dateStr + (pages.length > 1 ? ` (${i + 1}/${pages.length})` : "");
    const blocks: Record<string, any>[] = [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      ...page,
      { type: "context", elements: [{ type: "mrkdwn", text: footerText }] },
    ];
    out.push(blocks);
  });
  return out;
}
