import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useCommsSelector } from "@/contexts/CommsContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Edit3,
  MoreHorizontal,
  Reply,
  Smile,
  Trash2,
  Pin,
  Bookmark,
  Link,
  Download,
  FileText,
  Image as ImageIcon,
  EyeOff,
  Bot,
  BookmarkPlus,
  History,
  Bell,
  Forward,
  ChevronLeft,
  ChevronRight,
  X,
  ExternalLink,
} from "lucide-react";
import { Avatar, QUICK_EMOJIS, displayName, formatTime, renderContent, formatBytes } from "./helpers";
import { contentMatchesKeywords } from "@shared/commsNotifResolution";
import { EmojiPicker, useCustomEmojiMap, AnchoredPortalPanel } from "./EmojiPicker";
import type { CommsMessage, CommsAttachment, CommsLinkPreview } from "./types";
import { baseEmojiOf, toneLabelOf } from "./emojiSkinTone";

// Skin-tone variants of the same base emoji deliberately render as SEPARATE
// reaction pills (Slack parity — each user+emoji string is a distinct reaction
// row, see tests/comms-custom-emoji.test.ts §6). The pill tooltip labels toned
// variants ("👍 — Medium-Dark skin tone") so the distinction is legible.
export function reactionPillTitle(
  emoji: string,
  names?: string[],
  count?: number,
): string | undefined {
  const label = toneLabelOf(emoji);
  const toneText = label ? `${baseEmojiOf(emoji)} — ${label} skin tone` : undefined;
  const list = (names ?? []).filter((n) => n && n.length > 0);
  if (list.length === 0) return toneText;
  const total = Math.max(count ?? list.length, list.length);
  const extra = total - list.length;
  let who: string;
  if (extra > 0) {
    who = `${list.join(", ")} and ${extra} other${extra === 1 ? "" : "s"}`;
  } else if (list.length === 1) {
    who = list[0];
  } else {
    who = `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }
  const base = `${who} reacted with ${emoji}`;
  return toneText ? `${base} (${toneText})` : base;
}

// ─── Image lightbox ───────────────────────────────────────────────────────────

export function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: {
  images: Array<{ src: string; alt: string }>;
  initialIndex: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(initialIndex);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIdx((i) => (i - 1 + images.length) % images.length);
      if (e.key === "ArrowRight") setIdx((i) => (i + 1) % images.length);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [images.length, onClose]);

  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(() => new Set());

  const img = images[idx];
  const imgFailed = failedSrcs.has(img.src);
  return (
    <div
      className="fixed inset-0 z-[var(--z-toast)] bg-black/90 flex items-center justify-center"
      onClick={onClose}
      data-testid="lightbox-overlay"
    >
      <button
        className="absolute top-4 right-4 text-white/70 hover:text-white p-2"
        onClick={onClose}
        data-testid="lightbox-close"
      >
        <X className="h-6 w-6" />
      </button>
      {images.length > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-2"
            onClick={(e) => { e.stopPropagation(); setIdx((i) => (i - 1 + images.length) % images.length); }}
            data-testid="lightbox-prev"
          >
            <ChevronLeft className="h-8 w-8" />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-2"
            onClick={(e) => { e.stopPropagation(); setIdx((i) => (i + 1) % images.length); }}
            data-testid="lightbox-next"
          >
            <ChevronRight className="h-8 w-8" />
          </button>
        </>
      )}
      {imgFailed ? (
        <div
          className="flex flex-col items-center gap-2 text-white/80 px-6 py-8 rounded bg-white/5 border border-white/10"
          onClick={(e) => e.stopPropagation()}
          data-testid="lightbox-image-fallback"
        >
          <FileText className="h-8 w-8 text-white/50" />
          <p className="text-sm font-medium">{img.alt}</p>
          <p className="text-xs text-white/50">Image could not be loaded</p>
        </div>
      ) : (
        <img
          src={img.src}
          alt={img.alt}
          className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            setFailedSrcs((prev) => {
              if (prev.has(img.src)) return prev;
              const next = new Set(prev);
              next.add(img.src);
              return next;
            });
          }}
          data-testid="lightbox-image"
        />
      )}
      {images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-sm">
          {idx + 1} / {images.length}
        </div>
      )}
    </div>
  );
}

// ─── Attachment card ──────────────────────────────────────────────────────────

export function AttachmentCard({
  att,
  allImages,
  imageIndex,
  onOpenLightbox,
  mediaCompact = false,
}: {
  att: CommsAttachment;
  allImages: Array<{ src: string; alt: string }>;
  imageIndex: number;
  onOpenLightbox: (idx: number) => void;
  /** Narrow-surface (popup) rendering: cap image preview height so stacked
   *  media blocks don't crowd the 340px popup. Lightbox still shows full-res. */
  mediaCompact?: boolean;
}) {
  const isImage = att.contentType.startsWith("image/");
  const downloadUrl = `/api/comms/attachments/${encodeURIComponent(att.objectKey)}`;
  // Preview uses the server-generated thumbnail when available; the lightbox
  // (allImages) always loads the full-resolution original.
  const previewUrl = att.thumbnailKey
    ? `/api/comms/attachments/${encodeURIComponent(att.thumbnailKey)}`
    : downloadUrl;
  // When the inline preview fails to load (missing object, 403/404/500), fall
  // back to the filename + download-link treatment instead of a broken image.
  const [previewFailed, setPreviewFailed] = useState(false);

  if (isImage && !previewFailed) {
    return (
      <button
        onClick={() => onOpenLightbox(imageIndex)}
        className="inline-block max-w-full mt-1 rounded overflow-hidden border border-border hover:opacity-90 transition-opacity cursor-zoom-in text-left"
        data-testid={`attachment-image-${att.id}`}
        type="button"
        aria-label={`Open ${att.filename} in lightbox`}
      >
        <img
          src={previewUrl}
          alt={att.filename}
          className={`max-w-full object-contain bg-muted ${mediaCompact ? "max-h-32" : "max-h-48"}`}
          onError={(e) => {
            // Best-effort thumbnail: if it fails to load, fall back to full-res.
            // If the full-res original also fails, drop to the filename +
            // download-link treatment instead of a broken image.
            const el = e.target as HTMLImageElement;
            const current = el.getAttribute("src");
            if (previewUrl !== downloadUrl && current !== downloadUrl) {
              el.src = downloadUrl;
            } else {
              setPreviewFailed(true);
            }
          }}
        />
      </button>
    );
  }

  return (
    <a
      href={downloadUrl}
      download={att.filename}
      className="flex items-center gap-2 mt-1 p-2 rounded border border-border hover:bg-muted/50 transition-colors max-w-full group"
      data-testid={`attachment-file-${att.id}`}
    >
      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{att.filename}</p>
        {att.sizeBytes && (
          <p className="text-xs text-muted-foreground">{formatBytes(att.sizeBytes)}</p>
        )}
      </div>
      <Download className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
    </a>
  );
}

// ─── Link preview card ────────────────────────────────────────────────────────

// Route external preview images through the authenticated server-side proxy
// so readers' browsers never contact the outside site directly (the site
// owner would otherwise see each viewer's IP, timing, and user agent).
function proxiedImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return `/api/comms/link-preview-image?url=${encodeURIComponent(raw)}`;
}

function LinkPreviewCard({
  preview,
  compact = false,
}: {
  preview: CommsLinkPreview;
  /** Compact variant for narrow surfaces (340px popup): drops the side
   *  thumbnail, clamps title to one line, and hides the description so a
   *  message carrying both an image attachment and previews stays legible. */
  compact?: boolean;
}) {
  const imageSrc = proxiedImageUrl(preview.imageUrl);
  const faviconSrc = proxiedImageUrl(preview.faviconUrl);
  const domain = (() => {
    try {
      return new URL(preview.url).hostname.replace(/^www\./, "");
    } catch {
      return preview.siteName ?? preview.url;
    }
  })();

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex mt-2 rounded-md border border-border hover:bg-muted/40 transition-colors overflow-hidden max-w-full group ${compact ? "gap-2" : "gap-3"}`}
      data-testid={`link-preview-${encodeURIComponent(preview.url).slice(0, 40)}`}
      data-compact={compact ? "true" : undefined}
    >
      {imageSrc && !compact && (
        <div className="w-20 flex-shrink-0 bg-muted overflow-hidden">
          <img
            src={imageSrc}
            alt={preview.title ?? ""}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </div>
      )}
      <div className={`flex-1 min-w-0 ${compact ? "p-2" : "p-2.5"}`}>
        <div className="flex items-center gap-1 mb-0.5">
          {faviconSrc && (
            <img
              src={faviconSrc}
              alt=""
              className="w-3 h-3 flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <span className="text-xs text-muted-foreground truncate">{domain}</span>
          <ExternalLink className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        {preview.title && (
          <p
            className={`text-sm font-medium text-foreground leading-tight ${compact ? "line-clamp-1" : "line-clamp-2"}`}
          >
            {preview.title}
          </p>
        )}
        {preview.description && !compact && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 leading-snug">{preview.description}</p>
        )}
      </div>
    </a>
  );
}

// ─── MessageItem ──────────────────────────────────────────────────────────────

export function MessageItem({
  msg,
  currentUserId,
  onReact,
  onEdit,
  onDelete,
  onReply,
  onOpenThread,
  onPin,
  onSave,
  onMarkUnread,
  onBookmarkAttachment,
  onShowEditHistory,
  onRemind,
  onForward,
  isCompact = false,
  highlightKeywords,
  mediaCompact = false,
}: {
  msg: CommsMessage;
  currentUserId: string;
  onReact: (messageId: string, emoji: string) => void;
  onEdit: (msg: CommsMessage) => void;
  onDelete: (messageId: string) => void;
  onReply?: (msg: CommsMessage) => void;
  onOpenThread?: (msg: CommsMessage) => void;
  onPin?: (messageId: string) => void;
  onSave?: (messageId: string) => void;
  onMarkUnread?: (messageId: string) => void;
  onBookmarkAttachment?: (att: CommsAttachment) => void;
  onShowEditHistory?: (msg: CommsMessage) => void;
  onRemind?: (msg: CommsMessage) => void;
  onForward?: (msg: CommsMessage) => void;
  isCompact?: boolean;
  /** The viewing user's own notification keywords — used to visually flag matching messages. */
  highlightKeywords?: string[];
  /** Rendered inside a narrow surface (340px popup): cap image preview height
   *  and use the compact link-preview variant so both blocks fit legibly. */
  mediaCompact?: boolean;
}) {
  // Narrow store subscription (Task #3848): only the AUTHOR's status entry —
  // status/presence churn for other users never re-renders this message.
  const authorEntry = useCommsSelector((s) =>
    msg.userId ? s.userStatuses.get(msg.userId) ?? null : null,
  );
  const [showEmoji, setShowEmoji] = useState(false);
  const [showFullEmojiPicker, setShowFullEmojiPicker] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const customEmojiMap = useCustomEmojiMap();
  const isOwn = msg.userId === currentUserId;
  const authorStatus = authorEntry?.effectiveStatus ?? null;
  const authorCustomEmoji = authorEntry?.customEmoji ?? null;
  const authorCustomText = authorEntry?.customText ?? null;
  // Keyword highlight: only for the viewing user's own keywords, never on own/system messages
  const keywords = !isOwn && msg.contentType === "text" ? (highlightKeywords ?? []) : [];
  const isKeywordMatch =
    keywords.length > 0 && contentMatchesKeywords(msg.content ?? "", keywords);

  // Collect image attachments for gallery navigation
  const imageAttachments = (msg.attachments ?? []).filter((a) => a.contentType.startsWith("image/"));
  const imageGallery = imageAttachments.map((a) => ({
    src: `/api/comms/attachments/${encodeURIComponent(a.objectKey)}`,
    alt: a.filename,
  }));

  // Link previews — pulled from either the typed field or message metadata
  const linkPreviews: CommsLinkPreview[] =
    msg.linkPreviews ??
    ((msg.metadata as any)?.linkPreviews as CommsLinkPreview[] | undefined) ??
    [];

  const closeEmoji = () => {
    setShowEmoji(false);
    setShowFullEmojiPicker(false);
  };

  const copyPermalink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("channel", msg.channelId);
    url.searchParams.set("message", msg.id);
    url.hash = "";
    navigator.clipboard.writeText(url.toString()).catch(() => {});
  };

  if (msg.contentType === "system") {
    return (
      <div className="flex items-center gap-2 py-1 px-4 text-xs text-muted-foreground">
        <div className="flex-1 border-t border-dashed border-border" />
        <span className="flex-shrink-0">{msg.content}</span>
        <div className="flex-1 border-t border-dashed border-border" />
      </div>
    );
  }

  if (msg.contentType === "bot") {
    const source = (msg.metadata as any)?.source as string | undefined;
    const fields = (msg.metadata as any)?.fields as Array<{ title: string; value: string }> | undefined;
    const link = (msg.metadata as any)?.link as { label: string; url: string } | undefined;
    return (
      <div
        className="group flex gap-3 px-4 py-2 hover:bg-muted/30 transition-colors"
        data-testid={`comms-message-${msg.id}`}
      >
        <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-md bg-primary/10 border border-primary/20">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
            <span className="font-semibold text-sm text-foreground">
              NoBull Bot
            </span>
            {source && (
              <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono">
                {source}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
          </div>
          <div className="text-sm text-foreground break-words leading-relaxed">
            {renderContent(msg.content, undefined, customEmojiMap)}
          </div>
          {fields && fields.length > 0 && (
            <div className="mt-2 space-y-1 pl-2 border-l-2 border-primary/30">
              {fields.map((f, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="font-semibold text-muted-foreground">{f.title}:</span>
                  <span className="text-foreground">{f.value}</span>
                </div>
              ))}
            </div>
          )}
          {link && (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-primary-ink hover:underline"
            >
              {link.label} →
            </a>
          )}
          {Object.keys(msg.reactionCounts).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(msg.reactionCounts).map(([emoji, count]) => {
                const customMatch = emoji.match(/^:([a-zA-Z0-9_-]{2,64}):$/);
                const customUrl = customMatch ? customEmojiMap[customMatch[1]] : undefined;
                const isMine = msg.myReactions?.includes(emoji) ?? false;
                return (
                  <button
                    key={emoji}
                    data-testid={`reaction-${msg.id}-${emoji}`}
                    title={reactionPillTitle(emoji, msg.reactionNames?.[emoji], count)}
                    onClick={() => onReact(msg.id, emoji)}
                    {...(isMine ? { "data-mine": "true" } : {})}
                    className={cn(
                      "flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border transition-colors",
                      isMine
                        ? "bg-primary/10 hover:bg-primary/15 border-primary/60"
                        : "bg-muted hover:bg-muted/80 border-border/50",
                    )}
                  >
                    {customUrl ? (
                      <img
                        src={customUrl}
                        alt={emoji}
                        title={emoji}
                        className="w-3.5 h-3.5 object-contain rounded-sm"
                      />
                    ) : (
                      <span>{emoji}</span>
                    )}
                    <span className={isMine ? "text-primary font-medium" : "text-muted-foreground"}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {lightboxIndex !== null && imageGallery.length > 0 && (
        <ImageLightbox
          images={imageGallery}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      <div
        className={cn(
          "group relative flex gap-3 px-4 py-1.5 hover:bg-muted/30 transition-colors",
          isCompact && "py-0.5",
          // Status-signal keyword rail — official --status-warn token (Task #4492).
          isKeywordMatch && "border-l-2 border-l-status-warn bg-status-warn/5 pl-[14px]",
        )}
        data-testid={`comms-message-${msg.id}`}
        {...(isKeywordMatch ? { "data-keyword-match": "true" } : {})}
      >
        {!isCompact && <Avatar user={msg.user} size="sm" status={authorStatus ?? undefined} />}
        {isCompact && <div className="w-8 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          {!isCompact && (
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-semibold text-sm text-foreground">
                {displayName(msg.user)}
              </span>
              {authorCustomText && (
                <span className="text-xs text-muted-foreground" data-testid={`msg-author-custom-status-${msg.id}`}>
                  {authorCustomEmoji ? `${authorCustomEmoji} ${authorCustomText}` : authorCustomText}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
              {msg.editedAt && (
                <span className="text-xs text-muted-foreground italic">(edited)</span>
              )}
            </div>
          )}
          {(() => {
            const fwd = (msg.metadata as any)?.forwardedFrom as
              | { channelName: string | null; authorName: string; content: string; createdAt: string }
              | undefined;
            if (!fwd) return null;
            return (
              <div
                className="mt-0.5 mb-1 border-l-2 border-primary/40 pl-2 py-0.5"
                data-testid={`forwarded-block-${msg.id}`}
              >
                <p className="text-xs text-muted-foreground">
                  Forwarded from{" "}
                  <span className="font-medium">{fwd.authorName}</span>
                  {fwd.channelName ? <> in #{fwd.channelName}</> : null}
                </p>
                <div className="text-sm text-foreground/90 break-words leading-relaxed">
                  {renderContent(fwd.content, undefined, customEmojiMap)}
                </div>
              </div>
            );
          })()}
          {msg.content && (
            <div className="text-sm text-foreground break-words leading-relaxed">
              {renderContent(msg.content, isKeywordMatch ? keywords : undefined, customEmojiMap)}
            </div>
          )}

          {msg.attachments && msg.attachments.length > 0 && (() => {
            let imgIdx = 0;
            return (
              <div className="flex flex-col gap-1 mt-1 max-w-full">
                {msg.attachments.map((att) => {
                  const isImg = att.contentType.startsWith("image/");
                  const currentImgIdx = isImg ? imgIdx++ : -1;
                  return (
                    <AttachmentCard
                      key={att.id}
                      att={att}
                      allImages={imageGallery}
                      imageIndex={currentImgIdx}
                      onOpenLightbox={(i) => setLightboxIndex(i)}
                      mediaCompact={mediaCompact}
                    />
                  );
                })}
              </div>
            );
          })()}

          {linkPreviews.length > 0 && (
            <div className="flex flex-col gap-1 max-w-full" data-testid={`link-previews-${msg.id}`}>
              {linkPreviews.map((p) => (
                <LinkPreviewCard key={p.url} preview={p} compact={mediaCompact} />
              ))}
            </div>
          )}

          {Object.keys(msg.reactionCounts).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(msg.reactionCounts).map(([emoji, count]) => {
                const customMatch = emoji.match(/^:([a-zA-Z0-9_-]{2,64}):$/);
                const customUrl = customMatch ? customEmojiMap[customMatch[1]] : undefined;
                const isMine = msg.myReactions?.includes(emoji) ?? false;
                return (
                  <button
                    key={emoji}
                    data-testid={`reaction-${msg.id}-${emoji}`}
                    title={reactionPillTitle(emoji, msg.reactionNames?.[emoji], count)}
                    onClick={() => onReact(msg.id, emoji)}
                    {...(isMine ? { "data-mine": "true" } : {})}
                    className={cn(
                      "flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border transition-colors",
                      isMine
                        ? "bg-primary/10 hover:bg-primary/15 border-primary/60"
                        : "bg-muted hover:bg-muted/80 border-border/50",
                    )}
                  >
                    {customUrl ? (
                      <img
                        src={customUrl}
                        alt={emoji}
                        title={emoji}
                        className="w-3.5 h-3.5 object-contain rounded-sm"
                      />
                    ) : (
                      <span>{emoji}</span>
                    )}
                    <span className={isMine ? "text-primary font-medium" : "text-muted-foreground"}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {msg.replyCount > 0 && onOpenThread && (
            <button
              onClick={() => onOpenThread(msg)}
              className="flex items-center gap-1 text-xs text-primary-ink hover:underline mt-1"
              data-testid={`thread-count-${msg.id}`}
            >
              <Reply className="h-3 w-3" />
              {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
            </button>
          )}
        </div>

        <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 absolute top-1 right-2 z-10 flex items-center gap-0.5 bg-popover border border-border rounded-md shadow-sm px-0.5 py-0.5 transition-opacity pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
          <div className="relative" ref={emojiRef}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowEmoji((v) => !v)}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  data-testid={`emoji-trigger-${msg.id}`}
                >
                  <Smile className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Add reaction</TooltipContent>
            </Tooltip>
            {showEmoji && !showFullEmojiPicker && (
              <AnchoredPortalPanel
                anchorRef={emojiRef}
                onDismiss={closeEmoji}
                testId={`quick-emoji-panel-${msg.id}`}
              >
                <div className="bg-popover border border-border rounded-lg shadow-md p-2">
                  <div className="flex gap-1 mb-1">
                    {QUICK_EMOJIS.map((e) => (
                      <button
                        key={e}
                        onClick={() => { onReact(msg.id, e); closeEmoji(); }}
                        className="text-lg hover:bg-muted rounded p-1 transition-colors"
                        data-testid={`quick-emoji-${e}`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setShowFullEmojiPicker(true)}
                    className="w-full text-xs text-muted-foreground hover:text-foreground py-1 hover:bg-muted rounded transition-colors"
                  >
                    More emoji…
                  </button>
                </div>
              </AnchoredPortalPanel>
            )}
            {showEmoji && showFullEmojiPicker && (
              <AnchoredPortalPanel
                anchorRef={emojiRef}
                onDismiss={closeEmoji}
                testId={`full-emoji-panel-${msg.id}`}
              >
                <EmojiPicker
                  onSelect={(emoji) => { onReact(msg.id, emoji); closeEmoji(); }}
                  onClose={closeEmoji}
                />
              </AnchoredPortalPanel>
            )}
          </div>
          {onReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onReply(msg)}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  data-testid={`reply-${msg.id}`}
                >
                  <Reply className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reply in thread</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                data-testid={`msg-menu-${msg.id}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isOwn && (
                <DropdownMenuItem onClick={() => onEdit(msg)} data-testid={`edit-msg-${msg.id}`}>
                  <Edit3 className="h-4 w-4 mr-2" /> Edit
                </DropdownMenuItem>
              )}
              {onPin && (
                <DropdownMenuItem onClick={() => onPin(msg.id)} data-testid={`pin-msg-${msg.id}`}>
                  <Pin className="h-4 w-4 mr-2" /> Pin message
                </DropdownMenuItem>
              )}
              {onSave && (
                <DropdownMenuItem onClick={() => onSave(msg.id)} data-testid={`save-msg-${msg.id}`}>
                  <Bookmark className="h-4 w-4 mr-2" /> Save message
                </DropdownMenuItem>
              )}
              {onBookmarkAttachment && msg.attachments && msg.attachments.length > 0 && (
                msg.attachments.map((att) => (
                  <DropdownMenuItem
                    key={`bm-att-${att.id}`}
                    onClick={() => onBookmarkAttachment(att)}
                    data-testid={`bookmark-attachment-${att.id}`}
                  >
                    <BookmarkPlus className="h-4 w-4 mr-2" /> Bookmark "{att.filename ?? "file"}"
                  </DropdownMenuItem>
                ))
              )}
              {onMarkUnread && (
                <DropdownMenuItem onClick={() => onMarkUnread(msg.id)} data-testid={`mark-unread-${msg.id}`}>
                  <EyeOff className="h-4 w-4 mr-2" /> Mark unread from here
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={copyPermalink} data-testid={`permalink-${msg.id}`}>
                <Link className="h-4 w-4 mr-2" /> Copy link
              </DropdownMenuItem>
              {onShowEditHistory && msg.editedAt && (
                <DropdownMenuItem onClick={() => onShowEditHistory(msg)} data-testid={`edit-history-${msg.id}`}>
                  <History className="h-4 w-4 mr-2" /> Edit history
                </DropdownMenuItem>
              )}
              {onRemind && (
                <DropdownMenuItem onClick={() => onRemind(msg)} data-testid={`remind-msg-${msg.id}`}>
                  <Bell className="h-4 w-4 mr-2" /> Remind me
                </DropdownMenuItem>
              )}
              {onForward && (
                <DropdownMenuItem onClick={() => onForward(msg)} data-testid={`forward-msg-${msg.id}`}>
                  <Forward className="h-4 w-4 mr-2" /> Forward
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(msg.id)}
                className="text-destructive"
                data-testid={`delete-msg-${msg.id}`}
              >
                <Trash2 className="h-4 w-4 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </>
  );
}
