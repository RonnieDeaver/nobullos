/**
 * Privacy-masking helpers for the book operations read-model surface.
 *
 * Exported as pure functions so focused unit tests can assert privacy
 * guarantees independently of any DB query.
 *
 * Rules:
 *   - maskEmail:  keep domain; replace local-part with first char + "***".
 *   - maskName:   keep first initial; replace rest with "***".
 *   - maskPhone:  keep last 4 digits; replace leading digits with "***".
 *
 * These helpers operate on the raw server-side value and MUST be applied
 * before any field is placed in a returned model.  Raw PII (address, intake
 * answers, notes, tokens, hashes, object keys, raw payload) must never reach
 * the model at all — the queries must exclude those columns entirely.
 */

/** Mask an email address: show "x***@domain.tld". Returns null when falsy. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/** Mask a display name: show "F***". Returns null when falsy. */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  return `${name[0]}***`;
}

/**
 * Mask a phone number: keep last 4 digits, replace the rest with "***".
 * Returns null when falsy or when fewer than 4 digits are present.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}
