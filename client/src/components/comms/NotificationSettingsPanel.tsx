/**
 * NotificationSettingsPanel — per-user comms notification preferences.
 *
 * Covers:
 *   • Global default (all / mentions-only / nothing)
 *   • Sound on/off + sound choice (default / ding / subtle)
 *   • Desktop browser notifications toggle (with permission request)
 *   • Keyword watch list (add / remove)
 *   • Do Not Disturb is controlled from UserStatusPicker, shown here read-only
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Keyboard, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  getNotificationPermission,
  requestNotificationPermission,
  getSoundPlaybackState,
  subscribeSoundPlaybackState,
  playNotificationSound,
  type SoundPlaybackState,
} from "./useDesktopNotifications";
import type { CommsUserNotificationSettings } from "./types";

interface Props {
  settings: CommsUserNotificationSettings;
  onSave: (patch: Partial<CommsUserNotificationSettings>) => Promise<void>;
  saving: boolean;
  isDndActive: boolean;
}

export function NotificationSettingsPanel({ settings, onSave, saving, isDndActive }: Props) {
  const [desktopPerm, setDesktopPerm] = useState<NotificationPermission>(() =>
    getNotificationPermission(),
  );
  const [kwInput, setKwInput] = useState("");
  const kwInputRef = useRef<HTMLInputElement>(null);

  // Refresh permission state when the panel is shown
  useEffect(() => {
    setDesktopPerm(getNotificationPermission());
  }, []);

  // Track sound playback support (Web Audio may be blocked until a user gesture)
  const [soundState, setSoundState] = useState<SoundPlaybackState>(() =>
    getSoundPlaybackState(),
  );
  useEffect(() => {
    const refresh = () => setSoundState(getSoundPlaybackState());
    refresh();
    const unsub = subscribeSoundPlaybackState(refresh);
    // A user gesture anywhere may unlock audio; re-check on interaction too.
    window.addEventListener("pointerdown", refresh);
    return () => {
      unsub();
      window.removeEventListener("pointerdown", refresh);
    };
  }, []);

  const handleTestSound = useCallback(() => {
    playNotificationSound(settings.soundChoice);
    // The click itself is a user gesture — playback state may have just changed.
    setSoundState(getSoundPlaybackState());
  }, [settings.soundChoice]);

  // ─── Global default ──────────────────────────────────────────────────────────
  const handleGlobalDefault = useCallback(
    (val: string) => {
      void onSave({ globalDefault: val as CommsUserNotificationSettings["globalDefault"] }).catch((err) => console.error("[NotificationSettingsPanel] save failed:", err));
    },
    [onSave],
  );

  // ─── Sound enabled ───────────────────────────────────────────────────────────
  const handleSoundToggle = useCallback(
    (checked: boolean) => onSave({ soundEnabled: checked }),
    [onSave],
  );

  const handleSoundChoice = useCallback(
    (val: string) => onSave({ soundChoice: val as CommsUserNotificationSettings["soundChoice"] }),
    [onSave],
  );

  // ─── Desktop notifications ───────────────────────────────────────────────────
  const handleDesktopToggle = useCallback(
    async (checked: boolean) => {
      if (checked && desktopPerm !== "granted") {
        const result = await requestNotificationPermission();
        setDesktopPerm(result);
        if (result !== "granted") return;
      }
      void onSave({ desktopEnabled: checked }).catch((err) => console.error("[NotificationSettingsPanel] save failed:", err));
    },
    [onSave, desktopPerm],
  );

  // ─── Suppress snippet ────────────────────────────────────────────────────────
  const handleSuppress = useCallback(
    (checked: boolean) => onSave({ suppressSnippetPrivate: checked }),
    [onSave],
  );

  // ─── Keyword list ────────────────────────────────────────────────────────────
  const addKeyword = useCallback(() => {
    const kw = kwInput.trim().toLowerCase();
    if (!kw || kw.length > 80) return;
    if (settings.keywords.includes(kw)) { setKwInput(""); return; }
    if (settings.keywords.length >= 50) return;
    void onSave({ keywords: [...settings.keywords, kw] }).catch((err) => console.error("[NotificationSettingsPanel] save failed:", err));
    setKwInput("");
    kwInputRef.current?.focus();
  }, [kwInput, settings.keywords, onSave]);

  const removeKeyword = useCallback(
    (kw: string) => onSave({ keywords: settings.keywords.filter((k) => k !== kw) }),
    [settings.keywords, onSave],
  );

  const onKwKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") { e.preventDefault(); addKeyword(); }
    },
    [addKeyword],
  );

  const desktopBlocked = desktopPerm === "denied";

  return (
    <div className="space-y-5 p-1" data-testid="notif-settings-panel">

      {/* DND indicator */}
      {isDndActive && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <BellOff className="h-3.5 w-3.5 shrink-0" />
          <span>Do Not Disturb is active — all notifications are suppressed</span>
        </div>
      )}

      {/* Global default */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-foreground/80">
          Default notification level
        </Label>
        <Select value={settings.globalDefault} onValueChange={handleGlobalDefault} disabled={saving}>
          <SelectTrigger className="h-8 text-xs" data-testid="notif-global-default-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All messages
            </SelectItem>
            <SelectItem value="mentions" className="text-xs">
              @mentions and keywords only
            </SelectItem>
            <SelectItem value="nothing" className="text-xs">
              Nothing (badge only)
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Per-channel preferences override this setting.
        </p>
      </div>

      {/* Sound */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {settings.soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <VolumeX className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <Label htmlFor="notif-sound-toggle" className="text-xs font-medium">
              Notification sound
            </Label>
          </div>
          <Switch
            id="notif-sound-toggle"
            checked={settings.soundEnabled && soundState !== "unsupported"}
            onCheckedChange={handleSoundToggle}
            disabled={saving || soundState === "unsupported"}
            data-testid="notif-sound-toggle"
          />
        </div>
        {settings.soundEnabled && soundState !== "unsupported" && (
          <div className="flex items-center gap-1.5 ml-5">
            <Select value={settings.soundChoice} onValueChange={handleSoundChoice} disabled={saving}>
              <SelectTrigger className="h-7 text-xs w-auto" data-testid="notif-sound-choice-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default" className="text-xs">Default chime</SelectItem>
                <SelectItem value="ding" className="text-xs">Single ding</SelectItem>
                <SelectItem value="subtle" className="text-xs">Subtle tone</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2"
              onClick={handleTestSound}
              data-testid="notif-sound-test-btn"
            >
              Test
            </Button>
          </div>
        )}
        {settings.soundEnabled && soundState === "needs-interaction" && (
          <p
            className="text-[11px] text-amber-600 dark:text-amber-400 ml-5"
            data-testid="notif-sound-activation-hint"
          >
            Your browser pauses sounds until you interact with the page — click
            anywhere (or press Test) to activate them.
          </p>
        )}
        {settings.soundEnabled && soundState === "fallback" && (
          <p
            className="text-[11px] text-muted-foreground ml-5"
            data-testid="notif-sound-fallback-hint"
          >
            Using a basic audio fallback for this browser.
          </p>
        )}
        {soundState === "unsupported" && (
          <p
            className="text-[11px] text-destructive ml-5"
            data-testid="notif-sound-unsupported-hint"
          >
            This browser doesn't support notification sounds.
          </p>
        )}
      </div>

      {/* Desktop notifications */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            <Label htmlFor="notif-desktop-toggle" className="text-xs font-medium">
              Desktop notifications
            </Label>
          </div>
          <Switch
            id="notif-desktop-toggle"
            checked={settings.desktopEnabled && desktopPerm === "granted"}
            onCheckedChange={handleDesktopToggle}
            disabled={saving || desktopBlocked}
            data-testid="notif-desktop-toggle"
          />
        </div>
        {desktopBlocked && (
          <p className="text-[11px] text-destructive ml-5">
            Blocked by browser — enable in site settings
          </p>
        )}
        {desktopPerm === "default" && !settings.desktopEnabled && (
          <p className="text-[11px] text-muted-foreground ml-5">
            Browser will ask for permission when you enable this.
          </p>
        )}
        {settings.desktopEnabled && desktopPerm === "granted" && (
          <div className="flex items-center justify-between ml-5">
            <Label htmlFor="notif-suppress-snippet" className="text-xs text-muted-foreground">
              Hide message preview in private threads
            </Label>
            <Switch
              id="notif-suppress-snippet"
              checked={settings.suppressSnippetPrivate}
              onCheckedChange={handleSuppress}
              disabled={saving}
              data-testid="notif-suppress-snippet-toggle"
            />
          </div>
        )}
      </div>

      {/* Keyword alerts */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-xs font-medium">
            Keyword alerts{" "}
            <span className="text-muted-foreground font-normal">
              — highlights messages that contain these words
            </span>
          </Label>
        </div>

        <div className="flex gap-1.5">
          <Input
            ref={kwInputRef}
            value={kwInput}
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={onKwKeyDown}
            placeholder="Add keyword…"
            className="h-7 text-xs flex-1"
            maxLength={80}
            disabled={saving || settings.keywords.length >= 50}
            data-testid="notif-keyword-input"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs px-2"
            onClick={addKeyword}
            disabled={saving || !kwInput.trim() || settings.keywords.length >= 50}
            data-testid="notif-keyword-add-btn"
          >
            Add
          </Button>
        </div>

        {settings.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5" data-testid="notif-keyword-list">
            {settings.keywords.map((kw) => (
              <Badge
                key={kw}
                variant="secondary"
                className="text-xs gap-1 pl-2 pr-1 py-0.5 font-normal"
                data-testid={`notif-keyword-badge-${kw}`}
              >
                {kw}
                <button
                  className="ml-0.5 rounded-sm hover:bg-muted"
                  onClick={() => removeKeyword(kw)}
                  disabled={saving}
                  data-testid={`notif-keyword-remove-${kw}`}
                  aria-label={`Remove keyword ${kw}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        {settings.keywords.length === 0 && (
          <p className="text-[11px] text-muted-foreground">No keywords yet.</p>
        )}
        {settings.keywords.length >= 50 && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">Maximum 50 keywords reached.</p>
        )}
      </div>
    </div>
  );
}
