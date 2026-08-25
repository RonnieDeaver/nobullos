// @cross-instance-safe: refreshes an in-memory rate-limit multiplier cache from system_settings; per-instance read, no shared write.
import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getAuth } from "@clerk/express";
import { createDefaultOpenAiClient } from "../services/ai/openAiClient";
import multer from "multer";
import { createRateLimitHandler, registerLimiterConfig, trackRequest, getDynamicMax, isIPBlocked, trackUserUsage } from "../services/rateLimitMonitor";
import { WEBHOOK_PATHS, isDedicatedBucketWriteRoute } from "./limiterMounts";
import { withDbAttribution } from "../db";
import { CEO_PULSE_IMAGE_MAX_BYTES } from "@shared/schema";

type Role = 'ceo' | 'team_lead' | 'account_manager';

export const DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS: Record<string, number> = {
  ceo: 3,
  team_lead: 2,
  account_manager: 1.5,
};

const HARDCODED_MULTIPLIERS = DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS;

export let ROLE_RATE_LIMIT_MULTIPLIERS: Record<string, number> = { ...DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS };

const DEFAULT_RATE_LIMIT_MULTIPLIER = 1;
const RATE_LIMIT_MULTIPLIERS_KEY = "rate_limit_multipliers";

let cachedMultipliers: Record<string, number> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

export async function getEffectiveMultipliers(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedMultipliers && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMultipliers;
  }
  try {
    const setting = await storage.getSystemSetting(RATE_LIMIT_MULTIPLIERS_KEY);
    if (setting?.value) {
      const parsed = JSON.parse(setting.value);
      if (typeof parsed === "object" && parsed !== null) {
        cachedMultipliers = { ...DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS, ...parsed };
        cacheTimestamp = now;
        return cachedMultipliers!;
      }
    }
  } catch {
  }
  cachedMultipliers = { ...DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS };
  cacheTimestamp = now;
  return cachedMultipliers;
}

export function invalidateMultipliersCache() {
  cachedMultipliers = null;
  cacheTimestamp = 0;
}

function parseMultipliers(raw: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const num = Number(v);
      if (!isFinite(num) || num <= 0) return null;
      result[k] = num;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function multipliersEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export async function loadRateLimitMultipliers(options: { silent?: boolean } = {}): Promise<void> {
  let source = "hardcoded defaults";
  let multipliers: Record<string, number> = { ...HARDCODED_MULTIPLIERS };

  const envVal = process.env.RATE_LIMIT_MULTIPLIERS;
  if (envVal) {
    const parsed = parseMultipliers(envVal);
    if (parsed) {
      multipliers = parsed;
      source = "environment variable RATE_LIMIT_MULTIPLIERS";
    } else {
      console.warn("[RateLimit] Invalid RATE_LIMIT_MULTIPLIERS env var, ignoring");
    }
  }

  try {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    const dbSetting = await getSystemSetting("rate_limit_multipliers");
    if (dbSetting?.value) {
      const parsed = parseMultipliers(dbSetting.value);
      if (parsed) {
        multipliers = parsed;
        source = "database system_settings (key: rate_limit_multipliers)";
      } else {
        console.warn("[RateLimit] Invalid rate_limit_multipliers in database, ignoring");
      }
    }
  } catch (err) {
    console.warn("[RateLimit] Could not read multipliers from database, using fallback:", err);
  }

  const previous = ROLE_RATE_LIMIT_MULTIPLIERS;
  const changed = !multipliersEqual(previous, multipliers);
  ROLE_RATE_LIMIT_MULTIPLIERS = multipliers;
  invalidateMultipliersCache();

  if (changed) {
    console.log(
      `[RateLimit] Multipliers changed (source: ${source}): ${JSON.stringify(previous)} -> ${JSON.stringify(multipliers)}`
    );
  } else if (!options.silent) {
    console.log(`[RateLimit] Active multipliers (source: ${source}):`, JSON.stringify(ROLE_RATE_LIMIT_MULTIPLIERS));
  }
}

let multipliersRefreshInterval: NodeJS.Timeout | null = null;
const MULTIPLIERS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function startRateLimitMultipliersRefresh(intervalMs: number = MULTIPLIERS_REFRESH_INTERVAL_MS): void {
  if (multipliersRefreshInterval) return;
  multipliersRefreshInterval = setInterval(() => {
    void withDbAttribution("scheduler:rate-limit-multipliers-refresh", () =>
      loadRateLimitMultipliers({ silent: true }).catch((err) => {
        console.warn("[RateLimit] Periodic multiplier refresh failed:", err);
      }),
    );
  }, intervalMs);
  if (typeof multipliersRefreshInterval.unref === "function") {
    multipliersRefreshInterval.unref();
  }
  console.log(`[RateLimit] Started periodic multipliers refresh every ${Math.round(intervalMs / 1000)}s`);
}

export function stopRateLimitMultipliersRefresh(): void {
  if (multipliersRefreshInterval) {
    clearInterval(multipliersRefreshInterval);
    multipliersRefreshInterval = null;
  }
}

export async function resolveUserRoleMultiplier(req: Request): Promise<number> {
  const role = await resolveUserRole(req);
  const multipliers = await getEffectiveMultipliers();
  return (role && multipliers[role]) || DEFAULT_RATE_LIMIT_MULTIPLIER;
}

async function resolveUserRole(req: Request): Promise<string | null> {
  const reqAny = req as any;
  if (reqAny._rateLimitRole !== undefined) return reqAny._rateLimitRole;

  // Task #4789 — Clerk-first identity resolution: clerkMiddleware runs before
  // limiters so getAuth() resolves the session at limiter time. requireAuth
  // (which populates req.user) runs AFTER limiters, so reading req.user here
  // caused everyone to fall through to the IP bucket post-Clerk cutover.
  let userId: string | null = null;
  try {
    const auth = getAuth(req);
    userId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId || null;
  } catch {
    // getAuth throws when clerkMiddleware is not mounted (e.g. isolated route tests).
  }
  // Legacy / test-seam fallback: req.user is set by requireAuth for routes that
  // run the auth middleware; also covers route tests that set req.user directly.
  if (!userId) {
    userId = (reqAny.user?.claims?.sub as string | undefined) ?? null;
  }

  if (!userId) {
    reqAny._rateLimitRole = null;
    return null;
  }

  try {
    const user = await storage.getUser(userId);
    reqAny._rateLimitRole = user?.role ?? null;
  } catch {
    reqAny._rateLimitRole = null;
  }
  return reqAny._rateLimitRole;
}

// Task #4683 — dev-environment headroom multiplier. Rapid navigation across
// internal report/CEO pages (fast tab-switching, authed QA sweeps) trips the
// production-sized budgets in development and surfaces false red
// "Too many requests" toasts that mask real failures during QA. Development
// gets 10x headroom on every role-aware bucket (api, adminRead, admin, write,
// sensitiveWrite, upload, ai, commsWrite, sheetsAutosave, background_polling)
// via the single roleAwareMax seam. Gated strictly on NODE_ENV === "development"
// so production abuse protection is untouched and tests (NODE_ENV=test) keep
// asserting the exact production maxes. Tunable via DEV_RATE_LIMIT_MULTIPLIER
// (clamped 1..1000); non-role-aware limiters (auth, webhook, shareFile) are
// deliberately excluded — they are IP-keyed abuse surfaces, not toast sources.
export function computeDevEnvRateLimitMultiplier(env: {
  NODE_ENV?: string;
  DEV_RATE_LIMIT_MULTIPLIER?: string;
}): number {
  if (env.NODE_ENV !== "development") return 1;
  const raw = env.DEV_RATE_LIMIT_MULTIPLIER;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n;
    console.warn(
      `[RateLimit] Invalid DEV_RATE_LIMIT_MULTIPLIER "${raw}" (must be 1..1000), using default 10`,
    );
  }
  return 10;
}

const DEV_ENV_RATE_LIMIT_MULTIPLIER = computeDevEnvRateLimitMultiplier({
  NODE_ENV: process.env.NODE_ENV,
  DEV_RATE_LIMIT_MULTIPLIER: process.env.DEV_RATE_LIMIT_MULTIPLIER,
});

export function roleAwareMax(baseMax: number | (() => number)) {
  return async (req: Request): Promise<number> => {
    const role = await resolveUserRole(req);
    const multipliers = await getEffectiveMultipliers();
    const multiplier =
      (role && multipliers[role]) || DEFAULT_RATE_LIMIT_MULTIPLIER;
    const resolvedMax = typeof baseMax === "function" ? baseMax() : baseMax;
    return Math.ceil(resolvedMax * multiplier * DEV_ENV_RATE_LIMIT_MULTIPLIER);
  };
}

const ROLE_LEVELS: Record<Role, number> = {
  'ceo': 3,
  'team_lead': 2,
  'account_manager': 1,
};

export function hasRole(userRole: string | null | undefined, requiredRole: Role): boolean {
  if (!userRole) return false;
  const userLevel = ROLE_LEVELS[userRole as Role] || 0;
  const requiredLevel = ROLE_LEVELS[requiredRole];
  return userLevel >= requiredLevel;
}

function requireRole(role: Role) {
  return async (req: any, res: Response, next: NextFunction) => {
    if (!req.user?.claims?.sub) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const user = await storage.getUser(req.user.claims.sub);
      if (!user || !hasRole(user.role, role)) {
        return res.status(403).json({ error: `${role} access required` });
      }
      (req as any).dbUser = user;
      next();
    } catch (err) {
      console.error("[Auth] Role check error:", err);
      res.status(500).json({ error: "Server error" });
    }
  };
}

export const requireCeo = requireRole('ceo');
export const requireTeamLead = requireRole('team_lead');
export const requireAccountManager = requireRole('account_manager');

import nodeCrypto from "node:crypto";

const CEO_TOOLS_TOKEN = process.env.CEO_TOOLS_API_TOKEN;

/**
 * Audit A-005 — length-safe constant-time token comparison.
 * `crypto.timingSafeEqual` throws on unequal-length buffers, so both inputs
 * are first reduced to fixed-length SHA-256 digests; the digest comparison
 * is then constant-time regardless of input lengths and never throws. The
 * result leaks nothing about whether a mismatch came from length or content.
 */
function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = nodeCrypto.createHash("sha256").update(provided, "utf8").digest();
  const b = nodeCrypto.createHash("sha256").update(expected, "utf8").digest();
  return nodeCrypto.timingSafeEqual(a, b);
}

export const requireCeoToolsAuth = (req: any, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  
  const token = authHeader.substring(7);
  // A-005: constant-time comparison; blank/missing tokens and a missing
  // server-side configuration all fail through the same 403 contract.
  if (!CEO_TOOLS_TOKEN || !token || !timingSafeTokenEqual(token, CEO_TOOLS_TOKEN)) {
    return res.status(403).json({ error: "Invalid API token" });
  }
  
  next();
};

export async function requireTwilioAccess(req: any, res: Response, next: NextFunction) {
  if (!req.user?.claims?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = await storage.getUser(req.user.claims.sub);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    (req as any).dbUser = user;

    const role = user.role;
    const isSales = role === 'sales';
    const isAccountManager = role === 'account_manager';
    const isTeamLeadPlus = hasRole(role, 'team_lead');

    if (isSales) {
      if (req.method !== 'GET') {
        return res.status(403).json({ error: "Sales role has read-only access" });
      }
    } else if (!isAccountManager && !isTeamLeadPlus) {
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  } catch (err) {
    console.error("[Twilio] Auth error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export function userKeyGenerator(req: Request): string {
  // Task #4789 — Clerk-first: clerkMiddleware is mounted before limiters so
  // getAuth() works here. requireAuth (which populates req.user) runs AFTER
  // limiters, so req.user?.claims?.sub is always empty at limiter time in
  // production — causing the entire staff to share one IP bucket post-cutover.
  try {
    const auth = getAuth(req);
    const clerkId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
    if (clerkId) return `user:${clerkId}`;
  } catch {
    // getAuth throws when clerkMiddleware is not mounted (isolated route tests).
  }
  // Legacy / test-seam fallback: req.user.claims.sub is set by requireAuth for
  // downstream handlers, and by route-test harnesses that call requireAuth
  // before a downstream limiter invocation.
  const legacyId = (req as any).user?.claims?.sub as string | undefined;
  if (legacyId) return `user:${legacyId}`;
  return ipKeyGenerator(req.ip!);
}

export async function requireCommandCenterAccess(req: any, res: Response, next: NextFunction) {
  if (!req.user?.claims?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = await storage.getUser(req.user.claims.sub);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    (req as any).dbUser = user;

    const clientId = req.params.clientId;
    const client = await storage.getClient(clientId);
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }
    (req as any).client = client;

    const role = user.role;
    const isSales = role === 'sales';
    const isAccountManager = role === 'account_manager';
    const isTeamLeadPlus = hasRole(role, 'team_lead');

    if (isSales) {
      if (req.method !== 'GET') {
        return res.status(403).json({ error: "Sales role has read-only access" });
      }
    } else if (!isAccountManager && !isTeamLeadPlus) {
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  } catch (err) {
    console.error("[CommandCenter] Auth error:", err);
    res.status(500).json({ error: "Server error" });
  }
}


registerLimiterConfig("ai", 15 * 60 * 1000, 20);
const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("ai")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many AI requests, please try again later." },
  handler: createRateLimitHandler("ai"),
});
export const aiLimiter = [createRequestTracker("ai"), aiRateLimiter];

registerLimiterConfig("webhook", 15 * 60 * 1000, 300, false);
export const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => getDynamicMax("webhook"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many webhook requests." },
  handler: createRateLimitHandler("webhook"),
});

registerLimiterConfig("write", 15 * 60 * 1000, 60);
export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("write")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many write requests, please try again later." },
  // Task #944B: webhook traffic (Twilio, Stripe, Front, Zoom) must not be
  // counted against the user-facing write limiter. Twilio's edge IP is
  // shared across many of our calls/SMS, so a busy hour can exhaust the
  // 60-per-15-min cap and 429 the next voice webhook — which makes the
  // recipient hear Twilio's default "an application error has occurred"
  // prompt mid-call. Webhook traffic is already gated by `webhookLimiter`
  // mounted on the per-prefix path in `server/index.ts`.
  // Task #4788: mutations that ride a DEDICATED bucket (commsWrite,
  // sheetsAutosave, background_polling) must not ALSO drain this shared
  // budget. Before this skip, the comms presence heartbeat (POST every 25 s
  // per open tab) plus typing (~every 2 s while composing) and sheets/docs
  // autosave (~every 30 s) double-counted here, exhausted the 60/15 min
  // bucket, and unrelated saves (e.g. Weekly Availability on /profile)
  // got 429 "Too many write requests" for up to 15 minutes. The
  // exemption <-> dedicated-limiter pairing is enforced by
  // tests/rate-limit-coverage.test.ts.
  skip: (req) =>
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS" ||
    WEBHOOK_PATHS.some((p) => req.originalUrl.startsWith(p)) ||
    isDedicatedBucketWriteRoute(req.method, req.originalUrl),
  handler: createRateLimitHandler("write"),
});

registerLimiterConfig("upload", 15 * 60 * 1000, 20);
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("upload")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many upload requests, please try again later." },
  handler: createRateLimitHandler("upload"),
});

// Task #3853 — app.use(path, limiter) mounts have no HTTP-method filter, so
// the strict admin (30/15min) and sensitiveWrite (15/15min) budgets were also
// consumed by sibling GETs under the same prefixes (verified live:
// GET /api/admin/notifications reported RateLimit-Limit: 15). Frequently
// polled admin dashboards could starve themselves with read traffic. These
// limiters exist to throttle privileged MUTATIONS; reads under the same
// prefixes stay governed by apiLimiter (and adminReadLimiter where mounted).
const skipReadOnlyMethods = (req: Request) =>
  req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";

registerLimiterConfig("admin", 15 * 60 * 1000, 30);
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("admin")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many admin requests, please try again later." },
  // Task #3853 — mutations only; admin GETs must not consume the 30-req budget.
  skip: skipReadOnlyMethods,
  handler: createRateLimitHandler("admin"),
});

// Task #3829 — read-heavy admin-classified surfaces (Ads OS dashboards,
// Service Desk mixed staff/CEO prefixes). adminLimiter's 30-req budget would
// break UIs that fire 10+ GETs per page load, so these get a roomier bucket;
// their mutations remain throttled by writeLimiter/sensitiveWriteLimiter.
registerLimiterConfig("adminRead", 15 * 60 * 1000, 300);
export const adminReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("adminRead")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many requests, please try again later." },
  handler: createRateLimitHandler("adminRead"),
});

registerLimiterConfig("sensitiveWrite", 15 * 60 * 1000, 15);
export const sensitiveWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("sensitiveWrite")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many requests to this endpoint, please try again later." },
  // Task #3853 — mutations only; sibling GETs under SENSITIVE_WRITE_PATHS
  // prefixes must not consume the 15-req budget.
  skip: skipReadOnlyMethods,
  handler: createRateLimitHandler("sensitiveWrite"),
});

// Comms write traffic: per-user limiter for high-frequency mutation paths
// (send, edit, delete, react, typing). A tighter 1-minute window stops
// runaway clients without blocking normal real-time usage (typing fires
// every ~2 s when actively composing). Role multipliers still apply.
registerLimiterConfig("commsWrite", 60 * 1000, 60);
export const commsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("commsWrite")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many comms requests, please slow down." },
  handler: createRateLimitHandler("commsWrite"),
});

// Sheets autosave traffic: background-style classification with a higher
// per-15-min ceiling than interactive writes (200 vs 60), reflecting that
// autosave fires every ~30 s from the editor and should not exhaust the
// shared writeLimiter bucket. Role multipliers still apply so editors with
// elevated roles get proportionally more headroom.
registerLimiterConfig("sheetsAutosave", 15 * 60 * 1000, 200);
export const sheetsAutosaveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("sheetsAutosave")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many autosave requests, please wait a moment." },
  handler: createRateLimitHandler("sheetsAutosave"),
});

// Task #4041 — public token-gated share-link downloads (/share/file/:token)
// are the only unauthenticated client-file surface. IP-keyed (no session
// exists there, so express-rate-limit's default IP key applies) and no role
// multipliers. 60 downloads per 15 min per IP is generous for a human
// recipient while stopping hot-linked files and scripted token scanners from
// consuming bandwidth/DB work freely.
registerLimiterConfig("shareFile", 15 * 60 * 1000, 60, false);
export const shareFileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => getDynamicMax("shareFile"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many download requests, please try again later." },
  handler: createRateLimitHandler("shareFile"),
});

export function createRequestTracker(
  category: string,
  options: { mutatingOnly?: boolean } = {},
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Task #3853 — categories whose limiter skips read-only methods must not
    // track those methods either, or usage stats/auto-tune would over-count.
    if (options.mutatingOnly && skipReadOnlyMethods(req)) {
      return next();
    }
    trackRequest(category);
    const userId = (req as any).user?.claims?.sub || null;
    if (userId) {
      try {
        const multiplier = await resolveUserRoleMultiplier(req);
        trackUserUsage(category, userId, multiplier);
      } catch {
        trackUserUsage(category, userId, 1);
      }
    }
    next();
  };
}

export function ipBlockMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (isIPBlocked(ip)) {
    res.status(403).json({ error: "Your IP has been blocked." });
    return;
  }
  next();
}

export { WEBHOOK_PATHS } from "./limiterMounts";

// Audit Track B (Task #1572): explicitly pin `maxRetries` (SDK default is 2,
// but make it intentional so 429/5xx are retried predictably) and `timeout`
// (no SDK default — without this a stalled OpenAI request could hold a worker
// indefinitely). 60 s covers the slowest chat-completion site (CEO Pulse
// refine) without hiding genuine outages.
export const openai = createDefaultOpenAiClient({
  maxRetries: 3,
  timeout: 60_000,
});

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

export const jdUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
    }
  }
});

const SHEETS_IMPORT_ALLOWED_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls (legacy)
  'text/csv',
  'text/plain', // some systems send .csv as text/plain
  'application/csv',
  'application/octet-stream', // fallback for renamed/ambiguous files
]);

const SHEETS_IMPORT_ALLOWED_EXTENSIONS = /\.(xlsx|xls|csv|tsv)$/i;

export const sheetsImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const byMime = SHEETS_IMPORT_ALLOWED_MIMETYPES.has(file.mimetype);
    const byExt = SHEETS_IMPORT_ALLOWED_EXTENSIONS.test(file.originalname);
    if (byMime || byExt) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx, .xls, .csv, and .tsv files are allowed for import'));
    }
  },
});

// NoBull Docs (.docx) import — Task #4024, mirrors sheetsImportUpload.
const DOCS_IMPORT_ALLOWED_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/octet-stream', // fallback for renamed/ambiguous files
]);

const DOCS_IMPORT_ALLOWED_EXTENSIONS = /\.docx$/i;

export const docsImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const byMime = DOCS_IMPORT_ALLOWED_MIMETYPES.has(file.mimetype);
    const byExt = DOCS_IMPORT_ALLOWED_EXTENSIONS.test(file.originalname);
    // .docx must ALSO pass the extension check when the mimetype is the
    // generic fallback — octet-stream alone shouldn't admit arbitrary files.
    if (byExt || (byMime && file.mimetype !== 'application/octet-stream')) {
      cb(null, true);
    } else {
      cb(new Error('Only .docx files are allowed for import'));
    }
  },
});

// NoBull Brief supporting images (Task #4293). The mimetype filter here is
// advisory UX only — the route decides by magic-byte sniffing
// (sniffUploadFormat) and derives the stored extension from the SNIFFED
// format, never from the client mimetype or filename. Size cap comes from
// the shared constant so the Studio UI and tests stay in lockstep.
const PULSE_IMAGE_ALLOWED_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/octet-stream', // renamed/ambiguous files — magic bytes decide
]);

export const pulseImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CEO_PULSE_IMAGE_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (PULSE_IMAGE_ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});
