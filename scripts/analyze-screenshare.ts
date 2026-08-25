import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { TwelvelabsApiClient } from "twelvelabs-js";
import { createDefaultOpenAiClient } from "../server/services/ai/openAiClient";
import { QUALITY_MODEL } from "../server/aiModels";
import {
  resolveAndValidateLocalPath,
  submitVideo,
  getJobStatus,
  getVideoTranscription,
  extractFrames,
  parseTimestampToSeconds,
} from "../server/services/videoAnalysis";

const ORIGINAL_VIDEO = "Screenshare_-_2026-04-01_5_11_14_PM_1775152861901.mp4";
const FIXED_VIDEO = "Screenshare_-_2026-04-01_fixed.mp4";
const OUTPUT_FILE = "screenshare-analysis-report.md";
const SCRIPT_USER_ID = "script-screenshare-analysis";
const SERVICE_INDEX_NAME = "replit-video-analysis";

const EXISTING_VIDEO_ID = process.env.RESUME_VIDEO_ID || "";

function formatTimestamp(seconds: number | undefined): string {
  if (seconds === undefined || seconds === null) return "??:??";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

async function ensureIndexExists(): Promise<void> {
  const apiKey = process.env.TWELVELABS_API_KEY;
  if (!apiKey) throw new Error("TWELVELABS_API_KEY environment variable is not set");

  const client = new TwelvelabsApiClient({ apiKey });

  const REQUIRED_MODELS = ["marengo3.0", "pegasus1.2"];

  for await (const index of await client.indexes.list({ indexName: SERVICE_INDEX_NAME })) {
    if (index.id) {
      const indexModels = index.models || [];
      const modelNames = indexModels.map((m) => m.modelName || "unknown");
      const hasAllRequired = REQUIRED_MODELS.every((req) =>
        modelNames.some((name) => name === req)
      );
      if (!hasAllRequired) {
        throw new Error(
          `Existing index "${SERVICE_INDEX_NAME}" (${index.id}) has incompatible models: [${modelNames.join(", ")}]. ` +
          `Required: [${REQUIRED_MODELS.join(", ")}]. ` +
          `Please delete the index manually via the TwelveLabs dashboard and re-run this script.`
        );
      }
      console.log(`  Index "${SERVICE_INDEX_NAME}" already exists: ${index.id} (models: ${modelNames.join(", ")})`);
      return;
    }
  }

  console.log(`  Creating index "${SERVICE_INDEX_NAME}" with marengo3.0 + pegasus1.2...`);
  const response = await client.indexes.create({
    indexName: SERVICE_INDEX_NAME,
    models: [
      { modelName: "marengo3.0", modelOptions: ["visual", "audio"] },
      { modelName: "pegasus1.2", modelOptions: ["visual", "audio"] },
    ],
  });

  if (!response.id) throw new Error("Failed to create index: no ID returned");
  console.log(`  Created index: ${response.id}`);
}

function fixVideoIfNeeded(): string {
  const fixedPath = path.resolve("attached_assets", FIXED_VIDEO);

  if (fs.existsSync(fixedPath)) {
    console.log("  Fixed video already exists, reusing.");
    return FIXED_VIDEO;
  }

  const originalPath = path.resolve("attached_assets", ORIGINAL_VIDEO);
  if (!fs.existsSync(originalPath)) {
    throw new Error(`Original video not found: ${originalPath}`);
  }

  console.log("  Re-encoding video to fix potential audio/video duration mismatch...");
  execSync(
    `ffmpeg -y -i "${originalPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest -movflags +faststart "${fixedPath}"`,
    { stdio: "pipe", timeout: 120000 }
  );

  console.log("  Video re-encoded successfully.");
  return FIXED_VIDEO;
}

async function waitForReady(taskId: string): Promise<void> {
  const pollInterval = 10000;
  const maxAttempts = 360;

  for (let i = 0; i < maxAttempts; i++) {
    const job = getJobStatus(taskId, SCRIPT_USER_ID);
    if (!job) throw new Error("Job disappeared from store");

    if (job.status === "ready") {
      console.log(`  Video indexed successfully. videoId: ${job.videoId}`);
      return;
    }
    if (job.status === "failed") {
      throw new Error(`Indexing failed: ${job.error}`);
    }
    if (job.status === "timeout") {
      throw new Error("Indexing timed out");
    }

    if (i % 6 === 0) {
      console.log(`    ... status: ${job.status} (${Math.round((i * pollInterval) / 1000)}s elapsed)`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error("Timed out waiting for indexing");
}

const CACHE_DIR = "/tmp/screenshare-cache";

function getCachePath(label: string): string {
  return path.join(CACHE_DIR, `${label.replace(/[^a-zA-Z0-9]/g, "_")}.txt`);
}

function loadFromCache(label: string): string | null {
  const cachePath = getCachePath(label);
  if (fs.existsSync(cachePath)) {
    const content = fs.readFileSync(cachePath, "utf-8");
    if (content.length > 50) {
      console.log(`  [Cache hit] ${label} (${content.length} chars)`);
      return content;
    }
  }
  return null;
}

function saveToCache(label: string, content: string): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(getCachePath(label), content, "utf-8");
}

async function runTranscriptAnalysis(transcriptText: string, label: string, prompt: string): Promise<string> {
  const cached = loadFromCache(label);
  if (cached) return cached;

  console.log(`[OpenAI] ${label}...`);
  const openai = createDefaultOpenAiClient();

  const systemPrompt = `You are a software analyst reviewing the transcript of a screenshare video recording. You MUST base your analysis ONLY on what appears in the provided transcript. Rules:
- ONLY cite things that actually appear in the transcript text provided
- When quoting, use the EXACT words from the transcript — do not paraphrase or fabricate quotes
- Include the timestamp from the transcript for every claim you make
- If you cannot find evidence in the transcript for a claim, do not include it
- Clearly distinguish between explicit statements and reasonable inferences (label inferences as "implied")`;

  const response = await openai.chat.completions.create({
    model: QUALITY_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here is the full transcript:\n\n${transcriptText}\n\n---\n\n${prompt}` },
    ],
    max_completion_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content || "";
  if (!content) {
    console.warn(`  Warning: No result for "${label}"`);
    return "_No analysis returned._";
  }
  console.log(`  Done (${content.length} chars)`);
  saveToCache(label, content);
  return content;
}

async function getIndexId(): Promise<string> {
  const apiKey = process.env.TWELVELABS_API_KEY;
  if (!apiKey) throw new Error("TWELVELABS_API_KEY environment variable is not set");
  const client = new TwelvelabsApiClient({ apiKey });
  for await (const index of await client.indexes.list({ indexName: SERVICE_INDEX_NAME })) {
    if (index.id) return index.id;
  }
  throw new Error(`Index "${SERVICE_INDEX_NAME}" not found`);
}

async function getTranscriptDirect(videoId: string, indexId: string): Promise<Array<{ start?: number; end?: number; value?: string }>> {
  const apiKey = process.env.TWELVELABS_API_KEY;
  if (!apiKey) throw new Error("TWELVELABS_API_KEY not set");
  const client = new TwelvelabsApiClient({ apiKey });
  const video = await client.indexes.videos.retrieve(indexId, videoId, { transcription: true });
  return Array.isArray(video.transcription) ? video.transcription : [];
}

async function main() {
  console.log("=== Screenshare Video Analysis Script ===\n");
  console.log(`Source video: ${ORIGINAL_VIDEO}\n`);

  let videoId = EXISTING_VIDEO_ID;
  let taskId = "";
  let videoPath = "";
  let indexId = "";

  if (videoId) {
    console.log(`[1/8] Resuming from existing videoId: ${videoId}`);
    indexId = await getIndexId();
    console.log(`  Index ID: ${indexId}`);

    console.log("[2/8] Skipping preprocessing (video already indexed)...");
    console.log("[3/8] Skipping submission (video already indexed)...");
    console.log("[4/8] Skipping wait (video already indexed)...");

    const fixedPath = path.resolve("attached_assets", FIXED_VIDEO);
    if (fs.existsSync(fixedPath)) {
      videoPath = fixedPath;
    } else {
      videoPath = path.resolve("attached_assets", ORIGINAL_VIDEO);
    }
    taskId = videoId;
  } else {
    console.log("[1/8] Ensuring TwelveLabs index exists with compatible models...");
    await ensureIndexExists();

    console.log("[2/8] Preprocessing video (fixing potential audio/video duration mismatch)...");
    const fixedAssetName = fixVideoIfNeeded();

    console.log("[3/8] Submitting video via service...");
    videoPath = resolveAndValidateLocalPath(undefined, fixedAssetName);
    console.log(`  Resolved path: ${videoPath}`);
    const job = await submitVideo(videoPath, SCRIPT_USER_ID);
    taskId = job.taskId;
    indexId = job.indexId;
    console.log(`  Task ID: ${taskId}`);

    console.log("[4/8] Waiting for indexing to complete...");
    await waitForReady(taskId);

    const readyJob = getJobStatus(taskId, SCRIPT_USER_ID);
    videoId = readyJob?.videoId || taskId;
  }

  console.log("[5/8] Extracting transcript...");
  let transcriptMd = "";
  const cachedTranscript = loadFromCache("transcript_md");
  if (cachedTranscript) {
    transcriptMd = cachedTranscript;
  } else {
    try {
      let transcript: Array<{ start?: number; end?: number; value?: string }> = [];

      if (EXISTING_VIDEO_ID) {
        transcript = await getTranscriptDirect(videoId, indexId);
      } else {
        const transcriptResult = await getVideoTranscription(taskId, SCRIPT_USER_ID);
        transcript = transcriptResult?.transcript || [];
      }

      if (transcript.length > 0) {
        transcriptMd = transcript
          .map((t) => `- **[${formatTimestamp(t.start)} – ${formatTimestamp(t.end)}]** ${t.value || ""}`)
          .join("\n");
        console.log(`  Got ${transcript.length} transcript segments`);
        saveToCache("transcript_md", transcriptMd);
      } else {
        transcriptMd = "_No transcript segments returned._";
        console.log("  No transcript segments returned");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      transcriptMd = `_Transcript extraction failed: ${msg}_`;
      console.warn(`  Transcript error: ${msg}`);
    }
  }

  const plainTranscript = transcriptMd
    .split("\n")
    .map((line) => {
      const match = line.match(/- \*\*\[(.*?)\]\*\* (.*)/);
      return match ? `[${match[1]}] ${match[2]}` : "";
    })
    .filter(Boolean)
    .join("\n");

  console.log("[6/8] Identifying visual scenes and extracting frames...");
  let sceneTimestamps: number[] = [];
  try {
    const apiKey = process.env.TWELVELABS_API_KEY;
    if (!apiKey) throw new Error("TWELVELABS_API_KEY not set");
    const tlClient = new TwelvelabsApiClient({ apiKey });
    if (videoId) {
      const scenesResp = await tlClient.analyze(
        {
          videoId: videoId,
          prompt: "Identify distinct visual scenes in this screenshare video. For each scene provide the timestamp in seconds and a brief description of what is shown on screen.",
          temperature: 0.1,
          maxTokens: 2000,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              type: "object",
              properties: {
                scenes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      timestamp: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        { timeoutInSeconds: 120 }
      );
      const rawScenes = scenesResp.data || "";
      const parsed = typeof rawScenes === "string" ? JSON.parse(rawScenes) : rawScenes;
      if (parsed && Array.isArray(parsed.scenes)) {
        for (const scene of parsed.scenes) {
          const sec = parseTimestampToSeconds(String(scene.timestamp || ""));
          if (sec !== null && sec >= 0) {
            sceneTimestamps.push(sec);
          }
        }
      }
      console.log(`  Found ${sceneTimestamps.length} visual scene timestamps`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Visual scene identification failed: ${msg}`);
    if (sceneTimestamps.length === 0 && videoPath) {
      console.log("  Falling back to evenly-spaced frame extraction...");
      try {
        const probe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`, { encoding: "utf-8" }).trim();
        const duration = parseFloat(probe);
        if (duration > 0) {
          const interval = Math.max(30, duration / 10);
          for (let t = 5; t < duration - 2; t += interval) {
            sceneTimestamps.push(Math.round(t));
          }
          console.log(`  Generated ${sceneTimestamps.length} evenly-spaced timestamps (every ${Math.round(interval)}s across ${Math.round(duration)}s)`);
        }
      } catch (probeErr: unknown) {
        const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
        console.warn(`  ffprobe failed: ${probeMsg}`);
      }
    }
  }

  let frameMap = new Map<number, string>();
  if (sceneTimestamps.length > 0) {
    try {
      frameMap = await extractFrames(videoPath, sceneTimestamps, taskId);
      console.log(`  Extracted ${frameMap.size} frames`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Frame extraction failed: ${msg}`);
    }
  }

  console.log("[7/8] Running all analysis via OpenAI (grounded in transcript)...");

  const visualScenes = await runTranscriptAnalysis(
    plainTranscript,
    "Visual Scene / Screen Breakdown",
    `Based on the transcript of a screenshare video, identify the distinct screens, pages, or sections that are navigated through. For each screen/section:
- The approximate timestamp range (from transcript timestamps)
- What screen/page/application is being discussed or shown
- What the speaker describes seeing or doing on that screen
- Any issues or observations mentioned about the UI/layout/functionality
- EXACT quotes from the transcript that describe the screen

Format each screen as a separate section with timestamp headers. Only include screens/sections that are clearly referenced in the transcript.`
  );

  const featureRequests = await runTranscriptAnalysis(
    plainTranscript,
    "Feature Requests",
    `Extract every explicit feature request or improvement suggestion mentioned in this transcript. For each one provide:
1. What was specifically asked for — use the EXACT quote from the transcript
2. The timestamp range from the transcript
3. The context: what were they discussing when they brought it up
4. How urgent/important it seems based on emphasis words

Also note any features they mention wanting that are implied but not directly stated as requests (e.g., complaining about a manual process implies they want automation). Clearly label these as "implied."

Format as a numbered list, ordered by timestamp. Every item MUST include a direct quote from the transcript above.`
  );

  const painPoints = await runTranscriptAnalysis(
    plainTranscript,
    "Pain Points",
    `Identify every pain point, frustration, or complaint expressed in this transcript. For each one:
1. Describe the specific pain point
2. Provide the exact timestamp range from the transcript
3. Include the EXACT quote from the transcript that demonstrates this pain point
4. Categorize it: UI/UX issue, missing feature, performance problem, data quality issue, workflow inefficiency, or integration gap
5. Rate severity based on speaker emphasis (high/medium/low)

Include both explicitly stated frustrations AND implied ones (e.g., workarounds described that indicate underlying problems). Clearly label implied items as "implied."

Every item MUST include a direct quote from the transcript. Do not include any pain point you cannot support with a specific quote.`
  );

  const workflowGaps = await runTranscriptAnalysis(
    plainTranscript,
    "Workflow Gaps",
    `Analyze the gap between what the speaker DESCRIBES they currently do versus what they SAY they wish they could do. For each workflow gap:
1. Current workflow: What steps does the speaker describe performing?
2. Desired workflow: What does the speaker say they want instead?
3. The gap: What's missing or broken that forces the workaround?
4. Impact: How does this gap affect productivity, data quality, or outcomes?
5. Exact timestamp range and direct quote from the transcript

Also identify any workflows where the speaker mentions using external tools or workarounds — these indicate capability gaps.

Every item MUST include a direct quote from the transcript. Do not include any workflow gap you cannot support with a specific quote.`
  );

  const recommendations = await runTranscriptAnalysis(
    plainTranscript,
    "Prioritized Recommendations",
    `Based ONLY on the transcript evidence above, provide a prioritized list of improvements. For each recommendation:

1. **Title**: A concise name for the improvement
2. **Priority**: P0 (critical/blocking), P1 (high-impact), P2 (medium), P3 (nice-to-have)
3. **Category**: UI/UX, New Feature, Workflow Automation, Data Management, Integration, Performance
4. **Description**: What should be built or changed
5. **Transcript evidence**: The EXACT quote(s) from the transcript and their timestamps that support this recommendation
6. **Expected impact**: How this would improve the workflow

Order by priority (P0 first), then by expected impact within each priority level. Aim for 8-15 recommendations total. Every recommendation MUST cite at least one exact transcript quote.`
  );

  console.log("[8/8] Cross-referencing analysis against transcript...");
  const fullTranscriptText = transcriptMd
    .replace(/- \*\*\[.*?\]\*\* /g, "")
    .toLowerCase();

  function countTranscriptMatches(analysisText: string): { total: number; matched: number } {
    const quotedPhrases = analysisText.match(/"([^"]{5,})"/g) || [];
    let matched = 0;
    const total = quotedPhrases.length;
    for (const phrase of quotedPhrases) {
      const clean = phrase.replace(/"/g, "").toLowerCase().trim();
      const words = clean.split(/\s+/).filter((w) => w.length > 3);
      const significantMatches = words.filter((w) => fullTranscriptText.includes(w));
      if (significantMatches.length >= Math.ceil(words.length * 0.4)) {
        matched++;
      }
    }
    return { total, matched };
  }

  const sections = [
    { name: "Feature Requests", text: featureRequests },
    { name: "Pain Points", text: painPoints },
    { name: "Workflow Gaps", text: workflowGaps },
    { name: "Recommendations", text: recommendations },
  ];

  let verificationSummary = "";
  for (const s of sections) {
    const { total, matched } = countTranscriptMatches(s.text);
    if (total > 0) {
      const pct = Math.round((matched / total) * 100);
      verificationSummary += `- **${s.name}**: ${matched}/${total} quoted phrases have partial transcript support (${pct}%)\n`;
      console.log(`  ${s.name}: ${matched}/${total} quoted phrases verified (${pct}%)`);
    } else {
      verificationSummary += `- **${s.name}**: No direct quotes to verify\n`;
      console.log(`  ${s.name}: No quoted phrases found`);
    }
  }

  console.log("\nCompiling report...");

  let frameImagesMd = "";
  if (frameMap.size > 0) {
    const sortedFrames = [...frameMap.entries()].sort((a, b) => a[0] - b[0]);
    frameImagesMd = sortedFrames
      .map(([ts, url]) => {
        const mins = Math.floor(ts / 60);
        const secs = Math.floor(ts % 60);
        const label = `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
        return `![Scene at ${label}](${url})`;
      })
      .join("\n\n");
  }

  const report = `# Screenshare Video Analysis Report

> **Source video**: \`${ORIGINAL_VIDEO}\`
> **Analyzed**: ${new Date().toISOString().split("T")[0]}
> **Transcript extraction**: TwelveLabs (marengo3.0 + pegasus1.2)
> **Analysis**: OpenAI GPT-4o (all sections grounded in transcript text)
> **Note**: The original video was preprocessed with ffmpeg to fix potential audio/video duration mismatch before submission to TwelveLabs.
> **Methodology**: TwelveLabs extracts the timestamped transcript from the video. All analysis sections (visual scenes, feature requests, pain points, workflow gaps, recommendations) are generated by GPT-4o using the raw transcript as input, with strict instructions to only cite exact quotes.

### Transcript Verification Summary

${verificationSummary}
> Verification uses a word-level overlap heuristic (≥40% of significant words found in transcript) to estimate grounding confidence. High scores indicate strong alignment but are not proof of exact quotation.

---

## Table of Contents

1. [Complete Transcript](#complete-transcript)
2. [Screenshot Stills](#screenshot-stills)
3. [Visual Scene Breakdown](#visual-scene-breakdown)
4. [Feature Requests](#feature-requests)
5. [Pain Points](#pain-points)
6. [Workflow Gaps](#workflow-gaps)
7. [Prioritized Recommendations](#prioritized-recommendations)

---

## Complete Transcript

${transcriptMd}

---

## Screenshot Stills

${frameImagesMd || "_No frames were extracted._"}

---

## Visual Scene Breakdown

${visualScenes}

---

## Feature Requests

${featureRequests}

---

## Pain Points

${painPoints}

---

## Workflow Gaps

${workflowGaps}

---

## Prioritized Recommendations

${recommendations}
`;

  fs.writeFileSync(OUTPUT_FILE, report, "utf-8");
  console.log(`\n[DONE] Report written to ${OUTPUT_FILE} (${report.length} chars)`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message || err);
  process.exit(1);
});
