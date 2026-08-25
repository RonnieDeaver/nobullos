// Task #862: parse the formatted error string produced by the server's
// `describeTwilioError` helper (server/services/twilioErrors.ts) back into
// structured fields so the UI can render the Twilio code + a "Learn more"
// link instead of an opaque string. Format produced by the server:
//
//   [HTTP {status} / Twilio code {code}] {message} ({moreInfo})
//
// Any of the bracketed prefix, the moreInfo suffix, or both may be absent
// for non-Twilio errors. Falls back to `{ message }` so the caller can
// still render a useful toast.

export interface ParsedTwilioError {
  message: string;
  status?: number;
  code?: number;
  moreInfo?: string;
}

const PREFIX_RE = /^\[([^\]]+)\]\s+/;
const STATUS_RE = /HTTP\s+(\d+)/i;
const CODE_RE = /Twilio code\s+(\d+)/i;

export function parseTwilioError(raw: string | null | undefined): ParsedTwilioError {
  const text = (raw ?? "").toString();
  if (!text) return { message: "Unknown error" };

  let rest = text;
  let status: number | undefined;
  let code: number | undefined;

  const prefixMatch = rest.match(PREFIX_RE);
  if (prefixMatch) {
    const inner = prefixMatch[1];
    const s = inner.match(STATUS_RE);
    const c = inner.match(CODE_RE);
    if (s) status = Number(s[1]);
    if (c) code = Number(c[1]);
    rest = rest.slice(prefixMatch[0].length);
  }

  let moreInfo: string | undefined;
  const moreInfoMatch = rest.match(/\s+\((https?:\/\/[^\s)]+)\)\s*$/);
  if (moreInfoMatch) {
    moreInfo = moreInfoMatch[1];
    rest = rest.slice(0, moreInfoMatch.index!).trimEnd();
  }

  return {
    message: rest.trim() || text,
    status,
    code,
    moreInfo,
  };
}
