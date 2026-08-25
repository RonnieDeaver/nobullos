// @db-pool-intent: worker
//
// Task #1723 (Phase 2.4): the agent-memory rebuild paths
// (`persistKnowledgeFacts`, `propagateFeedbackToKnowledge`,
// `extractChatKnowledge`, `extractAndPersistFromAgentOutput`) are all
// write-heavy background work invoked from worker-class flows
// (daily-judgment, communication-analysis, communication-enrichment).
// We funnel every mutator through `runWithWorkerDb` so the
// `storage.*` calls land on the worker pool even when an outer caller
// is itself an API route handler.
import { runWithWorkerDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import type { InsertAgentKnowledgeBase, KnowledgeFactCategory, KnowledgeSourceAgent } from "@shared/schema";
import {
  filterFabricatedZeroFacts,
  getClientMetricTracking,
  matchFabricatedZeroClaim,
} from "./judgmentMetricTracking";

const STALE_SIGNAL_DAYS = 90;
const STALE_DECAY_FACTOR = 0.8;
const MIN_CONFIDENCE = 0.05;
const BOOST_FACTOR = 1.15;
const PENALTY_FACTOR = 0.65;

interface ExtractedFact {
  category: KnowledgeFactCategory;
  text: string;
  confidence: number;
}

interface AgentOutput {
  summary?: string;
  signals?: Array<{ type: string; description: string; relevance?: string }>;
  concerns?: string[];
  wins?: string[];
  sentimentSummary?: string;
  unresolvedAsks?: string[];
  perPersonSentiment?: Array<{ name: string; frustration: number; trust: number }>;
  complaintThemes?: Array<{ category: string; severity: number; evidence: string }>;
}

function mapSignalToCategory(signalType: string): ExtractedFact["category"] {
  const mapping: Record<string, ExtractedFact["category"]> = {
    budget_mention: "strategic_context",
    priority_shift: "strategic_context",
    goal_change: "strategic_context",
    product_change: "strategic_context",
    risk_signal: "recurring_concern",
    dissatisfaction: "recurring_concern",
    execution_update: "relationship_insight",
    client_preference: "client_preference",
    competitive_intel: "strategic_context",
  };
  return mapping[signalType] || "relationship_insight";
}

function mapRelevanceToConfidence(relevance?: string): number {
  if (relevance === "high") return 0.9;
  if (relevance === "medium") return 0.7;
  return 0.5;
}

export function extractFactsFromAgentOutput(output: AgentOutput): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  if (output.signals) {
    for (const signal of output.signals) {
      if (signal.description && signal.description.length > 10) {
        facts.push({
          category: mapSignalToCategory(signal.type),
          text: signal.description,
          confidence: mapRelevanceToConfidence(signal.relevance),
        });
      }
    }
  }

  if (output.concerns) {
    for (const concern of output.concerns) {
      if (concern && concern.length > 10) {
        facts.push({
          category: "recurring_concern",
          text: concern,
          confidence: 0.75,
        });
      }
    }
  }

  if (output.wins) {
    for (const win of output.wins) {
      if (win && win.length > 10) {
        facts.push({
          category: "relationship_insight",
          text: win,
          confidence: 0.7,
        });
      }
    }
  }

  if (output.unresolvedAsks) {
    for (const ask of output.unresolvedAsks) {
      if (ask && ask.length > 10) {
        facts.push({
          category: "recurring_concern",
          text: `Unresolved: ${ask}`,
          confidence: 0.8,
        });
      }
    }
  }

  if (output.sentimentSummary && output.sentimentSummary.length > 10) {
    facts.push({
      category: "communication_pattern",
      text: output.sentimentSummary,
      confidence: 0.75,
    });
  }

  if (output.complaintThemes) {
    for (const theme of output.complaintThemes) {
      if (theme.severity >= 0.5) {
        facts.push({
          category: "recurring_concern",
          text: `${theme.category}: ${theme.evidence}`,
          confidence: Math.min(1.0, theme.severity),
        });
      }
    }
  }

  if (output.perPersonSentiment) {
    for (const person of output.perPersonSentiment) {
      if (person.frustration >= 0.6) {
        facts.push({
          category: "behavioral_pattern",
          text: `${person.name} shows elevated frustration (${(person.frustration * 100).toFixed(0)}%)`,
          confidence: person.frustration,
        });
      }
      if (person.trust <= 0.3) {
        facts.push({
          category: "relationship_insight",
          text: `${person.name} shows low trust level (${(person.trust * 100).toFixed(0)}%)`,
          confidence: 0.8,
        });
      }
    }
  }

  return facts;
}

export async function persistKnowledgeFacts(
  clientId: string,
  sourceAgent: KnowledgeSourceAgent,
  sourceRecordId: string | undefined,
  facts: ExtractedFact[],
): Promise<number> {
  if (facts.length === 0) return 0;

  const entries: InsertAgentKnowledgeBase[] = facts.map((fact) => ({
    clientId,
    factCategory: fact.category,
    factText: fact.text,
    confidence: fact.confidence,
    sourceAgent,
    sourceRecordId: sourceRecordId || null,
    usageCount: 1,
    isActive: true,
  }));

  const results = await storage.bulkUpsertAgentKnowledge(entries);
  return results.length;
}

/**
 * Task #4292 — mirror an operator concern-intel entry into the agent
 * knowledge base so the radar sweep and agent chat see what a human already
 * addressed. Source of record stays client_concern_intel (judgment inputs
 * read that table directly); this mirror is best-effort and the caller
 * treats failures as non-fatal.
 */
export async function mirrorOperatorIntelToKnowledge(
  clientId: string,
  intelId: string,
  intelType: "context" | "resolved",
  concernText: string,
  note: string,
): Promise<number> {
  const label = intelType === "resolved" ? "resolved" : "added context on";
  const fact: ExtractedFact = {
    category: "operator_intel",
    text: `Operator ${label} flagged concern "${concernText}": ${note}`,
    confidence: 0.95,
  };
  return runWithWorkerDb(() =>
    withDbAttribution("worker:agent-knowledge-persist", () =>
      persistKnowledgeFacts(clientId, "manual", intelId, [fact]),
    ),
  );
}

export async function extractAndPersistFromAgentOutput(
  clientId: string,
  sourceAgent: KnowledgeSourceAgent,
  sourceRecordId: string | undefined,
  output: AgentOutput,
): Promise<number> {
  let facts = extractFactsFromAgentOutput(output);
  // Task #4846 — fabricated-zero guard, daily_judgment only. Judgment
  // outputs asserting zero/absent intake/sales outcomes for metric families
  // the client has NEVER entered are recycled narrative, not observations:
  // persisting them re-forms the self-reinforcing memory loop this guard
  // exists to break (the KB upsert also RESURRECTS deactivated rows on
  // exact-text match, so the hygiene drain only converges if this gate
  // holds the line). Tracking is fetched lazily — only when some candidate
  // actually matches the claim vocabulary. A tracking-fetch failure
  // propagates: the caller already treats extraction as non-fatal, and
  // silently persisting unguarded facts would re-poison memory.
  if (sourceAgent === "daily_judgment" && facts.some((f) => matchFabricatedZeroClaim(f.text).matched)) {
    const tracking = await getClientMetricTracking(clientId);
    const { kept, suppressed } = filterFabricatedZeroFacts(facts, tracking);
    if (suppressed.length > 0) {
      console.log(
        `[AgentKnowledge] Suppressed ${suppressed.length} fabricated-zero metric fact(s) for client ${clientId} ` +
          `(tracking: consults=${tracking.consults}, cases=${tracking.cases})`,
      );
    }
    facts = kept;
  }
  // Task #1723 Phase 2.4: agent-memory writes go to the worker pool.
  return runWithWorkerDb(() =>
    withDbAttribution("worker:agent-knowledge-persist", () =>
      persistKnowledgeFacts(clientId, sourceAgent, sourceRecordId, facts),
    ),
  );
}

export function applyStaleDecay(confidence: number, lastSeenAt: Date | null): number {
  if (!lastSeenAt) return confidence;
  const daysSinceLastSeen = (Date.now() - lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSeen > STALE_SIGNAL_DAYS) {
    return Math.max(MIN_CONFIDENCE, confidence * STALE_DECAY_FACTOR);
  }
  return confidence;
}

export async function boostKnowledgeConfidence(entryId: string): Promise<void> {
  const entry = await storage.getAgentKnowledgeEntry(entryId);
  if (!entry) return;
  const newConfidence = Math.min(1.0, entry.confidence * BOOST_FACTOR);
  await storage.updateAgentKnowledgeEntry(entryId, {
    confidence: newConfidence,
    lastSeenAt: new Date(),
    usageCount: entry.usageCount + 1,
  });
}

export async function penalizeKnowledgeConfidence(entryId: string): Promise<void> {
  const entry = await storage.getAgentKnowledgeEntry(entryId);
  if (!entry) return;
  const newConfidence = Math.max(MIN_CONFIDENCE, entry.confidence * PENALTY_FACTOR);
  await storage.updateAgentKnowledgeEntry(entryId, {
    confidence: newConfidence,
  });
}


export async function propagateFeedbackToKnowledge(
  clientId: string,
  sourceAgent: string,
  sourceRecordId: string,
  feedbackType: "confirmed" | "corrected" | "dismissed",
): Promise<number> {
  // Task #1723 Phase 2.4: pin the read+update loop to the worker pool.
  return runWithWorkerDb(() =>
    withDbAttribution("worker:agent-knowledge-feedback", async () => {
      const allEntries = await storage.getAgentKnowledgeByClient(clientId, { isActive: true });
      const relatedEntries = allEntries.filter(
        (e) => e.sourceAgent === sourceAgent && e.sourceRecordId === sourceRecordId
      );

      let updated = 0;
      for (const entry of relatedEntries) {
        if (feedbackType === "confirmed") {
          await boostKnowledgeConfidence(entry.id);
          updated++;
        } else if (feedbackType === "corrected" || feedbackType === "dismissed") {
          await penalizeKnowledgeConfidence(entry.id);
          updated++;
        }
      }

      if (updated > 0) {
        console.log(`[AgentKnowledge] Propagated ${feedbackType} feedback to ${updated} KB entries from ${sourceAgent}/${sourceRecordId}`);
      }
      return updated;
    }),
  );
}

const CHAT_FACT_PATTERNS = [
  { pattern: /(?:client|they|he|she)\s+(?:hates?|doesn't like|dislikes?|prefers? not)\s+(.+)/i, category: "client_preference" as const },
  { pattern: /(?:client|they|he|she)\s+(?:prefers?|likes?|wants?|loves?)\s+(.+)/i, category: "client_preference" as const },
  { pattern: /(?:always|usually|typically|tends to)\s+(.+)/i, category: "behavioral_pattern" as const },
  { pattern: /(?:concerned about|worried about|frustrated with|upset about)\s+(.+)/i, category: "recurring_concern" as const },
  { pattern: /(?:strategy|strategic|plan|planning|goal|objective)\s+(?:is|to|for)\s+(.+)/i, category: "strategic_context" as const },
];

export async function extractChatKnowledge(
  clientId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<number> {
  const facts: ExtractedFact[] = [];

  for (const { pattern, category } of CHAT_FACT_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match && match[1] && match[1].length > 5) {
      facts.push({
        category,
        text: match[0].trim(),
        confidence: 0.85,
      });
    }
  }

  if (facts.length > 0) {
    return persistKnowledgeFacts(clientId, "agent_chat", undefined, facts);
  }
  return 0;
}
