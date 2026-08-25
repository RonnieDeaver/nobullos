// @db-pool-intent: ambient
// LiveKit auto-egress recording service.
//
// Responsibilities:
//   1. Create LiveKit rooms server-side with a RoomCompositeEgress config that
//      automatically records the session (MP4) to a transit S3-compatible bucket
//      as soon as the first participant joins, and stops when the room ends.
//   2. After LiveKit fires egress_ended, mirror the MP4 from the transit bucket
//      into Replit private object storage (canonical copy).
//   3. Optionally clean up the transit copy after a successful mirror.
//
// Kill switch: system_settings key "livekit_recording_enabled" (default ON).
// Transit bucket env vars (all required for recording to work):
//   LIVEKIT_RECORDING_S3_BUCKET         — bucket name
//   LIVEKIT_RECORDING_S3_ACCESS_KEY     — IAM access key id
//   LIVEKIT_RECORDING_S3_SECRET_KEY     — IAM secret access key
//   LIVEKIT_RECORDING_S3_REGION         — AWS region (default "us-east-1")
//   LIVEKIT_RECORDING_S3_ENDPOINT       — optional, for S3-compatible endpoints

import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { getSystemSetting } from "../storage/settingsStorage";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";

const objectStorage = new ObjectStorageService();

// ─── Constants ────────────────────────────────────────────────────────────────

const KILL_SWITCH_KEY = "livekit_recording_enabled";
const OFF_TOKENS = new Set(["false", "0", "off", "no"]);

/** Key in Replit private object storage for a given call's recording. */
export function getRecordingObjectKey(callId: string): string {
  return `comms_calls/${callId}/recording.mp4`;
}

/**
 * Key in the transit S3 bucket for a given room's recording.
 * This matches the filepath set in EncodedFileOutput so we can derive the S3
 * key from the room name deterministically at mirror time.
 */
export function getTransitKey(roomName: string): string {
  return `comms-recordings/${roomName}.mp4`;
}

// ─── Configuration helpers ────────────────────────────────────────────────────

/**
 * Returns true when recording is enabled (kill switch not tripped).
 * Fails open (default ON) if the system setting cannot be read.
 */
export async function isRecordingEnabled(): Promise<boolean> {
  try {
    const setting = await getSystemSetting(KILL_SWITCH_KEY);
    if (!setting || setting.value == null) return true;
    return !OFF_TOKENS.has(setting.value.trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * Returns true when all required transit-bucket env vars are present.
 */
export function isTransitBucketConfigured(): boolean {
  return !!(
    process.env.LIVEKIT_RECORDING_S3_BUCKET &&
    process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY &&
    process.env.LIVEKIT_RECORDING_S3_SECRET_KEY
  );
}

// ─── Room creation with auto-egress ──────────────────────────────────────────

export interface RoomWithRecordingResult {
  transitKey: string | null;
  status: "pending" | "not_configured" | "disabled" | "failed";
  error?: string;
}

/**
 * Creates the LiveKit room server-side with a RoomCompositeEgress config.
 * The egress auto-starts when the first participant joins and auto-stops
 * when the room finishes. Returns `status: "pending"` on success.
 *
 * Non-fatal: if recording setup fails the call can still proceed (the room
 * will be created lazily by LiveKit without recording).
 */
export async function createRoomWithRecording(params: {
  roomName: string;
}): Promise<RoomWithRecordingResult> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_SERVER_URL;

  if (!apiKey || !apiSecret || !serverUrl) {
    return { transitKey: null, status: "not_configured", error: "LiveKit credentials not set" };
  }

  const enabled = await isRecordingEnabled();
  if (!enabled) {
    return { transitKey: null, status: "disabled" };
  }

  if (!isTransitBucketConfigured()) {
    return {
      transitKey: null,
      status: "not_configured",
      error:
        "Transit S3 bucket not configured — set LIVEKIT_RECORDING_S3_BUCKET, " +
        "LIVEKIT_RECORDING_S3_ACCESS_KEY, and LIVEKIT_RECORDING_S3_SECRET_KEY.",
    };
  }

  const transitKey = getTransitKey(params.roomName);

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- livekit-server-sdk is optional; gracefully degrades
    const {
      RoomServiceClient,
      RoomEgress,
      RoomCompositeEgressRequest,
      EncodedFileOutput,
      EncodedFileType,
      S3Upload,
    } = await import("livekit-server-sdk");

    const roomClient = new RoomServiceClient(serverUrl, apiKey, apiSecret);

    const s3Bucket = process.env.LIVEKIT_RECORDING_S3_BUCKET!;
    const s3Region = process.env.LIVEKIT_RECORDING_S3_REGION || "us-east-1";
    const s3AccessKey = process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY!;
    const s3SecretKey = process.env.LIVEKIT_RECORDING_S3_SECRET_KEY!;
    const s3Endpoint = process.env.LIVEKIT_RECORDING_S3_ENDPOINT || "";

    const s3Upload = new S3Upload({
      accessKey: s3AccessKey,
      secret: s3SecretKey,
      bucket: s3Bucket,
      region: s3Region,
      ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
    });

    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: transitKey,
      output: { case: "s3", value: s3Upload },
    });

    const egressConfig = new RoomEgress({
      room: new RoomCompositeEgressRequest({
        fileOutputs: [fileOutput],
      }),
    });

    await roomClient.createRoom({
      name: params.roomName,
      emptyTimeout: 300,
      egress: egressConfig,
    });

    return { transitKey, status: "pending" };
  } catch (err: any) {
    console.error("[LiveKitRecording] createRoomWithRecording failed:", err?.message);
    return {
      transitKey,
      status: "failed",
      error: String(err?.message || err).slice(0, 256),
    };
  }
}

// ─── SigV4 signing (minimal — no AWS SDK dependency) ─────────────────────────

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function s3SignedFetchHeaders(params: {
  method: string;
  url: URL;
  region: string;
  accessKey: string;
  secretKey: string;
}): Record<string, string> {
  const now = new Date();
  // e.g. "20260718T120000Z"
  const amzDate =
    now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStr = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");

  const headers: Record<string, string> = {
    host: params.url.hostname,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaderStr = sortedKeys.join(";");

  const canonicalRequest = [
    params.method,
    params.url.pathname,
    params.url.search.slice(1),
    canonicalHeaders,
    signedHeaderStr,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStr}/${params.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${params.secretKey}`, dateStr);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers["authorization"] = [
    `AWS4-HMAC-SHA256 Credential=${params.accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaderStr}`,
    `Signature=${signature}`,
  ].join(", ");

  return headers;
}

function buildS3Url(bucket: string, key: string, region: string, endpoint: string): URL {
  if (endpoint) {
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    return new URL(`${base}${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`);
  }
  return new URL(
    `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
  );
}

// ─── Transit → Replit mirror ──────────────────────────────────────────────────

export interface MirrorResult {
  objectKey: string;
  fileSizeBytes: number | null;
}

/**
 * Downloads the recording MP4 from the transit S3 bucket and streams it
 * into Replit private object storage under a deterministic key.
 * Idempotent: re-running overwrites the existing private key.
 */
export async function mirrorRecordingFromTransit(params: {
  transitKey: string;
  callId: string;
}): Promise<MirrorResult> {
  const s3Bucket = process.env.LIVEKIT_RECORDING_S3_BUCKET!;
  const s3Region = process.env.LIVEKIT_RECORDING_S3_REGION || "us-east-1";
  const s3AccessKey = process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY!;
  const s3SecretKey = process.env.LIVEKIT_RECORDING_S3_SECRET_KEY!;
  const s3Endpoint = process.env.LIVEKIT_RECORDING_S3_ENDPOINT || "";

  const s3Url = buildS3Url(s3Bucket, params.transitKey, s3Region, s3Endpoint);
  const signedHeaders = s3SignedFetchHeaders({
    method: "GET",
    url: s3Url,
    region: s3Region,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
  });

  const response = await fetch(s3Url.toString(), { headers: signedHeaders });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`S3 GetObject failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const objectKey = getRecordingObjectKey(params.callId);
  const body = response.body;
  if (!body) throw new Error("S3 response body is empty");

  const nodeStream = Readable.fromWeb(body as any);
  const { size } = await objectStorage.streamUploadToPrivateKey(objectKey, nodeStream, "video/mp4");

  return { objectKey, fileSizeBytes: size };
}

/**
 * Deletes the recording file from the transit S3 bucket after a successful
 * mirror into Replit private storage. Best-effort: 404 is silently ignored.
 */
export async function deleteTransitObject(transitKey: string): Promise<void> {
  const s3Bucket = process.env.LIVEKIT_RECORDING_S3_BUCKET!;
  const s3Region = process.env.LIVEKIT_RECORDING_S3_REGION || "us-east-1";
  const s3AccessKey = process.env.LIVEKIT_RECORDING_S3_ACCESS_KEY!;
  const s3SecretKey = process.env.LIVEKIT_RECORDING_S3_SECRET_KEY!;
  const s3Endpoint = process.env.LIVEKIT_RECORDING_S3_ENDPOINT || "";

  const s3Url = buildS3Url(s3Bucket, transitKey, s3Region, s3Endpoint);
  const signedHeaders = s3SignedFetchHeaders({
    method: "DELETE",
    url: s3Url,
    region: s3Region,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
  });

  const response = await fetch(s3Url.toString(), {
    method: "DELETE",
    headers: signedHeaders,
  });
  if (!response.ok && response.status !== 404) {
    console.warn("[LiveKitRecording] Transit delete non-fatal error:", response.status);
  }
}
