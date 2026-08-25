/**
 * One-attempt website contact → Slack relay.
 *
 * The inquiry row is the system of record. Slack is best-effort notification
 * only: there is no delivery row, retry queue, fallback channel, or replay.
 * A timeout after Slack accepted chat.postMessage is therefore never retried.
 */
import {
  isTerminalSlackAuthCode,
  listChannels,
  parseSlackErrorCode,
  plainEnglishSlackReason,
  postMessageOnce,
  probeConnection as probeSlackConnection,
  type SlackChannel,
  type SlackProbeResult,
} from "./slackIntegration";
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const WEBSITE_INQUIRY_SLACK_CHANNEL_NAME = "sales-calls";
export const WEBSITE_INQUIRY_MESSAGE_EXCERPT_MAX = 1_200;
export const WEBSITE_INQUIRY_SLACK_TIMEOUT_MS = 8_000;

export interface WebsiteInquirySlackArgs {
  inquiryId: string;
  fullName: string;
  email: string;
  phone: string;
  message: string;
  sourcePage: string | null;
  sourceHost: string | null;
}

export type WebsiteInquirySlackResult = {
  status: "delivered" | "failed" | "not_connected";
  reason: string | null;
};

interface WebsiteInquirySlackDeps {
  probeConnection: () => Promise<SlackProbeResult>;
  listChannels: () => Promise<SlackChannel[]>;
  postMessage: (
    channel: string,
    text: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  timeoutMs?: number;
}

const defaultDeps: WebsiteInquirySlackDeps = {
  probeConnection: probeSlackConnection,
  listChannels,
  postMessage: (channel, text, signal) =>
    postMessageOnce(channel, text, signal),
  timeoutMs: WEBSITE_INQUIRY_SLACK_TIMEOUT_MS,
};

let inquirySlackChannelId: string | null = null;
let inquirySlackLookupDone = false;

export function __resetWebsiteInquirySlackStateForTest(): void {
  inquirySlackChannelId = null;
  inquirySlackLookupDone = false;
}

registerModuleStateResetForTest(
  "websiteInquirySlackRelay",
  __resetWebsiteInquirySlackStateForTest,
);

function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function excerpt(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function withSlackTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Slack relay call timed out"));
    }, timeoutMs);
    timeout.unref?.();
    void start(controller.signal).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function buildWebsiteInquirySlackMessage(
  args: WebsiteInquirySlackArgs,
): string {
  const location =
    [args.sourceHost, args.sourcePage].filter(Boolean).join("") || "unknown";
  const message = excerpt(args.message, WEBSITE_INQUIRY_MESSAGE_EXCERPT_MAX);
  const quotedMessage = escapeSlackText(message)
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
  return [
    ":incoming_envelope: *New website inquiry*",
    `Inquiry ID: \`${escapeSlackText(args.inquiryId)}\``,
    `Name: *${escapeSlackText(args.fullName)}*`,
    `Email: ${escapeSlackText(args.email)}`,
    `Phone: ${escapeSlackText(args.phone)}`,
    `Source: ${escapeSlackText(location)}`,
    "Message:",
    quotedMessage || ">_(empty)_",
  ].join("\n");
}

/**
 * Resolve the exact normalized channel and attempt one post. Never throws.
 * Tests pass local stubs through deps; production uses the existing Slack
 * credential, probe, breaker, pagination, and error classification.
 */
export async function relayWebsiteInquiryToSlack(
  args: WebsiteInquirySlackArgs,
  deps: WebsiteInquirySlackDeps = defaultDeps,
): Promise<WebsiteInquirySlackResult> {
  const timeoutMs = deps.timeoutMs ?? WEBSITE_INQUIRY_SLACK_TIMEOUT_MS;
  let probe: SlackProbeResult;
  try {
    probe = await withSlackTimeout(() => deps.probeConnection(), timeoutMs);
  } catch {
    console.warn("[WebsiteInquiryRelay] Slack connectivity probe timed out or failed");
    return {
      status: "failed",
      reason: "Slack is temporarily unreachable.",
    };
  }
  if (probe.outcome === "unauthorized") {
    return {
      status: "not_connected",
      reason: plainEnglishSlackReason(probe.reason),
    };
  }
  if (probe.outcome === "probe_failed") {
    return {
      status: "failed",
      reason: "Slack is temporarily unreachable.",
    };
  }

  if (!inquirySlackLookupDone || !inquirySlackChannelId) {
    try {
      inquirySlackLookupDone = true;
      const channels = await withSlackTimeout(
        () => deps.listChannels(),
        timeoutMs,
      );
      const target = channels.find(
        (channel) =>
          channel.name.trim().toLowerCase() ===
            WEBSITE_INQUIRY_SLACK_CHANNEL_NAME && channel.is_member,
      );
      inquirySlackChannelId = target?.id ?? null;
      if (!target) {
        console.warn(
          `[WebsiteInquiryRelay] #${WEBSITE_INQUIRY_SLACK_CHANNEL_NAME} is unavailable or the Slack bot is not a member`,
        );
      }
    } catch (error) {
      inquirySlackLookupDone = false;
      const code = parseSlackErrorCode(
        error instanceof Error ? error.message : null,
      );
      console.warn(
        `[WebsiteInquiryRelay] Slack channel lookup failed (${code ?? "unclassified"})`,
      );
      return {
        status: isTerminalSlackAuthCode(code)
          ? "not_connected"
          : "failed",
        reason: code
          ? plainEnglishSlackReason(code)
          : "Could not reach Slack to look up the channel.",
      };
    }
  }

  const channelId = inquirySlackChannelId;
  if (!channelId) {
    return {
      status: "failed",
      reason: plainEnglishSlackReason("channel_not_found"),
    };
  }

  try {
    await withSlackTimeout(
      (signal) => deps.postMessage(
        channelId,
        buildWebsiteInquirySlackMessage(args),
        signal,
      ),
      timeoutMs,
    );
    return { status: "delivered", reason: null };
  } catch (error) {
    const code = parseSlackErrorCode(
      error instanceof Error ? error.message : null,
    );
    if (
      code === "channel_not_found" ||
      code === "is_archived" ||
      code === "not_in_channel"
    ) {
      inquirySlackChannelId = null;
      inquirySlackLookupDone = false;
    }
    console.warn(
      `[WebsiteInquiryRelay] Slack post failed (${code ?? "unclassified"})`,
    );
    return {
      status: isTerminalSlackAuthCode(code)
        ? "not_connected"
        : "failed",
      reason: code
        ? plainEnglishSlackReason(code)
        : "Slack post failed or timed out.",
    };
  }
}

const pendingInquiryRelays = new Set<Promise<unknown>>();

export async function __test_drainPendingWebsiteInquiryRelays(): Promise<void> {
  while (pendingInquiryRelays.size > 0) {
    await Promise.allSettled(Array.from(pendingInquiryRelays));
  }
}

async function runWebsiteInquiryRelay(
  args: WebsiteInquirySlackArgs,
): Promise<WebsiteInquirySlackResult> {
  try {
    const result = await relayWebsiteInquiryToSlack(args);
    if (result.status === "delivered") {
      console.log(
        `[WebsiteInquiryRelay] Inquiry ${args.inquiryId} posted to #${WEBSITE_INQUIRY_SLACK_CHANNEL_NAME}`,
      );
    } else {
      console.warn(
        `[WebsiteInquiryRelay] Inquiry ${args.inquiryId} not posted (${result.status}; ${result.reason ?? "unknown"}); stored inquiry remains available`,
      );
    }
    return result;
  } catch {
    console.warn(
      `[WebsiteInquiryRelay] Inquiry ${args.inquiryId} relay failed unexpectedly; stored inquiry remains available`,
    );
    return { status: "failed", reason: "unexpected relay error" };
  }
}

export function kickWebsiteInquirySlackRelay(
  args: WebsiteInquirySlackArgs,
): Promise<WebsiteInquirySlackResult> {
  const pending = runWebsiteInquiryRelay(args);
  pendingInquiryRelays.add(pending);
  const remove = () => pendingInquiryRelays.delete(pending);
  void pending.then(remove, remove);
  return pending;
}