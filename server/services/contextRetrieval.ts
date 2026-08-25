import { storage } from "../storage";
import type { AgentKnowledgeBase } from "@shared/schema";
import { applyStaleDecay } from "./agentKnowledgeService";

interface ContextPayload {
  knownFacts: {
    category: string;
    facts: Array<{
      text: string;
      confidence: number;
      lastSeen: string;
      /**
       * Task #4846 — provenance carried through so prompts can label facts
       * extracted from prior agent runs as AI-inferred. Only 'manual'
       * (operator-filed intel mirror) is human-verified; every agent source
       * is the system's own inference, and judgments were misattributing it
       * as "operator intel".
       */
      sourceAgent: string;
    }>;
  }[];
  recentCorrections: Array<{
    feedbackType: string;
    correctedValue: string | null;
    agentType: string;
    createdAt: Date | null;
  }>;
  factCount: number;
  // Task #3697 — data-availability inventory needs the UNCAPPED count (how
  // much agent memory exists at all) plus the newest lastSeenAt so the
  // judgment carry-forward fingerprint changes when memory changes.
  totalFactCount: number;
  latestFactSeenAt: string | null;
}

const CATEGORY_RELEVANCE: Record<string, Record<string, number>> = {
  daily_judgment: {
    client_preference: 1.0,
    recurring_concern: 1.0,
    relationship_insight: 0.9,
    strategic_context: 0.9,
    behavioral_pattern: 0.8,
    communication_pattern: 0.7,
    // Task #4292 — operator-filed concern context/resolutions. Max weight:
    // a human saying "already handled" must outrank AI-inferred patterns.
    operator_intel: 1.0,
  },
  communication_analysis: {
    client_preference: 0.9,
    communication_pattern: 1.0,
    recurring_concern: 0.8,
    behavioral_pattern: 0.9,
    relationship_insight: 0.7,
    strategic_context: 0.6,
    operator_intel: 0.8,
  },
  communication_enrichment: {
    behavioral_pattern: 1.0,
    communication_pattern: 1.0,
    client_preference: 0.8,
    relationship_insight: 0.9,
    recurring_concern: 0.7,
    strategic_context: 0.5,
    operator_intel: 0.6,
  },
  agent_chat: {
    client_preference: 1.0,
    strategic_context: 1.0,
    recurring_concern: 1.0,
    relationship_insight: 1.0,
    behavioral_pattern: 1.0,
    communication_pattern: 1.0,
    operator_intel: 1.0,
  },
};

function scoreEntry(entry: AgentKnowledgeBase, agentPurpose: string): number {
  const categoryWeight = CATEGORY_RELEVANCE[agentPurpose]?.[entry.factCategory] ?? 0.5;
  const effectiveConfidence = applyStaleDecay(entry.confidence, entry.lastSeenAt);
  const recencyDays = entry.lastSeenAt
    ? (Date.now() - entry.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24)
    : 365;
  const recencyBoost = Math.max(0.1, 1.0 - recencyDays / 180);
  return effectiveConfidence * categoryWeight * recencyBoost;
}

export async function getClientContext(
  clientId: string,
  agentPurpose: string,
  maxFacts: number = 30,
): Promise<ContextPayload> {
  const [allFacts, recentFeedback] = await Promise.all([
    storage.getAgentKnowledgeByClient(clientId, { isActive: true }),
    storage.getAgentFeedbackByClient(clientId, 10),
  ]);

  const scored = allFacts.map((entry) => ({
    entry,
    score: scoreEntry(entry, agentPurpose),
  }));

  scored.sort((a, b) => b.score - a.score);
  const topFacts = scored.slice(0, maxFacts).map((s) => s.entry);

  const grouped = new Map<string, AgentKnowledgeBase[]>();
  for (const fact of topFacts) {
    const existing = grouped.get(fact.factCategory) || [];
    existing.push(fact);
    grouped.set(fact.factCategory, existing);
  }

  const knownFacts = Array.from(grouped.entries()).map(([category, facts]) => ({
    category,
    facts: facts.map((f) => ({
      text: f.factText,
      confidence: applyStaleDecay(f.confidence, f.lastSeenAt),
      lastSeen: f.lastSeenAt?.toISOString().split("T")[0] || "unknown",
      sourceAgent: f.sourceAgent,
    })),
  }));

  const recentCorrections = recentFeedback.map((fb) => ({
    feedbackType: fb.feedbackType,
    correctedValue: fb.correctedValue,
    agentType: fb.agentType,
    createdAt: fb.createdAt,
  }));

  let latestFactSeenAt: string | null = null;
  for (const fact of allFacts) {
    const seen = fact.lastSeenAt?.toISOString() ?? null;
    if (seen && (!latestFactSeenAt || seen > latestFactSeenAt)) latestFactSeenAt = seen;
  }

  return {
    knownFacts,
    recentCorrections,
    factCount: topFacts.length,
    totalFactCount: allFacts.length,
    latestFactSeenAt,
  };
}

export function formatContextForPrompt(context: ContextPayload): string {
  if (context.factCount === 0 && context.recentCorrections.length === 0) {
    return "";
  }

  const parts: string[] = [];

  if (context.factCount > 0) {
    parts.push("=== WHAT THE SYSTEM ALREADY KNOWS ABOUT THIS CLIENT ===");
    // Task #4846 — provenance caution: most of this section is the system
    // re-reading its own earlier outputs. Without the label, judgments were
    // citing recycled AI narrative as "operator intel".
    parts.push(
      "Provenance: facts labeled [AI-inferred] were extracted from this system's own prior agent outputs — they are recycled inference, NOT human statements, NOT operator intel, and NOT measurements. Only facts labeled [human-filed] come from the account team. Treat AI-inferred facts as hypotheses that today's data must confirm; where today's data does not support an AI-inferred claim, drop it rather than restate it.",
    );
    for (const group of context.knownFacts) {
      const label = group.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      parts.push(`\n[${label}]`);
      for (const fact of group.facts) {
        const conf = fact.confidence >= 0.8 ? "high" : fact.confidence >= 0.5 ? "medium" : "low";
        const provenance = fact.sourceAgent === "manual" ? "human-filed" : "AI-inferred";
        parts.push(`- [${provenance}] ${fact.text} (confidence: ${conf}, last seen: ${fact.lastSeen})`);
      }
    }
    parts.push("");
  }

  if (context.recentCorrections.length > 0) {
    parts.push("=== PRIOR CORRECTIONS TO BE AWARE OF ===");
    for (const correction of context.recentCorrections) {
      const date = correction.createdAt ? new Date(correction.createdAt).toISOString().split("T")[0] : "unknown";
      if (correction.feedbackType === "corrected" && correction.correctedValue) {
        parts.push(`- [${date}] Correction from ${correction.agentType}: ${correction.correctedValue}`);
      } else if (correction.feedbackType === "dismissed") {
        parts.push(`- [${date}] User dismissed suggestion from ${correction.agentType}`);
      } else if (correction.feedbackType === "confirmed") {
        parts.push(`- [${date}] User confirmed output from ${correction.agentType}`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}
