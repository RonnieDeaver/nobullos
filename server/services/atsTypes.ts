import { z } from "zod";
import { QUALITY_MODEL, CHEAP_MODEL } from "../aiModels";

export const ATS_SPEC_VERSION = "2.0.0";
export const ATS_MODEL_ID = QUALITY_MODEL;
export const ATS_MODEL_FAST = CHEAP_MODEL;

export const assessmentLayerOptions = [
  "role_skill", "reality_based", "personality", "stress_test",
  "contradiction", "self_correction", "energy_audit"
] as const;
export type AssessmentLayer = typeof assessmentLayerOptions[number];

export const CANONICAL_SCORING_DIMENSIONS = [
  "role_skill", "role_behavior", "reality_based_mindset",
  "personality_alignment", "communication_clarity"
] as const;
export type ScoringDimension = typeof CANONICAL_SCORING_DIMENSIONS[number];

export const DIMENSION_SYNONYM_MAP: Record<string, ScoringDimension> = {
  "stress_resilience": "role_behavior",
  "stress_response": "role_behavior",
  "resilience": "role_behavior",
  "reality_based": "reality_based_mindset",
  "personality": "personality_alignment",
  "communication": "communication_clarity",
};

export const LAYER_TO_DIMENSION_MAP: Record<AssessmentLayer, ScoringDimension[]> = {
  role_skill: ["role_skill", "role_behavior"],
  reality_based: ["reality_based_mindset"],
  personality: ["personality_alignment"],
  stress_test: ["role_behavior"],
  contradiction: ["role_behavior"],
  self_correction: ["personality_alignment", "communication_clarity"],
  energy_audit: ["personality_alignment"],
};

export const CANONICAL_EVIDENCE_MARKERS = [
  "claims", "actions", "outcomes",
  "ownership_language", "blame_language",
  "emotional_reactivity_markers", "structure_signals", "speed_signals",
  "conflict_posture", "ambiguity_behavior",
  "technical_competence_signals", "solution_orientation_signals",
] as const;
export type CanonicalMarker = typeof CANONICAL_EVIDENCE_MARKERS[number];

export const MARKER_SYNONYM_MAP: Record<string, CanonicalMarker> = {
  "process discipline": "structure_signals",
  "process_discipline": "structure_signals",
  "clarity": "structure_signals",
  "resistance_management": "conflict_posture",
  "solution-orientation": "solution_orientation_signals",
  "solution orientation": "solution_orientation_signals",
  "solution_orientation": "solution_orientation_signals",
  "technical understanding": "technical_competence_signals",
  "technical_understanding": "technical_competence_signals",
  "technical competence": "technical_competence_signals",
  "energy strategies": "actions",
  "energy_strategies": "actions",
  "decision making": "actions",
  "decision_making": "actions",
  "accountability": "ownership_language",
  "blame": "blame_language",
  "emotional reactivity": "emotional_reactivity_markers",
  "conflict": "conflict_posture",
  "ambiguity": "ambiguity_behavior",
  "speed": "speed_signals",
  "structure": "structure_signals",
};

export const riskTierOptions = ["green", "yellow", "orange", "red"] as const;
export type RiskTier = typeof riskTierOptions[number];

export const aiRunStageOptions = [
  "source_of_truth", "cognitive_profile", "assessment", "rubric",
  "evidence", "scoring", "hiring_card"
] as const;
export type AiRunStage = typeof aiRunStageOptions[number];

export const ScorecardOutcomeSchema = z.object({
  id: z.string(),
  text: z.string(),
});

export const ScorecardJsonSchema = z.object({
  mission: z.string().min(5),
  outcomes: z.array(ScorecardOutcomeSchema).min(3).max(10),
  competencies: z.array(z.string()).min(3).max(10),
  non_negotiables: z.array(z.object({
    id: z.string(),
    text: z.string(),
  })).min(3).max(12),
  constraints: z.array(z.string()).min(1).max(10),
});
export type ScorecardJson = z.infer<typeof ScorecardJsonSchema>;

export const ResumeProfileSchema = z.object({
  years_experience_estimate: z.number().nullable(),
  recent_roles: z.array(z.object({
    title: z.string(),
    dates: z.string(),
  })),
  skills_claimed: z.array(z.string()),
  tools_claimed: z.array(z.string()),
  domain_claims: z.array(z.string()),
  leadership_claims: z.array(z.string()),
  project_scale_claims: z.array(z.string()),
  credential_claims: z.array(z.string()),
});
export type ResumeProfile = z.infer<typeof ResumeProfileSchema>;

export const ResumeConsistencySchema = z.object({
  resume_consistency_flag: z.enum(["none", "possible", "high"]),
  consistency_reasons: z.array(z.string()),
  seniority_mismatch_flag: z.enum(["none", "possible", "high"]),
  suggested_followup_questions: z.array(z.string()),
});
export type ResumeConsistency = z.infer<typeof ResumeConsistencySchema>;

export const RoleSourceOfTruthSchema = z.object({
  role_summary: z.string().min(10),
  top_outcomes: z.array(z.string()).min(5).max(10),
  responsibilities: z.array(z.string()).min(6).max(15),
  required_skills: z.array(z.string()).min(1),
  preferred_skills: z.array(z.string()),
  tools_stack: z.array(z.string()),
  technical_domains: z.array(z.string()),
  stakeholders: z.object({
    internal: z.array(z.string()),
    external: z.array(z.string()),
  }),
  constraints: z.array(z.string()),
  stressors: z.array(z.string()).min(1),
  non_negotiables: z.array(z.object({
    id: z.string(),
    text: z.string(),
  })).min(5).max(10),
});
export type RoleSourceOfTruth = z.infer<typeof RoleSourceOfTruthSchema>;

export const CognitiveLoadDimensionSchema = z.object({
  score: z.number().min(1).max(10),
  implication: z.string(),
});

export const CognitiveProfileSchema = z.object({
  cognitive_load_map: z.object({
    ambiguity_tolerance_required: CognitiveLoadDimensionSchema,
    speed_vs_precision_bias: CognitiveLoadDimensionSchema,
    conflict_exposure: CognitiveLoadDimensionSchema,
    emotional_labor: CognitiveLoadDimensionSchema,
    initiative_requirement: CognitiveLoadDimensionSchema,
    systems_thinking_depth: CognitiveLoadDimensionSchema,
    process_discipline: CognitiveLoadDimensionSchema,
    persuasion_intensity: CognitiveLoadDimensionSchema,
    detail_penalty_risk: CognitiveLoadDimensionSchema,
    context_switching_intensity: CognitiveLoadDimensionSchema,
  }),
  ideal_default_operating_mode: z.array(z.string()).min(6).max(10),
  action_tendencies_map: z.object({
    fact_finding_bias: z.number().min(0).max(100),
    follow_through_bias: z.number().min(0).max(100),
    quick_start_bias: z.number().min(0).max(100),
    tangible_build_bias: z.number().min(0).max(100),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }),
  risk_pattern_predictions: z.object({
    mismatch_risks: z.array(z.string()).min(3).max(6),
    coaching_levers: z.array(z.string()).min(3).max(6),
  }),
});
export type CognitiveProfile = z.infer<typeof CognitiveProfileSchema>;

export const AssessmentItemSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  type: z.enum(["text", "video", "timed_text"]),
  layer: z.enum(assessmentLayerOptions),
  ordering_index: z.number(),
  required: z.boolean(),
  duration_sec: z.number().optional(),
  time_limit_sec: z.number().optional(),
  no_redo: z.boolean().optional(),
  contradiction_pair_id: z.string().optional(),
  contradiction_role: z.enum(["A", "B"]).optional(),
  trait_target: z.string().optional(),
  maps_to_non_negotiable: z.string().nullable().optional(),
  maps_to_outcome: z.string().nullable().optional(),
  expected_evidence_markers: z.array(z.string()).optional(),
  scoring_dimension_targets: z.array(z.string()).optional(),
  disqualifying_patterns: z.array(z.string()).optional(),
});
export type AssessmentItem = z.infer<typeof AssessmentItemSchema>;

export const AssessmentJsonSchema = z.object({
  items: z.array(AssessmentItemSchema),
  meta: z.object({
    total_items: z.number(),
    total_text_items: z.number().optional(),
    total_video_items: z.number().optional(),
    total_timed_items: z.number().optional(),
    layer_counts: z.record(z.string(), z.number()),
    contradiction_pair_ids: z.array(z.string()),
    stress_test_id: z.string(),
    self_correction_id: z.string(),
    energy_audit_id: z.string(),
  }),
});
export type AssessmentJson = z.infer<typeof AssessmentJsonSchema>;

export const RubricAnchorSchema = z.object({
  score: z.number(),
  label: z.string(),
  evidence: z.string(),
});

export const RubricDimensionFullSchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  is_diagnostic: z.boolean(),
  definition: z.string(),
  anchors: z.array(RubricAnchorSchema).min(5),
  evidence_requirements: z.string(),
  disqualifying_patterns: z.array(z.string()),
  required_evidence_markers: z.array(z.string()).optional(),
  minimum_specificity: z.string().optional(),
  penalty_rules: z.array(z.string()).optional(),
});
export type RubricDimensionFull = z.infer<typeof RubricDimensionFullSchema>;

export const RubricJsonSchema = z.object({
  dimensions: z.array(RubricDimensionFullSchema).min(5),
  total_weighted_check: z.number(),
});
export type RubricJson = z.infer<typeof RubricJsonSchema>;

export const EvidenceMarkersSchema = z.object({
  question_id: z.string(),
  claims: z.array(z.string()),
  actions: z.array(z.string()),
  outcomes: z.array(z.string()),
  ownership_language: z.array(z.string()),
  blame_language: z.array(z.string()),
  hedging_language: z.array(z.string()),
  emotional_reactivity_markers: z.array(z.string()),
  structure_signals: z.array(z.string()),
  speed_signals: z.array(z.string()),
  conflict_posture: z.string(),
  ambiguity_behavior: z.string(),
  technical_competence_signals: z.array(z.string()).optional().default([]),
  solution_orientation_signals: z.array(z.string()).optional().default([]),
  excerpt_evidence: z.array(z.object({
    marker_group: z.string(),
    excerpts: z.array(z.string()).min(1).max(3),
  })),
});
export type EvidenceMarkers = z.infer<typeof EvidenceMarkersSchema>;

export const ContradictionScoresSchema = z.object({
  pair_id: z.string(),
  trait_target: z.string(),
  narrative_consistency_score: z.number().min(0).max(100),
  responsibility_consistency_score: z.number().min(0).max(100),
  evasion_score: z.number().min(0).max(100),
});
export type ContradictionScores = z.infer<typeof ContradictionScoresSchema>;

export const SelfCorrectionScoresSchema = z.object({
  ego_flexibility: z.number().min(0).max(100),
  quality_of_revision: z.number().min(0).max(100),
  defensiveness: z.number().min(0).max(100),
  learning_velocity: z.number().min(0).max(100),
});
export type SelfCorrectionScores = z.infer<typeof SelfCorrectionScoresSchema>;

export const EnergyAuditScoresSchema = z.object({
  specificity: z.number().min(0).max(100),
  process_excited_vs_status_excited: z.string(),
  alignment_to_role_stressors: z.number().min(0).max(100),
  intrinsic_motivation_markers: z.array(z.string()),
});
export type EnergyAuditScores = z.infer<typeof EnergyAuditScoresSchema>;

export const AgencyFeaturesSchema = z.object({
  active_voice_count: z.number(),
  passive_voice_count: z.number(),
  external_causality_count: z.number(),
  constraint_reframe_count: z.number(),
  initiative_count: z.number(),
  hedging_count: z.number(),
  vagueness_count: z.number(),
  action_outcome_links_count: z.number(),
  self_correction_count: z.number(),
  high_agency_excerpts: z.array(z.string()).max(3).optional(),
  low_agency_excerpts: z.array(z.string()).max(3).optional(),
});
export type AgencyFeatures = z.infer<typeof AgencyFeaturesSchema>;

export const LanguageAgencyResultSchema = z.object({
  overall_score: z.number().min(0).max(100),
  agency_under_pressure: z.number(),
  agency_consistency: z.number(),
  per_item_scores: z.record(z.string(), z.number()),
  feature_counts: z.record(z.string(), AgencyFeaturesSchema),
  high_agency_quote: z.string().optional(),
  low_agency_quote: z.string().optional(),
});
export type LanguageAgencyResult = z.infer<typeof LanguageAgencyResultSchema>;

export const AGENCY_LAYER_WEIGHTS: Record<string, number> = {
  stress_test: 2.0,
  contradiction: 1.5,
  role_skill: 1.25,
  reality_based: 1.0,
  self_correction: 1.25,
  energy_audit: 1.25,
  personality: 1.0,
};

export const AiLikelihoodResultSchema = z.object({
  ai_style_score: z.number().min(0).max(100),
  written_video_coherence_delta: z.number().min(0).max(100),
  stress_structure_delta: z.number().min(0).max(100),
  revision_depth_score: z.number().min(0).max(100),
  detail_density_penalty: z.number().min(0).max(100),
  paste_behavior_penalty: z.number().min(0).max(100),
  ai_likelihood_score: z.number().min(0).max(100),
  ai_assistance_flag: z.enum(["none", "possible", "high"]),
  signals: z.array(z.string()),
});
export type AiLikelihoodResult = z.infer<typeof AiLikelihoodResultSchema>;

export const ScoringResultSchema = z.object({
  role_skill_score: z.number().min(0).max(100),
  role_behavior_score: z.number().min(0).max(100),
  reality_based_score: z.number().min(0).max(100),
  personality_alignment_score: z.number().min(0).max(100),
  communication_clarity_score: z.number().min(0).max(100),
  base_total: z.number(),
  low_effort_multiplier: z.number(),
  low_effort_reason: z.string().optional(),
  stress_multiplier: z.number(),
  stress_reason: z.string().optional(),
  final_score: z.number(),
  fit_delta: z.number(),
  fit_delta_interpretation: z.string(),
  contradiction_scores: z.array(ContradictionScoresSchema).optional(),
  self_correction_scores: SelfCorrectionScoresSchema.optional(),
  energy_audit_scores: EnergyAuditScoresSchema.optional(),
  risk_tier: z.enum(riskTierOptions),
  risk_tier_reasons: z.array(z.string()).min(1).max(3),
  language_agency: LanguageAgencyResultSchema.optional(),
  hard_fail_triggered: z.boolean(),
  hard_fail_reason: z.string().optional(),
  dimension_details: z.array(z.object({
    dimension: z.string(),
    score: z.number(),
    weight: z.number(),
    is_diagnostic: z.boolean(),
    feedback: z.string(),
    key_evidence: z.array(z.string()),
  })),
  audit: z.object({
    model_id: z.string(),
    spec_version: z.string(),
    scored_at: z.string(),
    response_completeness: z.record(z.string(), z.number()),
  }),
});
export type ScoringResult = z.infer<typeof ScoringResultSchema>;

export const HiringCardSchema = z.object({
  final_score: z.number(),
  dimension_scores: z.record(z.string(), z.number()),
  fit_delta: z.number(),
  fit_delta_interpretation: z.string(),
  multipliers: z.array(z.object({
    name: z.string(),
    value: z.number(),
    reason: z.string(),
  })),
  risk_tier: z.enum(riskTierOptions),
  risk_tier_reasons: z.array(z.string()),
  hard_fail_triggered: z.boolean(),
  hard_fail_reason: z.string().optional(),
  top_strengths: z.array(z.string()).length(3),
  top_risks: z.array(z.string()).length(3),
  most_likely_friction_point: z.string(),
  recommended_interview_angles: z.array(z.string()).length(3),
  evidence_excerpts: z.array(z.object({
    claim: z.string(),
    excerpt: z.string(),
    source_question_id: z.string(),
  })),
  default_operating_mode_summary: z.string(),
  most_likely_manager_style_needed: z.string(),
  contradiction_summary: z.string().optional(),
  self_correction_summary: z.string().optional(),
  energy_alignment_summary: z.string().optional(),
  language_agency_summary: z.object({
    overall: z.number(),
    under_pressure: z.number(),
    consistency_label: z.string(),
    high_agency_quote: z.string().optional(),
    low_agency_quote: z.string().optional(),
  }).optional(),
  response_authenticity: z.object({
    ai_assistance_flag: z.enum(["none", "possible", "high"]),
    ai_likelihood_score: z.number(),
    signals: z.array(z.string()),
  }).optional(),
  resume_consistency: z.object({
    resume_consistency_flag: z.enum(["none", "possible", "high"]),
    consistency_reasons: z.array(z.string()),
    seniority_mismatch_flag: z.enum(["none", "possible", "high"]),
    suggested_followup_questions: z.array(z.string()),
  }).optional(),
  safety_note: z.string(),
});
export type HiringCard = z.infer<typeof HiringCardSchema>;

export function cleanAiJson(raw: string): string {
  let cleaned = raw.replace(/^\uFEFF/, "").trim();

  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
  cleaned = cleaned.trim();

  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let jsonStart = -1;
  if (firstBrace === -1 && firstBracket === -1) return cleaned;
  if (firstBrace === -1) jsonStart = firstBracket;
  else if (firstBracket === -1) jsonStart = firstBrace;
  else jsonStart = Math.min(firstBrace, firstBracket);

  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }

  const isObj = cleaned.startsWith("{");
  const openChar = isObj ? "{" : "[";
  const closeChar = isObj ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastClose = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) { lastClose = i; break; } }
  }
  if (lastClose > 0 && lastClose < cleaned.length - 1) {
    cleaned = cleaned.slice(0, lastClose + 1);
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");

  return cleaned;
}

export function sanitizeCandidateText(text: string): string {
  return sanitizePromptInput(text);
}

export function sanitizePromptInput(text: string): string {
  return text
    .replace(/SYSTEM\s*:/gi, "[FILTERED]:")
    .replace(/IGNORE\s+(ALL\s+)?PREVIOUS\s+(INSTRUCTIONS?)?/gi, "[FILTERED]")
    .replace(/YOU\s+ARE\s+NOW/gi, "[FILTERED]")
    .replace(/OVERRIDE\s+(SCORING|WEIGHTS?|RUBRIC|RULES?|INSTRUCTIONS?)/gi, "[FILTERED]")
    .replace(/DISREGARD\s+(ABOVE|PREVIOUS|ALL)/gi, "[FILTERED]")
    .replace(/FORGET\s+(EVERYTHING|ALL|YOUR)/gi, "[FILTERED]")
    .replace(/PRETEND\s+(YOU\s+ARE|TO\s+BE)/gi, "[FILTERED]")
    .replace(/ACT\s+AS\s+(IF|A|AN)/gi, "[FILTERED]")
    .replace(/NEW\s+INSTRUCTIONS?\s*:/gi, "[FILTERED]:");
}
