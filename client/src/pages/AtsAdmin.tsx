import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtsInfiniteList } from "@/lib/atsListPagination";
import { apiRequest } from "@/lib/queryClient";
import { logActivity } from "@/hooks/use-activity-tracker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { PageHeader } from "@/components/admin/PageHeader";
import { describeAtsTranscriptionFailure } from "@shared/models/ats";
import React from "react";

class AtsErrorBoundary extends React.Component<{ children: React.ReactNode; onReset?: () => void }, { hasError: boolean; error: Error | null }> {
  constructor(props: any) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error("[ATS Error Boundary]", error, info.componentStack); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center">
          <p className="text-red-600 font-medium mb-2">Something went wrong rendering this view.</p>
          <p className="text-xs text-muted-foreground mb-3">{this.state.error?.message}</p>
          <button className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm" onClick={() => { this.setState({ hasError: false, error: null }); this.props.onReset?.(); }}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  Plus, Sparkles, Users, Copy, Check, UserPlus, Loader2,
  ChevronRight, ChevronDown, X, GripVertical, Pencil, Upload, BarChart3,
  ArrowRight, FileText, AlertTriangle, Target, Star, CheckCircle, AlertCircle, Trash2, RefreshCw, Shield, TrendingUp, Eye
} from "lucide-react";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  type AtsJob, type AtsCandidate, type AtsSubmission, type AtsEmailTemplate,
  type AtsInterview, type AtsFinalDecision, type JobAnalytics,
  type DimensionHistoryEntry,
  stageColors, stageLabels, kanbanStages, kanbanStageMapping,
  kanbanStageLabels, kanbanStageColors, scoredStages,
} from "./ats/types";

const EVIDENCE_CONFIDENCE_MAP: Record<number, number> = { 0: 10, 1: 40, 2: 55, 3: 70, 4: 85, 5: 95 };
function getEvidenceConfidence(stageCount: number): number {
  return EVIDENCE_CONFIDENCE_MAP[Math.min(stageCount, 5)] ?? 10;
}

export default function AtsAdmin() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Applicant Tracker");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showCreateJob, setShowCreateJob] = useState(false);
  const [newJobTitle, setNewJobTitle] = useState("");
  const [newJobDescription, setNewJobDescription] = useState("");
  const [parsingFile, setParsingFile] = useState(false);
  const [scorecardText, setScorecardText] = useState("");
  const [scorecardJson, setScorecardJson] = useState<any>(null);
  const [parsingScorecard, setParsingScorecard] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    try { return localStorage.getItem("ats_selected_job_id"); } catch { return null; }
  });
  const [showAddCandidate, setShowAddCandidate] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [candidatePhone, setCandidatePhone] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("pipeline");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [editingQuestions, setEditingQuestions] = useState(false);
  const [editedQuestions, setEditedQuestions] = useState<any[]>([]);
  const [editingVideoTasks, setEditingVideoTasks] = useState(false);
  const [editedVideoTasks, setEditedVideoTasks] = useState<any[]>([]);
  const [editingRubric, setEditingRubric] = useState(false);
  const [editedRubricDimensions, setEditedRubricDimensions] = useState<any[]>([]);
  const [editedHardFails, setEditedHardFails] = useState<string[]>([]);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [candidateNotes, setCandidateNotes] = useState("");
  const [showRegenerateFeedback, setShowRegenerateFeedback] = useState(false);
  const [regenerateFeedbackText, setRegenerateFeedbackText] = useState("");
  const [showDecisionFeedback, setShowDecisionFeedback] = useState(false);
  const [decisionFeedbackText, setDecisionFeedbackText] = useState("");
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [templateType, setTemplateType] = useState("invite");
  const [templateIsGlobal, setTemplateIsGlobal] = useState(false);
  const [previewCandidate, setPreviewCandidate] = useState<AtsCandidate | null>(null);
  const [interviewTranscript, setInterviewTranscript] = useState("");
  const [interviewNotes, setInterviewNotes] = useState("");
  const [interviewType, setInterviewType] = useState<string>("phone");
  const [showInterviewUpload, setShowInterviewUpload] = useState(false);
  const [focusRatings, setFocusRatings] = useState<Record<string, number>>({});
  const [editingInterviewId, setEditingInterviewId] = useState<string | null>(null);
  const [editTranscript, setEditTranscript] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [candidateDetailTab, setCandidateDetailTab] = useState("overview");
  const [genProgress, setGenProgress] = useState<{ active: boolean; startTime: number; elapsed: number; stage: number } | null>(null);
  const genTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startGenTimer = useCallback(() => {
    const startTime = Date.now();
    setGenProgress({ active: true, startTime, elapsed: 0, stage: 1 });
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    genTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const stage = elapsed < 15 ? 1 : elapsed < 25 ? 2 : elapsed < 120 ? 3 : 4;
      setGenProgress(prev => prev ? { ...prev, elapsed, stage } : null);
    }, 500);
  }, []);

  const stopGenTimer = useCallback(() => {
    if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
    setGenProgress(null);
  }, []);

  useEffect(() => { return () => { if (genTimerRef.current) clearInterval(genTimerRef.current); }; }, []);

  // Task #3979: cursor-paginated endpoint consumed one page at a time — the
  // job picker renders what has been fetched so far and loads more on demand.
  const {
    items: jobs,
    isLoading: jobsLoading,
    hasNextPage: jobsHasNextPage,
    isFetchingNextPage: jobsFetchingNextPage,
    fetchNextPage: fetchNextJobsPage,
  } = useAtsInfiniteList<AtsJob>({
    queryKey: ["/api/ats/jobs"],
    basePath: "/api/ats/jobs",
    itemsKey: "jobs",
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });

  useEffect(() => {
    if (jobs.length === 0) return;
    if (selectedJobId && jobs.find(j => j.id === selectedJobId)) return;
    const stored = localStorage.getItem("ats_selected_job_id");
    const match = stored && jobs.find(j => j.id === stored);
    setSelectedJobId(match ? stored : jobs[0].id);
  }, [jobs, selectedJobId]);

  useEffect(() => {
    if (selectedJobId) {
      try { localStorage.setItem("ats_selected_job_id", selectedJobId); } catch {}
    }
  }, [selectedJobId]);

  const selectedJob = jobs.find(j => j.id === selectedJobId) || null;

  // Task #4005: candidates now page on demand through the shared cursor
  // envelope like jobs/submissions/interviews (Task #3979 pattern) — pools
  // beyond the first page no longer silently truncate; a Load More control
  // under the board fetches the next page.
  const {
    items: candidates,
    hasNextPage: candidatesHasNextPage,
    isFetchingNextPage: candidatesFetchingNextPage,
    fetchNextPage: fetchNextCandidatesPage,
  } = useAtsInfiniteList<AtsCandidate>({
    queryKey: ["/api/ats/jobs", selectedJobId, "candidates"],
    basePath: `/api/ats/jobs/${selectedJobId}/candidates`,
    itemsKey: "candidates",
    enabled: !!selectedJobId,
  });

  const selectedCandidate = candidates.find(c => c.id === selectedCandidateId) || null;

  // Task #3979: one page at a time; a Load More control fetches the rest on
  // demand instead of walking every continuation page up-front.
  const {
    items: submissions,
    hasNextPage: submissionsHasNextPage,
    isFetchingNextPage: submissionsFetchingNextPage,
    fetchNextPage: fetchNextSubmissionsPage,
  } = useAtsInfiniteList<AtsSubmission>({
    queryKey: ["/api/ats/candidates", selectedCandidateId, "submissions"],
    basePath: `/api/ats/candidates/${selectedCandidateId}/submissions`,
    itemsKey: "submissions",
    enabled: !!selectedCandidateId,
  });

  const { data: analytics } = useQuery<JobAnalytics>({
    queryKey: ["/api/ats/jobs", selectedJobId, "analytics"],
    enabled: !!selectedJobId && activeTab === "analytics",
    queryFn: async () => {
      const res = await fetch(`/api/ats/jobs/${selectedJobId}/analytics`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch analytics");
      return res.json();
    },
  });

  const { data: emailTemplates = [] } = useQuery<AtsEmailTemplate[]>({
    queryKey: ["/api/ats/email-templates", selectedJobId],
    enabled: !!selectedJobId && activeTab === "templates",
    queryFn: async () => {
      const res = await fetch(`/api/ats/email-templates?jobId=${selectedJobId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
  });

  // Task #3979: one page at a time with a Load More control (see above).
  const {
    items: interviews,
    hasNextPage: interviewsHasNextPage,
    isFetchingNextPage: interviewsFetchingNextPage,
    fetchNextPage: fetchNextInterviewsPage,
  } = useAtsInfiniteList<AtsInterview>({
    queryKey: ["/api/ats/candidates", selectedCandidateId, "interviews"],
    basePath: `/api/ats/candidates/${selectedCandidateId}/interviews`,
    itemsKey: "interviews",
    enabled: !!selectedCandidateId,
  });

  const { data: finalDecision } = useQuery<AtsFinalDecision | null>({
    queryKey: ["/api/ats/candidates", selectedCandidateId, "final-decision"],
    enabled: !!selectedCandidateId,
    queryFn: async () => {
      const res = await fetch(`/api/ats/candidates/${selectedCandidateId}/final-decision`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch final decision");
      return res.json();
    },
  });

  const uploadInterviewMutation = useMutation({
    mutationFn: async ({ candidateId, type, transcript, interviewNotes, manualRatings }: { candidateId: string; type: string; transcript?: string; interviewNotes?: string; manualRatings?: Record<string, number> }) => {
      const res = await apiRequest("POST", `/api/ats/candidates/${candidateId}/interviews`, {
        interviewType: type,
        transcript: transcript || undefined,
        interviewNotes: interviewNotes || undefined,
        manualRatings,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "interviews"] }); // fire-and-forget: cache refresh only
      setInterviewTranscript("");
      setInterviewNotes("");
      setShowInterviewUpload(false);
      setFocusRatings({});
      logActivity("action", "Uploaded ATS interview", { candidateId: selectedCandidateId });
      toast({ title: "Interview uploaded" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const analyzeInterviewMutation = useMutation({
    mutationFn: async ({ candidateId, interviewId }: { candidateId: string; interviewId: string }) => {
      const res = await apiRequest("POST", `/api/ats/candidates/${candidateId}/interviews/${interviewId}/analyze`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "interviews"] }); // fire-and-forget: cache refresh only
      toast({ title: "Interview analyzed" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteInterviewMutation = useMutation({
    mutationFn: async ({ candidateId, interviewId }: { candidateId: string; interviewId: string }) => {
      await apiRequest("DELETE", `/api/ats/candidates/${candidateId}/interviews/${interviewId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "interviews"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      toast({ title: "Interview deleted" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const editInterviewMutation = useMutation({
    mutationFn: async ({ candidateId, interviewId, transcript, interviewNotes }: { candidateId: string; interviewId: string; transcript?: string; interviewNotes?: string }) => {
      const res = await apiRequest("PATCH", `/api/ats/candidates/${candidateId}/interviews/${interviewId}`, {
        transcript,
        interviewNotes,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "interviews"] }); // fire-and-forget: cache refresh only
      setEditingInterviewId(null);
      setEditTranscript("");
      setEditNotes("");
      toast({ title: "Interview updated" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const generateFinalDecisionMutation = useMutation({
    mutationFn: async ({ candidateId, feedback }: { candidateId: string; feedback?: string }) => {
      const res = await apiRequest("POST", `/api/ats/candidates/${candidateId}/final-decision`, { feedback });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "final-decision"] }); // fire-and-forget: cache refresh only
      logActivity("action", "Generated ATS final decision", { candidateId: selectedCandidateId });
      toast({ title: "Final decision generated" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const approveFinalDecisionMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const res = await apiRequest("POST", `/api/ats/candidates/${candidateId}/final-decision/approve`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/candidates", selectedCandidateId, "final-decision"] }); // fire-and-forget: cache refresh only
      toast({ title: "Decision approved" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const candidatesByStage = useMemo(() => {
    const map: Record<string, AtsCandidate[]> = {};
    for (const s of kanbanStages) map[s] = [];
    for (const c of candidates) {
      if (c.stage === "rejected" || c.stage === "withdrawn") continue;
      const mappedStage = kanbanStageMapping[c.stage] || c.stage;
      if (map[mappedStage]) map[mappedStage].push(c);
    }
    for (const s of kanbanStages) {
      if (scoredStages.has(s)) {
        map[s].sort((a, b) => {
          const aRank = a.cohortRank ?? 9999;
          const bRank = b.cohortRank ?? 9999;
          if (aRank !== bRank) return aRank - bRank;
          return ((b.finalDisplayScore ?? b.calibratedScore ?? b.totalScore) ?? -1) - ((a.finalDisplayScore ?? a.calibratedScore ?? a.totalScore) ?? -1);
        });
      }
    }
    return map;
  }, [candidates]);

  const rejectedCandidates = useMemo(() => candidates.filter(c => c.stage === "rejected" || c.stage === "withdrawn"), [candidates]);

  const createJobMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ats/jobs", {
        title: newJobTitle,
        description: newJobDescription,
        scorecardText: scorecardText || undefined,
        scorecardJson: scorecardJson || undefined,
      });
      return res.json();
    },
    onSuccess: (job: AtsJob) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs"] }); // fire-and-forget: cache refresh only
      setShowCreateJob(false);
      setNewJobTitle("");
      setNewJobDescription("");
      setScorecardText("");
      setScorecardJson(null);
      setSelectedJobId(job.id);
      logActivity("save", "Created ATS job", { jobId: job.id, title: newJobTitle });
      toast({ title: "Job created" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: async ({ jobId, feedback }: { jobId: string; feedback?: string }) => {
      startGenTimer();
      const res = await apiRequest("POST", `/api/ats/jobs/${jobId}/generate`, { feedback });
      return res.json();
    },
    onSuccess: () => {
      stopGenTimer();
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs"] }); // fire-and-forget: cache refresh only
      toast({ title: "AI interview flow generated" });
    },
    onError: (err: Error) => {
      stopGenTimer();
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const updateJobMutation = useMutation({
    mutationFn: async ({ jobId, data }: { jobId: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/ats/jobs/${jobId}`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs"] }); // fire-and-forget: cache refresh only
      toast({ title: "Job updated" });
      setEditingQuestions(false);
      setEditingVideoTasks(false);
      setEditingRubric(false);
    },
  });

  const addCandidateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/ats/jobs/${selectedJobId}/candidates`, {
        name: candidateName, email: candidateEmail, phone: candidatePhone || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      setShowAddCandidate(false);
      setCandidateName(""); setCandidateEmail(""); setCandidatePhone("");
      logActivity("action", "Added ATS candidate", { jobId: selectedJobId, candidateName });
      toast({ title: "Candidate added" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const updateCandidateMutation = useMutation({
    mutationFn: async ({ candidateId, data }: { candidateId: string; data: any }) => {
      const res = await apiRequest("PATCH", `/api/ats/candidates/${candidateId}`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
    },
  });

  const deleteCandidateMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const res = await apiRequest("DELETE", `/api/ats/candidates/${candidateId}`);
      return res.json();
    },
    onMutate: async (candidateId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] });
      const previousCandidates = queryClient.getQueryData(["/api/ats/jobs", selectedJobId, "candidates"]);
      // Task #4005: the candidates cache is infinite-query shaped
      // ({ pages: [{ items, nextCursor }] }) — filter the deleted row out of
      // every fetched page. Keep the legacy bare-array branch for safety.
      queryClient.setQueryData(["/api/ats/jobs", selectedJobId, "candidates"], (old: any) => {
        if (Array.isArray(old)) return old.filter((c: any) => c.id !== candidateId);
        if (old && Array.isArray(old.pages)) {
          return {
            ...old,
            pages: old.pages.map((p: any) =>
              p && Array.isArray(p.items)
                ? { ...p, items: p.items.filter((c: any) => c.id !== candidateId) }
                : p,
            ),
          };
        }
        return old;
      });
      if (selectedCandidateId === candidateId) {
        setSelectedCandidateId(null);
      }
      return { previousCandidates };
    },
    onError: (err: Error, _candidateId, context) => {
      if (context?.previousCandidates) {
        queryClient.setQueryData(["/api/ats/jobs", selectedJobId, "candidates"], context.previousCandidates);
      }
      toast({ title: err.message, variant: "destructive" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
    },
    onSuccess: () => {
      toast({ title: "Candidate deleted" });
    },
  });

  const retryTranscriptionMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const res = await apiRequest("POST", `/api/ats/candidates/${candidateId}/retry-transcription`);
      return res.json();
    },
    onSuccess: (data: any) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      if (selectedCandidateId) {
        void queryClient.invalidateQueries({ queryKey: [`/api/ats/candidates/${selectedCandidateId}/submissions`] }); // fire-and-forget: cache refresh only
      }
      toast({ title: data.message || "Retranscribing videos..." });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const [scoringCandidateIds, setScoringCandidateIds] = useState<Set<string>>(new Set());
  const [scoreQueue, setScoreQueue] = useState<string[]>([]);
  const [scoreQueueTotal, setScoreQueueTotal] = useState(0);
  const [scoreQueueDone, setScoreQueueDone] = useState(0);
  const scoreQueueProcessingRef = useRef(false);
  const scoreQueueDoneRef = useRef(0);
  const scoreQueueErrorsRef = useRef(0);

  const enqueueScore = useCallback((candidateId: string) => {
    setScoringCandidateIds(prev => new Set(prev).add(candidateId));
    setScoreQueue(prev => {
      if (prev.includes(candidateId)) return prev;
      if (prev.length === 0) {
        scoreQueueDoneRef.current = 0;
        scoreQueueErrorsRef.current = 0;
        setScoreQueueDone(0);
      }
      const next = [...prev, candidateId];
      setScoreQueueTotal(next.length);
      return next;
    });
  }, []);

  const enqueueScoreAll = useCallback(() => {
    const scorable = candidates.filter(c =>
      c.stage !== "rejected" && c.stage !== "withdrawn" &&
      (c.stage === "screening" || c.stage === "video" || c.stage === "answers_received" ||
       c.stage === "ai_scored" || c.aiScoreJson)
    );
    if (scorable.length === 0) {
      toast({ title: "No candidates to score" });
      return;
    }
    scoreQueueDoneRef.current = 0;
    scoreQueueErrorsRef.current = 0;
    setScoreQueueDone(0);
    setScoreQueue(prev => {
      const existing = new Set(prev);
      const next = [...prev];
      let added = 0;
      for (const c of scorable) {
        if (!existing.has(c.id)) {
          next.push(c.id);
          existing.add(c.id);
          added++;
        }
      }
      setScoreQueueTotal(next.length);
      return next;
    });
    setScoringCandidateIds(prev => {
      const next = new Set(prev);
      for (const c of scorable) next.add(c.id);
      return next;
    });
    toast({ title: `Queued ${scorable.length} candidates for scoring` });
  }, [candidates, toast]);

  useEffect(() => {
    if (scoreQueue.length === 0 || scoreQueueProcessingRef.current) return;
    scoreQueueProcessingRef.current = true;

    const candidateId = scoreQueue[0];
    const isLastItem = scoreQueue.length === 1;
    void (async () => { // fire-and-forget: background scoring, errors handled inside
      let succeeded = false;
      try {
        await apiRequest("POST", `/api/ats/candidates/${candidateId}/score`, {});
        succeeded = true;
        scoreQueueDoneRef.current++;
        setScoreQueueDone(scoreQueueDoneRef.current);
        void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      } catch (err: any) {
        scoreQueueErrorsRef.current++;
        toast({ title: `Scoring failed: ${err.message}`, variant: "destructive" });
      } finally {
        setScoringCandidateIds(prev => { const next = new Set(prev); next.delete(candidateId); return next; });
        if (isLastItem) {
          const total = scoreQueueDoneRef.current + scoreQueueErrorsRef.current;
          if (total > 1) {
            toast({ title: `Scoring complete: ${scoreQueueDoneRef.current} scored${scoreQueueErrorsRef.current > 0 ? `, ${scoreQueueErrorsRef.current} failed` : ""}` });
          } else if (total === 1 && succeeded) {
            toast({ title: "Candidate scored by AI" });
          }
          setScoreQueueTotal(0);
          setScoreQueueDone(0);
          scoreQueueDoneRef.current = 0;
          scoreQueueErrorsRef.current = 0;
        }
        scoreQueueProcessingRef.current = false;
        setScoreQueue(prev => prev.slice(1));
      }
    })();
  }, [scoreQueue, selectedJobId, queryClient, toast]);

  const csvImportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/ats/jobs/${selectedJobId}/candidates/import-csv`, { csvText });
      return res.json();
    },
    onSuccess: (data: any) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      setShowCsvImport(false);
      setCsvText("");
      toast({ title: `Imported ${data.created} candidates${data.errors?.length ? `, ${data.errors.length} errors` : ""}` });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: async (stage: string) => {
      const res = await apiRequest("POST", `/api/ats/jobs/${selectedJobId}/candidates/bulk-update`, {
        candidateIds: Array.from(bulkSelected),
        stage,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      setBulkSelected(new Set());
      toast({ title: `Updated ${data.updated} candidates` });
    },
  });

  const createTemplateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ats/email-templates", {
        name: templateName,
        subject: templateSubject,
        body: templateBody,
        templateType: templateType,
        jobId: templateIsGlobal ? null : selectedJobId,
        isGlobal: templateIsGlobal,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/email-templates", selectedJobId] }); // fire-and-forget: cache refresh only
      setShowCreateTemplate(false);
      resetTemplateForm();
      toast({ title: "Template created" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const updateTemplateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/ats/email-templates/${editingTemplateId}`, {
        name: templateName,
        subject: templateSubject,
        body: templateBody,
        templateType: templateType,
        isGlobal: templateIsGlobal,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/email-templates", selectedJobId] }); // fire-and-forget: cache refresh only
      setEditingTemplateId(null);
      resetTemplateForm();
      toast({ title: "Template updated" });
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/ats/email-templates/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/email-templates", selectedJobId] }); // fire-and-forget: cache refresh only
      toast({ title: "Template deleted" });
    },
  });

  const recalibrateMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await apiRequest("POST", `/api/ats/jobs/${jobId}/recalibrate`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/ats/jobs", selectedJobId, "candidates"] }); // fire-and-forget: cache refresh only
      toast({ title: "Cohort recalibrated" });
    },
    onError: (error: any) => {
      toast({ title: "Recalibration failed", description: error.message, variant: "destructive" });
    },
  });

  const resetTemplateForm = () => {
    setTemplateName("");
    setTemplateSubject("");
    setTemplateBody("");
    setTemplateType("invite");
    setTemplateIsGlobal(false);
  };

  const fillVariables = (text: string, candidate?: AtsCandidate | null) => {
    const c = candidate || previewCandidate;
    return text
      .replace(/\{\{candidate_name\}\}/g, c?.name || "[Candidate Name]")
      .replace(/\{\{candidate_email\}\}/g, c?.email || "[candidate@email.com]")
      .replace(/\{\{job_title\}\}/g, selectedJob?.title || "[Job Title]")
      .replace(/\{\{portal_link\}\}/g, c ? `${window.location.origin}/apply/${c.accessToken}` : "[Portal Link]")
      .replace(/\{\{company_name\}\}/g, "No Bull Marketing");
  };

  const copyPortalLink = (candidate: AtsCandidate) => {
    const url = `${window.location.origin}/apply/${candidate.accessToken}`;
    navigator.clipboard.writeText(url).catch((err) => console.error("[AtsAdmin] clipboard write failed:", err));
    setCopiedToken(candidate.id);
    toast({ title: "Portal link copied" });
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const toggleBulkSelect = (id: string) => {
    setBulkSelected(prev => {
      const next = new Set(Array.from(prev));
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const moveQuestion = (arr: any[], from: number, to: number) => {
    const copy = [...arr];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  };

  if (authLoading) return null;
  if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center bg-surface-warm-1">
        <Card><CardContent className="p-8 text-center">
          <p className="text-foreground">Access restricted to Team Lead and above.</p>
          <Button asChild className="mt-4" variant="outline"><Link href="/">Back to Dashboard</Link></Button>
        </CardContent></Card>
      </div>
    );
  }

  const renderInterviewCard = (interview: AtsInterview) => {
    const typeLabels: Record<string, string> = { phone: "Phone Screen", story: "Story Interview", reference: "Reference Interview", focus: "Focus Interview" };
    const a = interview.analysisJson as any;
    const isAnalyzing = analyzeInterviewMutation.isPending;

    return (
      <Card key={interview.id} className="border-border" data-testid={`card-interview-${interview.id}`}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-sm">{typeLabels[interview.interviewType] || interview.interviewType}</CardTitle>
              {interview.transcript && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-muted/50">transcript</Badge>}
              {interview.interviewNotes && <Badge variant="outline" className="text-[10px] h-4 px-1 bg-blue-50 text-blue-600 border-blue-200">notes</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`text-xs ${interview.analysisStatus === "analyzed" ? "bg-green-50 text-green-700" : interview.analysisStatus === "analyzing" ? "bg-blue-50 text-blue-700" : "bg-muted/50"}`}>
                {interview.analysisStatus}
              </Badge>
              {interview.analysisStatus === "uploaded" && (
                <Button size="sm" variant="outline" className="h-6 text-xs" disabled={isAnalyzing}
                  onClick={() => analyzeInterviewMutation.mutate({ candidateId: interview.candidateId, interviewId: interview.id })}
                  data-testid={`button-analyze-${interview.id}`}>
                  {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                  Analyze
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-600"
                onClick={() => {
                  setEditingInterviewId(editingInterviewId === interview.id ? null : interview.id);
                  setEditTranscript(interview.transcript || "");
                  setEditNotes(interview.interviewNotes || "");
                }}
                data-testid={`button-edit-interview-${interview.id}`}>
                <Pencil className="w-3 h-3" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                    disabled={deleteInterviewMutation.isPending}
                    data-testid={`button-delete-interview-${interview.id}`}>
                    {deleteInterviewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Interview</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete this {typeLabels[interview.interviewType]?.toLowerCase() || interview.interviewType}? This action cannot be undone and the candidate's scores will be recalculated.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-red-600 hover:bg-red-700"
                      onClick={() => deleteInterviewMutation.mutate({ candidateId: interview.candidateId, interviewId: interview.id })}
                      data-testid={`button-confirm-delete-interview-${interview.id}`}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        {editingInterviewId === interview.id && (
          <div className="px-4 pb-3 space-y-3 border-t border-blue-100 bg-blue-50/30 pt-3" data-testid={`edit-interview-form-${interview.id}`}>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Transcript</p>
              <Textarea
                value={editTranscript}
                onChange={e => setEditTranscript(e.target.value)}
                placeholder="Interview transcript..."
                rows={5}
                className="text-xs"
                data-testid={`edit-transcript-${interview.id}`}
              />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Interviewer Notes</p>
              <Textarea
                value={editNotes}
                onChange={e => setEditNotes(e.target.value)}
                placeholder="Interviewer notes..."
                rows={3}
                className="text-xs"
                data-testid={`edit-notes-${interview.id}`}
              />
            </div>
            <p className="text-[10px] text-amber-600">Saving will reset analysis status to "uploaded" so you can re-analyze with updated content.</p>
            <div className="flex gap-2">
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-xs"
                disabled={editInterviewMutation.isPending}
                onClick={() => editInterviewMutation.mutate({
                  candidateId: interview.candidateId,
                  interviewId: interview.id,
                  transcript: editTranscript.trim() || undefined,
                  interviewNotes: editNotes.trim() || undefined,
                })}
                data-testid={`button-save-edit-${interview.id}`}>
                {editInterviewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Save Changes
              </Button>
              <Button size="sm" variant="ghost" className="text-xs"
                onClick={() => { setEditingInterviewId(null); setEditTranscript(""); setEditNotes(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <CardContent className="space-y-3">
          {interview.transcript && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View Transcript ({interview.transcript.length.toLocaleString()} chars)</summary>
              <pre className="mt-2 p-2 bg-muted/50 rounded border text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">{interview.transcript}</pre>
            </details>
          )}
          {interview.interviewNotes && (
            <details className="text-xs">
              <summary className="cursor-pointer text-blue-500 hover:text-blue-700">View Notes ({interview.interviewNotes.length.toLocaleString()} chars)</summary>
              <pre className="mt-2 p-2 bg-blue-50 rounded border border-blue-200 text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">{interview.interviewNotes}</pre>
            </details>
          )}
          {a && interview.interviewType === "phone" && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">{a.summary}</p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Professionalism:</span> <Badge variant="outline" className="text-xs ml-1">{a.professionalismSignal}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Technical:</span> <Badge variant="outline" className="text-xs ml-1">{a.technicalViabilitySignal}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Self-reflection:</span> <Badge variant="outline" className="text-xs ml-1">{a.selfReflectionSignal}</Badge></div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Career Clarity:</span> {a.careerClarity}</div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Comp Fit:</span> {a.compensationFitSignal}</div>
              </div>
              {a.strengths?.length > 0 && <div className="text-xs"><p className="font-medium text-green-700">Strengths</p>{a.strengths.map((s: string, i: number) => <p key={i} className="text-muted-foreground">+ {s}</p>)}</div>}
              {a.concerns?.length > 0 && <div className="text-xs"><p className="font-medium text-red-700">Concerns</p>{a.concerns.map((c: string, i: number) => <p key={i} className="text-muted-foreground">- {c}</p>)}</div>}
              <div className="flex items-center gap-2 text-xs">
                <Badge className={a.recommendedOutcome === "pass" ? "bg-green-100 text-green-700" : a.recommendedOutcome === "fail" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}>
                  {a.recommendedOutcome?.toUpperCase()}
                </Badge>
                <span className="text-muted-foreground">Confidence: {((a.confidenceScore || 0) * 100).toFixed(0)}%</span>
              </div>
            </div>
          )}
          {a && interview.interviewType === "story" && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">{a.summary}</p>
              <p className="text-xs text-muted-foreground italic">{a.careerNarrativeSnapshot}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Growth:</span> <Badge variant="outline" className="text-xs ml-1">{a.growthMindsetSignal}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Victim:</span> <Badge variant="outline" className="text-xs ml-1">{a.victimMindsetSignal}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Stability:</span> <Badge variant="outline" className="text-xs ml-1">{a.emotionalStabilitySignal}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Integrity:</span> <Badge variant="outline" className="text-xs ml-1">{a.integritySignal}</Badge></div>
              </div>
              {a.riskFlags?.length > 0 && <div className="text-xs"><p className="font-medium text-red-700">Risk Flags</p>{a.riskFlags.map((f: string, i: number) => <p key={i} className="text-muted-foreground">- {f}</p>)}</div>}
              {a.inconsistencies?.length > 0 && <div className="text-xs"><p className="font-medium text-amber-700">Inconsistencies</p>{a.inconsistencies.map((c: string, i: number) => <p key={i} className="text-muted-foreground">! {c}</p>)}</div>}
              <Badge className={a.recommendation === "strong" ? "bg-green-100 text-green-700" : a.recommendation === "weak" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}>
                {a.recommendation?.toUpperCase()}
              </Badge>
            </div>
          )}
          {a && interview.interviewType === "reference" && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">{a.summary}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Endorsement:</span> <Badge variant="outline" className="text-xs ml-1">{a.endorsementStrength}</Badge></div>
                <div className="p-1.5 rounded bg-muted/50"><span className="font-medium">Confidence:</span> <Badge variant="outline" className="text-xs ml-1">{a.referenceConfidenceLevel}</Badge></div>
              </div>
              {a.confirmedStrengths?.length > 0 && <div className="text-xs"><p className="font-medium text-green-700">Confirmed Strengths</p>{a.confirmedStrengths.map((s: string, i: number) => <p key={i} className="text-muted-foreground">+ {s}</p>)}</div>}
              {a.hesitationFlags?.length > 0 && <div className="text-xs"><p className="font-medium text-amber-700">Hesitation Flags</p>{a.hesitationFlags.map((f: string, i: number) => <p key={i} className="text-muted-foreground">! {f}</p>)}</div>}
              <Badge className={a.overallRecommendation === "supportive" ? "bg-green-100 text-green-700" : a.overallRecommendation === "concerning" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}>
                {a.overallRecommendation?.toUpperCase()}
              </Badge>
            </div>
          )}
          {a && interview.interviewType === "focus" && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">{a.summary}</p>
              {a.categoryScores && Object.entries(a.categoryScores).map(([cat, score]: [string, any]) => (
                <div key={cat} className="mb-1">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="font-medium capitalize">{cat.replace(/_/g, " ")}</span>
                    <span className="font-mono">{score}/10</span>
                  </div>
                  <Progress value={(score as number) * 10} className="h-1.5" />
                </div>
              ))}
              <Badge className={a.finalFitRecommendation === "strong fit" ? "bg-green-100 text-green-700" : a.finalFitRecommendation === "poor fit" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}>
                {a.finalFitRecommendation?.toUpperCase()}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderFinalDecisionCard = () => {
    if (!finalDecision) return null;
    const d = finalDecision.decisionJson as any;
    if (!d) return null;

    const recColors: Record<string, string> = { "Strong Yes": "bg-green-100 text-green-700", "Yes": "bg-green-50 text-green-600", "Mixed": "bg-yellow-100 text-yellow-700", "No": "bg-red-100 text-red-700" };
    const stepColors: Record<string, string> = { Offer: "bg-green-100 text-green-700", Hold: "bg-yellow-100 text-yellow-700", Reject: "bg-red-100 text-red-700" };

    return (
      <Card className="border-primary/30 bg-primary/5" data-testid="card-final-decision">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2"><Target className="w-4 h-4" /> Final Decision Card</CardTitle>
            <div className="flex items-center gap-2">
              <Badge className={recColors[finalDecision.finalRecommendation] || "bg-muted"}>{finalDecision.finalRecommendation}</Badge>
              <Badge className={stepColors[finalDecision.nextStep] || "bg-muted"}>{finalDecision.nextStep}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 text-xs">
            <span>Confidence: <span className="font-mono font-bold">{((finalDecision.confidence || 0) * 100).toFixed(0)}%</span></span>
            <span>Stages: {finalDecision.basedOnStagesCompleted?.join(", ")}</span>
            {finalDecision.approvedAt && <Badge variant="outline" className="bg-green-50 text-green-700">Approved</Badge>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {d.topReasonsToHire?.length > 0 && (
              <div><p className="text-xs font-medium text-green-700 mb-1">Top Reasons to Hire</p>
                {d.topReasonsToHire.map((r: string, i: number) => <p key={i} className="text-xs text-muted-foreground">+ {r}</p>)}
              </div>
            )}
            {d.topRisks?.length > 0 && (
              <div><p className="text-xs font-medium text-red-700 mb-1">Top Risks</p>
                {d.topRisks.map((r: string, i: number) => <p key={i} className="text-xs text-muted-foreground">- {r}</p>)}
              </div>
            )}
          </div>

          {d.contradictionsAcrossStages?.length > 0 && (
            <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs">
              <p className="font-medium text-amber-700 mb-1">Cross-Stage Contradictions</p>
              {d.contradictionsAcrossStages.map((c: string, i: number) => <p key={i} className="text-amber-800">! {c}</p>)}
            </div>
          )}

          {d.authenticityConcerns?.length > 0 && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs">
              <p className="font-medium text-red-700 mb-1">Authenticity Concerns</p>
              {d.authenticityConcerns.map((c: string, i: number) => <p key={i} className="text-red-800">! {c}</p>)}
            </div>
          )}

          {d.unresolvedQuestions?.length > 0 && (
            <div className="text-xs">
              <p className="font-medium text-muted-foreground mb-1">Unresolved Questions</p>
              {d.unresolvedQuestions.map((q: string, i: number) => <p key={i} className="text-muted-foreground">? {q}</p>)}
            </div>
          )}

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {d.authenticityFlag && d.authenticityFlag !== "none" && <span>Authenticity: {d.authenticityFlag}</span>}
            {d.aiAssistanceLikelihood && d.aiAssistanceLikelihood !== "N/A" && <span>AI Likelihood: {d.aiAssistanceLikelihood}</span>}
            {d.languageAgencyScore != null && <span>Language Agency: {d.languageAgencyScore}</span>}
          </div>

          {!finalDecision.approvedAt && selectedCandidate && (
            <Button size="sm" className="bg-primary hover:bg-primary/90"
              onClick={() => approveFinalDecisionMutation.mutate(selectedCandidate.id)}
              disabled={approveFinalDecisionMutation.isPending}
              data-testid="button-approve-decision">
              {approveFinalDecisionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
              Approve Decision
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderCandidateDetail = () => {
    if (!selectedCandidate || !selectedJob) return null;
    const scoreData = selectedCandidate.aiScoreJson as any;
    const allQuestions = [
      ...((selectedJob.screeningQuestions as any[]) || []),
      ...((selectedJob.videoTasks as any[]) || []),
    ];

    const interviewTypes = ["phone", "story", "reference", "focus"] as const;

    return (
      <Dialog open={!!selectedCandidateId} onOpenChange={(open) => { if (!open) { setSelectedCandidateId(null); setCandidateDetailTab("overview"); } }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <span className="text-xl">{selectedCandidate.name}</span>
              <Badge className={`text-xs ${stageColors[selectedCandidate.stage] || "bg-muted"}`}>
                {stageLabels[selectedCandidate.stage] || selectedCandidate.stage}
              </Badge>
              {(selectedCandidate.finalDisplayScore ?? selectedCandidate.calibratedScore ?? selectedCandidate.totalScore) != null && (
                <span className="flex items-center gap-1.5">
                  <span className="text-lg font-mono font-bold text-foreground">{Number(selectedCandidate.finalDisplayScore ?? selectedCandidate.calibratedScore ?? selectedCandidate.totalScore).toFixed(0)}/100</span>
                  {selectedCandidate.cohortRank != null && (
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-pill text-xs font-bold ${
                      selectedCandidate.cohortRank === 1 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" :
                      selectedCandidate.cohortRank === 2 ? "bg-muted text-muted-foreground ring-1 ring-slate-300" :
                      selectedCandidate.cohortRank === 3 ? "bg-orange-50 text-orange-600 ring-1 ring-orange-300" :
                      "bg-muted text-muted-foreground ring-1 ring-gray-200"
                    }`} title={`Rank ${selectedCandidate.cohortRank} of ${selectedCandidate.cohortSize}`}>{selectedCandidate.cohortRank}</span>
                  )}
                  {selectedCandidate.assessmentBaseScore != null && (
                    <span className="text-xs text-muted-foreground font-normal">(base: {Number(selectedCandidate.assessmentBaseScore).toFixed(0)})</span>
                  )}
                  {selectedCandidate.evidenceStageCount != null && selectedCandidate.evidenceStageCount > 0 && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-pill font-medium ${
                      selectedCandidate.evidenceStageCount >= 4 ? "bg-green-100 text-green-700" :
                      selectedCandidate.evidenceStageCount >= 3 ? "bg-blue-100 text-blue-700" :
                      selectedCandidate.evidenceStageCount >= 2 ? "bg-yellow-100 text-yellow-700" : "bg-orange-100 text-orange-700"
                    }`} title={`${selectedCandidate.evidenceStageCount} of 5 evidence stages completed`}>
                      {getEvidenceConfidence(selectedCandidate.evidenceStageCount)}% conf
                    </span>
                  )}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>{selectedCandidate.email}{selectedCandidate.phone ? ` · ${selectedCandidate.phone}` : ""}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-2">
            {(() => {
              const card = selectedCandidate.hiringCardJson as any;
              const baseScore = selectedCandidate.assessmentBaseScore ?? card?.final_score ?? selectedCandidate.totalScore ?? 0;
              const score = selectedCandidate.finalDisplayScore ?? selectedCandidate.calibratedScore ?? baseScore;
              const riskTier = card?.risk_tier || (selectedCandidate.riskTier as string) || "yellow";
              const hardFail = card?.hard_fail_triggered;
              const recommendation = hardFail ? "Reject" : (riskTier === "green" && score >= 70) ? "Move Forward" : ((riskTier === "yellow" || riskTier === "green") && score >= 55) ? "Hold" : "Reject";

              const nextStageMap: Record<string, { stage: string; label: string }> = {
                applied: { stage: "invited", label: "Invite" },
                phone_interview: { stage: "ai_scored", label: "Move to AI Scored" },
                ai_scored: { stage: "story_interview", label: "Move to Story Interview" },
                story_interview: { stage: "reference_interview", label: "Move to Reference" },
                reference_interview: { stage: "focus_interview", label: "Move to Focus" },
                focus_interview: { stage: "offered", label: "Make Offer" },
              };
              const nextAction = nextStageMap[selectedCandidate.stage];
              const isPrimaryForward = recommendation === "Move Forward";
              const isPrimaryReject = recommendation === "Reject";
              const isHold = recommendation === "Hold";

              return (
                <div className="flex gap-2 flex-wrap items-center">
                  {isHold && (
                    <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 px-2 py-1">Hold — needs more signal</Badge>
                  )}
                  {nextAction && (
                    <Button
                      size="sm"
                      className={isPrimaryForward ? "bg-green-600 hover:bg-green-700" : isPrimaryReject ? "" : isHold ? "bg-amber-600 hover:bg-amber-700" : "bg-gray-600 hover:bg-gray-700"}
                      variant={isPrimaryReject ? "outline" : "default"}
                      onClick={() => updateCandidateMutation.mutate({ candidateId: selectedCandidate.id, data: { stage: nextAction.stage } })}
                      data-testid="button-detail-advance"
                    >
                      {nextAction.label}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={isPrimaryReject ? "default" : "ghost"}
                    className={isPrimaryReject ? "bg-red-600 hover:bg-red-700" : "text-red-500 hover:text-red-700"}
                    onClick={() => { updateCandidateMutation.mutate({ candidateId: selectedCandidate.id, data: { stage: "rejected" } }); setSelectedCandidateId(null); }}
                    data-testid="button-detail-reject"
                  >
                    Reject
                  </Button>
                  {(selectedCandidate.stage === "screening" || selectedCandidate.stage === "video") && !selectedCandidate.aiScoreJson && (
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => enqueueScore(selectedCandidate.id)} disabled={scoringCandidateIds.has(selectedCandidate.id)} data-testid="button-detail-score">
                      {scoringCandidateIds.has(selectedCandidate.id) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                      {scoringCandidateIds.has(selectedCandidate.id) && scoreQueue.length > 0 ? `Queued (${scoreQueue.indexOf(selectedCandidate.id) + 1})` : "Score Now"}
                    </Button>
                  )}
                  {(selectedCandidate.aiScoreJson || selectedCandidate.stage === "ai_scored") && (
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => enqueueScore(selectedCandidate.id)} disabled={scoringCandidateIds.has(selectedCandidate.id)} data-testid="button-detail-rescore">
                      {scoringCandidateIds.has(selectedCandidate.id) ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                      {scoringCandidateIds.has(selectedCandidate.id) && scoreQueue.length > 0 ? `Queued (${scoreQueue.indexOf(selectedCandidate.id) + 1})` : "Re-Score"}
                    </Button>
                  )}
                  {selectedJobId && selectedCandidate.totalScore != null && (
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => recalibrateMutation.mutate(selectedJobId)} disabled={recalibrateMutation.isPending} data-testid="button-detail-recalibrate">
                      {recalibrateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Users className="w-3 h-3 mr-1" />}
                      Recalibrate
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => copyPortalLink(selectedCandidate)} data-testid="button-detail-copy-link">
                    {copiedToken === selectedCandidate.id ? <Check className="w-3 h-3 mr-1 text-green-600" /> : <Copy className="w-3 h-3 mr-1" />}
                    Copy Link
                  </Button>
                  <ConfirmActionDialog
                    title={`Permanently delete ${selectedCandidate.name}?`}
                    description="All of this candidate's data is removed — answers, scores, interviews, and decision history. This cannot be undone."
                    confirmLabel="Delete candidate"
                    testId="dialog-confirm-detail-delete"
                    onConfirm={() => deleteCandidateMutation.mutate(selectedCandidate.id)}
                    trigger={
                      <Button size="sm" variant="ghost" className="text-xs text-red-400 hover:text-red-600" data-testid="button-detail-delete">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    }
                  />
                </div>
              );
            })()}

            <Tabs value={candidateDetailTab} onValueChange={setCandidateDetailTab} className="min-w-0">
              <TabsList className="w-full justify-start">
                <TabsTrigger value="overview" data-testid="tab-candidate-overview">Overview</TabsTrigger>
                <TabsTrigger value="interviews" data-testid="tab-candidate-interviews">
                  Interviews {interviews.length > 0 && <Badge variant="outline" className="ml-1 text-xs h-4 px-1">{interviews.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="decision" data-testid="tab-candidate-decision">
                  Decision {finalDecision && <Check className="w-3 h-3 ml-1 text-green-600" />}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="min-w-0">

            <div className="flex items-center gap-2 text-xs">
              <input
                type="file"
                accept=".pdf,.docx,.txt"
                className="hidden"
                id="resume-file-upload"
                data-testid="input-resume-file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const formData = new FormData();
                    formData.append("file", file);
                    const res = await fetch(`/api/ats/candidates/${selectedCandidate.id}/upload-resume`, {
                      method: "POST",
                      body: formData,
                      credentials: "include",
                    });
                    if (!res.ok) {
                      const err = await res.json();
                      throw new Error(err.error || "Failed to parse resume");
                    }
                    toast({ title: "Resume parsed and saved" });
                    void queryClient.invalidateQueries({ queryKey: [`/api/ats/jobs/${selectedCandidate.jobId}/candidates`] }); // fire-and-forget: cache refresh only
                  } catch (err: any) {
                    toast({ title: err.message, variant: "destructive" });
                  } finally {
                    e.target.value = "";
                  }
                }}
              />
              <label htmlFor="resume-file-upload" className="cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted/50 text-muted-foreground" data-testid="button-upload-resume">
                <Upload className="w-3 h-3" /> {selectedCandidate.resumeProfileJson ? "Replace Resume" : "Upload Resume"}
              </label>
              {selectedCandidate.resumeProfileJson && (
                <span className="text-green-600 flex items-center gap-1" data-testid="text-resume-status">
                  <CheckCircle className="w-3 h-3" /> Resume on file ({(selectedCandidate.resumeProfileJson as any).years_experience_estimate ?? "?"} yrs exp, {(selectedCandidate.resumeProfileJson as any).recent_roles?.length ?? 0} roles)
                </span>
              )}
            </div>

            {selectedCandidate.hiringCardJson && (() => {
              try {
              const card = selectedCandidate.hiringCardJson as any;
              if (!card || typeof card !== "object") return null;
              const scoreJson = selectedCandidate.aiScoreJson as any;
              const baseScore = Number(selectedCandidate.assessmentBaseScore ?? card.final_score ?? selectedCandidate.totalScore ?? 0);
              const score = Number(selectedCandidate.finalDisplayScore ?? selectedCandidate.calibratedScore ?? baseScore);
              const riskTier = card.risk_tier || "yellow";
              const hardFail = card.hard_fail_triggered;
              const riskColors: Record<string, string> = { green: "bg-green-100 text-green-700 border-green-300", yellow: "bg-yellow-100 text-yellow-700 border-yellow-300", orange: "bg-orange-100 text-orange-700 border-orange-300", red: "bg-red-100 text-red-700 border-red-300" };
              const riskColor = riskColors[riskTier] || riskColors.yellow;
              const recommendation = hardFail ? "Reject" : (riskTier === "green" && baseScore >= 70) ? "Move Forward" : ((riskTier === "yellow" || riskTier === "green") && baseScore >= 55) ? "Hold" : "Reject";
              const confidenceLevel = baseScore >= 70 ? "High" : baseScore >= 55 ? "Medium" : "Low";
              const confidenceColor = baseScore >= 70 ? "bg-green-500" : baseScore >= 55 ? "bg-amber-500" : "bg-red-500";
              const confidenceTextColor = baseScore >= 70 ? "text-green-700" : baseScore >= 55 ? "text-amber-700" : "text-red-700";
              const recColor = recommendation === "Move Forward" ? "bg-green-100 text-green-800 border-green-300" : recommendation === "Hold" ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-red-100 text-red-800 border-red-300";

              const toStr = (v: unknown): string => {
                if (typeof v === "string") return v;
                if (v && typeof v === "object") {
                  const o = v as any;
                  return o.text || o.strength || o.risk || o.claim || o.description || o.summary || o.label || o.message || JSON.stringify(v);
                }
                return String(v ?? "");
              };
              const truncate = (s: unknown, max: number = 100) => {
                const str = toStr(s);
                let cleaned = str.replace(/,?\s*(as evidenced by|as indicated by|as demonstrated by|demonstrated by|illustrated by|which could stem from)[^.]*\./gi, ".").replace(/:\s*'[^']*'/g, "").replace(/:\s*"[^"]*"/g, "").trim();
                return cleaned.length > max ? cleaned.substring(0, max).replace(/\s+\S*$/, "") + "…" : cleaned;
              };

              const authFlag = card.response_authenticity?.ai_assistance_flag;
              const authIsFlagged = authFlag === "high" || authFlag === "possible";

              const consistencyScore = scoreData?.contradiction_scores?.[0]?.narrative_consistency_score;
              const consistencyLabel = consistencyScore != null && consistencyScore >= 80 ? "High" : consistencyScore != null && consistencyScore >= 60 ? "Moderate" : consistencyScore != null ? "Low" : null;

              const coachabilityScore = scoreData?.self_correction_scores?.ego_flexibility;
              const coachabilityLabel = coachabilityScore != null && coachabilityScore >= 80 ? "High" : coachabilityScore != null && coachabilityScore >= 60 ? "Moderate" : coachabilityScore != null ? "Low" : null;

              const energyScore = scoreData?.energy_audit_scores?.alignment_to_role_stressors;
              const energyLabel = energyScore != null && energyScore >= 80 ? "Strong" : energyScore != null && energyScore >= 60 ? "Mixed" : energyScore != null ? "Weak" : null;

              const fitDelta = Number(card.fit_delta ?? 0);
              const fitLabel = fitDelta >= 2 ? "Above Target" : fitDelta <= -2 ? "Below Target" : "On Target";

              const activeMultipliers = Array.isArray(card.multipliers) ? card.multipliers.filter((m: any) => m && typeof m === "object" && Number(m?.value ?? 1) < 1.0 && m?.name !== "interview") : [];

              const dimHistory = selectedCandidate.dimensionHistory;
              const mostImpactedDims: { dim: string; delta: number }[] = [];
              if (dimHistory && dimHistory.length >= 2) {
                const first = dimHistory[0]?.dimensions;
                const last = dimHistory[dimHistory.length - 1]?.dimensions;
                if (first && last) {
                  for (const key of Object.keys(last)) {
                    if (typeof first[key] === "number" && typeof last[key] === "number") {
                      const d = last[key] - first[key];
                      if (Math.abs(d) >= 1) mostImpactedDims.push({ dim: key, delta: d });
                    }
                  }
                  mostImpactedDims.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
                }
              }

              return (
                <Card className="border-indigo-200 bg-indigo-50/30 w-full" data-testid="card-hiring-brief">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between flex-wrap gap-1">
                      <CardTitle className="text-sm flex items-center gap-2 min-w-0"><Target className="w-4 h-4 flex-shrink-0" /> Hiring Brief</CardTitle>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge className={`text-xs border whitespace-nowrap ${riskColor}`} data-testid="badge-risk-tier">{riskTier?.toUpperCase()} RISK</Badge>
                        {selectedCandidate.cohortRank != null && (
                          <span className={`inline-flex items-center justify-center w-5 h-5 rounded-pill text-[10px] font-bold ${
                            selectedCandidate.cohortRank === 1 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" :
                            selectedCandidate.cohortRank === 2 ? "bg-muted text-muted-foreground ring-1 ring-slate-300" :
                            selectedCandidate.cohortRank === 3 ? "bg-orange-50 text-orange-600 ring-1 ring-orange-300" :
                            "bg-muted text-muted-foreground ring-1 ring-gray-200"
                          }`} title={`Rank ${selectedCandidate.cohortRank} of ${selectedCandidate.cohortSize}`} data-testid="text-cohort-rank">{selectedCandidate.cohortRank}</span>
                        )}
                        <span className="text-lg font-mono font-bold text-foreground whitespace-nowrap" data-testid="text-final-score">{Number(score).toFixed(1)}</span>
                        {selectedCandidate.assessmentBaseScore != null && (
                          <span className="text-xs text-muted-foreground whitespace-nowrap">base: {Number(selectedCandidate.assessmentBaseScore).toFixed(0)}</span>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">

                    <div className={`p-3 border ${recColor}`} data-testid="block-decision-summary">
                      <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                        <span className="text-sm font-bold">{recommendation}</span>
                        <span className={`text-xs font-medium whitespace-nowrap ${confidenceTextColor}`}>Confidence: {confidenceLevel}</span>
                      </div>
                      <div className="w-full bg-muted rounded-pill h-2 mb-3">
                        <div className={`h-2 rounded-pill ${confidenceColor}`} style={{ width: `${Math.min(score, 100)}%` }} />
                      </div>
                      {selectedCandidate.scoreChangeSummary && (
                        <div className="text-xs text-muted-foreground italic mb-2 px-1" data-testid="text-score-adjustment-summary">
                          {selectedCandidate.scoreChangeSummary}
                        </div>
                      )}
                      {selectedCandidate.evidenceStageCount != null && selectedCandidate.evidenceStageCount > 0 && (
                        <div className="mb-3" data-testid="block-evidence-confidence">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-medium text-muted-foreground">Evidence Confidence</span>
                            <span className="font-mono text-muted-foreground">
                              {getEvidenceConfidence(selectedCandidate.evidenceStageCount)}%
                              <span className="text-muted-foreground ml-1">({selectedCandidate.evidenceStageCount}/5 stages)</span>
                            </span>
                          </div>
                          <div className="w-full bg-muted rounded-pill h-1.5">
                            <div className={`h-1.5 rounded-pill transition-all ${
                              selectedCandidate.evidenceStageCount >= 4 ? "bg-green-500" :
                              selectedCandidate.evidenceStageCount >= 3 ? "bg-blue-500" :
                              selectedCandidate.evidenceStageCount >= 2 ? "bg-yellow-500" : "bg-orange-400"
                            }`} style={{ width: `${getEvidenceConfidence(selectedCandidate.evidenceStageCount)}%` }} />
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3 text-xs min-w-0">
                        {card.top_strengths?.[0] && (
                          <div className="min-w-0 break-words">
                            <span className="font-medium text-green-700">
                              {recommendation === "Reject" ? "Best signal: " : recommendation === "Hold" ? "In their favor: " : "Advance because: "}
                            </span>
                            <span>{truncate(card.top_strengths[0], 80)}</span>
                          </div>
                        )}
                        {card.top_risks?.[0] && (
                          <div className="min-w-0 break-words">
                            <span className="font-medium text-red-700">
                              {recommendation === "Reject" ? "Primary concern: " : "Validate: "}
                            </span>
                            <span>{truncate(card.top_risks[0], 80)}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {hardFail && (
                      <div className="p-3 bg-red-50 border border-red-200 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-red-700">Hard Fail Triggered</p>
                          <p className="text-xs text-red-600">{card.hard_fail_reason}</p>
                        </div>
                      </div>
                    )}

                    {authIsFlagged && (
                      <div data-testid="card-authenticity-alert" className={`text-xs p-2.5 border flex items-start gap-2 ${
                        authFlag === "high" ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"
                      }`}>
                        <Shield className={`w-4 h-4 flex-shrink-0 mt-0.5 ${authFlag === "high" ? "text-red-500" : "text-amber-500"}`} />
                        <div>
                          <span className={`font-medium ${authFlag === "high" ? "text-red-700" : "text-amber-700"}`}>
                            {authFlag === "high" ? "High AI Likelihood" : "Possible AI Assistance"}
                          </span>
                          <span className="text-muted-foreground ml-1">(score: {card.response_authenticity?.ai_likelihood_score})</span>
                          {card.response_authenticity?.signals?.length > 0 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View signals</summary>
                              <ul className="mt-1 space-y-0.5">
                                {card.response_authenticity?.signals.map((s: string, i: number) => (
                                  <li key={i} className="text-muted-foreground">• {s}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      </div>
                    )}

                    {mostImpactedDims.length > 0 && (
                      <div className="p-3 bg-violet-50 border border-violet-200" data-testid="block-dimension-impact">
                        <p className="text-xs font-bold text-violet-800 mb-1.5 flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> Dimensions Changed by Interviews</p>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          {mostImpactedDims.slice(0, 6).map(({ dim, delta }) => (
                            <div key={dim} className="flex items-center justify-between text-xs">
                              <span className="capitalize text-violet-700">{dim.replace(/_/g, " ")}</span>
                              <span className={`font-mono font-medium ${delta > 0 ? "text-green-600" : "text-red-600"}`}>{delta > 0 ? "+" : ""}{Math.round(delta)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {dimHistory && dimHistory.length > 1 && (
                      <div data-testid="block-score-evolution-summary">
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">Score Evolution</p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {dimHistory.map((entry: DimensionHistoryEntry, idx: number) => {
                            const prev = idx > 0 ? dimHistory[idx - 1] : null;
                            const diff = prev ? entry.base_total - prev.base_total : 0;
                            return (
                              <div key={idx} className="flex items-center gap-1">
                                {idx > 0 && <ChevronRight className="w-3 h-3 text-gray-300" />}
                                <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${
                                  idx === dimHistory.length - 1 ? "bg-indigo-50 border-indigo-200 font-medium" : "bg-muted/50 border-border"
                                }`}>
                                  <span className="text-muted-foreground">{
                                    entry.stage === "assessment" ? "Assess" :
                                    entry.stage === "phone" ? "Phone" :
                                    entry.stage === "story" ? "Story" :
                                    entry.stage === "reference" ? "Ref" :
                                    entry.stage === "focus" ? "Focus" : entry.stage
                                  }</span>
                                  <span className="font-mono text-foreground">{Number(entry.base_total).toFixed(0)}</span>
                                  {idx > 0 && Math.abs(diff) >= 0.1 && (
                                    <span className={`text-[10px] font-mono ${diff > 0 ? "text-green-600" : "text-red-600"}`}>{diff > 0 ? "+" : ""}{diff.toFixed(1)}</span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {activeMultipliers.length > 0 && (
                      <div className="space-y-1">
                        {activeMultipliers.map((m: any, i: number) => {
                          let reason = m.reason;
                          if (m.name === "low_effort" && scoreJson?.low_effort_reason) reason = scoreJson.low_effort_reason;
                          else if (m.name === "stress" && scoreJson?.stress_reason) reason = scoreJson.stress_reason;
                          return (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <Badge variant="outline" className="text-xs border-orange-300 text-orange-600">{m.name}: {Number(m.value ?? 1).toFixed(2)}x</Badge>
                              <span className="text-muted-foreground">{reason}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs font-medium text-green-700 mb-1">Strengths</p>
                        <ul className="space-y-1">
                          {card.top_strengths?.map((s: any, i: number) => (
                            <li key={i} className="text-xs text-muted-foreground flex gap-1" title={toStr(s)}><span className="text-green-500">+</span> {truncate(s)}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-red-700 mb-1">Risks</p>
                        <ul className="space-y-1">
                          {card.top_risks?.map((r: any, i: number) => (
                            <li key={i} className="text-xs text-muted-foreground flex gap-1" title={toStr(r)}><span className="text-red-500">-</span> {truncate(r)}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {card.recommended_interview_angles?.length > 0 && (
                      <div className="p-3 bg-indigo-50 border border-indigo-200" data-testid="block-test-next">
                        <p className="text-xs font-bold text-indigo-800 mb-1.5 flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> What to Test Next</p>
                        {card.most_likely_friction_point && (
                          <p className="text-xs text-amber-700 mb-2 italic">Key friction: {card.most_likely_friction_point}</p>
                        )}
                        <ul className="space-y-1">
                          {card.recommended_interview_angles.slice(0, 3).map((a: any, i: number) => (
                            <li key={i} className="text-xs text-indigo-900 flex gap-1"><ChevronRight className="w-3 h-3 text-indigo-400 flex-shrink-0 mt-0.5" /> {toStr(a)}</li>
                          ))}
                        </ul>
                        {card.recommended_interview_angles.length > 3 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-indigo-500 hover:text-indigo-700">+{card.recommended_interview_angles.length - 3} more</summary>
                            <ul className="mt-1 space-y-1">
                              {card.recommended_interview_angles.slice(3).map((a: any, i: number) => (
                                <li key={i} className="text-xs text-indigo-900 flex gap-1"><ChevronRight className="w-3 h-3 text-indigo-400 flex-shrink-0 mt-0.5" /> {toStr(a)}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}

                    {selectedCandidate.comparativeSummary && (
                      <div className="p-3 bg-muted/50 border border-border" data-testid="block-comparative-summary">
                        <p className="text-xs font-bold text-foreground mb-1 flex items-center gap-1"><Users className="w-3.5 h-3.5" /> Cohort Standing</p>
                        <p className="text-xs text-muted-foreground">{selectedCandidate.comparativeSummary}</p>
                        {selectedCandidate.calibrationMultiplier != null && (
                          <p className="text-[10px] text-muted-foreground mt-1">Calibration: {Number(selectedCandidate.calibrationMultiplier).toFixed(3)}x{Number(selectedCandidate.cohortSize ?? 0) >= 2 ? ` · Preferred in ${Math.round(Number(selectedCandidate.pairwiseWinRate ?? 0) * (Number(selectedCandidate.cohortSize) - 1))} of ${Number(selectedCandidate.cohortSize) - 1} head-to-head comparisons` : ""}</p>
                        )}
                      </div>
                    )}

                    {card.evidence_excerpts?.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Proof Points</p>
                        <div className="space-y-1.5">
                          {card.evidence_excerpts.slice(0, 4).map((e: any, i: number) => (
                            <div key={i} className="text-xs flex gap-2">
                              <span className="text-foreground font-medium flex-shrink-0">{e.claim}</span>
                              <span className="text-muted-foreground italic truncate">"{e.excerpt}"</span>
                              <span className="text-gray-300 text-[10px] flex-shrink-0">{e.source_question_id}</span>
                            </div>
                          ))}
                          {card.evidence_excerpts.length > 4 && (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-muted-foreground">+{card.evidence_excerpts.length - 4} more</summary>
                              <div className="mt-1 space-y-1.5">
                                {card.evidence_excerpts.slice(4).map((e: any, i: number) => (
                                  <div key={i} className="text-xs flex gap-2">
                                    <span className="text-foreground font-medium flex-shrink-0">{e.claim}</span>
                                    <span className="text-muted-foreground italic truncate">"{e.excerpt}"</span>
                                    <span className="text-gray-300 text-[10px] flex-shrink-0">{e.source_question_id}</span>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    )}

                    {card.fit_delta !== undefined && (
                      <div className="text-xs">
                        <span className="font-medium text-muted-foreground">Fit to Role: </span>
                        <span className={`font-medium ${fitDelta >= 2 ? "text-green-600" : fitDelta <= -2 ? "text-red-600" : "text-blue-600"}`}>{fitLabel}</span>
                        {card.fit_delta_interpretation && <span className="text-muted-foreground ml-1.5">— {card.fit_delta_interpretation}</span>}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-1.5 pt-1 border-t" data-testid="block-snapshot-row">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${recommendation === "Move Forward" ? "border-green-300 text-green-700" : recommendation === "Hold" ? "border-amber-300 text-amber-700" : "border-red-300 text-red-700"}`}>
                        {recommendation}
                      </Badge>
                      {!authIsFlagged && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 border-border text-muted-foreground">No AI Indicators</Badge>
                      )}
                      {authIsFlagged && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${authFlag === "high" ? "border-red-300 text-red-600" : "border-amber-300 text-amber-600"}`}>
                          {authFlag === "high" ? "High AI" : "Possible AI"}
                        </Badge>
                      )}
                      {consistencyLabel && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${consistencyLabel === "High" ? "border-green-200 text-green-600" : consistencyLabel === "Moderate" ? "border-amber-200 text-amber-600" : "border-red-200 text-red-600"}`}>
                          Consistency: {consistencyLabel}
                        </Badge>
                      )}
                      {coachabilityLabel && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${coachabilityLabel === "High" ? "border-green-200 text-green-600" : coachabilityLabel === "Moderate" ? "border-amber-200 text-amber-600" : "border-red-200 text-red-600"}`}>
                          Coachability: {coachabilityLabel}
                        </Badge>
                      )}
                      {energyLabel && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${energyLabel === "Strong" ? "border-green-200 text-green-600" : energyLabel === "Mixed" ? "border-amber-200 text-amber-600" : "border-red-200 text-red-600"}`}>
                          Energy: {energyLabel}
                        </Badge>
                      )}
                      {card.fit_delta != null && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 ${fitDelta >= 2 ? "border-green-200 text-green-600" : fitDelta <= -2 ? "border-red-200 text-red-600" : "border-blue-200 text-blue-600"}`}>
                          Fit: {fitLabel}
                        </Badge>
                      )}
                    </div>

                    <details className="pt-2 border-t">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium">
                        <Eye className="w-3.5 h-3.5" /> View Full Analyst Report
                      </summary>
                      <div className="mt-3 space-y-3">

                        {(() => {
                          const dims: Record<string, number> = {};
                          if (scoreJson) {
                            if (scoreJson.role_skill_score != null) dims.role_skill = scoreJson.role_skill_score;
                            if (scoreJson.role_behavior_score != null) dims.role_behavior = scoreJson.role_behavior_score;
                            if (scoreJson.reality_based_score != null) dims.reality_based_mindset = scoreJson.reality_based_score;
                            if (scoreJson.personality_alignment_score != null) dims.personality_alignment = scoreJson.personality_alignment_score;
                            if (scoreJson.communication_clarity_score != null) dims.communication_clarity = scoreJson.communication_clarity_score;
                          }
                          const dimSource: Record<string, number> = Object.keys(dims).length >= 5
                            ? dims
                            : (card.dimension_scores && typeof card.dimension_scores === "object"
                              ? card.dimension_scores as Record<string, number>
                              : null) as Record<string, number>;
                          if (!dimSource) return null;
                          return (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-2">Dimension Scores</p>
                            {Object.entries(dimSource).map(([dim, dimScore]: [string, number]) => {
                              const history = selectedCandidate.dimensionHistory;
                              const dimKey = dim;
                              let delta: number | null = null;
                              if (history && history.length >= 2) {
                                const first = history[0]?.dimensions?.[dimKey];
                                const last = history[history.length - 1]?.dimensions?.[dimKey];
                                if (typeof first === "number" && typeof last === "number") {
                                  delta = last - first;
                                }
                              }
                              return (
                                <div key={dim} className="mb-2">
                                  <div className="flex items-center justify-between text-xs mb-0.5">
                                    <span className="font-medium capitalize">{dim.replace(/_/g, " ")}</span>
                                    <span className="flex items-center gap-1.5">
                                      {delta != null && Math.abs(delta) >= 1 && (
                                        <span className={`text-[10px] font-mono ${delta > 0 ? "text-green-600" : "text-red-600"}`}>
                                          {delta > 0 ? "+" : ""}{Math.round(delta)}
                                        </span>
                                      )}
                                      <span className="font-mono text-foreground">{typeof dimScore === "number" ? dimScore : 0}/100</span>
                                    </span>
                                  </div>
                                  <Progress value={typeof dimScore === "number" ? dimScore : 0} className="h-1.5" />
                                </div>
                              );
                            })}
                          </div>
                          );
                        })()}

                        {selectedCandidate.dimensionHistory && Array.isArray(selectedCandidate.dimensionHistory) && selectedCandidate.dimensionHistory.length > 1 && (
                          <div data-testid="block-dimension-evolution">
                            <p className="text-xs font-medium text-muted-foreground mb-2">Score Evolution</p>
                            <div className="space-y-1">
                              {selectedCandidate.dimensionHistory.map((entry: DimensionHistoryEntry, idx: number) => (
                                <div key={idx} className="flex items-center gap-2 text-xs p-1.5 bg-muted/50 rounded">
                                  <Badge variant="outline" className="text-[10px] shrink-0">{
                                    entry.stage === "assessment" ? "Assessment" :
                                    entry.stage === "phone" ? "Phone" :
                                    entry.stage === "story" ? "Story" :
                                    entry.stage === "reference" ? "Reference" :
                                    entry.stage === "focus" ? "Focus" : entry.stage
                                  }</Badge>
                                  <span className="font-mono text-foreground shrink-0">{Number(entry.base_total).toFixed(1)}</span>
                                  {idx > 0 && (() => {
                                    const prev = selectedCandidate.dimensionHistory![idx - 1];
                                    const diff = entry.base_total - prev.base_total;
                                    if (Math.abs(diff) < 0.1) return null;
                                    return <span className={`text-[10px] font-mono ${diff > 0 ? "text-green-600" : "text-red-600"}`}>{diff > 0 ? "+" : ""}{diff.toFixed(1)}</span>;
                                  })()}
                                  {entry.change_summary && <span className="text-muted-foreground truncate">{entry.change_summary}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {card.fit_delta !== undefined && (
                          <div className="p-2 bg-muted/50 rounded text-xs">
                            <span className="font-medium">Fit Delta: </span>
                            <span className={`font-mono ${fitDelta > 15 ? "text-orange-600" : fitDelta < -15 ? "text-blue-600" : "text-green-600"}`}>{fitDelta > 0 ? "+" : ""}{fitDelta.toFixed(1)}</span>
                            {card.fit_delta_interpretation && <span className="text-muted-foreground ml-2">{card.fit_delta_interpretation}</span>}
                          </div>
                        )}

                        {(() => {
                          const scoreAdjustments = Array.isArray(card.multipliers) ? card.multipliers.filter((m: any) => m && typeof m === "object" && m?.name !== "interview") : [];
                          return scoreAdjustments.length > 0 ? (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">Score Adjustments</p>
                            {scoreAdjustments.map((m: any, i: number) => {
                              let reason = m.reason;
                              if (m.name === "low_effort" && scoreJson?.low_effort_reason) reason = scoreJson.low_effort_reason;
                              else if (m.name === "stress" && scoreJson?.stress_reason) reason = scoreJson.stress_reason;
                              return (
                                <div key={i} className="flex items-center gap-2 text-xs">
                                  <Badge variant="outline" className={`text-xs ${Number(m.value ?? 1) < 0.9 ? "border-orange-300 text-orange-600" : "border-green-300 text-green-600"}`}>{m.name}: {Number(m.value ?? 1).toFixed(2)}x</Badge>
                                  <span className="text-muted-foreground">{reason}</span>
                                </div>
                              );
                            })}
                          </div>
                          ) : null;
                        })()}

                        {card.contradiction_summary && (
                          <div className="text-xs p-2 bg-purple-50 border border-purple-200 rounded">
                            <span className="font-medium text-purple-700">Contradiction Analysis: </span>
                            <span className="text-purple-800">{card.contradiction_summary}</span>
                          </div>
                        )}

                        {card.self_correction_summary && (
                          <div className="text-xs p-2 bg-teal-50 border border-teal-200 rounded">
                            <span className="font-medium text-teal-700">Self-Correction: </span>
                            <span className="text-teal-800">{card.self_correction_summary}</span>
                          </div>
                        )}

                        {card.energy_alignment_summary && (
                          <div className="text-xs p-2 bg-cyan-50 border border-cyan-200 rounded">
                            <span className="font-medium text-cyan-700">Energy Alignment: </span>
                            <span className="text-cyan-800">{card.energy_alignment_summary}</span>
                          </div>
                        )}

                        {card.default_operating_mode_summary && (
                          <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                            <p className="text-xs font-medium text-blue-700 mb-1">Default Operating Mode</p>
                            <p className="text-xs text-blue-800 whitespace-pre-wrap">{card.default_operating_mode_summary}</p>
                          </div>
                        )}

                        {card.most_likely_manager_style_needed && (
                          <div className="text-xs">
                            <span className="font-medium text-muted-foreground">Manager Style Needed: </span>
                            <span className="text-foreground">{card.most_likely_manager_style_needed}</span>
                          </div>
                        )}

                        {card.response_authenticity && !authIsFlagged && (
                          <div className="text-xs p-2 bg-green-50 border border-green-200 rounded">
                            <span className="font-medium text-green-700">Response Authenticity: No AI indicators</span>
                            <span className="text-muted-foreground ml-1">(score: {card.response_authenticity?.ai_likelihood_score})</span>
                          </div>
                        )}

                        {card.response_authenticity && authIsFlagged && (
                          <div data-testid="card-response-authenticity" className={`text-xs p-2 rounded border ${
                            authFlag === "high" ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"
                          }`}>
                            <span className={`font-medium ${authFlag === "high" ? "text-red-700" : "text-amber-700"}`}>
                              {authFlag === "high" ? "High AI Likelihood" : "Possible AI Assistance"}
                            </span>
                            <span className="text-muted-foreground ml-1">(score: {card.response_authenticity?.ai_likelihood_score})</span>
                            {card.response_authenticity?.signals?.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {card.response_authenticity?.signals.map((s: string, i: number) => (
                                  <li key={i} className="text-muted-foreground">• {s}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        {card.resume_consistency && (
                          <div data-testid="card-resume-consistency" className={`text-xs p-2 rounded border ${
                            card.resume_consistency.resume_consistency_flag === "high" ? "bg-red-50 border-red-200" :
                            card.resume_consistency.resume_consistency_flag === "possible" ? "bg-amber-50 border-amber-200" :
                            "bg-green-50 border-green-200"
                          }`}>
                            <span className={`font-medium ${
                              card.resume_consistency.resume_consistency_flag === "high" ? "text-red-700" :
                              card.resume_consistency.resume_consistency_flag === "possible" ? "text-amber-700" :
                              "text-green-700"
                            }`}>
                              Resume Consistency: {card.resume_consistency.resume_consistency_flag === "none" ? "No issues detected" :
                                card.resume_consistency.resume_consistency_flag === "possible" ? "Possible inconsistencies" : "Significant inconsistencies"}
                            </span>
                            {card.resume_consistency.seniority_mismatch_flag !== "none" && (
                              <span className="ml-1 text-amber-600">· Seniority mismatch: {card.resume_consistency.seniority_mismatch_flag}</span>
                            )}
                            {card.resume_consistency.consistency_reasons?.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {card.resume_consistency.consistency_reasons.map((r: string, i: number) => (
                                  <li key={i} className="text-muted-foreground">• {r}</li>
                                ))}
                              </ul>
                            )}
                            {card.resume_consistency.suggested_followup_questions?.length > 0 && (
                              <div className="mt-1.5 pt-1.5 border-t border-border">
                                <p className="font-medium text-muted-foreground mb-0.5">Interview follow-ups:</p>
                                {card.resume_consistency.suggested_followup_questions.map((q: string, i: number) => (
                                  <p key={i} className="text-muted-foreground italic">"{q}"</p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {card.risk_tier_reasons?.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1">Risk Tier Reasoning</p>
                            <ul className="space-y-1">
                              {card.risk_tier_reasons.map((r: string, i: number) => (
                                <li key={i} className="text-xs text-muted-foreground">• {r}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {scoreData?.dimension_details && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-2">Scoring Details</p>
                            <div className="space-y-2">
                              {scoreData.dimension_details.map((dim: any, i: number) => (
                                <div key={i} className="p-2 bg-muted/50 rounded">
                                  <div className="flex items-center justify-between text-xs mb-1">
                                    <span className="font-medium capitalize">{dim.dimension?.replace(/_/g, " ")}</span>
                                    <span className="font-mono">{dim.score}/100 (w={dim.weight}){dim.is_diagnostic ? " [diagnostic]" : ""}</span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">{dim.feedback}</p>
                                  {dim.key_evidence?.length > 0 && (
                                    <div className="mt-1 space-y-0.5">
                                      {dim.key_evidence.map((e: string, j: number) => (
                                        <p key={j} className="text-[10px] text-muted-foreground italic">"{e}"</p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {scoreData?.contradiction_scores?.[0] && (
                          <div className="p-2 bg-purple-50 rounded text-xs">
                            <p className="font-medium text-purple-700">Contradiction Scores</p>
                            <p className="text-purple-600">Trait: {scoreData.contradiction_scores[0].trait_target} · Narrative consistency: {scoreData.contradiction_scores[0].narrative_consistency_score} · Responsibility: {scoreData.contradiction_scores[0].responsibility_consistency_score} · Evasion: {scoreData.contradiction_scores[0].evasion_score}</p>
                          </div>
                        )}

                        {scoreData?.self_correction_scores && (
                          <div className="p-2 bg-teal-50 rounded text-xs">
                            <p className="font-medium text-teal-700">Self-Correction Scores</p>
                            <p className="text-teal-600">Ego flexibility: {scoreData.self_correction_scores.ego_flexibility} · Revision quality: {scoreData.self_correction_scores.quality_of_revision} · Defensiveness: {scoreData.self_correction_scores.defensiveness} · Learning velocity: {scoreData.self_correction_scores.learning_velocity}</p>
                          </div>
                        )}

                        {scoreData?.energy_audit_scores && (
                          <div className="p-2 bg-cyan-50 rounded text-xs">
                            <p className="font-medium text-cyan-700">Energy Audit</p>
                            <p className="text-cyan-600">Specificity: {scoreData.energy_audit_scores.specificity} · Motivation: {scoreData.energy_audit_scores.process_excited_vs_status_excited} · Role alignment: {scoreData.energy_audit_scores.alignment_to_role_stressors}</p>
                          </div>
                        )}

                        <div className="pt-2 border-t flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>{card.safety_note}</span>
                          {selectedCandidate.aiSpecVersion && <span>Spec {selectedCandidate.aiSpecVersion} · {selectedCandidate.modelId}</span>}
                        </div>
                      </div>
                    </details>

                  </CardContent>
                </Card>
              );
              } catch (e: any) { console.error("[ATS] Hiring card render error:", e); return (
                <Card className="border-red-200 bg-red-50/30" data-testid="card-hiring-brief-error">
                  <CardContent className="py-3">
                    <p className="text-xs text-red-600 font-medium">Hiring Brief failed to render</p>
                    <p className="text-[10px] text-red-400 mt-1">{e?.message || String(e)}</p>
                  </CardContent>
                </Card>
              ); }
            })()}

            {scoreData && !selectedCandidate.hiringCardJson && scoreData.dimensionScores && (
              <Card className="border-indigo-200 bg-indigo-50/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Target className="w-4 h-4" /> AI Score Breakdown (Legacy)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {scoreData.hardFailTriggered && (
                    <div className="p-3 bg-red-50 border border-red-200 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-red-700">Hard Fail Triggered</p>
                        <p className="text-xs text-red-600">{scoreData.hardFailReason}</p>
                      </div>
                    </div>
                  )}
                  {(scoreData.dimensionScores as any[]).map((dim: any, i: number) => (
                    <div key={i}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium">{dim.dimension}</span>
                        <span className="font-mono text-foreground">{dim.score}/{dim.maxScore}</span>
                      </div>
                      <Progress value={(dim.score / dim.maxScore) * 100} className="h-2 mb-1" />
                      <p className="text-xs text-muted-foreground">{dim.feedback}</p>
                    </div>
                  ))}
                  {scoreData.summary && (
                    <div className="pt-2 border-t">
                      <p className="text-sm font-medium mb-1">Summary</p>
                      <p className="text-xs text-muted-foreground">{scoreData.summary}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between w-full">
                  <CardTitle className="text-sm flex items-center gap-2"><FileText className="w-4 h-4" /> Submissions ({submissions.length})</CardTitle>
                  {submissions.some((s) => s.questionType === "video" && (s.transcriptionStatus === "failed" || !s.transcriptText)) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      onClick={() => retryTranscriptionMutation.mutate(selectedCandidate.id)}
                      disabled={retryTranscriptionMutation.isPending}
                      data-testid="button-retry-transcription"
                    >
                      {retryTranscriptionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                      Retry Transcription
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {submissions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No submissions yet.</p>
                ) : (
                  submissions.map((sub) => {
                    const question = allQuestions.find((q: any) => q.id === sub.questionId);
                    return (
                      <div key={sub.id} className="p-3 border bg-muted/50">
                        <div className="flex items-start justify-between mb-1">
                          <p className="text-sm font-medium">{question?.prompt || sub.questionId}</p>
                          <Badge variant="outline" className="text-xs">{sub.questionType}</Badge>
                        </div>
                        {sub.videoObjectKey ? (
                          <div className="mt-2">
                            <video
                              src={sub.videoObjectKey}
                              controls
                              className="w-full max-w-lg border bg-black"
                              data-testid={`video-playback-${sub.id}`}
                            />
                            <div className="flex items-center gap-2 mt-1">
                              <p className="text-xs text-muted-foreground">{sub.responseText}</p>
                              {sub.transcriptionStatus === "completed" && (
                                <Badge variant="outline" className="text-xs text-green-600 border-green-300">Transcribed</Badge>
                              )}
                              {sub.transcriptionStatus === "failed" && (
                                <Badge variant="outline" className="text-xs text-red-600 border-red-300">Transcription Failed</Badge>
                              )}
                              {sub.transcriptionStatus === "failed" && (() => {
                                // Task #3987 — surface WHY it failed (typed code from
                                // #3963) instead of a bare 'failed' badge; raw detail on
                                // hover; retry-worthwhile codes point at the retry button.
                                const reason = describeAtsTranscriptionFailure(sub.transcriptionFailureCode);
                                return (
                                  <span
                                    className="text-xs text-muted-foreground"
                                    title={sub.transcriptionFailureDetail || undefined}
                                    data-testid={`text-transcription-failure-reason-${sub.id}`}
                                  >
                                    {reason.label}
                                    {reason.retrySuggested && (
                                      <span className="text-blue-600"> Retry Transcription is worth trying.</span>
                                    )}
                                  </span>
                                );
                              })()}
                              {sub.transcriptionStatus === "processing" && (
                                <Badge variant="outline" className="text-xs text-blue-600 border-blue-300"><Loader2 className="w-3 h-3 animate-spin mr-1" />Transcribing</Badge>
                              )}
                              {sub.transcriptionStatus === "pending" && (
                                <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-300">Pending</Badge>
                              )}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{sub.responseText || "(no response)"}</p>
                        )}
                        {sub.aiScore !== null && (
                          <div className="mt-2 flex items-center gap-2">
                            <Star className="w-3 h-3 text-amber-500" />
                            <span className="text-xs font-mono">{sub.aiScore}/100</span>
                            {sub.aiFeedback && <span className="text-xs text-muted-foreground">- {sub.aiFeedback}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                {submissionsHasNextPage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-xs"
                    onClick={() => fetchNextSubmissionsPage()}
                    disabled={submissionsFetchingNextPage}
                    data-testid="button-load-more-submissions"
                  >
                    {submissionsFetchingNextPage ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Load more submissions
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={candidateNotes || selectedCandidate.notes || ""}
                  onChange={e => setCandidateNotes(e.target.value)}
                  placeholder="Add notes about this candidate..."
                  rows={3}
                  data-testid="input-candidate-notes"
                />
                <Button
                  size="sm"
                  className="mt-2 bg-primary hover:bg-primary/90"
                  onClick={() => {
                    updateCandidateMutation.mutate({ candidateId: selectedCandidate.id, data: { notes: candidateNotes } });
                    toast({ title: "Notes saved" });
                  }}
                  data-testid="button-save-notes"
                >
                  Save Notes
                </Button>
              </CardContent>
            </Card>
              </TabsContent>

              <TabsContent value="interviews" className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Interviews</p>
                  <Button size="sm" variant="outline" onClick={() => setShowInterviewUpload(true)} data-testid="button-upload-interview">
                    <Plus className="w-3 h-3 mr-1" /> Add Interview
                  </Button>
                </div>

                {showInterviewUpload && (
                  <Card className="border-blue-200 bg-blue-50/30">
                    <CardContent className="pt-4 space-y-3">
                      <div className="flex gap-2">
                        {(["phone", "story", "reference", "focus"] as const).map(t => (
                          <Button key={t} size="sm" variant={interviewType === t ? "default" : "outline"} className="text-xs"
                            onClick={() => setInterviewType(t)} data-testid={`button-type-${t}`}>
                            {t === "phone" ? "Phone" : t === "story" ? "Story" : t === "reference" ? "Reference" : "Focus"}
                          </Button>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Transcript (optional)</p>
                        <Textarea
                          value={interviewTranscript}
                          onChange={e => setInterviewTranscript(e.target.value)}
                          placeholder="Paste the full interview transcript here..."
                          rows={6}
                          data-testid="input-interview-transcript"
                        />
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Interviewer Notes (optional)</p>
                        <Textarea
                          value={interviewNotes}
                          onChange={e => setInterviewNotes(e.target.value)}
                          placeholder="Add your observations, impressions, and key takeaways from the interview..."
                          rows={4}
                          data-testid="input-interview-notes"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">Provide a transcript, notes, or both. Both will be used for AI analysis.</p>
                      {interviewType === "focus" && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">Manual Category Ratings (optional, 1-10)</p>
                          <div className="grid grid-cols-3 gap-2">
                            {["role_outcomes", "culture_fit", "competency", "leadership", "communication", "initiative"].map(cat => (
                              <div key={cat} className="flex items-center gap-1">
                                <label className="text-xs capitalize w-24 truncate">{cat.replace(/_/g, " ")}</label>
                                <Input type="number" min={1} max={10} className="h-6 w-14 text-xs"
                                  value={focusRatings[cat] || ""}
                                  onChange={e => setFocusRatings(prev => ({ ...prev, [cat]: parseInt(e.target.value) || 0 }))}
                                  data-testid={`input-focus-rating-${cat}`}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-primary hover:bg-primary/90"
                          disabled={(!interviewTranscript.trim() && !interviewNotes.trim()) || uploadInterviewMutation.isPending}
                          onClick={() => {
                            uploadInterviewMutation.mutate({
                              candidateId: selectedCandidate.id,
                              type: interviewType,
                              transcript: interviewTranscript.trim() || undefined,
                              interviewNotes: interviewNotes.trim() || undefined,
                              manualRatings: interviewType === "focus" && Object.keys(focusRatings).length > 0 ? focusRatings : undefined,
                            });
                          }}
                          data-testid="button-submit-interview">
                          {uploadInterviewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
                          Upload & Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setShowInterviewUpload(false); setInterviewTranscript(""); setInterviewNotes(""); setFocusRatings({}); }}>Cancel</Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {interviews.length === 0 && !showInterviewUpload && (
                  <p className="text-sm text-muted-foreground text-center py-8">No interviews uploaded yet.</p>
                )}

                {interviews.map(interview => renderInterviewCard(interview))}

                {interviewsHasNextPage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-xs"
                    onClick={() => fetchNextInterviewsPage()}
                    disabled={interviewsFetchingNextPage}
                    data-testid="button-load-more-interviews"
                  >
                    {interviewsFetchingNextPage ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Load more interviews
                  </Button>
                )}
              </TabsContent>

              <TabsContent value="decision" className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Final Decision Card</p>
                  <Button size="sm" className="bg-primary hover:bg-primary/90"
                    disabled={generateFinalDecisionMutation.isPending}
                    onClick={() => {
                      if (finalDecision) {
                        setDecisionFeedbackText("");
                        setShowDecisionFeedback(true);
                      } else {
                        generateFinalDecisionMutation.mutate({ candidateId: selectedCandidate.id });
                      }
                    }}
                    data-testid="button-generate-decision">
                    {generateFinalDecisionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                    {finalDecision ? "Regenerate" : "Generate"} Decision
                  </Button>
                  <Dialog open={showDecisionFeedback} onOpenChange={setShowDecisionFeedback}>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Regenerate Decision</DialogTitle>
                        <DialogDescription>Provide feedback to guide the regeneration. Tell the AI what to change or weight differently.</DialogDescription>
                      </DialogHeader>
                      <Textarea
                        placeholder="e.g., Weight references more heavily, be stricter on authenticity concerns..."
                        value={decisionFeedbackText}
                        onChange={(e) => setDecisionFeedbackText(e.target.value)}
                        rows={4}
                        data-testid="textarea-decision-feedback"
                      />
                      <div className="flex justify-end gap-2 mt-2">
                        <Button variant="outline" onClick={() => setShowDecisionFeedback(false)} data-testid="button-cancel-decision">Cancel</Button>
                        <Button className="bg-primary hover:bg-primary/90" disabled={!decisionFeedbackText.trim()} onClick={() => {
                          setShowDecisionFeedback(false);
                          generateFinalDecisionMutation.mutate({ candidateId: selectedCandidate.id, feedback: decisionFeedbackText || undefined });
                        }} data-testid="button-confirm-decision">
                          <Sparkles className="w-3 h-3 mr-1" /> Regenerate
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>

                {!finalDecision && !generateFinalDecisionMutation.isPending && (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    <p>No final decision generated yet.</p>
                    <p className="text-xs mt-1">Upload and analyze interviews first, then generate a decision card.</p>
                  </div>
                )}

                {generateFinalDecisionMutation.isPending && (
                  <div className="text-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
                    <p className="text-sm text-muted-foreground mt-2">Synthesizing evidence from all stages...</p>
                  </div>
                )}

                {renderFinalDecisionCard()}

                {finalDecision && (
                  <div className="text-xs text-muted-foreground text-center">
                    Generated {new Date(finalDecision.createdAt).toLocaleString()}
                    {finalDecision.approvedAt && ` · Approved ${new Date(finalDecision.approvedAt).toLocaleString()}`}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  const renderKanban = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">Pipeline</CardTitle>
          <Badge variant="outline" className="text-xs">{candidates.length} total</Badge>
        </div>
        <div className="flex gap-2">
          <Dialog open={showCsvImport} onOpenChange={setShowCsvImport}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="button-csv-import">
                <Upload className="w-3 h-3 mr-1" /> CSV Import
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Import Candidates from CSV</DialogTitle>
                <DialogDescription>Paste CSV data with columns: name, email, phone (header row required)</DialogDescription>
              </DialogHeader>
              <Textarea
                value={csvText}
                onChange={e => setCsvText(e.target.value)}
                placeholder={`name,email,phone\nJohn Doe,john@example.com,555-1234\nJane Smith,jane@example.com,`}
                rows={8}
                className="font-mono text-xs"
                data-testid="input-csv"
              />
              <Button
                className="w-full bg-primary hover:bg-primary/90"
                onClick={() => csvImportMutation.mutate()}
                disabled={!csvText.trim() || csvImportMutation.isPending}
                data-testid="button-import-csv"
              >
                {csvImportMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
                Import
              </Button>
            </DialogContent>
          </Dialog>
          <Dialog open={showAddCandidate} onOpenChange={setShowAddCandidate}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="button-add-candidate">
                <UserPlus className="w-4 h-4 mr-1" /> Add
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Candidate</DialogTitle>
                <DialogDescription>Add a new candidate to this job posting.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <Input placeholder="Full Name" value={candidateName} onChange={e => setCandidateName(e.target.value)} data-testid="input-candidate-name" />
                <Input placeholder="Email" value={candidateEmail} onChange={e => setCandidateEmail(e.target.value)} data-testid="input-candidate-email" />
                <Input placeholder="Phone (optional)" value={candidatePhone} onChange={e => setCandidatePhone(e.target.value)} data-testid="input-candidate-phone" />
                <Button className="w-full bg-primary hover:bg-primary/90" onClick={() => addCandidateMutation.mutate()} disabled={!candidateName || !candidateEmail || addCandidateMutation.isPending} data-testid="button-submit-candidate">
                  {addCandidateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Add Candidate
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Button
            size="sm"
            variant="outline"
            onClick={enqueueScoreAll}
            disabled={scoringCandidateIds.size > 0}
            data-testid="button-score-all"
          >
            <Sparkles className="w-4 h-4 mr-1" /> Score All
          </Button>
        </div>
      </div>

      {scoringCandidateIds.size > 0 && (
        <div className="flex items-center gap-3 p-2.5 bg-indigo-50 border border-indigo-200" data-testid="score-queue-progress">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-indigo-700">
                Scoring {Math.min(scoreQueueDone + 1, scoreQueueTotal)} of {scoreQueueTotal}
                {scoreQueueErrorsRef.current > 0 && <span className="text-red-500 ml-1">({scoreQueueErrorsRef.current} failed)</span>}
              </span>
              <span className="text-indigo-500">
                {candidates.find(c => c.id === scoreQueue[0])?.name || "Processing..."}
              </span>
            </div>
            <Progress value={scoreQueueTotal > 0 ? (scoreQueueDone / scoreQueueTotal) * 100 : 0} className="h-1.5" />
          </div>
        </div>
      )}

      {bulkSelected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-indigo-50 border border-indigo-200">
          <span className="text-sm font-medium text-indigo-700">{bulkSelected.size} selected</span>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => bulkUpdateMutation.mutate("invited")}>Bulk Invite</Button>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => bulkUpdateMutation.mutate("rejected")}>Bulk Reject</Button>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setBulkSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max pb-4">
          {kanbanStages.map(stage => (
            <div key={stage} className="w-56 flex-shrink-0">
              <div className={`px-3 py-2 border-b-2 ${kanbanStageColors[stage] || stageColors[stage] || "bg-muted"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase">{kanbanStageLabels[stage] || stageLabels[stage] || stage}</span>
                  <Badge variant="outline" className="text-xs h-5 w-5 flex items-center justify-center p-0 rounded-pill">
                    {candidatesByStage[stage]?.length || 0}
                  </Badge>
                </div>
              </div>
              <div className="bg-muted/30 border border-t-0 min-h-[120px] p-2 space-y-2">
                {(candidatesByStage[stage] || []).map((candidate, columnIndex) => (
                  <div
                    key={candidate.id}
                    className="bg-card border p-2.5 cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all group"
                    onClick={() => { setSelectedCandidateId(candidate.id); setCandidateNotes(candidate.notes || ""); }}
                    data-testid={`card-candidate-${candidate.id}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="rounded border-border text-indigo-600 h-3 w-3"
                          checked={bulkSelected.has(candidate.id)}
                          onChange={(e) => { e.stopPropagation(); toggleBulkSelect(candidate.id); }}
                          onClick={e => e.stopPropagation()}
                          data-testid={`checkbox-${candidate.id}`}
                        />
                        <span className="text-sm font-medium truncate max-w-[120px]">{candidate.name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {scoringCandidateIds.has(candidate.id) && (
                          <span title="Scoring..."><Loader2 className="w-3 h-3 animate-spin text-indigo-500 flex-shrink-0" /></span>
                        )}
                        {candidate.riskTier && !scoringCandidateIds.has(candidate.id) && (
                          <span className={`w-2 h-2 rounded-pill flex-shrink-0 ${candidate.riskTier === "green" ? "bg-green-500" : candidate.riskTier === "yellow" ? "bg-yellow-500" : candidate.riskTier === "orange" ? "bg-orange-500" : "bg-red-500"}`} title={`${candidate.riskTier} risk`} />
                        )}
                        {(candidate.finalDisplayScore ?? candidate.calibratedScore ?? candidate.totalScore) != null && (
                          <span className="text-xs font-mono font-bold text-foreground">{Number(candidate.finalDisplayScore ?? candidate.calibratedScore ?? candidate.totalScore).toFixed(0)}</span>
                        )}
                        {candidate.evidenceStageCount != null && candidate.evidenceStageCount > 0 && (
                          <span className={`w-1.5 h-1.5 rounded-pill flex-shrink-0 ${
                            candidate.evidenceStageCount >= 4 ? "bg-green-500" :
                            candidate.evidenceStageCount >= 3 ? "bg-blue-500" :
                            candidate.evidenceStageCount >= 2 ? "bg-yellow-500" : "bg-orange-400"
                          }`} title={`Evidence: ${candidate.evidenceStageCount}/5 stages (${getEvidenceConfidence(candidate.evidenceStageCount)}% confidence)`} />
                        )}
                        {candidate.totalScore != null && (() => {
                          const pos = columnIndex + 1;
                          return (
                            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-pill text-[10px] font-bold flex-shrink-0 ${
                              pos === 1 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" :
                              pos === 2 ? "bg-muted text-muted-foreground ring-1 ring-slate-300" :
                              pos === 3 ? "bg-orange-50 text-orange-600 ring-1 ring-orange-300" :
                              "bg-muted text-muted-foreground ring-1 ring-gray-200"
                            }`} title={candidate.cohortRank != null ? `#${pos} in stage · Cohort rank ${candidate.cohortRank} of ${candidate.cohortSize}` : `#${pos} in stage`}>{pos}</span>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">{candidate.email}</div>
                    <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-5 px-1 text-xs" onClick={e => { e.stopPropagation(); copyPortalLink(candidate); }} title="Copy link">
                        {copiedToken === candidate.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                      </Button>
                      {stage !== "offered" && (
                        <Button size="sm" variant="ghost" className="h-5 px-1 text-xs" onClick={e => {
                          e.stopPropagation();
                          const nextIdx = kanbanStages.indexOf(stage) + 1;
                          if (nextIdx < kanbanStages.length) {
                            const nextKanban = kanbanStages[nextIdx];
                            const kanbanToDb: Record<string, string> = {
                              
                              invited: "invited",
                              answers_received: "screening",
                              ai_scored: "ai_scored",
                              story: "story_interview",
                              reference: "reference_interview",
                              focus: "focus_interview",
                              offered: "offered",
                            };
                            updateCandidateMutation.mutate({ candidateId: candidate.id, data: { stage: kanbanToDb[nextKanban] || nextKanban } });
                          }
                        }} title="Advance stage">
                          <ArrowRight className="w-3 h-3" />
                        </Button>
                      )}
                      <ConfirmActionDialog
                        title={`Delete ${candidate.name}?`}
                        description="All of this candidate's data is removed — answers, scores, interviews, and decision history. This cannot be undone."
                        confirmLabel="Delete candidate"
                        testId={`dialog-confirm-delete-candidate-${candidate.id}`}
                        onConfirm={() => deleteCandidateMutation.mutate(candidate.id)}
                        trigger={
                          <Button size="sm" variant="ghost" className="h-5 px-1 text-xs text-red-400 hover:text-red-600" onClick={e => e.stopPropagation()} title="Delete candidate" data-testid={`button-delete-candidate-${candidate.id}`}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Task #4005: candidate pools beyond the fetched pages load on demand —
          the board and the rejected list below both render from the same
          accumulated list, so one control serves both views. */}
      {candidatesHasNextPage && (
        <Button
          size="sm"
          variant="outline"
          className="w-full text-xs mt-2"
          onClick={() => fetchNextCandidatesPage()}
          disabled={candidatesFetchingNextPage}
          data-testid="button-load-more-candidates"
        >
          {candidatesFetchingNextPage ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          Load more candidates
        </Button>
      )}

      {rejectedCandidates.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm text-muted-foreground cursor-pointer hover:text-foreground">
            Rejected / Withdrawn ({rejectedCandidates.length})
          </summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {rejectedCandidates.map(c => (
              <div
                key={c.id}
                className="p-2 border bg-muted/50 text-sm opacity-60 cursor-pointer hover:opacity-80 hover:border-primary/40 hover:shadow-sm transition-all"
                onClick={() => { setSelectedCandidateId(c.id); setCandidateNotes(c.notes || ""); }}
                data-testid={`card-candidate-rejected-${c.id}`}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-muted-foreground ml-2">{c.email}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );

  const renderEditableQuestions = () => {
    const questions = editingQuestions ? editedQuestions : (selectedJob?.screeningQuestions as any[]) || [];
    return (
      <Card className="bg-card border-primary/10">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Screening Questions</CardTitle>
              <CardDescription>AI-generated questions — click Edit to customize</CardDescription>
            </div>
            {!editingQuestions ? (
              <Button size="sm" variant="outline" onClick={() => { setEditingQuestions(true); setEditedQuestions([...questions]); }} data-testid="button-edit-questions">
                <Pencil className="w-3 h-3 mr-1" /> Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditingQuestions(false)}>Cancel</Button>
                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => updateJobMutation.mutate({ jobId: selectedJob!.id, data: { screeningQuestions: editedQuestions } })} data-testid="button-save-questions">
                  Save
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {questions.length === 0 && !editingQuestions ? (
            <div className="text-center py-8 text-muted-foreground">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Click "Generate AI Flow" to create screening questions.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(editingQuestions ? editedQuestions : questions).map((q: any, i: number) => (
                <div key={q.id} className="p-3 border bg-muted/50">
                  <div className="flex items-start gap-2">
                    {editingQuestions && (
                      <div className="flex flex-col gap-0.5 mt-1">
                        <button className="text-muted-foreground hover:text-muted-foreground disabled:opacity-30" disabled={i === 0} onClick={() => setEditedQuestions(moveQuestion(editedQuestions, i, i - 1))}>▲</button>
                        <button className="text-muted-foreground hover:text-muted-foreground disabled:opacity-30" disabled={i === editedQuestions.length - 1} onClick={() => setEditedQuestions(moveQuestion(editedQuestions, i, i + 1))}>▼</button>
                      </div>
                    )}
                    <span className="text-xs font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">{i + 1}</span>
                    <div className="flex-1">
                      {editingQuestions ? (
                        <Textarea value={q.prompt} onChange={e => { const copy = [...editedQuestions]; copy[i] = { ...copy[i], prompt: e.target.value }; setEditedQuestions(copy); }} rows={2} className="text-sm" />
                      ) : (
                        <p className="text-sm font-medium">{q.prompt}</p>
                      )}
                      <div className="flex gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{q.type}</Badge>
                        {q.required && <Badge variant="outline" className="text-xs text-red-500">Required</Badge>}
                      </div>
                    </div>
                    {editingQuestions && (
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600 h-7 w-7 p-0" onClick={() => setEditedQuestions(editedQuestions.filter((_, idx) => idx !== i))}>
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {editingQuestions && (
                <Button size="sm" variant="outline" className="w-full" onClick={() => setEditedQuestions([...editedQuestions, { id: `custom_${Date.now()}`, prompt: "", type: "text", required: true }])} data-testid="button-add-question">
                  <Plus className="w-3 h-3 mr-1" /> Add Question
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderEditableVideoTasks = () => {
    const tasks = editingVideoTasks ? editedVideoTasks : (selectedJob?.videoTasks as any[]) || [];
    return (
      <Card className="bg-card border-primary/10">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Video Tasks</CardTitle>
              <CardDescription>Candidates record video responses to these prompts</CardDescription>
            </div>
            {!editingVideoTasks ? (
              <Button size="sm" variant="outline" onClick={() => { setEditingVideoTasks(true); setEditedVideoTasks([...tasks]); }} data-testid="button-edit-video-tasks">
                <Pencil className="w-3 h-3 mr-1" /> Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditingVideoTasks(false)}>Cancel</Button>
                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => updateJobMutation.mutate({ jobId: selectedJob!.id, data: { videoTasks: editedVideoTasks } })} data-testid="button-save-video-tasks">
                  Save
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 && !editingVideoTasks ? (
            <div className="text-center py-8 text-muted-foreground">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Click "Generate AI Flow" to create video tasks.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(editingVideoTasks ? editedVideoTasks : tasks).map((v: any, i: number) => (
                <div key={v.id} className="p-3 border bg-muted/50">
                  <div className="flex items-start gap-2">
                    {editingVideoTasks && (
                      <div className="flex flex-col gap-0.5 mt-1">
                        <button className="text-muted-foreground hover:text-muted-foreground disabled:opacity-30" disabled={i === 0} onClick={() => setEditedVideoTasks(moveQuestion(editedVideoTasks, i, i - 1))}>▲</button>
                        <button className="text-muted-foreground hover:text-muted-foreground disabled:opacity-30" disabled={i === editedVideoTasks.length - 1} onClick={() => setEditedVideoTasks(moveQuestion(editedVideoTasks, i, i + 1))}>▼</button>
                      </div>
                    )}
                    <span className="text-xs font-mono bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">V{i + 1}</span>
                    <div className="flex-1">
                      {editingVideoTasks ? (
                        <>
                          <Textarea value={v.prompt} onChange={e => { const copy = [...editedVideoTasks]; copy[i] = { ...copy[i], prompt: e.target.value }; setEditedVideoTasks(copy); }} rows={2} className="text-sm mb-1" />
                          <Input type="number" value={v.durationSec} onChange={e => { const copy = [...editedVideoTasks]; copy[i] = { ...copy[i], durationSec: parseInt(e.target.value) || 60 }; setEditedVideoTasks(copy); }} className="w-24 text-xs" placeholder="Duration (s)" />
                        </>
                      ) : (
                        <p className="text-sm font-medium">{v.prompt}</p>
                      )}
                      <div className="flex gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{v.durationSec}s max</Badge>
                        {v.required && <Badge variant="outline" className="text-xs text-red-500">Required</Badge>}
                      </div>
                    </div>
                    {editingVideoTasks && (
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600 h-7 w-7 p-0" onClick={() => setEditedVideoTasks(editedVideoTasks.filter((_, idx) => idx !== i))}>
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {editingVideoTasks && (
                <Button size="sm" variant="outline" className="w-full" onClick={() => setEditedVideoTasks([...editedVideoTasks, { id: `custom_v_${Date.now()}`, prompt: "", durationSec: 120, required: true }])} data-testid="button-add-video-task">
                  <Plus className="w-3 h-3 mr-1" /> Add Video Task
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderEditableRubric = () => {
    const rubric = selectedJob?.rubric as any;
    const dims = editingRubric ? editedRubricDimensions : (rubric?.dimensions || []);
    const hfails = editingRubric ? editedHardFails : ((selectedJob?.hardFails as string[]) || []);

    return (
      <Card className="bg-card border-primary/10">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Scoring Rubric</CardTitle>
              <CardDescription>How the AI evaluates candidate responses</CardDescription>
            </div>
            {!editingRubric ? (
              <Button size="sm" variant="outline" onClick={() => { setEditingRubric(true); setEditedRubricDimensions([...dims]); setEditedHardFails([...hfails]); }} data-testid="button-edit-rubric">
                <Pencil className="w-3 h-3 mr-1" /> Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditingRubric(false)}>Cancel</Button>
                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => updateJobMutation.mutate({ jobId: selectedJob!.id, data: { rubric: { dimensions: editedRubricDimensions }, hardFails: editedHardFails } })} data-testid="button-save-rubric">
                  Save
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {dims.length === 0 && !editingRubric ? (
            <div className="text-center py-8 text-muted-foreground">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Click "Generate AI Flow" to create the rubric.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3">
                {dims.map((d: any, i: number) => (
                  <div key={i} className="p-3 border bg-muted/50">
                    {editingRubric ? (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <Input value={d.name} onChange={e => { const copy = [...editedRubricDimensions]; copy[i] = { ...copy[i], name: e.target.value }; setEditedRubricDimensions(copy); }} placeholder="Dimension name" className="text-sm" />
                          <Input type="number" step="0.05" min="0" max="1" value={d.weight} onChange={e => { const copy = [...editedRubricDimensions]; copy[i] = { ...copy[i], weight: parseFloat(e.target.value) || 0 }; setEditedRubricDimensions(copy); }} className="w-24 text-xs" placeholder="Weight" />
                          <Button size="sm" variant="ghost" className="text-red-400 h-8 w-8 p-0" onClick={() => setEditedRubricDimensions(editedRubricDimensions.filter((_, idx) => idx !== i))}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                        <Textarea value={d.criteria} onChange={e => { const copy = [...editedRubricDimensions]; copy[i] = { ...copy[i], criteria: e.target.value }; setEditedRubricDimensions(copy); }} rows={2} className="text-xs" placeholder="Scoring criteria" />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-sm">{d.name}</span>
                          <Badge variant="outline" className="text-xs">Weight: {((d.weight ?? 0) * 100).toFixed(0)}%</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{d.criteria}</p>
                      </>
                    )}
                  </div>
                ))}
                {editingRubric && (
                  <Button size="sm" variant="outline" className="w-full" onClick={() => setEditedRubricDimensions([...editedRubricDimensions, { name: "", weight: 0.1, criteria: "" }])}>
                    <Plus className="w-3 h-3 mr-1" /> Add Dimension
                  </Button>
                )}
              </div>

              <div>
                <h4 className="text-sm font-medium text-red-600 mb-2">Hard Fails</h4>
                {editingRubric ? (
                  <div className="space-y-2">
                    {editedHardFails.map((hf, i) => (
                      <div key={i} className="flex gap-2">
                        <Input value={hf} onChange={e => { const copy = [...editedHardFails]; copy[i] = e.target.value; setEditedHardFails(copy); }} className="text-sm" />
                        <Button size="sm" variant="ghost" className="text-red-400 h-8 w-8 p-0" onClick={() => setEditedHardFails(editedHardFails.filter((_, idx) => idx !== i))}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <Button size="sm" variant="outline" className="w-full" onClick={() => setEditedHardFails([...editedHardFails, ""])}>
                      <Plus className="w-3 h-3 mr-1" /> Add Hard Fail
                    </Button>
                  </div>
                ) : hfails.length > 0 ? (
                  <ul className="space-y-1">
                    {hfails.map((hf: string, i: number) => (
                      <li key={i} className="text-sm text-red-500 flex items-start gap-1">
                        <span className="mt-0.5">&#x2022;</span> {hf}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No hard-fail signals defined.</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderAnalytics = () => {
    if (!analytics) return (
      <Card className="bg-card border-primary/10">
        <CardContent className="p-8 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          <p className="text-sm">Loading analytics...</p>
        </CardContent>
      </Card>
    );

    const maxCount = Math.max(1, ...Object.values(analytics.stageCounts));

    return (
      <div className="space-y-4">
        <Card className="bg-card border-primary/10">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2"><BarChart3 className="w-5 h-5" /> Pipeline Analytics</CardTitle>
            <CardDescription>{analytics.totalCandidates} total candidates</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {kanbanStages.map(stage => {
                const count = analytics.stageCounts[stage] || 0;
                const rate = analytics.conversionRates[stage];
                const avg = analytics.avgScores[stage];
                return (
                  <div key={stage}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <div className="flex items-center gap-2">
                        <Badge className={`text-xs ${stageColors[stage]}`}>{stageLabels[stage]}</Badge>
                        <span className="font-mono">{count}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {rate !== undefined && <span>{(rate * 100).toFixed(0)}% conversion</span>}
                        {avg !== undefined && <span>Avg score: {avg.toFixed(0)}</span>}
                      </div>
                    </div>
                    <div className="w-full bg-muted rounded-pill h-3">
                      <div
                        className="h-3 rounded-pill bg-primary/60 transition-all"
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {(analytics.stageCounts["rejected"] || 0) > 0 && (
              <div className="pt-3 border-t">
                <div className="flex items-center gap-2 text-sm">
                  <Badge className="text-xs bg-red-100 text-red-700">Rejected</Badge>
                  <span className="font-mono">{analytics.stageCounts["rejected"]}</span>
                  <span className="text-xs text-muted-foreground">
                    ({((analytics.stageCounts["rejected"] / (analytics.totalCandidates || 1)) * 100).toFixed(0)}% of total)
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  };

  const templateTypeLabels: Record<string, string> = {
    invite: "Invitation",
    rejection: "Rejection",
    offer: "Offer",
    follow_up: "Follow-up",
    custom: "Custom",
  };

  const renderEmailTemplates = () => {
    const isEditing = !!editingTemplateId;
    const isFormOpen = showCreateTemplate || isEditing;

    return (
      <div className="space-y-4">
        <Card className="bg-card border-primary/10">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Email Templates</CardTitle>
                <CardDescription>
                  Templates with variables: {"{{candidate_name}}"}, {"{{job_title}}"}, {"{{portal_link}}"}, {"{{company_name}}"}, {"{{candidate_email}}"}
                </CardDescription>
              </div>
              {!isFormOpen && (
                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => { resetTemplateForm(); setShowCreateTemplate(true); }} data-testid="button-create-template">
                  <Plus className="w-3 h-3 mr-1" /> New Template
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isFormOpen && (
              <div className="border p-4 bg-muted/50 space-y-3">
                <h4 className="font-medium text-sm">{isEditing ? "Edit Template" : "New Template"}</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Name</label>
                    <Input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="e.g. Standard Invite" data-testid="input-template-name" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Type</label>
                    <select
                      value={templateType}
                      onChange={e => setTemplateType(e.target.value)}
                      className="w-full border border-input bg-background px-3 py-2 text-sm"
                      data-testid="select-template-type"
                    >
                      <option value="invite">Invitation</option>
                      <option value="rejection">Rejection</option>
                      <option value="offer">Offer</option>
                      <option value="follow_up">Follow-up</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Subject</label>
                  <Input value={templateSubject} onChange={e => setTemplateSubject(e.target.value)} placeholder="e.g. You're invited to apply for {{job_title}}" data-testid="input-template-subject" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Body</label>
                  <Textarea value={templateBody} onChange={e => setTemplateBody(e.target.value)} placeholder="Hi {{candidate_name}},&#10;&#10;We'd like to invite you to complete our screening for the {{job_title}} position.&#10;&#10;Click here to begin: {{portal_link}}" rows={8} data-testid="input-template-body" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={templateIsGlobal} onChange={e => setTemplateIsGlobal(e.target.checked)} className="rounded border-border" />
                  Global template (available across all jobs)
                </label>

                {(templateSubject || templateBody) && (
                  <div className="border p-3 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <h5 className="text-xs font-medium text-muted-foreground">Preview</h5>
                      {candidates.length > 0 && (
                        <select
                          className="text-xs border rounded px-2 py-1"
                          onChange={e => {
                            const c = candidates.find(c => c.id === e.target.value);
                            setPreviewCandidate(c || null);
                          }}
                          value={previewCandidate?.id || ""}
                        >
                          <option value="">Sample data</option>
                          {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                    </div>
                    <p className="text-sm font-medium mb-1">{fillVariables(templateSubject)}</p>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{fillVariables(templateBody)}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => {
                        const full = `Subject: ${fillVariables(templateSubject)}\n\n${fillVariables(templateBody)}`;
                        navigator.clipboard.writeText(full).catch((err) => console.error("[AtsAdmin] clipboard write failed:", err));
                        toast({ title: "Email copied to clipboard" });
                      }}
                      data-testid="button-copy-email"
                    >
                      <Copy className="w-3 h-3 mr-1" /> Copy Email
                    </Button>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setShowCreateTemplate(false); setEditingTemplateId(null); resetTemplateForm(); }}>Cancel</Button>
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90"
                    onClick={() => isEditing ? updateTemplateMutation.mutate() : createTemplateMutation.mutate()}
                    disabled={!templateName || !templateSubject || !templateBody || createTemplateMutation.isPending || updateTemplateMutation.isPending}
                    data-testid="button-save-template"
                  >
                    {(createTemplateMutation.isPending || updateTemplateMutation.isPending) && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    {isEditing ? "Update" : "Create"} Template
                  </Button>
                </div>
              </div>
            )}

            {emailTemplates.length === 0 && !isFormOpen ? (
              <p className="text-sm text-muted-foreground text-center py-6">No email templates yet. Create one to get started.</p>
            ) : (
              emailTemplates.map(tmpl => (
                <div key={tmpl.id} className="border p-4 hover:border-primary/30 transition-colors" data-testid={`card-template-${tmpl.id}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{tmpl.name}</span>
                        <Badge variant="outline" className="text-xs">{templateTypeLabels[tmpl.templateType] || tmpl.templateType}</Badge>
                        {tmpl.isGlobal && <Badge variant="outline" className="text-xs text-blue-600">Global</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mb-1">Subject: {tmpl.subject}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{tmpl.body}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => {
                        const filled = `Subject: ${fillVariables(tmpl.subject)}\n\n${fillVariables(tmpl.body)}`;
                        navigator.clipboard.writeText(filled).catch((err) => console.error("[AtsAdmin] clipboard write failed:", err));
                        toast({ title: "Email copied to clipboard" });
                      }} title="Copy with variables filled" data-testid={`button-use-template-${tmpl.id}`}>
                        <Copy className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => {
                        setEditingTemplateId(tmpl.id);
                        setShowCreateTemplate(false);
                        setTemplateName(tmpl.name);
                        setTemplateSubject(tmpl.subject);
                        setTemplateBody(tmpl.body);
                        setTemplateType(tmpl.templateType);
                        setTemplateIsGlobal(tmpl.isGlobal);
                      }} data-testid={`button-edit-template-${tmpl.id}`}>
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-red-400 hover:text-red-600" onClick={() => deleteTemplateMutation.mutate(tmpl.id)} data-testid={`button-delete-template-${tmpl.id}`}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    );
  };

  return (
    <AtsErrorBoundary>
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <PageHeader
          title="Applicant Tracking System"
          backHref="/"
          backLabel="Dashboard"
          titleTestId="text-ats-title"
          className="mb-6"
        />

        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-3">
            <Card className="bg-card border-primary/10">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg text-foreground">Jobs</CardTitle>
                  <Dialog open={showCreateJob} onOpenChange={setShowCreateJob}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="bg-primary hover:bg-primary/90" data-testid="button-create-job">
                        <Plus className="w-4 h-4 mr-1" /> New
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Create Job Posting</DialogTitle>
                        <DialogDescription>Upload a JD file or paste the description manually. AI will generate the interview flow.</DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 mt-2">
                        <div className="border-2 border-dashed border-border p-4 text-center">
                          <input
                            type="file"
                            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                            className="hidden"
                            id="jd-file-upload"
                            data-testid="input-jd-file"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setParsingFile(true);
                              try {
                                const formData = new FormData();
                                formData.append("file", file);
                                const res = await fetch("/api/ats/parse-jd", {
                                  method: "POST",
                                  body: formData,
                                  credentials: "include",
                                });
                                if (!res.ok) {
                                  const err = await res.json();
                                  throw new Error(err.error || "Failed to parse file");
                                }
                                const data = await res.json();
                                setNewJobTitle(data.title || "");
                                setNewJobDescription(data.description || "");
                                toast({ title: "File parsed successfully" });
                              } catch (err: any) {
                                toast({ title: err.message, variant: "destructive" });
                              } finally {
                                setParsingFile(false);
                                e.target.value = "";
                              }
                            }}
                          />
                          <label htmlFor="jd-file-upload" className="cursor-pointer flex flex-col items-center gap-2">
                            {parsingFile ? (
                              <>
                                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                                <span className="text-sm text-muted-foreground">Parsing file with AI...</span>
                              </>
                            ) : (
                              <>
                                <Upload className="w-8 h-8 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">Upload JD file</span>
                                <span className="text-xs text-muted-foreground">PDF, DOCX, or TXT</span>
                              </>
                            )}
                          </label>
                        </div>
                        <div className="relative flex items-center justify-center">
                          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
                          <span className="relative bg-card px-3 text-xs text-muted-foreground">or enter manually</span>
                        </div>
                        <div>
                          <label className="text-sm font-medium">Job Title</label>
                          <Input value={newJobTitle} onChange={e => setNewJobTitle(e.target.value)} placeholder="e.g. Senior Account Manager" data-testid="input-job-title" />
                        </div>
                        <div>
                          <label className="text-sm font-medium">Full Job Description</label>
                          <Textarea value={newJobDescription} onChange={e => setNewJobDescription(e.target.value)} placeholder="Paste the complete JD here..." rows={8} data-testid="input-job-description" />
                        </div>
                        <div className="relative flex items-center justify-center">
                          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
                          <span className="relative bg-card px-3 text-xs text-muted-foreground">Scorecard</span>
                        </div>
                        <div className="border-2 border-dashed border-border p-3 text-center">
                          <input
                            type="file"
                            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                            className="hidden"
                            id="scorecard-file-upload"
                            data-testid="input-scorecard-file"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setParsingScorecard(true);
                              try {
                                const formData = new FormData();
                                formData.append("file", file);
                                const res = await fetch("/api/ats/parse-scorecard", {
                                  method: "POST",
                                  body: formData,
                                  credentials: "include",
                                });
                                if (!res.ok) {
                                  const err = await res.json();
                                  throw new Error(err.error || "Failed to parse scorecard");
                                }
                                const data = await res.json();
                                setScorecardText(data.scorecardText || "");
                                setScorecardJson(data.scorecardJson);
                                toast({ title: "Scorecard parsed successfully" });
                              } catch (err: any) {
                                toast({ title: err.message, variant: "destructive" });
                              } finally {
                                setParsingScorecard(false);
                                e.target.value = "";
                              }
                            }}
                          />
                          <label htmlFor="scorecard-file-upload" className="cursor-pointer flex flex-col items-center gap-1">
                            {parsingScorecard ? (
                              <>
                                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                                <span className="text-xs text-muted-foreground">Parsing scorecard...</span>
                              </>
                            ) : scorecardJson ? (
                              <div className="text-left w-full px-2">
                                <div className="flex items-center gap-2 mb-1">
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                  <span className="text-sm font-medium text-green-700">Scorecard loaded</span>
                                </div>
                                <div className="text-xs text-muted-foreground space-y-0.5" data-testid="text-scorecard-preview">
                                  <div>Mission: {scorecardJson.mission?.substring(0, 60)}...</div>
                                  <div>{scorecardJson.outcomes?.length || 0} outcomes · {scorecardJson.competencies?.length || 0} competencies · {scorecardJson.non_negotiables?.length || 0} non-negotiables</div>
                                </div>
                              </div>
                            ) : (
                              <>
                                <Upload className="w-6 h-6 text-muted-foreground" />
                                <span className="text-xs font-medium text-foreground">Upload Scorecard</span>
                                <span className="text-[10px] text-muted-foreground">PDF, DOCX, or TXT — required for AI generation</span>
                              </>
                            )}
                          </label>
                        </div>
                        {!scorecardJson && (
                          <p className="text-xs text-amber-600 flex items-center gap-1" data-testid="text-scorecard-warning">
                            <AlertCircle className="w-3 h-3" /> Scorecard is required for AI assessment generation
                          </p>
                        )}
                        <Button onClick={() => createJobMutation.mutate()} disabled={!newJobTitle || !newJobDescription || createJobMutation.isPending || parsingFile || parsingScorecard} className="bg-primary hover:bg-primary/90 w-full" data-testid="button-submit-job">
                          {createJobMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                          Create Job
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {jobsLoading ? (
                  <div className="text-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
                ) : jobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No jobs yet.</p>
                ) : (
                  jobs.map(job => (
                    <button
                      key={job.id}
                      onClick={() => { setSelectedJobId(job.id); setSelectedCandidateId(null); setBulkSelected(new Set()); }}
                      className={`w-full text-left p-3 border transition-colors ${selectedJobId === job.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}
                      data-testid={`button-job-${job.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm truncate">{job.title}</span>
                        <Badge className={`text-xs ${job.status === "active" ? "bg-green-100 text-green-700" : job.status === "draft" ? "bg-muted text-muted-foreground" : job.status === "paused" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                          {job.status}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {job.aiGeneratedAt ? "AI Ready" : "Needs AI"} · {new Date(job.createdAt).toLocaleDateString()}
                      </div>
                    </button>
                  ))
                )}
                {jobsHasNextPage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-xs"
                    onClick={() => fetchNextJobsPage()}
                    disabled={jobsFetchingNextPage}
                    data-testid="button-load-more-jobs"
                  >
                    {jobsFetchingNextPage ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                    Load more jobs
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="col-span-9">
            {!selectedJob ? (
              <Card className="bg-card border-primary/10">
                <CardContent className="p-12 text-center text-muted-foreground">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-30" />
                  <p>Select a job or create a new one to get started.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                <Card className="bg-card border-primary/10">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-xl text-foreground" data-testid="text-job-title">{selectedJob.title}</CardTitle>
                        <CardDescription className="mt-1">
                          {selectedJob.aiGeneratedAt ? `AI generated ${new Date(selectedJob.aiGeneratedAt).toLocaleString()}` : "AI interview flow not yet generated"}
                        </CardDescription>
                      </div>
                      <div className="flex gap-2">
                        {selectedJob.status === "active" && (
                          <Button size="sm" variant="outline" className="border-yellow-500 text-yellow-600" onClick={() => updateJobMutation.mutate({ jobId: selectedJob.id, data: { status: "paused" } })} data-testid="button-pause-job">
                            Pause
                          </Button>
                        )}
                        {selectedJob.status === "paused" && (
                          <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => updateJobMutation.mutate({ jobId: selectedJob.id, data: { status: "active" } })} data-testid="button-resume-job">
                            Resume
                          </Button>
                        )}
                        {selectedJob.status === "draft" && selectedJob.aiGeneratedAt && (
                          <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => updateJobMutation.mutate({ jobId: selectedJob.id, data: { status: "active" } })} data-testid="button-activate-job">
                            Activate
                          </Button>
                        )}
                        {selectedJob.status !== "closed" && (
                          <Button size="sm" variant="outline" className="border-red-400 text-red-500" onClick={() => updateJobMutation.mutate({ jobId: selectedJob.id, data: { status: "closed" } })} data-testid="button-close-job">
                            Close
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => {
                          if (selectedJob.aiGeneratedAt) {
                            setRegenerateFeedbackText("");
                            setShowRegenerateFeedback(true);
                          } else {
                            generateMutation.mutate({ jobId: selectedJob.id });
                          }
                        }} disabled={generateMutation.isPending} className="border-primary text-primary-ink" data-testid="button-generate-ai">
                          {generateMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                          {selectedJob.aiGeneratedAt ? "Regenerate" : "Generate"} AI Flow
                        </Button>
                        <Dialog open={showRegenerateFeedback} onOpenChange={setShowRegenerateFeedback}>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Regenerate AI Flow</DialogTitle>
                              <DialogDescription>Provide feedback to guide the regeneration. Tell the AI what to change or improve.</DialogDescription>
                            </DialogHeader>
                            <Textarea
                              placeholder="e.g., Make the assessment harder on technical skills, add more scenario-based questions..."
                              value={regenerateFeedbackText}
                              onChange={(e) => setRegenerateFeedbackText(e.target.value)}
                              rows={4}
                              data-testid="textarea-regenerate-feedback"
                            />
                            <div className="flex justify-end gap-2 mt-2">
                              <Button variant="outline" onClick={() => setShowRegenerateFeedback(false)} data-testid="button-cancel-regenerate">Cancel</Button>
                              <Button className="bg-primary hover:bg-primary/90" disabled={!regenerateFeedbackText.trim()} onClick={() => {
                                setShowRegenerateFeedback(false);
                                generateMutation.mutate({ jobId: selectedJob.id, feedback: regenerateFeedbackText || undefined });
                              }} data-testid="button-confirm-regenerate">
                                <Sparkles className="w-4 h-4 mr-1" /> Regenerate
                              </Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </div>
                    </div>
                  </CardHeader>
                </Card>

                {genProgress && genProgress.active && (
                  <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20" data-testid="card-gen-progress">
                    <CardContent className="pt-6 pb-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                          <span className="font-semibold text-foreground">Generating AI Interview Flow</span>
                        </div>
                        <span className="text-sm font-mono text-muted-foreground" data-testid="text-gen-timer">
                          {Math.floor(genProgress.elapsed / 60)}:{String(genProgress.elapsed % 60).padStart(2, "0")}
                        </span>
                      </div>
                      <Progress value={genProgress.stage === 1 ? 10 : genProgress.stage === 2 ? 25 : genProgress.stage === 3 ? 55 : 85} className="h-2 mb-4" />
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: "Source of Truth", desc: "Role analysis", est: "~10s" },
                          { label: "Cognitive Profile", desc: "Behavior mapping", est: "~8s" },
                          { label: "Assessment", desc: "19 items, 7 layers", est: "~2 min" },
                          { label: "Rubric", desc: "5 dimensions", est: "~30s" },
                        ].map((s, i) => {
                          const stageNum = i + 1;
                          const isActive = genProgress.stage === stageNum;
                          const isDone = genProgress.stage > stageNum;
                          return (
                            <div key={i} className={`p-3 text-center transition-all ${isDone ? "bg-green-50 border border-green-200" : isActive ? "bg-card border border-primary/30 shadow-sm" : "bg-muted/50 border border-border opacity-50"}`} data-testid={`stage-${stageNum}`}>
                              <div className="flex items-center justify-center mb-1">
                                {isDone ? <CheckCircle className="w-4 h-4 text-green-600" /> : isActive ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <div className="w-4 h-4 rounded-pill border-2 border-border" />}
                              </div>
                              <div className={`text-xs font-semibold ${isDone ? "text-green-700" : isActive ? "text-foreground" : "text-muted-foreground"}`}>Stage {stageNum}</div>
                              <div className={`text-xs ${isDone ? "text-green-600" : isActive ? "text-foreground/80" : "text-muted-foreground"}`}>{s.label}</div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">{isDone ? "Done" : isActive ? s.est : s.est}</div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground mt-3 text-center">This typically takes 2-3 minutes. Each stage saves progress automatically.</p>
                    </CardContent>
                  </Card>
                )}

                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="grid w-full grid-cols-6">
                    <TabsTrigger value="pipeline" data-testid="tab-pipeline">Pipeline</TabsTrigger>
                    <TabsTrigger value="screening" data-testid="tab-screening">Questions</TabsTrigger>
                    <TabsTrigger value="video" data-testid="tab-video">Video</TabsTrigger>
                    <TabsTrigger value="rubric" data-testid="tab-rubric">Rubric</TabsTrigger>
                    <TabsTrigger value="templates" data-testid="tab-templates">Emails</TabsTrigger>
                    <TabsTrigger value="analytics" data-testid="tab-analytics">Analytics</TabsTrigger>
                  </TabsList>

                  <TabsContent value="pipeline">
                    <Card className="bg-card border-primary/10">
                      <CardContent className="pt-6">
                        {renderKanban()}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="screening">{renderEditableQuestions()}</TabsContent>
                  <TabsContent value="video">{renderEditableVideoTasks()}</TabsContent>
                  <TabsContent value="rubric">{renderEditableRubric()}</TabsContent>
                  <TabsContent value="templates">{renderEmailTemplates()}</TabsContent>
                  <TabsContent value="analytics">{renderAnalytics()}</TabsContent>
                </Tabs>
              </div>
            )}
          </div>
        </div>
      </div>

      <AtsErrorBoundary onReset={() => setSelectedCandidateId(null)}>
        {renderCandidateDetail()}
      </AtsErrorBoundary>
    </div>
    </AtsErrorBoundary>
  );
}
