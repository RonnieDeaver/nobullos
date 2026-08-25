// Task #880: short, human-readable label for an SMS delivery failure
// shown inline on a failed/undelivered outbound bubble. Keeps the full
// Twilio code/message available in the hover tooltip — this is just
// the at-a-glance "why" so users don't have to hover to triage.
//
// Codes sourced from https://www.twilio.com/docs/api/errors. Anything
// we don't have a curated label for falls back to the Twilio-provided
// message (truncated) or a generic "Delivery failed".

const FRIENDLY_BY_CODE: Record<string, string> = {
  "21211": "Invalid number",
  "21408": "Region not enabled",
  "21610": "Recipient unsubscribed",
  "21612": "Number can't receive SMS",
  "21614": "Not a mobile number",
  "30003": "Phone unreachable",
  "30004": "Message blocked",
  "30005": "Unknown destination",
  "30006": "Landline or unreachable carrier",
  "30007": "Carrier filtered as spam",
  "30008": "Unknown delivery error",
  "30034": "Number not registered (10DLC)",
  "30410": "Provider timeout",
};

export function friendlySmsFailureReason(
  errorCode?: string | number | null,
  errorMessage?: string | null,
): string {
  const codeKey = errorCode == null ? "" : String(errorCode);
  const mapped = codeKey ? FRIENDLY_BY_CODE[codeKey] : undefined;
  if (mapped) return mapped;
  const msg = (errorMessage || "").trim();
  if (msg) return msg.length > 60 ? `${msg.slice(0, 57)}…` : msg;
  return "Delivery failed";
}
