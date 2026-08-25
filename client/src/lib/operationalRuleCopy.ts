export type OperationalRuleCategory =
  | "automated_sender_pattern"
  | "operational_domain"
  | "operational_subject_pattern"
  | "content_spam_signal"
  | "internal_domain"
  | "internal_exact_email";

export function categoryHeaderCopy(c: OperationalRuleCategory): string {
  switch (c) {
    case "automated_sender_pattern":
      return "Emails from senders matching this pattern will be auto-dismissed as operational.";
    case "operational_domain":
      return "Emails from any sender at this domain will be auto-dismissed as operational.";
    case "operational_subject_pattern":
      return "Emails whose subject matches this pattern will be auto-dismissed as operational.";
    case "content_spam_signal":
      return "Messages containing this signal contribute to the spam score, and high-scoring messages are auto-dismissed.";
    case "internal_domain":
      return "Emails from this domain are treated as internal company mail (not auto-dismissed).";
    case "internal_exact_email":
      return "This exact address is treated as internal company mail (not auto-dismissed).";
  }
}

export function categoryEffectCopy(c: OperationalRuleCategory): string {
  switch (c) {
    case "automated_sender_pattern":
    case "operational_domain":
    case "operational_subject_pattern":
      return "Effect: auto-dismiss matching messages — they won't appear in the unmatched feed.";
    case "content_spam_signal":
      return "Effect: add to the message's spam score. Messages over the spam threshold are auto-dismissed.";
    case "internal_domain":
    case "internal_exact_email":
      return "Effect: mark matching senders as internal — they're treated as company mail, not dismissed.";
  }
}

export function categoryUsesRegex(c: OperationalRuleCategory): boolean {
  return (
    c === "automated_sender_pattern" ||
    c === "operational_subject_pattern" ||
    c === "content_spam_signal"
  );
}
