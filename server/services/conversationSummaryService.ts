import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";
import { storage } from "../storage";

const openai = createDefaultOpenAiClient();

export interface ConversationSummaryJson {
  communicationPulse: {
    total14Days: number;
    total30Days: number;
    byChannel: Record<string, number>;
    lastContactDate: string | null;
    inboundCount: number;
    outboundCount: number;
    touchpointCount30Days: number;
    lastTouchpointDate: string | null;
  };
  keyTakeaways: Array<{
    text: string;
    category: "request" | "decision" | "concern" | "win";
    recency: "recent" | "older";
  }>;
  openThreads: Array<{
    text: string;
    urgency: "high" | "medium" | "low";
  }>;
  toneAndEngagement: string;
}

export async function generateConversationSummary(clientId: string): Promise<void> {
  const now = new Date();
  const windowEnd = now;
  const windowStart30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windowStart14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const comms30 = await storage.listRawCommunications(clientId, {
    dateFrom: windowStart30,
    dateTo: windowEnd,
  });

  if (comms30.length === 0) {
    await storage.upsertClientConversationSummary({
      clientId,
      summaryJson: { empty: true },
      generatedAt: now,
      windowStart: windowStart30,
      windowEnd,
      commCount: 0,
    });
    return;
  }

  const comms14Count = comms30.filter(c => new Date(c.timestamp) >= windowStart14).length;

  const byChannel: Record<string, number> = {};
  let inboundCount = 0;
  let outboundCount = 0;
  let lastContactDate: string | null = null;

  let touchpointCount30Days = 0;
  let lastTouchpointDate: string | null = null;

  for (const comm of comms30) {
    const src = comm.sourceType || "unknown";
    byChannel[src] = (byChannel[src] || 0) + 1;
    if (comm.direction === "inbound") inboundCount++;
    if (comm.direction === "outbound") outboundCount++;
    if (!lastContactDate || new Date(comm.timestamp) > new Date(lastContactDate)) {
      lastContactDate = comm.timestamp instanceof Date ? comm.timestamp.toISOString() : String(comm.timestamp);
    }
    if (comm.isTouchpoint) {
      touchpointCount30Days++;
      const commTs = comm.timestamp instanceof Date ? comm.timestamp.toISOString() : String(comm.timestamp);
      if (!lastTouchpointDate || new Date(commTs) > new Date(lastTouchpointDate)) {
        lastTouchpointDate = commTs;
      }
    }
  }

  const pulse: ConversationSummaryJson["communicationPulse"] = {
    total14Days: comms14Count,
    total30Days: comms30.length,
    byChannel,
    lastContactDate,
    inboundCount,
    outboundCount,
    touchpointCount30Days,
    lastTouchpointDate,
  };

  const commSummaries = comms30
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50)
    .map(c => {
      const dateStr = new Date(c.timestamp).toISOString().split("T")[0];
      const dir = c.direction ? ` [${c.direction}]` : "";
      const src = c.sourceType || "unknown";
      const tp = c.isTouchpoint ? " [TOUCHPOINT]" : "";
      const summary = c.aiSummary || c.contentPreview || c.title;
      return `[${dateStr}] (${src})${dir}${tp} ${c.title}\n  Summary: ${summary}`;
    })
    .join("\n\n");

  try {
    const response = await openai.chat.completions.create({
      model: QUALITY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You synthesize recent client communications into a structured summary for an account management team at a legal marketing agency.

You will receive a list of recent communications (most recent first) from the last 30 days. Items marked [TOUCHPOINT] represent real human-to-human interactions (answered phone calls, Zoom meetings with transcripts or multiple participants). All other items are general communications (emails, texts, Slack messages, voicemails, etc.).

Context stats: ${touchpointCount30Days} touchpoints out of ${comms30.length} total communications in the last 30 days. Last touchpoint: ${lastTouchpointDate ? new Date(lastTouchpointDate).toISOString().split("T")[0] : "none"}.

Produce a summary with these sections:

1. **Key Takeaways** — Bullets covering:
   - What the client is asking about or requesting
   - Decisions made or commitments given (by either side)
   - Concerns or frustrations expressed
   - Wins or positive signals
   Order bullets by recency/urgency. Only include older items if still relevant or unresolved.

2. **Open Threads** — Unresolved questions, pending requests, or items still needing follow-up. Rate urgency.

3. **Tone & Engagement** — One-line sentiment summary covering communication tone, responsiveness trends, and touchpoint quality. If there are many communications but few touchpoints, flag this as a concern (e.g., "High email volume but limited real conversations").

Respond in JSON:
{
  "keyTakeaways": [
    { "text": "bullet text", "category": "request|decision|concern|win", "recency": "recent|older" }
  ],
  "openThreads": [
    { "text": "thread description", "urgency": "high|medium|low" }
  ],
  "toneAndEngagement": "one-line summary"
}

Be concise and actionable. Lead with what matters most right now.`,
        },
        {
          role: "user",
          content: `Here are the last 30 days of communications for this client:\n\n${commSummaries}`,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) throw new Error("Empty AI response");

    const aiResult = JSON.parse(rawContent);

    const summaryJson: ConversationSummaryJson = {
      communicationPulse: pulse,
      keyTakeaways: aiResult.keyTakeaways || [],
      openThreads: aiResult.openThreads || [],
      toneAndEngagement: aiResult.toneAndEngagement || "",
    };

    await storage.upsertClientConversationSummary({
      clientId,
      summaryJson,
      generatedAt: now,
      windowStart: windowStart30,
      windowEnd,
      commCount: comms30.length,
    });

    console.log(`[ConvSummary] Generated summary for client ${clientId}: ${comms30.length} comms, ${summaryJson.keyTakeaways.length} takeaways`);
  } catch (error: any) {
    console.error(`[ConvSummary] Failed to generate summary for client ${clientId}:`, error.message);
    throw error;
  }
}
