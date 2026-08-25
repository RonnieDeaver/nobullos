import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquarePlus, Loader2, ImagePlus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { FEEDBACK_MAX_IMAGE_BYTES, FEEDBACK_MAX_VIDEO_BYTES } from "@shared/attachments";
import { fetchWithSessionRetry } from "@/lib/fetchWithSessionRetry";

const TOPICS = [
  { value: "BUG_REPORT", label: "Bug Report" },
  { value: "FEATURE_REQUEST", label: "Feature Request" },
  { value: "DESIGN", label: "Design Feedback" },
  { value: "CONTENT", label: "Content Issue" },
  { value: "OTHER", label: "Other" },
];

const MAX_ATTACHMENTS = 5;
// Task #3964 — the caps live in @shared/attachments so this client pre-filter
// and the server-side post-upload verifier (audit A-006) stay in lockstep.
const MAX_IMAGE_BYTES = FEEDBACK_MAX_IMAGE_BYTES; // 10MB
const MAX_VIDEO_BYTES = FEEDBACK_MAX_VIDEO_BYTES; // 50MB (Task #2409)

type ScreenshotFile = {
  file: File;
  preview: string;
  isVideo: boolean;
  objectPath?: string;
  uploading?: boolean;
};

// Derive the file extension the server should stamp onto the storage key so
// the stored path is self-describing (image vs video).
function fileExtension(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot === -1) return "";
  return file.name.slice(dot + 1).toLowerCase();
}

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("BUG_REPORT");
  const [text, setText] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const remaining = MAX_ATTACHMENTS - screenshots.length;
    const newFiles = Array.from(files).slice(0, remaining);

    const newScreenshots: ScreenshotFile[] = newFiles
      .filter((f) => {
        if (f.type.startsWith("image/")) return f.size <= MAX_IMAGE_BYTES;
        if (f.type.startsWith("video/")) return f.size <= MAX_VIDEO_BYTES;
        return false;
      })
      .map((f) => ({
        file: f,
        preview: URL.createObjectURL(f),
        isVideo: f.type.startsWith("video/"),
      }));

    if (newScreenshots.length < newFiles.length) {
      toast({
        title: "Some files skipped",
        description: "Accepted: images up to 10MB and videos up to 50MB.",
        variant: "destructive",
      });
    }

    setScreenshots((prev) => [...prev, ...newScreenshots]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeScreenshot = (index: number) => {
    setScreenshots((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  /**
   * Upload all pending screenshots. Uses fetchWithSessionRetry so a Clerk
   * token lapse during a long upload session gets one silent refresh + retry
   * instead of silently swallowing the failure. Throws on any upload-url
   * failure so handleSubmit can surface the specific error rather than
   * silently submitting with missing attachments.
   */
  const uploadScreenshots = async (): Promise<string[]> => {
    const paths: string[] = [];
    for (const ss of screenshots) {
      const urlResult = await fetchWithSessionRetry("/api/feedback/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentType: ss.file.type,
          ext: fileExtension(ss.file),
        }),
      });
      if (!urlResult.ok) {
        throw Object.assign(new Error("upload_url_failed"), {
          fetchResult: urlResult,
        });
      }
      const { uploadUrl, objectPath } = urlResult.data as {
        uploadUrl: string;
        objectPath: string;
      };

      // Direct PUT to object storage — not through our server, no session
      // involved, so a plain fetch suffices. Check Response.ok: a 4xx/5xx
      // from the signed-upload endpoint resolves without throwing, so we must
      // inspect the status explicitly or the failed upload path is submitted
      // as if it succeeded.
      let putRes: Response;
      try {
        putRes = await fetch(uploadUrl, {
          method: "PUT",
          body: ss.file,
          headers: { "Content-Type": ss.file.type },
        });
      } catch (err) {
        console.error("[Feedback] Screenshot PUT upload failed (network):", err);
        throw Object.assign(new Error("upload_put_failed"), {
          fetchResult: {
            ok: false,
            status: 0,
            data: null,
            errorMessage:
              "Could not upload the attachment. Check your connection and try again.",
            errorKind: "network",
          },
        });
      }
      if (!putRes.ok) {
        console.error(`[Feedback] Screenshot PUT rejected: HTTP ${putRes.status}`);
        throw Object.assign(new Error("upload_put_rejected"), {
          fetchResult: {
            ok: false,
            status: putRes.status,
            data: null,
            errorMessage:
              "The attachment upload was rejected. Try removing the attachment and submitting without it.",
            errorKind: putRes.status >= 500 ? "server_error" : "server_error",
          },
        });
      }

      paths.push(objectPath);
    }
    return paths;
  };

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      let screenshotPaths: string[] = [];
      if (screenshots.length > 0) {
        try {
          screenshotPaths = await uploadScreenshots();
        } catch (err: any) {
          const result = err?.fetchResult;
          toast({
            title: "Attachment upload failed",
            description:
              result?.errorMessage ??
              "Could not upload attachments. Try removing them and submitting without.",
            variant: "destructive",
          });
          // Keep dialog open with draft intact; leave screenshots in state so
          // the user can decide to remove them.
          return;
        }
      }

      const result = await fetchWithSessionRetry("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          text: text.trim(),
          currentPage: window.location.pathname,
          screenshots: screenshotPaths,
        }),
      });

      if (!result.ok) {
        // Dialog stays open; draft text, topic, and attachments are preserved.
        toast({
          title:
            result.errorKind === "session_expired"
              ? "Session expired"
              : result.errorKind === "rate_limited"
                ? "Too many requests"
                : "Submission failed",
          description: result.errorMessage ?? "Could not submit feedback. Please try again.",
          variant: "destructive",
        });
        return;
      }

      const data = result.data as {
        slackStatus?: string;
        slackReason?: string;
      } | null ?? {};
      // Task #2064 — the feedback is always saved server-side. If the Slack
      // relay didn't go through, tell the submitter it was saved (not lost)
      // but not yet relayed, rather than the unconditional "Feedback sent".
      if (data?.slackStatus === "pending") {
        toast({
          title: "Feedback saved",
          description:
            "Thanks — your feedback was saved and is still being sent to Slack in the background. The team has also been notified in-app.",
        });
      } else if (data?.slackStatus && data.slackStatus !== "delivered") {
        toast({
          title: "Feedback saved",
          description:
            "Thanks — your feedback was saved, but we couldn't relay it to Slack just yet. The team has been notified in-app and can re-send it.",
        });
      } else {
        toast({ title: "Feedback sent", description: "Thank you — your feedback has been received." });
      }
      screenshots.forEach((ss) => URL.revokeObjectURL(ss.preview));
      setOpen(false);
      setText("");
      setTopic("BUG_REPORT");
      setScreenshots([]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      screenshots.forEach((ss) => URL.revokeObjectURL(ss.preview));
      setScreenshots([]);
    }
    setOpen(isOpen);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        // Chrome-band tokens, not white literals: `.dark .bg-card` remaps
        // would repaint white utilities on the charcoal band (Task #4659).
        // aria-label keeps the accessible name when the text label is hidden
        // at phone widths (icon-only).
        className="text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground text-sm"
        aria-label="Send feedback"
        data-testid="button-feedback"
      >
        <MessageSquarePlus className="w-4 h-4 sm:mr-2" aria-hidden="true" />
        <span className="hidden sm:inline">Feedback</span>
      </Button>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Feedback</DialogTitle>
            <DialogDescription>
              Report a bug, request a feature, or share any feedback.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label htmlFor="feedback-topic" className="text-sm font-medium text-foreground mb-1.5 block">
                Topic
              </label>
              <Select value={topic} onValueChange={setTopic}>
                <SelectTrigger id="feedback-topic" data-testid="select-feedback-topic">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOPICS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="feedback-details" className="text-sm font-medium text-foreground mb-1.5 block">
                Details
              </label>
              <Textarea
                id="feedback-details"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Describe what happened or what you'd like to see..."
                rows={4}
                data-testid="textarea-feedback"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Attachments <span className="text-muted-foreground font-normal">(optional, up to 5 — images or videos)</span>
              </label>
              {screenshots.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {screenshots.map((ss, i) => (
                    <div key={i} className="relative group w-16 h-16 rounded border overflow-hidden bg-black/5">
                      {ss.isVideo ? (
                        <video
                          src={ss.preview}
                          className="w-full h-full object-cover"
                          muted
                          data-testid={`video-attachment-preview-${i}`}
                        />
                      ) : (
                        <img src={ss.preview} alt="" className="w-full h-full object-cover" />
                      )}
                      <button
                        type="button"
                        onClick={() => removeScreenshot(i)}
                        aria-label="Remove attachment"
                        className="absolute top-0 right-0 bg-black/60 text-white p-0.5 rounded-bl opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        data-testid={`button-remove-screenshot-${i}`}
                      >
                        <X className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {screenshots.length < MAX_ATTACHMENTS && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    data-testid="input-screenshot-file"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs"
                    data-testid="button-add-screenshot"
                  >
                    <ImagePlus className="w-3.5 h-3.5 mr-1.5" />
                    Add Attachment
                  </Button>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)} data-testid="button-feedback-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!text.trim() || submitting}
              className="bg-primary hover:bg-primary/90"
              data-testid="button-feedback-submit"
            >
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {submitting && screenshots.length > 0 ? "Uploading..." : "Send Feedback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
