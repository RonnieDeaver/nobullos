import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Hash, Lock, MessageSquare } from "lucide-react";
import type { CommsChannel, CommsMessage } from "./types";

export const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "🔥", "✅", "💯"];

export function displayName(
  user: Pick<NonNullable<CommsMessage["user"]>, "id" | "firstName" | "lastName" | "email"> | null,
): string {
  if (!user) return "System";
  if (user.firstName || user.lastName) {
    return [user.firstName, user.lastName].filter(Boolean).join(" ");
  }
  if (user.email) return user.email.split("@")[0];
  return user.id.slice(0, 8);
}

export function avatarInitials(user: CommsMessage["user"] | null): string {
  if (!user) return "?";
  if (user.firstName) return user.firstName[0].toUpperCase();
  if (user.lastName) return user.lastName[0].toUpperCase();
  return "?";
}

export function formatTime(ts: string): string {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

/**
 * Renders a safe markdown-subset content string to React nodes.
 * Block-level: ```fenced code blocks```, > blockquotes, -/* unordered lists,
 * 1. ordered lists. Inline: **bold**, *italic*, `code`, ~~strikethrough~~,
 * @[Name](user:id) mentions, @channel / @here broadcast tokens, :name: custom
 * emoji (rendered as <img> when found in customEmojiMap), and plain URLs as
 * clickable links. Everything is built as React elements — no innerHTML.
 */
export function renderContent(
  content: string,
  highlightKeywords?: string[],
  customEmojiMap?: Record<string, string>,
): React.ReactNode {
  if (!content) return null;
  const keywords = (highlightKeywords ?? []).filter((k) => k.trim().length > 0);
  return renderBlocks(content, keywords, customEmojiMap);
}

/**
 * Converts a markdown-subset message to plain text for one-line previews,
 * snippets, and desktop notifications. Pure strip logic lives in
 * shared/commsFormatting.ts so the server can build notification bodies
 * with the same rules; re-exported here for existing client imports.
 */
export { stripFormatting } from "@shared/commsFormatting";

type Block =
  | { type: "code"; lang: string; lines: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[]; start: number }
  | { type: "para"; lines: string[] };

function parseBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ type: "code", lang: fence[1] ?? "", lines: codeLines });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoteLines: string[] = [quote[1]];
      i++;
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i].match(/^>\s?(.*)$/))) {
        quoteLines.push(m[1]);
        i++;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }
    const ulItem = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulItem) {
      const items: string[] = [ulItem[1]];
      i++;
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i].match(/^\s*[-*]\s+(.*)$/))) {
        items.push(m[1]);
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    const olItem = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (olItem) {
      const start = parseInt(olItem[1], 10);
      const items: string[] = [olItem[2]];
      i++;
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i].match(/^\s*\d{1,9}[.)]\s+(.*)$/))) {
        items.push(m[1]);
        i++;
      }
      blocks.push({ type: "ol", items, start });
      continue;
    }
    // Paragraph: accumulate until the next special block or blank-line boundary
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^```(\S*)\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d{1,9}[.)]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", lines: paraLines });
  }
  return blocks;
}

function renderBlocks(
  content: string,
  keywords: string[],
  customEmojiMap?: Record<string, string>,
): React.ReactNode {
  const blocks = parseBlocks(content);
  // Single plain paragraph: render inline directly (preserves existing DOM shape)
  if (blocks.length === 1 && blocks[0].type === "para") {
    return renderInlineTokens(blocks[0].lines.join("\n"), keywords, customEmojiMap);
  }
  return blocks.map((block, bi) => {
    if (block.type === "code") {
      return (
        <pre
          key={bi}
          className="bg-muted rounded-md px-3 py-2 my-1 overflow-x-auto text-sm font-mono whitespace-pre-wrap"
          data-testid="md-code-block"
        >
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    }
    if (block.type === "quote") {
      return (
        <blockquote
          key={bi}
          className="border-l-2 border-muted-foreground/40 pl-3 my-1 text-foreground/80"
          data-testid="md-blockquote"
        >
          {block.lines.map((l, li) => (
            <span key={li} className="block">
              {renderInlineTokens(l, keywords, customEmojiMap)}
            </span>
          ))}
        </blockquote>
      );
    }
    if (block.type === "ul") {
      return (
        <ul key={bi} className="list-disc pl-5 my-1 space-y-0.5" data-testid="md-ul">
          {block.items.map((item, li) => (
            <li key={li}>{renderInlineTokens(item, keywords, customEmojiMap)}</li>
          ))}
        </ul>
      );
    }
    if (block.type === "ol") {
      return (
        <ol
          key={bi}
          start={block.start}
          className="list-decimal pl-5 my-1 space-y-0.5"
          data-testid="md-ol"
        >
          {block.items.map((item, li) => (
            <li key={li}>{renderInlineTokens(item, keywords, customEmojiMap)}</li>
          ))}
        </ol>
      );
    }
    return (
      <span key={bi} className="block">
        {renderInlineTokens(block.lines.join("\n"), keywords, customEmojiMap)}
      </span>
    );
  });
}

function renderInlineTokens(
  content: string,
  keywords: string[],
  customEmojiMap?: Record<string, string>,
): React.ReactNode {
  if (!content) return null;
  // Split on mention tokens, broadcast tokens, and :name: custom emoji tokens
  const parts = content.split(/(@\[[^\]]+\]\([^)]+\)|@channel|@here|:[a-zA-Z0-9_-]{2,64}:)/g);
  return parts.map((part, i) => {
    const mentionMatch = part.match(/^@\[([^\]]+)\]\(([^)]+)\)$/);
    if (mentionMatch) {
      return (
        <span key={i} className="bg-primary/10 text-primary rounded px-1 font-medium">
          @{mentionMatch[1]}
        </span>
      );
    }
    if (part === "@channel" || part === "@here") {
      return (
        <span key={i} className="bg-amber-500/15 text-amber-700 dark:text-amber-400 rounded px-1 font-medium">
          {part}
        </span>
      );
    }
    // :name: custom emoji token
    const emojiMatch = part.match(/^:([a-zA-Z0-9_-]{2,64}):$/);
    if (emojiMatch) {
      const name = emojiMatch[1];
      const url = customEmojiMap?.[name];
      if (url) {
        return (
          <img
            key={i}
            src={url}
            alt={`:${name}:`}
            title={`:${name}:`}
            className="inline-block w-5 h-5 align-middle rounded-sm object-contain"
            data-testid={`custom-emoji-${name}`}
          />
        );
      }
      // Unknown custom emoji: render as literal text (no silent fallback)
      return <span key={i}>{part}</span>;
    }
    return <RichInline key={i} text={part} keywords={keywords} />;
  });
}

/**
 * Underlines word-boundary matches for the viewing user's notification keywords
 * in a plain-text segment. Matching semantics mirror contentMatchesKeywords in
 * shared/commsNotifResolution.ts (case-insensitive, non-word-char boundaries).
 */
function keywordify(text: string, keywords: string[], keyBase: number): React.ReactNode {
  if (!text || keywords.length === 0) return text;
  const escaped = keywords
    .map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (escaped.length === 0) return text;
  const re = new RegExp(`(?<=^|\\W)(${escaped.join("|")})(?=\\W|$)`, "gi");
  const parts: React.ReactNode[] = [];
  let last = 0;
  let k = keyBase;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <span
        key={`kw-${k++}`}
        className="underline decoration-amber-500 decoration-2 underline-offset-2 font-medium"
        data-testid="keyword-highlight"
      >
        {match[0]}
      </span>
    );
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function RichInline({ text, keywords = [] }: { text: string; keywords?: string[] }) {
  if (!text) return null;
  // Process markdown-subset inline rules: **bold**, *italic*, `code`, ~~strike~~
  const segments: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Code: `code`
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
    // Bold: **text**
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*(.*)/s);
    // Italic: *text* (not preceded by *)
    const italicMatch = remaining.match(/^(.*?)(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)(.*)/s);
    // Italic: _text_ (word-boundary delimited, so snake_case stays untouched)
    const underItalicMatch = remaining.match(/^(.*?)(?<![\w_])_(?!_)([^_]+)(?<!_)_(?![\w_])(.*)/s);
    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^(.*?)~~([^~]+)~~(.*)/s);

    const candidates = [
      codeMatch && { before: codeMatch[1], inner: codeMatch[2], after: codeMatch[3], type: "code" as const },
      boldMatch && { before: boldMatch[1], inner: boldMatch[2], after: boldMatch[3], type: "bold" as const },
      italicMatch && { before: italicMatch[1], inner: italicMatch[2], after: italicMatch[3], type: "italic" as const },
      underItalicMatch && { before: underItalicMatch[1], inner: underItalicMatch[2], after: underItalicMatch[3], type: "italic" as const },
      strikeMatch && { before: strikeMatch[1], inner: strikeMatch[2], after: strikeMatch[3], type: "strike" as const },
    ].filter((c): c is NonNullable<typeof c> => !!c);

    if (candidates.length === 0) {
      segments.push(<span key={key++}>{linkify(remaining, keywords)}</span>);
      break;
    }

    const best = candidates.reduce((a, b) => a.before.length <= b.before.length ? a : b);

    if (best.before) segments.push(<span key={key++}>{linkify(best.before, keywords)}</span>);

    if (best.type === "code") {
      segments.push(
        <code key={key++} className="bg-muted px-1 rounded text-sm font-mono">
          {best.inner}
        </code>
      );
    } else if (best.type === "bold") {
      segments.push(<strong key={key++}>{best.inner}</strong>);
    } else if (best.type === "italic") {
      segments.push(<em key={key++}>{best.inner}</em>);
    } else if (best.type === "strike") {
      segments.push(<s key={key++}>{best.inner}</s>);
    }

    remaining = best.after;
  }

  return <>{segments}</>;
}

function linkify(text: string, keywords: string[] = []): React.ReactNode {
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let k = 0;
  while ((match = urlPattern.exec(text)) !== null) {
    if (match.index > last) parts.push(<span key={k++}>{keywordify(text.slice(last, match.index), keywords, k * 100)}</span>);
    parts.push(
      <a
        key={k++}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-ink underline hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        {match[0]}
      </a>
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(<span key={k++}>{keywordify(text.slice(last), keywords, k * 100)}</span>);
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

/** Maps an effective status to a CSS class for the presence dot. */
const STATUS_DOT: Record<string, string> = {
  online: "bg-green-500",
  away: "bg-yellow-400",
  dnd: "bg-red-500",
  offline: "bg-muted-foreground/40",
};

export function Avatar({
  user,
  online,
  status,
  size = "sm",
}: {
  user: CommsMessage["user"] | null;
  /** Legacy boolean presence dot — ignored when `status` is provided. */
  online?: boolean;
  /** Effective status string (online/away/dnd/offline). Takes precedence over `online`. */
  status?: string | null;
  size?: "xs" | "sm" | "md";
}) {
  const sizes = { xs: "h-6 w-6 text-xs", sm: "h-8 w-8 text-sm", md: "h-10 w-10 text-base" };
  const dotClass = status != null
    ? STATUS_DOT[status] ?? "bg-muted-foreground/40"
    : online
    ? "bg-green-500"
    : "bg-muted-foreground/40";
  const showDot = status != null || online !== undefined;
  return (
    <div className="relative flex-shrink-0">
      {user?.profileImageUrl ? (
        <img
          src={user.profileImageUrl}
          alt={displayName(user)}
          className={cn("rounded-full object-cover", sizes[size])}
        />
      ) : (
        <div
          className={cn(
            "rounded-full bg-primary/15 flex items-center justify-center font-semibold text-primary",
            sizes[size],
          )}
        >
          {avatarInitials(user)}
        </div>
      )}
      {showDot && (
        <span
          className={cn(
            "absolute bottom-0 right-0 h-2 w-2 rounded-full border border-background",
            dotClass,
          )}
          data-testid={status != null ? `avatar-status-${status}` : undefined}
        />
      )}
    </div>
  );
}

export function ChannelIcon({ ch }: { ch: CommsChannel }) {
  if (ch.type === "dm" || ch.type === "group_dm") {
    return <MessageSquare className="h-4 w-4 flex-shrink-0" />;
  }
  if (ch.visibility === "private") {
    return <Lock className="h-4 w-4 flex-shrink-0" />;
  }
  return <Hash className="h-4 w-4 flex-shrink-0" />;
}

export function channelDisplayName(ch: CommsChannel): string {
  if (ch.clientId) return ch.clientFirmName ?? "Client channel";
  if (ch.type === "dm") {
    if (ch.name) return ch.name;
    if (ch.dmParticipantNames?.length) return ch.dmParticipantNames[0];
    return "Direct Message";
  }
  if (ch.type === "group_dm") {
    if (ch.name) return ch.name;
    if (ch.dmParticipantNames?.length) {
      // First names only to keep the label concise in the rail/header
      const firstNames = ch.dmParticipantNames.map((n) => n.split(" ")[0]).filter(Boolean);
      if (firstNames.length) return firstNames.join(", ");
    }
    return "Group DM";
  }
  return ch.name ?? ch.slug ?? "Channel";
}

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
