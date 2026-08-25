/**
 * HighLevel (GHL) private-integration boundary.
 *
 * This module owns credential resolution and outbound HTTP policy only. It
 * deliberately has no authority over payments, orders, entitlements, refunds,
 * or SMS consent; downstream operational sync consumers use this adapter.
 */
import { storage } from "../storage";
import { auditedFetch } from "./externalCallAudit";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const REQUEST_TIMEOUT_MS = 10_000;

export const GHL_PRIVATE_TOKEN_SETTING_KEY = "ghl_private_integration_token";
export const GHL_LOCATION_ID_SETTING_KEY = "ghl_location_id";

type CredentialResolution =
  | { status: "found"; privateToken: string; locationId: string }
  | { status: "empty"; reason: "no_private_token" | "no_location_id" }
  | { status: "unknown"; error: string };

let lastKnownCredentials: { privateToken: string; locationId: string } | null = null;

async function resolveCredentials(): Promise<CredentialResolution> {
  try {
    const [tokenSetting, locationSetting] = await Promise.all([
      storage.getSystemSetting(GHL_PRIVATE_TOKEN_SETTING_KEY),
      storage.getSystemSetting(GHL_LOCATION_ID_SETTING_KEY),
    ]);
    const privateToken = tokenSetting?.value?.trim() ?? "";
    const locationId = locationSetting?.value?.trim() ?? "";
    if (!privateToken) {
      lastKnownCredentials = null;
      return { status: "empty", reason: "no_private_token" };
    }
    if (!locationId) {
      lastKnownCredentials = null;
      return { status: "empty", reason: "no_location_id" };
    }
    lastKnownCredentials = { privateToken, locationId };
    return { status: "found", privateToken, locationId };
  } catch (error: any) {
    // A failed settings read is not proof that an operator disconnected GHL.
    // Preserve the last positively observed pair for in-flight work.
    if (lastKnownCredentials) return { status: "found", ...lastKnownCredentials };
    return { status: "unknown", error: String(error?.message ?? "settings_read_failed").slice(0, 160) };
  }
}

export function __resetGhlCredentialsForTest(): void {
  lastKnownCredentials = null;
}

export type GhlProbeResult =
  | { outcome: "connected"; status: number }
  | { outcome: "unauthorized"; status?: number; reason: string }
  | { outcome: "probe_failed"; status?: number; reason: string };

export class GhlApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GhlApiError";
  }
}

/**
 * The sole GHL HTTP seam. It has a hard deadline, goes through the audit
 * wrapper, and never includes a request/response body in its audit context.
 */
export async function ghlApiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/")) throw new Error("GHL API paths must be relative");
  const credentials = await resolveCredentials();
  if (credentials.status === "empty") {
    throw new GhlApiError(`GHL is not configured: ${credentials.reason}`, undefined, false);
  }
  if (credentials.status === "unknown") {
    throw new GhlApiError(`GHL credential lookup failed: ${credentials.error}`, undefined, true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credentials.privateToken}`);
    headers.set("Version", GHL_API_VERSION);
    headers.set("Accept", "application/json");
    const response = await auditedFetch(
      {
        integration: "ghl",
        endpoint: path,
        method: init.method ?? "GET",
      },
      `${GHL_API_BASE}${path}`,
      { ...init, headers, signal: controller.signal },
    );
    if (!response.ok) {
      // 401/403 are terminal for a private token (including missing scopes).
      // Rate limits and server failures remain retryable for queue consumers.
      throw new GhlApiError(
        `GHL API returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      );
    }
    return response;
  } catch (error: any) {
    if (error instanceof GhlApiError) throw error;
    if (error?.name === "AbortError") {
      throw new GhlApiError("GHL request timed out", undefined, true);
    }
    throw new GhlApiError("GHL network request failed", undefined, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeConnection(): Promise<GhlProbeResult> {
  const credentials = await resolveCredentials();
  if (credentials.status === "unknown") {
    return { outcome: "probe_failed", reason: `credential_lookup_failed:${credentials.error}` };
  }
  if (credentials.status === "empty") return { outcome: "unauthorized", reason: credentials.reason };

  try {
    const response = await ghlApiRequest(`/locations/${encodeURIComponent(credentials.locationId)}`);
    return { outcome: "connected", status: response.status };
  } catch (error: any) {
    if (error instanceof GhlApiError) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        return { outcome: "unauthorized", status: error.statusCode, reason: `http_${error.statusCode}` };
      }
      return {
        outcome: "probe_failed",
        status: error.statusCode,
        reason: error.statusCode ? `http_${error.statusCode}` : error.retryable ? "network_timeout_or_error" : "probe_failed",
      };
    }
    return { outcome: "probe_failed", reason: "probe_failed" };
  }
}

export function isTerminalGhlAuthReason(reason: string | null | undefined): boolean {
  return reason === "http_401" || reason === "http_403";
}

/**
 * Persist operator-selected private-token credentials. The token is write-only:
 * callers receive no credential value, prefix, fingerprint, or derived hash.
 */
export async function setPrivateIntegrationCredentials(
  privateToken: string,
  locationId: string,
  updatedBy?: string,
): Promise<void> {
  await storage.setSystemSetting(GHL_LOCATION_ID_SETTING_KEY, locationId.trim(), updatedBy ?? "system");
  await storage.setSystemSetting(GHL_PRIVATE_TOKEN_SETTING_KEY, privateToken.trim(), updatedBy ?? "system");
  lastKnownCredentials = { privateToken: privateToken.trim(), locationId: locationId.trim() };
  try {
    await storage.recordAdminSettingChange({
      settingKey: GHL_PRIVATE_TOKEN_SETTING_KEY,
      scope: "connect",
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event: "connect", authorizationMode: "private_integration_token", locationConfigured: true },
    });
  } catch (error: any) {
    console.error("[GHL] Credential connect audit insert failed:", error?.message ?? error);
  }
}

export async function disconnect(
  updatedBy?: string,
  options?: { trigger?: "manual_disconnect" | "connect_terminal_auth_error"; reason?: string | null },
): Promise<void> {
  const trigger = options?.trigger ?? "manual_disconnect";
  await Promise.all([
    storage.setSystemSetting(GHL_PRIVATE_TOKEN_SETTING_KEY, "", updatedBy ?? "system"),
    storage.setSystemSetting(GHL_LOCATION_ID_SETTING_KEY, "", updatedBy ?? "system"),
  ]);
  lastKnownCredentials = null;
  try {
    await storage.recordAdminSettingChange({
      settingKey: GHL_PRIVATE_TOKEN_SETTING_KEY,
      scope: trigger,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event: "disconnect", trigger, reason: options?.reason ?? null },
    });
  } catch (error: any) {
    console.error("[GHL] Credential disconnect audit insert failed:", error?.message ?? error);
  }
}