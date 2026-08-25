// Google service-account auth — Sheets lane only.
//
// Task #4084 (audits/drive-least-privilege-migration-plan.md, end-state D
// taken to full retirement): the Google Drive integration — folder pickers,
// sync worker, Zoom recording mirror, call-archive Drive phase, bulk Drive
// import, and the service-account key management UI — has been removed.
// Pipeline artifacts are delivered exclusively to in-app client files
// (server/services/clientFileDelivery.ts) backed by object storage.
//
// What survives here is the read-only Google Sheets token lane used by the
// Ads OS client-log reader (Task #2958/#3646): minting a service-account
// access token for `spreadsheets.readonly`.
//
// Task #4118: the legacy fallback lanes (GOOGLE_SERVICE_ACCOUNT_KEY env var
// and google_service_account_key DB setting) have been removed. Only
// GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY is used.

/**
 * Low-level helper: sign a service-account JWT and exchange it for an access
 * token.
 */
async function mintServiceAccountToken(creds: any, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const crypto = await import("crypto");

  const encodeBase64Url = (data: string) =>
    Buffer.from(data).toString("base64url");

  const headerB64 = encodeBase64Url(JSON.stringify(header));
  const payloadB64 = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(creds.private_key, "base64url");

  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as any;
  return data.access_token;
}

/**
 * Access token scoped to Google Sheets (read-only) — the Ads OS client-log
 * reader lane (Task #2958).
 *
 * Requires `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` to be set. Throws when the
 * secret is absent or contains invalid JSON.
 */
export async function getSheetsAccessToken(): Promise<string> {
  const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
  const sheetsEnvKey = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY;
  if (!sheetsEnvKey) {
    throw new Error(
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY is not set — cannot mint a Sheets access token",
    );
  }
  let creds: any;
  try {
    creds = JSON.parse(sheetsEnvKey);
  } catch {
    throw new Error(
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY environment variable contains invalid JSON",
    );
  }
  return mintServiceAccountToken(creds, SHEETS_SCOPE);
}

/**
 * Task #4107 — mint an access token scoped to the Cloud IAM API using the
 * GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY credential (the dedicated Sheets SA).
 * Used by the CEO prod-action that deletes the legacy SA key in Google Cloud.
 * Throws when the secret is not set or contains invalid JSON.
 */
export async function getIamAccessTokenFromSheetsKey(): Promise<string> {
  const IAM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
  const sheetsEnvKey = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY;
  if (!sheetsEnvKey) {
    throw new Error(
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY is not set — cannot mint an IAM token",
    );
  }
  let creds: any;
  try {
    creds = JSON.parse(sheetsEnvKey);
  } catch {
    throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY contains invalid JSON");
  }
  return mintServiceAccountToken(creds, IAM_SCOPE);
}

/**
 * Task #3646 — the service-account email each client's log Google Sheet must
 * be shared with (view-only) for the AI summary reader. Derived at runtime
 * from `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY`. Never throws — returns null when
 * nothing usable is configured, so callers stay resilient.
 */
export function getSheetsServiceAccountEmail(): string | null {
  const sheetsEnvKey = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY;
  if (!sheetsEnvKey) return null;
  try {
    const creds = JSON.parse(sheetsEnvKey);
    return (creds?.client_email as string | undefined) || null;
  } catch {
    return null;
  }
}
