/**
 * Comms message formatting — plain-text stripper shared by client and server.
 *
 * Converts a markdown-subset comms message to plain text for one-line
 * previews, snippets, desktop notifications, and server-built notification
 * bodies (inbox + Slack DM forwarding). Strips **bold**, *italic*, _italic_,
 * ~~strike~~, `code` markers, ``` fences, > quote prefixes, and -/* / 1. list
 * markers, and converts @[Name](user:id) mention tokens to @Name. Custom
 * :emoji: tokens and URLs are left as literal text.
 *
 * The client-side React renderer (renderContent) lives in
 * client/src/components/comms/helpers.tsx; this module holds only the pure,
 * DOM-free strip logic so the server can consume it too.
 */
export function stripFormatting(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```\S*\s*$/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let l = line;
    l = l.replace(/^>\s?/, "");
    l = l.replace(/^\s*[-*]\s+/, "");
    l = l.replace(/^\s*(\d{1,9})[.)]\s+/, "$1. ");
    out.push(l);
  }
  let text = out.join(" ").replace(/\s+/g, " ").trim();
  text = text.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "$1");
  text = text.replace(/(?<![\w_])_(?!_)([^_]+)(?<!_)_(?![\w_])/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  return text;
}
