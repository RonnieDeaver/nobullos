/**
 * Task #994 — Secret redaction for notification delivery history.
 *
 * Anything written to `notification_deliveries.error_message` or
 * `payload_preview` flows through here so we never persist API keys, OAuth
 * tokens, Slack bot tokens, Authorization headers, webhook signatures, or raw
 * credential error bodies.
 */

type RedactionReplacement = string | ((match: string, ...groups: string[]) => string);

interface RedactionPattern {
  regex: RegExp;
  replacement: RedactionReplacement;
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  // Slack bot/user tokens (xoxb-*, xoxp-*, xapp-*, xoxa-*).
  { regex: /xox[baposr]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  // OpenAI API keys.
  { regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_OPENAI_KEY]" },
  // Generic Bearer tokens.
  { regex: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [REDACTED]" },
  // Basic auth headers.
  { regex: /Basic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: "Basic [REDACTED]" },
  // Authorization header values when serialized as JSON.
  { regex: /"authorization"\s*:\s*"[^"]+"/gi, replacement: '"authorization":"[REDACTED]"' },
  // Generic api_key / api-key / apikey / secret / password values.
  {
    regex: /("?(?:api[_-]?key|secret|password|token|x-[a-z-]+-signature)"?\s*[:=]\s*)("[^"]+"|'[^']+'|[A-Za-z0-9._~+/=-]{6,})/gi,
    replacement: (_match: string, key: string) => `${key}"[REDACTED]"`,
  },
  // Twilio account SIDs + auth tokens.
  { regex: /AC[a-f0-9]{32}/g, replacement: "[REDACTED_TWILIO_SID]" },
  { regex: /SK[a-f0-9]{32}/g, replacement: "[REDACTED_TWILIO_KEY]" },
  // PandaDoc API keys (typically `API-Key XXXX`).
  { regex: /API-Key\s+[A-Za-z0-9-]{8,}/gi, replacement: "API-Key [REDACTED]" },
];

const MAX_PREVIEW_LEN = 500;
const MAX_ERROR_LEN = 1000;

function applyPatterns(input: string): string {
  let out = input;
  for (const { regex, replacement } of REDACTION_PATTERNS) {
    out =
      typeof replacement === "function"
        ? out.replace(regex, replacement)
        : out.replace(regex, replacement);
  }
  return out;
}

export function redactString(input: string | null | undefined, max = MAX_ERROR_LEN): string | null {
  if (input == null) return null;
  const s = String(input);
  if (!s) return null;
  const redacted = applyPatterns(s);
  return redacted.length > max ? redacted.slice(0, max - 1) + "…" : redacted;
}

/** Stringify + redact a payload for storage in `payload_preview`. */
export function redactPayloadPreview(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  let str: string;
  try {
    str = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    str = "[unserializable]";
  }
  if (!str) return null;
  return redactString(str, MAX_PREVIEW_LEN);
}
