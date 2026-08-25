// Stub for server/services/adsOs/slackWebhook.ts (see ads-os-p6-hooks.mjs).
// Records every Block Kit payload instead of POSTing; test state flips
// delivery failure. Pure stub (nothing else from the real module is used by
// the digest path).

const g = (): any => ((globalThis as any).__p6 ??= {});

export interface SlackPostResult {
  sent: boolean;
  reason?: string;
}

export async function postSlackMessage(payload: object): Promise<SlackPostResult> {
  (g().slackPosts ??= []).push(payload);
  if (g().slackFail) return { sent: false, reason: "stub delivery failure" };
  return { sent: true };
}

export async function postSlackText(text: string): Promise<SlackPostResult> {
  return postSlackMessage({ blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
}
