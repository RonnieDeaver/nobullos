import { z } from "zod";

export const RECAPTCHA_SITE_KEY_ENV = "RECAPTCHA_SITE_KEY";
export const RECAPTCHA_SECRET_KEY_ENV = "RECAPTCHA_SECRET_KEY";
export const RECAPTCHA_VERIFY_URL =
  "https://www.google.com/recaptcha/api/siteverify";
export const RECAPTCHA_VERIFY_TIMEOUT_MS = 4_500;

const RECAPTCHA_KEY_MAX = 500;
const RECAPTCHA_TOKEN_MAX = 2_048;
const RECAPTCHA_RESPONSE_MAX_BYTES = 16_384;

const recaptchaResponseSchema = z
  .object({
    success: z.boolean(),
    hostname: z.string().trim().max(253).optional(),
    "error-codes": z.array(z.string().max(100)).max(20).optional(),
  })
  .passthrough();

export type RecaptchaFailureReason =
  | "missing_token"
  | "misconfigured"
  | "invalid_or_expired"
  | "hostname_mismatch"
  | "timeout"
  | "verification_unavailable";

export type RecaptchaVerificationResult =
  | { ok: true }
  | { ok: false; reason: RecaptchaFailureReason };

export interface RecaptchaVerifyDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  getSiteKey: () => string | null;
  getSecretKey: () => string | null;
}

function normalizedEnvValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? "";
  if (!value || value.length > RECAPTCHA_KEY_MAX) return null;
  return value;
}

export function getPublicRecaptchaSiteKey(): string | null {
  return normalizedEnvValue(RECAPTCHA_SITE_KEY_ENV);
}

const defaultVerifyDeps: RecaptchaVerifyDeps = {
  fetchImpl: fetch,
  timeoutMs: RECAPTCHA_VERIFY_TIMEOUT_MS,
  getSiteKey: getPublicRecaptchaSiteKey,
  getSecretKey: () => normalizedEnvValue(RECAPTCHA_SECRET_KEY_ENV),
};

function normalizeHostname(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\.$/, "");
}

export async function verifyRecaptchaToken(
  args: {
    token: string;
    remoteIp?: string | null;
    expectedHostnames: readonly string[];
  },
  overrides: Partial<RecaptchaVerifyDeps> = {},
): Promise<RecaptchaVerificationResult> {
  const deps: RecaptchaVerifyDeps = { ...defaultVerifyDeps, ...overrides };
  const token = args.token.trim();
  if (!token || token.length > RECAPTCHA_TOKEN_MAX) {
    return { ok: false, reason: "missing_token" };
  }

  const siteKey = deps.getSiteKey();
  const secretKey = deps.getSecretKey();
  if (!siteKey || !secretKey) {
    return { ok: false, reason: "misconfigured" };
  }

  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
  });
  if (args.remoteIp?.trim()) body.set("remoteip", args.remoteIp.trim());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await deps.fetchImpl(RECAPTCHA_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: "verification_unavailable" };
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RECAPTCHA_RESPONSE_MAX_BYTES) {
      return { ok: false, reason: "verification_unavailable" };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { ok: false, reason: "verification_unavailable" };
    }
    const parsed = recaptchaResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { ok: false, reason: "verification_unavailable" };
    }
    if (!parsed.data.success) {
      const errorCodes = new Set(parsed.data["error-codes"] ?? []);
      if (
        errorCodes.has("missing-input-secret") ||
        errorCodes.has("invalid-input-secret")
      ) {
        return { ok: false, reason: "misconfigured" };
      }
      return { ok: false, reason: "invalid_or_expired" };
    }

    const expectedHostnames = new Set(
      args.expectedHostnames
        .slice(0, 32)
        .map(normalizeHostname)
        .filter(Boolean),
    );
    const verifiedHostname = normalizeHostname(parsed.data.hostname);
    if (
      expectedHostnames.size === 0 ||
      !verifiedHostname ||
      !expectedHostnames.has(verifiedHostname)
    ) {
      return { ok: false, reason: "hostname_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "verification_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}