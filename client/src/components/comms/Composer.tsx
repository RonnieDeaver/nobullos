import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Send, Smile, Bold, Italic, Code, Paperclip, AtSign, X, Clock, AlertTriangle, Eye, Quote, List, ListOrdered, SquareCode } from "lucide-react";
import { EmojiPicker, useCustomEmojiMap, AnchoredPortalPanel } from "./EmojiPicker";
import { renderContent } from "./helpers";
import { useCommsSelector } from "@/contexts/CommsContext";
import { cn } from "@/lib/utils";

const DRAFT_DEBOUNCE_MS = 500;

// Static list of common standard emoji for `:query` autocomplete in the composer.
// Custom emoji always take priority; these fill remaining slots.
const STANDARD_EMOJI: Array<{ name: string; char: string }> = [
  { name: "thumbsup", char: "👍" }, { name: "thumbsdown", char: "👎" },
  { name: "heart", char: "❤️" }, { name: "smile", char: "😊" },
  { name: "laughing", char: "😄" }, { name: "joy", char: "😂" },
  { name: "sob", char: "😭" }, { name: "fire", char: "🔥" },
  { name: "wave", char: "👋" }, { name: "clap", char: "👏" },
  { name: "eyes", char: "👀" }, { name: "tada", char: "🎉" },
  { name: "rocket", char: "🚀" }, { name: "star", char: "⭐" },
  { name: "check", char: "✅" }, { name: "x", char: "❌" },
  { name: "warning", char: "⚠️" }, { name: "thinking", char: "🤔" },
  { name: "100", char: "💯" }, { name: "muscle", char: "💪" },
  { name: "pray", char: "🙏" }, { name: "ok_hand", char: "👌" },
  { name: "raised_hands", char: "🙌" }, { name: "point_right", char: "👉" },
  { name: "point_left", char: "👈" }, { name: "bulb", char: "💡" },
  { name: "memo", char: "📝" }, { name: "email", char: "📧" },
  { name: "phone", char: "📞" }, { name: "calendar", char: "📅" },
  { name: "chart", char: "📊" }, { name: "lock", char: "🔒" },
  { name: "key", char: "🔑" }, { name: "link", char: "🔗" },
  { name: "hammer", char: "🔨" }, { name: "bug", char: "🐛" },
  { name: "robot", char: "🤖" }, { name: "computer", char: "💻" },
  { name: "coffee", char: "☕" }, { name: "pizza", char: "🍕" },
  { name: "money", char: "💰" }, { name: "boom", char: "💥" },
  { name: "clock", char: "⏰" }, { name: "mega", char: "📣" },
  { name: "bookmark", char: "🔖" }, { name: "pencil", char: "✏️" },
  { name: "sparkles", char: "✨" }, { name: "zap", char: "⚡" },
  { name: "sunglasses", char: "😎" }, { name: "raised_hand", char: "✋" },
];

// ─── Server-synced draft hook ─────────────────────────────────────────────────

// Serializable file metadata stored in draft. When objectKey is present the
// file was pre-uploaded to object storage and can be fully restored on resume.
interface StagedFileInfo {
  name: string;
  size: number;
  type: string;
  objectKey?: string; // present after successful pre-upload
  thumbnailKey?: string; // present when pre-upload generated a 600px webp thumb
  // Client-only: set on restore when the local File bytes are the small
  // thumbnail, not the original — send must NOT upload these bytes raw.
  restoredFromThumb?: boolean;
}

function useServerDraft(
  channelId: string,
  parentId: string | null | undefined,
  onRestored?: (content: string, stagedFiles: StagedFileInfo[]) => void,
) {
  // Narrow store subscriptions (Task #3848): both are stable callbacks, so
  // busy SSE activity elsewhere never re-renders the composer through them.
  const refetchDrafts = useCommsSelector((s) => s.refetchDrafts);
  const addSseListener = useCommsSelector((s) => s.addSseListener);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string | null>(null);
  const hasRestored = useRef(false);
  // Keep a stable ref so the SSE handler always calls the latest callback.
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;

  // Load draft on mount (or channel switch).
  useEffect(() => {
    if (hasRestored.current) return;
    const url = `/api/comms/channels/${channelId}/draft${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ""}`;
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((draft) => {
        if (draft && draft.content && !hasRestored.current) {
          hasRestored.current = true;
          const staged: StagedFileInfo[] = Array.isArray(draft.metadata?.attachments)
            ? draft.metadata.attachments
            : [];
          const metaFp = staged.map((f) => f.objectKey ?? f.name).join(",");
          lastSaved.current = `${draft.content}||${metaFp}`;
          onRestoredRef.current?.(draft.content, staged);
        }
      })
      .catch(() => {});
    return () => {
      hasRestored.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, parentId]);

  // Live cross-session sync — re-fetch and notify when another session saves/
  // clears this exact draft (matched by channelId + parentId).
  useEffect(() => {
    const unsub = addSseListener((e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "comms:draft") return;
        if (data.channelId !== channelId) return;
        const myParent = parentId ?? null;
        const evParent = data.parentId ?? null;
        if (myParent !== evParent) return;
        const url = `/api/comms/channels/${channelId}/draft${myParent ? `?parentId=${encodeURIComponent(myParent)}` : ""}`;
        fetch(url, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then((draft) => {
            const content = draft?.content ?? "";
            const staged: StagedFileInfo[] = Array.isArray(draft?.metadata?.attachments)
              ? draft.metadata.attachments
              : [];
            onRestoredRef.current?.(content, staged);
          })
          .catch(() => {});
      } catch {}
    });
    return unsub;
  }, [channelId, parentId, addSseListener]);

  // files: StagedFileInfo[] — metadata already serialisable (no File objects).
  const saveDraft = useCallback(
    (content: string, files: StagedFileInfo[] = []) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(async () => {
        // Include attachment fingerprint so a file-only change (text unchanged)
        // is not silently deduplicated.
        const metaFp = files.map((f) => f.objectKey ?? f.name).join(",");
        const changeKey = `${content}||${metaFp}`;
        if (changeKey === lastSaved.current) return;
        lastSaved.current = changeKey;
        try {
          await fetch(`/api/comms/channels/${channelId}/draft`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              content,
              parentId: parentId ?? null,
              metadata: files.length > 0 ? { attachments: files } : null,
            }),
          });
          refetchDrafts();
        } catch {
          // Best-effort — fall back to localStorage
          try {
            if (content) localStorage.setItem(`comms_draft_${channelId}`, content);
            else localStorage.removeItem(`comms_draft_${channelId}`);
          } catch {}
        }
      }, DRAFT_DEBOUNCE_MS);
    },
    [channelId, parentId, refetchDrafts],
  );

  const clearDraft = useCallback(async () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    lastSaved.current = "";
    try {
      await fetch(`/api/comms/channels/${channelId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: "", parentId: parentId ?? null, metadata: null }),
      });
      refetchDrafts();
    } catch {
      try { localStorage.removeItem(`comms_draft_${channelId}`); } catch {}
    }
  }, [channelId, parentId, refetchDrafts]);

  return { saveDraft, clearDraft };
}

// ─── Schedule-send dialog ─────────────────────────────────────────────────────

// Build a datetime-local string (no seconds, local timezone) for a given Date.
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SCHEDULE_PRESETS = [
  {
    label: "In 1 hour",
    make: () => {
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setSeconds(0, 0);
      return d;
    },
  },
  {
    label: "Tomorrow 9 am",
    make: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next Monday 9 am",
    make: () => {
      const d = new Date();
      const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
      d.setDate(d.getDate() + daysUntilMonday);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
] as const;

function ScheduleDialog({
  open,
  onClose,
  onConfirm,
  initialValue,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (scheduledFor: Date) => void;
  initialValue?: string;
}) {
  const defaultTime = () => {
    if (initialValue) return initialValue;
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    return toDatetimeLocal(d);
  };
  const [value, setValue] = useState(defaultTime);

  useEffect(() => {
    if (open) setValue(initialValue ?? defaultTime());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleConfirm = () => {
    const d = new Date(value);
    if (isNaN(d.getTime()) || d <= new Date()) return;
    onConfirm(d);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Schedule Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex flex-wrap gap-2">
            {SCHEDULE_PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setValue(toDatetimeLocal(p.make()))}
                type="button"
                data-testid={`schedule-preset-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="space-y-1">
            <input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={toDatetimeLocal(new Date())}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="schedule-datetime-input"
            />
            <p className="text-xs text-muted-foreground">{tzName}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!value || new Date(value) <= new Date()}
              data-testid="schedule-confirm-button"
            >
              Schedule
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── @channel / @here confirmation dialog ────────────────────────────────────

const BROADCAST_CONFIRM_THRESHOLD = 10;

function BroadcastConfirmDialog({
  open,
  mention,
  memberCount,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  mention: "@channel" | "@here";
  memberCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const audience =
    mention === "@here"
      ? "online members"
      : `all ${memberCount} members`;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Notify {mention}?
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <p className="text-sm text-muted-foreground">
            This will send a notification to{" "}
            <span className="font-semibold text-foreground">{audience}</span> in this
            channel.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} data-testid="broadcast-cancel">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              data-testid="broadcast-confirm"
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Yes, notify {mention}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Slash command definitions ────────────────────────────────────────────────

interface SlashCommand {
  command: string;
  argHint: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/status", argHint: "[online|away|dnd|offline]", description: "Set your status" },
  { command: "/online", argHint: "", description: "Set status to Online" },
  { command: "/away", argHint: "", description: "Set status to Away" },
  { command: "/dnd", argHint: "[duration]", description: "Set Do Not Disturb" },
  { command: "/shrug", argHint: "[message]", description: "Append ¯\\_(ツ)_/¯ to message" },
  { command: "/me", argHint: "[action]", description: "Post an action message" },
  { command: "/search", argHint: "[query]", description: "Search messages in this channel" },
  { command: "/mute", argHint: "", description: "Mute notifications for this channel" },
  { command: "/unmute", argHint: "", description: "Unmute notifications for this channel" },
  { command: "/leave", argHint: "", description: "Leave this channel" },
  { command: "/help", argHint: "", description: "Show available commands" },
];

function matchSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const lower = input.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.command.startsWith(lower));
}

// ─── @ mention suggestions ────────────────────────────────────────────────────

interface AtMentionSuggestion {
  label: string;
  value: string;
  description: string;
}

const SPECIAL_MENTIONS: AtMentionSuggestion[] = [
  { label: "@channel", value: "@channel", description: "Notify all members" },
  { label: "@here", value: "@here", description: "Notify online members" },
];

/**
 * Returns @-mention suggestions given the current text and cursor position.
 * Looks for the last `@` before the cursor with no space after it.
 */
function getAtMentionMatches(text: string, cursorPos: number): AtMentionSuggestion[] {
  const before = text.slice(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1) return [];
  const fragment = before.slice(atIdx + 1); // text after the @
  if (fragment.includes(" ")) return []; // space = mention already complete
  const lower = fragment.toLowerCase();
  return SPECIAL_MENTIONS.filter(
    (s) =>
      s.value.toLowerCase().startsWith("@" + lower) ||
      s.value.toLowerCase().slice(1).startsWith(lower),
  );
}

// ─── Ephemeral message (only you see it) ─────────────────────────────────────

interface EphemeralMsg {
  id: string;
  text: string;
}

// ─── Composer ─────────────────────────────────────────────────────────────────

export function Composer({
  channelId,
  placeholder,
  parentId,
  onSent,
  compact = false,
}: {
  channelId: string;
  placeholder: string;
  parentId?: string | null;
  onSent?: () => void;
  compact?: boolean;
}) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [atMatches, setAtMatches] = useState<AtMentionSuggestion[]>([]);
  const [atHighlight, setAtHighlight] = useState(0);
  // `:query` emoji autocomplete — includes custom (imageUrl) and standard (char)
  const [emojiMatches, setEmojiMatches] = useState<Array<{ name: string; imageUrl?: string; char?: string }>>([]);
  const [emojiHighlight, setEmojiHighlight] = useState(0);
  const [ephemeralMsgs, setEphemeralMsgs] = useState<EphemeralMsg[]>([]);
  // Broadcast confirm state
  const [broadcastPending, setBroadcastPending] = useState<"@channel" | "@here" | null>(null);
  const [channelMemberCount, setChannelMemberCount] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiAnchorRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();
  // Custom emoji map for `:query` autocomplete
  const customEmojiMap = useCustomEmojiMap();

  const [pendingFileMeta, setPendingFileMeta] = useState<StagedFileInfo[]>([]);
  const [restoredAttachments, setRestoredAttachments] = useState<StagedFileInfo[]>([]);

  // Object URLs for image previews in the pending-attachment chips. For
  // restored drafts these bytes are the small 600px webp thumbnail (fast),
  // falling back to the original when no thumbnail exists.
  const pendingFilePreviews = useMemo(
    () =>
      pendingFiles.map((f) =>
        f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
      ),
    [pendingFiles],
  );
  useEffect(() => {
    return () => {
      pendingFilePreviews.forEach((u) => {
        if (u) URL.revokeObjectURL(u);
      });
    };
  }, [pendingFilePreviews]);

  const { saveDraft, clearDraft } = useServerDraft(
    channelId,
    parentId,
    async (restored, stagedFiles) => {
      if (restored !== undefined) setContent(restored);
      if (stagedFiles.length === 0) { setRestoredAttachments([]); return; }
      // Partition: files with objectKey can be downloaded; without fall back to advisory.
      const restorable = stagedFiles.filter((f) => !!f.objectKey);
      const nonRestorable = stagedFiles.filter((f) => !f.objectKey);
      if (restorable.length > 0) {
        const results = await Promise.all(
          restorable.map(async (meta) => {
            try {
              // Prefer the small pre-generated thumbnail for restore — it's a
              // fast preview-sized download. Send still promotes the original
              // via draftObjectKey, so full-size bytes are never needed here.
              if (meta.thumbnailKey) {
                try {
                  const thumbResp = await fetch(
                    `/api/comms/attachments/${meta.thumbnailKey}`,
                    { credentials: "include" },
                  );
                  if (thumbResp.ok) {
                    const thumbBytes = await thumbResp.arrayBuffer();
                    return {
                      file: new File([thumbBytes], meta.name, { type: "image/webp" }),
                      meta: { ...meta, restoredFromThumb: true },
                    };
                  }
                } catch { /* fall through to full-size original */ }
              }
              const resp = await fetch(
                `/api/comms/attachments/${meta.objectKey}`,
                { credentials: "include" },
              );
              if (!resp.ok) throw new Error("fetch failed");
              const bytes = await resp.arrayBuffer();
              return { file: new File([bytes], meta.name, { type: meta.type }), meta };
            } catch {
              return null;
            }
          }),
        );
        const ok = results.filter((r): r is { file: File; meta: StagedFileInfo } => r !== null);
        if (ok.length > 0) {
          setPendingFiles((prev) => [...prev, ...ok.map((r) => r.file)]);
          setPendingFileMeta((prev) => [...prev, ...ok.map((r) => r.meta)]);
        }
        const failed = restorable.filter((_, i) => results[i] === null);
        setRestoredAttachments([...failed, ...nonRestorable]);
      } else {
        setRestoredAttachments(nonRestorable);
      }
    },
  );

  const channelKey = parentId
    ? `/api/comms/channels/${channelId}/messages?parentId=${parentId}`
    : `/api/comms/channels/${channelId}/messages`;

  // ── SSE: invalidate message list when link previews arrive ──────────────────
  const addSseListener = useCommsSelector((s) => s.addSseListener);
  useEffect(() => {
    return addSseListener((e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "comms:link_preview") return;
        if (data.channelId !== channelId) return;
        void qc.invalidateQueries({ queryKey: [channelKey] }); // fire-and-forget: cache refresh only
      } catch {}
    });
  }, [channelId, channelKey, addSseListener, qc]);

  // ── Fetch channel stats lazily for broadcast confirmation ───────────────────
  useEffect(() => {
    fetch(`/api/comms/channels/${channelId}/stats`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.memberCount) setChannelMemberCount(d.memberCount); })
      .catch(() => {});
  }, [channelId]);

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      fetch(`/api/comms/channels/${channelId}/typing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isTyping }),
      }).catch(() => {});
    },
    [channelId],
  );

  const addEphemeral = (text: string) => {
    const id = String(Date.now());
    setEphemeralMsgs((prev) => [...prev, { id, text }]);
    setTimeout(() => setEphemeralMsgs((prev) => prev.filter((m) => m.id !== id)), 8000);
  };

  /**
   * Detect `:query` emoji autocomplete: text before cursor ends with `:xx` (2+ chars, no space).
   * Returns the query fragment or null.
   */
  function getEmojiQuery(text: string, cursorPos: number): string | null {
    const before = text.slice(0, cursorPos);
    const colonIdx = before.lastIndexOf(":");
    if (colonIdx === -1) return null;
    const fragment = before.slice(colonIdx + 1);
    if (fragment.length < 2) return null;
    if (/\s/.test(fragment)) return null; // space = colon already closed or unrelated
    return fragment.toLowerCase();
  }

  /**
   * Complete a `:query` emoji autocomplete:
   * - Standard emoji: replace `:fragment` with the bare Unicode character
   * - Custom emoji: replace `:fragment` with `:name: ` (rendered by renderContent)
   */
  const selectEmojiSuggestion = (suggestion: { name: string; char?: string; imageUrl?: string }) => {
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? content.length;
    const before = content.slice(0, cursor);
    const colonIdx = before.lastIndexOf(":");
    // Standard emoji inserts the char directly; custom inserts the :name: token
    const insertion = suggestion.char ? `${suggestion.char} ` : `:${suggestion.name}: `;
    const newContent = content.slice(0, colonIdx) + insertion + content.slice(cursor);
    setContent(newContent);
    setEmojiMatches([]);
    saveDraft(newContent, pendingFileMeta);
    const newCursor = colonIdx + insertion.length;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(newCursor, newCursor);
    });
  };

  const handleChange = (val: string) => {
    setContent(val);
    saveDraft(val, pendingFileMeta);
    // Slash autocomplete (only on leading /)
    const trimmed = val.trimStart();
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      const matches = matchSlashCommands(trimmed);
      setSlashMatches(matches);
      setSlashHighlight(0);
      setAtMatches([]);
      setEmojiMatches([]);
    } else {
      setSlashMatches([]);
      const cursor = textareaRef.current?.selectionStart ?? val.length;
      // @-mention autocomplete
      const atMentions = getAtMentionMatches(val, cursor);
      setAtMatches(atMentions);
      setAtHighlight(0);
      // `:query` emoji autocomplete: merge custom + common standard emoji
      if (atMentions.length === 0) {
        const q = getEmojiQuery(val, cursor);
        if (q) {
          const customResults = Object.entries(customEmojiMap)
            .filter(([name]) => name.toLowerCase().includes(q))
            .map(([name, imageUrl]) => ({ name, imageUrl }));
          const standardResults = STANDARD_EMOJI
            .filter((e) => e.name.includes(q) && !customResults.some((c) => c.name === e.name))
            .map(({ name, char }) => ({ name, char }));
          setEmojiMatches([...customResults, ...standardResults].slice(0, 10));
          setEmojiHighlight(0);
        } else {
          setEmojiMatches([]);
        }
      } else {
        setEmojiMatches([]);
      }
    }
    if (val) {
      sendTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => sendTyping(false), 3000);
    }
  };

  const insertFormat = (before: string, after: string = before) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.slice(start, end);
    const newContent =
      content.slice(0, start) + before + selected + after + content.slice(end);
    setContent(newContent);
    saveDraft(newContent);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  /**
   * Prefix every line touched by the current selection with a block marker
   * ("> ", "- ", or "1. " / "2. " / ... for ordered lists). The selection is
   * expanded to full line boundaries first so multi-line selections get each
   * line prefixed. Cursor/selection is restored over the same text afterwards.
   */
  const insertLinePrefix = (prefix: string, ordered = false) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = content.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = content.length;
    const block = content.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const prefixed = lines.map((line, i) =>
      (ordered ? `${i + 1}. ` : prefix) + line,
    );
    const newBlock = prefixed.join("\n");
    const newContent =
      content.slice(0, lineStart) + newBlock + content.slice(lineEnd);
    setContent(newContent);
    saveDraft(newContent);
    const added = newBlock.length - block.length;
    const firstPrefixLen = ordered ? 3 : prefix.length;
    requestAnimationFrame(() => {
      ta.focus();
      if (start === end) {
        const newCursor = start + firstPrefixLen;
        ta.setSelectionRange(newCursor, newCursor);
      } else {
        ta.setSelectionRange(start + firstPrefixLen, end + added);
      }
    });
  };

  /**
   * Wrap the current selection in a fenced code block. With no selection,
   * inserts an empty fence and places the cursor on the blank middle line.
   */
  const insertCodeBlock = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.slice(start, end);
    const needsLeadingNewline = start > 0 && content[start - 1] !== "\n";
    const lead = needsLeadingNewline ? "\n" : "";
    const inner = selected || "";
    const insertion = `${lead}\`\`\`\n${inner}\n\`\`\`\n`;
    const newContent = content.slice(0, start) + insertion + content.slice(end);
    setContent(newContent);
    saveDraft(newContent);
    const innerStart = start + lead.length + 4;
    requestAnimationFrame(() => {
      ta.focus();
      if (selected) {
        ta.setSelectionRange(innerStart, innerStart + inner.length);
      } else {
        ta.setSelectionRange(innerStart, innerStart);
      }
    });
  };

  const insertText = (text: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const newContent = content.slice(0, start) + text + content.slice(start);
    setContent(newContent);
    saveDraft(newContent);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + text.length, start + text.length);
    });
  };

  /**
   * Complete an @-mention suggestion: replace the `@fragment` before cursor
   * with the chosen value + trailing space.
   */
  const selectAtMention = (suggestion: AtMentionSuggestion) => {
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? content.length;
    const before = content.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    const newContent =
      content.slice(0, atIdx) + suggestion.value + " " + content.slice(cursor);
    setContent(newContent);
    setAtMatches([]);
    saveDraft(newContent, pendingFileMeta);
    const newCursor = atIdx + suggestion.value.length + 1;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(newCursor, newCursor);
    });
  };

  const selectSlashCommand = (cmd: SlashCommand) => {
    setContent(cmd.command + " ");
    setSlashMatches([]);
    textareaRef.current?.focus();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const MAX_SIZE = 25 * 1024 * 1024;
    const valid = files.filter((f) => {
      if (f.size > MAX_SIZE) {
        alert(`${f.name} exceeds the 25 MB limit.`);
        return false;
      }
      return true;
    });
    if (valid.length === 0) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    // Pre-upload each file to object storage so drafts can be fully restored.
    setUploading(true);
    try {
      const results = await Promise.all(
        valid.map(async (file) => {
          const meta: StagedFileInfo = { name: file.name, size: file.size, type: file.type };
          try {
            const fd = new FormData();
            fd.append("file", file);
            const resp = await fetch(
              `/api/comms/channels/${channelId}/draft/attachments`,
              { method: "POST", body: fd, credentials: "include" },
            );
            if (resp.ok) {
              const data = await resp.json();
              meta.objectKey = data.objectKey;
              if (data.thumbnailKey) meta.thumbnailKey = data.thumbnailKey;
            }
          } catch { /* pre-upload optional — file still staged in memory */ }
          return { file, meta };
        }),
      );
      const newFiles = results.map((r) => r.file);
      const newMetas = results.map((r) => r.meta);
      setPendingFiles((prev) => [...prev, ...newFiles]);
      setPendingFileMeta((prev) => {
        const next = [...prev, ...newMetas];
        saveDraft(content, next);
        return next;
      });
    } finally {
      setUploading(false);
    }
  };

  const removeFile = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
    setPendingFileMeta((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      saveDraft(content, next);
      return next;
    });
  };

  const handleSlashDispatch = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;
    const spaceIdx = trimmed.indexOf(" ");
    const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

    // /search is handled client-side for now
    if (command === "/search") {
      addEphemeral(`Search is not yet available in this view. Use the global search bar.`);
      return true;
    }

    try {
      const resp = await apiRequest("POST", `/api/comms/channels/${channelId}/slash`, {
        command,
        args,
      });
      const data = await resp.json();
      if (data.ephemeral) {
        addEphemeral(data.text);
      } else if (data.left) {
        // Channel left — navigate away (best-effort)
        window.dispatchEvent(new CustomEvent("comms:left-channel", { detail: { channelId } }));
      } else if (resp.ok) {
        // Status-change or silent success — optionally show ephemeral
        if (data.status) {
          addEphemeral(`Status set to ${data.status}.`);
        }
      } else {
        addEphemeral(data.error ?? "Command failed.");
      }
    } catch {
      addEphemeral("Could not reach server. Please try again.");
    }
    return true;
  };

  /** Core send logic — called after any broadcast confirmation is resolved. */
  const doSend = async (trimmed: string) => {
    setSending(true);
    try {
      let messageId: string | null = null;

      if (pendingFiles.length > 0) {
        setUploading(true);
        const uploadUrl = `/api/comms/channels/${channelId}/messages/upload`;
        for (let i = 0; i < pendingFiles.length; i++) {
          const file = pendingFiles[i];
          const meta = pendingFileMeta[i];

          const uploadRaw = async (): Promise<Response> => {
            const fd = new FormData();
            fd.append("file", file);
            if (i === 0) {
              fd.append("content", trimmed || " ");
              if (parentId) fd.append("parentId", parentId);
            } else {
              fd.append("messageId", messageId!);
            }
            return fetch(uploadUrl, { method: "POST", body: fd });
          };

          let resp: Response;
          if (meta?.objectKey) {
            // File was pre-uploaded through the draft flow — promote the
            // stored object server-side (runs the thumbnail pipeline there)
            // instead of re-uploading the bytes from the browser.
            resp = await fetch(uploadUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                draftObjectKey: meta.objectKey,
                filename: meta.name,
                contentType: meta.type,
                ...(i === 0
                  ? { content: trimmed || " ", parentId: parentId ?? null }
                  : { messageId }),
              }),
            });
            // Draft object may have expired/been cleaned up — fall back to
            // uploading the in-memory bytes. Only for "object gone" statuses;
            // other failures (auth, validation, server errors) surface below.
            // When the local bytes are only the small restore thumbnail, the
            // original is gone too — surface the failure instead of silently
            // sending a downscaled webp masquerading as the original file.
            if (resp.status === 404 || resp.status === 410) {
              if (meta?.restoredFromThumb) {
                throw new Error(
                  `Draft attachment "${meta.name}" has expired — please re-attach it.`,
                );
              }
              resp = await uploadRaw();
            }
          } else {
            resp = await uploadRaw();
          }
          if (!resp.ok) throw new Error(await resp.text());
          const data = await resp.json();
          if (i === 0) messageId = data.message?.id;
        }
        setUploading(false);
      } else {
        const resp = await apiRequest("POST", `/api/comms/channels/${channelId}/messages`, {
          content: trimmed,
          parentId: parentId ?? null,
        });
        if (!resp.ok) throw new Error(await resp.text());
      }

      setContent("");
      setSlashMatches([]);
      setAtMatches([]);
      setEmojiMatches([]);
      setPendingFiles([]);
      setPendingFileMeta([]);
      setRestoredAttachments([]);
      await clearDraft();
      void qc.invalidateQueries({ queryKey: [channelKey] }); // fire-and-forget: cache refresh only
      onSent?.();
    } catch (err: any) {
      console.error("[Comms] Send error:", err?.message);
    } finally {
      setSending(false);
      setUploading(false);
    }
  };

  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    if (sending || uploading) return;

    // Slash command intercept
    if (trimmed.startsWith("/") && pendingFiles.length === 0) {
      const handled = await handleSlashDispatch(trimmed);
      if (handled) {
        setContent("");
        setSlashMatches([]);
        return;
      }
    }

    // @channel / @here confirmation guard
    const broadcastMatch = trimmed.match(/@channel|@here/);
    if (broadcastMatch && channelMemberCount >= BROADCAST_CONFIRM_THRESHOLD) {
      setBroadcastPending(broadcastMatch[0] as "@channel" | "@here");
      return; // wait for user confirmation
    }

    await doSend(trimmed);
  };

  const handleSchedule = async (scheduledFor: Date) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    setScheduling(true);
    try {
      const resp = await apiRequest("POST", `/api/comms/channels/${channelId}/scheduled-messages`, {
        content: trimmed,
        scheduledFor: scheduledFor.toISOString(),
        parentId: parentId ?? null,
      });
      if (!resp.ok) throw new Error(await resp.text());
      setContent("");
      setPendingFileMeta([]);
      await clearDraft();
      void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channelId}/scheduled-messages`] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
    } catch (err: any) {
      console.error("[Comms] Schedule error:", err?.message);
    } finally {
      setScheduling(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Navigate emoji autocomplete with arrow keys
    if (emojiMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEmojiHighlight((h) => (h + 1) % emojiMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEmojiHighlight((h) => (h - 1 + emojiMatches.length) % emojiMatches.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        selectEmojiSuggestion(emojiMatches[emojiHighlight]);
        return;
      }
      if (e.key === "Escape") {
        setEmojiMatches([]);
        return;
      }
    }
    // Navigate @-mention autocomplete with arrow keys
    if (atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtHighlight((h) => (h + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtHighlight((h) => (h - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && atMatches.length > 0)) {
        e.preventDefault();
        selectAtMention(atMatches[atHighlight]);
        return;
      }
      if (e.key === "Escape") {
        setAtMatches([]);
        return;
      }
    }
    // Navigate slash autocomplete with arrow keys
    if (slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashHighlight((h) => (h + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashHighlight((h) => (h - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && slashMatches.length > 0)) {
        e.preventDefault();
        selectSlashCommand(slashMatches[slashHighlight]);
        return;
      }
      if (e.key === "Escape") {
        setSlashMatches([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend(); // fire-and-forget: send flow handles its own errors internally
    }
  };

  const isBusy = sending || uploading || scheduling;

  return (
    <div className={compact ? "px-2 pb-2 pt-1 border-t border-border bg-background" : "p-3 border-t border-border bg-background"}>
      {restoredAttachments.length > 0 && (
        <div className="flex items-start gap-2 mb-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800">
          <Paperclip className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Draft had {restoredAttachments.length} staged {restoredAttachments.length === 1 ? "file" : "files"} (
            {restoredAttachments.map((f) => f.name).join(", ")}
            ) — please re-attach before sending.
          </span>
          <button
            className="ml-auto flex-shrink-0 text-amber-600 hover:text-amber-800"
            onClick={() => setRestoredAttachments([])}
            type="button"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {/* Ephemeral messages */}
      {ephemeralMsgs.length > 0 && (
        <div className="mb-2 space-y-1">
          {ephemeralMsgs.map((m) => (
            <div
              key={m.id}
              className="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-300"
              data-testid="ephemeral-message"
            >
              <span className="font-medium">Only you can see this:</span>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* Custom emoji `:query` autocomplete popover */}
      {emojiMatches.length > 0 && (
        <div
          className="mb-2 bg-popover border border-border rounded-lg shadow-md overflow-hidden"
          data-testid="emoji-autocomplete"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium border-b border-border">
            Emoji
          </div>
          {emojiMatches.map((e, idx) => (
            <button
              key={e.name}
              onMouseDown={(ev) => { ev.preventDefault(); selectEmojiSuggestion(e); }}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors",
                idx === emojiHighlight && "bg-muted",
              )}
              data-testid={`emoji-autocomplete-option-${e.name}`}
              type="button"
            >
              {e.imageUrl ? (
                <img src={e.imageUrl} alt={`:${e.name}:`} className="w-5 h-5 object-contain rounded-sm flex-shrink-0" />
              ) : (
                <span className="w-5 h-5 flex items-center justify-center text-lg leading-none flex-shrink-0">{e.char}</span>
              )}
              <span className="font-medium text-foreground">
                {e.char ? e.char : `:${e.name}:`}
                <span className="ml-1.5 text-muted-foreground font-normal">:{e.name}:</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {/* @-mention autocomplete popover */}
      {atMatches.length > 0 && (
        <div
          className="mb-2 bg-popover border border-border rounded-lg shadow-md overflow-hidden"
          data-testid="at-mention-autocomplete"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium border-b border-border">
            Mentions
          </div>
          {atMatches.map((s, idx) => (
            <button
              key={s.value}
              onMouseDown={(e) => { e.preventDefault(); selectAtMention(s); }}
              className={cn(
                "w-full flex items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors",
                idx === atHighlight && "bg-muted",
              )}
              data-testid={`at-mention-option-${s.value.slice(1)}`}
              type="button"
            >
              <span className="font-semibold text-primary-ink shrink-0">{s.label}</span>
              <span className="text-muted-foreground text-xs truncate">{s.description}</span>
            </button>
          ))}
        </div>
      )}
      {/* Slash autocomplete popover */}
      {slashMatches.length > 0 && (
        <div
          className="mb-2 bg-popover border border-border rounded-lg shadow-md overflow-hidden"
          data-testid="slash-autocomplete"
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium border-b border-border">
            Commands
          </div>
          {slashMatches.map((cmd, idx) => (
            <button
              key={cmd.command}
              onClick={() => selectSlashCommand(cmd)}
              className={cn(
                "w-full flex items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors",
                idx === slashHighlight && "bg-muted",
              )}
              data-testid={`slash-option-${cmd.command.slice(1)}`}
              type="button"
            >
              <span className="font-mono font-semibold text-primary-ink shrink-0">{cmd.command}</span>
              {cmd.argHint && (
                <span className="text-muted-foreground font-mono text-xs shrink-0">{cmd.argHint}</span>
              )}
              <span className="text-muted-foreground text-xs truncate">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2 px-1">
          {pendingFiles.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-1 bg-muted rounded px-2 py-1 text-xs max-w-[180px]"
              data-testid={`pending-attachment-${i}`}
            >
              {pendingFilePreviews[i] && (
                <img
                  src={pendingFilePreviews[i]!}
                  alt=""
                  className="h-8 w-8 rounded object-cover flex-shrink-0"
                  data-testid={`pending-attachment-preview-${i}`}
                />
              )}
              <span className="truncate">{f.name}</span>
              <button onClick={() => removeFile(i)} className="flex-shrink-0 text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Live formatting preview — uses the shared renderContent so it always
          matches how recipients will see the message. */}
      {showPreview && (
        <div
          className={cn(
            "mb-2 rounded-lg border border-border bg-muted/30",
            // Compact composers (thread replies, popups) have very little
            // vertical room — tighten padding and cap the preview height so
            // it scrolls instead of crowding the message list out of view.
            compact ? "px-2 py-1.5 max-h-24 overflow-y-auto" : "px-3 py-2",
          )}
          data-testid="composer-preview"
        >
          <div className="text-caption uppercase tracking-wide text-muted-foreground font-medium mb-1">
            Preview
          </div>
          {content.trim() ? (
            <div className="text-sm break-words" data-testid="composer-preview-content">
              {renderContent(content, undefined, customEmojiMap)}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic" data-testid="composer-preview-empty">
              Start typing to see how your message will look…
            </p>
          )}
        </div>
      )}
      {/* Mobile (<sm): the row wraps — the textarea takes the full first row and
          the toolbar drops to a second row below it, so typing space is never
          squeezed by the ~12 icon buttons (Task #4444). Desktop (sm+) keeps the
          original single-row inline layout. */}
      <div className="flex flex-wrap sm:flex-nowrap gap-2 items-end rounded-lg border border-border bg-muted/20 p-2">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 basis-full sm:basis-0 resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[36px] max-h-[120px] text-sm p-1"
          rows={1}
          data-testid="comms-composer-input"
        />
        <div className="flex items-center gap-0.5 flex-shrink-0 w-full justify-end sm:w-auto sm:justify-start">
          {/* Trimmed toolbar in compact mode (thread replies, popups): keep the
              formatting insertion buttons so the preview toggle isn't the only
              formatting affordance, but drop @channel / attach / schedule to
              save horizontal space. Decision documented in COMMS.md. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => insertFormat("**", "**")}
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Bold"
                data-testid="format-bold"
                type="button"
              >
                <Bold className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Bold</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => insertFormat("*", "*")}
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Italic"
                data-testid="format-italic"
                type="button"
              >
                <Italic className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Italic</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => insertFormat("`", "`")}
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Inline code"
                data-testid="format-code"
                type="button"
              >
                <Code className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Inline code</TooltipContent>
          </Tooltip>
          {!compact && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => insertLinePrefix("> ")}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Blockquote"
                    data-testid="format-blockquote"
                    type="button"
                  >
                    <Quote className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Blockquote</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => insertLinePrefix("- ")}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Bullet list"
                    data-testid="format-bullet-list"
                    type="button"
                  >
                    <List className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Bullet list</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => insertLinePrefix("", true)}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Numbered list"
                    data-testid="format-numbered-list"
                    type="button"
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Numbered list</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={insertCodeBlock}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Code block"
                    data-testid="format-code-block"
                    type="button"
                  >
                    <SquareCode className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Code block</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => insertText("@channel ")}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Notify channel"
                    data-testid="mention-channel"
                    type="button"
                  >
                    <AtSign className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Notify @channel</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Attach file"
                    data-testid="attach-file"
                    type="button"
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Attach file</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowSchedule(true)}
                    className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Schedule send"
                    data-testid="schedule-send-trigger"
                    type="button"
                    disabled={!content.trim() || isBusy}
                  >
                    <Clock className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Schedule send</TooltipContent>
              </Tooltip>
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setShowPreview((v) => !v)}
                className={cn(
                  "h-7 w-7 flex items-center justify-center rounded hover:bg-muted",
                  showPreview
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-label="Preview formatting"
                data-testid="toggle-preview"
                type="button"
                aria-pressed={showPreview}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{showPreview ? "Hide preview" : "Preview formatting"}</TooltipContent>
          </Tooltip>
          <div className="relative" ref={emojiAnchorRef}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowEmoji((v) => !v)}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  aria-label="Add emoji"
                  data-testid="emoji-trigger-composer"
                  type="button"
                >
                  <Smile className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Emoji</TooltipContent>
            </Tooltip>
            {showEmoji && (
              <AnchoredPortalPanel
                anchorRef={emojiAnchorRef}
                onDismiss={() => setShowEmoji(false)}
                testId="composer-emoji-panel"
              >
                <EmojiPicker
                  onSelect={(emoji) => insertText(emoji)}
                  onClose={() => setShowEmoji(false)}
                />
              </AnchoredPortalPanel>
            )}
          </div>
          <Button
            size="sm"
            onClick={handleSend}
            disabled={(!content.trim() && pendingFiles.length === 0) || isBusy}
            className="h-7 px-2 ml-1"
            aria-label="Send message"
            data-testid="comms-send-button"
            type="button"
          >
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground mt-1 px-1">
          Enter to send · Shift+Enter for newline · **bold** · *italic* · `code` · / commands · @ mentions · :name: emoji
        </p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        data-testid="file-input"
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
      />
      <ScheduleDialog
        open={showSchedule}
        onClose={() => setShowSchedule(false)}
        onConfirm={handleSchedule}
      />
      {broadcastPending && (
        <BroadcastConfirmDialog
          open
          mention={broadcastPending}
          memberCount={channelMemberCount}
          onConfirm={async () => {
            const trimmed = content.trim();
            setBroadcastPending(null);
            await doSend(trimmed);
          }}
          onCancel={() => setBroadcastPending(null)}
        />
      )}
    </div>
  );
}
