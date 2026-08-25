// Shared phone normalization helpers (Tasks #848 + #849).
// Single canonical form so DB lookups can be indexed; canonical match
// keys for direct (1:1) Twilio SMS thread identity.

/** Strip everything except digits. */
export function digitsOnly(phone: string): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/** Last 10 digits — canonical form for indexed lookup. Returns "" for unusable input. */
export function normalizeToTen(phone: string): string {
  const d = digitsOnly(phone);
  if (d.length === 0) return "";
  return d.slice(-10);
}

/** E.164-style normalization (best-effort, US-default for 10-digit numbers). */
export function normalizeToE164(phone: string): string {
  if (!phone) return "";
  const trimmed = phone.trim();
  const digits = digitsOnly(trimmed);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+")) return trimmed;
  return `+${digits}`;
}

/** Normalize an array of raw phone strings to canonical 10-digit form, drop blanks. */
export function normalizePhoneArray(phones: readonly (string | null | undefined)[] | null | undefined): string[] {
  if (!phones || phones.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of phones) {
    if (!p) continue;
    const norm = normalizeToTen(p);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task #849: SMS thread identity helpers
// ---------------------------------------------------------------------------

export interface NormalizedPhone {
  /** E.164 form (e.g. `+12676398995`) when confidently derivable. */
  e164?: string;
  /** Last 10 digits (set when digit count >= 10). Practical match key for US Twilio. */
  national10?: string;
  /** Stripped digits — empty only when input had no digits. */
  digits: string;
}

/**
 * Normalize a phone-like string into all the representations downstream
 * code might need. Never throws.
 */
export function normalizeSmsPhone(input: string | null | undefined): NormalizedPhone {
  const digits = digitsOnly(input ?? "");
  if (!digits) return { digits: "" };

  let national10: string | undefined;
  let e164: string | undefined;

  if (digits.length >= 10) {
    national10 = digits.slice(-10);
  }

  // Prefer explicit `+` from the original input; otherwise infer US/Canada.
  const hadPlus = typeof input === "string" && input.trim().startsWith("+");
  if (hadPlus && digits.length >= 10) {
    e164 = `+${digits}`;
  } else if (!hadPlus && digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (!hadPlus && digits.length === 11 && digits.startsWith("1")) {
    e164 = `+${digits}`;
  }

  return { digits, national10, e164 };
}

/**
 * Deterministic match key for "same number" comparisons. Last-10-digit
 * key collapses every shape we see in this app's data into one value.
 * Returns null when the input has fewer than 10 digits.
 */
export function getPhoneMatchKey(input: string | null | undefined): string | null {
  const n = normalizeSmsPhone(input);
  return n.national10 ?? null;
}

/**
 * Canonical direct-thread identity for a (contactPhone, twilioPhoneNumber)
 * pair. Format: `direct:{twilioKey}:{contactKey}`. Returns null when either
 * side cannot be matched.
 */
export function getDirectConversationKey(args: {
  contactPhone: string | null | undefined;
  twilioPhoneNumber: string | null | undefined;
}): string | null {
  const contact = getPhoneMatchKey(args.contactPhone);
  const twilio = getPhoneMatchKey(args.twilioPhoneNumber);
  if (!contact || !twilio) return null;
  return `direct:${twilio}:${contact}`;
}
