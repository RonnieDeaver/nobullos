// @cross-instance-safe: work_queue poller — claims rows with FOR UPDATE SKIP LOCKED; parallel polling across instances is intended.
import { workerDb as db, dbRetry, withDbAttribution } from "../db";
import { callAnalysisJobs, type CallAnalysisResult, type CallClassification } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { getMaxProcessingMs } from "./queueMaxProcessing";
import { isKillSwitchEnabled } from "./killSwitches";
import { workerLog } from "./workerLogger";
import crypto from "crypto";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createDefaultOpenAiClient, DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS } from "./ai/openAiClient";
import { CHEAP_MODEL } from "../aiModels";
// @ts-ignore - no types available for fft-js
import fftModule from "fft-js";
const fft = {
  fft: fftModule.fft || fftModule.default?.fft,
  util: fftModule.util || fftModule.default?.util,
};

const openai = createDefaultOpenAiClient();

export async function transcribeAudio(wavPath: string, maxSeconds: number): Promise<{
  transcript: any;
  detectedLanguage: string;
  hasSyntheticTimestamps: boolean;
}> {
  try {
    const audioBuffer = await fs.promises.readFile(wavPath);
    const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });
    
    const response = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: audioFile,
      response_format: "json",
    }, { timeout: DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS });
    
    const text = response.text || "";
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    const transcript = {
      monologues: [{
        speaker: 0,
        elements: words.map((word, i) => ({
          type: "text",
          value: word,
          ts: i * 0.5,
          end_ts: (i + 1) * 0.5,
        }))
      }]
    };
    
    let detectedLanguage = "english";
    const spanishIndicators = /\b(hola|gracias|buenos|días|llamando|cómo|está|para|español|habla)\b/i;
    if (spanishIndicators.test(text)) {
      detectedLanguage = "spanish";
    }
    
    return { transcript, detectedLanguage, hasSyntheticTimestamps: true };
  } catch (error: any) {
    console.error("[CallAnalysis] Transcription error:", error.message);
    return {
      transcript: null,
      detectedLanguage: "unknown",
      hasSyntheticTimestamps: true
    };
  }
}

export async function transcribeForTimestamps(wavPath: string): Promise<{
  words: Array<{ word: string; start: number; end: number }>;
  firstSpeechTime: number | null;
  firstHumanGreetingTime: number | null;
  hasSyntheticTimestamps: boolean;
} | null> {
  try {
    const audioBuffer = await fs.promises.readFile(wavPath);
    const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

    let words: Array<{ word: string; start: number; end: number }> = [];
    let hasSyntheticTimestamps = false;

    const response = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: audioFile,
      response_format: "json",
    }, { timeout: DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS });

    const text = (response.text || "").trim();
    if (!text) return null;

    const responseWords: Array<{ word: string; start: number; end: number }> = (response as any).words || [];
    if (responseWords.length > 0) {
      words = responseWords;
    } else {
      console.log("[CallAnalysis] Timestamp transcription: model returned plain text only (no word-level timestamps). Degrading to synthetic timestamps.");
      hasSyntheticTimestamps = true;
      const splitWords = text.split(/\s+/).filter((w: string) => w.length > 0);
      words = splitWords.map((w: string, i: number) => ({
        word: w,
        start: i * 0.3,
        end: (i + 1) * 0.3,
      }));
    }

    if (words.length === 0) return null;

    const firstSpeechTime = words[0].start;

    let firstHumanGreetingTime: number | null = null;
    for (let i = 0; i < words.length; i++) {
      const windowWords = words.slice(i, Math.min(i + 8, words.length));
      const phrase = windowWords.map(w => w.word).join(" ");
      if (HUMAN_PATTERNS.some(p => p.test(phrase))) {
        firstHumanGreetingTime = words[i].start;
        break;
      }
    }

    return { words, firstSpeechTime, firstHumanGreetingTime, hasSyntheticTimestamps };
  } catch (error: any) {
    console.error("[CallAnalysis] Timestamp transcription error:", error.message);
    return null;
  }
}

export async function detectSpeechOnset(wavPath: string, maxScanSeconds: number = 30, startFromSeconds: number = 0): Promise<{
  firstSpeechTime: number | null;
  noiseFloorDb: number;
  speechThresholdDb: number;
}> {
  const { samples, sampleRate } = await readWavSamples(wavPath);
  const maxSamples = Math.min(samples.length, Math.floor(maxScanSeconds * sampleRate));
  
  const frameSize = Math.floor(sampleRate * 0.025);
  const hopSize = Math.floor(sampleRate * 0.010);
  
  const energies: number[] = [];
  for (let start = 0; start + frameSize <= maxSamples; start += hopSize) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i++) {
      sum += samples[i] * samples[i];
    }
    energies.push(sum / frameSize);
  }
  
  if (energies.length === 0) return { firstSpeechTime: null, noiseFloorDb: -100, speechThresholdDb: -100 };
  
  const sortedEnergies = [...energies].sort((a, b) => a - b);
  const noiseFloor = sortedEnergies[Math.floor(sortedEnergies.length * 0.1)] || 1e-10;
  const noiseFloorDb = 10 * Math.log10(Math.max(noiseFloor, 1e-10));
  
  const speechThreshold = noiseFloor * 100;
  const speechThresholdDb = 10 * Math.log10(Math.max(speechThreshold, 1e-10));
  
  const minSustainedFrames = Math.ceil(0.15 / (hopSize / sampleRate));
  const startFrame = Math.floor(startFromSeconds * sampleRate / hopSize);
  
  let consecutiveAbove = 0;
  for (let i = startFrame; i < energies.length; i++) {
    if (energies[i] >= speechThreshold) {
      consecutiveAbove++;
      if (consecutiveAbove >= minSustainedFrames) {
        const onsetFrame = i - minSustainedFrames + 1;
        const onsetTime = Math.round((onsetFrame * hopSize / sampleRate) * 10) / 10;
        console.log(`[CallAnalysis] VAD speech onset at ${onsetTime}s (noise floor ${noiseFloorDb.toFixed(1)}dB, threshold ${speechThresholdDb.toFixed(1)}dB, startFrom=${startFromSeconds}s)`);
        return { firstSpeechTime: onsetTime, noiseFloorDb, speechThresholdDb };
      }
    } else {
      consecutiveAbove = 0;
    }
  }
  
  return { firstSpeechTime: null, noiseFloorDb, speechThresholdDb };
}

export async function detectSpeechAfterSilence(wavPath: string, maxScanSeconds: number = 65): Promise<{
  speechOnsets: Array<{ time: number; gapBefore: number }>;
}> {
  const { samples, sampleRate } = await readWavSamples(wavPath);
  const maxSamples = Math.min(samples.length, Math.floor(maxScanSeconds * sampleRate));
  
  const frameSize = Math.floor(sampleRate * 0.025);
  const hopSize = Math.floor(sampleRate * 0.010);
  
  const energies: number[] = [];
  for (let start = 0; start + frameSize <= maxSamples; start += hopSize) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i++) {
      sum += samples[i] * samples[i];
    }
    energies.push(sum / frameSize);
  }
  
  if (energies.length === 0) return { speechOnsets: [] };
  
  const sortedEnergies = [...energies].sort((a, b) => a - b);
  const noiseFloor = sortedEnergies[Math.floor(sortedEnergies.length * 0.1)] || 1e-10;
  const speechThreshold = noiseFloor * 100;
  const minSustainedSpeech = Math.ceil(0.15 / (hopSize / sampleRate));
  const minSilenceFrames = Math.ceil(0.8 / (hopSize / sampleRate));
  
  const speechOnsets: Array<{ time: number; gapBefore: number }> = [];
  let inSpeech = false;
  let silenceStart = 0;
  let consecutiveSilence = 0;
  let consecutiveSpeech = 0;
  let lastSpeechEnd = 0;
  let hadAnySpeech = false;
  
  for (let i = 0; i < energies.length; i++) {
    const isSpeech = energies[i] >= speechThreshold;
    
    if (isSpeech) {
      consecutiveSpeech++;
      consecutiveSilence = 0;
      
      if (!inSpeech && consecutiveSpeech >= minSustainedSpeech) {
        inSpeech = true;
        const onsetFrame = i - minSustainedSpeech + 1;
        const onsetTime = Math.round((onsetFrame * hopSize / sampleRate) * 10) / 10;
        
        if (hadAnySpeech) {
          const gapDuration = Math.round((onsetFrame - lastSpeechEnd) * hopSize / sampleRate * 10) / 10;
          if (gapDuration >= 0.8) {
            speechOnsets.push({ time: onsetTime, gapBefore: gapDuration });
          }
        }
        hadAnySpeech = true;
      }
    } else {
      if (inSpeech) {
        lastSpeechEnd = i;
        inSpeech = false;
      }
      consecutiveSpeech = 0;
      consecutiveSilence++;
    }
  }
  
  return { speechOnsets };
}

export function computeIdempotencyKey(externalId: string, audioUrl: string | null): string {
  return crypto.createHash('sha256').update(`${externalId}:${audioUrl || 'transcript-only'}`).digest('hex');
}

export async function createOrGetJob(params: {
  externalId: string;
  audioUrl: string | null;
  revTranscriptJson: any;
  maxListenSeconds?: number;
}) {
  const idempotencyKey = computeIdempotencyKey(params.externalId, params.audioUrl);
  
  const existing = await dbRetry(() =>
    db.select().from(callAnalysisJobs)
      .where(eq(callAnalysisJobs.idempotencyKey, idempotencyKey))
      .limit(1),
    "callanalysis-check-existing"
  );
  
  if (existing.length > 0) {
    const job = existing[0];
    if (job.status === "failed") {
      const [updated] = await dbRetry(() =>
        db.update(callAnalysisJobs)
          .set({ 
            status: "queued", 
            errorMessage: null,
            resultJson: null,
            attemptCount: 0,
            revTranscriptJson: params.revTranscriptJson || job.revTranscriptJson,
          })
          .where(eq(callAnalysisJobs.analysisId, job.analysisId))
          .returning(),
        "callanalysis-retry-failed"
      );
      return updated;
    }
    return job;
  }
  
  const [newJob] = await dbRetry(() =>
    db.insert(callAnalysisJobs).values({
      externalId: params.externalId,
      idempotencyKey,
      audioUrl: params.audioUrl,
      revTranscriptJson: params.revTranscriptJson,
      maxListenSeconds: params.maxListenSeconds || 60,
      status: "queued",
    }).returning(),
    "callanalysis-create-job"
  );
  
  return newJob;
}

export async function getJob(analysisId: string) {
  const [job] = await dbRetry(() =>
    db.select().from(callAnalysisJobs)
      .where(eq(callAnalysisJobs.analysisId, analysisId))
      .limit(1),
    "callanalysis-get-job"
  );
  return job;
}

export async function getJobsByExternalId(externalId: string) {
  return dbRetry(() =>
    db.select().from(callAnalysisJobs)
      .where(eq(callAnalysisJobs.externalId, externalId))
      .orderBy(sql`${callAnalysisJobs.createdAt} DESC`),
    "callanalysis-get-by-external"
  );
}

export async function getAllJobs(limit = 100, offset = 0) {
  return db.select().from(callAnalysisJobs)
    .orderBy(sql`${callAnalysisJobs.createdAt} DESC`)
    .limit(limit)
    .offset(offset);
}

export async function fetchTranscriptFromUrl(url: string): Promise<any> {
  const downloadUrl = convertGoogleDriveUrl(url);
  
  const response = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CallAnalyzer/1.0)'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download transcript: ${response.status}`);
  }
  
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  
  // Google Drive may return HTML for access errors
  if (contentType.includes('text/html') && !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    if (text.includes('confirm=')) {
      // Large file requires confirmation
      const confirmMatch = text.match(/confirm=([^&"]+)/);
      if (confirmMatch) {
        const confirmUrl = `${downloadUrl}&confirm=${confirmMatch[1]}`;
        const confirmResponse = await fetch(confirmUrl, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; CallAnalyzer/1.0)'
          }
        });
        if (!confirmResponse.ok) {
          throw new Error(`Failed to download transcript after confirmation: ${confirmResponse.status}`);
        }
        const confirmText = await confirmResponse.text();
        return JSON.parse(confirmText);
      }
    }
    throw new Error('Google Drive returned HTML instead of JSON. Check sharing permissions - file must be publicly accessible.');
  }
  
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON in transcript file');
  }
}

function convertGoogleDriveUrl(url: string): string {
  // Convert Google Drive sharing links to direct download links
  // Formats:
  // - https://drive.google.com/file/d/FILE_ID/view -> https://drive.google.com/uc?export=download&id=FILE_ID
  // - https://drive.google.com/open?id=FILE_ID -> https://drive.google.com/uc?export=download&id=FILE_ID
  // - Already has export=download -> return as-is
  
  if (!url.includes('drive.google.com')) {
    return url;
  }
  
  // Already a direct download link
  if (url.includes('uc?') && url.includes('export=download')) {
    return url;
  }
  
  // Extract file ID from various formats
  let fileId: string | null = null;
  
  // Format: /file/d/FILE_ID/
  const fileMatch = url.match(/\/file\/d\/([^/]+)/);
  if (fileMatch) {
    fileId = fileMatch[1];
  }
  
  // Format: ?id=FILE_ID or &id=FILE_ID
  if (!fileId) {
    const idMatch = url.match(/[?&]id=([^&]+)/);
    if (idMatch) {
      fileId = idMatch[1];
    }
  }
  
  if (fileId) {
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  
  return url;
}

const DOWNLOAD_TIMEOUT_MS = 60000;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CallAnalyzer/1.0)'
      }
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAudioOnce(downloadUrl: string, tempFile: string): Promise<Buffer> {
  const response = await fetchWithTimeout(downloadUrl, DOWNLOAD_TIMEOUT_MS);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${downloadUrl.substring(0, 80)}`);
  }
  
  const contentType = response.headers.get('content-type') || '';
  
  if (contentType.includes('text/html')) {
    const text = await response.text();
    if (text.includes('confirm=')) {
      const confirmMatch = text.match(/confirm=([^&"]+)/);
      if (confirmMatch) {
        const confirmUrl = `${downloadUrl}&confirm=${confirmMatch[1]}`;
        const confirmResponse = await fetchWithTimeout(confirmUrl, DOWNLOAD_TIMEOUT_MS);
        if (!confirmResponse.ok) {
          throw new Error(`HTTP ${confirmResponse.status} after confirmation`);
        }
        return Buffer.from(await confirmResponse.arrayBuffer());
      }
    }
    throw new Error('Google Drive returned HTML instead of audio file. Check sharing permissions.');
  }
  
  return Buffer.from(await response.arrayBuffer());
}

const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;

// Task #1049: downloadAudio now returns file size alongside the path so
// processJob can persist preflight metadata (audioSizeBytes) before
// conversion. The path-only return shape is preserved via downloadAudio
// for backward compatibility with any external caller; processJob uses
// downloadAudioWithMeta directly.
export async function downloadAudioWithMeta(audioUrl: string): Promise<{ path: string; sizeBytes: number }> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `call_${Date.now()}.mp3`);

  const downloadUrl = convertGoogleDriveUrl(audioUrl);
  console.log(`[CallAnalysis] Downloading audio from ${downloadUrl.substring(0, 80)}...`);
  const dlStart = Date.now();

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const buffer = await downloadAudioOnce(downloadUrl, tempFile);
      await fs.promises.writeFile(tempFile, buffer);
      console.log(`[CallAnalysis] Audio downloaded in ${((Date.now() - dlStart) / 1000).toFixed(1)}s (${(buffer.length / 1024 / 1024).toFixed(1)} MB)${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return { path: tempFile, sizeBytes: buffer.length };
    } catch (e: any) {
      lastError = e;
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        const delay = DOWNLOAD_RETRY_DELAY_MS * attempt;
        console.log(`[CallAnalysis] Download attempt ${attempt} failed (${e.message}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Task #1049: tag download exhaustion with the typed `download_failed`
  // reason so the failure dashboard can group these separately from
  // ffmpeg / whisper failures.
  const err: any = new Error(`Failed to download audio after ${DOWNLOAD_MAX_RETRIES} attempts: ${lastError?.message}`);
  err.failureReason = 'download_failed';
  throw err;
}

export async function downloadAudio(audioUrl: string): Promise<string> {
  const { path } = await downloadAudioWithMeta(audioUrl);
  return path;
}

export function getAudioDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ffprobeBinary = 'ffprobe';
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const proc = spawn(ffprobeBinary, args);
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        const dur = parseFloat(output.trim());
        resolve(isNaN(dur) ? null : Math.round(dur * 10) / 10);
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

// Task #1049: bucketed ffmpeg timeouts based on the *output* duration we
// are extracting (maxSeconds), not the input file duration. The previous
// flat 90 s budget caused 849 ffmpeg_timeout failures because a long
// whisper conversion (up to 300 s of audio) competed with the same 90 s
// wall-clock budget under CPU pressure. These buckets give ffmpeg a
// realistic ratio of conversion-budget to audio-output-length:
//   ≤90 s output  → 90 s budget (1×)
//   ≤180 s output → 180 s budget (1×)
//   ≤300 s output → 300 s budget (1×)
//   >300 s output → 600 s budget (slow-lane only; normal lane never
//   converts files this long because they get rerouted upfront).
export function ffmpegTimeoutForOutputSeconds(maxSeconds?: number): number {
  if (!maxSeconds || maxSeconds <= 90) return 90_000;
  if (maxSeconds <= 180) return 180_000;
  if (maxSeconds <= 300) return 300_000;
  return 600_000;
}

export async function convertToWav(inputPath: string, maxSeconds?: number): Promise<string> {
  const suffix = maxSeconds ? `_${maxSeconds}s` : '';
  const outputPath = inputPath.replace(/\.[^.]+$/, `${suffix}.wav`);
  const timeoutMs = ffmpegTimeoutForOutputSeconds(maxSeconds);

  return new Promise((resolve, reject) => {
    // Task #4144: PATH-provided ffmpeg (Nix package, 6.1.1) — same
    // resolution as the ffprobe spawn above and every other media
    // consumer (videoAnalysis, atsTranscription, zoomFaceSentiment,
    // analyze scripts). The bundled-binary npm package is gone; a missing
    // PATH binary surfaces through the spawn 'error' handler below as a
    // classified ffmpeg_* failure — never a silent skip or a fallback.
    const ffmpegBinary = 'ffmpeg';
    const args = ['-y', '-i', inputPath];
    if (maxSeconds) {
      args.push('-t', String(maxSeconds));
    }
    args.push('-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', outputPath);

    const convertStart = Date.now();

    const ffmpeg = spawn(ffmpegBinary, args);

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      // Task #1049: typed error so processJob can classify into
      // `ffmpeg_timeout` instead of stuffing the wall-clock string into
      // the free-text errorMessage.
      const err: any = new Error(`ffmpeg conversion timed out after ${Math.round(timeoutMs / 1000)}s`);
      err.failureReason = 'ffmpeg_timeout';
      reject(err);
    }, timeoutMs);

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(outputPath);
      } else {
        const err: any = new Error(`ffmpeg exited with code ${code}`);
        err.failureReason = 'ffmpeg_invalid_audio';
        reject(err);
      }
    });

    ffmpeg.on('error', (err: any) => {
      clearTimeout(timeout);
      err.failureReason = err.failureReason || 'ffmpeg_invalid_audio';
      reject(err);
    });
  });
}

// STFT-based ringback detection constants
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 2048;
const HOP_SIZE = 512;
// US ringback: 440 Hz + 480 Hz dual-tone
const RING_TONE_A_CENTER = 440;
const RING_TONE_B_CENTER = 480;
const RING_TONE_HALF_WIDTH = 8; // ±8 Hz
// Adjacent bands for contrast calculation
const ADJACENT_LOW_CENTER = 400;
const ADJACENT_HIGH_CENTER = 520;
// Ringback detection parameters (per spec)
const MAX_SCAN_SECONDS = 60; // Only analyze first 60 seconds
const EARLY_WINDOW_SECONDS = 20; // Adaptive threshold from first 20 seconds
const MIN_SEGMENT_DURATION = 0.8; // Minimum ring segment duration to suppress false positives
const STABLE_OFF_REQUIRED = 1.5; // Sustained absence duration for pickup detection
const SMOOTHING_FRAMES = 5;
const THRESHOLD_FLOOR = 1.0; // Minimum threshold value
const MAD_MULTIPLIER = 4; // median + 4*MAD for threshold
const EPSILON = 1e-9; // Small value to prevent division by zero
// Cadence validation parameters (widened to accommodate real-world variation)
// After STFT smoothing/thresholding, a theoretical 2s ring can appear as 0.8-1.8s
const MIN_ON_DURATION = 0.8; // Ring ON must be 0.8-3.5 seconds
const MAX_ON_DURATION = 3.5;
const MIN_OFF_GAP = 1.5; // OFF gap must be 1.5-6.0 seconds
const MAX_OFF_GAP = 6.0;

function hannWindow(size: number): number[] {
  const window = new Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return window;
}

async function getWavDuration(wavPath: string): Promise<number> {
  const buffer = await fs.promises.readFile(wavPath);
  
  // Parse WAV header to get duration
  let offset = 12;
  let sampleRate = 16000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataSize = 0;
  
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    
    if (chunkId === 'fmt ') {
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }
    
    offset += 8 + chunkSize;
  }
  
  const bytesPerSample = (bitsPerSample / 8) * numChannels;
  const numSamples = dataSize / bytesPerSample;
  return numSamples / sampleRate;
}

async function readWavSamples(wavPath: string): Promise<{ samples: number[]; sampleRate: number }> {
  const buffer = await fs.promises.readFile(wavPath);
  
  // Parse WAV header
  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Invalid WAV file: missing RIFF header');
  }
  
  const format = buffer.toString('ascii', 8, 12);
  if (format !== 'WAVE') {
    throw new Error('Invalid WAV file: missing WAVE format');
  }
  
  // Find fmt chunk
  let offset = 12;
  let sampleRate = SAMPLE_RATE;
  let bitsPerSample = 16;
  let numChannels = 1;
  
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    
    if (chunkId === 'fmt ') {
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buffer.length);
      
      const samples: number[] = [];
      const bytesPerSample = bitsPerSample / 8;
      
      for (let i = dataStart; i < dataEnd; i += bytesPerSample * numChannels) {
        let sample: number;
        if (bitsPerSample === 16) {
          sample = buffer.readInt16LE(i) / 32768;
        } else if (bitsPerSample === 8) {
          sample = (buffer.readUInt8(i) - 128) / 128;
        } else {
          sample = buffer.readInt16LE(i) / 32768;
        }
        samples.push(sample);
      }
      
      return { samples, sampleRate };
    }
    
    offset += 8 + chunkSize;
  }
  
  throw new Error('Invalid WAV file: no data chunk found');
}

function computeSTFT(samples: number[], windowSize: number, hopSize: number): number[][] {
  const window = hannWindow(windowSize);
  const numFrames = Math.floor((samples.length - windowSize) / hopSize) + 1;
  const magnitudes: number[][] = [];
  
  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    const segment: number[] = new Array(windowSize);
    
    // Apply window
    for (let i = 0; i < windowSize; i++) {
      segment[i] = (samples[start + i] || 0) * window[i];
    }
    
    // Compute FFT
    const phasors = fft.fft(segment);
    const mags = fft.util.fftMag(phasors);
    magnitudes.push(mags);
  }
  
  return magnitudes;
}

function getMeanBandMagnitude(magnitudes: number[], sampleRate: number, centerFreq: number, halfWidth: number, windowSize: number): number {
  const binSize = sampleRate / windowSize;
  const lowBin = Math.floor((centerFreq - halfWidth) / binSize);
  const highBin = Math.ceil((centerFreq + halfWidth) / binSize);
  
  let sum = 0;
  let count = 0;
  for (let bin = lowBin; bin <= highBin && bin < magnitudes.length; bin++) {
    sum += magnitudes[bin];
    count++;
  }
  
  return count > 0 ? sum / count : 0;
}

function computeDualToneContrastScore(magnitudes: number[], sampleRate: number, windowSize: number): number {
  const E440 = getMeanBandMagnitude(magnitudes, sampleRate, RING_TONE_A_CENTER, RING_TONE_HALF_WIDTH, windowSize);
  const E480 = getMeanBandMagnitude(magnitudes, sampleRate, RING_TONE_B_CENTER, RING_TONE_HALF_WIDTH, windowSize);
  
  const E400 = getMeanBandMagnitude(magnitudes, sampleRate, ADJACENT_LOW_CENTER, RING_TONE_HALF_WIDTH, windowSize);
  const E520 = getMeanBandMagnitude(magnitudes, sampleRate, ADJACENT_HIGH_CENTER, RING_TONE_HALF_WIDTH, windowSize);
  
  const E_ring_min = Math.min(E440, E480);
  const E_near = (E400 + E520) / 2;
  
  return E_ring_min / (E_near + EPSILON);
}

const SPECTRAL_CONCENTRATION_MIN = 0.25;
const WIDEBAND_LOW_HZ = 100;
const WIDEBAND_HIGH_HZ = 4000;

function computeSpectralConcentration(magnitudes: number[], sampleRate: number, windowSize: number): number {
  const binSize = sampleRate / windowSize;
  const ring440Low = Math.floor((RING_TONE_A_CENTER - RING_TONE_HALF_WIDTH) / binSize);
  const ring440High = Math.ceil((RING_TONE_A_CENTER + RING_TONE_HALF_WIDTH) / binSize);
  const ring480Low = Math.floor((RING_TONE_B_CENTER - RING_TONE_HALF_WIDTH) / binSize);
  const ring480High = Math.ceil((RING_TONE_B_CENTER + RING_TONE_HALF_WIDTH) / binSize);
  const wideLow = Math.floor(WIDEBAND_LOW_HZ / binSize);
  const wideHigh = Math.min(Math.ceil(WIDEBAND_HIGH_HZ / binSize), magnitudes.length - 1);

  let ringEnergy = 0;
  let wideEnergy = 0;

  for (let bin = wideLow; bin <= wideHigh; bin++) {
    const e = magnitudes[bin] * magnitudes[bin];
    wideEnergy += e;
    if ((bin >= ring440Low && bin <= ring440High) || (bin >= ring480Low && bin <= ring480High)) {
      ringEnergy += e;
    }
  }

  return wideEnergy > 0 ? ringEnergy / wideEnergy : 0;
}

function smoothSignal(signal: number[], windowSize: number): number[] {
  const smoothed: number[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < signal.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(signal.length - 1, i + halfWindow); j++) {
      sum += signal[j];
      count++;
    }
    smoothed.push(sum / count);
  }
  
  return smoothed;
}

interface RingSegment {
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

interface RingbackResult {
  pickupTimeSeconds: number | null;
  evidence: string;
  scanLimitSeconds: number;
  threshold: number;
  numRingSegmentsAfterFilter: number;
  numCadenceValidPairs: number;
  stopReason: 'pickup_found' | 'no_cadence_valid_pair' | 'no_stable_off_found' | 'no_ringback_detected' | 'error';
}

function computeAdaptiveThreshold(scores: number[], earlyFrameCount: number): number {
  // Get early window scores
  const earlyScores = scores.slice(0, earlyFrameCount);
  if (earlyScores.length === 0) return THRESHOLD_FLOOR;
  
  // Compute median
  const sorted = [...earlyScores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  
  // Compute MAD (median absolute deviation)
  const deviations = earlyScores.map(s => Math.abs(s - median));
  const sortedDeviations = [...deviations].sort((a, b) => a - b);
  const mad = sortedDeviations[Math.floor(sortedDeviations.length / 2)];
  
  // Threshold = median + 4*MAD, with floor of 1.0
  const threshold = median + MAD_MULTIPLIER * mad;
  return Math.max(threshold, THRESHOLD_FLOOR);
}

function isCadenceValidPair(seg1: RingSegment, seg2: RingSegment): boolean {
  // Check ON durations are in valid range (1.5-3.0 seconds)
  const on1Valid = seg1.durationSeconds >= MIN_ON_DURATION && seg1.durationSeconds <= MAX_ON_DURATION;
  const on2Valid = seg2.durationSeconds >= MIN_ON_DURATION && seg2.durationSeconds <= MAX_ON_DURATION;
  
  // Check OFF gap between them (2.0-5.0 seconds)
  const offGap = seg2.startSeconds - seg1.endSeconds;
  const offValid = offGap >= MIN_OFF_GAP && offGap <= MAX_OFF_GAP;
  
  return on1Valid && on2Valid && offValid;
}

export async function detectRingbackPickup(wavPath: string, maxScanSecondsOverride?: number): Promise<RingbackResult> {
  try {
    const effectiveMaxScan = maxScanSecondsOverride || MAX_SCAN_SECONDS;
    
    // Step 1: Read WAV file and restrict search window
    const { samples, sampleRate } = await readWavSamples(wavPath);
    const fileDurationSeconds = samples.length / sampleRate;
    const scanLimitSeconds = Math.min(effectiveMaxScan, fileDurationSeconds);
    const scanSamples = Math.floor(scanLimitSeconds * sampleRate);
    const trimmedSamples = samples.slice(0, scanSamples);
    
    
    // Step 2: Normalize amplitude (peak = 1.0)
    // Use loop instead of spread operator to avoid stack overflow on large arrays
    let maxAmp = 0;
    for (let i = 0; i < trimmedSamples.length; i++) {
      const absVal = Math.abs(trimmedSamples[i]);
      if (absVal > maxAmp) maxAmp = absVal;
    }
    const normalizedSamples = maxAmp > 0 ? trimmedSamples.map(s => s / maxAmp) : trimmedSamples;
    
    // Step 3: Compute STFT
    const magnitudes = computeSTFT(normalizedSamples, WINDOW_SIZE, HOP_SIZE);
    const frameTimeSeconds = HOP_SIZE / sampleRate;
    
    // Step 4: Compute dual-tone contrast score AND spectral concentration per frame
    const contrastScores: number[] = [];
    const concentrationScores: number[] = [];
    for (const mags of magnitudes) {
      contrastScores.push(computeDualToneContrastScore(mags, sampleRate, WINDOW_SIZE));
      concentrationScores.push(computeSpectralConcentration(mags, sampleRate, WINDOW_SIZE));
    }
    
    // Step 5: Smooth the contrast score
    const smoothedScores = smoothSignal(contrastScores, SMOOTHING_FRAMES);
    
    // Step 6: Adaptive threshold from first 20 seconds
    const earlyWindowSeconds = Math.min(EARLY_WINDOW_SECONDS, scanLimitSeconds);
    const earlyFrameCount = Math.floor(earlyWindowSeconds / frameTimeSeconds);
    const threshold = computeAdaptiveThreshold(smoothedScores, earlyFrameCount);
    
    // Step 7: Build ring_present boolean and find candidate segments >= 0.8 seconds
    const minSegmentFrames = Math.floor(MIN_SEGMENT_DURATION / frameTimeSeconds);
    const candidateSegments: RingSegment[] = [];
    let ringStart = -1;
    
    for (let i = 0; i < smoothedScores.length; i++) {
      const isRinging = smoothedScores[i] >= threshold;
      
      if (isRinging) {
        if (ringStart === -1) ringStart = i;
      } else {
        if (ringStart !== -1) {
          const durationFrames = i - ringStart;
          if (durationFrames >= minSegmentFrames) {
            const startSeconds = ringStart * frameTimeSeconds;
            const endSeconds = i * frameTimeSeconds;
            candidateSegments.push({
              startFrame: ringStart,
              endFrame: i,
              startSeconds,
              endSeconds,
              durationSeconds: endSeconds - startSeconds
            });
          }
          ringStart = -1;
        }
      }
    }
    
    // Handle segment at end of window
    if (ringStart !== -1) {
      const durationFrames = smoothedScores.length - ringStart;
      if (durationFrames >= minSegmentFrames) {
        const startSeconds = ringStart * frameTimeSeconds;
        const endSeconds = smoothedScores.length * frameTimeSeconds;
        candidateSegments.push({
          startFrame: ringStart,
          endFrame: smoothedScores.length,
          startSeconds,
          endSeconds,
          durationSeconds: endSeconds - startSeconds
        });
      }
    }
    
    // Step 7b: Filter candidates by spectral concentration
    // Real ringback concentrates energy in 440+480 Hz bands. Speech harmonics
    // spread energy across the spectrum, producing low concentration.
    const ringSegments: RingSegment[] = [];
    for (const seg of candidateSegments) {
      let concSum = 0;
      let concCount = 0;
      for (let f = seg.startFrame; f < seg.endFrame && f < concentrationScores.length; f++) {
        concSum += concentrationScores[f];
        concCount++;
      }
      const avgConc = concCount > 0 ? concSum / concCount : 0;
      
      if (avgConc >= SPECTRAL_CONCENTRATION_MIN) {
        ringSegments.push(seg);
      } else {
      }
    }
    
    
    // If no ring segments, immediate answer
    if (ringSegments.length === 0) {
      return {
        pickupTimeSeconds: 0,
        evidence: "No ringback detected - immediate answer",
        scanLimitSeconds,
        threshold,
        numRingSegmentsAfterFilter: 0,
        numCadenceValidPairs: 0,
        stopReason: 'no_ringback_detected'
      };
    }
    
    // Step 7c: Build continuous chain starting from the earliest segment.
    // Real ring segments form a continuous sequence at the start of the call.
    // Once a gap exceeds MAX_OFF_GAP, later segments are speech artifacts.
    const ringChain: RingSegment[] = [ringSegments[0]];
    for (let i = 1; i < ringSegments.length; i++) {
      const gap = ringSegments[i].startSeconds - ringSegments[i - 1].endSeconds;
      if (gap <= MAX_OFF_GAP) {
        ringChain.push(ringSegments[i]);
      } else {
        break;
      }
    }
    
    if (ringChain.length < ringSegments.length) {
    }
    
    // Step 8: Cadence validation - find valid pairs (using chain only)
    // Log each segment and gap for debugging
    for (let i = 0; i < ringChain.length; i++) {
      const seg = ringChain[i];
      const gapToNext = i < ringChain.length - 1 
        ? (ringChain[i + 1].startSeconds - seg.endSeconds).toFixed(2)
        : 'N/A';
    }
    
    const cadenceValidPairs: Array<{seg1: RingSegment; seg2: RingSegment}> = [];
    for (let i = 0; i < ringChain.length - 1; i++) {
      const seg1 = ringChain[i];
      const seg2 = ringChain[i + 1];
      const valid = isCadenceValidPair(seg1, seg2);
      if (valid) {
        cadenceValidPairs.push({ seg1, seg2 });
      }
      const offGap = seg2.startSeconds - seg1.endSeconds;
    }
    
    
    // Must have at least one cadence-valid pair
    if (cadenceValidPairs.length === 0) {
      const segDetails = ringSegments.map((s, i) => {
        const gap = i < ringSegments.length - 1 
          ? (ringSegments[i + 1].startSeconds - s.endSeconds).toFixed(1)
          : '-';
        return `[${s.startSeconds.toFixed(1)}-${s.endSeconds.toFixed(1)}s ON=${s.durationSeconds.toFixed(2)}s gap=${gap}]`;
      }).join(' ');
      return {
        pickupTimeSeconds: null,
        evidence: `No cadence-valid pairs (${ringSegments.length} segs, need ON=${MIN_ON_DURATION}-${MAX_ON_DURATION}s OFF=${MIN_OFF_GAP}-${MAX_OFF_GAP}s): ${segDetails}`,
        scanLimitSeconds,
        threshold,
        numRingSegmentsAfterFilter: ringSegments.length,
        numCadenceValidPairs: 0,
        stopReason: 'no_cadence_valid_pair'
      };
    }
    
    // Step 9: Find first stable no-ring after the LAST ring segment in the chain
    const stableOffFrames = Math.floor(STABLE_OFF_REQUIRED / frameTimeSeconds);
    const lastRingSegment = ringChain[ringChain.length - 1];
    const searchStartFrame = lastRingSegment.endFrame;
    
    let consecutiveOffFrames = 0;
    let pickupFrame: number | null = null;
    
    for (let i = searchStartFrame; i < smoothedScores.length; i++) {
      if (smoothedScores[i] < threshold) {
        consecutiveOffFrames++;
        if (consecutiveOffFrames >= stableOffFrames) {
          pickupFrame = i - stableOffFrames + 1;
          break;
        }
      } else {
        consecutiveOffFrames = 0;
      }
    }
    
    if (pickupFrame !== null) {
      const confirmedAtSeconds = pickupFrame * frameTimeSeconds;
      const pickupTimeSeconds = lastRingSegment.endSeconds;
      return {
        pickupTimeSeconds: Math.round(pickupTimeSeconds * 10) / 10,
        evidence: `Cadence-validated ringback: pickup at ${pickupTimeSeconds.toFixed(1)}s (last ring end), confirmed by ${STABLE_OFF_REQUIRED}s silence at ${confirmedAtSeconds.toFixed(1)}s, ${cadenceValidPairs.length} valid pairs, ${ringChain.length}/${ringSegments.length} segments in chain`,
        scanLimitSeconds,
        threshold,
        numRingSegmentsAfterFilter: ringChain.length,
        numCadenceValidPairs: cadenceValidPairs.length,
        stopReason: 'pickup_found'
      };
    }
    
    // No stable off found
    return {
      pickupTimeSeconds: null,
      evidence: `Cadence-valid ringing detected but no stable ${STABLE_OFF_REQUIRED}s silence found within scan window`,
      scanLimitSeconds,
      threshold,
      numRingSegmentsAfterFilter: ringSegments.length,
      numCadenceValidPairs: cadenceValidPairs.length,
      stopReason: 'no_stable_off_found'
    };
    
  } catch (error: any) {
    console.error("[CallAnalysis] Ringback detection error:", error.message);
    return {
      pickupTimeSeconds: null,
      evidence: `Ringback detection failed: ${error.message}`,
      scanLimitSeconds: 0,
      threshold: 0,
      numRingSegmentsAfterFilter: 0,
      numCadenceValidPairs: 0,
      stopReason: 'error'
    };
  }
}

const SPAM_PATTERNS = [
  /business listing verification/i,
  /your vehicle('s)?\s*(extended\s*)?warranty/i,
  /regarding your account/i,
  /your listing has been/i,
  /verification department/i,
  /eligible for\s*(a\s*)?(free|special|exclusive)/i,
  /final notice/i,
  /act now/i,
  /limited time offer/i,
  /google\s*business\s*(listing|profile)\s*(has been|needs|requires)/i,
  /your\s*(business\s*)?(listing|profile)\s*(is|has|needs|requires)/i,
  /call.*back.*immediately/i,
  /urgent\s*(message|notice|matter|business)/i,
];

const RECORDING_DISCLAIMER_PATTERNS = [
  /your call (may|will) be (recorded|monitored)/i,
  /this call (is|may be) (recorded|monitored)/i,
  /for (quality|security)\s*(assurance|purposes|and training)/i,
  /calls?\s*(are|may be)\s*(recorded|monitored)/i,
  /for\s+security\s+and\s+training\s+purposes/i,
];

const AUTO_ATTENDANT_PATTERNS = [
  /please hold for the next/i,
  /hold for the next available/i,
  /your call will be answered/i,
  /all\s*(of our\s*)?(representatives|agents|operators|staff)\s*(are\s*)?(currently|busy|assisting|unavailable)/i,
  /please stay on the line/i,
  /your call is important/i,
  /currently assisting other/i,
  /in the order.*received/i,
  /estimated wait time/i,
  /please hold\b.*\b(we|and|while|your)/i,
];

const IVR_STRONG_PATTERNS = [
  /press\s*(?:\d|one|two|three|four|five|six|seven|eight|nine|zero|pound|star|hash|#|\*)/i,
  /main\s*menu/i,
  /options have changed/i,
  /listen carefully/i,
  /if you know your party/i,
  /press or say/i,
  /select from/i,
  /to repeat\s*(this\s*)?menu/i,
  /for\s+(?:sales|billing|intake|new\s+clients?|existing\s+clients?)\s*(?:,?\s*)?press/i,
];

const IVR_WEAK_PATTERNS = [
  /for sales/i, /for support/i, /to speak with/i,
  /to repeat/i, /please hold/i, /dial\s*(?:\d|the|an|your)/i,
  /extension/i, /for billing/i,
  /para español/i, /en español/i,
  /transferring/i,
];

const VOICEMAIL_PATTERNS = [
  /please leave a message/i, /after the tone/i, /voicemail/i,
  /mailbox/i, /leave your name/i, /leave a message/i,
  /at the beep/i, /record your message/i,
  /(?:the\s+)?(?:person|party|number)\s+(?:you\s+)?(?:are\s+)?(?:calling|called|dialed)?\s*(?:is\s+)?(?:not available|unavailable)/i,
  /(?:is\s+)?(?:not available|unavailable).*(?:leave|message|beep|tone|after)/i,
];

const VOICEMAIL_ACTION_CUES = [
  /leave\s*(a\s+)?message/i,
  /leave\s+your\s+name/i,
  /after the (tone|beep)/i,
  /at the beep/i,
  /mailbox/i,
  /voicemail/i,
  /record your message/i,
];

const HUMAN_PATTERNS = [
  /thank you for calling/i, /how can i help/i, /how can we help/i,
  /how may i help/i, /how may we help/i,
  /this is/i, /hello/i, /^hi$/i, /what is your/i, /may i help/i,
  /good morning/i, /good afternoon/i, /law office/i, /law firm/i,
  /speaking/i, /can i help/i, /can we help/i,
  /are you a client/i, /what can i do for you/i,
  /the firm/i, /receptionist/i, /i'm going to/i, /i'll transfer/i,
  /one moment/i, /hold on/i, /please hold/i, /let me transfer/i,
  /take your information/i, /your phone number/i, /your contact/i,
  /client of/i, /already a client/i, /become a client/i,
  /schedule.*appointment/i, /schedule.*consult/i, /set up a/i,
  /attorney/i, /lawyer/i, /paralegal/i,
];

const HUMAN_CONVERSATIONAL_MARKERS = [
  /how can i help/i, /how can we help/i,
  /how may i help/i, /how may we help/i,
  /may i help/i, /can i help/i, /can we help/i,
  /what can i do for you/i,
  /are you a client/i, /who is calling/i, /may i ask/i,
  /what is your/i, /take your information/i,
  /your phone number/i, /your contact/i,
  /schedule.*appointment/i, /schedule.*consult/i,
  /already a client/i, /become a client/i,
];

// Patterns for speaker scoring
const RECIPIENT_POSITIVE_PATTERNS = [
  /thank you for calling/i, /how can i help/i, /how can we help/i,
  /good morning/i, /good afternoon/i, /law office/i, /law firm/i
];

const RECIPIENT_NEGATIVE_PATTERNS = [
  /press\s*(?:\d|one|two|three|four|five|six|seven|eight|nine|zero|pound|star|hash|#|\*)/i,
  /main\s*menu/i, /for sales/i, /leave a message/i
];

function getFirstSpeechTimeAfter(transcript: any, afterSeconds: number): number | null {
  let earliest = Infinity;
  for (const monologue of transcript.monologues || []) {
    for (const element of monologue.elements || []) {
      if (element.type === "punct") continue;
      const ts = element.ts;
      if (typeof ts === 'number' && ts > afterSeconds && ts < earliest) {
        earliest = ts;
      }
    }
  }
  return earliest === Infinity ? null : earliest;
}

function countSpeakerWordsInRange(
  transcript: any, speaker: string | null, fromSeconds: number, toSeconds: number
): number {
  let count = 0;
  for (const monologue of transcript.monologues || []) {
    const spk = monologue.speaker?.toString() || null;
    if (speaker !== null && spk !== speaker) continue;
    for (const element of monologue.elements || []) {
      if (element.type === "punct") continue;
      const ts = element.ts;
      if (typeof ts === 'number' && ts >= fromSeconds && ts < toSeconds) {
        count++;
      }
    }
  }
  return count;
}

function getFirstSpeakerSpeechBefore(
  transcript: any, speaker: string | null, beforeSeconds: number
): number | null {
  let earliest = Infinity;
  for (const monologue of transcript.monologues || []) {
    const spk = monologue.speaker?.toString() || null;
    if (speaker !== null && spk !== speaker) continue;
    for (const element of monologue.elements || []) {
      if (element.type === "punct") continue;
      const ts = element.ts;
      if (typeof ts === 'number' && ts < beforeSeconds && ts < earliest) {
        earliest = ts;
      }
    }
  }
  return earliest === Infinity ? null : earliest;
}

function identifyRecipientSpeaker(transcript: any, pickupTime: number): string | null {
  const speakerScores: Record<string, number> = {};
  const scoringWindow = pickupTime + 15;
  let firstSpeakerAfterPickup: string | null = null;
  let firstSpeakerTime = Infinity;
  
  for (const monologue of transcript.monologues || []) {
    const speaker = monologue.speaker?.toString() || "unknown";
    if (!speakerScores[speaker]) speakerScores[speaker] = 0;
    
    for (const element of monologue.elements || []) {
      const ts = element.ts || 0;
      const text = element.value || "";
      if (element.type === "punct") continue;
      
      if (ts < pickupTime || ts > scoringWindow) continue;
      
      if (ts < firstSpeakerTime) {
        firstSpeakerTime = ts;
        firstSpeakerAfterPickup = speaker;
      }
      
      for (const pattern of RECIPIENT_POSITIVE_PATTERNS) {
        if (pattern.test(text)) speakerScores[speaker] += 5;
      }
      
      for (const pattern of RECIPIENT_NEGATIVE_PATTERNS) {
        if (pattern.test(text)) speakerScores[speaker] -= 3;
      }
    }
  }
  
  if (firstSpeakerAfterPickup) {
    speakerScores[firstSpeakerAfterPickup] = (speakerScores[firstSpeakerAfterPickup] || 0) + 10;
  }
  
  let bestSpeaker: string | null = null;
  let bestScore = -Infinity;
  
  for (const [speaker, score] of Object.entries(speakerScores)) {
    if (score > bestScore) {
      bestScore = score;
      bestSpeaker = speaker;
    }
  }
  
  return bestSpeaker;
}

// Scan window constants
const SCAN_WINDOWS = [60, 120, 180];

interface ScanState {
  systemMessageSeen: boolean;
  systemMessageTime: number | null;
  ivrStrongTime: number | null;
  ivrWeakTime: number | null;
  firstHumanTime: number | null;
  humanHasConversationalMarkers: boolean;
  voicemailTime: number | null;
  voicemailActionCueSeen: boolean;
  spamTime: number | null;
  recipientSpeaker: string | null;
  evidence: string[];
  lastScannedTime: number;
}

interface TranscriptAnalysisResult {
  timeToHumanSeconds: number | null;
  classification: CallClassification;
  confidence: number;
  evidence: string;
  detectedLanguage: string;
  scanWindowSecondsUsed: number;
  scanEndSeconds: number;
  ivrSeen: boolean;
  signals: import("@shared/schema").CallAnalysisSignals;
  reviewRequired: boolean;
  stopReason: 'human_detected' | 'voicemail_detected' | 'ivr_menu_detected' | 'timeout';
}

function isWhisperSingleMonologue(transcript: any): boolean {
  if (!transcript?.monologues || transcript.monologues.length !== 1) return false;
  const mono = transcript.monologues[0];
  const elements = (mono.elements || []).filter((e: any) => e.type !== "punct");
  if (elements.length < 10) return false;
  let uniformSpacing = true;
  for (let i = 1; i < Math.min(elements.length, 10); i++) {
    const gap = (elements[i].ts || 0) - (elements[i - 1].ts || 0);
    if (Math.abs(gap - 0.5) > 0.1) { uniformSpacing = false; break; }
  }
  return uniformSpacing;
}

function splitWhisperMonologue(monologue: any): any[] {
  const elements = monologue.elements || [];
  if (elements.length <= 15) return [monologue];

  const chunks: any[][] = [];
  let currentChunk: any[] = [];

  for (const el of elements) {
    currentChunk.push(el);
    if (el.type === "punct") {
      const val = (el.value || "").trim();
      if ((val === "." || val === "?" || val === "!") && currentChunk.length >= 3) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    }
  }
  if (currentChunk.length > 0) {
    if (chunks.length > 0 && currentChunk.length < 5) {
      chunks[chunks.length - 1].push(...currentChunk);
    } else {
      chunks.push(currentChunk);
    }
  }

  if (chunks.length < 3 && elements.length > 40) {
    const CONNECTOR_PHRASES = [
      "thank you for calling", "thanks for calling", "this is", "hello",
      "good morning", "good afternoon", "good evening", "hi there",
      "welcome to", "you have reached", "you've reached", "please hold",
      "if you", "press", "for", "to speak", "leave a message", "after the beep",
      "your call", "we are", "we're", "our office"
    ];
    chunks.length = 0;
    let currentChunk: any[] = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.type !== "punct" && currentChunk.length >= 8) {
        const lookAhead = elements.slice(i, i + 5)
          .filter((e: any) => e.type !== "punct")
          .map((e: any) => (e.value || "").toLowerCase())
          .join(" ");
        const isConnector = CONNECTOR_PHRASES.some(p => lookAhead.startsWith(p));
        if (isConnector) {
          chunks.push(currentChunk);
          currentChunk = [];
        }
      }
      currentChunk.push(el);
    }
    if (currentChunk.length > 0) {
      if (chunks.length > 0 && currentChunk.length < 5) {
        chunks[chunks.length - 1].push(...currentChunk);
      } else {
        chunks.push(currentChunk);
      }
    }

    if (chunks.length < 3) {
      chunks.length = 0;
      for (let i = 0; i < elements.length; i += 20) {
        chunks.push(elements.slice(i, Math.min(i + 20, elements.length)));
      }
    }
  }

  return chunks.map(chunk => ({
    speaker: monologue.speaker,
    elements: chunk,
  }));
}

export async function analyzeTranscriptWithWindows(
  transcript: any,
  pickupTimeSeconds: number | null,
  fileDurationSeconds: number | null
): Promise<TranscriptAnalysisResult> {
  const emptySignals: import("@shared/schema").CallAnalysisSignals = {};

  if (!transcript || !transcript.monologues) {
    return {
      timeToHumanSeconds: null,
      classification: "unknown",
      confidence: 0.3,
      evidence: "No transcript data available",
      detectedLanguage: "unknown",
      scanWindowSecondsUsed: 0,
      scanEndSeconds: 0,
      ivrSeen: false,
      signals: emptySignals,
      reviewRequired: true,
      stopReason: 'timeout'
    };
  }

  const startTime = pickupTimeSeconds || 0;

  const whisperDetected = isWhisperSingleMonologue(transcript);
  let effectiveMonologues = transcript.monologues;
  if (whisperDetected) {
    effectiveMonologues = splitWhisperMonologue(transcript.monologues[0]);
  }

  const state: ScanState = {
    systemMessageSeen: false,
    systemMessageTime: null,
    ivrStrongTime: null,
    ivrWeakTime: null,
    firstHumanTime: null,
    humanHasConversationalMarkers: false,
    voicemailTime: null,
    voicemailActionCueSeen: false,
    spamTime: null,
    recipientSpeaker: identifyRecipientSpeaker(transcript, startTime),
    evidence: [],
    lastScannedTime: startTime
  };

  const hasDiarization = state.recipientSpeaker !== null;
  const speakerCount = new Set((transcript.monologues || []).map((m: any) => m.speaker?.toString())).size;
  let finalWindowUsed = SCAN_WINDOWS[0];
  let actualScanEnd = startTime;
  const ivrSeen = () => state.ivrStrongTime !== null || state.ivrWeakTime !== null;

  for (const windowSeconds of SCAN_WINDOWS) {
    const windowEnd = startTime + windowSeconds;
    const scanEnd = fileDurationSeconds !== null
      ? Math.min(windowEnd, fileDurationSeconds)
      : windowEnd;


    for (const monologue of effectiveMonologues) {
      const speaker = monologue.speaker?.toString() || "unknown";
      const isRecipientSide = !hasDiarization || speaker === state.recipientSpeaker;

      if (!isRecipientSide && !ivrSeen() && speakerCount <= 2) continue;

      const elements = (monologue.elements || []).filter((e: any) => {
        const ts = e.ts || 0;
        return ts >= state.lastScannedTime && ts <= scanEnd;
      });
      if (elements.length === 0) continue;

      const phraseText = elements
        .map((e: any) => e.value || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const firstTs = elements[0].ts || 0;

      if (!phraseText) continue;

      const chunkHits = {
        disclaimer: RECORDING_DISCLAIMER_PATTERNS.some(p => p.test(phraseText)),
        spam: SPAM_PATTERNS.some(p => p.test(phraseText)),
        voicemail: VOICEMAIL_PATTERNS.some(p => p.test(phraseText)),
        voicemailCue: VOICEMAIL_ACTION_CUES.some(p => p.test(phraseText)),
        autoAttendant: AUTO_ATTENDANT_PATTERNS.some(p => p.test(phraseText)),
        ivrStrong: IVR_STRONG_PATTERNS.some(p => p.test(phraseText)),
        ivrWeak: IVR_WEAK_PATTERNS.some(p => p.test(phraseText)),
        human: HUMAN_PATTERNS.some(p => p.test(phraseText)),
        conversational: HUMAN_CONVERSATIONAL_MARKERS.some(p => p.test(phraseText)),
      };

      if (chunkHits.disclaimer) {
        if (!state.systemMessageSeen) {
          state.systemMessageSeen = true;
          state.systemMessageTime = firstTs;
          state.evidence.push(`System message at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
        }
        if (chunkHits.human && !chunkHits.ivrStrong && state.firstHumanTime === null) {
          state.firstHumanTime = firstTs;
          state.evidence.push(`Human detected in disclaimer chunk at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
          if (chunkHits.conversational) {
            state.humanHasConversationalMarkers = true;
          }
        }
        continue;
      }

      if (chunkHits.spam) {
        if (state.spamTime === null) {
          state.spamTime = firstTs;
          state.evidence.push(`Spam/robocall at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
        }
        continue;
      }

      if (chunkHits.voicemail && state.voicemailTime === null) {
        state.voicemailTime = firstTs;
        state.evidence.push(`Voicemail signal at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
      }

      if (chunkHits.voicemailCue) {
        state.voicemailActionCueSeen = true;
      }

      if (chunkHits.autoAttendant) {
        if (state.ivrWeakTime === null) {
          state.ivrWeakTime = firstTs;
          state.evidence.push(`IVR queue at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
        }
      }

      if (chunkHits.ivrStrong) {
        if (state.ivrStrongTime === null) {
          state.ivrStrongTime = firstTs;
          state.evidence.push(`IVR menu at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);

          if (state.firstHumanTime !== null && !state.humanHasConversationalMarkers && state.firstHumanTime <= firstTs) {
            state.evidence.push(`Human timing invalidated: prior human at ${state.firstHumanTime.toFixed(1)}s was part of IVR preamble (IVR strong at ${firstTs.toFixed(1)}s, no conversational markers)`);
            state.firstHumanTime = null;
          }
        }
      }

      if (!state.ivrStrongTime && chunkHits.ivrWeak) {
        if (state.ivrWeakTime === null) {
          state.ivrWeakTime = firstTs;
          state.evidence.push(`IVR weak at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
        }
      }

      if (chunkHits.human && !chunkHits.ivrStrong) {
        if (state.ivrStrongTime !== null) {
          if (state.firstHumanTime === null) {
            state.firstHumanTime = firstTs;
            state.evidence.push(`Human detected at ${firstTs.toFixed(1)}s (post-IVR): "${phraseText.slice(0, 60)}"`);
          }
          if (chunkHits.conversational) {
            state.humanHasConversationalMarkers = true;
          }
        } else {
          if (state.firstHumanTime === null) {
            state.firstHumanTime = firstTs;
            state.evidence.push(`Human detected at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
          }
          if (chunkHits.conversational) {
            state.humanHasConversationalMarkers = true;
          }
        }
      } else if (chunkHits.human && chunkHits.ivrStrong) {
        state.evidence.push(`Human greeting suppressed (IVR co-occurrence) at ${firstTs.toFixed(1)}s: "${phraseText.slice(0, 60)}"`);
      }
    }

    state.lastScannedTime = scanEnd;
    actualScanEnd = scanEnd;
    finalWindowUsed = windowSeconds;

    if (state.spamTime !== null) {
      break;
    }

    if (fileDurationSeconds !== null && scanEnd >= fileDurationSeconds) {
      break;
    }

    const hasHuman = state.firstHumanTime !== null;
    const hasVoicemailWithCue = state.voicemailTime !== null && state.voicemailActionCueSeen;
    if (hasHuman || hasVoicemailWithCue) {
      break;
    }
  }

  if (state.firstHumanTime === null && state.voicemailTime === null && !ivrSeen() && state.spamTime === null) {
    const fallbackStart = pickupTimeSeconds || 0;
    const speakerTurns: Array<{speaker: string; ts: number; wordCount: number}> = [];
    for (const monologue of transcript.monologues || []) {
      const speaker = monologue.speaker?.toString() || "unknown";
      const words = (monologue.elements || []).filter((e: any) => {
        return e.type !== "punct" && typeof e.ts === 'number' && e.ts >= fallbackStart;
      });
      if (words.length >= 3) {
        speakerTurns.push({ speaker, ts: words[0].ts, wordCount: words.length });
      }
    }

    const uniqueSpeakers = new Set(speakerTurns.map(t => t.speaker));
    if (uniqueSpeakers.size >= 2 && speakerTurns.length >= 3) {
      const firstTurn = speakerTurns[0];
      state.firstHumanTime = firstTurn.ts;
      state.evidence.push(
        `Dialogue fallback: ${speakerTurns.length} turns from ${uniqueSpeakers.size} speakers at ${firstTurn.ts.toFixed(1)}s`
      );
    }
  }

  let classification: CallClassification;
  let confidence: number;
  let reviewRequired = false;
  let stopReason: TranscriptAnalysisResult['stopReason'];

  if (state.spamTime !== null) {
    classification = "unknown";
    confidence = 0.3;
    stopReason = 'timeout';
    state.evidence.push("Classification: spam detected → unknown");
  } else if (state.voicemailTime !== null && state.voicemailActionCueSeen) {
    if (state.firstHumanTime !== null && state.firstHumanTime > state.voicemailTime) {
      classification = "human";
      confidence = 0.75;
      stopReason = 'human_detected';
      reviewRequired = true;
      state.evidence.push("Classification: voicemail then human → human (review)");
    } else if (state.firstHumanTime !== null && state.firstHumanTime <= state.voicemailTime) {
      classification = "human";
      confidence = 0.8;
      stopReason = 'human_detected';
      state.evidence.push("Classification: human before voicemail → human");
    } else {
      classification = "voicemail";
      confidence = 0.9;
      stopReason = 'voicemail_detected';
      state.evidence.push("Classification: voicemail with action cue");
    }
  } else if (state.voicemailTime !== null && !state.voicemailActionCueSeen) {
    state.evidence.push("Voicemail signal ignored: no action cue (leave message, beep, tone, etc.)");
    if (state.firstHumanTime !== null) {
      classification = "human";
      confidence = 0.8;
      stopReason = 'human_detected';
      state.evidence.push("Classification: human (voicemail signal without action cue ignored)");
    } else if (state.ivrStrongTime !== null) {
      classification = "ivr_menu";
      confidence = 0.8;
      stopReason = 'ivr_menu_detected';
      state.evidence.push("Classification: ivr_menu (voicemail signal ignored)");
    } else {
      classification = "unknown";
      confidence = 0.4;
      stopReason = 'timeout';
      reviewRequired = true;
      state.evidence.push("Classification: unknown (voicemail signal without action cue)");
    }
  } else if (state.ivrStrongTime !== null) {
    if (state.firstHumanTime !== null && state.firstHumanTime > state.ivrStrongTime) {
      classification = "human";
      confidence = 0.8;
      stopReason = 'human_detected';
      state.evidence.push("Classification: IVR menu then human transfer");
    } else {
      classification = "ivr_menu";
      confidence = 0.85;
      stopReason = 'ivr_menu_detected';
      state.evidence.push("Classification: IVR menu (strong patterns)");
    }
  } else if (state.ivrWeakTime !== null && state.firstHumanTime !== null) {
    if (state.humanHasConversationalMarkers) {
      classification = "human";
      confidence = 0.85;
      stopReason = 'human_detected';
      state.evidence.push("Classification: human (conversational markers override weak IVR)");
    } else {
      classification = "ivr_queue";
      confidence = 0.6;
      stopReason = 'timeout';
      reviewRequired = true;
      state.evidence.push("Classification: ivr_queue (weak IVR + human without conversational markers)");
    }
  } else if (state.ivrWeakTime !== null) {
    classification = "ivr_queue";
    confidence = 0.7;
    stopReason = 'timeout';
    state.evidence.push("Classification: ivr_queue (weak IVR, no human)");
  } else if (state.systemMessageSeen && state.firstHumanTime !== null) {
    classification = "system_message_then_human";
    confidence = 0.85;
    stopReason = 'human_detected';
    state.evidence.push("Classification: system_message_then_human");
  } else if (state.firstHumanTime !== null) {
    classification = "human";
    confidence = 0.85;
    stopReason = 'human_detected';
    state.evidence.push("Classification: human");
  } else {
    classification = "unknown";
    confidence = 0.4;
    stopReason = 'timeout';
    reviewRequired = true;
    state.evidence.push("Classification: unknown (no patterns matched)");
  }

  if (!reviewRequired && confidence < 0.7) {
    reviewRequired = true;
  }

  const signals: import("@shared/schema").CallAnalysisSignals = {};
  if (state.firstHumanTime !== null) signals.humanSeenAtSeconds = state.firstHumanTime;
  if (state.ivrStrongTime !== null) signals.ivrMenuSeenAtSeconds = state.ivrStrongTime;
  if (state.ivrWeakTime !== null) signals.ivrQueueSeenAtSeconds = state.ivrWeakTime;
  if (state.voicemailTime !== null) signals.voicemailSeenAtSeconds = state.voicemailTime;
  if (state.systemMessageTime !== null) signals.systemMessageSeenAtSeconds = state.systemMessageTime;


  const languageResult = await detectLanguage(transcript);

  return {
    timeToHumanSeconds: state.firstHumanTime,
    classification,
    confidence,
    evidence: state.evidence.join("; ") || "No specific patterns detected",
    detectedLanguage: languageResult,
    scanWindowSecondsUsed: finalWindowUsed,
    scanEndSeconds: actualScanEnd,
    ivrSeen: ivrSeen(),
    signals,
    reviewRequired,
    stopReason
  };
}

// Keep old function for backwards compatibility
export async function analyzeTranscript(
  transcript: any,
  pickupTimeSeconds: number | null,
  maxListenSeconds: number
): Promise<{ 
  timeToHumanSeconds: number | null;
  classification: CallClassification;
  confidence: number;
  evidence: string;
  detectedLanguage: string;
}> {
  const result = await analyzeTranscriptWithWindows(transcript, pickupTimeSeconds, null);
  return {
    timeToHumanSeconds: result.timeToHumanSeconds,
    classification: result.classification,
    confidence: result.confidence,
    evidence: result.evidence,
    detectedLanguage: result.detectedLanguage
  };
}

async function detectLanguage(transcript: any): Promise<string> {
  try {
    let sampleText = "";
    if (transcript.monologues) {
      for (const mono of transcript.monologues.slice(0, 3)) {
        for (const el of (mono.elements || []).slice(0, 10)) {
          sampleText += (el.value || "") + " ";
        }
      }
    }
    
    if (!sampleText.trim()) return "unknown";
    
    const response = await openai.chat.completions.create({
      model: CHEAP_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a language detector. Respond with ONLY the language name: English, Spanish, or Other."
        },
        {
          role: "user",
          content: `Detect the language of this text: "${sampleText.slice(0, 500)}"`
        }
      ],
      reasoning_effort: "minimal",
      max_completion_tokens: 2000,
    });
    
    const lang = response.choices[0]?.message?.content?.trim().toLowerCase() || "unknown";
    if (lang.includes("english")) return "english";
    if (lang.includes("spanish") || lang.includes("español")) return "spanish";
    return "other";
  } catch (e) {
    return "unknown";
  }
}

// Task #1049 / workers-queues parity (E-F02): per-lane wall-clock
// budgets. The processing ceilings now come from the canonical
// queueMaxProcessing lanes (`call_analysis` = 5 min,
// `call_analysis_slow` = 16 min at the defaults; operator-tunable via
// the work_queue_max_processing_ms setting) instead of hard-coded
// constants duplicated here. The in-run deadline is derived as
// (ceiling - 60s slack), which reproduces the historical hard-coded
// 4-minute normal / 15-minute slow budgets exactly at the defaults.
const CALL_ANALYSIS_HEARTBEAT_MS = 60 * 1000;
// Lease quantum: how far ahead a claim/heartbeat pushes locked_until.
// Two heartbeat periods — one missed heartbeat doesn't lose the lease,
// but a crashed worker's row becomes reclaimable within ~2 minutes.
const CALL_ANALYSIS_LEASE_MS = 2 * CALL_ANALYSIS_HEARTBEAT_MS;
export function callAnalysisQueueNameForLane(lane: string | null | undefined): "call_analysis" | "call_analysis_slow" {
  return lane === 'slow' ? 'call_analysis_slow' : 'call_analysis';
}
async function laneCeilingMs(lane: string | null | undefined): Promise<number> {
  return getMaxProcessingMs(callAnalysisQueueNameForLane(lane));
}
async function jobTimeoutForLane(lane: string | null | undefined): Promise<number> {
  const ceilingMs = await laneCeilingMs(lane);
  return Math.max(60 * 1000, ceilingMs - 60 * 1000);
}
const STFT_WAV_MAX_SECONDS = 65;

// Task #1049: routing thresholds.
//   * Files longer than SLOW_LANE_DURATION_THRESHOLD seconds are
//     re-routed from the normal lane to the slow lane upfront so they
//     can't starve normal-call latency or trip the 4-minute budget
//     before Whisper runs (the 572 `Job timed out before Whisper
//     transcription` failures all came from this path).
//   * Files larger than FILE_TOO_LARGE_BYTES are rejected with a typed
//     `file_too_large` reason — they're guaranteed to time out and we
//     waste several minutes of CPU and download bandwidth otherwise.
const SLOW_LANE_DURATION_THRESHOLD_SECONDS = 600; // 10 min
const FILE_TOO_LARGE_BYTES = 200 * 1024 * 1024;   // 200 MB

// Task #1049: classify a thrown error into the typed failure reason
// stored in call_analysis_jobs.failure_reason. Matching is in priority
// order: explicit `failureReason` tag from the inner thrower wins,
// otherwise we string-match the message. The free-text errorMessage is
// preserved separately for human debugging.
export function classifyFailure(err: any): import("@shared/schema").CallAnalysisFailureReason {
  if (err?.failureReason) return err.failureReason;
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('ffmpeg') && msg.includes('timed out')) return 'ffmpeg_timeout';
  if (msg.includes('ffmpeg') && (msg.includes('exited with code') || msg.includes('invalid'))) return 'ffmpeg_invalid_audio';
  if (msg.includes('whisper') && msg.includes('timed out')) return 'whisper_timeout';
  if (msg.includes('timed out before whisper')) return 'whisper_timeout';
  if (msg.includes('timed out during audio processing')) return 'cpu_starved';
  if (msg.includes('failed to download audio') || msg.includes('http ') && msg.includes('from ')) return 'download_failed';
  if (msg.includes('file too large')) return 'file_too_large';
  return 'unknown';
}

function normalizeRevTranscript(rawTranscript: any): any {
  if (!rawTranscript) return null;
  
  if (rawTranscript.monologues) {
    return rawTranscript;
  }
  
  if (rawTranscript.transcript_json) {
    try {
      const inner = typeof rawTranscript.transcript_json === 'string' 
        ? JSON.parse(rawTranscript.transcript_json) 
        : rawTranscript.transcript_json;
      if (inner && inner.monologues) {
        return inner;
      }
    } catch (e) {
    }
  }
  
  if (typeof rawTranscript.transcript === 'string' && rawTranscript.transcript.trim()) {
    const words = rawTranscript.transcript.split(/\s+/).filter((w: string) => w.length > 0);
    return {
      monologues: [{
        speaker: 0,
        elements: words.map((word: string, i: number) => ({
          type: "text",
          value: word,
          ts: i * 0.5,
          end_ts: (i + 1) * 0.5,
        }))
      }]
    };
  }
  
  return rawTranscript;
}

// Workers/queues parity (E-F01): lease-guarded terminal writes. Only
// the owner of the current attempt epoch (attempt_count captured at
// claim time) may finalize a processing row. If stale recovery requeued
// the row — and possibly another worker re-claimed it — the guard
// matches 0 rows and the caller must skip all side effects. Exported
// for the focused lease-controls suite.
export async function finalizeJobComplete(
  analysisId: string,
  claimedAttempts: number,
  result: CallAnalysisResult,
): Promise<boolean> {
  const rows = await dbRetry(() =>
    db.update(callAnalysisJobs)
      .set({
        status: "complete",
        resultJson: result,
        completedAt: new Date(),
        lockedUntil: null,
        leasedAt: null,
      })
      .where(and(
        eq(callAnalysisJobs.analysisId, analysisId),
        eq(callAnalysisJobs.status, "processing"),
        sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) = ${claimedAttempts}`,
      ))
      .returning({ analysisId: callAnalysisJobs.analysisId }),
    "callanalysis-set-complete"
  );
  return rows.length > 0;
}

export async function finalizeJobFailed(
  analysisId: string,
  claimedAttempts: number,
  error: any,
): Promise<boolean> {
  // Task #1049: persist the typed failure reason alongside the
  // free-text errorMessage so the failure mix is groupable.
  const failureReason = classifyFailure(error);
  const rows = await dbRetry(() =>
    db.update(callAnalysisJobs)
      .set({
        status: "failed",
        errorMessage: error?.message || "Unknown error",
        failureReason,
        completedAt: new Date(),
        lockedUntil: null,
        leasedAt: null,
      })
      .where(and(
        eq(callAnalysisJobs.analysisId, analysisId),
        eq(callAnalysisJobs.status, "processing"),
        sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) = ${claimedAttempts}`,
      ))
      .returning({ analysisId: callAnalysisJobs.analysisId }),
    "callanalysis-set-failed"
  ).catch(() => [] as Array<{ analysisId: string }>);
  return rows.length > 0;
}

// Workers/queues parity (E-F01): claim-by-id is now a single guarded
// UPDATE (the row must still be 'queued') that also stamps the lease
// columns. The previous getJob + unconditional UPDATE pair could
// re-claim a row another instance was already processing. The poller
// claims via claimNextQueuedJob instead and runs runClaimedJob directly.
export async function processJob(analysisId: string): Promise<CallAnalysisResult> {
  const claimed = await dbRetry(() =>
    db.update(callAnalysisJobs)
      .set({
        status: "processing",
        startedAt: sql`NOW()`,
        attemptCount: sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) + 1`,
        leasedAt: sql`NOW()`,
        lockedUntil: sql`NOW() + interval '${sql.raw(String(CALL_ANALYSIS_LEASE_MS / 1000))} seconds'`,
      })
      .where(and(
        eq(callAnalysisJobs.analysisId, analysisId),
        eq(callAnalysisJobs.status, "queued"),
      ))
      .returning(),
    "callanalysis-set-processing"
  );
  const job = claimed[0];
  if (!job) {
    const existing = await getJob(analysisId);
    if (!existing) {
      throw new Error("Job not found");
    }
    // Row exists but is not queued: another worker owns it or it is
    // terminal. Refusing (instead of silently re-running) is what
    // prevents double-processing.
    throw new Error(`Job ${analysisId} is not claimable (status=${existing.status})`);
  }
  return runClaimedJob(job);
}

// Internal: run a job THIS worker just claimed atomically. `job` is the
// post-claim row (status='processing', attempt_count already bumped —
// that value is the lease epoch guarding every subsequent write, same
// pattern as callArchivePipeline).
async function runClaimedJob(job: typeof callAnalysisJobs.$inferSelect): Promise<CallAnalysisResult> {
  const analysisId = job.analysisId;
  const claimedAttempts = job.attemptCount ?? 0;
  const laneLabel = job.lane === 'slow' ? 'call_analysis_slow' : 'call_analysis';

  const jobStartTime = Date.now();
  // Task #1049: lane-aware wall-clock budget (lane ceiling - 60 s
  // slack — 4 min normal / 15 min slow at the default ceilings).
  const jobTimeoutMs = await jobTimeoutForLane(job.lane);
  const ceilingMs = await laneCeilingMs(job.lane);

  // Workers/queues parity (E-F02): heartbeat. Extends locked_until by
  // the lease quantum while the job runs, but never past
  // leased_at + ceiling (LEAST in SQL) — a hung job cannot keep
  // ownership forever. Lease-guarded on (status, attempt_count) so a
  // reclaimed row's new lease is never touched by this owner.
  let capExceededLogged = false;
  const tickHeartbeat = async () => {
    try {
      const elapsedMs = Date.now() - jobStartTime;
      if (elapsedMs >= ceilingMs) {
        if (!capExceededLogged) {
          capExceededLogged = true;
          workerLog({
            worker: laneLabel,
            event: "max_processing_exceeded",
            jobId: analysisId,
            queueName: callAnalysisQueueNameForLane(job.lane),
            elapsedMs,
            maxProcessingMs: ceilingMs,
            attempts: claimedAttempts,
          });
        }
        return; // stop extending — recovery may reclaim at the ceiling
      }
      await db.update(callAnalysisJobs)
        .set({
          lockedUntil: sql`LEAST(NOW() + interval '${sql.raw(String(CALL_ANALYSIS_LEASE_MS / 1000))} seconds', ${callAnalysisJobs.leasedAt} + ${Math.floor(ceilingMs / 1000)} * interval '1 second')`,
        })
        .where(and(
          eq(callAnalysisJobs.analysisId, analysisId),
          eq(callAnalysisJobs.status, "processing"),
          sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) = ${claimedAttempts}`,
        ));
    } catch (err: any) {
      console.warn(`[CallAnalysis] Heartbeat lease-extend failed for ${analysisId}:`, err?.message);
    }
  };
  const heartbeat = setInterval(() => { void tickHeartbeat(); }, CALL_ANALYSIS_HEARTBEAT_MS);
  heartbeat.unref?.();

  let tempMp3: string | null = null;
  let tempWavShort: string | null = null;
  let tempWavFull: string | null = null;

  try {
    let ringbackResult = { pickupTimeSeconds: null as number | null, evidence: "No audio provided" };
    let transcript = normalizeRevTranscript(job.revTranscriptJson);
    let whisperLanguage: string | null = null;
    let fileDurationSeconds: number | null = null;
    let callDurationSeconds: number | null = null;
    
    if (job.audioUrl) {
      const hasTranscriptFallback = !!(transcript && (transcript as any).monologues);
      let audioDownloaded = false;
      let audioSizeBytes: number | null = null;

      try {
        const dl = await downloadAudioWithMeta(job.audioUrl);
        tempMp3 = dl.path;
        audioSizeBytes = dl.sizeBytes;
        audioDownloaded = true;
      } catch (dlError: any) {
        if (hasTranscriptFallback) {
          ringbackResult = { pickupTimeSeconds: null, evidence: `Audio download failed: ${dlError.message} — using transcript-only` };
        } else {
          throw dlError;
        }
      }

      if (audioDownloaded && tempMp3) {
        // Task #1049 step 1: preflight metadata. Probe duration with
        // ffprobe and read size from the buffer we already downloaded
        // before any conversion runs. Persisted on the job row so
        // re-routing decisions and dashboards have the data even if a
        // later stage fails.
        callDurationSeconds = await getAudioDuration(tempMp3);
        await dbRetry(() =>
          db.update(callAnalysisJobs)
            .set({
              audioDurationSeconds: callDurationSeconds,
              audioSizeBytes: audioSizeBytes,
            })
            .where(eq(callAnalysisJobs.analysisId, analysisId)),
          "callanalysis-preflight-meta",
        ).catch(() => {});

        // Task #1049 step 1: reject obviously bad files upfront. A
        // 200 MB+ recording is guaranteed to time out under our worker
        // budget — fail fast with a typed reason instead of burning
        // the slot.
        if (audioSizeBytes !== null && audioSizeBytes > FILE_TOO_LARGE_BYTES) {
          const err: any = new Error(`File too large: ${(audioSizeBytes / 1024 / 1024).toFixed(1)} MB exceeds ${FILE_TOO_LARGE_BYTES / 1024 / 1024} MB limit`);
          err.failureReason = 'file_too_large';
          throw err;
        }

        // Task #1049 step 2/3: route long audio to the slow lane
        // upfront. We only re-route from the normal lane — a job
        // already on the slow lane stays put so we don't ping-pong.
        // The slow-lane poller will pick it up and process with the
        // 15-minute budget + bucketed ffmpeg timeouts.
        if (
          job.lane !== 'slow' &&
          callDurationSeconds !== null &&
          callDurationSeconds > SLOW_LANE_DURATION_THRESHOLD_SECONDS
        ) {
          console.log(`[CallAnalysis] ${analysisId}: rerouting to slow lane (duration=${callDurationSeconds}s > ${SLOW_LANE_DURATION_THRESHOLD_SECONDS}s)`);
          const rerouted = await dbRetry(() =>
            db.update(callAnalysisJobs)
              .set({
                lane: 'slow',
                status: 'queued',
                startedAt: null,
                // Reset attempt count so the slow-lane poller gets a
                // full retry budget — the normal-lane attempt didn't
                // do any real work beyond preflight.
                attemptCount: 0,
                errorMessage: null,
                failureReason: null,
                // Parity E-F01: release the lease with the requeue — a
                // queued row must not carry a live lock.
                lockedUntil: null,
                leasedAt: null,
              })
              // Lease-guarded: only the current owner may requeue. If
              // the row was reclaimed while preflight ran, leave it to
              // its new owner.
              .where(and(
                eq(callAnalysisJobs.analysisId, analysisId),
                eq(callAnalysisJobs.status, "processing"),
                sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) = ${claimedAttempts}`,
              ))
              .returning({ analysisId: callAnalysisJobs.analysisId }),
            "callanalysis-route-slow-lane",
          );
          if (rerouted.length === 0) {
            workerLog({
              worker: laneLabel,
              event: "job_completion_stale_lease_ignored",
              jobId: analysisId,
              attempts: claimedAttempts,
              detail: "slow-lane reroute skipped - lease no longer owned",
            });
          }
          // Return a sentinel result so processJob's caller doesn't
          // mark this job complete. Cleanup happens in `finally`.
          return {
            pickupTimeSeconds: null,
            timeToHumanSeconds: null,
            finalClassification: 'unknown',
            confidence: 0,
            evidence: `Routed to slow lane (duration=${callDurationSeconds}s)`,
            reviewRequired: false,
            signals: {},
            callDurationSeconds,
          } as CallAnalysisResult;
        }

        const needsWhisper = !transcript || !(transcript as any).monologues;

        tempWavShort = await convertToWav(tempMp3, STFT_WAV_MAX_SECONDS);

        try {
          fileDurationSeconds = await getWavDuration(tempWavShort);
        } catch (e) {
        }

        if (Date.now() - jobStartTime > jobTimeoutMs) {
          const err: any = new Error("Job timed out during audio processing");
          err.failureReason = 'cpu_starved';
          throw err;
        }

        const stftStart = Date.now();
        ringbackResult = await detectRingbackPickup(tempWavShort);

        if (needsWhisper) {
          if (Date.now() - jobStartTime > jobTimeoutMs) {
            // Task #1049: this used to fire ~572×/week because long
            // calls burned the budget on download + ffmpeg + STFT
            // before Whisper ever ran. Now that long files are
            // re-routed to the slow lane upfront, this should fire
            // only if the slow lane itself is starved — typed as
            // `whisper_timeout` so it's groupable.
            const err: any = new Error("Job timed out before Whisper transcription");
            err.failureReason = 'whisper_timeout';
            throw err;
          }
          const whisperMaxSeconds = Math.min(callDurationSeconds || 180, 300);
          let whisperWav = tempWavShort;
          if (whisperMaxSeconds > STFT_WAV_MAX_SECONDS) {
            whisperWav = await convertToWav(tempMp3, whisperMaxSeconds);
            tempWavFull = whisperWav;
          }
          const whisperStart = Date.now();
          const whisperResult = await transcribeAudio(whisperWav, whisperMaxSeconds);
          transcript = whisperResult.transcript;
          whisperLanguage = whisperResult.detectedLanguage;
          if (whisperResult.hasSyntheticTimestamps) {
            console.log(`[CallAnalysis] ${analysisId}: Whisper transcription produced synthetic timestamps — will require timestamp correction`);
          }
        }
      }
    } else if (!transcript) {
      throw new Error("No audio URL and no transcript provided - cannot analyze");
    } else {
    }
    
    let effectivePickup = ringbackResult.pickupTimeSeconds;
    const hasRealTimestamps = !!job.revTranscriptJson && !whisperLanguage;
    
    // Step 1: Whisper timestamp cross-check (FIRST, before Rev-based cross-validation).
    // When we have both Rev transcript and audio, run whisper-1 on the audio
    // to get accurate word-level timestamps. Rev timestamps can be off by 5+ seconds.
    let whisperTimestampResult: Awaited<ReturnType<typeof transcribeForTimestamps>> = null;
    let whisperFirstSpeech: number | null = null;
    if (hasRealTimestamps && tempWavShort && Date.now() - jobStartTime < jobTimeoutMs) {
      try {
        const whisperTsStart = Date.now();
        whisperTimestampResult = await transcribeForTimestamps(tempWavShort);
        
        if (whisperTimestampResult) {
          if (whisperTimestampResult.hasSyntheticTimestamps) {
            console.log("[CallAnalysis] Whisper cross-check returned synthetic timestamps — skipping timestamp-based corrections");
          }
          whisperFirstSpeech = whisperTimestampResult.hasSyntheticTimestamps ? null : whisperTimestampResult.firstSpeechTime;
          
          if (!whisperTimestampResult.hasSyntheticTimestamps && whisperTimestampResult.firstHumanGreetingTime !== null) {
            const whisperGreeting = whisperTimestampResult.firstHumanGreetingTime;
            const currentPickup = effectivePickup ?? Infinity;
            
            if (whisperGreeting < currentPickup - 1) {
              const adjusted = Math.round(Math.max(0, whisperGreeting - 0.5) * 10) / 10;
              ringbackResult = {
                ...ringbackResult,
                evidence: `${ringbackResult.evidence}; Whisper cross-check: greeting at ${whisperGreeting.toFixed(1)}s`,
              };
              effectivePickup = adjusted;
            } else if (effectivePickup === null && whisperGreeting < 30) {
              const adjusted = Math.round(Math.max(0, whisperGreeting - 0.5) * 10) / 10;
              effectivePickup = adjusted;
            }
          }
        }
      } catch (e: any) {
      }
    }
    
    // Step 2: Rev-based cross-validation (only when Whisper didn't already adjust).
    // Forward cross-validation uses a 10s threshold since Rev timestamps can be 5+ seconds off.
    // Backward cross-validation checks for recipient speech before STFT pickup.
    if (effectivePickup !== null && transcript?.monologues) {
      const firstSpeechAfterPickup = getFirstSpeechTimeAfter(transcript, effectivePickup);
      if (firstSpeechAfterPickup !== null && firstSpeechAfterPickup - effectivePickup > 10) {
        const adjusted = Math.round((firstSpeechAfterPickup - 1) * 10) / 10;
        effectivePickup = adjusted;
      }
      
      if (hasRealTimestamps && effectivePickup > 5) {
        const recipientSpeaker = identifyRecipientSpeaker(transcript, effectivePickup);
        const recipientWordsBeforePickup = countSpeakerWordsInRange(
          transcript, recipientSpeaker, 0, effectivePickup
        );
        if (recipientWordsBeforePickup >= 5) {
          const firstRecipientBefore = getFirstSpeakerSpeechBefore(
            transcript, recipientSpeaker, effectivePickup
          );
          if (firstRecipientBefore !== null) {
            const adjusted = Math.round(Math.max(0, firstRecipientBefore - 0.5) * 10) / 10;
            effectivePickup = adjusted;
          }
        }
      }
    }
    
    let transcriptResult = await analyzeTranscriptWithWindows(
      transcript,
      effectivePickup,
      callDurationSeconds
    );
    
    if (
      (transcriptResult.classification === "ivr_menu" || transcriptResult.classification === "ivr_queue") &&
      !transcriptResult.signals.humanSeenAtSeconds &&
      job.audioUrl &&
      tempMp3 &&
      callDurationSeconds !== null &&
      callDurationSeconds > STFT_WAV_MAX_SECONDS &&
      Date.now() - jobStartTime < jobTimeoutMs
    ) {
      const extendSeconds = Math.min(callDurationSeconds, 300);
      
      const tempWavExtended = await convertToWav(tempMp3, extendSeconds);
      try {
        const extendedRingback = await detectRingbackPickup(tempWavExtended, extendSeconds);
        if (extendedRingback.pickupTimeSeconds !== null && extendedRingback.pickupTimeSeconds > (effectivePickup || 0) + 10) {
          ringbackResult = {
            ...ringbackResult,
            evidence: `${ringbackResult.evidence}; Extended STFT: second pickup at ${extendedRingback.pickupTimeSeconds}s`,
          };
          effectivePickup = extendedRingback.pickupTimeSeconds;
          
          transcriptResult = await analyzeTranscriptWithWindows(
            transcript,
            effectivePickup,
            callDurationSeconds
          );
        }
      } catch (e: any) {
      } finally {
        try { await fs.promises.unlink(tempWavExtended); } catch {}
      }
    }
    
    const totalElapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(`[CallAnalysis] Result: ${transcriptResult.classification}, window: ${transcriptResult.scanWindowSecondsUsed}s, stop: ${transcriptResult.stopReason}, total: ${totalElapsed}s`);

    const SHORT_CALL_CANNED_PATTERNS = [
      /thank you for calling\s+\w+/i,
      /welcome to\s+\w+/i,
      /calling\s+\w+\s+(law|legal|firm|group|office)/i,
    ];
    const isHumanClassification = transcriptResult.classification === "human" || transcriptResult.classification === "system_message_then_human";
    if (
      isHumanClassification &&
      callDurationSeconds !== null &&
      callDurationSeconds <= 12 &&
      !transcriptResult.ivrSeen
    ) {
      const fullText = (transcript?.monologues || [])
        .flatMap((m: any) => (m.elements || []).map((e: any) => e.value || ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const looksLikeCannedGreeting = SHORT_CALL_CANNED_PATTERNS.some(p => p.test(fullText));
      const hasConversation = fullText.split(/[.!?]/).filter((s: string) => s.trim().length > 10).length >= 3;
      if (looksLikeCannedGreeting && !hasConversation) {
        transcriptResult = {
          ...transcriptResult,
          classification: "ivr_queue",
          confidence: 0.6,
          evidence: `${transcriptResult.evidence}; Auto-greeting detected (${callDurationSeconds.toFixed(1)}s call, canned greeting, no conversation)`,
          reviewRequired: true,
          stopReason: 'timeout',
        };
      }
    }

    const hasSyntheticTimestamps = !!whisperLanguage && !hasRealTimestamps;
    const needsTimestampCorrection =
      hasSyntheticTimestamps ||
      (transcriptResult.timeToHumanSeconds === 0 && (effectivePickup === 0 || effectivePickup === null) && ringbackResult.pickupTimeSeconds === null);

    let timestampsCorrected = false;
    if (
      needsTimestampCorrection &&
      tempWavShort &&
      Date.now() - jobStartTime < jobTimeoutMs
    ) {
      try {
        const tsStart = Date.now();
        const tsResult = await transcribeForTimestamps(tempWavShort);

        if (tsResult) {
          if (tsResult.hasSyntheticTimestamps) {
            console.log("[CallAnalysis] Timestamp correction: model returned synthetic timestamps — skipping timing corrections");
          } else {
            timestampsCorrected = true;
            if (tsResult.firstSpeechTime !== null && tsResult.firstSpeechTime > 0.3) {
              const corrected = Math.round(tsResult.firstSpeechTime * 10) / 10;
              effectivePickup = corrected;
            }
            if (tsResult.firstHumanGreetingTime !== null) {
              const correctedTTHA = Math.round(tsResult.firstHumanGreetingTime * 10) / 10;
              const oldTTHA = transcriptResult.timeToHumanSeconds;
              transcriptResult = {
                ...transcriptResult,
                timeToHumanSeconds: correctedTTHA,
                evidence: `${transcriptResult.evidence}; Whisper timestamp correction: first speech=${tsResult.firstSpeechTime?.toFixed(1)}s, greeting=${tsResult.firstHumanGreetingTime.toFixed(1)}s`,
              };
            } else if (tsResult.firstSpeechTime !== null && transcriptResult.timeToHumanSeconds !== null) {
              const correctedTTHA = Math.round(Math.max(0, tsResult.firstSpeechTime) * 10) / 10;
              transcriptResult = {
                ...transcriptResult,
                timeToHumanSeconds: correctedTTHA,
                evidence: `${transcriptResult.evidence}; Whisper timestamp correction: first speech=${tsResult.firstSpeechTime.toFixed(1)}s (no greeting pattern)`,
              };
            }
          }
        }
      } catch (e: any) {
      }

      if (!timestampsCorrected && tempWavShort) {
        try {
          if (transcriptResult.ivrSeen && transcriptResult.timeToHumanSeconds !== null && transcriptResult.timeToHumanSeconds > 0) {
            const silenceResult = await detectSpeechAfterSilence(tempWavShort, 65);
            if (silenceResult.speechOnsets.length > 0) {
              let bestOnset = silenceResult.speechOnsets[0];
              for (const onset of silenceResult.speechOnsets) {
                if (onset.gapBefore > bestOnset.gapBefore) {
                  bestOnset = onset;
                }
              }
              if (bestOnset.gapBefore >= 1.0 && bestOnset.time > 5) {
                timestampsCorrected = true;
                const corrected = bestOnset.time;
                transcriptResult = {
                  ...transcriptResult,
                  timeToHumanSeconds: corrected,
                  evidence: `${transcriptResult.evidence}; VAD IVR→human correction: human speech at ${corrected}s after ${bestOnset.gapBefore}s silence`,
                };
              }
            }
            if (!timestampsCorrected) {
            }
          } else {
            const vadResult = await detectSpeechOnset(tempWavShort, 30);
            if (vadResult.firstSpeechTime !== null && vadResult.firstSpeechTime > 0.3) {
              timestampsCorrected = true;
              const corrected = vadResult.firstSpeechTime;
              effectivePickup = corrected;
              if (transcriptResult.timeToHumanSeconds !== null) {
                transcriptResult = {
                  ...transcriptResult,
                  timeToHumanSeconds: corrected,
                  evidence: `${transcriptResult.evidence}; VAD speech onset correction: ${corrected}s`,
                };
              }
            } else {
            }
          }
        } catch (e: any) {
        }
      }
    }

    let finalTTHA = transcriptResult.timeToHumanSeconds;
    if (
      effectivePickup !== null &&
      isHumanClassification &&
      !transcriptResult.ivrSeen &&
      transcriptResult.timeToHumanSeconds !== null &&
      transcriptResult.timeToHumanSeconds >= effectivePickup &&
      !timestampsCorrected
    ) {
      const pickupToSpeechGap = transcriptResult.timeToHumanSeconds - effectivePickup;
      if (pickupToSpeechGap <= 3.0) {
        finalTTHA = effectivePickup;
      } else {
      }
    } else if (timestampsCorrected) {
    }

    const result: CallAnalysisResult = {
      pickupTimeSeconds: effectivePickup,
      timeToHumanSeconds: finalTTHA,
      finalClassification: transcriptResult.classification,
      confidence: transcriptResult.confidence,
      evidence: `${ringbackResult.evidence}; ${transcriptResult.evidence}; scan_end=${transcriptResult.scanEndSeconds.toFixed(1)}s, window=${transcriptResult.scanWindowSecondsUsed}s, ivr_seen=${transcriptResult.ivrSeen}, stop=${transcriptResult.stopReason}`,
      reviewRequired: transcriptResult.reviewRequired,
      signals: transcriptResult.signals,
      detectedLanguage: whisperLanguage || transcriptResult.detectedLanguage,
      callDurationSeconds,
    };

    const completionLanded = await finalizeJobComplete(analysisId, claimedAttempts, result);
    if (!completionLanded) {
      // Completed work is never falsely failed — the analysis result is
      // still returned — but a stale owner must not overwrite the row's
      // new owner or fire side effects (touchpoint finalization).
      workerLog({
        worker: laneLabel,
        event: "job_completion_stale_lease_ignored",
        jobId: analysisId,
        attempts: claimedAttempts,
        detail: "completion skipped - row reclaimed while processing",
      });
      return result;
    }

    try {
      const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
      const isTouchpoint = classifyTouchpoint({
        sourceType: "twilio_call",
        callClassification: result.finalClassification,
      });
      const { finalizeTouchpointClassification } = await import("../storage/communicationStorage");
      await finalizeTouchpointClassification(job.externalId, isTouchpoint);
    } catch (tpErr: any) {
      console.error(`[CallAnalysis] Failed to finalize touchpoint classification for ${analysisId}:`, tpErr.message);
    }

    return result;
  } catch (error: any) {
    const failureLanded = await finalizeJobFailed(analysisId, claimedAttempts, error);
    if (!failureLanded) {
      workerLog({
        worker: laneLabel,
        event: "job_completion_stale_lease_ignored",
        jobId: analysisId,
        attempts: claimedAttempts,
        detail: "failure write skipped - lease no longer owned (or write failed)",
      });
    }

    throw error;
  } finally {
    clearInterval(heartbeat);
    try { if (tempMp3) await fs.promises.unlink(tempMp3); } catch {}
    try { if (tempWavShort) await fs.promises.unlink(tempWavShort); } catch {}
    try { if (tempWavFull) await fs.promises.unlink(tempWavFull); } catch {}
  }
}

// Task #1049: per-lane runtime state. Each lane has its own polling
// interval, in-flight flag, and worker-running flag so the slow lane
// can run its single concurrent job alongside the normal lane without
// contending for the same in-process gate.
type LaneRuntime = {
  workerRunning: boolean;
  workerInterval: NodeJS.Timeout | null;
  jobProcessing: boolean;
};
const laneRuntime: Record<'normal' | 'slow', LaneRuntime> = {
  normal: { workerRunning: false, workerInterval: null, jobProcessing: false },
  slow: { workerRunning: false, workerInterval: null, jobProcessing: false },
};

// Workers/queues parity (E-F05): log the kill-switch skip once per
// OFF→ON transition per lane. The pollers fire every 15/30 s — a line
// per poll would be noise, zero lines would hide the operator stop.
const killSwitchLogged: Record<'normal' | 'slow', boolean> = {
  normal: false,
  slow: false,
};

// Stale-job recovery (workers/queues parity E-F01/E-F02): a processing
// row is stale when its lease has expired (locked_until < NOW()) — the
// owner stopped heartbeating (crash) or hit the processing ceiling (the
// heartbeat never extends past leased_at + ceiling). Legacy rows claimed
// before the lease columns existed (locked_until IS NULL) fall back to
// the old started_at test against the per-lane ceiling, so no row can
// stay locked forever across the deploy boundary or after a rollback.
// Exported for the hermetic lease/recovery suite — production callers are
// the two lane pollers below only.
export async function recoverStaleJobs(): Promise<void> {
  try {
    const capNormalSecs = Math.ceil((await getMaxProcessingMs("call_analysis")) / 1000);
    const capSlowSecs = Math.ceil((await getMaxProcessingMs("call_analysis_slow")) / 1000);
    const staleJobs = await dbRetry(() =>
      db.select().from(callAnalysisJobs)
        .where(
          and(
            eq(callAnalysisJobs.status, "processing"),
            sql`(
              (${callAnalysisJobs.lockedUntil} IS NOT NULL AND ${callAnalysisJobs.lockedUntil} < NOW())
              OR (${callAnalysisJobs.lockedUntil} IS NULL AND ${callAnalysisJobs.startedAt} < NOW() - ((CASE WHEN ${callAnalysisJobs.lane} = 'slow' THEN ${capSlowSecs} ELSE ${capNormalSecs} END) || ' seconds')::interval)
            )`
          )
        ),
      "callanalysis-recover-select"
    );

    for (const job of staleJobs) {
      const canRetry = (job.attemptCount || 0) < 2;
      const newStatus = canRetry ? "queued" : "failed";
      const budgetMinutes = Math.round((job.lane === 'slow' ? capSlowSecs : capNormalSecs) / 60);
      workerLog({
        worker: job.lane === 'slow' ? 'call_analysis_slow' : 'call_analysis',
        event: "stale_job_reset",
        jobId: job.analysisId,
        externalId: job.externalId,
        attempts: job.attemptCount ?? 0,
        detail: `stale lease -> ${newStatus}`,
      });

      await dbRetry(() =>
        db.update(callAnalysisJobs)
          .set({
            status: newStatus,
            errorMessage: canRetry ? null : `Job timed out after ${budgetMinutes} minutes (max retries exhausted)`,
            // Task #1049: stale = the worker died mid-conversion or
            // CPU was starved long enough that we couldn't finish.
            // `cpu_starved` is the right typed bucket; if a retry
            // succeeds the failure_reason is overwritten on completion.
            failureReason: canRetry ? null : 'cpu_starved',
            completedAt: canRetry ? null : new Date(),
            // Release the expired lease so the row is claimable again
            // (or carries no lock in its terminal state).
            lockedUntil: null,
            leasedAt: null,
          })
          // Epoch-guarded: if another worker already reclaimed this row
          // (attempt_count moved on), leave the new owner alone.
          .where(and(
            eq(callAnalysisJobs.analysisId, job.analysisId),
            eq(callAnalysisJobs.status, "processing"),
            sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) = ${job.attemptCount ?? 0}`,
          )),
        "callanalysis-recover-update"
      );
    }
  } catch (error) {
    console.error("[CallAnalysis] Stale job recovery error:", error);
  }
}

// Task #1049: lane-aware poller. The normal poller passes lane='normal'
// (default) and only picks up `lane='normal'` rows; the slow poller
// passes lane='slow' and only picks up `lane='slow'` rows. The two
// lanes thus share zero contention beyond the single Helium worker
// pool.
// Workers/queues parity (E-F01): atomic claim. One UPDATE with a
// FOR UPDATE SKIP LOCKED subselect (same shape as
// callArchivePipeline.claimNextCall) transitions the oldest queued row
// to processing and stamps the lease columns in a single statement —
// two instances polling concurrently can never claim the same row,
// unlike the old SELECT-then-UPDATE pair. Exported for the focused
// lease-controls suite.
export async function claimNextQueuedJob(
  lane: 'normal' | 'slow',
): Promise<typeof callAnalysisJobs.$inferSelect | undefined> {
  const claimed = await dbRetry(() =>
    db.update(callAnalysisJobs)
      .set({
        status: "processing",
        startedAt: sql`NOW()`,
        attemptCount: sql`COALESCE(${callAnalysisJobs.attemptCount}, 0) + 1`,
        leasedAt: sql`NOW()`,
        lockedUntil: sql`NOW() + interval '${sql.raw(String(CALL_ANALYSIS_LEASE_MS / 1000))} seconds'`,
      })
      .where(sql`${callAnalysisJobs.analysisId} = (
        SELECT analysis_id FROM call_analysis_jobs
        WHERE status = 'queued' AND lane = ${lane} AND COALESCE(attempt_count, 0) < 2
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`)
      .returning(),
    "callanalysis-claim"
  );
  return claimed[0];
}

export async function processNextJob(lane: 'normal' | 'slow' = 'normal'): Promise<boolean> {
  const rt = laneRuntime[lane];
  if (rt.jobProcessing) {
    return false;
  }
  rt.jobProcessing = true;
  try {
    // Workers/queues parity (E-F05): operator kill switch — checked
    // before every claim, so flipping it on stops NEW work at the next
    // poll; a job already in flight finishes normally. Logged once per
    // OFF→ON transition (not per poll).
    if (isKillSwitchEnabled("call_analysis")) {
      if (!killSwitchLogged[lane]) {
        killSwitchLogged[lane] = true;
        workerLog({
          worker: lane === 'slow' ? 'call_analysis_slow' : 'call_analysis',
          event: "kill_switch_abort",
          killSwitch: "call_analysis",
          detail: "poller paused - not claiming new jobs",
        });
      }
      return false;
    }
    killSwitchLogged[lane] = false;

    const nextJob = await claimNextQueuedJob(lane);

    if (!nextJob) {
      return false;
    }

    try {
      await runClaimedJob(nextJob);
      return true;
    } catch (error) {
      console.error(`Failed to process job ${nextJob.analysisId} (lane=${lane}):`, error);
      return true;
    }
  } finally {
    rt.jobProcessing = false;
  }
}

// Internal: shared startup for both lanes. Differs only in the lane
// filter, the worker-lock name (so each lane gets its own
// single-instance gate), the poll interval, and the worker-log label.
async function startLaneWorker(opts: {
  lane: 'normal' | 'slow';
  intervalMs: number;
  lockName: string;
  workerLabel: string;
}): Promise<void> {
  const { lane, intervalMs, lockName, workerLabel } = opts;
  const rt = laneRuntime[lane];
  if (rt.workerRunning) return;
  rt.workerRunning = true;

  const { workerLog } = await import("./workerLogger");
  workerLog({ worker: workerLabel, event: "worker_started" });

  // Stale-job recovery is shared across lanes (the SQL handles both).
  // Only the normal-lane worker triggers the periodic recovery so we
  // don't duplicate the scan on every poll.
  if (lane === 'normal') {
    // Fire-and-forget: recovery runs alongside worker startup by design.
    recoverStaleJobs().catch((err) => {
      console.error('[CallAnalysis] Stale-job recovery failed:', err);
    });
  }

  let pollCount = 0;
  let consecutiveErrors = 0;
  rt.workerInterval = setInterval(() => {
    void withDbAttribution(`worker:call-analysis-poll-${lane}`, async () => {
      const { acquireLock, releaseLock } = await import("./workerLock");
      const { WORKER_LOCK_TTL_MS, WORKER_LOCK_HEARTBEAT_MS } = await import("./workerConfig");
      if (!acquireLock(lockName, WORKER_LOCK_TTL_MS, WORKER_LOCK_HEARTBEAT_MS)) {
        return;
      }
      try {
        if (consecutiveErrors > 0) {
          const backoffPolls = Math.min(consecutiveErrors * 2, 30);
          pollCount++;
          if (pollCount % backoffPolls !== 0) return;
        }
        const { workerLog } = await import("./workerLogger");
        pollCount++;
        if (lane === 'normal' && pollCount % 12 === 0) {
          await recoverStaleJobs();
        }
        const pollStart = Date.now();
        const processed = await processNextJob(lane);
        if (processed) {
          workerLog({ worker: workerLabel, event: "worker_completed", durationMs: Date.now() - pollStart });
        }
        consecutiveErrors = 0;
      } catch (error: any) {
        consecutiveErrors++;
        const msg = error?.message || String(error);
        const { workerLog: wl } = await import("./workerLogger");
        wl({ worker: workerLabel, event: "worker_failed", error: msg.slice(0, 120) });
      } finally {
        releaseLock(lockName);
      }
    });
  }, intervalMs);
}

export async function startWorker(intervalMs = 15000) {
  await startLaneWorker({
    lane: 'normal',
    intervalMs,
    lockName: 'call_analysis_poll',
    workerLabel: 'call_analysis',
  });
}

// Task #1049: slow-lane worker. Polls less often (30 s vs 15 s) since
// these jobs are long anyway, processes one slow job at a time, and
// uses a separate worker-lock so a normal-lane poll cannot block it.
export async function startSlowLaneWorker(intervalMs = 30000) {
  await startLaneWorker({
    lane: 'slow',
    intervalMs,
    lockName: 'call_analysis_poll_slow',
    workerLabel: 'call_analysis_slow',
  });
}

export function stopWorker() {
  for (const lane of ['normal', 'slow'] as const) {
    const rt = laneRuntime[lane];
    if (rt.workerInterval) {
      clearInterval(rt.workerInterval);
      rt.workerInterval = null;
    }
    rt.workerRunning = false;
  }
  console.log("[CallAnalysis] Worker stopped (both lanes)");
}
