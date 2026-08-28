/**
 * Company-token adapter for the canonical Client List lifecycle mirror.
 * Tests replace this whole boundary; callers never reach fetch directly.
 */
import { clickUpCompanyRawRequest } from "./clickUpClient";
import { resolveClickUpCompanyToken } from "./clickUpCompanyToken";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";
import { auditOutboundCall, isAuditEnabled } from "./externalCallAudit";

export const clientIdentityMarker = (clientId: string): string =>
  `[NoBull Client ID: ${clientId}]`;

export interface RemoteClientParent {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  listId: string;
  parentId: string | null;
}

export class ClientMirrorVendorError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "rate_limited" | "timeout" | "vendor_5xx" | "vendor_4xx",
    readonly ambiguous = false,
  ) { super(message); }
}

async function request(method: string, path: string, body?: unknown) {
  const { token } = await resolveClickUpCompanyToken();
  if (!token) throw new ClientMirrorVendorError("ClickUp company token is not configured", "auth");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const doFetch = () => clickUpCompanyRawRequest({
      token, method, path, body, signal: controller.signal,
    });
    const response = isAuditEnabled()
      ? await auditOutboundCall({
          integration: "clickup",
          endpoint: path,
          method: method.toUpperCase(),
        }, async () => {
          const value = await doFetch();
          return { value, statusCode: value.status };
        })
      : await doFetch();
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "auth"
        : response.status === 429 ? "rate_limited"
        : response.status >= 500 ? "vendor_5xx" : "vendor_4xx";
      throw new ClientMirrorVendorError(
        `ClickUp ${method} failed (${response.status}): ${response.text.slice(0, 300)}`,
        code,
        method !== "GET" && (response.status >= 500 || response.status === 429),
      );
    }
    return response.text ? JSON.parse(response.text) : {};
  } catch (error) {
    if (error instanceof ClientMirrorVendorError) throw error;
    throw new ClientMirrorVendorError(
      error instanceof Error ? error.message : "ClickUp request timed out",
      "timeout",
      method !== "GET",
    );
  } finally {
    clearTimeout(timer);
  }
}

function parent(raw: any): RemoteClientParent {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    description: String(raw.markdown_description ?? raw.description ?? ""),
    archived: raw.archived === true,
    listId: String(raw.list?.id ?? raw.list_id ?? ""),
    parentId: raw.parent == null ? null : String(raw.parent),
  };
}

/** Fresh bounded pagination. Never uses the directory cache. */
export async function findParentsByMarker(clientId: string): Promise<RemoteClientParent[]> {
  const marker = clientIdentityMarker(clientId);
  const matches: RemoteClientParent[] = [];
  for (let page = 0; page < 100; page++) {
    const data = await request(
      "GET",
      `/list/${CANONICAL_PRODUCTION_LIST_ID}/task?page=${page}&archived=true&include_closed=true&subtasks=false&include_markdown_description=true`,
    );
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    for (const raw of tasks) {
      const row = parent(raw);
      if (!row.parentId && row.description.includes(marker)) matches.push(row);
    }
    if (data.last_page === true || tasks.length === 0) return matches;
  }
  throw new ClientMirrorVendorError("Canonical Client List pagination exceeded 100 pages", "vendor_4xx");
}

export async function getClientParent(taskId: string): Promise<RemoteClientParent> {
  return parent(await request("GET", `/task/${encodeURIComponent(taskId)}?include_markdown_description=true`));
}

export async function createClientParent(clientId: string, name: string): Promise<RemoteClientParent> {
  return parent(await request("POST", `/list/${CANONICAL_PRODUCTION_LIST_ID}/task`, {
    name,
    markdown_description: clientIdentityMarker(clientId),
  }));
}

export async function updateClientParent(
  taskId: string,
  patch: { name?: string; archived?: boolean },
): Promise<void> {
  await request("PUT", `/task/${encodeURIComponent(taskId)}`, patch);
}
