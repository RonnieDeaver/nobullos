import * as fs from "fs";
import type { RouteEntry } from "./route-inventory";

export type OutcomeClassification =
  | "PASS"
  | "FAIL_PRODUCT"
  | "FAIL_AUTH"
  | "FAIL_ENV"
  | "FAIL_FIXTURE"
  | "FAIL_EXTERNAL"
  | "NOT_IMPLEMENTED"
  | "SKIPPED";

export interface TestResult {
  route: string;
  method: string;
  persona: string;
  requestSummary: string;
  expectedStatus: number | number[];
  actualStatus: number;
  expectedShape?: string;
  actualShape?: string;
  outcome: OutcomeClassification;
  durationMs: number;
  error?: string;
  responseBody?: any;
  timestamp: string;
}

export interface Persona {
  name: string;
  role: "ceo" | "team_lead" | "account_manager" | "sales" | "anonymous";
  authMethod: "cookie" | "bearer" | "api_key" | "none";
  cookie?: string;
  token?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
}

export interface TestHarnessConfig {
  baseUrl: string;
  personas: Persona[];
  defaultTimeoutMs: number;
  captureResponseBody: boolean;
  maxBodyCaptureLength: number;
}

const DEFAULT_CONFIG: TestHarnessConfig = {
  baseUrl: process.env.TEST_BASE_URL || "http://localhost:5000",
  personas: [],
  defaultTimeoutMs: 10000,
  captureResponseBody: true,
  maxBodyCaptureLength: 2000,
};

export class TestHarness {
  private config: TestHarnessConfig;
  private results: TestResult[] = [];

  constructor(config?: Partial<TestHarnessConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getResults(): TestResult[] {
    return [...this.results];
  }

  clearResults(): void {
    this.results = [];
  }

  async request(opts: {
    method: string;
    path: string;
    persona?: Persona;
    body?: any;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    timeoutMs?: number;
    contentType?: string;
    rawBody?: Buffer;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: any;
    rawBody: string;
    durationMs: number;
  }> {
    const url = new URL(opts.path, this.config.baseUrl);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = { ...opts.headers };

    if (opts.persona) {
      if (opts.persona.authMethod === "cookie" && opts.persona.cookie) {
        headers["Cookie"] = opts.persona.cookie;
      } else if (opts.persona.authMethod === "bearer" && opts.persona.token) {
        headers["Authorization"] = `Bearer ${opts.persona.token}`;
      } else if (opts.persona.authMethod === "api_key" && opts.persona.apiKeyValue) {
        const headerName = opts.persona.apiKeyHeader || "Authorization";
        headers[headerName] = headerName === "Authorization"
          ? `Bearer ${opts.persona.apiKeyValue}`
          : opts.persona.apiKeyValue;
      }
    }

    if (opts.body && !opts.rawBody) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = opts.contentType || "application/json";
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs || this.config.defaultTimeoutMs
    );

    const startTime = Date.now();
    try {
      const fetchOpts: RequestInit = {
        method: opts.method,
        headers,
        signal: controller.signal,
      };

      if (opts.rawBody) {
        fetchOpts.body = opts.rawBody;
      } else if (opts.body) {
        fetchOpts.body =
          typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      }

      const response = await fetch(url.toString(), fetchOpts);
      const durationMs = Date.now() - startTime;

      const rawBody = await response.text();
      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      return { status: response.status, headers: responseHeaders, body, rawBody, durationMs };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (err.name === "AbortError") {
        return {
          status: 0,
          headers: {},
          body: { error: "Request timed out" },
          rawBody: "",
          durationMs,
        };
      }
      return {
        status: 0,
        headers: {},
        body: { error: err.message },
        rawBody: "",
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async testRoute(opts: {
    route: RouteEntry;
    persona: Persona;
    body?: any;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    expectedStatus: number | number[];
    expectedShape?: string;
    description?: string;
    rawBody?: Buffer;
    contentType?: string;
  }): Promise<TestResult> {
    const response = await this.request({
      method: opts.route.method,
      path: opts.route.path,
      persona: opts.persona,
      body: opts.body,
      query: opts.query,
      headers: opts.headers,
      rawBody: opts.rawBody,
      contentType: opts.contentType,
    });

    const expectedStatuses = Array.isArray(opts.expectedStatus)
      ? opts.expectedStatus
      : [opts.expectedStatus];
    const statusMatch = expectedStatuses.includes(response.status);

    let shapeMatch = true;
    let actualShape = typeof response.body;
    if (opts.expectedShape) {
      shapeMatch = matchShape(response.body, opts.expectedShape);
      actualShape = describeShape(response.body);
    }

    const outcome = classifyOutcome({
      statusMatch,
      shapeMatch,
      status: response.status,
      body: response.body,
      route: opts.route,
      persona: opts.persona,
    });

    const result: TestResult = {
      route: opts.route.path,
      method: opts.route.method,
      persona: opts.persona.name,
      requestSummary:
        opts.description ||
        `${opts.route.method} ${opts.route.path} as ${opts.persona.name}`,
      expectedStatus: opts.expectedStatus,
      actualStatus: response.status,
      expectedShape: opts.expectedShape,
      actualShape,
      outcome,
      durationMs: response.durationMs,
      timestamp: new Date().toISOString(),
    };

    if (this.config.captureResponseBody) {
      const bodyStr =
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
      result.responseBody =
        bodyStr.length > this.config.maxBodyCaptureLength
          ? bodyStr.substring(0, this.config.maxBodyCaptureLength) + "...[truncated]"
          : response.body;
    }

    if (!statusMatch || !shapeMatch) {
      result.error = !statusMatch
        ? `Expected status ${JSON.stringify(opts.expectedStatus)}, got ${response.status}`
        : `Shape mismatch: expected ${opts.expectedShape}, got ${actualShape}`;
    }

    this.results.push(result);
    return result;
  }

  async testAuthGuard(opts: {
    route: RouteEntry;
    authorizedPersona: Persona;
    unauthorizedPersona: Persona;
    body?: any;
    query?: Record<string, string>;
  }): Promise<TestResult[]> {
    const results: TestResult[] = [];

    const unauthedResult = await this.testRoute({
      route: opts.route,
      persona: opts.unauthorizedPersona,
      body: opts.body,
      query: opts.query,
      expectedStatus: [401, 403],
      description: `Auth guard: ${opts.route.method} ${opts.route.path} as ${opts.unauthorizedPersona.name} (should be denied)`,
    });
    results.push(unauthedResult);

    const authedResult = await this.testRoute({
      route: opts.route,
      persona: opts.authorizedPersona,
      body: opts.body,
      query: opts.query,
      expectedStatus: [200, 201, 204, 404, 422],
      description: `Auth guard: ${opts.route.method} ${opts.route.path} as ${opts.authorizedPersona.name} (should be allowed)`,
    });
    results.push(authedResult);

    return results;
  }

  generateReport(): string {
    const lines: string[] = [];
    lines.push("# API Test Report");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total tests: ${this.results.length}`);
    lines.push("");

    const byCls = new Map<OutcomeClassification, number>();
    for (const r of this.results) {
      byCls.set(r.outcome, (byCls.get(r.outcome) || 0) + 1);
    }

    lines.push("## Outcome Summary");
    lines.push("");
    lines.push("| Outcome | Count |");
    lines.push("|---|---|");
    for (const [cls, count] of byCls) {
      lines.push(`| ${cls} | ${count} |`);
    }
    lines.push("");

    const failures = this.results.filter((r) => r.outcome.startsWith("FAIL"));
    if (failures.length > 0) {
      lines.push("## Failures");
      lines.push("");
      lines.push(
        "| # | Method | Path | Persona | Expected | Actual | Outcome | Error |"
      );
      lines.push("|---|---|---|---|---|---|---|---|");
      failures.forEach((r, i) => {
        lines.push(
          `| ${i + 1} | ${r.method} | ${r.route} | ${r.persona} | ${JSON.stringify(r.expectedStatus)} | ${r.actualStatus} | ${r.outcome} | ${r.error || ""} |`
        );
      });
      lines.push("");
    }

    lines.push("## All Results");
    lines.push("");
    lines.push(
      "| # | Method | Path | Persona | Expected | Actual | Outcome | Duration |"
    );
    lines.push("|---|---|---|---|---|---|---|---|");
    this.results.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${r.method} | ${r.route} | ${r.persona} | ${JSON.stringify(r.expectedStatus)} | ${r.actualStatus} | ${r.outcome} | ${r.durationMs}ms |`
      );
    });

    return lines.join("\n");
  }

  exportResults(filePath: string): void {
    fs.writeFileSync(filePath, JSON.stringify(this.results, null, 2));
  }

  exportReport(filePath: string): void {
    fs.writeFileSync(filePath, this.generateReport());
  }
}

function matchShape(body: any, expectedShape: string): boolean {
  if (expectedShape === "array") return Array.isArray(body);
  if (expectedShape === "object")
    return typeof body === "object" && body !== null && !Array.isArray(body);
  if (expectedShape === "string") return typeof body === "string";
  if (expectedShape === "number") return typeof body === "number";
  if (expectedShape === "null") return body === null;

  if (expectedShape.startsWith("{") && expectedShape.endsWith("}")) {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return false;
    try {
      const requiredKeys = expectedShape
        .slice(1, -1)
        .split(",")
        .map((k) => k.trim());
      return requiredKeys.every((k) => k in body);
    } catch {
      return false;
    }
  }

  return true;
}

function describeShape(body: any): string {
  if (body === null) return "null";
  if (body === undefined) return "undefined";
  if (Array.isArray(body)) return `array(${body.length})`;
  if (typeof body === "object") {
    const keys = Object.keys(body).slice(0, 10);
    return `object{${keys.join(",")}}`;
  }
  return typeof body;
}

function classifyOutcome(ctx: {
  statusMatch: boolean;
  shapeMatch: boolean;
  status: number;
  body: any;
  route: RouteEntry;
  persona: Persona;
}): OutcomeClassification {
  if (ctx.status === 0) return "FAIL_ENV";

  if (ctx.statusMatch && ctx.shapeMatch) return "PASS";

  if (ctx.status === 401 || ctx.status === 403) {
    return "FAIL_AUTH";
  }

  if (ctx.status === 501) return "NOT_IMPLEMENTED";

  if (ctx.status === 502 || ctx.status === 503 || ctx.status === 504) {
    return "FAIL_EXTERNAL";
  }

  if (ctx.status === 404) {
    const bodyStr =
      typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body || "");
    if (
      bodyStr.includes("not found") ||
      bodyStr.includes("Not found") ||
      bodyStr.includes("Client not found")
    ) {
      return "FAIL_FIXTURE";
    }
  }

  if (ctx.status === 500) {
    const bodyStr =
      typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body || "");
    if (
      bodyStr.includes("ECONNREFUSED") ||
      bodyStr.includes("connection") ||
      bodyStr.includes("timeout")
    ) {
      return "FAIL_ENV";
    }
    if (
      bodyStr.includes("API") ||
      bodyStr.includes("external") ||
      bodyStr.includes("Twilio") ||
      bodyStr.includes("Stripe") ||
      bodyStr.includes("PandaDoc") ||
      bodyStr.includes("Semrush") ||
      bodyStr.includes("Front") ||
      bodyStr.includes("Zoom") ||
      bodyStr.includes("Google")
    ) {
      return "FAIL_EXTERNAL";
    }
  }

  return "FAIL_PRODUCT";
}

export function createAnonymousPersona(): Persona {
  return {
    name: "anonymous",
    role: "anonymous",
    authMethod: "none",
  };
}

export function createBearerPersona(
  name: string,
  token: string,
  role: "ceo" | "team_lead" | "account_manager" | "sales" = "ceo"
): Persona {
  return {
    name,
    role,
    authMethod: "bearer",
    token,
  };
}

export function createCookiePersona(
  name: string,
  cookie: string,
  role: "ceo" | "team_lead" | "account_manager" | "sales"
): Persona {
  return {
    name,
    role,
    authMethod: "cookie",
    cookie,
  };
}

export function substitutePathParams(
  routePath: string,
  params: Record<string, string>
): string {
  let result = routePath;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, value);
  }
  return result;
}

export interface MultipartField {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

export function buildMultipartBody(fields: MultipartField[]): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----TestHarnessBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  for (const field of fields) {
    let header = `--${boundary}\r\n`;
    if (field.filename) {
      header += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
      header += `Content-Type: ${field.contentType || "application/octet-stream"}\r\n`;
    } else {
      header += `Content-Disposition: form-data; name="${field.name}"\r\n`;
    }
    header += "\r\n";

    parts.push(Buffer.from(header));
    parts.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value));
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function createApiKeyPersona(
  name: string,
  apiKey: string,
  opts?: { headerName?: string; role?: "ceo" | "team_lead" | "account_manager" | "sales" }
): Persona {
  return {
    name,
    role: opts?.role || "ceo",
    authMethod: "api_key",
    apiKeyHeader: opts?.headerName || "Authorization",
    apiKeyValue: apiKey,
  };
}
