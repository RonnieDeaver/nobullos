// @db-pool-intent: ambient
//
// Task #2368 — BigQuery access for the RIS auto-pull.
//
// This module is the only place that talks to BigQuery. It is built to be
// dormant by default: the BigQuery dataset/tables do not exist yet and the
// service-account credentials may not be configured, so every entry point
// degrades gracefully (isBigQueryConfigured() returns false, query calls
// throw a typed BigQueryUnavailableError) rather than crashing the server.
//
// Credentials are read from the environment and never hardcoded:
//   * BIGQUERY_SERVICE_ACCOUNT_JSON — secret. The full Google Cloud service
//     account key JSON (the object with client_email / private_key / etc).
//     Passed to the client via `credentials` (NOT keyFilename — there is no
//     file on disk).
//   * BIGQUERY_PROJECT_ID — the GCP project to bill/run the query against.
//     Falls back to project_id inside the key JSON when omitted.
//   * BIGQUERY_LOCATION — optional default job location (e.g. "US", "EU").
//
// Docs reviewed (per replit.md public-API rule):
//   * Client constructor with explicit credentials —
//     https://cloud.google.com/nodejs/docs/reference/bigquery/latest/bigquery/bigquery
//     (`new BigQuery({ projectId, credentials })`).
//   * Parameterized queries with named params —
//     https://cloud.google.com/bigquery/docs/parameterized-queries
//     (`bigquery.query({ query, params, types, location })`; `@name`
//     placeholders; `types` needed to type a NULL param).

import type { RisAutoSourceMapping } from "@shared/schema";

// Lazily-required so the dependency never loads (or errors) on a server
// that has no BigQuery work to do.
type BigQueryCtor = new (opts: any) => any;

export class BigQueryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigQueryUnavailableError";
  }
}

export class BigQueryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigQueryQueryError";
  }
}

interface ParsedCredentials {
  credentials: Record<string, unknown>;
  projectId: string | undefined;
}

/** Parse + validate the service-account JSON from the environment. Returns
 *  null when the secret is absent or unparseable (the dormant case). */
function readCredentials(): ParsedCredentials | null {
  const raw = process.env.BIGQUERY_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed secret is a configuration error, not a transient one —
    // surface it loudly so an operator notices, but never throw at import.
    console.warn(
      "[ris:bigquery] BIGQUERY_SERVICE_ACCOUNT_JSON is set but is not valid JSON",
    );
    return null;
  }
  const projectId =
    process.env.BIGQUERY_PROJECT_ID?.trim() ||
    (typeof parsed.project_id === "string" ? parsed.project_id : undefined);
  return { credentials: parsed, projectId };
}

/** True only when a usable service-account credential is present. Cheap —
 *  used by callers to decide between "pull" and "degrade to needs_review". */
export function isBigQueryConfigured(): boolean {
  return readCredentials() !== null;
}

let cachedClient: any = null;
let cachedClientKey: string | null = null;

async function getClient(creds: ParsedCredentials): Promise<any> {
  // Re-create the client if the credential/project changed (e.g. a secret
  // rotation between ticks); otherwise reuse the cached instance.
  const key = `${creds.projectId ?? ""}:${
    (creds.credentials.client_email as string) ?? ""
  }`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  let BigQuery: BigQueryCtor;
  try {
    ({ BigQuery } = await import("@google-cloud/bigquery"));
  } catch (err: any) {
    throw new BigQueryUnavailableError(
      `@google-cloud/bigquery is not installed: ${err?.message ?? err}`,
    );
  }
  cachedClient = new BigQuery({
    projectId: creds.projectId,
    credentials: creds.credentials,
  });
  cachedClientKey = key;
  return cachedClient;
}

export interface AutoSourceQueryParams {
  clientId: string;
  locationId: string | null;
  periodStart: string; // 'YYYY-MM-DD' inclusive
  periodEnd: string; // 'YYYY-MM-DD' exclusive
  // Task #2485 — per-client BigQuery binding. Both are nullable and bound as
  // STRING named params so a template may reference `@clientKey` /
  // `@filterValue` even when unset (a NULL STRING). The caller is responsible
  // for degrading a template that *requires* `@clientKey` to needs_review when
  // the client has no key — see templateNeedsClientKey in risRuleResolution.
  clientKey?: string | null;
  filterValue?: string | null;
}

export interface AutoSourceQueryResult {
  /** The single result row, or null when the query returned no rows. */
  row: Record<string, unknown> | null;
}

/**
 * Execute a mapping's SQL template against BigQuery and return the first
 * row. Throws BigQueryUnavailableError when credentials are missing (the
 * caller maps that to needs_review without alarm) and BigQueryQueryError
 * for an actual query failure. NEVER call this inside a DB hold — it is a
 * remote HTTP round-trip.
 */
export async function runAutoSourceQuery(
  mapping: Pick<RisAutoSourceMapping, "sqlTemplate" | "bqLocation">,
  params: AutoSourceQueryParams,
): Promise<AutoSourceQueryResult> {
  const creds = readCredentials();
  if (!creds) {
    throw new BigQueryUnavailableError(
      "BigQuery service-account credentials are not configured",
    );
  }
  const sql = (mapping.sqlTemplate ?? "").trim();
  if (!sql) {
    throw new BigQueryUnavailableError("Mapping has no SQL template");
  }
  const client = await getClient(creds);
  const location =
    mapping.bqLocation?.trim() || process.env.BIGQUERY_LOCATION?.trim() || undefined;
  try {
    const [rows] = await client.query({
      query: sql,
      params: {
        clientId: params.clientId,
        locationId: params.locationId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        // Task #2485 — per-client binding params. Null when unset.
        clientKey: params.clientKey ?? null,
        filterValue: params.filterValue ?? null,
      },
      // A NULL param has no inferable type — tell BigQuery it's a STRING so
      // `@locationId` / `@clientKey` / `@filterValue` are valid even when the
      // value is null (non-location checks, unset client key / filter).
      types: {
        clientId: "STRING",
        locationId: "STRING",
        periodStart: "STRING",
        periodEnd: "STRING",
        clientKey: "STRING",
        filterValue: "STRING",
      },
      location,
    });
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return { row };
  } catch (err: any) {
    throw new BigQueryQueryError(err?.message ?? String(err));
  }
}

/** Test seam: drop the cached client (e.g. after a credential change). */
export function __resetBigQueryClientForTests(): void {
  cachedClient = null;
  cachedClientKey = null;
}
