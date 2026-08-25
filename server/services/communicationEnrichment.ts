import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";
import { workerDb as db } from "../db";
import { storage } from "../storage";
import { rawCommunicationRecords, clientCommunicationInsights, clientOpenAsks } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getClientContext, formatContextForPrompt } from "./contextRetrieval";
import { extractAndPersistFromAgentOutput } from "./agentKnowledgeService";
import { recordExtractedAsk } from "./openAskPipeline";

const openai = createDefaultOpenAiClient();

interface PersonSentiment {
  name: string;
  role: string;
  frustration: number;
  trust: number;
  urgency: number;
  gratitude: number;
  confusion: number;
  disappointment: number;
}

interface ComplaintTheme {
  category: string;
  severity: number;
  evidence: string;
}

interface ExtractedAsk {
  summary: string;
  detail: string;
  type: "client_ask" | "internal_promise";
  urgency: number;
  unresolvedLikelihood: number;
}

interface EnrichmentResult {
  perPersonSentiment: PersonSentiment[];
  overallSentiment: number;
  sentimentTrend: "improving" | "stable" | "declining";
  trustLevel: number;
  urgencyLevel: number;
  frustrationLevel: number;
  gratitudeLevel: number;
  confusionLevel: number;
  disappointmentLevel: number;
  complaintThemes: ComplaintTheme[];
  extractedAsks: ExtractedAsk[];
  extractedPromises: ExtractedAsk[];
}

export async function enrichCommunication(recordId: string): Promise<void> {
  const record = await storage.getRawCommunication(recordId);
  if (!record) {
    console.error(`[CommEnrichment] Record ${recordId} not found`);
    return;
  }

  const existing = await storage.getClientCommunicationInsightByCommId(recordId);
  if (existing) {
    console.log(`[CommEnrichment] Record ${recordId} already enriched, skipping`);
    return;
  }

  try {
    let knowledgeContextStr = "";
    if (record.clientId) {
      try {
        const context = await getClientContext(record.clientId, "communication_enrichment");
        knowledgeContextStr = formatContextForPrompt(context);
      } catch (err: any) {
        console.error(`[CommEnrichment] Context retrieval failed for ${recordId}:`, err.message);
      }
    }

    const contentForAnalysis = buildEnrichmentContent(record) +
      (knowledgeContextStr ? `\n\n${knowledgeContextStr}` : "");

    const response = await openai.chat.completions.create({
      model: QUALITY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an AI analyst for a legal marketing agency. You perform deep sentiment and relationship analysis on client communications (Slack, email, Zoom calls, manual notes).

Your job is to extract structured relationship intelligence:

1. **Per-person sentiment**: For each participant, rate their frustration, trust, urgency, gratitude, confusion, and disappointment levels (0.0-1.0 scale)
2. **Overall sentiment**: Single score from -1.0 (very negative) to 1.0 (very positive)
3. **Sentiment trend**: Whether the tone is "improving", "stable", or "declining" relative to what's discussed
4. **Aggregate signal levels**: Trust, urgency, frustration, gratitude, confusion, disappointment (0.0-1.0)
5. **Complaint themes**: Map complaints to categories with severity (0.0-1.0):
   - responsiveness, lead_volume, lead_quality, execution_speed, missed_follow_up, reporting_confusion, poor_communication, delays, trust_erosion, billing, other
6. **Extracted asks**: Explicit or inferred requests from the client. Include urgency and likelihood the ask is still unresolved (0.0-1.0)
7. **Extracted promises**: Commitments made by the internal team. Include urgency and likelihood the promise is still unresolved (0.0-1.0)

Respond in JSON with this exact structure:
{
  "perPersonSentiment": [
    { "name": "Person Name", "role": "client|internal|unknown", "frustration": 0.0, "trust": 0.0, "urgency": 0.0, "gratitude": 0.0, "confusion": 0.0, "disappointment": 0.0 }
  ],
  "overallSentiment": 0.0,
  "sentimentTrend": "improving|stable|declining",
  "trustLevel": 0.0,
  "urgencyLevel": 0.0,
  "frustrationLevel": 0.0,
  "gratitudeLevel": 0.0,
  "confusionLevel": 0.0,
  "disappointmentLevel": 0.0,
  "complaintThemes": [
    { "category": "responsiveness|lead_volume|lead_quality|execution_speed|missed_follow_up|reporting_confusion|poor_communication|delays|trust_erosion|billing|other", "severity": 0.0, "evidence": "brief quote or description" }
  ],
  "extractedAsks": [
    { "summary": "short description of request", "detail": "fuller context", "type": "client_ask", "urgency": 0.0, "unresolvedLikelihood": 0.0 }
  ],
  "extractedPromises": [
    { "summary": "short description of promise", "detail": "fuller context", "type": "internal_promise", "urgency": 0.0, "unresolvedLikelihood": 0.0 }
  ]
}

If the communication is routine with no notable sentiment signals, return neutral scores and empty arrays for complaints/asks/promises.`,
        },
        {
          role: "user",
          content: contentForAnalysis,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) {
      console.error(`[CommEnrichment] Empty AI response for record ${recordId}`);
      return;
    }

    const enrichment: EnrichmentResult = JSON.parse(rawContent);

    if (!record.clientId) {
      console.error(`[CommEnrichment] Record ${recordId} has no clientId, skipping insight creation`);
      return;
    }

    await storage.createClientCommunicationInsight({
      clientId: record.clientId,
      rawCommunicationRecordId: recordId,
      overallSentiment: enrichment.overallSentiment,
      sentimentTrend: enrichment.sentimentTrend,
      perPersonSentiment: enrichment.perPersonSentiment,
      trustLevel: enrichment.trustLevel,
      urgencyLevel: enrichment.urgencyLevel,
      frustrationLevel: enrichment.frustrationLevel,
      gratitudeLevel: enrichment.gratitudeLevel,
      confusionLevel: enrichment.confusionLevel,
      disappointmentLevel: enrichment.disappointmentLevel,
      complaintThemes: enrichment.complaintThemes,
      extractedAsks: enrichment.extractedAsks,
      extractedPromises: enrichment.extractedPromises,
      enrichmentModel: QUALITY_MODEL,
      enrichedAt: new Date(),
    });

    const allAsks = [
      ...enrichment.extractedAsks,
      ...enrichment.extractedPromises,
    ];

    if (allAsks.length > 0 && record.clientId) {
      await processAsksWithMemory(record.clientId, recordId, allAsks);
    }

    if (record.clientId) {
      try {
        await extractAndPersistFromAgentOutput(record.clientId, "communication_enrichment", recordId, {
          perPersonSentiment: enrichment.perPersonSentiment,
          complaintThemes: enrichment.complaintThemes,
        });
      } catch (err: any) {
        console.error(`[CommEnrichment] Knowledge extraction failed for ${recordId}:`, err.message);
      }
    }

    console.log(`[CommEnrichment] Enriched record ${recordId}: sentiment=${enrichment.overallSentiment}, asks=${enrichment.extractedAsks.length}, promises=${enrichment.extractedPromises.length}`);
  } catch (error: any) {
    console.error(`[CommEnrichment] Failed to enrich record ${recordId}:`, error.message);
  }
}

// Task #4765 — extraction now routes through the ONE shared ask-creation
// path (server/services/openAskPipeline.ts): semantic dedup across ALL ask
// types and all sweepable statuses, per-client advisory lock + partial
// unique index against burst races, defined merge semantics. The old local
// SELECT-then-INSERT + same-type-only matcher lived here.
async function processAsksWithMemory(
  clientId: string,
  sourceRecordId: string,
  newAsks: ExtractedAsk[]
): Promise<void> {
  for (const ask of newAsks) {
    if (!ask.summary || !ask.summary.trim()) continue;
    try {
      const result = await recordExtractedAsk(
        clientId,
        {
          summary: ask.summary,
          detail: ask.detail,
          type: ask.type,
          urgency: ask.urgency,
          unresolvedLikelihood: ask.unresolvedLikelihood,
        },
        { sourceRecordId },
      );
      console.log(`[CommEnrichment] ${result.outcome} ask ${result.ask.id} (mention #${result.ask.mentionCount})`);
    } catch (err: any) {
      console.error(`[CommEnrichment] Failed to record ask "${ask.summary.slice(0, 60)}":`, err?.message ?? err);
    }
  }
}

function buildEnrichmentContent(record: any): string {
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
  parts.push(record.contentText || record.contentPreview || "(no content available)");

  return parts.join("\n");
}
