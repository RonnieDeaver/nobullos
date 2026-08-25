import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useParams } from "wouter";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Check, Video, Send, Loader2, StopCircle, Play, RotateCcw, Pencil, Clock, Lock, AlertTriangle } from "lucide-react";

type AssessmentItem = {
  id: string;
  prompt: string;
  type: "text" | "video" | "timed_text";
  layer: string;
  ordering_index: number;
  required: boolean;
  duration_sec?: number;
  time_limit_sec?: number;
  no_redo?: boolean;
  contradiction_pair_id?: string;
  contradiction_role?: string;
  trait_target?: string;
  maps_to_non_negotiable?: string;
};

type PortalSubmission = {
  questionId: string;
  questionType: string;
  hasResponse: boolean;
  responseText?: string | null;
  videoObjectKey?: string | null;
  questionLayer?: string | null;
  isTimed?: boolean;
  noRedo?: boolean;
  lockedAt?: string | null;
  timeUsedSec?: number | null;
};

type PortalData = {
  candidate: { id: string; name: string; stage: string };
  job: {
    title: string;
    screeningQuestions: Array<{ id: string; prompt: string; type: string; options?: string[]; required: boolean }> | null;
    videoTasks: Array<{ id: string; prompt: string; durationSec: number; required: boolean }> | null;
    assessmentJson: { items: AssessmentItem[]; meta: any } | null;
  };
  submissions: PortalSubmission[];
};

export default function CandidatePortal() {
  const { token } = useParams<{ token: string }>();

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submittedQuestions, setSubmittedQuestions] = useState<Set<string>>(new Set());
  const [editingQuestions, setEditingQuestions] = useState<Set<string>>(new Set());
  const [lockedQuestions, setLockedQuestions] = useState<Set<string>>(new Set());
  const [activeVideoTaskId, setActiveVideoTaskId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlobs, setRecordedBlobs] = useState<Record<string, Blob>>({});
  const [recordingTime, setRecordingTime] = useState(0);
  const [videoUploading, setVideoUploading] = useState<Record<string, boolean>>({});
  const [recordedDurations, setRecordedDurations] = useState<Record<string, number>>({});
  const [editingVideos, setEditingVideos] = useState<Set<string>>(new Set());
  const [timedActive, setTimedActive] = useState<string | null>(null);
  const [timedRemaining, setTimedRemaining] = useState(0);
  const [timedElapsed, setTimedElapsed] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [selfCorrectionTarget, setSelfCorrectionTarget] = useState<string | null>(null);
  const [pasteCountMap, setPasteCountMap] = useState<Record<string, number>>({});
  const [firstKeystrokeTimeMap, setFirstKeystrokeTimeMap] = useState<Record<string, number>>({});
  const [questionStartTimeMap, setQuestionStartTimeMap] = useState<Record<string, number>>({});
  const [typingStartTimeMap, setTypingStartTimeMap] = useState<Record<string, number>>({});
  const [cameraError, setCameraError] = useState<Record<string, boolean>>({});
  const [videoErrors, setVideoErrors] = useState<Record<string, string>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [completeError, setCompleteError] = useState<string | null>(null);

  const videoRefsMap = useRef<Record<string, HTMLVideoElement | null>>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingTimeRef = useRef(0);
  const activeVideoTaskIdRef = useRef<string | null>(null);
  const stressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const queryClient = useQueryClient();

  const { data: portal, isLoading, error } = useQuery<PortalData>({
    queryKey: ["/api/ats/portal", token],
    queryFn: async () => {
      const res = await fetch(`/api/ats/portal/${token}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const hasAssessmentJson = !!portal?.job.assessmentJson?.items?.length;

  const orderedItems: AssessmentItem[] = useMemo(
    () =>
      hasAssessmentJson
        ? [...(portal!.job.assessmentJson!.items)].sort((a, b) => a.ordering_index - b.ordering_index)
        : [
            ...((portal?.job.screeningQuestions || []).map((q, i) => ({
              id: q.id, prompt: q.prompt, type: "text" as const, layer: "role_skill",
              ordering_index: i, required: q.required,
            }))),
            ...((portal?.job.videoTasks || []).map((v, i) => ({
              id: v.id, prompt: v.prompt, type: "video" as const, layer: "role_skill",
              ordering_index: 100 + i, required: v.required, duration_sec: v.durationSec,
            }))),
          ],
    [hasAssessmentJson, portal],
  );

  useEffect(() => {
    if (portal?.submissions) {
      const submitted = new Set<string>(portal.submissions.filter(s => s.hasResponse).map(s => s.questionId));
      setSubmittedQuestions(submitted);
      const locked = new Set<string>(portal.submissions.filter(s => s.noRedo && s.lockedAt).map(s => s.questionId));
      setLockedQuestions(locked);

      const submittedAnswers: Record<string, string> = {};
      for (const s of portal.submissions) {
        if (s.responseText && (s.questionType === "text" || s.questionType === "timed_text")) {
          submittedAnswers[s.questionId] = s.responseText;
        }
      }
      setAnswers(prev => ({ ...submittedAnswers, ...prev }));

      const allDone = orderedItems.length > 0 && orderedItems.every(item => submitted.has(item.id));
      if (allDone) setIsComplete(true);
    }
  }, [portal, orderedItems]);

  const getVideoUrl = useCallback((objectKey: string) => objectKey.startsWith("/objects/") ? objectKey : `/objects/${objectKey}`, []);

  const trackQuestionStart = useCallback((questionId: string) => {
    setQuestionStartTimeMap(prev => {
      if (prev[questionId]) return prev;
      return { ...prev, [questionId]: Date.now() };
    });
  }, []);

  const handleTextChange = useCallback((questionId: string, value: string) => {
    const now = Date.now();
    setFirstKeystrokeTimeMap(prev => {
      if (prev[questionId]) return prev;
      const startTime = questionStartTimeMap[questionId] || now;
      return { ...prev, [questionId]: (now - startTime) / 1000 };
    });
    if (!typingStartTimeMap[questionId]) {
      setTypingStartTimeMap(prev => ({ ...prev, [questionId]: now }));
    }
    setAnswers(prev => ({ ...prev, [questionId]: value }));
  }, [questionStartTimeMap, typingStartTimeMap]);

  const handlePaste = useCallback((questionId: string) => {
    setPasteCountMap(prev => ({ ...prev, [questionId]: (prev[questionId] || 0) + 1 }));
  }, []);

  const getBehavioralMeta = useCallback((questionId: string) => {
    const now = Date.now();
    const typingStart = typingStartTimeMap[questionId];
    const totalTypingTimeSec = typingStart ? (now - typingStart) / 1000 : undefined;
    return {
      pasteEvents: pasteCountMap[questionId] || 0,
      timeToFirstKeystrokeSec: firstKeystrokeTimeMap[questionId] || undefined,
      totalTypingTimeSec,
    };
  }, [pasteCountMap, firstKeystrokeTimeMap, typingStartTimeMap]);

  const getSubmission = (questionId: string): PortalSubmission | undefined =>
    portal?.submissions.find(s => s.questionId === questionId);

  const getPriorAnswers = (): Array<{ id: string; prompt: string; answer: string }> => {
    if (!portal) return [];
    return orderedItems
      .filter(item => item.layer !== "self_correction" && item.layer !== "energy_audit" && (item.type === "text" || item.type === "timed_text"))
      .map(item => {
        const sub = getSubmission(item.id);
        if (!sub?.responseText) return null;
        return { id: item.id, prompt: item.prompt, answer: sub.responseText };
      })
      .filter(Boolean) as Array<{ id: string; prompt: string; answer: string }>;
  };

  const submitAnswerMutation = useMutation({
    mutationFn: async (params: {
      questionId: string; questionType: string; responseText: string;
      questionLayer?: string; isTimed?: boolean; timeLimitSec?: number;
      timeUsedSec?: number; noRedo?: boolean;
      contradictionPairId?: string; contradictionRole?: string; traitTarget?: string;
      pasteEvents?: number; timeToFirstKeystrokeSec?: number; totalTypingTimeSec?: number;
    }) => {
      const res = await fetch(`/api/ats/portal/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      setAnswerErrors(prev => {
        const next = { ...prev };
        delete next[variables.questionId];
        return next;
      });
      setSubmittedQuestions(prev => new Set<string>(Array.from(prev).concat(variables.questionId)));
      setEditingQuestions(prev => {
        const next = new Set(prev);
        next.delete(variables.questionId);
        return next;
      });
      if (variables.noRedo) {
        setLockedQuestions(prev => new Set(prev).add(variables.questionId));
      }
      if (timedActive === variables.questionId) {
        setTimedActive(null);
        if (stressTimerRef.current) clearInterval(stressTimerRef.current);
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/portal", token] }); // fire-and-forget: cache refresh only
    },
    onError: (_err, variables) => {
      setAnswerErrors(prev => ({
        ...prev,
        [variables.questionId]: "Couldn't save your answer. Check your connection and try again.",
      }));
    },
  });

  const completeAssessmentMutation = useMutation({
    mutationFn: async () => {
      const screeningRes = await fetch(`/api/ats/portal/${token}/complete-screening`, { method: "POST" });
      if (!screeningRes.ok) throw new Error("Failed to complete screening");
      const videoRes = await fetch(`/api/ats/portal/${token}/complete-video`, { method: "POST" });
      if (!videoRes.ok) throw new Error("Failed to complete video");
      return true;
    },
    onSuccess: () => {
      setCompleteError(null);
      setIsComplete(true);
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/portal", token] }); // fire-and-forget: cache refresh only
    },
    onError: () => {
      setCompleteError("Couldn't submit your application. Check your connection and try again.");
    },
  });

  const startStressTimer = useCallback((itemId: string, timeLimitSec: number) => {
    setTimedActive(itemId);
    setTimedRemaining(timeLimitSec);
    setTimedElapsed(0);
    stressTimerRef.current = setInterval(() => {
      setTimedElapsed(prev => prev + 1);
      setTimedRemaining(prev => {
        if (prev <= 1) {
          if (stressTimerRef.current) clearInterval(stressTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Ref-guard so the auto-submit fires exactly once per timed item even
  // though the effect now re-runs whenever any listed dependency changes
  // (previously it only keyed on `timedRemaining` and read stale values).
  const autoSubmittedTimedRef = useRef<Set<string>>(new Set());
  const { mutate: submitAnswer } = submitAnswerMutation;
  useEffect(() => {
    if (timedActive && timedRemaining <= 0) {
      const item = orderedItems.find(i => i.id === timedActive);
      if (
        item &&
        !submittedQuestions.has(item.id) &&
        !autoSubmittedTimedRef.current.has(item.id)
      ) {
        autoSubmittedTimedRef.current.add(item.id);
        submitAnswer({
          questionId: item.id,
          questionType: "timed_text",
          responseText: answers[item.id] || "(Time expired - no response submitted)",
          questionLayer: item.layer,
          isTimed: true,
          timeLimitSec: item.time_limit_sec,
          timeUsedSec: timedElapsed,
          noRedo: true,
          ...getBehavioralMeta(item.id),
        });
      }
    }
  }, [
    timedRemaining,
    timedActive,
    orderedItems,
    submittedQuestions,
    answers,
    timedElapsed,
    getBehavioralMeta,
    submitAnswer,
  ]);

  const startRecording = useCallback(async (taskId: string, maxDuration: number) => {
    setCameraError(prev => { const next = { ...prev }; delete next[taskId]; return next; });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      setActiveVideoTaskId(taskId);
      activeVideoTaskIdRef.current = taskId;
      const videoEl = videoRefsMap.current[taskId];
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.play().catch((err) => console.error("[CandidatePortal] video play failed:", err));
      }
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        setRecordedBlobs(prev => ({ ...prev, [taskId]: blob }));
        const el = videoRefsMap.current[taskId];
        if (el) { el.srcObject = null; el.src = URL.createObjectURL(blob); el.muted = false; }
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      };
      recorder.start(1000);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimeRef.current = 0;
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => {
          const next = prev + 1;
          recordingTimeRef.current = next;
          if (next >= maxDuration) {
            recorder.stop();
            setIsRecording(false);
            if (timerRef.current) clearInterval(timerRef.current);
            setRecordedDurations(p => ({ ...p, [taskId]: maxDuration }));
            return maxDuration;
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      console.error("Camera access error:", err);
      setCameraError(prev => ({ ...prev, [taskId]: true }));
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    const taskId = activeVideoTaskIdRef.current;
    const elapsed = recordingTimeRef.current;
    if (taskId) {
      setRecordedDurations(prev => ({ ...prev, [taskId]: elapsed }));
    }
  }, []);

  const submitVideoResponse = useCallback(async (taskId: string, item: AssessmentItem) => {
    const blob = recordedBlobs[taskId];
    if (!blob) return;
    // `recordingTimeRef.current` is always a number, so the old trailing
    // `?? recordingTime` fallback was dead code (and a stale closure read).
    const duration = recordedDurations[taskId] ?? recordingTimeRef.current;
    setVideoErrors(prev => { const next = { ...prev }; delete next[taskId]; return next; });
    setVideoUploading(prev => ({ ...prev, [taskId]: true }));
    try {
      const urlRes = await fetch(`/api/ats/portal/${token}/video-upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: taskId }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadUrl, objectPath } = await urlRes.json();
      await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/webm" }, body: blob });
      const submitRes = await fetch(`/api/ats/portal/${token}/submit-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: taskId, objectPath, durationSec: duration }),
      });
      if (!submitRes.ok) throw new Error("Failed to submit video");
      setSubmittedQuestions(prev => new Set<string>(Array.from(prev).concat(taskId)));
      setRecordedBlobs(prev => { const next = { ...prev }; delete next[taskId]; return next; });
      setRecordingTime(0);
      setActiveVideoTaskId(null);
      setEditingVideos(prev => { const next = new Set(prev); next.delete(taskId); return next; });
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/portal", token] }); // fire-and-forget: cache refresh only
    } catch (err) {
      console.error("Video upload error:", err);
      setVideoErrors(prev => ({ ...prev, [taskId]: "Couldn't upload your video. Check your connection and try again." }));
    }
    finally { setVideoUploading(prev => ({ ...prev, [taskId]: false })); }
  }, [recordedBlobs, recordedDurations, token, queryClient]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-surface-warm-1 to-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" role="status" aria-label="Loading your application" />
      </div>
    );
  }

  if (error || !portal) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-surface-warm-1 to-white flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-8 text-center">
            <h2 className="text-xl font-bold text-foreground mb-2">Link Not Found</h2>
            <p className="text-gray-600">This link is no longer valid or the position has been closed.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-surface-warm-1 to-white flex items-center justify-center">
        <Card className="max-w-lg">
          <CardContent className="p-10 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-600" aria-hidden="true" />
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-2" data-testid="text-complete-title">Application Complete</h2>
            <p className="text-gray-600 mb-4">
              Thank you, {portal.candidate.name}! Your responses for the <strong>{portal.job.title}</strong> position have been submitted.
            </p>
            <p className="text-sm text-gray-600">We'll be in touch soon.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalItems = orderedItems.length;
  const completedCount = orderedItems.filter(i => submittedQuestions.has(i.id)).length;
  const progressPct = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;

  const currentItem = orderedItems[currentStep];
  const allComplete = completedCount === totalItems && totalItems > 0;

  const renderTextQuestion = (item: AssessmentItem, index: number) => {
    const isSubmitted = submittedQuestions.has(item.id);
    const isLocked = lockedQuestions.has(item.id);
    const isEditing = editingQuestions.has(item.id);
    const showForm = !isSubmitted || isEditing;
    const submission = getSubmission(item.id);
    const isSelfCorrection = item.layer === "self_correction";

    return (
      <Card key={item.id} className={`border transition-colors ${isSubmitted && !isEditing ? "border-green-200 bg-green-50/30" : "border-gray-200"} ${isLocked ? "opacity-90" : ""}`}>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <span className={`text-xs font-mono px-2 py-1 rounded flex-shrink-0 ${isSubmitted && !isEditing ? "bg-green-100 text-green-700" : "bg-primary/10 text-primary"}`}>
              {isLocked ? <Lock className="w-3 h-3 inline" /> : isSubmitted && !isEditing ? <Check className="w-3 h-3 inline" /> : index + 1}
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium mb-2 break-words" id={`prompt-${item.id}`} data-testid={`text-prompt-${item.id}`}>{item.prompt}</p>
              {item.required && <Badge variant="outline" className="text-caption text-status-critical mb-2">Required</Badge>}

              {isSelfCorrection && showForm && (
                <div className="mb-3 space-y-2">
                  <p className="text-caption text-gray-600">Select a previous answer to revise:</p>
                  {getPriorAnswers().map(pa => (
                    <button
                      key={pa.id}
                      onClick={() => {
                        setSelfCorrectionTarget(pa.id);
                        setAnswers(prev => ({
                          ...prev,
                          [item.id]: `Revising answer to "${pa.prompt}":\n\nOriginal: ${pa.answer}\n\nRevised: `,
                        }));
                      }}
                      className={`w-full text-left text-caption p-2 rounded border transition-colors ${selfCorrectionTarget === pa.id ? "border-primary bg-primary/5" : "border-gray-200 hover:border-gray-300"}`}
                      data-testid={`button-select-revision-${pa.id}`}
                    >
                      <span className="font-medium">{pa.prompt.slice(0, 80)}...</span>
                      <span className="block text-gray-600 mt-1 truncate">{pa.answer.slice(0, 100)}...</span>
                    </button>
                  ))}
                </div>
              )}

              {showForm && (
                <div className="mt-2">
                  <Textarea
                    placeholder="Type your answer using specific details from your own experience..."
                    value={answers[item.id] || ""}
                    onFocus={() => trackQuestionStart(item.id)}
                    onChange={e => handleTextChange(item.id, e.target.value)}
                    onPaste={() => handlePaste(item.id)}
                    rows={4}
                    aria-labelledby={`prompt-${item.id}`}
                    data-testid={`input-answer-${item.id}`}
                  />
                  <p className="text-caption text-gray-600 mt-1">Use specific details from your own experience including numbers, tools, or outcomes when possible.</p>
                  <div className="flex gap-2 mt-2">
                    <Button
                      size="sm"
                      className="bg-primary hover:bg-primary/90"
                      disabled={!answers[item.id]?.trim() || submitAnswerMutation.isPending}
                      onClick={() => submitAnswerMutation.mutate({
                        questionId: item.id,
                        questionType: "text",
                        responseText: answers[item.id],
                        questionLayer: item.layer,
                        contradictionPairId: item.contradiction_pair_id,
                        contradictionRole: item.contradiction_role,
                        traitTarget: item.trait_target,
                        ...getBehavioralMeta(item.id),
                      })}
                      data-testid={`button-submit-answer-${item.id}`}
                    >
                      {submitAnswerMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" /> : <Send className="w-3 h-3 mr-1" aria-hidden="true" />}
                      {isEditing ? "Save Changes" : "Submit Answer"}
                    </Button>
                    {isEditing && (
                      <Button size="sm" variant="outline" onClick={() => {
                        setEditingQuestions(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                        if (submission?.responseText) setAnswers(prev => ({ ...prev, [item.id]: submission.responseText! }));
                      }} data-testid={`button-cancel-edit-${item.id}`}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  {answerErrors[item.id] && (
                    <div
                      role="alert"
                      className="mt-2 rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                      data-testid={`error-answer-${item.id}`}
                    >
                      {answerErrors[item.id]}
                    </div>
                  )}
                </div>
              )}

              {isSubmitted && !isEditing && (
                <div className="mt-2">
                  <p className="text-sm text-gray-600 bg-gray-50 rounded p-3 whitespace-pre-wrap break-words">{answers[item.id] || submission?.responseText || ""}</p>
                  {!isLocked && (
                    <Button size="sm" variant="ghost" className="mt-2 text-primary-ink hover:text-primary-ink/90 hover:bg-primary/5"
                      onClick={() => {
                        setEditingQuestions(prev => new Set(prev).add(item.id));
                        if (submission?.responseText && !answers[item.id]) setAnswers(prev => ({ ...prev, [item.id]: submission.responseText! }));
                      }}
                      data-testid={`button-edit-answer-${item.id}`}
                    >
                      <Pencil className="w-3 h-3 mr-1" aria-hidden="true" /> Edit Answer
                    </Button>
                  )}
                  {isLocked && (
                    <p className="text-caption text-gray-600 mt-2 flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden="true" /> This answer is locked and cannot be changed</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderTimedQuestion = (item: AssessmentItem, index: number) => {
    const isSubmitted = submittedQuestions.has(item.id);
    const isLocked = lockedQuestions.has(item.id);
    const isTimerActive = timedActive === item.id;
    const timeLimitSec = item.time_limit_sec || 300;
    const submission = getSubmission(item.id);

    if (isSubmitted || isLocked) {
      return (
        <Card key={item.id} className="border border-green-200 bg-green-50/30">
          <CardContent className="p-5">
            <div className="flex items-start gap-3">
              <span className="text-caption font-mono px-2 py-1 rounded bg-green-100 text-green-700 flex-shrink-0">
                <Lock className="w-3 h-3 inline" aria-hidden="true" />
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-caption text-orange-700 border-orange-300">Timed Response</Badge>
                  {submission?.timeUsedSec && <span className="text-caption text-gray-600">Completed in {formatTime(Math.round(submission.timeUsedSec))}</span>}
                </div>
                <p className="text-sm font-medium mb-2 break-words">{item.prompt}</p>
                <p className="text-sm text-gray-600 bg-gray-50 rounded p-3 whitespace-pre-wrap break-words">{submission?.responseText || answers[item.id] || ""}</p>
                <p className="text-caption text-gray-600 mt-2 flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden="true" /> This answer is locked and cannot be changed</p>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    if (!isTimerActive) {
      return (
        <Card key={item.id} className="border border-orange-200 bg-orange-50/20">
          <CardContent className="p-5">
            <div className="flex items-start gap-3">
              <span className="text-caption font-mono px-2 py-1 rounded bg-orange-100 text-orange-700 flex-shrink-0">
                <Clock className="w-3 h-3 inline" aria-hidden="true" />
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="outline" className="text-caption text-orange-700 border-orange-300">Timed Response</Badge>
                  <Badge variant="outline" className="text-caption text-status-critical border-red-300">Cannot be redone</Badge>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-orange-800">Before you begin</p>
                      <ul className="text-caption text-orange-700 mt-1 space-y-1">
                        <li>You will have <strong>{formatTime(timeLimitSec)}</strong> to answer this question</li>
                        <li>The timer starts when you click "Begin" below</li>
                        <li>Your answer will auto-submit when time runs out</li>
                        <li>You <strong>cannot</strong> edit your answer after submission</li>
                      </ul>
                    </div>
                  </div>
                </div>
                <Button
                  className="bg-orange-600 hover:bg-orange-700"
                  onClick={() => startStressTimer(item.id, timeLimitSec)}
                  data-testid={`button-start-timer-${item.id}`}
                >
                  <Clock className="w-4 h-4 mr-2" aria-hidden="true" /> Begin Timed Response
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    const urgencyLevel = timedRemaining < 60 ? "text-status-critical" : timedRemaining < 120 ? "text-status-warn" : "text-gray-700";

    return (
      <Card key={item.id} className="border-2 border-orange-400">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <Badge variant="outline" className="text-caption text-orange-700 border-orange-300">Timed Response</Badge>
            <div className={`font-mono text-lg font-bold ${urgencyLevel}`} data-testid={`text-timer-${item.id}`} role="status" aria-label={`Time remaining ${formatTime(timedRemaining)}`}>
              {formatTime(timedRemaining)}
            </div>
          </div>
          <Progress value={((timeLimitSec - timedRemaining) / timeLimitSec) * 100} className="mb-4 h-2" />
          <p className="text-sm font-medium mb-3 break-words" id={`prompt-${item.id}`} data-testid={`text-prompt-${item.id}`}>{item.prompt}</p>
          <Textarea
            placeholder="Type your answer..."
            value={answers[item.id] || ""}
            onFocus={() => trackQuestionStart(item.id)}
            onChange={e => handleTextChange(item.id, e.target.value)}
            onPaste={() => handlePaste(item.id)}
            rows={8}
            autoFocus
            aria-labelledby={`prompt-${item.id}`}
            data-testid={`input-answer-${item.id}`}
          />
          {answerErrors[item.id] && (
            <div
              role="alert"
              className="mt-3 rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
              data-testid={`error-answer-${item.id}`}
            >
              {answerErrors[item.id]}
            </div>
          )}
          <div className="flex justify-between items-center mt-3">
            <p className="text-caption text-gray-600">Your answer will auto-submit when time runs out</p>
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90"
              disabled={!answers[item.id]?.trim() || submitAnswerMutation.isPending}
              onClick={() => {
                if (stressTimerRef.current) clearInterval(stressTimerRef.current);
                submitAnswerMutation.mutate({
                  questionId: item.id,
                  questionType: "timed_text",
                  responseText: answers[item.id],
                  questionLayer: item.layer,
                  isTimed: true,
                  timeLimitSec: timeLimitSec,
                  timeUsedSec: timedElapsed,
                  noRedo: true,
                  ...getBehavioralMeta(item.id),
                });
              }}
              data-testid={`button-submit-timed-${item.id}`}
            >
              {submitAnswerMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" /> : <Send className="w-3 h-3 mr-1" aria-hidden="true" />}
              Submit Answer
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderVideoQuestion = (item: AssessmentItem, index: number) => {
    const isSubmitted = submittedQuestions.has(item.id);
    const isEditing = editingVideos.has(item.id);
    const hasBlob = !!recordedBlobs[item.id];
    const isThisRecording = isRecording && activeVideoTaskId === item.id;
    const canInteract = !isRecording || activeVideoTaskId === item.id;
    const submission = getSubmission(item.id);
    const showRecorder = !isSubmitted || isEditing;
    const maxDuration = item.duration_sec || 120;

    return (
      <Card key={item.id} className={`border transition-colors ${isSubmitted && !isEditing ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <span className={`text-caption font-mono px-2 py-1 rounded flex-shrink-0 ${isSubmitted && !isEditing ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700"}`}>
              {isSubmitted && !isEditing ? <Check className="w-3 h-3 inline" aria-hidden="true" /> : <Video className="w-3 h-3 inline" aria-hidden="true" />}
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium mb-1 break-words" data-testid={`text-prompt-${item.id}`}>{item.prompt}</p>
              <Badge variant="outline" className="text-caption mb-3">Max {maxDuration}s</Badge>

              {isSubmitted && !isEditing && (
                <div className="mt-3">
                  {submission?.videoObjectKey && (
                    <div className="aspect-video bg-black rounded-lg overflow-hidden mb-3">
                      <video ref={el => { videoRefsMap.current[`playback-${item.id}`] = el; }}
                        src={getVideoUrl(submission.videoObjectKey)} className="w-full h-full object-cover"
                        playsInline controls data-testid={`video-playback-${item.id}`} />
                    </div>
                  )}
                  <Button size="sm" variant="ghost" className="text-primary-ink hover:text-primary-ink/90 hover:bg-primary/5"
                    onClick={() => setEditingVideos(prev => new Set(prev).add(item.id))}
                    aria-label="Re-record video"
                    data-testid={`button-edit-video-${item.id}`}>
                    <RotateCcw className="w-3 h-3 mr-1" aria-hidden="true" /> Re-record
                  </Button>
                </div>
              )}

              {showRecorder && (
                <div className="mt-3">
                  <div className="aspect-video bg-black rounded-lg overflow-hidden mb-3">
                    <video ref={el => { videoRefsMap.current[item.id] = el; }}
                      className="w-full h-full object-cover" playsInline data-testid={`video-preview-${item.id}`} />
                  </div>

                  {isThisRecording && (
                    <div className="mb-3">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-status-critical flex items-center gap-1" role="status">
                          <span className="w-2 h-2 rounded-full bg-status-critical animate-pulse" aria-hidden="true" /> Recording
                        </span>
                        <span className="font-mono">{formatTime(recordingTime)} / {formatTime(maxDuration)}</span>
                      </div>
                      <Progress value={(recordingTime / maxDuration) * 100} className="h-2" />
                    </div>
                  )}

                  {cameraError[item.id] && (
                    <div
                      role="alert"
                      className="mb-3 rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                      data-testid={`error-camera-${item.id}`}
                    >
                      <p className="font-medium">Camera and microphone access is required</p>
                      <p className="mt-1 text-caption text-status-critical">
                        We couldn't reach your camera or microphone. Allow access in the browser permission prompt, or enable it in your browser settings, then try again.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() => startRecording(item.id, maxDuration)}
                        data-testid={`button-retry-camera-${item.id}`}
                      >
                        Try again
                      </Button>
                    </div>
                  )}

                  {videoErrors[item.id] && (
                    <div
                      role="alert"
                      className="mb-3 rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                      data-testid={`error-video-${item.id}`}
                    >
                      <p>{videoErrors[item.id]}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={videoUploading[item.id]}
                        onClick={() => submitVideoResponse(item.id, item)}
                        data-testid={`button-retry-video-${item.id}`}
                      >
                        Try again
                      </Button>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {!isThisRecording && !hasBlob && (
                      <Button size="sm" className="bg-red-600 hover:bg-red-700" disabled={!canInteract}
                        onClick={() => startRecording(item.id, maxDuration)} aria-label="Start recording" data-testid={`button-start-recording-${item.id}`}>
                        <Video className="w-3 h-3 mr-1" aria-hidden="true" /> Record
                      </Button>
                    )}
                    {isThisRecording && (
                      <Button size="sm" variant="destructive" onClick={stopRecording} aria-label="Stop recording" data-testid={`button-stop-recording-${item.id}`}>
                        <StopCircle className="w-3 h-3 mr-1" aria-hidden="true" /> Stop
                      </Button>
                    )}
                    {hasBlob && !isThisRecording && (
                      <>
                        <Button size="sm" className="bg-primary hover:bg-primary/90"
                          disabled={videoUploading[item.id]}
                          onClick={() => submitVideoResponse(item.id, item)}
                          data-testid={`button-submit-video-${item.id}`}>
                          {videoUploading[item.id] ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" /> : <Send className="w-3 h-3 mr-1" aria-hidden="true" />}
                          Submit Video
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => {
                          setRecordedBlobs(prev => { const next = { ...prev }; delete next[item.id]; return next; });
                          setRecordingTime(0);
                        }} aria-label="Re-record video" data-testid={`button-rerecord-${item.id}`}>
                          <RotateCcw className="w-3 h-3 mr-1" aria-hidden="true" /> Re-record
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => {
                          const el = videoRefsMap.current[item.id];
                          if (el) { el.currentTime = 0; el.muted = false; el.play().catch((err) => console.error("[CandidatePortal] video play failed:", err)); }
                        }} aria-label="Preview recorded video" data-testid={`button-play-preview-${item.id}`}>
                          <Play className="w-3 h-3 mr-1" aria-hidden="true" /> Preview
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderItem = (item: AssessmentItem, index: number) => {
    if (item.type === "timed_text") return renderTimedQuestion(item, index);
    if (item.type === "video") return renderVideoQuestion(item, index);
    return renderTextQuestion(item, index);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-warm-1 to-white">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-foreground" data-testid="text-portal-title">{portal.job.title}</h1>
          <p className="text-gray-600 mt-1">Welcome, {portal.candidate.name}</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6" data-testid="notice-integrity">
          <p className="text-sm font-medium text-amber-800 mb-1">Assessment Integrity Notice</p>
          <p className="text-caption text-amber-700">All written responses must be your own work. Do not use AI tools such as ChatGPT, Claude, Gemini, or similar systems to generate answers. We evaluate your responses for clarity, reasoning, and decision-making style. When possible, answer using real situations from your own experience with specific details such as tools, numbers, and outcomes.</p>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between text-caption text-gray-600 mb-1" role="status">
            <span>{completedCount} of {totalItems} completed</span>
            <span>{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-2" />
        </div>

        {timedActive && (
          <div className="fixed top-0 left-0 right-0 bg-orange-500 text-white text-center py-2 z-50 font-mono text-sm" role="status" data-testid="text-global-timer">
            Timed response in progress — {formatTime(timedRemaining)} remaining
          </div>
        )}

        <div className="space-y-4">
          {orderedItems.map((item, index) => renderItem(item, index))}
        </div>

        {allComplete && (
          <div className="text-center pt-6">
            <Button
              className="bg-primary hover:bg-primary/90 px-8"
              onClick={() => completeAssessmentMutation.mutate()}
              disabled={completeAssessmentMutation.isPending}
              data-testid="button-complete-assessment"
            >
              {completeAssessmentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" aria-hidden="true" /> : null}
              Submit Application
            </Button>
            {completeError && (
              <div
                role="alert"
                className="mt-3 rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                data-testid="error-complete"
              >
                {completeError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
