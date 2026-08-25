/**
 * Ads OS — Slack incoming webhook poster.
 *
 * Simple best-effort fire-and-forget. The webhook URL is a server-side secret
 * (SLACK_WEBHOOK_URL) and is never logged, echoed, or returned to the browser.
 * When unconfigured, posts silently succeed as a no-op (spec §9: "no Slack → digest off").
 *
 * Used for the morning alert digest (Phase 6). Stubbed here for Phase 0 proofs.
 */

import { getSlackWebhookUrl, isSlackConfigured } from "./config";

export interface SlackPostResult {
  sent: boolean;
  reason?: string;
}

/**
 * POST a Slack Block Kit payload to the configured webhook.
 * Returns { sent: true } on HTTP 200; { sent: false, reason } otherwise.
 * Never throws — callers treat Slack as best-effort.
 */
export async function postSlackMessage(payload: object): Promise<SlackPostResult> {
  if (!isSlackConfigured()) {
    return { sent: false, reason: "SLACK_WEBHOOK_URL is not configured" };
  }
  const webhookUrl = getSlackWebhookUrl();
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) return { sent: true };
    return { sent: false, reason: `Slack returned HTTP ${res.status}` };
  } catch (err: any) {
    return { sent: false, reason: `Slack post failed: ${err?.message ?? err}` };
  }
}

/** Send a simple text message (for diagnostics). */
export async function postSlackText(text: string): Promise<SlackPostResult> {
  return postSlackMessage({ blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
}
