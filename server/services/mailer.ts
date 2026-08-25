export type SendEmailOptions = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /**
   * Optional pre-resolved per-alert sender override (e.g. the value of
   * MATCH_SETTINGS_EMAIL_FROM or ZOOM_REVIEW_ALERT_EMAIL_FROM). When present
   * and non-empty it takes precedence over the shared sender lookup.
   */
  fromOverride?: string | null;
  timeoutMs?: number;
  logPrefix?: string;
};

export type SendEmailFailureReason =
  | "no_recipients"
  | "missing_config"
  | "http_error"
  | "exception"
  | "timeout";

export type SendEmailResult =
  | { ok: true }
  | {
      ok: false;
      reason: SendEmailFailureReason;
      status?: number;
      message?: string;
    };

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

/**
 * Resolve the sender email address using a single, consistent lookup order:
 *   1. The caller-supplied per-alert override (if non-empty)
 *   2. SENDGRID_FROM_EMAIL
 *   3. ALERT_FROM_EMAIL
 */
export function resolveSenderEmail(override?: string | null): string | undefined {
  const candidates = [override, process.env.SENDGRID_FROM_EMAIL, process.env.ALERT_FROM_EMAIL];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c;
  }
  return undefined;
}

/** True iff a SendGrid API key and some sender address are available. */
export function isMailerConfigured(override?: string | null): boolean {
  return !!process.env.SENDGRID_API_KEY && !!resolveSenderEmail(override);
}

/**
 * Send a transactional email via SendGrid. Single shared implementation used
 * by every alert service; provider-specific details (endpoint, payload shape,
 * timeout) live here so they can be swapped in one place.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const prefix = opts.logPrefix || "[mailer]";
  if (!opts.to || opts.to.length === 0) {
    return { ok: false, reason: "no_recipients" };
  }
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = resolveSenderEmail(opts.fromOverride);
  if (!apiKey || !from) {
    console.warn(
      `${prefix} Email skipped: SENDGRID_API_KEY or sender address (override / SENDGRID_FROM_EMAIL / ALERT_FROM_EMAIL) not configured`,
    );
    return { ok: false, reason: "missing_config" };
  }

  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: opts.text },
  ];
  if (opts.html) content.push({ type: "text/html", value: opts.html });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: opts.to.map((email) => ({ email })) }],
        from: { email: from },
        subject: opts.subject,
        content,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `${prefix} Email send failed: ${res.status} ${body.slice(0, 200)}`,
      );
      return {
        ok: false,
        reason: "http_error",
        status: res.status,
        message: body.slice(0, 500),
      };
    }
    return { ok: true };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error(`${prefix} Email send timed out`);
      return { ok: false, reason: "timeout" };
    }
    console.error(`${prefix} Email send error:`, err?.message || err);
    return { ok: false, reason: "exception", message: err?.message };
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-facing overflow lane (Task #4334)
//
// SendGrid's second role: overflow fallback for the outbound-email seam when
// a user's daily mailbox cap is exhausted — and ONLY when the owner-gated
// setting is enabled on a verified marketing domain (enforced by the caller,
// server/services/outboundEmail.ts). These exports live here so mailer.ts
// stays the single SendGrid adapter; the alert-path `sendEmail` above is
// deliberately untouched.
// ─────────────────────────────────────────────────────────────────────────────

function unwrapMailerErrnoCode(err: unknown): string | undefined {
  let cur: any = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

// Failures raised before any connection existed — the request provably never
// reached SendGrid, so callers may classify the send as not-attempted.
const PRE_CONNECTION_ERRNOS = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

export type MarketingSendResult =
  | { ok: true; sendgridMessageId: string | null }
  | { ok: false; reason: "missing_config" | "rejected" | "not_attempted"; status?: number; message?: string }
  /**
   * The request may have reached SendGrid (timeout mid-flight, 5xx on a
   * non-idempotent create). Callers must treat this as terminal-by-policy:
   * alert and never auto-retry (pressure case P11).
   */
  | { ok: false; reason: "unknown_outcome"; status?: number; message?: string };

export interface MarketingEmailOptions {
  to: string;
  /** Verified marketing-domain sender (resolved by the caller from settings). */
  fromEmail: string;
  subject: string;
  text: string;
  html?: string | null;
  /**
   * Signed per-recipient unsubscribe URL. Sent as RFC 8058 one-click
   * List-Unsubscribe headers; the caller also embeds it in the body footer.
   */
  unsubscribeUrl: string;
  /** outbound_emails.id — carried as custom_args for durable webhook correlation. */
  sendId: string;
  timeoutMs?: number;
}

/**
 * Send ONE client-facing email via SendGrid. Single recipient by design —
 * the outbound seam fans out per-recipient rows/jobs, and per-recipient
 * personalization is what makes suppression + correlation exact.
 */
export async function sendMarketingEmail(opts: MarketingEmailOptions): Promise<MarketingSendResult> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !opts.fromEmail) {
    return { ok: false, reason: "missing_config", message: "SENDGRID_API_KEY or sender not configured" };
  }

  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: opts.text },
  ];
  if (opts.html) content.push({ type: "text/html", value: opts.html });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: opts.to }],
            custom_args: { send_id: opts.sendId },
          },
        ],
        from: { email: opts.fromEmail },
        subject: opts.subject,
        content,
        headers: {
          "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      signal: controller.signal,
    });
    if (res.status >= 500) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: "unknown_outcome", status: res.status, message: body.slice(0, 300) };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: "rejected", status: res.status, message: body.slice(0, 500) };
    }
    return { ok: true, sendgridMessageId: res.headers.get("x-message-id") };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, reason: "unknown_outcome", message: "timed out mid-flight" };
    }
    const code = unwrapMailerErrnoCode(err);
    if (code && PRE_CONNECTION_ERRNOS.has(code)) {
      return { ok: false, reason: "not_attempted", message: `${code}` };
    }
    return { ok: false, reason: "unknown_outcome", message: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface SendgridDomainAuthStatus {
  configured: boolean;
  domainFound: boolean;
  /** SendGrid's overall judgment for the authenticated domain. */
  valid: boolean;
  spfValid: boolean;
  dkimValid: boolean;
  sendgridDomainId: number | null;
  error?: string;
}

/**
 * Fetch SendGrid's domain-authentication status for the marketing domain
 * (SPF + DKIM as judged by SendGrid's own DNS validation). DMARC is checked
 * separately by the caller via a direct DNS TXT lookup — SendGrid does not
 * own that record.
 */
export async function fetchSendgridDomainAuthStatus(domain: string): Promise<SendgridDomainAuthStatus> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const base: SendgridDomainAuthStatus = {
    configured: !!apiKey,
    domainFound: false,
    valid: false,
    spfValid: false,
    dkimValid: false,
    sendgridDomainId: null,
  };
  if (!apiKey) return { ...base, error: "SENDGRID_API_KEY not configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.sendgrid.com/v3/whitelabel/domains?domain=${encodeURIComponent(domain)}&limit=10`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ...base, error: `SendGrid domain-auth lookup failed: ${res.status} ${body.slice(0, 200)}` };
    }
    const list: any[] = await res.json().catch(() => []);
    const entry = Array.isArray(list)
      ? list.find((d) => d?.domain === domain) ?? list[0]
      : null;
    if (!entry) return base;

    // Automated-security domains validate via CNAMEs (mail_cname covers the
    // return-path/SPF alignment, dkim1/dkim2 cover DKIM); manual setups
    // expose spf/dkim records directly. Read both shapes defensively.
    const dns = entry.dns || {};
    const spfValid = dns.mail_cname?.valid === true || dns.spf?.valid === true || dns.subdomain_spf?.valid === true;
    const dkimValid =
      (dns.dkim1?.valid === true && dns.dkim2?.valid === true) || dns.dkim?.valid === true;
    return {
      configured: true,
      domainFound: true,
      valid: entry.valid === true,
      spfValid,
      dkimValid,
      sendgridDomainId: typeof entry.id === "number" ? entry.id : null,
    };
  } catch (err: any) {
    return { ...base, error: err?.name === "AbortError" ? "SendGrid domain-auth lookup timed out" : (err?.message || String(err)) };
  } finally {
    clearTimeout(timeout);
  }
}
