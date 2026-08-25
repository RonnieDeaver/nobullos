// @db-pool-intent: ambient
/**
 * Task #2927 — ClickUp per-user OAuth integration.
 *
 * Auth flow: authorization-code grant.
 *   Authorize: https://app.clickup.com/api?client_id=…&redirect_uri=…
 *   Token:     POST https://api.clickup.com/api/v2/oauth/token
 *
 * ClickUp access tokens currently do not expire, so no refresh token flow
 * is needed. Tokens are encrypted at rest with AES-256-GCM (tokenCrypto).
 *
 * Probe rule: probes must never wipe tokens; only authoritative on-demand
 * disconnect may remove them.
 *
 * API ref reviewed 2026-07-16: developer.clickup.com/docs/authentication
 */

import crypto from "crypto";
import { getDb, withDbAttribution } from "../db";
import { resolveOsCanonicalHostname } from "./publicUrl";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";
import { clickupUserTokens, users } from "@shared/schema";
import { eq, isNull } from "drizzle-orm";
import { storage } from "../storage";

const CLICKUP_AUTH_URL = "https://app.clickup.com/api";
const CLICKUP_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SETTINGS_KEY_NONCE_PREFIX = "clickup_oauth_nonce:";

let tablesEnsured = false;

async function ensureTable(): Promise<void> {
  if (tablesEnsured) return;
  await withDbAttribution("clickupIntegration:ensureTable", async () => {
    const db = getDb();
    await db.execute(
      `CREATE TABLE IF NOT EXISTS clickup_user_tokens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL UNIQUE,
        access_token_encrypted text NOT NULL,
        clickup_user_id varchar,
        clickup_username varchar,
        clickup_email varchar,
        workspace_id varchar,
        status varchar NOT NULL DEFAULT 'connected',
        last_refresh_at timestamp,
        last_error text,
        connected_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )` as any,
    );
    await db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS clickup_user_tokens_user_id_idx ON clickup_user_tokens (user_id)` as any,
    );
    await db.execute(
      `ALTER TABLE clickup_user_tokens ADD COLUMN IF NOT EXISTS authorized_workspaces jsonb` as any,
    );
  });
  tablesEnsured = true;
}

export function __resetClickUpEnsureCacheForTests(): void {
  tablesEnsured = false;
}

function getClientId(): string {
  const v = process.env.CLICKUP_CLIENT_ID;
  if (!v) throw new Error("CLICKUP_CLIENT_ID not set — add it via Secrets.");
  return v;
}

function getClientSecret(): string {
  const v = process.env.CLICKUP_CLIENT_SECRET;
  if (!v) throw new Error("CLICKUP_CLIENT_SECRET not set — add it via Secrets.");
  return v;
}

export function isClickUpOAuthConfigured(): boolean {
  return !!(process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET);
}

/**
 * Returns the effective redirect URI for ClickUp OAuth.
 *
 * Resolution order (most-specific first):
 *   1. CLICKUP_REDIRECT_URI env var (explicit override — always wins).
 *   2. First custom domain in REPLIT_DOMAINS (excludes *.replit.app /
 *      *.repl.co so ordering in the env var cannot accidentally pick the
 *      wrong host — this is the OAUTH_017 root cause on the Reserved VM).
 *   3. First entry of REPLIT_DOMAINS (any domain, as a last resort).
 *
 * Exported so routes can include the value in status/connected-users
 * responses and surface it to admins for ClickUp app registration.
 */
export function getRedirectUri(): string {
  if (process.env.CLICKUP_REDIRECT_URI) return process.env.CLICKUP_REDIRECT_URI;
  // Task #3740: shared canonical OS host resolver — prefers reports.*, then a
  // custom non-marketing domain, so the "first custom domain" can never flip
  // to the marketing apex once nobullmarketing.com joins the domain list
  // (same class of bug as the OAUTH_017 Reserved-VM root cause).
  const domain = resolveOsCanonicalHostname();
  if (!domain)
    throw new Error("REPLIT_DOMAINS not set — cannot build ClickUp OAuth redirect URI");
  return `https://${domain}/api/integrations/clickup/callback`;
}

function getStateSigningKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(`clickup-oauth-state:${getClientSecret()}`)
    .digest();
}

function signStatePayload(payload: string): string {
  return crypto.createHmac("sha256", getStateSigningKey()).update(payload).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Authorization URL ────────────────────────────────────────────────────────

export async function getAuthorizationUrl(userId: string, returnTo?: string): Promise<string> {
  if (!userId) throw new Error("userId is required");
  const nonce = crypto.randomBytes(24).toString("hex");
  const issuedAt = Date.now();
  const payloadObj: Record<string, unknown> = { u: userId, n: nonce, t: issuedAt };
  if (returnTo) payloadObj.r = returnTo;
  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = signStatePayload(payloadB64);
  const state = `${payloadB64}.${sig}`;
  await storage.setSystemSetting(
    `${SETTINGS_KEY_NONCE_PREFIX}${userId}`,
    JSON.stringify({ nonce, issuedAt }),
    userId,
  );
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
  });
  return `${CLICKUP_AUTH_URL}?${params.toString()}&state=${encodeURIComponent(state)}`;
}

// ─── State validation ─────────────────────────────────────────────────────────

export async function validateOAuthState(
  state: string,
): Promise<{ valid: boolean; userId?: string; returnTo?: string }> {
  if (!state) return { valid: false };
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { valid: false };
  const payloadB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!constantTimeEquals(sig, signStatePayload(payloadB64))) return { valid: false };
  let parsed: { u?: string; n?: string; t?: number; r?: string };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false };
  }
  const userId = parsed?.u;
  const nonce = parsed?.n;
  const returnTo = parsed?.r;
  const issuedAt = typeof parsed?.t === "number" ? parsed.t : 0;
  if (!userId || !nonce) return { valid: false };
  if (Date.now() - issuedAt > OAUTH_STATE_TTL_MS) return { valid: false };
  return withDbAttribution("clickupOAuth:readState", async () => {
    const key = `${SETTINGS_KEY_NONCE_PREFIX}${userId}`;
    const stored = await storage.getSystemSetting(key);
    if (!stored?.value) return { valid: false };
    let storedNonce = "";
    try {
      storedNonce = (JSON.parse(stored.value) as { nonce?: string }).nonce || "";
    } catch {
      return { valid: false };
    }
    if (!constantTimeEquals(storedNonce, nonce)) return { valid: false };
    await storage.setSystemSetting(key, "", userId);
    return { valid: true, userId, returnTo };
  });
}

// ─── Code exchange ────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(userId: string, code: string): Promise<void> {
  const res = await fetch(CLICKUP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  const accessToken = json.access_token;
  if (!accessToken) throw new Error("ClickUp token exchange: no access_token in response");

  let cuUser: { id?: string; username?: string; email?: string } = {};
  let workspaceId: string | undefined;
  let authorizedWorkspaces: { id: string; name: string }[] = [];
  try {
    const [userRes, wsRes] = await Promise.all([
      fetch(`${CLICKUP_API_BASE}/user`, {
        headers: { Authorization: accessToken, "Content-Type": "application/json" },
      }),
      fetch(`${CLICKUP_API_BASE}/team`, {
        headers: { Authorization: accessToken, "Content-Type": "application/json" },
      }),
    ]);
    if (userRes.ok) {
      const u = (await userRes.json()) as { user?: { id?: string; username?: string; email?: string } };
      cuUser = u.user ?? {};
    }
    if (wsRes.ok) {
      // GET /team returns ONLY the workspaces the user checked on ClickUp's
      // authorization screen — record all of them so the UI can tell the
      // user when some of their workspaces are missing from the grant.
      const w = (await wsRes.json()) as { teams?: { id?: string; name?: string }[] };
      authorizedWorkspaces = (w.teams ?? [])
        .filter((t) => t.id)
        .map((t) => ({ id: String(t.id), name: t.name ?? "" }));
      workspaceId = authorizedWorkspaces[0]?.id;
    }
  } catch {
    // best-effort enrichment
  }

  await ensureTable();
  await withDbAttribution("clickupIntegration:storeToken", async () => {
    const db = getDb();
    await db
      .insert(clickupUserTokens)
      .values({
        userId,
        accessTokenEncrypted: encryptToken(accessToken),
        clickupUserId: cuUser.id ? String(cuUser.id) : null,
        clickupUsername: cuUser.username ?? null,
        clickupEmail: cuUser.email ?? null,
        workspaceId: workspaceId ?? null,
        authorizedWorkspaces: authorizedWorkspaces.length ? authorizedWorkspaces : null,
        status: "connected",
        lastRefreshAt: new Date(),
        lastError: null,
        connectedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: clickupUserTokens.userId,
        set: {
          accessTokenEncrypted: encryptToken(accessToken),
          clickupUserId: cuUser.id ? String(cuUser.id) : null,
          clickupUsername: cuUser.username ?? null,
          clickupEmail: cuUser.email ?? null,
          workspaceId: workspaceId ?? null,
          authorizedWorkspaces: authorizedWorkspaces.length ? authorizedWorkspaces : null,
          status: "connected",
          lastRefreshAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });
  });
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnect(userId: string): Promise<void> {
  await ensureTable();
  await withDbAttribution("clickupIntegration:disconnect", async () => {
    const db = getDb();
    await db.delete(clickupUserTokens).where(eq(clickupUserTokens.userId, userId));
  });
}

// ─── Token accessor ───────────────────────────────────────────────────────────

export async function getAccessToken(userId: string): Promise<string | null> {
  await ensureTable();
  return withDbAttribution("clickupIntegration:getToken", async () => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(clickupUserTokens)
      .where(eq(clickupUserTokens.userId, userId))
      .limit(1);
    if (!row || row.status !== "connected") return null;
    const token = decryptToken(row.accessTokenEncrypted);
    return token || null;
  });
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function getStatus(userId: string): Promise<{
  connected: boolean;
  clickupEmail: string | null;
  clickupUsername: string | null;
  workspaceId: string | null;
  authorizedWorkspaces: { id: string; name: string }[];
  status: string;
  lastError: string | null;
  redirectUri: string | null;
}> {
  await ensureTable();
  let redirectUri: string | null = null;
  try {
    redirectUri = getRedirectUri();
  } catch {
    redirectUri = null;
  }
  return withDbAttribution("clickupIntegration:getStatus", async () => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(clickupUserTokens)
      .where(eq(clickupUserTokens.userId, userId))
      .limit(1);
    if (!row) {
      return {
        connected: false,
        clickupEmail: null,
        clickupUsername: null,
        workspaceId: null,
        authorizedWorkspaces: [],
        status: "not_connected",
        lastError: null,
        redirectUri,
      };
    }
    return {
      connected: row.status === "connected",
      clickupEmail: row.clickupEmail,
      clickupUsername: row.clickupUsername,
      workspaceId: row.workspaceId,
      authorizedWorkspaces: Array.isArray(row.authorizedWorkspaces)
        ? (row.authorizedWorkspaces as { id: string; name: string }[])
        : [],
      status: row.status,
      lastError: row.lastError,
      redirectUri,
    };
  });
}

// ─── Connected users (admin overview) ─────────────────────────────────────────
// Task #3122 — per-user connection roster for the Integrations Hub.
// Read-only metadata (never tokens); joined against non-deleted users.

export interface ClickUpConnectedUser {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  clickupEmail: string | null;
  clickupUsername: string | null;
  status: string;
  connectedAt: string | null;
}

export async function getAllConnectedUsers(): Promise<{
  connectedUsers: ClickUpConnectedUser[];
  totalTeamMembers: number;
}> {
  await ensureTable();
  return withDbAttribution("clickupIntegration:getAllConnectedUsers", async () => {
    const db = getDb();
    const rows = await db
      .select({
        userId: clickupUserTokens.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        clickupEmail: clickupUserTokens.clickupEmail,
        clickupUsername: clickupUserTokens.clickupUsername,
        status: clickupUserTokens.status,
        connectedAt: clickupUserTokens.connectedAt,
      })
      .from(clickupUserTokens)
      .innerJoin(users, eq(users.id, clickupUserTokens.userId))
      .where(isNull(users.deletedAt))
      .orderBy(users.firstName, users.lastName);
    const allUsers = await storage.getAllUsers();
    return {
      connectedUsers: rows.map((r) => ({
        userId: r.userId,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        clickupEmail: r.clickupEmail,
        clickupUsername: r.clickupUsername,
        status: r.status,
        connectedAt: r.connectedAt ? r.connectedAt.toISOString() : null,
      })),
      totalTeamMembers: allUsers.length,
    };
  });
}

// ─── Probe ────────────────────────────────────────────────────────────────────
// Probes must never wipe tokens (per oauth-probe-refresh-no-wipe memory rule).

export async function probeConnection(userId: string): Promise<{
  outcome: "connected" | "unauthorized" | "probe_failed" | "not_connected";
  reason?: string;
}> {
  let token: string | null;
  try {
    token = await getAccessToken(userId);
  } catch (err: any) {
    return { outcome: "probe_failed", reason: err?.message ?? "token read threw" };
  }
  if (!token) return { outcome: "not_connected" };
  try {
    const res = await fetch(`${CLICKUP_API_BASE}/user`, {
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
    if (res.ok) return { outcome: "connected" };
    if (res.status === 401 || res.status === 403) {
      return { outcome: "unauthorized", reason: `ClickUp API returned ${res.status}` };
    }
    return { outcome: "probe_failed", reason: `ClickUp API returned ${res.status}` };
  } catch (err: any) {
    return { outcome: "probe_failed", reason: err?.message ?? "network error" };
  }
}
