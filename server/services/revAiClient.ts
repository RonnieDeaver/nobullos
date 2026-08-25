// Task #3701 — shared Rev AI speech-to-text HTTP client.
//
// Extracted from atsTranscription.ts so the Zoom transcript generation
// fallback (zoomIntegration.ts) and the ATS video-submission flow drive Rev
// AI's submit/status/transcript endpoints through ONE implementation instead
// of two drifting copies. Deliberately dependency-free (no DB, no object
// storage) so importing it never pulls module side effects into callers.
import * as fs from "fs";

const REV_AI_BASE_URL = "https://api.rev.ai/speechtotext/v1";

export function getRevAiToken(): string {
  const token = process.env.REV_AI_API_TOKEN;
  if (!token) {
    throw new Error("REV_AI_API_TOKEN environment variable is not set");
  }
  return token;
}

/** Non-2xx from Rev AI, with the HTTP status preserved so callers can branch (404 = job gone). */
export class RevAiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RevAiHttpError";
  }
}

export interface RevAiJobStatusResult {
  id: string;
  /** "in_progress" | "transcribed" | "failed" per Rev AI's async job API. */
  status: string;
  failure?: string;
  failure_detail?: string;
}

/**
 * Task #3963 (audit B-012) — completion webhook registration, passed through
 * to Rev AI as the `notification_config` job option (the older top-level
 * `callback_url` parameter is deprecated; notification_config supports auth
 * headers and both URL + headers are encrypted at rest, per
 * https://docs.rev.ai/api/asynchronous/webhooks). On completion or failure
 * Rev AI POSTs `{ "job": { id, status, ... } }` to `url`, replaying
 * `authHeaders` on the request; a non-200 response is retried every 30
 * minutes for up to 24 hours.
 */
export interface RevAiNotificationConfig {
  url: string;
  /**
   * Rev AI only allows the single "Authorization" header here, with a value
   * of the form "Bearer <token>".
   */
  authHeaders?: Record<string, string>;
}

/**
 * Submits a local audio file as a new Rev AI transcription job and returns
 * the Rev AI job id. The caller owns persistence of the id — a submitted job
 * whose id is lost cannot be recovered, so persist it immediately.
 */
export async function submitRevAiJobFromFile(
  audioPath: string,
  opts: {
    filename: string;
    contentType: string;
    metadata: string;
    notificationConfig?: RevAiNotificationConfig;
  },
): Promise<string> {
  const token = getRevAiToken();
  const audioBuffer = await fs.promises.readFile(audioPath);

  const formData = new FormData();
  formData.append(
    "media",
    new Blob([audioBuffer], { type: opts.contentType }),
    opts.filename,
  );
  // Job options ride in the documented `options` multipart part as one JSON
  // blob — the format Rev AI's official SDKs use for local-file submission.
  // (The previous loose top-level `metadata` part was undocumented; metadata
  // now travels inside `options`, alongside notification_config when the
  // caller registers a completion webhook. Task #3963, audit B-012.)
  const options: Record<string, unknown> = { metadata: opts.metadata };
  if (opts.notificationConfig) {
    options.notification_config = {
      url: opts.notificationConfig.url,
      ...(opts.notificationConfig.authHeaders
        ? { auth_headers: opts.notificationConfig.authHeaders }
        : {}),
    };
  }
  formData.append("options", JSON.stringify(options));

  const response = await fetch(`${REV_AI_BASE_URL}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new RevAiHttpError(
      `Rev.ai job submission failed (${response.status}): ${errorText}`,
      response.status,
    );
  }

  const job = (await response.json()) as { id: string; status: string };
  return job.id;
}

export async function getRevAiJobStatus(
  jobId: string,
): Promise<RevAiJobStatusResult> {
  const token = getRevAiToken();
  const response = await fetch(`${REV_AI_BASE_URL}/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new RevAiHttpError(
      `Rev.ai job status check failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as RevAiJobStatusResult;
}

export async function fetchRevAiTranscriptText(jobId: string): Promise<string> {
  const token = getRevAiToken();
  const response = await fetch(`${REV_AI_BASE_URL}/jobs/${jobId}/transcript`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/plain",
    },
  });
  if (!response.ok) {
    throw new RevAiHttpError(
      `Rev.ai transcript fetch failed (${response.status})`,
      response.status,
    );
  }
  return (await response.text()).trim();
}
