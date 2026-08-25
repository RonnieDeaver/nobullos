import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";
import { workerDb as db } from "../db";
import { rawCommunicationRecords, aiSuggestions } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { getClientContext, formatContextForPrompt } from "./contextRetrieval";
import { extractAndPersistFromAgentOutput } from "./agentKnowledgeService";
import { composeEmailThreadTextFromSiblings } from "../storage/communicationStorage";

const openai = createDefaultOpenAiClient();

interface AnalysisResult {
  summary: string;
  signals: Array<{
    type: string;
    description: string;
    relevance: "high" | "medium" | "low";
  }>;
  suggestions: Array<{
    destinationType: "command_panel" | "intelligence_feed" | "action_log";
    suggestedTitle: string;
    suggestedBody: string;
    suggestedFieldChanges?: Record<string, any>;
    confidenceScore: number;
    priority: "urgent" | "normal" | "low";
    reasonForRecommendation: string;
    citationSnippets: string[];
  }>;
}

// Task #2986: email_thread rollup rows with neither contentText nor
// externalThreadId cannot be composed from sibling email_message rows — the
// AI would analyze effectively empty content. Emit a structured, greppable
// data-quality warn so operators can find these rows. Returns true when the
// warn fired (exported for tests).
export function warnIfUncomposableRollup(
  record: {
    sourceType: string | null;
    sourceSubtype: string | null;
    contentText: string | null;
    externalThreadId: string | null;
    clientId: string | null;
  },
  recordId: string,
): boolean {
  if (
    record.sourceType === "front_email" &&
    record.sourceSubtype === "email_thread" &&
    !record.contentText &&
    !record.externalThreadId
  ) {
    console.warn(
      `[CommAnalysis] data-quality: email_thread rollup has no contentText and no externalThreadId — analysis will run on metadata only recordId=${recordId} clientId=${record.clientId ?? "none"}`,
    );
    return true;
  }
  return false;
}

export async function analyzeCommunication(recordId: string): Promise<void> {
  const [record] = await db
    .update(rawCommunicationRecords)
    .set({ processingStatus: "processing" })
    .where(eq(rawCommunicationRecords.id, recordId))
    .returning();

  if (!record) throw new Error("Communication record not found");

  try {
    let knowledgeContextStr = "";
    if (record.clientId) {
      try {
        const context = await getClientContext(record.clientId, "communication_analysis");
        knowledgeContextStr = formatContextForPrompt(context);
      } catch (err: any) {
        console.error(`[CommAnalysis] Context retrieval failed for ${recordId}:`, err.message);
      }
    }

    // Task #2637: content/transcript fuzzy client matching removed. The
    // multi-client transcript scan no longer runs; left as an empty string so
    // the downstream prompt assembly still concatenates cleanly.
    const multiClientContext = "";

    const hasTranscript = record.sourceType === "zoom" && record.contentText && record.contentText.length > 100;
    const transcriptInstruction = hasTranscript
      ? `\n\nIMPORTANT: This is a Zoom meeting with a full transcript. Produce a DETAILED summary that includes: (1) overall meeting purpose, (2) for each client mentioned, what was discussed with timestamped references, decisions made, and action items. Be specific and thorough — this transcript has rich content.`
      : record.sourceType === "zoom" && (!record.contentText || record.contentText.length <= 100)
      ? `\n\nIMPORTANT: This is a Zoom meeting with NO TRANSCRIPT available. The summary should clearly state "No transcript available — metadata only" and only summarize what can be inferred from the meeting title and participants.`
      : "";

    // Task #2963: email_thread rollup rows have empty contentText (~76% of
    // front_email records). Compose the thread body from sibling email_message
    // rows before handing to the AI — the same fallback the detail route uses.
    // Read-only: the rollup row is NEVER mutated here.
    let composedThreadContent: string | null = null;
    warnIfUncomposableRollup(record, recordId);
    if (
      record.sourceType === "front_email" &&
      record.sourceSubtype === "email_thread" &&
      !record.contentText &&
      record.externalThreadId &&
      record.clientId
    ) {
      try {
        const siblings = await db
          .select({
            direction: rawCommunicationRecords.direction,
            participantsJson: rawCommunicationRecords.participantsJson,
            timestamp: rawCommunicationRecords.timestamp,
            contentText: rawCommunicationRecords.contentText,
          })
          .from(rawCommunicationRecords)
          .where(
            and(
              eq(rawCommunicationRecords.externalThreadId, record.externalThreadId),
              eq(rawCommunicationRecords.clientId, record.clientId),
              eq(rawCommunicationRecords.sourceType, "front_email"),
              eq(rawCommunicationRecords.sourceSubtype, "email_message"),
            ),
          )
          .orderBy(asc(rawCommunicationRecords.timestamp));
        composedThreadContent = composeEmailThreadTextFromSiblings(siblings);
      } catch (err: any) {
        console.warn(`[CommAnalysis] Thread composition failed for ${recordId}:`, err.message);
      }
    }

    const contentForAnalysis = buildAnalysisContent(record, composedThreadContent) +
      multiClientContext +
      transcriptInstruction +
      (knowledgeContextStr ? `\n\n${knowledgeContextStr}` : "");

    const response = await openai.chat.completions.create({
      model: QUALITY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an AI analyst for a legal marketing agency. You analyze client communications (from Slack, email, Zoom calls, or manual notes) to extract actionable intelligence.

Your job is to:
1. Summarize the communication concisely
2. Extract structured signals (budget changes, strategic shifts, risks, client sentiment, execution updates, etc.)
3. Determine if formal updates should be suggested to any of these three modules:
   - **Command Panel**: The single source of strategic truth for a client. Update when there are changes to budgets, goals, priority markets, products, strategic direction, or ownership.
   - **Intelligence Feed**: Insights, observations, risks, and opportunities. Create entries for strategic insights, client sentiment, competitive intelligence, or emerging trends.
   - **Action Log**: Records of specific tactical actions taken. Create entries when campaigns were launched/paused, budgets changed, processes updated, or other material actions occurred.

If the communication is routine or contains no actionable intelligence, return an empty suggestions array.

Respond in JSON with this exact structure:
{
  "summary": "concise summary of the communication",
  "signals": [
    { "type": "budget_mention|priority_shift|risk_signal|execution_update|client_preference|dissatisfaction|goal_change|product_change|competitive_intel|other", "description": "what was detected", "relevance": "high|medium|low" }
  ],
  "suggestions": [
    {
      "destinationType": "command_panel|intelligence_feed|action_log",
      "suggestedTitle": "title for the update",
      "suggestedBody": "detailed content for the update",
      "suggestedFieldChanges": { "fieldName": "newValue" },
      "confidenceScore": 0.0-1.0,
      "priority": "urgent|normal|low",
      "reasonForRecommendation": "why this update matters",
      "citationSnippets": ["exact quotes from the communication that support this suggestion"]
    }
  ]
}

For Command Panel suggestions, suggestedFieldChanges should reference known fields like: quarterPrimaryObjective, annualGoals, growthStrategy, currentBottleneck, budgetPosture, googleAdsBudget, webinarBudget, lsaBudget, priorityMarkets, activeCampaignFocus, activeOffers, keyActiveInitiatives, internalHandlingNotes.

For Intelligence Feed, use entryTypes: strategy_insight, risk, opportunity, client_sentiment, competitive_intel, meeting_takeaway, account_health_note.

For Action Log, use actionTypes: campaign_launched, campaign_paused, budget_increased, budget_decreased, geo_expansion, product_added, product_removed, intake_workflow_updated, creative_refresh, strategy_pivot, other.`
        },
        {
          role: "user",
          content: contentForAnalysis,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) throw new Error("Empty AI response");

    const analysis: AnalysisResult = JSON.parse(rawContent);

    if (analysis.suggestions.length > 0 && record.clientId) {
      const suggestionInserts = analysis.suggestions.map((s) => ({
        clientId: record.clientId!,
        rawCommunicationRecordId: record.id,
        destinationType: s.destinationType,
        suggestedTitle: s.suggestedTitle,
        suggestedBody: s.suggestedBody,
        suggestedFieldChangesJson: s.suggestedFieldChanges || null,
        confidenceScore: s.confidenceScore,
        priority: s.priority,
        reasonForRecommendation: s.reasonForRecommendation,
        citationSnippetsJson: s.citationSnippets,
        status: "pending" as const,
      }));

      // Task #818 Phase 3: collapse the per-suggestion insert loop into a
      // single batched INSERT so we do one DB checkout instead of N. The
      // OpenAI call above already serializes everyone behind one ingestion
      // worker; the loop here was a hidden fanout amplifier on the worker
      // pool whenever the model returned many suggestions for one record.
      await db.insert(aiSuggestions).values(suggestionInserts);
    }

    await db
      .update(rawCommunicationRecords)
      .set({
        processingStatus: "processed",
        aiSummary: analysis.summary,
        aiSignals: analysis.signals,
        aiProcessedAt: new Date(),
        hasSuggestions: analysis.suggestions.length > 0,
        reviewStatus: analysis.suggestions.length > 0 ? "suggestions_pending" : "no_updates_needed",
        updatedAt: new Date(),
      })
      .where(eq(rawCommunicationRecords.id, recordId));

    try {
      const { pipelineLog } = await import("./pipelineLogger");
      pipelineLog({
        event: "normalized",
        sourceSystem: record.sourceType || "unknown",
        sourceEventType: "communication_analyzed",
        sourceEventId: recordId,
        outcome: analysis.suggestions.length > 0 ? "suggestions_found" : "no_updates",
      });
    } catch (logErr) {
      console.warn("[CommAnalysis] Pipeline normalized log emission failed:", logErr);
    }

    if (record.clientId) {
      try {
        await extractAndPersistFromAgentOutput(record.clientId, "communication_analysis", recordId, {
          summary: analysis.summary,
          signals: analysis.signals,
        });
      } catch (err: any) {
        console.error(`[CommAnalysis] Knowledge extraction failed for ${recordId}:`, err.message);
      }
    }

    if (record.sourceType === "zoom") {
      const hasTranscriptContent = record.contentText && record.contentText.length > 100;
      if (!hasTranscriptContent) {
        const participants = Array.isArray(record.participantsJson)
          ? (record.participantsJson as any[]).map((p: any) => p.name || p.email).filter(Boolean).join(", ")
          : "";
        const deterministicSummary = `No transcript available — metadata only. Meeting: "${record.title || "Untitled"}".${participants ? ` Participants: ${participants}.` : ""}`;
        await db.update(rawCommunicationRecords)
          .set({ aiSummary: deterministicSummary })
          .where(eq(rawCommunicationRecords.id, recordId));
        analysis.summary = deterministicSummary;
      }

      if (analysis.summary) {
        try {
          const { communicationClientLinks } = await import("@shared/schema");
          const links = await db.select().from(communicationClientLinks)
            .where(eq(communicationClientLinks.rawCommunicationRecordId, recordId));
          if (links.length > 0) {
            const { clients } = await import("@shared/schema");
            const allClients = await db.select().from(clients);
            const clientMap = new Map(allClients.map((c: typeof allClients[number]) => [c.id, c]));

            for (const link of links) {
              const clientName = clientMap.get(link.clientId)?.firmName || "Unknown";
              let clientSummary: string | null = null;
              if (links.length === 1) {
                clientSummary = analysis.summary;
              } else if (hasTranscriptContent && record.contentText) {
                const clientNameLower = clientName.toLowerCase();
                const lines = record.contentText.split("\n");
                const mentionLines = lines.filter(l => l.toLowerCase().includes(clientNameLower)).slice(0, 5);
                if (mentionLines.length > 0) {
                  clientSummary = `[${clientName} mentions] ${mentionLines.map(l => l.trim().substring(0, 150)).join(" | ")}`;
                }
              }
              if (clientSummary) {
                await db.update(communicationClientLinks)
                  .set({ perClientSummary: clientSummary })
                  .where(eq(communicationClientLinks.id, link.id));
              }
            }
          }
        } catch (err: any) {
          console.error(`[CommAnalysis] Per-client summary update failed for ${recordId}:`, err.message);
        }
      }
    }

    // fire-and-forget: background enrichment; each step catches + logs inside.
    void (async () => {
      try {
        const { enrichCommunication } = await import("./communicationEnrichment");
        await enrichCommunication(recordId);
      } catch (err: any) {
        console.error(`[CommAnalysis] Background enrichment failed for ${recordId}:`, err.message);
      }
      if (record.clientId) {
        try {
          const { generateConversationSummary } = await import("./conversationSummaryService");
          await generateConversationSummary(record.clientId);
        } catch (err: any) {
          console.error(`[CommAnalysis] Background summary generation failed for ${record.clientId}:`, err.message);
        }
      }
    })();
  } catch (error: any) {
    console.error(`[CommAnalysis] Failed to analyze record ${recordId}:`, error.message);
    await db
      .update(rawCommunicationRecords)
      .set({ processingStatus: "failed", updatedAt: new Date() })
      .where(eq(rawCommunicationRecords.id, recordId));
    throw error;
  }
}

/**
 * Task #2963: exported for testability. Accepts an optional `composedContent`
 * that overrides `record.contentText` for email_thread rollup rows whose body
 * was composed from sibling email_message rows — the fallback the detail route
 * (Task #2926) and the AI analysis path both use via the shared
 * `composeEmailThreadTextFromSiblings` helper.
 */
export function buildAnalysisContent(record: any, composedContent?: string | null): string {
  const parts: string[] = [];
  parts.push(`Source: ${record.sourceType}${record.sourceSubtype ? ` (${record.sourceSubtype})` : ""}`);
  parts.push(`Title: ${record.title}`);
  parts.push(`Date: ${new Date(record.timestamp).toISOString()}`);
  if (record.direction) parts.push(`Direction: ${record.direction}`);

  if (record.participantsJson) {
    const participants = Array.isArray(record.participantsJson) ? record.participantsJson : [];
    if (participants.length > 0) {
      parts.push(`Participants: ${participants.map((p: any) => p.name || p.email || p).join(", ")}`);
    }
  }

  parts.push("");
  parts.push("--- Communication Content ---");
  parts.push(composedContent ?? record.contentText ?? record.contentPreview ?? "(no content available)");

  return parts.join("\n");
}
