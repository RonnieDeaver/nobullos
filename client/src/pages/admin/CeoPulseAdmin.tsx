import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ArrowRight, Plus, Sparkles, Loader2, Send, Check, ChevronDown, X, Link2, Share2, Copy, ExternalLink, FileText, Upload, RefreshCw, GripVertical, ArrowUp, ArrowDown, Image as ImageIcon, Trash2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import CeoPulseVisual from "@/components/CeoPulseVisual";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/admin/PageHeader";
import { NOBULL_BRIEF_STRINGS } from "@/components/ceoPulseCopy";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { CEO_PULSE_EDITIONS, CEO_PULSE_EDITION_LABELS, CEO_PULSE_IMAGE_MAX_COUNT, CEO_PULSE_IMAGE_CAPTION_MAX, type CeoPulseEdition } from "@shared/schema";
import { fabColliderRef } from "@/lib/fabCollider";
import { fetchWithSessionRetry } from "@/lib/fetchWithSessionRetry";

// Task #4802 — every mutation on this page goes through the sanctioned
// session-retry helper (silent Clerk refresh + one retry on 401) instead of
// raw fetch(): the 2026-08-14 production letter-save failure surfaced as the
// generic unknown-failure toast because these mutations threw status-less
// Errors. On failure this throws an Error carrying the REAL reason —
// meaningful server-provided `error` copy when present (e.g. the image
// endpoints' validation 400s), otherwise the helper's humane status copy
// (session expired / too many requests / server problem / connection).
// Deliberately NOT prefixed "401:": queryClient.ts's caches treat that prefix
// as terminal auth loss and handleAuthLoss() navigates to "/", which would
// discard a ~20K-character pasted letter. This page's mutations are
// meta.silent and toast locally with the real reason instead.
async function requestWithSessionRetry(input: RequestInfo, init?: RequestInit): Promise<any> {
  const result = await fetchWithSessionRetry(input, init);
  if (!result.ok) {
    const serverError = (result.data as { error?: unknown } | null)?.error;
    const message =
      result.errorKind === "server_error" && typeof serverError === "string" && serverError.trim().length > 0
        ? serverError
        : result.errorMessage ?? "Request failed";
    throw new Error(message);
  }
  return result.data;
}

// Payload shape for the shared PATCH /api/ceo-pulses/:id mutation.
type UpdatePulseData = {
  isPublished?: boolean;
  rawContent?: string;
  aiAnalysis?: any;
  fullLetterHtml?: string | null;
  includeGraphs?: boolean;
  edition?: CeoPulseEdition;
};

// Failure-toast titles for the shared update mutation, derived from the PATCH
// payload so the single mutation-level onError names the action that failed
// ("Letter save failed", never a generic unknown-failure title). Callers whose
// payload shape is ambiguous (the two aiAnalysis writers) pass an explicit
// failureTitle in the mutate variables instead.
function updateFailureTitle(data: UpdatePulseData): string {
  if ("fullLetterHtml" in data) {
    return data.fullLetterHtml === null ? "Letter removal failed" : "Letter save failed";
  }
  if ("isPublished" in data) return "Failed to update publish status";
  if ("includeGraphs" in data) return "Failed to update graphs setting";
  if ("edition" in data) return "Failed to update edition";
  return "Failed to save changes";
}

type TakeawayItem = string | { highlight: string; detail: string; url?: string };

type AIAnalysis = {
  headline?: string;
  keyTakeaways?: TakeawayItem[];
  strategicImplications?: TakeawayItem[];
  charts?: Array<{
    type: string;
    title: string;
    description: string;
    data: Array<{ label: string; value: number; previousValue?: number }>;
  }>;
};

// Task #4293 — uploaded supporting image metadata as stored on the pulse row
// (array order = display order; slot is the stable {{image-N}} identity).
type SupportingImage = { slot: number; ext: string; caption?: string | null };

type CeoPulse = {
  id: string;
  monthKey: string;
  title: string | null;
  rawContent: string;
  aiAnalysis: AIAnalysis | null;
  fullLetterHtml: string | null;
  includeGraphs: boolean;
  isPublished: boolean | null;
  shareToken: string | null;
  createdAt: string | null;
  // "company_update" | "market_shift"; null for legacy untagged briefs.
  edition: string | null;
  // Task #4293 — null/absent for legacy briefs without images.
  supportingImages?: SupportingImage[] | null;
};

// Task #4293 — creating a Company Update defaults graphs OFF (update briefs
// lead with uploaded visuals); Market Shift keeps the data-story default.
const EDITION_DEFAULT_GRAPHS: Record<CeoPulseEdition, boolean> = {
  company_update: false,
  market_shift: true,
};

// Draft images are served through the public chart-route family with an
// authenticated-CEO bypass, so thumbnails work pre-publish. The `bust` query
// defeats the 1h browser cache when a freed slot number is reused.
function supportingImageUrl(monthKey: string, slot: number, bust?: number): string {
  return `/api/ceo-pulse-charts/${monthKey}/image-${slot}${bust ? `?v=${bust}` : ""}`;
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function CeoPulseAdmin() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle(NOBULL_BRIEF_STRINGS.title);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const chatScrollRef = useRef<HTMLDivElement>(null);
  
  const [selectedPulse, setSelectedPulse] = useState<CeoPulse | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [step, setStep] = useState<"input" | "visual">("input");
  const [chatOpen, setChatOpen] = useState(false);
  
  const [formData, setFormData] = useState({
    monthKey: "",
    rawContent: "",
    isPublished: false,
    // Task #4293 — matches the initial edition's default (company_update ⇒ off).
    includeGraphs: EDITION_DEFAULT_GRAPHS.company_update,
    // "company_update" | "market_shift"; null only while editing a legacy
    // untagged brief until an edition is picked (create always sends one).
    edition: "company_update" as CeoPulseEdition | null,
  });
  // Task #4293 — once the CEO touches the graphs switch on the create form,
  // edition clicks stop overriding their choice.
  const [graphsTouched, setGraphsTouched] = useState(false);

  const { data: pulses, isLoading } = useQuery<CeoPulse[]>({
    queryKey: ["/api/ceo-pulses"],
    queryFn: async () => {
      const res = await fetch("/api/ceo-pulses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch NoBull Briefs");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const createAndAnalyzeMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (data: typeof formData) => {
      const pulse = await requestWithSessionRetry("/api/ceo-pulses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      return requestWithSessionRetry(`/api/ceo-pulses/${pulse.id}/analyze`, {
        method: "POST",
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
      setSelectedPulse(data.pulse);
      setStep("visual");
      setChatOpen(true);
      toast({ title: "Visual generated!" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to generate visual", description: error.message, variant: "destructive" });
    },
  });

  const analyzeMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) =>
      requestWithSessionRetry(`/api/ceo-pulses/${id}/analyze`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
      setSelectedPulse(data.pulse);
      setStep("visual");
      toast({ title: "Visual regenerated!" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to analyze", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ id, data }: { id: string; data: UpdatePulseData; failureTitle?: string }) =>
      requestWithSessionRetry(`/api/ceo-pulses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: (updatedPulse) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
      setSelectedPulse(updatedPulse);
    },
    onError: (error: Error, variables) => {
      // Task #4802 — ONE destructive toast with the real failure reason, at
      // the mutation level so every caller reports failures exactly once
      // (a per-call onError on top of this would double-toast). Terminal
      // failures never navigate away or clear the editor.
      toast({
        title: variables.failureTitle ?? updateFailureTitle(variables.data),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const chatMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ pulseId, message, currentAnalysis }: { pulseId: string; message: string; currentAnalysis: AIAnalysis }) =>
      // Task #4802 — the shared session-retry helper replaces this mutation's
      // old hand-rolled "sleep 1s and refetch on 401" retry.
      requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, currentAnalysis }),
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
      setSelectedPulse(data.pulse);
      setChatMessages(prev => [...prev, { role: "assistant", content: data.message }]);
    },
    onError: (error: Error) => {
      const message = error?.message?.trim()
        ? error.message
        : "Sorry, I couldn't process that. Please try again.";
      setChatMessages(prev => [...prev, { role: "assistant", content: message }]);
    },
  });

  const [editingTakeawayLinks, setEditingTakeawayLinks] = useState(false);
  const [takeawayUrls, setTakeawayUrls] = useState<Record<number, string>>({});
  const [letterContent, setLetterContent] = useState("");
  const [showLetterEditor, setShowLetterEditor] = useState(false);
  const [dragChartIndex, setDragChartIndex] = useState<number | null>(null);
  const [dragOverChartIndex, setDragOverChartIndex] = useState<number | null>(null);

  // ── Supporting images (Task #4293) ────────────────────────────────────────
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const [imageCaptions, setImageCaptions] = useState<Record<number, string>>({});
  const [dragImageIndex, setDragImageIndex] = useState<number | null>(null);
  const [dragOverImageIndex, setDragOverImageIndex] = useState<number | null>(null);
  // Bumped on upload/delete so <img> tags refetch despite the 1h cache TTL
  // (slot numbers can be reused after deleting the highest slot).
  const [imageCacheBust, setImageCacheBust] = useState(0);

  const supportingImages: SupportingImage[] = Array.isArray(selectedPulse?.supportingImages)
    ? selectedPulse.supportingImages
    : [];

  function applyImagesResponse(resp: { supportingImages?: SupportingImage[] }) {
    const images = Array.isArray(resp?.supportingImages) ? resp.supportingImages : [];
    setSelectedPulse(prev => (prev ? { ...prev, supportingImages: images } : prev));
    setImageCaptions(() => {
      const next: Record<number, string> = {};
      for (const img of images) next[img.slot] = img.caption ?? "";
      return next;
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
  }

  const uploadImageMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ pulseId, file }: { pulseId: string; file: File }) => {
      const body = new FormData();
      body.append("image", file);
      return requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/images`, {
        method: "POST",
        body,
      });
    },
    onSuccess: (data) => {
      setImageCacheBust(Date.now());
      applyImagesResponse(data);
      toast({ title: "Image uploaded", description: `Use {{image-${data.slot}}} to place it in the letter.` });
    },
    onError: (error: Error) => {
      toast({ title: "Image upload failed", description: error.message, variant: "destructive" });
    },
  });

  const updateImagesMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ pulseId, images }: { pulseId: string; images: Array<{ slot: number; caption: string | null }> }) =>
      requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/images`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      }),
    onSuccess: (data) => {
      applyImagesResponse(data);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update images", description: error.message, variant: "destructive" });
    },
  });

  const deleteImageMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ pulseId, slot }: { pulseId: string; slot: number }) =>
      requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/images/${slot}`, {
        method: "DELETE",
      }),
    onSuccess: (data) => {
      setImageCacheBust(Date.now());
      applyImagesResponse(data);
      toast({ title: "Image deleted", description: "Its {{image-N}} placeholder will now strip from the letter." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete image", description: error.message, variant: "destructive" });
    },
  });

  const imagesBusy = uploadImageMutation.isPending || updateImagesMutation.isPending || deleteImageMutation.isPending;

  // Full-list payload for the caption/reorder PATCH: current captions from
  // local edit state (trimmed; empty ⇒ null), in the given display order.
  function buildImagesPayload(order: SupportingImage[]): Array<{ slot: number; caption: string | null }> {
    return order.map(img => {
      const raw = imageCaptions[img.slot] ?? img.caption ?? "";
      const trimmed = raw.trim();
      return { slot: img.slot, caption: trimmed.length > 0 ? trimmed : null };
    });
  }

  function reorderImages(from: number, to: number) {
    if (!selectedPulse) return;
    if (from === to || from < 0 || to < 0 || from >= supportingImages.length || to >= supportingImages.length) return;
    if (imagesBusy) return;
    const reordered = [...supportingImages];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    updateImagesMutation.mutate({ pulseId: selectedPulse.id, images: buildImagesPayload(reordered) });
  }

  function handleImageFileSelected(file: File | null) {
    if (!file || !selectedPulse) return;
    uploadImageMutation.mutate({ pulseId: selectedPulse.id, file });
  }

  const shareMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (pulseId: string) =>
      requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/share`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      const shareUrl = `${window.location.origin}/pulse/${data.shareToken}`;
      void navigator.clipboard.writeText(shareUrl).catch((err) => console.error("[CeoPulseAdmin] clipboard write failed:", err)); // fire-and-forget: clipboard write
      toast({ title: "Share link copied!", description: shareUrl });
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-pulses"] }); // fire-and-forget: cache refresh only
    },
    onError: (error: Error) => {
      toast({ title: "Failed to generate share link", description: error.message, variant: "destructive" });
    },
  });

  const regenChartsMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (pulseId: string) =>
      requestWithSessionRetry(`/api/ceo-pulses/${pulseId}/regenerate-charts`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      toast({ title: "Charts regenerated", description: `${data.generatedCount} chart images created` });
    },
    onError: (error: Error) => {
      toast({ title: "Chart generation failed", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    if (selectedPulse) {
      setFormData({
        monthKey: selectedPulse.monthKey,
        rawContent: selectedPulse.rawContent,
        isPublished: selectedPulse.isPublished || false,
        includeGraphs: selectedPulse.includeGraphs !== false,
        edition: (selectedPulse.edition ?? null) as CeoPulseEdition | null,
      });
      if (selectedPulse.aiAnalysis) {
        setStep("visual");
        const urls: Record<number, string> = {};
        selectedPulse.aiAnalysis.keyTakeaways?.forEach((t, i) => {
          if (typeof t === 'object' && t.url) urls[i] = t.url;
        });
        setTakeawayUrls(urls);
      }
      setLetterContent(selectedPulse.fullLetterHtml || "");
      setShowLetterEditor(!!selectedPulse.fullLetterHtml);
      // Task #4293 — seed caption edit state from the stored images.
      const captions: Record<number, string> = {};
      for (const img of (Array.isArray(selectedPulse.supportingImages) ? selectedPulse.supportingImages : [])) {
        captions[img.slot] = img.caption ?? "";
      }
      setImageCaptions(captions);
    }
  }, [selectedPulse]);

  function startNewPulse() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const defaultMonthKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
    
    setFormData({
      monthKey: defaultMonthKey,
      rawContent: "",
      isPublished: false,
      // Task #4293 — new briefs start as Company Update, whose default is
      // graphs off (still toggleable below).
      includeGraphs: EDITION_DEFAULT_GRAPHS.company_update,
      edition: "company_update" as CeoPulseEdition | null,
    });
    setGraphsTouched(false);
    setImageCaptions({});
    setSelectedPulse(null);
    setChatMessages([]);
    setStep("input");
    setChatOpen(false);
  }

  async function handleSubmit() {
    if (selectedPulse) {
      // Save the updated content + graph toggle first, then analyze
      try {
        await requestWithSessionRetry(`/api/ceo-pulses/${selectedPulse.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rawContent: formData.rawContent,
            includeGraphs: formData.includeGraphs,
            // Legacy briefs may still be untagged (null) — the PATCH schema
            // rejects null, so only send edition once one has been picked.
            ...(formData.edition ? { edition: formData.edition } : {}),
          }),
        });
        // Now analyze with the saved content
        analyzeMutation.mutate(selectedPulse.id);
      } catch (error) {
        toast({
          title: "Failed to save content",
          description: error instanceof Error ? error.message : undefined,
          variant: "destructive",
        });
      }
    } else {
      createAndAnalyzeMutation.mutate(formData);
    }
  }

  function handleChatSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim() || !selectedPulse?.aiAnalysis) return;
    
    const userMessage = chatInput.trim();
    setChatMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setChatInput("");
    
    chatMutation.mutate({
      pulseId: selectedPulse.id,
      message: userMessage,
      currentAnalysis: selectedPulse.aiAnalysis,
    });
  }

  function handlePublishToggle(checked: boolean) {
    if (selectedPulse) {
      updateMutation.mutate(
        { id: selectedPulse.id, data: { isPublished: checked } },
        {
          onSuccess: () => {
            toast({ title: checked ? "Published" : "Unpublished" });
          },
          // Failures toast once via the mutation-level onError, which derives
          // "Failed to update publish status" from the payload + real reason.
        }
      );
    }
  }

  function reorderCharts(from: number, to: number) {
    const charts = selectedPulse?.aiAnalysis?.charts;
    if (!selectedPulse || !selectedPulse.aiAnalysis || !Array.isArray(charts)) return;
    if (from === to || from < 0 || to < 0 || from >= charts.length || to >= charts.length) return;
    if (updateMutation.isPending || regenChartsMutation.isPending) return;

    const reordered = [...charts];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    const pulseId = selectedPulse.id;
    updateMutation.mutate(
      {
        id: pulseId,
        data: { aiAnalysis: { ...selectedPulse.aiAnalysis, charts: reordered } },
        failureTitle: "Failed to reorder charts",
      },
      {
        onSuccess: () => {
          toast({ title: "Chart order updated" });
          // Chart images are keyed by position, so regenerate them to keep the
          // {{chart-N}} letter placeholders aligned with the new order.
          regenChartsMutation.mutate(pulseId);
        },
      }
    );
  }

  function formatMonthKey(monthKey: string): string {
    const [year, month] = monthKey.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  if (authLoading || isLoading) {
    return <PageSkeleton />;
  }

  if (!user || user.role !== "ceo") {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground">Access denied. CEO only.</div>
      </div>
    );
  }

  const analysis = selectedPulse?.aiAnalysis;
  const isGenerating = createAndAnalyzeMutation.isPending || analyzeMutation.isPending;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Header — shared Pattern-A anatomy via PageHeader's on-band variant
          (Task #4451): the Studio keeps its full-width band — now the
          --chrome brand band (Task #4600 rebalance) — while the back
          affordance / title / action slot come from the shared component
          (light-on-dark tokens) instead of bespoke chrome. Month switcher +
          New live in the standard actions slot; view switching
          (input/visual) is untouched. */}
      <header className="bg-chrome text-chrome-foreground border-b border-chrome-edge px-3 sm:px-6 py-3 sm:py-4">
        <div className="max-w-7xl mx-auto">
          <PageHeader
            title="NoBull Brief Studio"
            backHref="/"
            onBand
            actions={
              <div className="flex items-center gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="bg-white/10 border-white/20 text-white hover:bg-white/20 min-w-[220px] justify-between">
                      {selectedPulse ? `Presenting: ${formatMonthKey(selectedPulse.monthKey)}` : "Select presentation month"}
                      <ChevronDown className="w-4 h-4 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[220px]">
                    {pulses?.map(pulse => (
                      <DropdownMenuItem 
                        key={pulse.id} 
                        onClick={() => { setSelectedPulse(pulse); setChatMessages([]); }}
                        className="flex items-center justify-between"
                      >
                        <span>{formatMonthKey(pulse.monthKey)}</span>
                        {pulse.isPublished && <Check className="w-4 h-4 text-green-600" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button onClick={startNewPulse} className="bg-white/10 hover:bg-white/20">
                  <Plus className="w-4 h-4 mr-2" />
                  New
                </Button>
              </div>
            }
          />
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {step === "input" ? (
          /* Step 1: Input Content */
          <div className="max-w-2xl mx-auto">
            <div className="bg-card p-8 shadow-sm">
              <div className="text-center mb-6">
                <h2 className="text-2xl font-bold text-foreground">Create NoBull Brief</h2>
                <p className="text-muted-foreground mt-1">Paste your message and we'll generate the visual</p>
              </div>
              
              <div className="space-y-5">
                <div>
                  <Label className="text-sm text-muted-foreground">Presentation Month</Label>
                  <Input
                    type="month"
                    value={formData.monthKey}
                    onChange={e => setFormData(prev => ({ ...prev, monthKey: e.target.value }))}
                    className="mt-1"
                    data-testid="input-month-key"
                  />
                  <p className="text-xs text-muted-foreground/70 mt-1">The month this brief will be shown (e.g., January for December data reports)</p>
                </div>
                
                <div>
                  <Label className="text-sm text-muted-foreground">Your Message</Label>
                  <Textarea
                    value={formData.rawContent}
                    onChange={e => setFormData(prev => ({ ...prev, rawContent: e.target.value }))}
                    placeholder="Paste your full CEO message here including any statistics..."
                    rows={14}
                    className="mt-1 resize-none"
                    data-testid="input-raw-content"
                  />
                  <p className="text-xs text-muted-foreground/70 mt-1">{formData.rawContent.length} characters</p>
                </div>

                <div>
                  <Label className="text-sm text-muted-foreground">Edition</Label>
                  <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Edition">
                    {CEO_PULSE_EDITIONS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={formData.edition === value}
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          edition: value,
                          // Task #4293 — creating a Company Update defaults
                          // graphs off (Market Shift on) until the CEO
                          // touches the switch; editing an existing brief
                          // never auto-flips it.
                          ...(!selectedPulse && !graphsTouched ? { includeGraphs: EDITION_DEFAULT_GRAPHS[value] } : {}),
                        }))}
                        className={`border px-4 py-2.5 text-sm font-medium transition-colors ${
                          formData.edition === value
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-surface-warm-2 text-muted-foreground hover:border-primary/40"
                        }`}
                        data-testid={`button-edition-${value}`}
                      >
                        {CEO_PULSE_EDITION_LABELS[value]}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground/70 mt-1">Declares what this brief covers — a company update or commentary on a market shift.</p>
                </div>

                <div className="flex items-center justify-between border border-border bg-surface-warm-2 px-4 py-3">
                  <div className="pr-4">
                    <Label htmlFor="toggle-include-graphs" className="text-sm font-medium text-foreground">
                      Include graphs
                    </Label>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      When off, the AI skips chart extraction and the visual + letter render text-only.
                    </p>
                  </div>
                  <Switch
                    id="toggle-include-graphs"
                    checked={formData.includeGraphs}
                    onCheckedChange={(checked) => {
                      setGraphsTouched(true);
                      setFormData(prev => ({ ...prev, includeGraphs: checked }));
                    }}
                    data-testid="switch-include-graphs"
                  />
                </div>

                <Button 
                  onClick={handleSubmit}
                  disabled={!formData.rawContent || !formData.monthKey || isGenerating}
                  className="w-full bg-primary hover:bg-primary/90 h-12 text-base"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin mr-2" />
                      Generating Visual...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-5 h-5 mr-2" />
                      Generate Visual
                      <ArrowRight className="w-5 h-5 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          /* Step 2: Visual Editor */
          <div className="relative">
            {/* Controls Bar — flex-wrap keeps the action cluster wrap-safe on
                narrow screens (actions flow onto extra rows, never horizontal
                overflow). */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <Button 
                variant="outline" 
                onClick={() => setStep("input")}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Edit Content
              </Button>
              <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                {/* Task #4901 — dedicated Re-analyze control (restores the one
                    removed in the Jan 2026 workflow simplification): re-runs
                    the AI analysis for the SAVED message via the existing
                    analyze mutation, without the Edit Content → Generate
                    Visual detour. Confirm-gated because a re-run replaces the
                    stored aiAnalysis wholesale — chat refinements and takeaway
                    links included; the letter HTML and supporting images live
                    outside aiAnalysis and survive. */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isGenerating || updateMutation.isPending}
                      data-testid="button-reanalyze"
                    >
                      {analyzeMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4 mr-1.5" />
                      )}
                      {analyzeMutation.isPending ? "Re-analyzing..." : "Re-analyze"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent data-testid="dialog-reanalyze">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Re-analyze this brief?</AlertDialogTitle>
                      <AlertDialogDescription data-testid="text-reanalyze-consequences">
                        This regenerates the analysis from your saved message. The current
                        AI-refined content and takeaway links will be replaced; your letter
                        and supporting images are kept.
                        {selectedPulse?.isPublished
                          ? " This brief is published — clients will see the updated analysis immediately."
                          : ""}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-reanalyze-cancel">Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="button-reanalyze-confirm"
                        onClick={() => {
                          if (!selectedPulse || analyzeMutation.isPending) return;
                          analyzeMutation.mutate(selectedPulse.id);
                        }}
                      >
                        Re-analyze
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingTakeawayLinks(!editingTakeawayLinks)}
                  data-testid="button-edit-links"
                >
                  <Link2 className="w-4 h-4 mr-1.5" />
                  {editingTakeawayLinks ? "Hide Links" : "Edit Links"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectedPulse && shareMutation.mutate(selectedPulse.id)}
                  disabled={shareMutation.isPending || !selectedPulse?.isPublished}
                  data-testid="button-share-pulse"
                >
                  {shareMutation.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Share2 className="w-4 h-4 mr-1.5" />}
                  Share
                </Button>
                <div className="flex items-center gap-2 bg-card px-4 py-2 shadow-sm">
                  <Switch
                    checked={selectedPulse?.isPublished || false}
                    onCheckedChange={handlePublishToggle}
                    disabled={updateMutation.isPending}
                    aria-label="Publish pulse"
                  />
                  <span className="text-sm text-foreground">
                    {selectedPulse?.isPublished ? "Published" : "Draft"}
                  </span>
                </div>
              </div>
            </div>

            {editingTakeawayLinks && analysis?.keyTakeaways && (
              <div className="bg-card p-5 shadow-sm border mb-4" data-testid="panel-takeaway-links">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-foreground">Takeaway Links</h4>
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90"
                    disabled={updateMutation.isPending}
                    onClick={() => {
                      if (!selectedPulse || !analysis) return;
                      const updatedTakeaways = analysis.keyTakeaways!.map((t, i) => {
                        const url = takeawayUrls[i]?.trim();
                        if (typeof t === 'string') {
                          return url ? { highlight: t, detail: '', url } : t;
                        }
                        const updated = { ...t };
                        if (url) {
                          updated.url = url;
                        } else {
                          delete updated.url;
                        }
                        return updated;
                      });
                      updateMutation.mutate(
                        {
                          id: selectedPulse.id,
                          data: { aiAnalysis: { ...analysis, keyTakeaways: updatedTakeaways } },
                          failureTitle: "Failed to save links",
                        },
                        {
                          onSuccess: () => {
                            toast({ title: "Links saved!" });
                          },
                        }
                      );
                    }}
                    data-testid="button-save-links"
                  >
                    {updateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
                    Save Links
                  </Button>
                </div>
                <div className="space-y-2">
                  {analysis.keyTakeaways.map((takeaway, i) => {
                    const text = typeof takeaway === 'object' && takeaway.highlight
                      ? takeaway.highlight
                      : (typeof takeaway === 'string' ? takeaway.slice(0, 60) : '');
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-48 truncate shrink-0">{text}...</span>
                        <Input
                          value={takeawayUrls[i] || ''}
                          onChange={e => setTakeawayUrls(prev => ({ ...prev, [i]: e.target.value }))}
                          placeholder="https://..."
                          className="text-sm h-8"
                          data-testid={`input-takeaway-url-${i}`}
                        />
                        {takeawayUrls[i] && (
                          <a href={takeawayUrls[i]} target="_blank" rel="noopener noreferrer" className="text-primary-ink hover:text-primary-ink/80">
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Editor controls — Include graphs toggle (always visible on existing pulse) */}
            {selectedPulse && (
              <div className="bg-card p-4 shadow-sm border flex items-center justify-between" data-testid="editor-include-graphs">
                <div className="pr-4">
                  <Label htmlFor="toggle-include-graphs-editor" className="text-sm font-medium text-foreground">
                    Include graphs
                  </Label>
                  <p className="text-xs text-muted-foreground/70 mt-0.5">
                    Toggle off to render this brief text-only. Existing chart data is cleared and the visual + letter re-render without "By The Numbers".
                  </p>
                </div>
                <Switch
                  id="toggle-include-graphs-editor"
                  checked={selectedPulse.includeGraphs !== false}
                  disabled={updateMutation.isPending}
                  onCheckedChange={(checked) => {
                    if (!selectedPulse) return;
                    updateMutation.mutate({ id: selectedPulse.id, data: { includeGraphs: checked } });
                  }}
                  data-testid="switch-include-graphs-editor"
                />
              </div>
            )}

            {/* Editor controls — Edition tag (Task #4268; saves immediately like the graphs toggle) */}
            {selectedPulse && (
              <div className="bg-card p-4 shadow-sm border flex items-center justify-between gap-4 flex-wrap" data-testid="editor-edition">
                <div className="pr-4">
                  <Label className="text-sm font-medium text-foreground">Edition</Label>
                  <p className="text-xs text-muted-foreground/70 mt-0.5">
                    {selectedPulse.edition
                      ? "Shown as a tag on the visual, letter, and report slide."
                      : "This brief predates edition tags — pick one to tag it."}
                  </p>
                </div>
                <div className="flex items-center gap-2" role="radiogroup" aria-label="Edition">
                  {CEO_PULSE_EDITIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selectedPulse.edition === value}
                      disabled={updateMutation.isPending}
                      onClick={() => {
                        if (selectedPulse.edition === value) return;
                        updateMutation.mutate({ id: selectedPulse.id, data: { edition: value } });
                      }}
                      className={`border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                        selectedPulse.edition === value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-surface-warm-2 text-muted-foreground hover:border-primary/40"
                      }`}
                      data-testid={`button-edition-editor-${value}`}
                    >
                      {CEO_PULSE_EDITION_LABELS[value]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Full Width Slide Preview */}
            <div className="bg-brief-ink-strong p-8 shadow-lg">
              <p className="text-white/40 text-xs uppercase tracking-wider mb-4">
                {formatMonthKey(selectedPulse?.monthKey || "")} - Live Preview
              </p>
              
              {analysis && (
                <CeoPulseVisual 
                  analysis={analysis}
                  monthLabel={formatMonthKey(selectedPulse?.monthKey || "")}
                  animate={true}
                  letterUrl={selectedPulse?.fullLetterHtml && selectedPulse?.shareToken ? `/pulse/${selectedPulse.shareToken}/letter` : undefined}
                  includeGraphs={selectedPulse?.includeGraphs !== false}
                  edition={selectedPulse?.edition ?? null}
                  supportingImages={selectedPulse ? supportingImages.map(img => ({
                    slot: img.slot,
                    url: supportingImageUrl(selectedPulse.monthKey, img.slot, imageCacheBust),
                    caption: img.caption ?? null,
                  })) : []}
                />
              )}
            </div>

            {selectedPulse?.includeGraphs !== false && analysis?.charts && analysis.charts.length > 0 && (
              <div className="mt-4 bg-card p-5 shadow-sm border" data-testid="panel-chart-placeholders">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-foreground">Chart Placeholders for Letter</h4>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    disabled={regenChartsMutation.isPending}
                    onClick={() => {
                      if (selectedPulse) regenChartsMutation.mutate(selectedPulse.id);
                    }}
                    data-testid="button-regenerate-charts"
                  >
                    {regenChartsMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1" />
                    )}
                    {regenChartsMutation.isPending ? "Generating..." : "Regenerate Chart Images"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Use these placeholders in your letter HTML. They will be automatically replaced with chart images when the letter is displayed. Drag the handle or use the arrows to reorder charts.
                </p>
                <div className="space-y-2">
                  {analysis.charts.map((chart: any, i: number) => {
                    const reorderBusy = updateMutation.isPending || regenChartsMutation.isPending;
                    const chartCount = analysis.charts!.length;
                    const isDragSource = dragChartIndex === i;
                    const isDropTarget = dragOverChartIndex === i && dragChartIndex !== null && dragChartIndex !== i;
                    return (
                      <div
                        key={i}
                        draggable={!reorderBusy}
                        onDragStart={() => setDragChartIndex(i)}
                        onDragOver={(e) => { e.preventDefault(); if (dragChartIndex !== null) setDragOverChartIndex(i); }}
                        onDragLeave={() => setDragOverChartIndex(prev => (prev === i ? null : prev))}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragChartIndex !== null) reorderCharts(dragChartIndex, i);
                          setDragChartIndex(null);
                          setDragOverChartIndex(null);
                        }}
                        onDragEnd={() => { setDragChartIndex(null); setDragOverChartIndex(null); }}
                        className={`flex items-center gap-2 bg-surface-warm-1 px-3 py-2.5 transition-all ${reorderBusy ? 'opacity-70' : 'cursor-move'} ${isDragSource ? 'opacity-40' : ''} ${isDropTarget ? 'ring-2 ring-primary' : ''}`}
                        data-testid={`chart-placeholder-${i}`}
                      >
                        <GripVertical className="w-4 h-4 text-primary/40 shrink-0" aria-hidden="true" />
                        <div className="flex flex-col shrink-0">
                          <button
                            onClick={() => reorderCharts(i, i - 1)}
                            disabled={i === 0 || reorderBusy}
                            className="text-primary-ink hover:text-primary-ink/80 disabled:text-primary-ink/25 disabled:cursor-not-allowed transition-colors"
                            title="Move up"
                            aria-label={`Move Chart ${i + 1} up`}
                            data-testid={`button-chart-move-up-${i}`}
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => reorderCharts(i, i + 1)}
                            disabled={i === chartCount - 1 || reorderBusy}
                            className="text-primary-ink hover:text-primary-ink/80 disabled:text-primary-ink/25 disabled:cursor-not-allowed transition-colors"
                            title="Move down"
                            aria-label={`Move Chart ${i + 1} down`}
                            data-testid={`button-chart-move-down-${i}`}
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-foreground">Chart {i + 1}: </span>
                          <span className="text-sm text-muted-foreground">{chart.title}</span>
                        </div>
                        <code className="bg-card px-3 py-1 rounded text-sm font-mono text-foreground border border-primary/20 select-all shrink-0" data-testid={`chart-placeholder-code-${i}`}>
                          {`{{chart-${i + 1}}}`}
                        </code>
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(`{{chart-${i + 1}}}`).catch((err) => console.error("[CeoPulseAdmin] clipboard write failed:", err)); // fire-and-forget: clipboard write
                            toast({ title: `Copied {{chart-${i + 1}}} to clipboard` });
                          }}
                          className="text-primary-ink hover:text-primary-ink/80 transition-colors shrink-0"
                          data-testid={`button-copy-placeholder-${i}`}
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Supporting Images (Task #4293) — uploads for update briefs;
                slot numbers are stable, so {{image-N}} chips show SLOTS, not
                display positions (reordering never retargets a placeholder). */}
            {selectedPulse && (
              <div className="mt-4 bg-card p-5 shadow-sm border" data-testid="panel-supporting-images">
                <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-primary" />
                    <h4 className="text-sm font-semibold text-foreground">Supporting Images</h4>
                    <span className="text-xs text-muted-foreground/70" data-testid="text-image-count">
                      {supportingImages.length}/{CEO_PULSE_IMAGE_MAX_COUNT}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={imageFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        handleImageFileSelected(e.target.files?.[0] ?? null);
                        e.target.value = "";
                      }}
                      aria-label="Upload supporting image"
                      data-testid="input-image-file"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={imagesBusy || supportingImages.length >= CEO_PULSE_IMAGE_MAX_COUNT}
                      onClick={() => imageFileInputRef.current?.click()}
                      data-testid="button-upload-image"
                    >
                      {uploadImageMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <Upload className="w-3.5 h-3.5 mr-1" />
                      )}
                      {uploadImageMutation.isPending ? "Uploading..." : "Upload Image"}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  JPEG, PNG, or WebP up to 5 MB — book covers, product shots, anything the brief should show instead of (or alongside) graphs.
                  They appear on the shared visual in this order, and each {"{{image-N}}"} placeholder embeds one in the letter. Captions are optional.
                </p>
                {supportingImages.length === 0 ? (
                  <div className="bg-surface-warm-1 px-4 py-6 text-center text-sm text-muted-foreground/70" data-testid="text-no-images">
                    No supporting images yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {supportingImages.map((img, i) => {
                      const isDragSource = dragImageIndex === i;
                      const isDropTarget = dragOverImageIndex === i && dragImageIndex !== null && dragImageIndex !== i;
                      return (
                        <div
                          key={img.slot}
                          draggable={!imagesBusy}
                          onDragStart={() => setDragImageIndex(i)}
                          onDragOver={(e) => { e.preventDefault(); if (dragImageIndex !== null) setDragOverImageIndex(i); }}
                          onDragLeave={() => setDragOverImageIndex(prev => (prev === i ? null : prev))}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragImageIndex !== null) reorderImages(dragImageIndex, i);
                            setDragImageIndex(null);
                            setDragOverImageIndex(null);
                          }}
                          onDragEnd={() => { setDragImageIndex(null); setDragOverImageIndex(null); }}
                          className={`flex items-center gap-3 bg-surface-warm-1 px-3 py-2.5 transition-all ${imagesBusy ? 'opacity-70' : 'cursor-move'} ${isDragSource ? 'opacity-40' : ''} ${isDropTarget ? 'ring-2 ring-primary' : ''}`}
                          data-testid={`supporting-image-row-${img.slot}`}
                        >
                          <GripVertical className="w-4 h-4 text-primary/40 shrink-0" aria-hidden="true" />
                          <div className="flex flex-col shrink-0">
                            <button
                              onClick={() => reorderImages(i, i - 1)}
                              disabled={i === 0 || imagesBusy}
                              className="text-primary-ink hover:text-primary-ink/80 disabled:text-primary-ink/25 disabled:cursor-not-allowed transition-colors"
                              title="Move up"
                              aria-label={`Move image ${img.slot} up`}
                              data-testid={`button-image-move-up-${img.slot}`}
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => reorderImages(i, i + 1)}
                              disabled={i === supportingImages.length - 1 || imagesBusy}
                              className="text-primary-ink hover:text-primary-ink/80 disabled:text-primary-ink/25 disabled:cursor-not-allowed transition-colors"
                              title="Move down"
                              aria-label={`Move image ${img.slot} down`}
                              data-testid={`button-image-move-down-${img.slot}`}
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <img
                            src={supportingImageUrl(selectedPulse.monthKey, img.slot, imageCacheBust)}
                            alt={img.caption || `Supporting image ${img.slot}`}
                            className="w-14 h-14 object-cover border border-black/5 bg-card shrink-0"
                            loading="lazy"
                            data-testid={`img-thumbnail-${img.slot}`}
                          />
                          <Input
                            value={imageCaptions[img.slot] ?? ""}
                            onChange={(e) => setImageCaptions(prev => ({ ...prev, [img.slot]: e.target.value }))}
                            onBlur={() => {
                              const current = supportingImages.find(s => s.slot === img.slot);
                              const stored = (current?.caption ?? "").trim();
                              const edited = (imageCaptions[img.slot] ?? "").trim();
                              if (stored !== edited && !imagesBusy) {
                                updateImagesMutation.mutate({ pulseId: selectedPulse.id, images: buildImagesPayload(supportingImages) });
                              }
                            }}
                            maxLength={CEO_PULSE_IMAGE_CAPTION_MAX}
                            placeholder="Caption (optional)"
                            className="text-sm h-9 bg-card"
                            data-testid={`input-image-caption-${img.slot}`}
                          />
                          <code className="bg-card px-3 py-1 rounded text-sm font-mono text-foreground border border-primary/20 select-all shrink-0" data-testid={`image-placeholder-code-${img.slot}`}>
                            {`{{image-${img.slot}}}`}
                          </code>
                          <button
                            onClick={() => {
                              void navigator.clipboard.writeText(`{{image-${img.slot}}}`).catch((err) => console.error("[CeoPulseAdmin] clipboard write failed:", err)); // fire-and-forget: clipboard write
                              toast({ title: `Copied {{image-${img.slot}}} to clipboard` });
                            }}
                            className="text-primary-ink hover:text-primary-ink/80 transition-colors shrink-0"
                            title="Copy placeholder"
                            aria-label={`Copy placeholder for image ${img.slot}`}
                            data-testid={`button-copy-image-placeholder-${img.slot}`}
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              if (imagesBusy) return;
                              deleteImageMutation.mutate({ pulseId: selectedPulse.id, slot: img.slot });
                            }}
                            disabled={imagesBusy}
                            className="text-muted-foreground hover:text-destructive disabled:cursor-not-allowed transition-colors shrink-0"
                            title="Delete image"
                            aria-label={`Delete image ${img.slot}`}
                            data-testid={`button-delete-image-${img.slot}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Full Letter Section */}
            <div className="mt-6 shadow-sm border overflow-hidden" style={{ background: selectedPulse?.fullLetterHtml ? 'hsl(var(--status-ok) / 8%)' : 'linear-gradient(135deg, hsl(var(--accent) / 5%) 0%, hsl(var(--surface-warm-2)) 60%)' }}>
              <button
                onClick={() => setShowLetterEditor(!showLetterEditor)}
                className="w-full flex items-center justify-between p-5 hover:bg-white/40 transition-colors"
                data-testid="button-toggle-letter"
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className={`w-12 h-12 flex items-center justify-center ${selectedPulse?.fullLetterHtml ? 'bg-status-ok/15 text-status-ok' : 'bg-status-critical/15 text-status-critical'}`}>
                      <FileText className="w-6 h-6" />
                    </div>
                    {selectedPulse?.fullLetterHtml && (
                      <div className="absolute -top-1 -right-1 w-5 h-5 bg-status-ok rounded-pill flex items-center justify-center">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    )}
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-foreground text-base">
                      {selectedPulse?.fullLetterHtml ? 'Full Letter Added' : 'Next Step: Add the Full Letter'}
                    </p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {selectedPulse?.fullLetterHtml
                        ? `Readers will see a "${NOBULL_BRIEF_STRINGS.letterCtaLabel}" link on the visual`
                        : 'Paste your email HTML below to create a standalone letter page linked from the visual'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!selectedPulse?.fullLetterHtml && !showLetterEditor && (
                    <span className="text-xs font-semibold text-status-critical bg-status-critical/10 px-3 py-1 rounded-pill">Add Now</span>
                  )}
                  <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${showLetterEditor ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {showLetterEditor && (
                <div className="px-5 pb-5 border-t border-black/5">
                  <div className="mt-4">
                    <Label className="text-sm font-medium text-foreground mb-2 block">
                      Paste your email content (HTML)
                    </Label>
                    <p className="text-xs text-muted-foreground mb-3">
                      Copy your finalized email content and paste it here. Headings, bold text, lists, and links will all be preserved on the letter page.
                    </p>
                    {selectedPulse?.includeGraphs !== false && analysis?.charts && analysis.charts.length > 0 && (
                      <div className="bg-surface-warm-1 px-4 py-3 mb-3" data-testid="letter-placeholder-hint">
                        <p className="text-xs font-semibold text-foreground mb-1">Available chart placeholders:</p>
                        <p className="text-xs text-muted-foreground">
                          {analysis.charts.map((_: any, i: number) => `{{chart-${i + 1}}}`).join(', ')}
                          {' '}— these will be replaced with chart images when the letter is displayed.
                        </p>
                      </div>
                    )}
                    {supportingImages.length > 0 && (
                      <div className="bg-surface-warm-1 px-4 py-3 mb-3" data-testid="letter-image-placeholder-hint">
                        <p className="text-xs font-semibold text-foreground mb-1">Available image placeholders:</p>
                        <p className="text-xs text-muted-foreground">
                          {supportingImages.map(img => `{{image-${img.slot}}}`).join(', ')}
                          {' '}— these will be replaced with your uploaded supporting images when the letter is displayed.
                        </p>
                      </div>
                    )}
                    <Textarea
                      value={letterContent}
                      onChange={e => setLetterContent(e.target.value)}
                      placeholder={"Paste your email HTML here...\n\nExample:\n<h2>Monthly Market Update</h2>\n<p>This month we saw significant growth in...</p>"}
                      className="font-mono text-sm min-h-[240px] bg-card"
                      data-testid="textarea-letter-content"
                    />
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <div className="text-xs text-muted-foreground">
                      {letterContent.length > 0 ? `${letterContent.length.toLocaleString()} characters` : 'No content yet'}
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedPulse?.fullLetterHtml && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (!selectedPulse) return;
                            // Task #4802 — clear the editor and toast only after
                            // the server confirms; a failed removal leaves the
                            // pasted letter intact in the editor.
                            updateMutation.mutate(
                              { id: selectedPulse.id, data: { fullLetterHtml: null } },
                              {
                                onSuccess: () => {
                                  setLetterContent("");
                                  toast({ title: "Letter removed" });
                                },
                              }
                            );
                          }}
                          className="text-red-600 hover:text-red-700"
                          data-testid="button-remove-letter"
                        >
                          Remove Letter
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="bg-primary hover:bg-primary/90"
                        disabled={!letterContent.trim() || updateMutation.isPending}
                        onClick={() => {
                          if (!selectedPulse) return;
                          // Task #4802 — "Letter saved!" fires only on confirmed
                          // success; failures surface the real reason via the
                          // mutation-level destructive toast.
                          updateMutation.mutate(
                            { id: selectedPulse.id, data: { fullLetterHtml: letterContent.trim() } },
                            {
                              onSuccess: () => {
                                toast({ title: "Letter saved!", description: "The full letter will appear on the shared pulse page." });
                              },
                            }
                          );
                        }}
                        data-testid="button-save-letter"
                      >
                        {updateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
                        Save Letter
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Floating Chat Button */}
            {!chatOpen && (
              <button
                onClick={() => setChatOpen(true)}
                // FAB collider: the global comms button lifts above this pill on
                // mobile instead of stacking on the same corner (Task #4374). The
                // open chat window is deliberately not marked — it behaves like a
                // modal and may cover the comms button, like any dialog overlay.
                ref={fabColliderRef}
                className="fixed bottom-6 right-6 bg-primary text-primary-foreground p-4 rounded-pill shadow-lg hover:bg-primary/90 transition-all z-50 flex items-center gap-2"
                data-testid="button-open-chat"
              >
                <Sparkles className="w-5 h-5" />
                <span className="font-medium">Refine with AI</span>
              </button>
            )}

            {/* Floating Chat Window */}
            {chatOpen && (
              <div className="fixed bottom-6 right-6 w-96 bg-card shadow-2xl z-50 flex flex-col overflow-hidden border border-border" style={{ height: '500px' }}>
                {/* Chat Header */}
                <div className="p-4 bg-primary text-primary-foreground flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5" />
                    <span className="font-semibold">Refine This Visual</span>
                  </div>
                  <button 
                    onClick={() => setChatOpen(false)}
                    className="hover:bg-white/10 p-1 rounded"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                {/* Chat Messages */}
                <div className="flex-1 overflow-y-auto p-4" ref={chatScrollRef}>
                  {chatMessages.length === 0 ? (
                    <div className="space-y-3">
                      <p className="text-muted-foreground text-sm">Tell me what to change:</p>
                      <div className="space-y-2">
                        {[
                          "Change the headline to...",
                          "Add a takeaway about...",
                          "Remove the second implication",
                          "Make the tone more urgent",
                        ].map((suggestion, i) => (
                          <button
                            key={i}
                            onClick={() => setChatInput(suggestion)}
                            className="block w-full text-left p-3 bg-surface-warm-1 text-foreground text-sm hover:bg-secondary transition-colors"
                          >
                            "{suggestion}"
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {chatMessages.map((msg, i) => (
                        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[85%] p-3 text-sm ${
                            msg.role === "user" 
                              ? "bg-primary text-primary-foreground" 
                              : "bg-surface-warm-1 text-foreground"
                          }`}>
                            {msg.content}
                          </div>
                        </div>
                      ))}
                      {chatMutation.isPending && (
                        <div className="flex justify-start">
                          <div className="bg-surface-warm-1 p-3">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Chat Input */}
                <form onSubmit={handleChatSubmit} className="p-4 border-t flex gap-2">
                  <Input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder="What should I change?"
                    disabled={chatMutation.isPending}
                    className="flex-1"
                    data-testid="input-chat"
                  />
                  <Button 
                    type="submit" 
                    disabled={!chatInput.trim() || chatMutation.isPending}
                    className="bg-primary hover:bg-primary/90"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
