// @db-pool-intent: api
import type { Express, Response } from "express";
import { getAuth } from "@clerk/express";
import type { AuthenticatedRequest, ValidatedBodyRequest } from "./requestContext";
  import { storage } from "../storage";
  import { db, getDb, withDbAttribution } from "../db";
  import { sql, eq, and, inArray, desc } from "drizzle-orm";
  import { isAuthenticated } from "../middlewares/requireAuth";
  import { hasRole, requireCeo, requireTeamLead, requireAccountManager, openai, aiLimiter, upload, pulseImageUpload } from "./middleware";
  import { maskReportPayloadForPrivacy } from "../services/reportPrivacyMasking";
  // Task #4293 — supporting images for update briefs: object ops + URL/
  // placeholder helpers (chart-family patterns) and the magic-byte sniffer
  // that decides upload acceptance (mimetype/filename never do).
  import {
    ceoPulseImageObjects,
    getCeoPulseImageUrl,
    resolveImagePlaceholders,
  } from "../services/ceoPulseSupportingImages";
  import {
    sniffUploadFormat,
    UPLOAD_SNIFF_HEAD_BYTES,
  } from "../replit_integrations/object_storage/uploadContentVerification";
import {
  SEASONAL_TRENDS_AI_SECTION_KEY,
  readStoredSeasonalTrendAiAnalysis,
} from "../services/practiceAreaTrendAnalysis";
// Task #4273 — per-slide verdict sentences (audit §8.1-1). Same
// finalize-time AI cache pattern as the seasonal block above: internal
// report_sections row, stripped from served sections, surfaced as the
// `slideVerdicts` payload map; anonymous paths never reach OpenAI.
import {
  SLIDE_VERDICTS_SECTION_KEY,
  readStoredSlideVerdicts,
  buildSlideVerdictContext,
  generateSlideVerdicts,
} from "../services/slideVerdicts";
import {
  SLIDE_VERDICT_KEYS,
  SLIDE_VERDICT_LABELS,
  findDegenerateVerdict,
  verdictProblemLabel,
  sanitizeSlideVerdictMap,
  slideVerdictsSectionSchema,
  type SlideVerdictKey,
} from "@shared/slideVerdicts";
  import { QUALITY_MODEL } from "../aiModels";
  import { getPresentationMonth } from "./helpers";
  import { sanitizePromptInput } from "../services/atsTypes";
  import { parseReportPdf, resolveCommonIssuesOnReimport, isPlaceholderOnlyCommonIssues } from "../services/pdfImportParser";
  // Task #3770 — serve-time structure normalization for Common Issues rows
  // stored as a single-line marker wall of text (poisoned before the repair
  // action runs).
  import { finalizeCommonIssuesForStorage, normalizeCommonIssuesStructure } from "../services/commonIssuesFormatter";
  import { BROKEN_SOURCE_WARNING_KEY, unflagWarnedFunnelMetrics } from "../services/reportImportWarnings";
  // Task #4467/#4509 — internal bookkeeping keys stripped from EVERY section
  // of the public payloads (share/preview + demo twin). The strip list +
  // helper live in ONE leaf module; the stamp-key guard test enforces that
  // every exported stamp-key constant under server/services is covered.
  import { stripInternalSectionBookkeepingKeys } from "../services/reportPublicInternalKeys";
  import {
    JUNE_LEAD_REPARSE_STAMP_KEY,
    JUNE_LEAD_REPARSE_OUTCOME_KEY,
  } from "../services/juneLeadReparse";
import { buildImportedSectionNoDataFlags } from "../services/importWritePolicy";
  import crypto from "crypto";
  import { generateAndStoreChartImages, resolveChartPlaceholders, checkAvailableChartImages } from "../services/chartImageGenerator";
  import { evaluateChartTargeting, buildTargetingMessage } from "../services/chartTargeting";
  import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
  import { resolveEffectiveProducts } from "../utils/productResolution";
  import { applyActiveProductsFilter, aggregateActiveLeadQuality } from "../../shared/marketingWriteBoundary";
  import { readGbpLeadQuality } from "../../shared/activeProductsHeadline";
import { applyHideOtherLeads, clampMissedCallRate, resolveMissedCallRate } from "../../shared/missedCallRate";
import { createLifetimeCaseAccumulator, addReportCasesToLifetime, getLifetimeCaseCoverage } from "../lib/lifetimeCases";
import { buildIntakeTrendEntry, buildSalesTrendEntry, type IntakeTrendEntry, type SalesTrendEntry } from "../lib/reportTrendEntries";
// Task #4216 — CEO Pulse "Product updates" block: live product-roadmap read
// through the single public projection (published rows, public fields only).
import { buildReportProductUpdates } from "../lib/publicRoadmap";
import { hasGenuineConsultBookingData, sumMissedCallBucketInputs } from "@shared/reportMetrics";
  import { getActiveProductsForClient, logResolution } from "../services/activeProducts";
  import {
    insertCeoPulseSchema,
    updateCeoPulseSchema,
    updateCeoPulseImagesSchema,
    CEO_PULSE_IMAGE_MAX_COUNT,
    CEO_PULSE_IMAGE_MAX_BYTES,
    CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS,
    CEO_PULSE_UPDATE_MAX_INITIATIVES,
    CEO_PULSE_UPDATE_MAX_COMMITMENTS,
    CEO_PULSE_UPDATE_STATUS_MAX_CHARS,
    CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS,
    CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS,
    CEO_PULSE_UPDATE_WHY_MAX_BULLETS,
    CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS,
    CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS,
    CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS,
    insertReportSchema,
    updateReportSchema,
    reportPresentedUpdateSchema,
    intakeSectionSchema,
    salesSectionSchema,
    marketingSectionSchema,
    nextActionsSectionSchema,
    NEXT_ACTION_OWNER_MAX_CHARS,
    NEXT_ACTION_DUE_MAX_CHARS,
    reports,
    reportSections,
    reportSectionHistory,
    webhookImportLogs,
  } from "@shared/schema";
import { matchCommandPanelLocation } from "@shared/gbpLocationMatch";
// F5 (audit R-03) — the ONLY sanctioned narrowing point for reports JSONB
// reads. Raw report_sections.data / ceo_pulses.ai_analysis values must flow
// through these named accessors instead of bare `as any` casts.
import {
  readIntakeSection,
  readOptionalIntakeSection,
  readSalesSection,
  readOptionalSalesSection,
  readMarketingSection,
  readOptionalMarketingSection,
  readSectionDataObject,
  readOptionalSectionDataObject,
  readCeoPulseAiAnalysis,
  readCeoPulseSupportingImages,
  type IntakeSectionRead,
  type SalesSectionRead,
  type MarketingSectionRead,
  type StoredGbpLocation,
  type StoredLeadQualityCounts,
  type ReportSectionDataObject,
} from "../lib/reportJsonbAccessors";
// Task #4197 — side-effect import installs the malformed-boundary operator
// alert listener (leaf-alert-sink pattern, mirrors routes/ats.ts).
import "../services/reportJsonbCorruptionAlerts";
import { checkLifetimeLeadMismatch } from "../services/lifetimeLeadMismatchAlerts";
  
  const FUNNEL_CHART_TYPES = new Set(["funnel"]);
  const SERIES_CHART_TYPES = new Set(["stacked_bar", "stackedBar", "grouped_bar", "groupedBar"]);
  const DATA_OPTIONAL_TYPES = new Set(["gauge", "metric", "metric_cards", "kpi"]);

  function validateCeoPulseChart(c: any): any | null {
    if (!c || !c.type || !c.title) return null;

    // A "caption" is not a real chart field — fold it into the rendered
    // "subtitle" line so caption requests actually appear beneath the chart
    // instead of being silently dropped.
    if (c.caption && !c.subtitle) {
      const { caption, ...rest } = c;
      c = { ...rest, subtitle: String(caption) };
    } else if (c.caption) {
      const { caption, ...rest } = c;
      c = rest;
    }

    if (FUNNEL_CHART_TYPES.has(c.type)) {
      if (!c.groups || !Array.isArray(c.groups) || c.groups.length === 0) return null;
      const cleanedGroups = c.groups
        .filter((g: any) => g.label && Array.isArray(g.stages) && g.stages.length > 0)
        .map((g: any) => ({
          ...g,
          stages: g.stages.map((s: any) => ({
            ...s,
            value: typeof s.value === 'number' ? s.value : parseFloat(String(s.value)),
          })).filter((s: any) => !isNaN(s.value) && Boolean(s.label)),
        }))
        .filter((g: any) => g.stages.length > 0);
      if (cleanedGroups.length === 0) return null;
      return { ...c, groups: cleanedGroups };
    }

    if (SERIES_CHART_TYPES.has(c.type)) {
      if (!c.series || !Array.isArray(c.series) || c.series.length === 0) return null;
      if (!c.data || !Array.isArray(c.data) || c.data.length === 0) return null;
      return { ...c, series: c.series.filter((s: any) => s.dataKey && s.name) };
    }

    if (c.series && Array.isArray(c.series) && c.series.length > 0 && c.data && Array.isArray(c.data)) {
      return { ...c, series: c.series.filter((s: any) => s.dataKey && s.name) };
    }

    if (!c.data || !Array.isArray(c.data) || c.data.length === 0) {
      if (DATA_OPTIONAL_TYPES.has(c.type)) return c;
      return null;
    }

    const cleanedData = c.data.map((d: any) => ({
      ...d,
      value: typeof d.value === 'number' ? d.value : parseFloat(String(d.value)),
      ...(d.previousValue != null ? { previousValue: typeof d.previousValue === 'number' ? d.previousValue : parseFloat(String(d.previousValue)) } : {}),
    })).filter((d: any) => !isNaN(d.value));

    if (cleanedData.length === 0) return null;
    return { ...c, data: cleanedData };
  }

  function normalizeLocName(name: string): string {
    return (name || '').toLowerCase().replace(/[.,'"]/g, '').replace(/\s+/g, ' ').trim();
  }

  function locNamesMatch(a: string, b: string): boolean {
    const na = normalizeLocName(a);
    const nb = normalizeLocName(b);
    if (na === nb) return true;
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.7) return true;
    if (na.length >= 6 && nb.length >= 6) {
      let m = na.length, n = nb.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = na[i - 1] === nb[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
      if (dp[m][n] <= Math.max(2, Math.floor(Math.max(m, n) * 0.2))) return true;
    }
    return false;
  }

  function deduplicateLocations(locations: any[]): any[] {
    const deduped: any[] = [];
    for (const loc of locations) {
      const existing = deduped.find(d => locNamesMatch(d.name || '', loc.name || ''));
      if (existing) {
        existing.uniqueLeads = (existing.uniqueLeads || 0) + (loc.uniqueLeads || 0);
        existing.reviewsGenerated = (existing.reviewsGenerated || 0) + (loc.reviewsGenerated || 0);
        existing.reviewsRespondedTo = (existing.reviewsRespondedTo || 0) + (loc.reviewsRespondedTo || 0);
        existing.postsQaCount = (existing.postsQaCount || 0) + (loc.postsQaCount || 0);
        if (loc.leadQuality && existing.leadQuality) {
          existing.leadQuality.good = (existing.leadQuality.good || 0) + (loc.leadQuality.good || 0);
          existing.leadQuality.notQuotable = (existing.leadQuality.notQuotable || 0) + (loc.leadQuality.notQuotable || 0);
          existing.leadQuality.missedCalls = (existing.leadQuality.missedCalls || 0) + (loc.leadQuality.missedCalls || 0);
          existing.leadQuality.noData = (existing.leadQuality.noData || 0) + (loc.leadQuality.noData || 0);
        }
      } else {
        deduped.push({ ...loc });
      }
    }
    return deduped;
  }

  function normalizeMarketingSectionKeys(section: any): any {
    if (!section || section.sectionKey !== 'marketing' || !section.data) return section;
    // F5 — typed same-reference view; the legacy webinars→webinar rename
    // still mutates the stored row object in place exactly as before.
    const data = readMarketingSection(section.data, { sectionId: section.id, reportId: section.reportId });
    if (data.webinars && !data.webinar) {
      data.webinar = data.webinars;
      delete data.webinars;
    }
    return section;
  }

  function normalizeSections(sections: any[]): any[] {
    return sections.map(normalizeMarketingSectionKeys);
  }

  // Hydrate each section's `lastEditedBy` token (e.g. `user:abc123`)
  // with a `lastEditedByUser` object so the Report Form audit panel
  // can show real names + emails instead of raw IDs (Task #833).
  async function hydrateSectionEditors(sections: any[]): Promise<any[]> {
    if (!sections || sections.length === 0) return sections;
    const { resolveLastEditedUsers } = await import("./lastEditedHelper");
    const ids = sections
      .map((s: any) => {
        const m = /^user:(.+)$/.exec(s?.lastEditedBy || "");
        return m ? m[1] : null;
      })
      .filter((id: string | null): id is string => !!id);
    const userMap = await resolveLastEditedUsers(ids);
    return sections.map((s: any) => {
      const m = /^user:(.+)$/.exec(s?.lastEditedBy || "");
      const user = m ? userMap.get(m[1]) ?? null : null;
      return { ...s, lastEditedByUser: user };
    });
  }

  export function registerReportRoutes(app: Express) {
    // --------------------------------------------
  // CEO ANALYTICS API - CEO only
  // --------------------------------------------
  app.get("/api/all-report-sections", isAuthenticated, requireCeo, async (_req: any, res) => {
    try {
      const allReports = await storage.getReports();
      if (allReports.length === 0) return res.json([]);

      const reportIds = allReports.map(r => r.id);
      const { reportSections } = await import("@shared/schema");
      const { inArray } = await import("drizzle-orm");
      // Task #4668 — read via getDb() (not the raw `db` import) so the
      // isolated-schema test sandbox's override covers this fan-out and
      // tests can assert the actual seeded payload, not just status/shape.
      const allSectionsRaw = await withDbAttribution(
        "reports:all-sections:fetch",
        () => getDb().select().from(reportSections).where(inArray(reportSections.reportId, reportIds)),
      );

      const reportMap = new Map(allReports.map(r => [r.id, r]));
      const allSections = normalizeSections(allSectionsRaw.map(section => {
        const report = reportMap.get(section.reportId);
        return {
          ...section,
          reportId: section.reportId,
          clientId: report?.clientId,
          reportMonth: report?.reportMonth,
          reportStatus: report?.status,
        };
      }));

      res.json(allSections);
    } catch (error) {
      console.error("Error fetching all report sections:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // --------------------------------------------
  // CEO PULSES API - CEO only
  // --------------------------------------------
  app.get("/api/ceo-pulses", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const pulses = await storage.getCeoPulses();
      res.json(pulses);
    } catch (error) {
      console.error("Error fetching CEO pulses:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  app.get("/api/ceo-pulses/:id", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      res.json(pulse);
    } catch (error) {
      console.error("Error fetching CEO pulse:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  app.get("/api/ceo-pulses/month/:monthKey", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const pulse = await storage.getCeoPulseByMonth(req.params.monthKey);
      res.json(pulse || null);
    } catch (error) {
      console.error("Error fetching CEO pulse by month:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  // Create CEO Pulse - CEO only
  app.post("/api/ceo-pulses", isAuthenticated, requireCeo, async (req: ValidatedBodyRequest<Record<string, unknown>>, res) => {
    try {
      const parsed = insertCeoPulseSchema.safeParse({
        ...req.body,
        createdBy: req.user?.claims?.sub,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const pulse = await storage.createCeoPulse(parsed.data);
      res.status(201).json(pulse);
    } catch (error) {
      console.error("Error creating CEO pulse:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  // Update CEO Pulse - CEO only. Body is validated against the explicit
  // whitelist of CEO-editable fields (audit D-PATCH: this handler previously
  // persisted a raw `{ ...req.body }` spread). Server-owned fields are
  // stripped before validation, mirroring the intelligence-feed PATCH
  // convention; unknown keys are dropped by the schema.
  app.patch("/api/ceo-pulses/:id", isAuthenticated, requireCeo, async (req: ValidatedBodyRequest<Record<string, unknown>, { id: string }>, res) => {
    try {
      const {
        id: _id,
        monthKey: _monthKey,
        shareToken: _shareToken,
        createdBy: _createdBy,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...rawData
      } = (req.body ?? {}) as Record<string, unknown>;
      const parsed = updateCeoPulseSchema.safeParse(rawData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const updates = { ...parsed.data };

      // When include_graphs is being toggled off, clear any chart artifacts
      // from the persisted analysis so the visual/letter immediately reflect
      // the new mode without a re-analyze.
      if (updates.includeGraphs === false) {
        const existing = await storage.getCeoPulse(req.params.id);
        if (!existing) {
          return res.status(404).json({ error: "NoBull Brief not found" });
        }
        const existingAnalysis = (existing.aiAnalysis ?? null) as { charts?: unknown } | null;
        if (existingAnalysis && Array.isArray(existingAnalysis.charts) && existingAnalysis.charts.length > 0) {
          // Caller didn't already supply a new analysis — strip charts from the stored one.
          if (!updates.aiAnalysis) {
            updates.aiAnalysis = { ...existingAnalysis, charts: [] };
          }
        }
        // If caller did supply aiAnalysis, also force its charts to empty for consistency.
        const suppliedAnalysis = (updates.aiAnalysis ?? null) as { charts?: unknown } | null;
        if (suppliedAnalysis && Array.isArray(suppliedAnalysis.charts) && suppliedAnalysis.charts.length > 0) {
          updates.aiAnalysis = { ...suppliedAnalysis, charts: [] };
        }
      }

      const pulse = await storage.updateCeoPulse(req.params.id, updates);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      res.json(pulse);
    } catch (error) {
      console.error("Error updating CEO pulse:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  // Helper function to validate URLs for safe fetching (SSRF protection)
  function isUrlSafe(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      // Only allow http/https
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      
      // Block localhost, private IPs, and internal hostnames
      const hostname = parsed.hostname.toLowerCase();
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.includes('metadata') ||
        hostname.includes('169.254.')
      ) {
        return false;
      }
      
      // Block URLs with auth credentials
      if (parsed.username || parsed.password) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  // Helper function to fetch and extract content from URLs
  async function fetchUrlContent(url: string): Promise<string> {
    try {
      // Security: Validate URL before fetching
      if (!isUrlSafe(url)) {
        return `[Skipped: URL not allowed for security reasons]`;
      }
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NoBullMarketing/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
        redirect: 'follow',
      });
      
      if (!response.ok) {
        return `[Could not fetch ${url}: HTTP ${response.status}]`;
      }
      
      const html = await response.text();
      
      // Basic HTML to text extraction - remove scripts, styles, and HTML tags
      const textContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      
      // Limit to first 6000 chars to avoid token limits (reduced for safety)
      const truncated = textContent.substring(0, 6000);
      return truncated.length < textContent.length ? truncated + '...' : truncated;
    } catch (error) {
      console.error(`Error fetching URL ${url}:`, error);
      return `[Could not fetch ${url}: ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
  }

  // Task #4813 — announcement-mode takeaways may carry an OPTIONAL "status"
  // chip ("Live now", "In beta"); Task #4834 adds an OPTIONAL "category" area
  // label (System / Product / Reporting / Education / Feedback) that drives
  // the roadmap template's snapshot-card icons. Additive fields inside the
  // free-form aiAnalysis JSONB: keep each only when it's a non-empty string
  // within its shared cap (CEO_PULSE_UPDATE_STATUS_MAX_CHARS /
  // CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS); DROP it otherwise (never truncate
  // mid-word — both are decorative, not load-bearing). Leaves string-form
  // items and every other field untouched. Shared by the analyze and refine
  // normalizers below.
  function sanitizeAnnouncementStatus(item: any): any {
    if (!item || typeof item !== 'object') return item;
    const { status, category, ...rest } = item;
    const out: any = rest;
    if (typeof status === 'string') {
      const trimmed = status.trim();
      if (trimmed.length > 0 && trimmed.length <= CEO_PULSE_UPDATE_STATUS_MAX_CHARS) {
        out.status = trimmed;
      }
    }
    if (typeof category === 'string') {
      const trimmed = category.trim();
      if (trimmed.length > 0 && trimmed.length <= CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS) {
        out.category = trimmed;
      }
    }
    return out;
  }

  // Task #4834 / #4984 — roadmap-template fields for freshly analyzed
  // text-only company updates (supportingLine, whyBullets, pullQuote; caps in
  // @shared/schema). Shared by the analyze and refine write sites. Each
  // sanitizer returns undefined when the value is absent or invalid so
  // callers OMIT the key entirely — sections the CEO's text doesn't support
  // stay absent (renderers skip them gracefully) rather than being stored as
  // empty shells or invented content. Same drop-never-truncate discipline as
  // the status chip above. (Task #4984 retired the beforeAfter/timeline
  // fields: neither write site stores them anymore, and the refine merge
  // deliberately never copies the legacy keys so edited old rows converge.)
  function sanitizeRoadmapLine(value: any, maxChars: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxChars) return undefined;
    return trimmed;
  }
  // Task #4984 — Why-This-Matters bullets: strings only, trimmed, over-cap
  // bullets DROPPED whole (never truncated), at most
  // CEO_PULSE_UPDATE_WHY_MAX_BULLETS survive. undefined when nothing does.
  function sanitizeWhyBullets(value: any): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const bullets = value
      .filter((b: any) => typeof b === 'string')
      .map((b: string) => b.trim())
      .filter((b: string) => b.length > 0 && b.length <= CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS)
      .slice(0, CEO_PULSE_UPDATE_WHY_MAX_BULLETS);
    return bullets.length > 0 ? bullets : undefined;
  }

  // Analyze CEO Pulse content with AI - CEO only
  app.post("/api/ceo-pulses/:id/analyze", isAuthenticated, requireCeo, aiLimiter, async (req: any, res: any) => {
    try {
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      
      if (!pulse.rawContent || pulse.rawContent.trim().length < 50) {
        return res.status(400).json({ error: "NoBull Brief content must be at least 50 characters" });
      }

      // When graphs are disabled for this pulse, omit all chart-related
      // instructions and output schema from the AI prompt entirely (true
      // skip of chart extraction, not just discarding results downstream).
      const graphsEnabledForPrompt = pulse.includeGraphs !== false;

      // Task #4813 — company-update briefs are announcements ("here is what
      // we're building because of what we've learned"), not market analysis.
      // When that edition renders text-only, the extraction spec switches to
      // announcement shape: one initiative per takeaway (name + one-liner ≤16
      // words + optional status), short commitment statements for
      // implications. Charts-mode company updates and every other edition
      // (market_shift, legacy NULL) keep the existing spec byte-for-byte.
      // Mirrors the render branch in CeoPulseVisual / CeoPulseSlide; caps
      // live in @shared/schema so prompts + normalization stay in lockstep.
      const announcementMode = !graphsEnabledForPrompt && pulse.edition === 'company_update';

      // Extract URLs from the content
      const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
      const urls = pulse.rawContent.match(urlRegex) || [];
      
      // Fetch content from URLs (limit to first 3 URLs)
      let referenceData = '';
      if (urls.length > 0) {
        const urlsToFetch = urls.slice(0, 3);
        
        const fetchedContents = await Promise.all(
          urlsToFetch.map(async (url) => {
            const content = await fetchUrlContent(url);
            return `\n\n--- SOURCE: ${url} ---\n${content}`;
          })
        );
        
        referenceData = fetchedContents.join('');
      } else {
      }

      // COLOR DECISION (Task #4567) — DELIBERATE KEEP of crimson/burgundy in
      // this prompt's chart palette (both this generation prompt and the
      // refine prompt below): these charts render into the branded NoBull
      // Brief via server/services/chartImageGenerator.ts, where crimson is a
      // brand data-series color (always legend-paired with navy/forest/…),
      // NOT internal-OS chrome — so the Task #4558 Liberty re-primary does
      // not apply. Keep the "Available colors" lists in lockstep with that
      // generator's ramps.
      const prompt = `You are extracting and structuring content from the CEO's exact words. Stay FAITHFUL to the source.

CRITICAL RULES:
- Do not summarize or soften the CEO's conclusions.
- Do not introduce new frameworks, stages, or concepts unless explicitly present in the CEO's text.
- Always explain cause-and-effect mechanics before stating conclusions.
- ${announcementMode ? 'Every insight must clearly answer: What are we building, and what does the reader get from it?' : 'Every insight must clearly answer: How does this affect revenue or case acquisition?'}
- Use statistics and numbers from BOTH the CEO's text AND any reference sources provided.
- When using data from reference sources, explicitly cite where it came from.

CEO'S INPUT TEXT:
${sanitizePromptInput(pulse.rawContent)}
${referenceData ? `\nREFERENCE DATA FROM LINKED SOURCES:${referenceData}` : ''}

EXTRACTION GUIDELINES:

1. HEADLINE (${announcementMode ? '6-10 words — a short, outcome-focused statement of what this update changes for the reader' : '10-18 words'})
   - Capture the CEO's main point in their voice
   - Lead with mechanics or orientation, not conclusions
   - Avoid absolute language unless the CEO uses it

${announcementMode ? `2. KEY TAKEAWAYS — WHAT WE'RE BUILDING (3-${CEO_PULSE_UPDATE_MAX_INITIATIVES} items, one per initiative)
   - Each item is ONE initiative, product, or project the CEO says the company is building, changing, or shipping.
   - Extract every distinct initiative in the CEO's text (up to ${CEO_PULSE_UPDATE_MAX_INITIATIVES}). Never pad with filler items and never merge two initiatives into one.
   - Format: "highlight" = the initiative's NAME (a 2-6 word noun phrase, in the CEO's own words). "detail" = ONE tight line of AT MOST 16 words saying what it does for clients or the firm.
   - OPTIONAL field "status": at most 3 words, ONLY when the CEO states a stage or timing ("Live now", "In beta", "Shipping Q4"). Omit the field entirely when the CEO doesn't state one — never invent it.
   - OPTIONAL field "category": a one- or two-word area label for the initiative (at most ${CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS} characters) — prefer System, Product, Reporting, Education, or Feedback when one fits; omit the field when none fits naturally. Classifying an initiative the CEO described is allowed — inventing initiatives is not.
   - GOOD: highlight="Review Velocity System", detail="automates weekly review asks so firms compound their local-search advantage", status="In beta", category="System"
   - BAD: a 40-word paragraph of market analysis — depth belongs to the full letter, not this card.

3. STRATEGIC IMPLICATIONS — WHAT THIS MEANS FOR YOU (3-${CEO_PULSE_UPDATE_MAX_COMMITMENTS} items)
   - Each item is a short commitment statement addressed directly to clients and partners: what they get from this work.
   - Format: "highlight" = a declarative commitment of AT MOST 8 words (e.g. "Your reviews start working harder"). "detail" = an optional amplifier of AT MOST 12 words; use "" when the statement stands alone.
   - No hedging and no market analysis — say what the reader gets, plainly.` : `2. KEY TAKEAWAYS (${graphsEnabledForPrompt ? 'max 4' : '5-6 items REQUIRED'})
   - Extract the CEO's actual points, not a summary of them
   - Each takeaway must reflect behavior, demand timing, or revenue mechanics
   - Avoid platform-first framing
   - Format: Highlight must be a noun phrase. Highlight + detail must read as one natural sentence.
   - GOOD: highlight="ChatGPT ads", detail="skew toward early demand generation before hiring intent exists"
   - BAD: highlight="Exploratory usage", detail="Two-thirds of activity focuses on learning" (abstract, not revenue-anchored)

3. STRATEGIC IMPLICATIONS (${graphsEnabledForPrompt ? 'max 3' : '4-5 items REQUIRED'})
   - Reflect what the CEO is advising or prioritizing
   - Frame as capital allocation or sequencing, not tactics
   - Format: Highlight must start with an action verb. Implications should describe what this means, not over-prescribe.
   - GOOD: highlight="Prioritize demand capture", detail="where active legal need already exists for faster, more predictable ROI"`}
${graphsEnabledForPrompt ? `
4. CHARTS (use REAL numbers only)
   - Use statistics from the CEO's text and/or reference sources
   - Charts must support a specific claim made in the takeaways
   - Do not include charts that merely restate data without decision relevance
   - Use ACTUAL numbers from sources, never estimates
   - If no relevant numbers exist, return "charts": []
   - Tie charts to demand behavior or revenue relevance, not platform popularity
   - SMART LABELING: Use category labels (e.g., "Navigational", "Transactional"), not source labels. Use color to distinguish sources.
   - COLORS: Google="#2D6A4F" (green), ChatGPT="#8B2E31" (burgundy)
   - LEGEND: Always include a legend when bars represent different sources
   - DESCRIPTION: Include source name and briefly state why the chart matters for decision-making
   - CHART TYPES — pick the best type for the data:
     "bar" — horizontal bars for comparing categories
     "comparison" — horizontal bars with previousValue for period-over-period comparison
     "line" — time series or sequential data points connected by lines
     "area" — like line but with filled area beneath (use for volume/cumulative data)
     "pie" — proportional breakdown of a whole (best with 2-6 slices)
     "donut" — like pie but with hollow center (cleaner look for fewer categories)
     "funnel" — sequential pipeline stages showing drop-off (uses groups[], not data[])
     "stacked_bar" — vertical stacked bars comparing composition across categories (requires series[])
     "grouped_bar" — vertical side-by-side bars comparing multiple metrics per category (requires series[])
     "radar" — multi-axis comparison (good for scoring/rating across 4-8 dimensions)
     "scatter" — relationship between two variables (value=x, previousValue=y); each point's "label" is drawn as a text label on its dot, so name every point via "label"
     "progress" — horizontal progress bars with percentage fill (good for goal tracking)
     "gauge" — single metric as a semicircle gauge (use data[0] only, target= sets max)
     "metric_cards" — grid of KPI cards with big numbers (good for summary stats)

   - MULTI-SERIES CHARTS (line, area, stacked_bar, grouped_bar): Use "series" array to define multiple data lines/bars. Each data item should have keys matching series[].dataKey.
   - TARGET LINE: Add "target": number to show a horizontal/vertical reference line on line/area/progress/gauge charts.
` : announcementMode ? `
4. NO CHARTS — TEXT-ONLY COMPANY UPDATE (announcement, not analysis)
   - This brief is configured to render text-only. Do NOT extract or generate any charts. Omit the "charts" field entirely from the JSON output.
   - This edition is a company update: "here is what we're building because of what we've learned" — scannable announcement cards, NOT the denser market brief. Keep every item tight; the layout carries the density, not the words.
   - Add a NEW field "contextNarrative" — the WHY THIS MATTERS lead: an array with EXACTLY ONE short paragraph (2-3 sentences, at most 60 words) in the CEO's voice. Open with a strong sentence naming the market or client problem this update responds to and close with why this update answers it. Quote a real number with its source inline ONLY when one exists in the CEO's text or reference data; never invent one. Brevity is the point — the "whyBullets" below carry the detail, and long-form depth belongs to the separately written full letter.
   - Add a NEW field "whyBullets" — the skimmable body of WHY THIS MATTERS: an array of 3-5 SHORT bullets, each UNDER ${CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS} characters and making ONE concrete point about why this update matters to the reader. When (and ONLY when) the CEO's text supports them, fold in the old-friction-to-improvement contrast and what's coming next with any timing the CEO actually states. Never invent a bullet and never pad the count — fewer real bullets beat five manufactured ones.
   - Add a NEW field "byTheNumbers": an array of plain-text stat callouts in the form {"label": "What the number measures", "value": "the number with units", "source": "where it came from"} ONLY for REAL numbers in the source material. Company updates often have none — return [] rather than inventing or estimating.

5. ROADMAP SECTIONS (extract ONLY what the CEO's text supports — OMIT any field, whole, when the text does not support it; NEVER invent content to fill a section)
   - "supportingLine": ONE sentence (at most ${CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS} characters) that sits under the headline and explains the reason behind this update — why now.
   - "pullQuote": ONE strong sentence (at most ${CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS} characters) that makes the main idea memorable — the CEO's core thesis in their own words or a faithful distillation of them. Omit when nothing in the text carries that weight.
` : `
4. NO CHARTS — TEXT-ONLY MODE (richer narrative)
   - This pulse is configured to render text-only. Do NOT extract or generate any charts.
   - Omit the "charts" field entirely from the JSON output.
   - Because there are no visuals to carry the page, the WORDS must do more work.
   - Produce a fuller, denser brief:
     * KEY TAKEAWAYS: produce 5-6 items (instead of 4). Each "detail" should be 18-32 words and explicitly name the mechanic, the number from the source, and the revenue or case-acquisition consequence.
     * STRATEGIC IMPLICATIONS: produce 4-5 items (instead of 3). Each "detail" should be 18-30 words and frame what the CEO is reallocating, sequencing, or pausing — not generic advice.
   - Add a NEW field "contextNarrative": an array of AT MOST ${CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS} tight paragraphs (40-70 words each) written in the CEO's voice. The report visual is a brief, not a letter — this is a short orienting intro, never letter-length prose (long-form depth belongs to the separately written full letter). Each paragraph must:
     * Open with a concrete mechanic or observation (not a thesis statement).
     * Quote at least one statistic from the CEO's text or the reference data, and cite the source inline ("per [source]").
     * End with the revenue / time-to-cash / demand-behavior consequence.
     * Together the paragraphs walk the reader from "what changed and why" → "where the money moves and what we're doing about it".
   - Add a NEW field "byTheNumbers": an array of 3-5 plain-text stat callouts in the form {"label": "What the number measures", "value": "the number with units", "source": "where it came from"}. These take the place of the missing chart and must be REAL numbers from the source material, never estimates. If no concrete numbers exist, return [].
`}
${announcementMode ? `MASTER CONSTRAINT:
Every output must make clear: What we're building, What it does for the reader, Why we're building it now. Keep every item scannable — names first, one line each. If something cannot be said in one line, it belongs in the full letter, not this brief.` : `MASTER CONSTRAINT:
Every output must make clear: Where money is made, How the CEO believes demand behaves, What uncertainty still exists. If any of these are missing, the output is incomplete.`}

OUTPUT FORMAT (JSON ONLY):
{
  "headline": "string",
  "keyTakeaways": [{"highlight": "noun phrase", "detail": "rest of the natural sentence", "url": "source URL if available, omit if none"${announcementMode ? ', "status": "optional stage like Live now — omit unless the CEO states one", "category": "optional area label like System — omit when none fits"' : ''}}],
  "strategicImplications": [{"highlight": "action phrase", "detail": "explanation"}]${graphsEnabledForPrompt ? '' : `,
  "contextNarrative": ${announcementMode ? '["why-this-matters lead paragraph (exactly one, 2-3 sentences)"]' : `["paragraph 1 in the CEO's voice (40-70 words)", "paragraph 2 (40-70 words, optional)"]`},
  "byTheNumbers": [{"label": "What it measures", "value": "Number with units", "source": "Where it came from"}]`}${announcementMode ? `,
  "supportingLine": "one sentence — the reason behind this update (omit when the text doesn't support it)",
  "whyBullets": ["short bullet, one concrete point, under ${CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS} characters"],
  "pullQuote": "one strong sentence (omit when nothing carries that weight)"` : ''}${graphsEnabledForPrompt ? `,
  "charts": [
    {
      "type": "bar|comparison|line|area|pie|donut|funnel|stacked_bar|grouped_bar|radar|scatter|progress|gauge|metric_cards",
      "title": "Chart Title",
      "description": "Source: [name of source]. Why it matters for decision-making.",
      "valueSuffix": "%",
      "data": [{"label": "Category", "value": number, "previousValue": number, "color": "#hex"}],
      "legend": [{"label": "Category Name", "color": "#hex"}],
      "series": [{"name": "Display Name", "dataKey": "fieldName", "color": "#hex"}],
      "target": number
    }
  ]` : ''}
}
${graphsEnabledForPrompt ? `
MULTI-SERIES EXAMPLE (line chart with two series):
{
  "type": "line",
  "title": "Monthly Lead Trend",
  "valueSuffix": "",
  "data": [{"label": "Jan", "organic": 120, "paid": 85}, {"label": "Feb", "organic": 135, "paid": 90}],
  "series": [{"name": "Organic", "dataKey": "organic", "color": "#2D6A4F"}, {"name": "Paid", "dataKey": "paid", "color": "#8B2E31"}],
  "target": 150
}

FUNNEL CHART FORMAT (use when data shows sequential pipeline stages):
{
  "type": "funnel",
  "title": "Pipeline Title",
  "description": "Why this funnel matters",
  "subtitle": "Optional micro-line beneath the chart",
  "groups": [
    {
      "label": "Group Name (e.g. Typical Firm)",
      "colorScheme": "light",
      "stages": [{"label": "Stage Name", "value": number}]
    },
    {
      "label": "Comparison Group (e.g. Optimized Firm)",
      "colorScheme": "dark",
      "stages": [{"label": "Stage Name", "value": number}]
    }
  ],
  "annotations": [
    {"afterStage": 0, "text": "Biggest Loss: Slow Follow-Up"},
    {"afterStage": 1, "text": "Leak 2: Sales Drop-Off"}
  ]
}
Note on afterStage indexing: afterStage is 0-based. afterStage 0 = between stages[0] and stages[1], afterStage 1 = between stages[1] and stages[2], etc.
` : ''}
Return valid JSON only.`;

      const response = await openai.chat.completions.create({
        model: QUALITY_MODEL,
        messages: [
          // Task #4813 — announcement mode drops the revenue-mechanics /
          // capital-allocation framing (that spec is for market-shift
          // analysis) in favor of faithful announcement extraction.
          { role: "system", content: announcementMode
            ? "You are a FAITHFUL extraction and structuring engine. Your job is to preserve the CEO's voice, logic, and intent without softening, reframing, or adding interpretation. This brief is a company update announcement: extract WHAT the company is building (initiative names in the CEO's own words), what each item does for clients, and why the company is building it. Do not force market-analysis or revenue-mechanics framing onto announcement items — one concrete line per item is enough. Never pad the item counts and never invent initiatives, numbers, or statuses. Avoid abstract marketing jargon; prefer concrete descriptions of what ships and what it does. Format highlight + detail so they read as one flowing line."
            : "You are a FAITHFUL extraction and structuring engine. Your job is to preserve the CEO's voice, logic, and intent without softening, reframing, or adding interpretation. You must prioritize behavioral and economic mechanics over surface-level conclusions. Do not lead with opinions. Always explain why outcomes occur before stating what they are. Anchor all insights to revenue mechanics, time-to-cash, and demand behavior. Write as if briefing a CEO on capital allocation, not as a marketing analyst. Use statistics from both the CEO's text and any reference sources provided. When reference data is used, include the source in chart descriptions. Avoid abstract marketing jargon unless it is immediately defined in plain language. Prefer concrete descriptions of user behavior. Do not teach frameworks or introduce models unless explicitly instructed. Your role is to orient decision-making, not educate. Format highlight + detail so they read as one flowing sentence." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: graphsEnabledForPrompt ? 2000 : 3500,
      });

      const content = response.choices[0]?.message?.content || "{}";
      let rawAnalysis;
      try {
        rawAnalysis = JSON.parse(content);
      } catch (parseErr) {
        console.error("[CEO Pulse] AI JSON parse error:", parseErr);
        return res.status(500).json({ error: "NoBull Brief operation failed" });
      }

      // Normalize and validate the analysis structure. When graphs are disabled
      // for this pulse, drop any chart payload the AI returned so the saved
      // analysis has no charts and image generation is skipped.
      const graphsEnabled = pulse.includeGraphs !== false;
      const analysis: any = {
        headline: rawAnalysis.headline || "CEO Update",
        keyTakeaways: Array.isArray(rawAnalysis.keyTakeaways) ? rawAnalysis.keyTakeaways : [],
        strategicImplications: Array.isArray(rawAnalysis.strategicImplications) ? rawAnalysis.strategicImplications : [],
        charts: graphsEnabled && Array.isArray(rawAnalysis.charts) ? rawAnalysis.charts
          .map((c: any) => validateCeoPulseChart(c))
          .filter((c: any) => c !== null) : [],
      };
      if (!graphsEnabled) {
        // Task #4834 — the roadmap template's Why-This-Matters section reuses
        // contextNarrative with one extra allowed paragraph (3 vs 2). Since
        // Task #4984 the announcement prompt asks for ONE short lead
        // paragraph (whyBullets carry the body); the 3-paragraph cap stays as
        // tolerance for legacy-shaped AI output.
        const narrativeCap = announcementMode ? CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS : CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS;
        analysis.contextNarrative = Array.isArray(rawAnalysis.contextNarrative)
          ? rawAnalysis.contextNarrative.filter((p: any) => typeof p === 'string' && p.trim().length > 0).slice(0, narrativeCap)
          : [];
        analysis.byTheNumbers = Array.isArray(rawAnalysis.byTheNumbers)
          ? rawAnalysis.byTheNumbers
              .filter((s: any) => s && typeof s === 'object' && (s.label || s.value))
              .map((s: any) => ({
                label: String(s.label || ''),
                value: String(s.value || ''),
                source: s.source ? String(s.source) : undefined,
              }))
              .slice(0, 6)
          : [];
      }
      // Task #4813 — announcement mode (text-only company updates): keep the
      // stored shape in lockstep with the announcement prompt. Slice to the
      // shared max counts and sanitize the additive optional per-item
      // "status" chip. Every other edition stores exactly what it did before.
      if (announcementMode) {
        analysis.keyTakeaways = analysis.keyTakeaways
          .slice(0, CEO_PULSE_UPDATE_MAX_INITIATIVES)
          .map((t: any) => sanitizeAnnouncementStatus(t));
        analysis.strategicImplications = analysis.strategicImplications.slice(0, CEO_PULSE_UPDATE_MAX_COMMITMENTS);
        // Task #4834 / #4984 — roadmap-template fields: sanitize each and set
        // the key ONLY when a valid value survives, so sections the CEO's
        // text doesn't support stay absent (renderers omit them gracefully)
        // instead of being stored as empty shells. Non-announcement editions
        // never copy these keys — this block is the only writer. Retired
        // beforeAfter/timeline (Task #4984) are never read off the AI output,
        // so a fresh analyze always stores the simplified shape.
        const supportingLine = sanitizeRoadmapLine(rawAnalysis.supportingLine, CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS);
        if (supportingLine !== undefined) analysis.supportingLine = supportingLine;
        const whyBullets = sanitizeWhyBullets(rawAnalysis.whyBullets);
        if (whyBullets !== undefined) analysis.whyBullets = whyBullets;
        const pullQuote = sanitizeRoadmapLine(rawAnalysis.pullQuote, CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS);
        if (pullQuote !== undefined) analysis.pullQuote = pullQuote;
      }

      const updated = await storage.updateCeoPulse(pulse.id, { aiAnalysis: analysis });

      let chartImagesGenerated = false;
      if (graphsEnabled && analysis.charts && analysis.charts.length > 0) {
        try {
          const result = await generateAndStoreChartImages(pulse.monthKey, analysis.charts);
          chartImagesGenerated = result.success && result.generatedCount === analysis.charts.length;
        } catch (chartErr) {
          console.error("[CEO Pulse] Chart image generation failed:", chartErr);
        }
      }

      res.json({ pulse: updated, analysis, chartImagesGenerated });
    } catch (error) {
      console.error("Error analyzing CEO pulse:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  // Refine CEO Pulse with AI chat - CEO only
  app.post("/api/ceo-pulses/:id/refine", isAuthenticated, requireCeo, aiLimiter, async (req: any, res: any) => {
    try {
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      
      const { message, currentAnalysis } = req.body;
      if (!message || !currentAnalysis) {
        return res.status(400).json({ error: "Message and current analysis required" });
      }

      // When graphs are disabled for this pulse, omit chart instructions
      // and chart output schema from the refine prompt entirely.
      const refineGraphsEnabled = pulse.includeGraphs !== false;

      // Task #4813 — announcement mode for text-only company updates: the
      // refine FORMAT RULES mirror the analyze prompt's announcement spec so
      // edits keep items announcement-shaped, and "add depth / make it
      // longer" deepens WITHIN the caps (long-form depth belongs to the full
      // letter). Market-shift / legacy NULL-edition briefs keep the existing
      // text-only rules byte-for-byte.
      const refineAnnouncementMode = !refineGraphsEnabled && pulse.edition === 'company_update';

      // Present the charts to the model with the SAME canonical 1-based numbering
      // the user sees in the UI ("Chart 1" / "{{chart-1}}" … numbered over the
      // charts array order) so an ordinal reference like "chart 3" lands on
      // charts[2] deterministically instead of the model guessing the slot.
      const refineCharts: any[] = refineGraphsEnabled && Array.isArray(currentAnalysis?.charts) ? currentAnalysis.charts : [];
      const numberedChartsBlock = refineCharts.length > 0
        ? refineCharts.map((c: any, i: number) =>
            `Chart ${i + 1} ({{chart-${i + 1}}}) — "${c?.title || '(untitled)'}" [type: ${c?.type || 'unknown'}]:\n${JSON.stringify(c, null, 2)}`
          ).join('\n\n')
        : '';

      // COLOR DECISION (Task #4567): burgundy #8B2E31 DELIBERATELY KEPT in
      // this refine prompt's palette — see the decision comment on the
      // generation prompt above and server/services/chartImageGenerator.ts.
      const prompt = `You are editing an existing structured analysis based on the user's request.

CURRENT ANALYSIS:
${JSON.stringify(currentAnalysis, null, 2)}
${refineGraphsEnabled && refineCharts.length > 0 ? `
CHART NUMBERING (CRITICAL — this is the EXACT numbering the user sees in the app):
${numberedChartsBlock}

The "charts" array above is in this exact order: index 0 = Chart 1, index 1 = Chart 2, and so on. "Chart 3", "the third chart", and "{{chart-3}}" all refer to the SAME chart — the 3rd one in the array (index 2).
` : ''}
ORIGINAL RAW CONTENT (reference for adding new elements):
${sanitizePromptInput(pulse.rawContent)}

USER REQUEST:
${sanitizePromptInput(message)}

EDITING RULES:
- Apply ONLY what the user requests - nothing more, nothing less
- PRESERVE everything else exactly as it appears in CURRENT ANALYSIS
- Do NOT revert colors, labels, legends, or any other changes from previous edits
- When ADDING content, reference the original raw content above
- Return the COMPLETE analysis including ALL charts, even ones you didn't modify
- NEVER report a change as done unless you wrote it to a field that actually renders. Captions go in "subtitle" (not "caption"); scatter point names go in each data point's "label". Do not claim success for a field that does not exist in the schema below.${refineGraphsEnabled && refineCharts.length > 0 ? `
- CHART TARGETING: When the user names a chart by its number or ordinal ("chart 3", "the third chart", "{{chart-3}}"), edit ONLY that exact chart from the CHART NUMBERING list above and leave every other chart byte-for-byte unchanged. Do not shift, renumber, or edit a neighboring chart.
- PRESERVE CHART ORDER AND COUNT: Return the charts in the same order and the same count as CURRENT ANALYSIS unless the user explicitly asks to add, remove, merge, or REORDER/MOVE charts.
- REORDERING CHARTS: When the user asks to reorder, move, swap, or rearrange charts (e.g. "move chart 2 above chart 1", "put the funnel last", "swap charts 1 and 3"), return the SAME chart objects in the new order they requested. Keep the count identical and every chart's contents byte-for-byte unchanged — only the sequence changes. Do not edit, rename, recolor, or otherwise alter any chart while reordering.
- CONFIRMATION MESSAGE: In "message", state the NUMBER and TITLE of the chart you actually changed (e.g. 'Updated the subtitle of Chart 3 ("Lead Sources").'). Never reference a chart number you did not actually edit.` : ''}

FORMAT RULES:
- keyTakeaways: ${refineGraphsEnabled ? 'Max 4 items' : refineAnnouncementMode ? `3-${CEO_PULSE_UPDATE_MAX_INITIATIVES} items — one per initiative the company is building (announcement mode: never pad, never merge initiatives)` : '5-6 items (text-only mode requires a denser brief)'}, each with {highlight: "${refineAnnouncementMode ? "the initiative's NAME (2-6 word noun phrase)" : 'Bold lead (3-5 words)'}", detail: "${refineGraphsEnabled ? 'rest (≤18 words)' : refineAnnouncementMode ? 'ONE tight line, AT MOST 16 words — what it does for clients or the firm' : 'rest (18-32 words, name the mechanic + the source-cited number + the revenue/case-acquisition consequence)'}"}${refineAnnouncementMode ? ` plus an OPTIONAL "status" (at most 3 words, only when the CEO states a stage/timing like "Live now" — never invent it) and an OPTIONAL "category" (a one- or two-word area label like System / Product / Reporting / Education / Feedback, at most ${CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS} characters — omit when none fits)` : ''}
- strategicImplications: ${refineGraphsEnabled ? 'Max 3 items' : refineAnnouncementMode ? `3-${CEO_PULSE_UPDATE_MAX_COMMITMENTS} short commitment statements addressed to clients/partners` : '4-5 items (text-only mode)'} with {highlight, detail} structure${refineGraphsEnabled ? '' : refineAnnouncementMode ? ' — highlight = a declarative commitment of AT MOST 8 words; detail = an optional amplifier of AT MOST 12 words ("" when the statement stands alone); no hedging, no market analysis' : ' — each detail 18-30 words, framing reallocation/sequencing/pausing decisions, not generic advice'}
${refineGraphsEnabled ? `- Charts: Group related metrics together. To condense, merge similar data into fewer charts.

ADDING A CHART (read carefully):
- Only add a chart if you can pull REAL numbers from the ORIGINAL RAW CONTENT above. Every data point's "value" MUST be a pure number (and funnel "stages[].value" must be a pure number).
- NEVER invent, estimate, or use placeholder/zero values to satisfy a chart request, and NEVER put text in "value".
- If the user asks to visualize a CONCEPTUAL or QUALITATIVE idea that has no numeric basis in the raw content (e.g. "The Client Journey Is No Longer a Straight Line"), DO NOT return a chart for it. Instead, leave "charts" exactly as in CURRENT ANALYSIS and use "message" to say plainly that the requested chart needs numeric values, and state which specific numbers the user would need to provide to plot it.

CHART OPTIONS:
- Colors: Add "color" field to data items. Use same color for related items (e.g., all Google bars = navy, all ChatGPT bars = burgundy)
- Available colors: "#8B2E31" (burgundy), "#1E3A5F" (navy), "#2D6A4F" (forest), "#D97706" (amber), "#7C3AED" (purple), "#0891B2" (teal)
- Legend: Add "legend" array to chart to explain what colors mean. Example: "legend": [{"label": "Google", "color": "#1E3A5F"}, {"label": "ChatGPT", "color": "#8B2E31"}]
- Caption / subtitle: To add or update a chart's caption, set the chart's "subtitle" field (a short italic line rendered directly beneath the chart). There is NO "caption" field — always write captions to "subtitle". Do NOT claim a caption was added unless you set "subtitle".
- valueSuffix: Controls how values are displayed next to bars. Default is "%". Use "x" for multipliers (e.g., "100x"), "" for plain numbers, "k" for thousands, etc. CRITICAL: The "value" field MUST ALWAYS be a pure number. Never put text in "value". Use "valueSuffix" for the display unit.
- CHART TYPES — pick the best type for the data:
  "bar" — horizontal bars for comparing categories
  "comparison" — horizontal bars with previousValue for period-over-period
  "line" — time series or sequential data points connected by lines
  "area" — like line but with filled area beneath (volume/cumulative data)
  "pie" — proportional breakdown of a whole (best with 2-6 slices)
  "donut" — like pie but with hollow center
  "funnel" — sequential pipeline stages showing drop-off (uses groups[], not data[])
  "stacked_bar" — vertical stacked bars comparing composition (requires series[])
  "grouped_bar" — vertical side-by-side bars comparing multiple metrics (requires series[])
  "radar" — multi-axis comparison (good for scoring across 4-8 dimensions)
  "scatter" — relationship between two variables (value=x, previousValue=y); each point's "label" is drawn as a text label on its dot, so name every point via "label"
  "progress" — horizontal progress bars with percentage fill (goal tracking)
  "gauge" — single metric as a semicircle gauge (data[0] only, target= sets max)
  "metric_cards" — grid of KPI cards with big numbers (summary stats)
- MULTI-SERIES CHARTS (line, area, stacked_bar, grouped_bar): Use "series" array to define multiple lines/bars. Data items should have keys matching series[].dataKey.
- TARGET LINE: Add "target": number for a reference line on line/area/progress/gauge charts.` : refineAnnouncementMode ? `- NO CHARTS: This pulse is configured to render text-only. Do NOT add, edit, or return any charts. Ignore any user request to create or modify charts and reply that charts are disabled for this pulse.
- COMPANY UPDATE (ANNOUNCEMENT) MODE: This brief is an announcement — "here is what we're building because of what we've learned" — not a market brief. Even when editing, every takeaway stays an initiative NAME plus a one-line detail of AT MOST 16 words, and every implication stays a short commitment statement. PRESERVE the existing "contextNarrative" (array of paragraphs) and "byTheNumbers" (array of {label, value, source}) from CURRENT ANALYSIS unless the user explicitly asks to change them. WHY THIS MATTERS is skimmable: "contextNarrative" holds its lead — EXACTLY ONE short paragraph (2-3 sentences, at most 60 words) naming the client problem and why this update answers it — and "whyBullets" holds its body: 3-5 SHORT bullets, each UNDER ${CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS} characters and making ONE concrete point (fold in the old-friction-to-improvement contrast and what's-coming timing ONLY when the CEO's material supports them — never invented). PRESERVE the stored "whyBullets" unless the user asks to change Why This Matters; when CURRENT ANALYSIS still has a multi-paragraph contextNarrative and no "whyBullets", CONVERT as part of this edit even if the user asked about something else: keep the strongest single paragraph as the lead and distill the rest into 3-5 whyBullets drawn from the stored text and the original raw content. When the user asks for more depth / context / "make it longer", deepen WITHIN these caps — sharpen each one-liner, commitment statement, lead sentence, and bullet — never grow items into paragraphs and never add items past the caps; long-form depth belongs to the full letter, not this brief. byTheNumbers values must remain real numbers from the source material (never invented) — [] is correct when none exist. ROADMAP FIELDS: PRESERVE the stored "supportingLine" and "pullQuote" from CURRENT ANALYSIS unless the user explicitly asks to change them. When editing them, keep the template caps: supportingLine ONE sentence (at most ${CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS} characters); pullQuote ONE strong sentence (at most ${CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS} characters). RETIRED FIELDS: "beforeAfter" and "timeline" no longer exist in this template — NEVER return them; any such content still in CURRENT ANALYSIS is dropped on save, and its old-vs-new contrast or sequencing belongs in whyBullets when the material supports it. NEVER invent content for a roadmap field the CEO's material doesn't support — omit it instead.` : `- NO CHARTS: This pulse is configured to render text-only. Do NOT add, edit, or return any charts. Ignore any user request to create or modify charts and reply that charts are disabled for this pulse.
- TEXT-ONLY MODE: This pulse uses richer narrative fields. PRESERVE the existing "contextNarrative" (array of paragraphs) and "byTheNumbers" (array of {label, value, source}) from CURRENT ANALYSIS unless the user explicitly asks to change them. The report visual is a brief, not a letter: contextNarrative is a short orienting intro of AT MOST ${CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS} tight paragraphs (40-70 words each). When the user asks for more depth / context / "make it longer", deepen WITHIN that cap — sharpen the mechanics, source-cited stats, and revenue consequence in the CEO's voice — never add paragraphs or exceed the word range; long-form depth belongs to the full letter, not this brief. byTheNumbers values must remain real numbers from the source material (never invented).`}

OUTPUT FORMAT (JSON ONLY):
{
  "analysis": {
    "headline": "${refineAnnouncementMode ? '6-10 word outcome-focused headline' : '10-18 word headline'}",
    "keyTakeaways": [{"highlight": "Bold phrase", "detail": "rest of takeaway", "url": "optional source URL"${refineAnnouncementMode ? ', "status": "optional stage (omit unless the CEO stated one)", "category": "optional area label (omit when none fits)"' : ''}}],
    "strategicImplications": [{"highlight": "Bold action", "detail": "explanation"}]${refineGraphsEnabled ? '' : `,
    "contextNarrative": ${refineAnnouncementMode ? '["why-this-matters lead paragraph (exactly one, 2-3 sentences)"]' : `["paragraph 1 (40-70 words in CEO's voice)", "paragraph 2 (40-70 words, optional)"]`},
    "byTheNumbers": [{"label": "What it measures", "value": "Number with units", "source": "Where it came from"}]`}${refineAnnouncementMode ? `,
    "supportingLine": "one sentence (omit when the material doesn't support it)",
    "whyBullets": ["short bullet, one concrete point, under ${CEO_PULSE_UPDATE_WHY_BULLET_MAX_CHARS} characters"],
    "pullQuote": "one strong sentence"` : ''}${refineGraphsEnabled ? `,
    "charts": [
      {
        "type": "bar|comparison|line|area|pie|donut|funnel|stacked_bar|grouped_bar|radar|scatter|progress|gauge|metric_cards",
        "title": "string",
        "description": "string",
        "subtitle": "optional caption rendered beneath the chart",
        "valueSuffix": "%",
        "data": [{"label": "Label", "value": number, "previousValue": number, "color": "#hex"}],
        "legend": [{"label": "Category Name", "color": "#hex"}],
        "series": [{"name": "Display Name", "dataKey": "fieldName", "color": "#hex"}],
        "target": number
      }
    ]` : ''}
  },
  "message": "Brief confirmation of what was changed (max 2 sentences)."
}
${refineGraphsEnabled ? `
MULTI-SERIES EXAMPLE (line chart):
{
  "type": "line",
  "title": "Monthly Lead Trend",
  "valueSuffix": "",
  "data": [{"label": "Jan", "organic": 120, "paid": 85}, {"label": "Feb", "organic": 135, "paid": 90}],
  "series": [{"name": "Organic", "dataKey": "organic", "color": "#2D6A4F"}, {"name": "Paid", "dataKey": "paid", "color": "#8B2E31"}],
  "target": 150
}

FUNNEL CHART FORMAT (use when user asks for funnel or pipeline visualization):
{
  "type": "funnel",
  "title": "Pipeline Title",
  "description": "Why this funnel matters",
  "subtitle": "Optional micro-line beneath the chart",
  "groups": [
    {
      "label": "Group Name (e.g. Typical Firm)",
      "colorScheme": "light",
      "stages": [{"label": "Stage Name", "value": number}]
    },
    {
      "label": "Comparison Group (e.g. Optimized Firm)",
      "colorScheme": "dark",
      "stages": [{"label": "Stage Name", "value": number}]
    }
  ],
  "annotations": [
    {"afterStage": 0, "text": "Biggest Loss: Slow Follow-Up"},
    {"afterStage": 1, "text": "Leak 2: Sales Drop-Off"}
  ]
}
Note on afterStage indexing: afterStage is 0-based. afterStage 0 = between stages[0] and stages[1], afterStage 1 = between stages[1] and stages[2], etc.
` : ''}
Return valid JSON only.`;

      const openaiMessages = [
        { role: "system" as const, content: "You are editing an existing analysis. CRITICAL: Start with the CURRENT ANALYSIS as your base and only modify what the user specifically requests. Do NOT revert or change anything the user didn't ask to change. Preserve all colors, legends, labels, and data exactly as they are unless the user asks to change them. Return the COMPLETE analysis with all charts, even unchanged ones." },
        { role: "user" as const, content: prompt }
      ];

      const makeOpenAICall = async () => {
        return openai.chat.completions.create({
          model: QUALITY_MODEL,
          messages: openaiMessages,
          response_format: { type: "json_object" },
          max_completion_tokens: 4000,
        });
      };

      let response;
      try {
        response = await makeOpenAICall();
      } catch (aiError: any) {
        const status = aiError?.status || aiError?.response?.status;
        const isTransient = status === 500 || status === 502 || status === 503 || status === 504 || aiError?.code === 'ETIMEDOUT' || aiError?.code === 'ECONNRESET';

        if (isTransient) {
          console.warn(`[CEO Pulse Refine] Transient OpenAI error (status=${status}, code=${aiError?.code}), retrying in 1s...`);
          await new Promise(r => setTimeout(r, 1000));
          try {
            response = await makeOpenAICall();
          } catch (retryError: any) {
            const retryStatus = retryError?.status || retryError?.response?.status;
            console.error(`[CEO Pulse Refine] Retry also failed (status=${retryStatus}, code=${retryError?.code}):`, retryError?.message);
            return res.status(502).json({ error: "The AI service is temporarily unavailable. Please try again in a moment." });
          }
        } else if (status === 429) {
          console.warn(`[CEO Pulse Refine] Rate limited by OpenAI:`, aiError?.message);
          return res.status(429).json({ error: "AI rate limit reached. Please wait a minute before trying again." });
        } else {
          console.error(`[CEO Pulse Refine] OpenAI API error (status=${status}):`, aiError?.message);
          return res.status(502).json({ error: "The AI service encountered an error. Please try again." });
        }
      }

      const content = response.choices[0]?.message?.content || "{}";
      let result;
      try {
        result = JSON.parse(content);
      } catch (parseErr: any) {
        console.error("[CEO Pulse Refine] JSON parse error:", parseErr?.message, "| Raw content length:", content.length, "| First 200 chars:", content.substring(0, 200));
        return res.status(500).json({ error: "The AI returned an invalid response. This can happen with complex charts — please try simplifying your request." });
      }

      if (!result.analysis) {
        console.warn("[CEO Pulse Refine] Validation failed: AI response missing 'analysis' key. Keys returned:", Object.keys(result));
        return res.status(422).json({ error: "The AI returned an unexpected response format. Please try rephrasing your request." });
      }

      const graphsEnabled = pulse.includeGraphs !== false;
      let charts = graphsEnabled ? (currentAnalysis.charts || []) : [];
      let chartWasModified = false;
      const droppedCharts: { title: string; type: string }[] = [];
      if (graphsEnabled && Array.isArray(result.analysis?.charts)) {
        const totalAICharts = result.analysis.charts.length;
        const validCharts: any[] = [];
        for (const c of result.analysis.charts) {
          const validated = validateCeoPulseChart(c);
          if (validated !== null) {
            validCharts.push(validated);
          } else {
            droppedCharts.push({
              title: (c && c.title) ? String(c.title) : "(untitled)",
              type: (c && c.type) ? String(c.type) : "(unknown)",
            });
          }
        }
        if (validCharts.length > 0) {
          charts = validCharts;
          chartWasModified = true;
        }
        if (validCharts.length < totalAICharts) {
          const droppedDesc = droppedCharts.map((d) => `"${d.title}" (${d.type})`).join(", ");
          console.warn(`[CEO Pulse Refine] Chart validation: ${totalAICharts - validCharts.length}/${totalAICharts} charts dropped due to invalid data — dropped: ${droppedDesc}`);
        }
      }

      // Server-side chart-targeting guard. When the user references a chart by
      // its canonical 1-based number ("chart 3" / "{{chart-3}}"), make sure the
      // edit actually landed on THAT chart and not a neighbor. Charts render in
      // array order, so position i is "Chart i+1". If the AI edited a different
      // slot (the bug), or drifted the count on what was an in-place edit, we
      // refuse to save the mis-targeted result and report honestly instead of
      // silently overwriting the wrong chart.
      const inputCharts: any[] = graphsEnabled && Array.isArray(currentAnalysis?.charts) ? currentAnalysis.charts : [];
      const targeting = evaluateChartTargeting({
        message,
        graphsEnabled,
        inputCharts,
        charts,
        chartWasModified,
      });
      charts = targeting.charts;
      chartWasModified = targeting.chartWasModified;
      const targetingMismatchNumber = targeting.targetingMismatchNumber;
      const targetedChart = targeting.targetedChart;
      const chartsReordered = targeting.reordered;

      // Validate and normalize the analysis structure
      const analysis: any = {
        headline: result.analysis?.headline || currentAnalysis.headline || "",
        keyTakeaways: Array.isArray(result.analysis?.keyTakeaways) ? result.analysis.keyTakeaways : currentAnalysis.keyTakeaways || [],
        strategicImplications: Array.isArray(result.analysis?.strategicImplications) ? result.analysis.strategicImplications : currentAnalysis.strategicImplications || [],
        charts,
      };
      if (!graphsEnabled) {
        // Task #4834 — announcement (roadmap) briefs allow one more narrative
        // paragraph for the Why-This-Matters section (3 vs 2).
        const refineNarrativeCap = refineAnnouncementMode ? CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS : CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS;
        const incomingNarrative = Array.isArray(result.analysis?.contextNarrative)
          ? result.analysis.contextNarrative.filter((p: any) => typeof p === 'string' && p.trim().length > 0).slice(0, refineNarrativeCap)
          : null;
        // Task #4804: the preserved stored narrative is capped too, so any refine
        // write converges legacy letter-length briefs onto the short report spec.
        analysis.contextNarrative = incomingNarrative
          ?? (Array.isArray(currentAnalysis.contextNarrative)
            ? currentAnalysis.contextNarrative.filter((p: any) => typeof p === 'string' && p.trim().length > 0).slice(0, refineNarrativeCap)
            : []);
        const incomingNumbers = Array.isArray(result.analysis?.byTheNumbers)
          ? result.analysis.byTheNumbers
              .filter((s: any) => s && typeof s === 'object' && (s.label || s.value))
              .map((s: any) => ({
                label: String(s.label || ''),
                value: String(s.value || ''),
                source: s.source ? String(s.source) : undefined,
              }))
              .slice(0, 6)
          : null;
        analysis.byTheNumbers = incomingNumbers ?? (Array.isArray(currentAnalysis.byTheNumbers) ? currentAnalysis.byTheNumbers : []);
      }
      // Task #4813 — announcement mode: same caps + status sanitation as the
      // analyze route, applied to both AI-returned and preserved arrays so a
      // refine write converges any over-cap row onto the announcement spec.
      // (The stored August 2026 draft is 6/5 — exactly at the caps — so
      // refines never drop its existing items.)
      if (refineAnnouncementMode) {
        analysis.keyTakeaways = analysis.keyTakeaways
          .slice(0, CEO_PULSE_UPDATE_MAX_INITIATIVES)
          .map((t: any) => sanitizeAnnouncementStatus(t));
        analysis.strategicImplications = analysis.strategicImplications.slice(0, CEO_PULSE_UPDATE_MAX_COMMITMENTS);
        // Task #4834 / #4984 — roadmap fields: accept the AI's value when
        // valid, else fall back to the STORED value (preserve-when-omitted
        // AND preserve-when-invalid, like contextNarrative above). Both paths
        // run the same sanitizers, so a refine write converges any over-cap
        // row onto the template caps; when neither side yields a value the
        // key is omitted entirely. `analysis` is built FRESH above and the
        // retired beforeAfter/timeline keys (Task #4984) are deliberately
        // never copied from CURRENT ANALYSIS or the AI output — any AI edit
        // converges a legacy row onto the simplified shape by dropping them.
        const supportingLine = sanitizeRoadmapLine(result.analysis?.supportingLine, CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS)
          ?? sanitizeRoadmapLine(currentAnalysis.supportingLine, CEO_PULSE_UPDATE_SUPPORTING_LINE_MAX_CHARS);
        if (supportingLine !== undefined) analysis.supportingLine = supportingLine;
        const whyBullets = sanitizeWhyBullets(result.analysis?.whyBullets)
          ?? sanitizeWhyBullets(currentAnalysis.whyBullets);
        if (whyBullets !== undefined) analysis.whyBullets = whyBullets;
        const pullQuote = sanitizeRoadmapLine(result.analysis?.pullQuote, CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS)
          ?? sanitizeRoadmapLine(currentAnalysis.pullQuote, CEO_PULSE_UPDATE_PULL_QUOTE_MAX_CHARS);
        if (pullQuote !== undefined) analysis.pullQuote = pullQuote;
      }

      let responseMessage = result.message || "Updated successfully!";
      const aiReturnedCharts = Array.isArray(result.analysis?.charts) && result.analysis.charts.length > 0;
      const currentChartsJson = JSON.stringify(currentAnalysis.charts || []);
      const newChartsJson = JSON.stringify(charts);
      const chartsUnchanged = currentChartsJson === newChartsJson;
      const chartRequestRegex = /chart|graph|bar|visual|funnel|pie|donut|line|area|radar|scatter|gauge|progress|metric/i;
      const targetingMessage = buildTargetingMessage({ targetingMismatchNumber, targetedChart, reordered: chartsReordered });
      if (targetingMessage !== null) {
        responseMessage = targetingMessage;
      } else if (!graphsEnabled && (aiReturnedCharts || chartRequestRegex.test(message))) {
        responseMessage = "Charts are turned off for this brief, so nothing was added. The rest of the analysis was updated.";
      } else if (aiReturnedCharts && !chartWasModified) {
        responseMessage = "The chart data couldn't be applied because values must be numeric. The rest of the analysis was updated. Please try rephrasing your chart request.";
      } else if (graphsEnabled && droppedCharts.length > 0) {
        // Partial drop: some charts survived validation, but at least one was
        // discarded for missing numeric values. Don't rely on the AI's
        // self-reported success — name the dropped chart(s) and why.
        const droppedList = droppedCharts.map((d) => `"${d.title}"`).join(", ");
        const isSingle = droppedCharts.length === 1;
        responseMessage = `${result.message || "Updated."} However, ${isSingle ? "this chart couldn't be added" : `${droppedCharts.length} charts couldn't be added`}: ${droppedList}. A chart needs a real number for every data point, so conceptual or qualitative topics can't be charted unless you provide the specific values to plot.`;
      } else if (!aiReturnedCharts && chartsUnchanged && chartRequestRegex.test(message)) {
        responseMessage = (result.message || "Updated!") + " Note: chart changes may not have applied. Try being more specific about the numeric values you want.";
      }

      const updated = await storage.updateCeoPulse(pulse.id, { aiAnalysis: analysis });

      let chartImagesGenerated = false;
      if (graphsEnabled && analysis.charts && analysis.charts.length > 0) {
        try {
          const result = await generateAndStoreChartImages(pulse.monthKey, analysis.charts);
          chartImagesGenerated = result.success && result.generatedCount === analysis.charts.length;
        } catch (chartErr) {
          console.error("[CEO Pulse Refine] Chart image generation failed:", chartErr);
        }
      }

      res.json({ 
        pulse: updated, 
        analysis,
        message: responseMessage,
        chartImagesGenerated,
      });
    } catch (error: any) {
      const errorType = error?.constructor?.name || 'Unknown';
      console.error(`[CEO Pulse Refine] Unhandled error (type=${errorType}):`, error?.message || error);
      res.status(500).json({ error: "An unexpected error occurred while refining the analysis. Please try again." });
    }
  });

  // ── Supporting images for update briefs (Task #4293) ─────────────────────
  // Company-update editions attach uploaded images (book cover, product
  // shots) instead of — or alongside — generated chart PNGs. These are the
  // ONLY writers of ceo_pulses.supporting_images (the column is excluded
  // from the generic POST/PATCH schemas). Bytes live beside the chart PNGs
  // under the public ceo-pulse/<monthKey>/ prefix; `slot` is the stable
  // per-brief identity used by {{image-<slot>}} placeholders and object
  // keys, so reorders/deletes never retarget a letter reference.

  // Upload one image (multipart field "image"). Acceptance is decided by
  // MAGIC BYTES (JPEG/PNG/WebP) — the multer mimetype filter is advisory —
  // and the stored extension comes from the sniffed format. Slot allocation
  // and the per-brief count cap are enforced in ONE atomic UPDATE (no
  // SELECT-then-INSERT window); the object write happens after, with a
  // compensating metadata removal if storage fails.
  app.post(
    "/api/ceo-pulses/:id/images",
    isAuthenticated,
    requireCeo,
    (req: any, res, next) => {
      pulseImageUpload.single("image")(req, res, (err: unknown) => {
        if (err) {
          const tooLarge = (err as { code?: string } | null)?.code === "LIMIT_FILE_SIZE";
          const message = tooLarge
            ? `Image exceeds the ${Math.floor(CEO_PULSE_IMAGE_MAX_BYTES / (1024 * 1024))} MB limit`
            : err instanceof Error
              ? err.message
              : "Upload failed";
          return res.status(400).json({ error: message });
        }
        next();
      });
    },
    async (req: any, res) => {
      try {
        const pulse = await storage.getCeoPulse(req.params.id);
        if (!pulse) {
          return res.status(404).json({ error: "NoBull Brief not found" });
        }
        const file = req.file as { buffer?: Buffer } | undefined;
        if (!file?.buffer || file.buffer.length === 0) {
          return res.status(400).json({ error: "No image file provided (multipart field: image)" });
        }
        const sniffed = sniffUploadFormat(file.buffer.subarray(0, UPLOAD_SNIFF_HEAD_BYTES));
        const format = sniffed?.kind === "image" ? sniffed.format : null;
        const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : format === "webp" ? "webp" : null;
        if (!ext) {
          return res.status(400).json({
            error: "Unsupported image content — only JPEG, PNG, and WebP are accepted (file content is checked, not the filename)",
          });
        }
        const appended = await storage.appendCeoPulseSupportingImage(pulse.id, ext, CEO_PULSE_IMAGE_MAX_COUNT);
        if (!appended) {
          return res.status(400).json({
            error: `This brief already has the maximum of ${CEO_PULSE_IMAGE_MAX_COUNT} supporting images`,
          });
        }
        try {
          await ceoPulseImageObjects.save(pulse.monthKey, appended.slot, ext, file.buffer);
        } catch (saveErr) {
          console.error("[CEO Pulse] Supporting-image storage write failed — compensating metadata removal:", saveErr);
          try {
            await storage.removeCeoPulseSupportingImage(pulse.id, appended.slot);
          } catch (compErr) {
            // Dangling entry (broken thumbnail in the Studio) — the CEO can
            // delete it; the serving route 404s cleanly meanwhile.
            console.error("[CEO Pulse] Compensation failed — dangling image metadata entry:", compErr);
          }
          return res.status(500).json({ error: "Image storage failed — nothing was saved" });
        }
        res.status(201).json({
          slot: appended.slot,
          supportingImages: readCeoPulseSupportingImages(appended.images, { ceoPulseId: pulse.id }),
        });
      } catch (error) {
        console.error("Error uploading supporting image:", error);
        res.status(500).json({ error: "NoBull Brief operation failed" });
      }
    },
  );

  // Caption edits + reorder in one write. The body must be EXACTLY the
  // brief's current slot set in the desired display order (no adds/removes
  // here — upload and delete own those); `ext` is re-derived from stored
  // metadata so it is never client-writable. A caption of null clears; an
  // omitted caption preserves the current one.
  app.patch("/api/ceo-pulses/:id/images", isAuthenticated, requireCeo, async (req: ValidatedBodyRequest<Record<string, unknown>, { id: string }>, res) => {
    try {
      const parsed = updateCeoPulseImagesSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      const existing = readCeoPulseSupportingImages(pulse.supportingImages, { ceoPulseId: pulse.id });
      const existingBySlot = new Map(existing.map((img) => [img.slot, img]));
      const requested = parsed.data.images;
      const requestedSlots = new Set(requested.map((img) => img.slot));
      const isExactPermutation =
        requested.length === existing.length &&
        requestedSlots.size === requested.length &&
        existing.every((img) => requestedSlots.has(img.slot));
      if (!isExactPermutation) {
        return res.status(400).json({
          error: "images must contain exactly the brief's current images (caption/reorder only — use the upload and delete endpoints to add or remove)",
        });
      }
      const next = requested.map((img) => {
        const current = existingBySlot.get(img.slot)!;
        return {
          slot: img.slot,
          ext: current.ext,
          caption: img.caption === undefined ? (current.caption ?? null) : img.caption,
        };
      });
      const updated = await storage.replaceCeoPulseSupportingImages(pulse.id, next);
      if (!updated) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      res.json({
        supportingImages: readCeoPulseSupportingImages(updated.supportingImages, { ceoPulseId: pulse.id }),
      });
    } catch (error) {
      console.error("Error updating supporting images:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  // Delete one image. Metadata is removed FIRST (share payloads and letters
  // stop referencing the slot immediately); the object delete is idempotent
  // best-effort after — a failure leaves an inert, unreferenced object that
  // a retried delete or slot-reusing upload overwrites.
  app.delete("/api/ceo-pulses/:id/images/:slot", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const slotParam = req.params.slot;
      if (!/^\d{1,4}$/.test(slotParam)) {
        return res.status(400).json({ error: "Invalid image slot" });
      }
      const slot = parseInt(slotParam, 10);
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      const existing = readCeoPulseSupportingImages(pulse.supportingImages, { ceoPulseId: pulse.id });
      const entry = existing.find((img) => img.slot === slot);
      if (!entry) {
        return res.status(404).json({ error: "Image not found" });
      }
      const removed = await storage.removeCeoPulseSupportingImage(pulse.id, slot);
      try {
        await ceoPulseImageObjects.delete(pulse.monthKey, slot, entry.ext);
      } catch (delErr) {
        console.error("[CEO Pulse] Image object delete failed (metadata already removed — orphan object is inert):", delErr);
      }
      res.json({
        supportingImages: removed
          ? readCeoPulseSupportingImages(removed.images, { ceoPulseId: pulse.id })
          : existing.filter((img) => img.slot !== slot),
      });
    } catch (error) {
      console.error("Error deleting supporting image:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  app.post("/api/ceo-pulses/:id/share", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      if (pulse.shareToken) {
        return res.json({ shareToken: pulse.shareToken });
      }
      const shareToken = crypto.randomUUID();
      const updated = await storage.updateCeoPulse(pulse.id, { shareToken });
      res.json({ shareToken: updated?.shareToken || shareToken });
    } catch (error) {
      console.error("Error generating share token:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  app.post("/api/ceo-pulses/:id/regenerate-charts", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const pulse = await storage.getCeoPulse(req.params.id);
      if (!pulse) {
        return res.status(404).json({ error: "NoBull Brief not found" });
      }
      if (pulse.includeGraphs === false) {
        return res.status(400).json({ error: "Graphs are disabled for this brief. Enable graphs and re-analyze first." });
      }
      const analysis = readCeoPulseAiAnalysis(pulse.aiAnalysis, { ceoPulseId: pulse.id });
      if (!analysis?.charts || analysis.charts.length === 0) {
        return res.status(400).json({ error: "No charts in analysis to generate" });
      }
      const result = await generateAndStoreChartImages(pulse.monthKey, analysis.charts);
      res.json(result);
    } catch (error) {
      console.error("[CEO Pulse] Chart regeneration failed:", error);
      res.status(500).json({ error: "Chart generation failed" });
    }
  });

  app.get("/api/ceo-pulse/share/:token", async (req, res) => {
    try {
      const pulse = await storage.getCeoPulseByShareToken(req.params.token);
      if (!pulse || !pulse.isPublished) {
        return res.status(404).json({ error: "NoBull Brief not found or not published" });
      }

      const graphsEnabled = pulse.includeGraphs !== false;
      const chartCount = graphsEnabled ? (readCeoPulseAiAnalysis(pulse.aiAnalysis, { ceoPulseId: pulse.id })?.charts?.length || 0) : 0;
      // Task #4293 — supporting images (metadata is authoritative; no
      // per-request storage existence checks, unlike async-generated charts).
      const supportingImages = readCeoPulseSupportingImages(pulse.supportingImages, { ceoPulseId: pulse.id });
      let letterHtml = pulse.fullLetterHtml || null;
      if (letterHtml) {
        const availableIndices = graphsEnabled
          ? await checkAvailableChartImages(pulse.monthKey, chartCount)
          : new Set<number>();
        letterHtml = resolveChartPlaceholders(letterHtml, pulse.monthKey, availableIndices, {
          stripMissing: !graphsEnabled || chartCount === 0,
        });
        letterHtml = resolveImagePlaceholders(letterHtml, pulse.monthKey, supportingImages);
      }

      res.json({
        monthKey: pulse.monthKey,
        title: pulse.title,
        // Task #4268 — edition tag ("company_update" | "market_shift");
        // null for legacy briefs created before editions existed.
        edition: pulse.edition ?? null,
        aiAnalysis: pulse.aiAnalysis,
        includeGraphs: graphsEnabled,
        hasFullLetter: !!pulse.fullLetterHtml,
        fullLetterHtml: letterHtml,
        // Task #4293 — ordered supporting images for the public visual
        // ([] for legacy briefs; captions null when unset).
        supportingImages: supportingImages.map((img) => ({
          slot: img.slot,
          url: getCeoPulseImageUrl(pulse.monthKey, img.slot),
          caption: typeof img.caption === "string" && img.caption.trim().length > 0 ? img.caption : null,
        })),
      });
    } catch (error) {
      console.error("Error fetching shared pulse:", error);
      res.status(500).json({ error: "NoBull Brief operation failed" });
    }
  });

  app.get("/api/ceo-pulse-charts/:monthKey/chart-:index.png", async (req, res) => {
    try {
      const { monthKey } = req.params;
      const index = req.params.index;

      if (!/^\d{4}-\d{2}$/.test(monthKey) || !/^\d+$/.test(index)) {
        return res.status(400).json({ error: "Invalid parameters" });
      }

      const pulse = await storage.getCeoPulseByMonth(monthKey);
      if (!pulse || !pulse.isPublished) {
        return res.status(404).json({ error: "Chart image not found" });
      }

      const objService = new ObjectStorageService();
      const file = await objService.searchPublicObject(`ceo-pulse/${monthKey}/chart-${index}.png`);
      if (!file) {
        return res.status(404).json({ error: "Chart image not found" });
      }
      await objService.downloadObject(file, res, 3600);
    } catch (error) {
      console.error("Error serving chart image:", error);
      res.status(500).json({ error: "Failed to serve chart image" });
    }
  });

  // Task #4293 — supporting-image serving, same route family and
  // published-pulse gate as the chart PNGs above (intentional_public row in
  // scripts/route-public-allowlist.json, pre-approved in the task plan).
  // Two deliberate differences from the chart route:
  //   • The URL carries NO extension — the object key's extension comes
  //     ONLY from stored metadata, so the public surface never turns a
  //     request string into a storage path suffix.
  //   • An authenticated CEO bypasses the published gate (Studio draft
  //     preview). Everyone else gets the same 404 as a missing image, so an
  //     unpublished brief's existence never leaks through this route.
  app.get("/api/ceo-pulse-charts/:monthKey/image-:slot", async (req: any, res) => {
    try {
      const { monthKey } = req.params;
      const slotParam = req.params.slot;
      if (!/^\d{4}-\d{2}$/.test(monthKey) || !/^\d{1,4}$/.test(slotParam)) {
        return res.status(400).json({ error: "Invalid parameters" });
      }
      const slot = parseInt(slotParam, 10);

      const pulse = await storage.getCeoPulseByMonth(monthKey);
      if (!pulse) {
        return res.status(404).json({ error: "Image not found" });
      }
      if (!pulse.isPublished) {
        // Optional auth (Clerk-era): resolve the local user id the same way
        // requireAuth does — test seam first (NODE_ENV=test), then Clerk
        // session claims (sessionClaims.userId = migrated legacy sub kept as
        // externalId; auth.userId = Clerk native id). Anonymous/unknown users
        // fall through to the same non-leaking 404 as a missing image.
        let sub: string | null = null;
        if (process.env.NODE_ENV === "test" && (req as any).__test_clerkUserId !== undefined) {
          sub = (req as any).__test_clerkUserId ?? null;
        } else {
          try {
            const auth = getAuth(req);
            sub = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId || null;
          } catch {
            sub = null; // Clerk middleware not mounted — unauthenticated.
          }
        }
        const user = sub ? await storage.getUser(sub) : null;
        if (!user || !hasRole(user.role, "ceo")) {
          return res.status(404).json({ error: "Image not found" });
        }
      }

      const images = readCeoPulseSupportingImages(pulse.supportingImages, { ceoPulseId: pulse.id });
      const entry = images.find((img) => img.slot === slot);
      if (!entry) {
        return res.status(404).json({ error: "Image not found" });
      }
      const served = await ceoPulseImageObjects.serve(monthKey, slot, entry.ext, res);
      if (!served) {
        return res.status(404).json({ error: "Image not found" });
      }
    } catch (error) {
      console.error("Error serving supporting image:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to serve image" });
      }
    }
  });

  // --------------------------------------------
  // REPORTS API
  // --------------------------------------------
  app.get("/api/reports", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Parse pagination params (optional)
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 0; // 0 = no pagination
      const offset = limit > 0 ? (page - 1) * limit : 0;
      
      if (limit > 0) {
        const result = await storage.getReportsPaginated(limit, offset);
        return res.json({ data: result.data, total: result.total, page, limit });
      }
      const reports = await storage.getReports();
      return res.json(reports);
    } catch (error) {
      console.error("Error fetching reports:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.get("/api/reports/matrix", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);

      const isCeo = user?.role === 'ceo';
      const allClients = await storage.getClients();

      const activeClients = allClients.filter(c => {
        if (c.isArchived) return false;
        if (!isCeo && c.isDemo) return false;
        return true;
      });

      const clientIds = activeClients.map(c => c.id);

      let allReportsWithSummary: Array<{
        id: string;
        clientId: string;
        reportMonth: string;
        status: string | null;
        shareToken: string | null;
        updatedAt: Date | null;
        // Task #4537 — presented/delivered mark, surfaced so matrix cells
        // can distinguish final+presented from final-but-not-presented.
        presentedAt: Date | null;
        totalLeads: number;
        totalCases: number;
      }> = [];

      if (clientIds.length > 0) {
        const baseReports = await db.select({
          id: reports.id,
          clientId: reports.clientId,
          reportMonth: reports.reportMonth,
          status: reports.status,
          shareToken: reports.shareToken,
          updatedAt: reports.updatedAt,
          presentedAt: reports.presentedAt,
        }).from(reports).where(inArray(reports.clientId, clientIds));

        const reportIds = baseReports.map(r => r.id);
        const sectionRows = reportIds.length > 0
          ? await db.select({
              reportId: reportSections.reportId,
              sectionKey: reportSections.sectionKey,
              data: reportSections.data,
            }).from(reportSections)
              .where(and(
                inArray(reportSections.reportId, reportIds),
                inArray(reportSections.sectionKey, ['marketing', 'sales'])
              ))
          : [];

        const sectionMap = new Map<string, Map<string, unknown>>();
        for (const s of sectionRows) {
          if (!sectionMap.has(s.reportId)) sectionMap.set(s.reportId, new Map());
          sectionMap.get(s.reportId)!.set(s.sectionKey, s.data);
        }

        allReportsWithSummary = baseReports.map(r => {
          const sections = sectionMap.get(r.id);
          const marketingData = readMarketingSection(sections?.get('marketing'), { reportId: r.id, clientId: r.clientId });
          const salesData = readSalesSection(sections?.get('sales'), { reportId: r.id, clientId: r.clientId });
          return {
            ...r,
            totalLeads: parseInt(String(marketingData?.totalLeads ?? 0)) || 0,
            totalCases: parseInt(String(salesData?.totalCases ?? 0)) || 0,
          };
        });
      }

      const reportsByClient = new Map<string, typeof allReportsWithSummary>();
      for (const r of allReportsWithSummary) {
        const list = reportsByClient.get(r.clientId) || [];
        list.push(r);
        reportsByClient.set(r.clientId, list);
      }

      const rows = activeClients.map(client => {
        const clientReports = reportsByClient.get(client.id) || [];
        const reportMap: Record<string, any> = {};
        for (const r of clientReports) {
          reportMap[r.reportMonth] = {
            id: r.id,
            status: r.status,
            shareToken: r.shareToken,
            totalLeads: r.totalLeads,
            totalCases: r.totalCases,
            updatedAt: r.updatedAt,
            // Task #4537 — operators scan delivery coverage on the matrix.
            presentedAt: r.presentedAt,
          };
        }
        return {
          clientId: client.id,
          firmName: client.firmName,
          clientCode: client.clientCode,
          // Task #4363 — same marker as the "Demo Account" badge, so the
          // global hide-demo toggle can filter client-side (CEO is the only
          // role that still sees demo rows here).
          isDemo: !!client.isDemo,
          reports: reportMap,
        };
      });

      res.json(rows);
    } catch (error) {
      console.error("Error fetching report matrix:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.get("/api/reports/:id", isAuthenticated, async (req: any, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const client = await storage.getClient(report.clientId);

      // Task #1785: opening a report by an authenticated operator
      // counts as activity for the demand-driven SEMrush gate. Best-
      // effort, never blocks. Public/anonymous report views go through
      // a separate unauthenticated route and are deliberately excluded.
      if (report.clientId) {
        try {
          const { markClientViewed } = await import(
            "../services/semrushCadenceGate"
          );
          void markClientViewed(report.clientId, "report:fetch");
        } catch {}
      }

      const sections = await hydrateSectionEditors(
        normalizeSections(await storage.getReportSections(report.id)),
      );

      // Task #2493: heal manually-uploaded heatmap screenshots that predate the
      // explicit-public-ACL fix so they render in the operator editor too
      // (canAccessObjectEntity also 403s a no-policy object for the operator).
      // Scoped to objects already referenced as a location heatmap; best-effort.
      try {
        const { ensureHeatmapImagesPublic, ensureHeatmapThumbVariants } =
          await import("../services/heatmapImageAcl");
        const heatmapStorage = new ObjectStorageService();
        await ensureHeatmapImagesPublic(
          heatmapStorage,
          sections,
          userId ?? report.createdBy ?? "heatmap-heal",
        );
        // Task #4544 — heal legacy scans' `__thumb` variants here (the
        // authenticated editor read, not the public serve path) so 56px
        // thumbnails stop pulling multi-MP originals. One metadata read per
        // referenced object once the variant exists.
        await ensureHeatmapThumbVariants(
          heatmapStorage,
          sections,
          userId ?? report.createdBy ?? "heatmap-heal",
        );
      } catch (err) {
        console.warn("[reports] heatmap ACL heal (editor) skipped:", err);
      }

      // Task #2652 — "Re-parse from Source" is available whenever the report
      // has a re-parseable source: a saved private copy of the PDF (survives
      // Zapier link expiry) OR an original source URL on the import log.
      let hasStoredPdfUrl = !!report.sourcePdfStorageKey;
      if (!hasStoredPdfUrl && report.webhookImportLogId) {
        const [importLog] = await db.select({ pdfSourceUrl: webhookImportLogs.pdfSourceUrl }).from(webhookImportLogs).where(eq(webhookImportLogs.id, report.webhookImportLogId));
        hasStoredPdfUrl = !!importLog?.pdfSourceUrl;
      }

      // Task #4537 — resolve the presenter identity for the editor caption
      // ("Presented by X on date"). Operator-facing payload only: the
      // anonymous share/demo payloads are built by buildReportResponse,
      // whose report allowlist deliberately excludes the presented columns.
      let presentedByUser:
        | { id: string; firstName: string | null; lastName: string | null; email: string | null }
        | null = null;
      if (report.presentedBy) {
        const presenter = await storage.getUser(report.presentedBy);
        if (presenter) {
          presentedByUser = {
            id: presenter.id,
            firstName: presenter.firstName ?? null,
            lastName: presenter.lastName ?? null,
            email: presenter.email ?? null,
          };
        }
      }

      res.json({ ...report, sections, hasStoredPdfUrl, presentedByUser });
    } catch (error) {
      console.error("Error fetching report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.post("/api/ai/format-issues", isAuthenticated, aiLimiter, async (req: any, res: any) => {
    try {
      const { text, section, reportId } = req.body;
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }
      if (text.length > 5000) {
        return res.status(400).json({ error: "Text too long (max 5000 characters)" });
      }
      // Task #2389 — the AI formatting + the Task #1267 missing-data-source
      // guard now live in a shared service so import code paths can reuse them.
      // formatCommonIssuesContent never throws: on any AI failure it degrades
      // to a deterministic fallback (OCR cleanup + marker-based splitting) so
      // the caller always gets readable, structured text instead of the raw
      // run-on blob.
      const { formatCommonIssuesContent } = await import(
        "../services/commonIssuesFormatter"
      );
      const sectionKind = section === "sales" ? "sales" : "intake";

      // Task #2460 — when the caller passes a reportId, resolve that section's
      // conversion rate + the client's consult type so the formatter tone can
      // scale with performance. Best-effort: if the report/section/rate isn't
      // available yet (e.g. rates not entered), fall through to neutral tone.
      let metricContext: { rate: number; consultType: "free" | "paid" } | undefined;
      if (reportId && typeof reportId === "string") {
        try {
          const report = await storage.getReport(reportId);
          if (report?.clientId) {
            const client = await storage.getClient(report.clientId);
            const consultType = client?.consultType === "paid" ? "paid" : "free";
            const sections = await storage.getReportSections(reportId);
            const sectionRow = sections.find((s) => s.sectionKey === sectionKind);
            const data =
              sectionKind === "sales"
                ? readSalesSection(sectionRow?.data, { sectionId: sectionRow?.id, reportId })
                : readIntakeSection(sectionRow?.data, { sectionId: sectionRow?.id, reportId });
            const rate =
              sectionKind === "sales"
                ? data.consultToCaseRate
                : data.leadToConsultRate;
            if (typeof rate === "number" && Number.isFinite(rate)) {
              metricContext = { rate, consultType };
            }
          }
        } catch (e: any) {
          console.warn(
            `[AI Format] Could not resolve performance context for report ${reportId}: ${e?.message}`,
          );
        }
      }

      const { formatted, degraded } = await formatCommonIssuesContent(
        text,
        sectionKind,
        metricContext,
      );
      res.json({ formatted, degraded });
    } catch (error: any) {
      console.error("[AI Format] Error:", error?.message);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.post("/api/reports/import-pdf", isAuthenticated, requireAccountManager, upload.single('pdf'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }
      
      const parsedData = await parseReportPdf(req.file.buffer);

      // Task #2475 — format the parsed Common Issues server-side BEFORE returning
      // so a manually-uploaded PDF lands the same clean 🔴 Issue / ↳ Impact /
      // ➡️ Strategic Fix markdown the unattended webhook import (Task #2389)
      // already produces, instead of the raw OCR run-on blob. Previously this
      // route returned the raw parsed text and only the frontend's interactive
      // "Format" step (POST /api/ai/format-issues) could clean it up, so a hand
      // import could still persist a wall-of-text section. This route is a
      // stateless parse with no client/report in scope, so the formatter runs
      // with NEUTRAL tone (no metric context — Task #2460 tone scaling only
      // applies where rates/consultType are known). formatCommonIssuesContent
      // never throws: it degrades to the deterministic OCR-cleanup + marker-split
      // fallback when the AI formatter is unavailable, and runs outside any DB
      // hold (DB-hold rule: no AI work inside a held scope).
      const { formatCommonIssuesContent } = await import(
        "../services/commonIssuesFormatter"
      );
      const [intakeIssuesFormatted, salesIssuesFormatted] = await Promise.all([
        formatCommonIssuesContent(parsedData.intake?.commonIssues || "", "intake"),
        formatCommonIssuesContent(parsedData.sales?.commonIssues || "", "sales"),
      ]);
      // Task #4054 — hand the editor normalized text so the later section PUT
      // (the actual persist path for manual uploads) stores well-formed data.
      if (parsedData.intake) parsedData.intake.commonIssues = finalizeCommonIssuesForStorage(intakeIssuesFormatted.formatted).text;
      if (parsedData.sales) parsedData.sales.commonIssues = finalizeCommonIssuesForStorage(salesIssuesFormatted.formatted).text;
      if (intakeIssuesFormatted.degraded) {
        console.warn(`[PDF Import] Intake Common Issues used deterministic fallback (${intakeIssuesFormatted.reason})`);
      }
      if (salesIssuesFormatted.degraded) {
        console.warn(`[PDF Import] Sales Common Issues used deterministic fallback (${salesIssuesFormatted.reason})`);
      }

      // Task #3769 — surface which sections' RAW Common Issues matched the
      // "Missing data source" placeholder (the parsed value itself is ""
      // then, so the field-confidence source is the only surviving signal).
      // The client echoes this back as `importMeta` on the section PUTs it
      // makes with editSource 'manual_pdf_upload', where the server combines
      // it with the missing-vs-prior funnel check to persist the
      // broken-source import warning.
      const { rawCommonIssuesMatchedPlaceholder } = await import(
        "../services/reportImportWarnings"
      );
      const placeholderSections = (["intake", "sales"] as const).filter((s) =>
        rawCommonIssuesMatchedPlaceholder(parsedData.fieldConfidence, s),
      );

      const { _extractedText, ...responseData } = parsedData as any;
      res.json({
        ...responseData,
        importMeta: { placeholderSections },
      });
    } catch (error: any) {
      console.error(`[PDF Import] Failed to parse ${req.file?.originalname}:`, error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // --------------------------------------------
  // WEBHOOK: Auto-draft report from scheduled PDF
  // --------------------------------------------
  // INTENTIONALLY PUBLIC ENDPOINT: this route is hit by an external scheduler/webhook
  // and therefore cannot use session-based isAuthenticated. Authentication is enforced
  // inside the handler via either the Authorization Bearer CEO_TOOLS_API_TOKEN or the
  // x-webhook-secret header matching WEBHOOK_SECRET. Requests are rejected with 401
  // when either secret is configured and does not match.
  app.post("/api/webhooks/report-import", upload.single('pdf'), async (req: any, res) => {
    const startTime = Date.now();

    // Track A — A-002: authenticate BEFORE any DB write or further work.
    // Previously this handler inserted a `webhook_import_logs` row before the
    // secret was validated, which let an unauth caller amplify storage. Also
    // hard-fail in production when neither secret is configured, instead of
    // silently allowing the request through.
    {
      const authHeader = req.headers.authorization;
      const webhookSecret = req.headers['x-webhook-secret'] as string | undefined;
      const webhookToken = process.env.CEO_TOOLS_API_TOKEN;
      const envWebhookSecret = process.env.WEBHOOK_SECRET;

      const bearerValid = !!(authHeader && authHeader.startsWith('Bearer ') && webhookToken && authHeader.substring(7) === webhookToken);
      const secretValid = !!(envWebhookSecret && webhookSecret && webhookSecret === envWebhookSecret);

      if (!webhookToken && !envWebhookSecret) {
        if (process.env.NODE_ENV === 'production') {
          console.error("[Webhook] report-import: no WEBHOOK_SECRET or CEO_TOOLS_API_TOKEN configured in production — refusing request");
          return res.status(503).json({ error: "Webhook auth not configured" });
        }
        console.warn("[Webhook] No WEBHOOK_SECRET or CEO_TOOLS_API_TOKEN configured — skipping auth check in dev");
      } else if (!bearerValid && !secretValid) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const sanitizedPayload: Record<string, any> = { ...req.body };
    if (sanitizedPayload.pdf && typeof sanitizedPayload.pdf === 'string' && sanitizedPayload.pdf.length > 200) {
      sanitizedPayload.pdf = `[base64_data:${sanitizedPayload.pdf.length}_chars]`;
    }
    const logData: Record<string, any> = {
      clientId: req.body?.clientId || null,
      reportMonth: req.body?.reportMonth || null,
      pdfFileName: req.file?.originalname || null,
      pdfSizeBytes: req.file?.size || null,
      status: "pending",
      webhookPayload: sanitizedPayload,
    };

    let savedLogId: string | null = null;
    async function saveLog(): Promise<string | null> {
      logData.durationMs = Date.now() - startTime;
      try {
        if (savedLogId) {
          await db.update(webhookImportLogs).set(logData).where(eq(webhookImportLogs.id, savedLogId));
          return savedLogId;
        }
        const [inserted] = await db.insert(webhookImportLogs).values(logData).returning({ id: webhookImportLogs.id });
        savedLogId = inserted?.id || null;
        return savedLogId;
      } catch (e: any) {
        console.error("[Webhook] Failed to save import log:", e?.message);
        return savedLogId;
      }
    }

    try {

      const { clientId, reportMonth } = req.body;
      if (!clientId) {
        logData.status = "validation_error";
        logData.errorMessage = "clientId is required";
        await saveLog();
        return res.status(400).json({ error: "clientId is required" });
      }
      if (!reportMonth || !/^\d{4}-\d{2}$/.test(reportMonth)) {
        logData.status = "validation_error";
        logData.errorMessage = "reportMonth is required in YYYY-MM format";
        await saveLog();
        return res.status(400).json({ error: "reportMonth is required in YYYY-MM format" });
      }
      let pdfBuffer: Buffer;
      let pdfSource: string;
      const MAX_PDF_SIZE = 10 * 1024 * 1024;

      function isPrivateIp(ip: string): boolean {
        const v4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (v4Match) {
          const [, a, b, , ] = v4Match.map(Number);
          if (a === 0 || a === 10 || a === 127) return true;
          if (a === 172 && b >= 16 && b <= 31) return true;
          if (a === 192 && b === 168) return true;
          if (a === 169 && b === 254) return true;
          if (a >= 224) return true;
          return false;
        }
        const lower = ip.toLowerCase();
        if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd') || lower.startsWith('ff') || lower.startsWith('::ffff:')) return true;
        return false;
      }

      async function validateUrlSafety(url: string): Promise<void> {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          throw new Error("Only HTTP(S) URLs are supported");
        }
        const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const blockedHosts = ['localhost', 'metadata.google.internal', '169.254.169.254'];
        if (blockedHosts.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
          throw new Error("URL points to a restricted/private host");
        }
        if (isPrivateIp(hostname)) {
          throw new Error("URL points to a private/internal IP address");
        }
        const dns = await import('dns');
        const { promisify } = await import('util');
        const lookup = promisify(dns.lookup);
        try {
          const result = await lookup(hostname, { all: true });
          const results = Array.isArray(result) ? result : [result];
          for (const entry of results) {
            if (isPrivateIp(entry.address)) {
              throw new Error("URL hostname resolves to a private/internal IP address");
            }
          }
        } catch (e: any) {
          if (e.message?.includes('private') || e.message?.includes('restricted')) throw e;
          // F10 (Task #4156): normalized message + preserved cause — a
          // non-Error rejection used to interpolate "undefined" and the
          // original lookup error was dropped entirely.
          const msg = typeof e?.message === "string" && e.message ? e.message : String(e);
          throw new Error(`DNS resolution failed for ${hostname}: ${msg}`, { cause: e });
        }
      }

      async function fetchPdfFromUrl(url: string, maxRedirects: number = 5): Promise<Buffer> {
        let currentUrl = url;
        for (let i = 0; i <= maxRedirects; i++) {
          await validateUrlSafety(currentUrl);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });

            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get('location');
              if (!location) throw new Error(`Redirect ${response.status} without Location header`);
              currentUrl = new URL(location, currentUrl).toString();
              clearTimeout(timeout);
              if (i === maxRedirects) throw new Error("Too many redirects (max 5)");
              continue;
            }

            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            const contentType = response.headers.get('content-type')?.toLowerCase() || '';
            if (contentType && !contentType.includes('application/pdf') && !contentType.includes('application/octet-stream') && !contentType.includes('binary/octet-stream')) {
              throw new Error(`Remote URL returned non-PDF content type: ${contentType}`);
            }
            const contentLength = response.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > MAX_PDF_SIZE) {
              throw new Error("Remote PDF exceeds 10MB size limit (content-length)");
            }
            const chunks: Buffer[] = [];
            let totalSize = 0;
            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error("Unable to read response body");
            }
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalSize += value.length;
              if (totalSize > MAX_PDF_SIZE) {
                void reader.cancel(); // fire-and-forget: aborting the stream on size-cap breach
                throw new Error("Remote PDF exceeds 10MB size limit");
              }
              chunks.push(Buffer.from(value));
            }
            return Buffer.concat(chunks);
          } finally {
            clearTimeout(timeout);
          }
        }
        throw new Error("Too many redirects (max 5)");
      }

      function isUrl(value: string): boolean {
        const trimmed = value.trim();
        return trimmed.startsWith('http://') || trimmed.startsWith('https://');
      }

      function validatePdfBuffer(buffer: Buffer): string | null {
        if (buffer.length > MAX_PDF_SIZE) {
          return "PDF exceeds 10MB size limit";
        }
        if (buffer.length === 0) {
          return "Fetched PDF is empty";
        }
        const header = buffer.subarray(0, 5).toString('ascii');
        if (!header.startsWith('%PDF')) {
          return "Fetched data is not a valid PDF (missing %PDF header)";
        }
        return null;
      }

      if (req.file) {
        pdfBuffer = req.file.buffer;
        pdfSource = "multipart_upload";
        logData.pdfSourceType = "multipart_upload";
      } else if (req.body?.pdfUrl) {
        logData.pdfSourceType = "explicit_pdfUrl";
        const pdfUrl = req.body.pdfUrl;
        if (typeof pdfUrl !== 'string' || !isUrl(pdfUrl)) {
          logData.status = "validation_error";
          logData.errorMessage = "body.pdfUrl must be a valid HTTP(S) URL";
          await saveLog();
          return res.status(400).json({ error: "body.pdfUrl must be a valid HTTP(S) URL" });
        }
        try {
          pdfBuffer = await fetchPdfFromUrl(pdfUrl.trim());
        } catch (e: any) {
          const msg = e?.name === 'AbortError'
            ? "Timeout fetching PDF from URL (30s limit exceeded)"
            : `Failed to fetch PDF from URL: ${e?.message || 'unknown error'}`;
          logData.status = "fetch_error";
          logData.errorMessage = msg;
          await saveLog();
          return res.status(400).json({ error: msg });
        }
        const validationError = validatePdfBuffer(pdfBuffer);
        if (validationError) {
          logData.status = "validation_error";
          logData.errorMessage = validationError;
          await saveLog();
          return res.status(400).json({ error: validationError });
        }
        pdfSource = "explicit_pdfUrl";
        logData.pdfSizeBytes = pdfBuffer.length;
        logData.pdfFileName = req.body.pdfFileName || "zapier-upload.pdf";
        logData.pdfSourceUrl = pdfUrl.trim();
      } else if (req.body?.pdf) {
        if (typeof req.body.pdf !== 'string') {
          logData.status = "validation_error";
          logData.errorMessage = "body.pdf must be a URL or base64-encoded string";
          await saveLog();
          return res.status(400).json({ error: "body.pdf must be a URL or base64-encoded string" });
        }
        const pdfField = req.body.pdf as string;
        if (isUrl(pdfField)) {
          logData.pdfSourceType = "url_in_pdf_field";
          try {
            pdfBuffer = await fetchPdfFromUrl(pdfField.trim());
          } catch (e: any) {
            const msg = e?.name === 'AbortError'
              ? "Timeout fetching PDF from URL (30s limit exceeded)"
              : `Failed to fetch PDF from URL: ${e?.message || 'unknown error'}`;
            logData.status = "fetch_error";
            logData.errorMessage = msg;
            await saveLog();
            return res.status(400).json({ error: msg });
          }
          const validationError = validatePdfBuffer(pdfBuffer);
          if (validationError) {
            logData.status = "validation_error";
            logData.errorMessage = validationError;
            await saveLog();
            return res.status(400).json({ error: validationError });
          }
          pdfSource = "url_in_pdf_field";
          logData.pdfSizeBytes = pdfBuffer.length;
          logData.pdfFileName = req.body.pdfFileName || "zapier-upload.pdf";
          logData.pdfSourceUrl = pdfField.trim();
        } else {
          logData.pdfSourceType = "base64_body";
          let base64Data = pdfField;
          const dataUriMatch = base64Data.match(/^data:[^;]*;base64,(.*)$/);
          if (dataUriMatch) {
            base64Data = dataUriMatch[1];
          }
          base64Data = base64Data.replace(/^hydrate\|\|/, '').replace(/\|\|hydrate$/, '').trim();
          const looksBase64 = !base64Data.startsWith('%PDF') && /^[A-Za-z0-9+/\r\n]+=*$/.test(base64Data);
          if (looksBase64) {
            while (base64Data.length % 4 !== 0) base64Data += '=';
            const MAX_BASE64_LENGTH = Math.ceil(MAX_PDF_SIZE * 4 / 3);
            if (base64Data.length > MAX_BASE64_LENGTH) {
              logData.status = "validation_error";
              logData.errorMessage = "base64 PDF exceeds 10MB size limit";
              await saveLog();
              return res.status(400).json({ error: "PDF exceeds 10MB size limit" });
            }
            pdfBuffer = Buffer.from(base64Data, 'base64');
          } else {
            pdfBuffer = Buffer.from(base64Data, 'latin1');
          }
          if (pdfBuffer.length > MAX_PDF_SIZE) {
            logData.status = "validation_error";
            logData.errorMessage = "PDF exceeds 10MB size limit";
            await saveLog();
            return res.status(400).json({ error: "PDF exceeds 10MB size limit" });
          }
          if (pdfBuffer.length === 0) {
            logData.status = "validation_error";
            logData.errorMessage = "Decoded PDF is empty";
            await saveLog();
            return res.status(400).json({ error: "Decoded PDF is empty" });
          }
          const header = pdfBuffer.subarray(0, 5).toString('ascii');
          if (!header.startsWith('%PDF')) {
            logData.status = "validation_error";
            logData.errorMessage = "Decoded data is not a valid PDF (missing %PDF header)";
            await saveLog();
            return res.status(400).json({ error: "Decoded data is not a valid PDF (missing %PDF header)" });
          }
          pdfSource = "base64_body";
          logData.pdfSizeBytes = pdfBuffer.length;
          logData.pdfFileName = req.body.pdfFileName || "zapier-upload.pdf";
        }
      } else {
        logData.status = "validation_error";
        logData.errorMessage = "PDF file is required (field name: 'pdf') — upload as multipart, send base64 in body.pdf, or provide a URL in body.pdf or body.pdfUrl";
        await saveLog();
        return res.status(400).json({ error: "PDF file is required — upload as multipart file (field: 'pdf'), send base64-encoded string in body.pdf, or provide a URL in body.pdf or body.pdfUrl" });
      }

      logData.pdfSourceType = pdfSource;

      // Task #1848 — fetch phase: keep the client + existing-report lookups
      // inside a labelled scope so attribution rollups can distinguish them
      // from the later parse + compute + persist phases. The PDF parse
      // (parseReportPdf — CPU heavy) runs OUTSIDE any DB-attribution scope
      // so it never holds a connection through the layout/extract work.
      const fetchResult = await withDbAttribution(
        "reports:webhook-import:fetch",
        async () => {
          let c = await storage.getClient(clientId);
          if (!c) {
            c = await storage.getClientByCode(clientId);
          }
          if (!c) {
            return { ok: false as const };
          }
          const existing = await storage.getReportsByClient(c.id);
          return { ok: true as const, client: c, existingReports: existing };
        },
      );
      if (!fetchResult.ok) {
        logData.status = "client_not_found";
        logData.errorMessage = `Client ${clientId} not found`;
        await saveLog();
        return res.status(404).json({ error: "Client not found" });
      }
      const client = fetchResult.client;
      logData.clientName = client.firmName;

      const resolvedClientId = client.id;
      const existingReports = fetchResult.existingReports;
      const existingReport = existingReports.find(r => r.reportMonth === reportMonth);
      // Webhook policy: always upsert. If a report already exists for this
      // (client, month), reuse its id and let the section writes below
      // overwrite via storage.upsertReportSection. Manual reimports go
      // through the per-field consent modal in the UI; webhook ingest is
      // trusted automation and should not be blocked by duplicate guards.
      let upsertReportId: string | null = null;
      // Task #2828 — when the upsert is about to overwrite a report an
      // operator already touched (hand edits in report_section_history with
      // a human editor, or status = final), the overwrite still proceeds
      // (webhook ingest stays trusted automation) but the client owner must
      // be told. Capture the "protected" state HERE — before the section
      // writes below append fresh `system:pdf-webhook` history rows — and
      // fire the inbox notification after the import succeeds.
      let overwriteNotifyReasons: string[] = [];
      if (existingReport) {
        upsertReportId = existingReport.id;
        logData.reportId = existingReport.id;
        console.log(`[Webhook] Upserting into existing report ${existingReport.id} (status=${existingReport.status}) for ${client.firmName} (${reportMonth})`);
        if (existingReport.status === "final") {
          overwriteNotifyReasons.push("finalized");
        }
        try {
          const priorHistory = await withDbAttribution(
            "reports:webhook-import:fetch",
            async () => storage.getReportSectionHistory(existingReport.id),
          );
          // Human editors are recorded as `user:<id>` (section PUT) or a
          // bare user id (report create seed); automation always writes a
          // `system:*` editor. `unknown` is the storage-layer fallback for
          // a missing attribution — treat it as non-human.
          const hasHumanEdits = priorHistory.some(
            (h) =>
              h.dataChanged !== false &&
              typeof h.editedBy === "string" &&
              h.editedBy.length > 0 &&
              !h.editedBy.startsWith("system:") &&
              h.editedBy !== "unknown",
          );
          if (hasHumanEdits) {
            overwriteNotifyReasons.push("hand-edited");
          }
        } catch (histErr: any) {
          // Best-effort: a history read failure must never block the
          // import. Err on the side of notifying if the report was final;
          // otherwise we simply can't prove edits and stay silent.
          console.warn(
            `[Webhook] Could not read section history for overwrite-warning check on report ${existingReport.id}: ${histErr?.message || histErr}`,
          );
        }
      }

      const parsed = await parseReportPdf(pdfBuffer);

      // Task #1028: Active-Products gate. Drop platform blocks for products
      // the client doesn't actually own before any aggregate is computed or
      // any section row is written. Routed through the canonical resolver so
      // we get `source` + `unknownValues` metadata in the audit log.
      const webhookResolution = await getActiveProductsForClient(resolvedClientId);
      logResolution("webhook_report_import", webhookResolution);
      const webhookActiveProducts = webhookResolution.products;
      applyActiveProductsFilter(parsed.marketing, webhookActiveProducts, {
        source: "webhook_report_import",
        clientId: resolvedClientId,
      });

      const configuredLocations = await storage.getClientLocations(resolvedClientId);

      let heatmapMapping: Record<string, string[]> = {};
      try {
        const { getSnapshotIdsForReportMonth } = await import("../services/heatmapService");
        heatmapMapping = await getSnapshotIdsForReportMonth(resolvedClientId, reportMonth);
      } catch (e: any) {
        console.warn("[Webhook] Failed to auto-pull heatmap snapshots:", e?.message);
      }

      // Task #1848 — short labelled fetch/create hold for the report row
      // itself. Parse + downstream compute (rates, lead-quality rollups,
      // local-dominance bulk fetch) happen outside this scope.
      const report = await withDbAttribution(
        "reports:webhook-import:report-row",
        async () =>
          upsertReportId
            ? (await storage.getReport(upsertReportId))!
            : await storage.createReport({
                clientId: resolvedClientId,
                reportMonth,
                status: "draft",
              }),
      );

      const totalLeads = (parsed.marketing?.totalLeads || 0);
      // Task #1028: Per-platform Lead Quality used by the public renderer's GBP
      // card. Always derived from gbpLocations after the Active-Products gate
      // ran, so non-GBP clients now contribute zero (instead of ghost NoData).
      const gbpLeadQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
      if (parsed.marketing?.gbpLocations?.length > 0) {
        for (const loc of parsed.marketing.gbpLocations) {
          gbpLeadQuality.good += loc.leadQuality?.good || 0;
          gbpLeadQuality.notQuotable += loc.leadQuality?.notQuotable || 0;
          gbpLeadQuality.missedCalls += loc.leadQuality?.missedCalls || 0;
          gbpLeadQuality.noData += loc.leadQuality?.noData || 0;
        }
      }
      // Task #1028: `allLeadQuality` is the legacy roll-up persisted onto the
      // marketing section. Build it through `aggregateActiveLeadQuality` so
      // inactive-product Lead Quality NEVER contributes — even if a stale
      // value somehow slipped past the structural filter above.
      const allLeadQuality = aggregateActiveLeadQuality(parsed.marketing, webhookActiveProducts);

      // Task #2680 — the missed-call numerator and the total-leads denominator
      // must come from the SAME lead set. `allLeadQuality` (active products)
      // excludes Other, but `totalLeads` (parsed grand total) includes it, so
      // fold Other's missed calls back into the numerator and then apply the
      // per-client hideOtherLeads toggle symmetrically to BOTH sides. Clamped
      // so a numerator/denominator mismatch can never persist an absurd value.
      const otherMissedCalls = parsed.marketing?.otherLeads?.leadQuality?.missedCalls || 0;
      const otherLeadCount = parsed.marketing?.otherLeads?.total || 0;
      const mcAdjusted = applyHideOtherLeads({
        missedCalls: allLeadQuality.missedCalls + otherMissedCalls,
        totalLeads,
        otherMissedCalls,
        otherLeadCount,
        hideOtherLeads: client?.hideOtherLeads === true,
      });
      // Task #4983 — three-tier resolution (shared resolver): bucket evidence
      // → recompute; else this PDF's parsed headline rate > 0 → clamped
      // stored; else null. Bare lead volume no longer stamps a fabricated 0
      // (the bucket fields are structural defaults unless the client's call
      // reporting pushed them). Null falls through to the prior stored rate
      // below once the existing sections are read.
      const resolvedMissedCallRate = resolveMissedCallRate({
        bucketMissedCalls: mcAdjusted.missedCalls,
        totalLeads: mcAdjusted.totalLeads,
        storedRate: parsed.intake?.missedCallRate,
      });

      const leadToConsultRate = totalLeads > 0 && parsed.intake?.totalConsults > 0
        ? Math.round((parsed.intake.totalConsults / totalLeads) * 1000) / 10
        : 0;

      const consultToCaseRate = parsed.intake?.totalConsults > 0 && parsed.sales?.totalCases > 0
        ? Math.round((parsed.sales.totalCases / parsed.intake.totalConsults) * 1000) / 10
        : 0;

      const googleAdsCPL = parsed.marketing?.googleAds?.adSpend > 0 && parsed.marketing?.googleAds?.uniqueLeads > 0
        ? Math.round(parsed.marketing.googleAds.adSpend / parsed.marketing.googleAds.uniqueLeads)
        : 0;
      const lsaCPL = parsed.marketing?.lsa?.adSpend > 0 && parsed.marketing?.lsa?.uniqueLeads > 0
        ? Math.round(parsed.marketing.lsa.adSpend / parsed.marketing.lsa.uniqueLeads)
        : 0;

      const webinarShowRate = parsed.marketing?.webinar?.registrants > 0 && parsed.marketing?.webinar?.attendees > 0
        ? Math.round((parsed.marketing?.webinar.attendees / parsed.marketing?.webinar.registrants) * 1000) / 10
        : 0;
      const webinarHotTransferRate = parsed.marketing?.webinar?.attendees > 0 && parsed.marketing?.webinar?.hotTransfers > 0
        ? Math.round((parsed.marketing?.webinar.hotTransfers / parsed.marketing?.webinar.attendees) * 1000) / 10
        : 0;

      const listActivationRate = parsed.marketing?.reviewGeneration?.listContacted > 0 && parsed.marketing?.reviewGeneration?.listReviews > 0
        ? Math.round((parsed.marketing.reviewGeneration.listReviews / parsed.marketing.reviewGeneration.listContacted) * 1000) / 10
        : 0;

      const otherLeadsData = parsed.marketing?.otherLeads;
      const otherLeadsDescription = otherLeadsData ? [
        otherLeadsData.socialMedia > 0 ? `Social Media: ${otherLeadsData.socialMedia}` : "",
        otherLeadsData.directCalls > 0 ? `Direct Calls: ${otherLeadsData.directCalls}` : "",
        otherLeadsData.referrals > 0 ? `Referrals: ${otherLeadsData.referrals}` : "",
      ].filter(Boolean).join(", ") : "";

      // Pre-insert webhook log so we can attribute section history rows to it.
      logData.reportId = report.id;
      await saveLog();
      const webhookAttribution = {
        editor: "system:pdf-webhook",
        source: "pdf_webhook" as const,
        webhookImportLogId: savedLogId,
      };

      // Task #1848 — persist phase: the section upserts are all DB work.
      // The bulk local-dominance enrichment inside the marketing block
      // is already a separate await (no connection is held across that
      // call thanks to per-query checkout/release), and the rate / lead-
      // quality math above runs before this scope opens.
      // Task #1810/#1848 — compute GBP locations BEFORE opening the persist
      // scope so the bulk local-dominance fetch doesn't sit inside an
      // object-literal `await (async () => {...})()` (esbuild's TS transform
      // strips the space and Node then parses `await(...)` as a call to the
      // reserved word `await`, breaking module load).
      // Task #2568 — parsed locations that do NOT resolve to one of the
      // client's real Command Panel locations are collected here and surfaced
      // (logged + stored on the marketing section as `gbpUnresolvedImports`)
      // instead of being silently minted as confident `crypto.randomUUID()`
      // rows. That naive exact-match-or-fresh-UUID behavior is how a foreign
      // source PDF's cities (e.g. Lansing / Waverly) became published GBP rows
      // on a Lehi / Las Vegas client. Resolution uses the shared
      // parenthetical-aware matcher so legit short PDF names ("Lehi") still
      // resolve to firm-qualified Command Panel names ("Firm (Lehi)").
      // Task #2595 — the resolve/skip block is extracted to the pure,
      // testable helper `buildWebhookGbpLocationsPayload` so the
      // foreign-location ghost guard can be asserted without a full HTTP
      // round-trip. Behavior is unchanged: dedupe → resolve each parsed name
      // against the client's Command Panel via the shared matcher → unresolved
      // names are collected (never minted as confident rows) → resolved rows
      // get heatmap + local-dominance enrichment.
      const { buildWebhookGbpLocationsPayload } = await import(
        "../services/webhookGbpPayload"
      );
      const { locations: gbpLocationsPayload, unresolved: webhookUnresolvedGbp } =
        await buildWebhookGbpLocationsPayload(
          parsed.marketing?.gbpLocations || [],
          configuredLocations,
          heatmapMapping,
          { deduplicate: deduplicateLocations, clientId: resolvedClientId },
        );

      if (webhookUnresolvedGbp.length > 0) {
        console.warn(
          `[Webhook] ${webhookUnresolvedGbp.length} GBP location(s) from the imported PDF did not resolve to ${client.firmName}'s command panel and were NOT added to report ${report.id}: ${webhookUnresolvedGbp.map(u => u.name).join(", ")}. Likely a wrong-source PDF or a location missing from Client Management. Stored under marketing.gbpUnresolvedImports for operator review.`,
        );
      }

      // Task #2389 — format imported Common Issues nicely BEFORE persisting so
      // unattended webhook imports store clean, scannable 🔴 Issue / ↳ Impact /
      // ➡️ Strategic Fix markdown by default instead of a raw OCR run-on blob.
      // This runs OUTSIDE the persist DB-attribution scope below because it may
      // make an AI call (DB-hold rules: no external/AI work inside a hold).
      // formatCommonIssuesContent never throws — it degrades to a deterministic
      // OCR-cleanup + marker-split fallback if the AI formatter is unavailable.
      const { formatCommonIssuesContent } = await import(
        "../services/commonIssuesFormatter"
      );
      // Task #2460 — scale the Common Issues tone with how the firm is actually
      // performing against goal. Intake tone follows the Lead-to-Consult rate,
      // Sales tone the Consult-to-Case rate, both gated on the client's consult
      // type. Rates + consultType are already computed/in-scope here.
      const webhookConsultType =
        client?.consultType === "paid" ? "paid" : "free";
      const [intakeIssuesFormatted, salesIssuesFormatted] = await Promise.all([
        formatCommonIssuesContent(parsed.intake?.commonIssues || "", "intake", {
          rate: leadToConsultRate,
          consultType: webhookConsultType,
        }),
        formatCommonIssuesContent(parsed.sales?.commonIssues || "", "sales", {
          rate: consultToCaseRate,
          consultType: webhookConsultType,
        }),
      ]);
      if (intakeIssuesFormatted.degraded) {
        console.warn(
          `[Webhook] Intake Common Issues used deterministic fallback (${intakeIssuesFormatted.reason}) for report ${report.id}`,
        );
      }
      if (salesIssuesFormatted.degraded) {
        console.warn(
          `[Webhook] Sales Common Issues used deterministic fallback (${salesIssuesFormatted.reason}) for report ${report.id}`,
        );
      }

      // Task #4054 — normalize-on-write + stamp-only-when-well-formed. The
      // formatter's degraded fallback can emit single-line marker text that
      // the stored-malformed-shape detector flags; stamping THAT text as
      // formatted is exactly the "born pre-stamped, repaired days later"
      // feeder this task closes. Finalize normalizes the structure and tells
      // us whether the result is genuinely stampable.
      const intakeIssuesFinal = finalizeCommonIssuesForStorage(
        intakeIssuesFormatted.formatted,
      );
      const salesIssuesFinal = finalizeCommonIssuesForStorage(
        salesIssuesFormatted.formatted,
      );
      if (!intakeIssuesFinal.stampable || !salesIssuesFinal.stampable) {
        console.warn(
          `[Webhook] Common Issues stored WITHOUT the reformat stamp for report ${report.id} (intake stampable=${intakeIssuesFinal.stampable}, sales stampable=${salesIssuesFinal.stampable}) — text still malformed after normalize; the reformat backfill will repair it.`,
        );
      }

      // Task #3533 — convergence stamps on the wholesale section writers.
      //
      // 1. Intake/Sales just went through the shared formatter above, so they
      //    are written WITH the Common Issues reformat stamp — otherwise every
      //    webhook import re-arms the one-time
      //    `reformat_common_issues_all_reports` back-catalog action forever.
      // 2. Marketing is replaced wholesale here, which used to WIPE the June
      //    2026 lead-reparse stamp (`juneLeadReparseVersion`/`...Outcome`) on
      //    every scheduled re-import, resurrecting
      //    `reparse_june_2026_report_leads` every press. This import runs the
      //    same fixed reconciliation parser the reparse used, so the fresh
      //    lead values are already correct — carrying the stamps forward is
      //    safe and stops the correct/re-correct churn loop.
      const { REFORMAT_STAMP_KEY, COMMON_ISSUES_REFORMAT_BACKFILL_VERSION } =
        await import("../services/commonIssuesReformatBackfill");
      const {
        JUNE_LEAD_REPARSE_STAMP_KEY,
        JUNE_LEAD_REPARSE_OUTCOME_KEY,
      } = await import("../services/juneLeadReparse");
      const existingWebhookSections = normalizeSections(
        await storage.getReportSections(report.id),
      );
      const existingWebhookMarketing = readOptionalSectionDataObject(
        existingWebhookSections.find((s) => s.sectionKey === "marketing")?.data,
        { reportId: report.id, clientId: report.clientId },
      );
      const preservedMarketingStamps: Record<string, any> = {};
      for (const key of [JUNE_LEAD_REPARSE_STAMP_KEY, JUNE_LEAD_REPARSE_OUTCOME_KEY]) {
        if (existingWebhookMarketing && existingWebhookMarketing[key] !== undefined) {
          preservedMarketingStamps[key] = existingWebhookMarketing[key];
        }
      }

      // Task #4983 — write-path preservation: when this PDF carries no
      // missed-call truth of its own (no bucket evidence, no parsed headline
      // rate), a re-import must NOT stamp a recomputed/structural 0 over a
      // previously pushed/typed stored rate. Prior stored 0s are not
      // preserved-worthy (they are the fabrication this task removes), so
      // only a prior rate > 0 survives; otherwise the section keeps the
      // legacy 0 shape (display-time resolution renders it as "No data").
      const existingWebhookIntake = readOptionalSectionDataObject(
        existingWebhookSections.find((s) => s.sectionKey === "intake")?.data,
        { reportId: report.id, clientId: report.clientId },
      );
      const priorStoredMissedCallRate = Number(existingWebhookIntake?.missedCallRate);
      const missedCallRate =
        resolvedMissedCallRate ??
        (Number.isFinite(priorStoredMissedCallRate) && priorStoredMissedCallRate > 0
          ? clampMissedCallRate(priorStoredMissedCallRate)
          : 0);

      // Task #3769 — broken-source import warning. When this PDF's
      // Consults/Cases resolve to "not entered" while the client's most
      // recent prior report had them entered — or a section's raw Common
      // Issues matched the "Missing data source" placeholder — persist a
      // per-section warning (mirrors gbpUnresolvedImports: cleared when the
      // operator saves the section) and notify the owner below. Best-effort:
      // a failed prior-report lookup never fails the import. Runs BEFORE the
      // persist scope opens (DB-hold rule: keep the hold to the upserts).
      const {
        BROKEN_SOURCE_WARNING_KEY,
        computeBrokenSourceSectionWarning,
        loadPriorFunnelEntries,
        rawCommonIssuesMatchedPlaceholder,
      } = await import("../services/reportImportWarnings");
      let webhookIntakeWarning: import("../services/reportImportWarnings").BrokenSourceSectionWarning | null = null;
      let webhookSalesWarning: import("../services/reportImportWarnings").BrokenSourceSectionWarning | null = null;
      try {
        const priorEntries = await loadPriorFunnelEntries(
          resolvedClientId,
          reportMonth,
          report.id,
        );
        webhookIntakeWarning = computeBrokenSourceSectionWarning({
          sectionKey: "intake",
          effectiveValue: parsed.intake?.totalConsults || 0,
          rawPlaceholder: rawCommonIssuesMatchedPlaceholder(parsed.fieldConfidence, "intake"),
          prior: priorEntries,
          source: "webhook",
        });
        webhookSalesWarning = computeBrokenSourceSectionWarning({
          sectionKey: "sales",
          effectiveValue: parsed.sales?.totalCases || 0,
          rawPlaceholder: rawCommonIssuesMatchedPlaceholder(parsed.fieldConfidence, "sales"),
          prior: priorEntries,
          source: "webhook",
        });
      } catch (warnErr: any) {
        console.warn(
          `[Webhook] Broken-source import warning check skipped for report ${report.id}: ${warnErr?.message || warnErr}`,
        );
      }

      await withDbAttribution("reports:webhook-import:persist", () => Promise.all([
        storage.upsertReportSection({
          reportId: report.id,
          sectionKey: "intake",
          data: {
            totalConsults: parsed.intake?.totalConsults || 0,
            missedCallRate,
            avgTimeToAnswer: parsed.intake?.avgTimeToAnswer || 0,
            qualityScore: parsed.intake?.qualityScore || 0,
            commonIssues: intakeIssuesFinal.text,
            leadToConsultRate,
            // Task #3772 — absent stays absent: entry-tracked metrics the
            // parser did NOT find are flagged No-Data so the report renders
            // "No Data" instead of a fabricated unflagged 0. Derived values
            // (missedCallRate, leadToConsultRate) have no flags by design.
            // Task #3813 — EXCEPT the funnel metric this same import warns
            // about: flagging it No-Data made the broken-source finalize
            // gate treat it as permanently not-entered.
            noDataFlags: unflagWarnedFunnelMetrics(
              buildImportedSectionNoDataFlags(parsed.fieldConfidence, "intake"),
              webhookIntakeWarning,
            ),
            // Task #4054 — stamp only when the stored text is well-formed.
            ...(intakeIssuesFinal.stampable
              ? { [REFORMAT_STAMP_KEY]: COMMON_ISSUES_REFORMAT_BACKFILL_VERSION }
              : {}),
            ...(webhookIntakeWarning
              ? { [BROKEN_SOURCE_WARNING_KEY]: webhookIntakeWarning }
              : {}),
          },
        }, webhookAttribution),
        storage.upsertReportSection({
          reportId: report.id,
          sectionKey: "sales",
          data: {
            totalConsults: parsed.intake?.totalConsults || 0,
            totalCases: parsed.sales?.totalCases || 0,
            consultToCaseRate,
            averageCaseValue: parsed.sales?.averageCaseValue || 0,
            noShowRate: parsed.sales?.noShowRate || 0,
            avgFollowUps: parsed.sales?.avgFollowUps || 0,
            qualityScore: parsed.sales?.qualityScore || 0,
            commonIssues: salesIssuesFinal.text,
            dealTouchDensity: parsed.sales?.dealTouchDensity || 0,
            avgAgeOpenMatters: parsed.sales?.avgAgeOpenMatters || 0,
            pipelineMomentumScore: parsed.sales?.pipelineMomentumScore || 0,
            // Task #3772 — same "absent stays absent" rule as intake above,
            // with the same Task #3813 carve-out for the warned funnel metric.
            noDataFlags: unflagWarnedFunnelMetrics(
              buildImportedSectionNoDataFlags(parsed.fieldConfidence, "sales"),
              webhookSalesWarning,
            ),
            // Task #4054 — stamp only when the stored text is well-formed.
            ...(salesIssuesFinal.stampable
              ? { [REFORMAT_STAMP_KEY]: COMMON_ISSUES_REFORMAT_BACKFILL_VERSION }
              : {}),
            ...(webhookSalesWarning
              ? { [BROKEN_SOURCE_WARNING_KEY]: webhookSalesWarning }
              : {}),
          },
        }, webhookAttribution),
        storage.upsertReportSection({
          reportId: report.id,
          sectionKey: "marketing",
          data: {
            ...preservedMarketingStamps,
            // Task #2760 — INVARIANT: `totalLeads` is persisted RAW, INCLUDING
            // the Other bucket, even for hideOtherLeads-enabled clients. This
            // is deliberate: operators need the full picture in the admin
            // editor, and the public report subtracts Other at DISPLAY time
            // (the public read injects `client.hideOtherLeads` and the
            // renderer / `adjustDisplayLeads` do the subtraction). Do NOT
            // "fix" this by persisting the reduced total — the display-time
            // subtraction would then run against an already-reduced value and
            // double-subtract. Only the missedCallRate above applies
            // hideOtherLeads at persist time (numerator+denominator
            // symmetrically, Task #2680) because that rate is stored as a
            // final percentage, not re-derived at render.
            totalLeads,
            leadQuality: allLeadQuality,
            gbpLeadQuality,
            gbp: {
              locations: gbpLocationsPayload,
              shared: { blogPostUrl: parsed.marketing?.blogPostUrl || undefined },
            },
            // Task #2568 — parsed locations that did not resolve to the client's
            // command panel. Preserved (no data loss) and surfaced to the
            // operator instead of being written as confident GBP rows.
            ...(webhookUnresolvedGbp.length > 0
              ? { gbpUnresolvedImports: webhookUnresolvedGbp }
              : {}),
            googleAds: {
              uniqueLeads: parsed.marketing?.googleAds?.uniqueLeads || 0,
              adSpend: parsed.marketing?.googleAds?.adSpend || 0,
              leadQuality: parsed.marketing?.googleAds?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
              costPerLead: googleAdsCPL,
            },
            lsa: {
              uniqueLeads: parsed.marketing?.lsa?.uniqueLeads || 0,
              adSpend: parsed.marketing?.lsa?.adSpend || 0,
              leadQuality: parsed.marketing?.lsa?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
              costPerLead: lsaCPL,
            },
            webinar: {
              registrants: parsed.marketing?.webinar?.registrants || 0,
              attendees: parsed.marketing?.webinar?.attendees || 0,
              hotTransfers: parsed.marketing?.webinar?.hotTransfers || parsed.marketing?.webinar?.leads || 0,
              showRate: webinarShowRate,
              hotTransferRate: webinarHotTransferRate,
              leadQuality: parsed.marketing?.webinar?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            },
            reviewGeneration: {
              list: {
                contacted: parsed.marketing?.reviewGeneration?.listContacted || 0,
                reviews: parsed.marketing?.reviewGeneration?.listReviews || 0,
                activationRate: listActivationRate,
              },
              webinar: { reviews: parsed.marketing?.reviewGeneration?.webinarReviews || 0 },
              other: { count: parsed.marketing?.reviewGeneration?.otherCount || 0 },
              totalReviews: parsed.marketing?.reviewGeneration?.totalReviews || 0,
            },
            otherLeads: {
              count: otherLeadsData?.total || 0,
              description: otherLeadsDescription,
              leadQuality: otherLeadsData?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            },
          },
        }, webhookAttribution),
        // Seed empty nextActions row so every newly-created report has the
        // full canonical set of 4 section keys (intake/sales/marketing/
        // nextActions). Mirrors the create-time seed in POST /api/reports.
        storage.upsertReportSection({
          reportId: report.id,
          sectionKey: "nextActions",
          data: {},
        }, webhookAttribution),
      ]));

      // Task #755: PDF import is no longer allowed to mutate authoritative
      // client-level fields (e.g. clients.averageCaseValue). Surface the
      // parsed value as a non-authoritative warning on the import log so
      // operators can promote it via Client Settings.
      if (parsed.sales?.averageCaseValue > 0) {
        const { evaluateImportWrite } = await import("../services/importWritePolicy");
        const decision = evaluateImportWrite("pdf_import", "client_field", "update", {
          entityExists: true,
          candidateLabel: "averageCaseValue",
          reason: `PDF parsed averageCaseValue=${parsed.sales.averageCaseValue} for client ${resolvedClientId}; not auto-applying — operator must update Client Settings`,
        });
        const warnings: any[] = Array.isArray(logData.warnings) ? logData.warnings : [];
        warnings.push({
          surface: "pdf_import",
          entityKind: "client_field",
          decision: decision.decision,
          reason: decision.reason,
        });
        logData.warnings = warnings;
        console.log(`[Webhook] ${decision.warning || decision.reason}`);
      }

      console.log(`[Webhook] Created draft report ${report.id} for ${client.firmName} (${reportMonth})`);

      // Task #2594 — an unattended import has no operator watching the screen,
      // so when locations are skipped (Task #2568) nobody sees the report-form
      // banner until they happen to open the report. Push a per-user inbox
      // notification (also mirrored to Slack DM where opted in) to the client
      // owner so the skipped locations get reviewed. Best-effort: never fail the
      // import on a notification error.
      if (webhookUnresolvedGbp.length > 0 && client?.ownerId) {
        try {
          const skippedNames = webhookUnresolvedGbp
            .map((u) => u.name)
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
          const { notifyUser } = await import("../services/notifications/userInbox");
          await notifyUser(client.ownerId, {
            category: "system",
            title: `${skippedNames.length} imported location(s) need review`,
            body: `An automated PDF import for ${client.firmName} (${reportMonth}) skipped ${skippedNames.length} GBP location(s) that don't match the command panel and were not added: ${skippedNames.join(", ")}. If they belong to this client, add them in Client Management and re-import; otherwise the PDF may be from the wrong source.`,
            deepLink: `/reports/${report.id}`,
            dedupeKey: `gbp-unresolved-import:${report.id}`,
            metadata: { reportId: report.id, clientId: resolvedClientId, skipped: skippedNames },
          });
        } catch (notifyErr: any) {
          console.warn(
            `[Webhook] Failed to notify owner of unresolved GBP imports for report ${report.id}: ${notifyErr?.message || notifyErr}`,
          );
        }
      }

      // Task #2828 — the upsert branch above just overwrote a report the
      // operator had already hand-edited and/or finalized, with nobody in
      // the loop (webhook re-posts skip the per-field consent modal manual
      // reimports get). Import behavior is unchanged — notify, don't block —
      // but the client owner gets a per-user inbox notification naming the
      // report + month with a link so they can review what changed.
      // Best-effort: never fail the import on a notification error.
      if (existingReport && overwriteNotifyReasons.length > 0 && client?.ownerId) {
        try {
          const reasonText = overwriteNotifyReasons.join(" and ");
          const { notifyUser } = await import("../services/notifications/userInbox");
          await notifyUser(client.ownerId, {
            category: "system",
            title: `Automated import overwrote a ${reasonText} report`,
            body: `An automated PDF import replaced the intake, sales, and marketing sections of the ${reportMonth} report for ${client.firmName}. That report was ${reasonText} before the re-import, so operator changes may have been overwritten. Review the report and its edit history to confirm the new values.`,
            deepLink: `/reports/${report.id}`,
            dedupeKey: `report-import-overwrite:${report.id}`,
            metadata: {
              reportId: report.id,
              clientId: resolvedClientId,
              reportMonth,
              reasons: overwriteNotifyReasons,
            },
          });
          console.log(
            `[Webhook] Notified owner ${client.ownerId} that report ${report.id} (${reasonText}) was overwritten by an automated re-import`,
          );
        } catch (notifyErr: any) {
          console.warn(
            `[Webhook] Failed to notify owner of overwritten ${overwriteNotifyReasons.join("/")} report ${report.id}: ${notifyErr?.message || notifyErr}`,
          );
        }
      }

      // Task #3769 — an unattended import from a broken-source PDF used to
      // land silently (empty funnel metrics + placeholder Common Issues) and
      // get finalized/shared with nobody warned. Push a dedupe-keyed inbox
      // notification to the client owner naming the affected metrics.
      // Best-effort: never fail the import on a notification error.
      if ((webhookIntakeWarning || webhookSalesWarning) && client?.ownerId) {
        try {
          const { buildBrokenSourceNotification } = await import(
            "../services/reportImportWarnings"
          );
          const brokenSourceNotification = buildBrokenSourceNotification({
            reportId: report.id,
            clientId: resolvedClientId,
            firmName: client.firmName,
            reportMonth,
            intakeWarning: webhookIntakeWarning,
            salesWarning: webhookSalesWarning,
          });
          if (brokenSourceNotification) {
            const { notifyUser } = await import("../services/notifications/userInbox");
            await notifyUser(client.ownerId, brokenSourceNotification);
            console.log(
              `[Webhook] Notified owner ${client.ownerId} of broken-source import warning for report ${report.id} (metrics: ${brokenSourceNotification.metadata.missingMetrics}, placeholder: ${brokenSourceNotification.metadata.placeholderSections})`,
            );
          }
        } catch (notifyErr: any) {
          console.warn(
            `[Webhook] Failed to notify owner of broken-source import for report ${report.id}: ${notifyErr?.message || notifyErr}`,
          );
        }
      }

      try {
        const { onMonthlyReportGenerated } = await import("../services/semrushInventorySync");
        onMonthlyReportGenerated(resolvedClientId, reportMonth).catch((err: any) => {
          console.warn(`[Webhook] Background Semrush refresh failed for report ${report.id}: ${err?.message || err}`);
        });
      } catch (e: any) {
        console.warn(`[Webhook] Could not enqueue Semrush refresh for report ${report.id}: ${e?.message || e}`);
      }

      logData.status = "success";
      logData.reportId = report.id;
      logData.sectionsCreated = ["intake", "sales", "marketing"];
      logData.fieldConfidence = parsed.fieldConfidence;
      logData.pdfExtractedText = (parsed as any)._extractedText || null;
      const importLogId = await saveLog();

      if (importLogId) {
        await db.update(reports).set({ webhookImportLogId: importLogId }).where(eq(reports.id, report.id));
      }

      // Task #2652 — persist a private copy of the source PDF so "Re-parse
      // from Source" keeps working after the temporary Zapier link expires.
      // External object-storage I/O runs OUTSIDE any held DB scope; the only
      // DB work is the short, separate key write. A failed save is non-fatal —
      // the import already succeeded above.
      try {
        const { saveReportSourcePdf } = await import("../services/reportSourcePdf");
        const sourcePdfKey = await saveReportSourcePdf(report.id, pdfBuffer);
        if (sourcePdfKey) {
          await db.update(reports).set({ sourcePdfStorageKey: sourcePdfKey }).where(eq(reports.id, report.id));
        }
      } catch (savePdfErr: any) {
        console.warn(`[Webhook] Failed to persist source PDF copy for report ${report.id}: ${savePdfErr?.message || savePdfErr}`);
      }

      res.status(201).json({
        success: true,
        reportId: report.id,
        clientName: client.firmName,
        reportMonth,
        status: "draft",
        sectionsCreated: ["intake", "sales", "marketing"],
        fieldConfidence: parsed.fieldConfidence,
      });
    } catch (error: any) {
      console.error("[Webhook] Report import failed:", error);
      logData.status = "error";
      logData.errorMessage = error?.message || "Unknown error";
      await saveLog();
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.get("/api/webhook-import-logs", isAuthenticated, requireCeo, async (_req: any, res) => {
    try {
      const logs = await db
        .select({
          id: webhookImportLogs.id,
          clientId: webhookImportLogs.clientId,
          clientName: webhookImportLogs.clientName,
          reportMonth: webhookImportLogs.reportMonth,
          reportId: webhookImportLogs.reportId,
          status: webhookImportLogs.status,
          sectionsCreated: webhookImportLogs.sectionsCreated,
          fieldConfidence: webhookImportLogs.fieldConfidence,
          pdfFileName: webhookImportLogs.pdfFileName,
          pdfSizeBytes: webhookImportLogs.pdfSizeBytes,
          pdfSourceType: webhookImportLogs.pdfSourceType,
          pdfSourceUrl: webhookImportLogs.pdfSourceUrl,
          webhookPayload: webhookImportLogs.webhookPayload,
          errorMessage: webhookImportLogs.errorMessage,
          durationMs: webhookImportLogs.durationMs,
          createdAt: webhookImportLogs.createdAt,
          hasExtractedText: sql<boolean>`pdf_extracted_text IS NOT NULL`.as('has_extracted_text'),
        })
        .from(webhookImportLogs)
        .orderBy(desc(webhookImportLogs.createdAt))
        .limit(200);
      res.json(logs);
    } catch (error: any) {
      console.error("[Webhook] Failed to fetch import logs:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.get("/api/webhook-import-logs/:id/extracted-text", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const [log] = await db
        .select({ pdfExtractedText: webhookImportLogs.pdfExtractedText, clientName: webhookImportLogs.clientName })
        .from(webhookImportLogs)
        .where(eq(webhookImportLogs.id, req.params.id));
      if (!log) return res.status(404).json({ error: "Import log not found" });
      if (!log.pdfExtractedText) return res.status(404).json({ error: "No extracted text available for this import" });
      res.json({ clientName: log.clientName, extractedText: log.pdfExtractedText });
    } catch (error: any) {
      console.error("[Webhook] Failed to fetch extracted text:", error);
      res.status(500).json({ error: "Failed to fetch extracted text" });
    }
  });

  app.post("/api/reports/:id/reimport", isAuthenticated, requireAccountManager, upload.single('pdf'), async (req: AuthenticatedRequest<{ id: string }, { fromStoredUrl?: unknown }>, res) => {
    try {
      const userId = req.user?.claims?.sub;
      // Task #1848 — fetch phase: user + report + client lookups bundled
      // into one labelled scope. PDF fetch/parse and the merge math run
      // outside this scope so the connection isn't held across them.
      const fetchResult = await withDbAttribution(
        "reports:reimport:fetch",
        async () => {
          // F9: compile-only assertion — behavior (incl. the !u → 401 path)
          // is unchanged.
          const u = await storage.getUser(userId!);
          if (!u) return { ok: false as const, code: 401, error: "Not authenticated" };
          const r = await storage.getReport(req.params.id);
          if (!r) return { ok: false as const, code: 404, error: "Report not found" };
          const c = await storage.getClient(r.clientId);
          if (!c) return { ok: false as const, code: 404, error: "Client not found" };
          return { ok: true as const, user: u, report: r, client: c };
        },
      );
      if (!fetchResult.ok) {
        return res.status(fetchResult.code).json({ error: fetchResult.error });
      }
      const report = fetchResult.report;
      const client = fetchResult.client;

      const MAX_PDF_SIZE = 10 * 1024 * 1024;

      function isPrivateIp(ip: string): boolean {
        const v4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (v4Match) {
          const [, a, b, , ] = v4Match.map(Number);
          if (a === 0 || a === 10 || a === 127) return true;
          if (a === 172 && b >= 16 && b <= 31) return true;
          if (a === 192 && b === 168) return true;
          if (a === 169 && b === 254) return true;
          if (a >= 224) return true;
          return false;
        }
        const lower = ip.toLowerCase();
        if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd') || lower.startsWith('ff') || lower.startsWith('::ffff:')) return true;
        return false;
      }

      async function validateUrlSafety(url: string): Promise<void> {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          throw new Error("Only HTTP(S) URLs are supported");
        }
        const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const blockedHosts = ['localhost', 'metadata.google.internal', '169.254.169.254'];
        if (blockedHosts.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
          throw new Error("URL points to a restricted/private host");
        }
        if (isPrivateIp(hostname)) {
          throw new Error("URL points to a private/internal IP address");
        }
        const dns = await import('dns');
        const { promisify } = await import('util');
        const lookup = promisify(dns.lookup);
        try {
          const result = await lookup(hostname, { all: true });
          const results = Array.isArray(result) ? result : [result];
          for (const entry of results) {
            if (isPrivateIp(entry.address)) {
              throw new Error("URL hostname resolves to a private/internal IP address");
            }
          }
        } catch (e: any) {
          if (e.message?.includes('private') || e.message?.includes('restricted')) throw e;
          // F10 (Task #4156): normalized message + preserved cause — a
          // non-Error rejection used to interpolate "undefined" and the
          // original lookup error was dropped entirely.
          const msg = typeof e?.message === "string" && e.message ? e.message : String(e);
          throw new Error(`DNS resolution failed for ${hostname}: ${msg}`, { cause: e });
        }
      }

      async function fetchPdfFromUrl(url: string, maxRedirects: number = 5): Promise<Buffer> {
        let currentUrl = url;
        for (let i = 0; i <= maxRedirects; i++) {
          await validateUrlSafety(currentUrl);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get('location');
              if (!location) throw new Error(`Redirect ${response.status} without Location header`);
              currentUrl = new URL(location, currentUrl).toString();
              clearTimeout(timeout);
              if (i === maxRedirects) throw new Error("Too many redirects (max 5)");
              continue;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const chunks: Buffer[] = [];
            let totalSize = 0;
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Unable to read response body");
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalSize += value.length;
              if (totalSize > MAX_PDF_SIZE) { void reader.cancel(); throw new Error("Remote PDF exceeds 10MB size limit"); } // reader.cancel fire-and-forget: aborting stream on size-cap breach
              chunks.push(Buffer.from(value));
            }
            return Buffer.concat(chunks);
          } finally {
            clearTimeout(timeout);
          }
        }
        throw new Error("Too many redirects (max 5)");
      }

      let pdfBuffer: Buffer;
      let reimportSource: string;
      // Task #2652 — true when the bytes came from the saved private copy, so
      // we skip re-saving an identical copy below.
      let loadedFromSavedCopy = false;

      // Plain-English guidance shown when neither a saved copy nor a working
      // original link is available (e.g. older reports whose temporary Zapier
      // link has expired and that predate the saved-copy change).
      const NO_SOURCE_MESSAGE =
        "The original file is no longer available to re-download. Please use 'Reimport PDF' to upload the file manually.";

      if (req.file) {
        pdfBuffer = req.file.buffer;
        reimportSource = "manual_upload";
      } else if (req.body?.fromStoredUrl === "true" || req.body?.fromStoredUrl === true) {
        // Task #2652 — prefer the saved private copy (survives Zapier link
        // expiry). Object-storage download is external I/O, kept outside any
        // held DB scope. Only fall back to re-fetching the original source URL
        // when there is no saved copy.
        let loaded: Buffer | null = null;
        if (report.sourcePdfStorageKey) {
          const { loadReportSourcePdf } = await import("../services/reportSourcePdf");
          loaded = await loadReportSourcePdf(report.sourcePdfStorageKey);
        }
        if (loaded) {
          pdfBuffer = loaded;
          reimportSource = "stored_copy";
          loadedFromSavedCopy = true;
        } else {
          // No usable saved copy — fall back to the original source link.
          let importLog: typeof webhookImportLogs.$inferSelect | undefined;
          if (report.webhookImportLogId) {
            [importLog] = await db.select().from(webhookImportLogs).where(eq(webhookImportLogs.id, report.webhookImportLogId));
          }
          if (!importLog?.pdfSourceUrl) {
            return res.status(400).json({ error: NO_SOURCE_MESSAGE });
          }
          try {
            pdfBuffer = await fetchPdfFromUrl(importLog.pdfSourceUrl);
          } catch (e: any) {
            // The original (temporary) link is dead — give the operator a
            // clear, actionable message instead of a raw HTTP error.
            return res.status(400).json({ error: NO_SOURCE_MESSAGE });
          }
          reimportSource = "stored_url";
        }
      } else {
        return res.status(400).json({ error: "Upload a PDF file or set fromStoredUrl=true to reimport from stored source" });
      }

      const header = pdfBuffer.subarray(0, 5).toString('ascii');
      if (!header.startsWith('%PDF')) {
        return res.status(400).json({ error: "Data is not a valid PDF (missing %PDF header)" });
      }

      const parsed = await parseReportPdf(pdfBuffer);

      // Task #1028: Active-Products gate (reimport path).
      // Task #1028: canonical Active-Products resolution (CP wins, fallback
      // to client.products) with metadata logged for audit.
      const reimportResolution = await getActiveProductsForClient(report.clientId);
      logResolution("reimport", { ...reimportResolution, reportId: report.id });
      const reimportActiveProducts = reimportResolution.products;
      applyActiveProductsFilter(parsed.marketing, reimportActiveProducts, {
        source: "reimport",
        clientId: report.clientId,
        reportId: report.id,
      });

      // Defensive shape defaults: the Active-Products filter above deletes
      // inactive platform blocks, AND the PDF parser may legitimately omit
      // blocks the report didn't include. The merge logic below dereferences
      // `parsed.marketing.googleAds.adSpend` etc. directly — without these
      // defaults a reimport for a client missing any of these blocks crashes
      // with "Cannot read properties of undefined (reading 'adSpend')".
      // The post-merge Active-Products filter at line ~2098 will strip these
      // empty placeholders back out for inactive products before storage.
      parsed.marketing = parsed.marketing || {};
      parsed.marketing.gbpLocations = parsed.marketing.gbpLocations || [];
      parsed.marketing.googleAds = parsed.marketing.googleAds || { uniqueLeads: 0, adSpend: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } };
      parsed.marketing.lsa = parsed.marketing.lsa || { uniqueLeads: 0, adSpend: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } };
      parsed.marketing.otherLeads = parsed.marketing.otherLeads || { total: 0, description: "" };
      parsed.marketing.reviewGeneration = parsed.marketing.reviewGeneration || { listReviews: 0, listContacted: 0, webinarReviews: 0, otherCount: 0, totalReviews: 0 };
      parsed.marketing.webinar = parsed.marketing.webinar || { registrants: 0, attendees: 0, leads: 0, showRate: 0, htScheduleRate: 0, hotTransfers: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } };
      parsed.marketing.webinar.leadQuality = parsed.marketing.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

      // Task #2475 — format the freshly-parsed Common Issues server-side so a
      // manual reimport also lands the clean 🔴 Issue / ↳ Impact / ➡️ Strategic
      // Fix markdown by default (matching the webhook import, Task #2389) instead
      // of a raw OCR blob. Formatting runs on the PARSED value BEFORE the
      // resolveCommonIssuesOnReimport preserve-existing rule below, so:
      //   • a real parsed body → returned as clean formatted markdown;
      //   • an empty/placeholder parsed body → formats to "" → still treated as
      //     empty by resolveCommonIssuesOnReimport, which preserves the existing
      //     (possibly hand-edited) value untouched — we never re-format or
      //     clobber what is already saved.
      // No metric context is in scope on this route, so tone is neutral. The
      // formatter never throws (deterministic fallback) and runs outside any DB
      // hold (DB-hold rule: no AI work inside a held scope).
      {
        const { formatCommonIssuesContent } = await import(
          "../services/commonIssuesFormatter"
        );
        const [intakeIssuesFormatted, salesIssuesFormatted] = await Promise.all([
          formatCommonIssuesContent(parsed.intake?.commonIssues || "", "intake"),
          formatCommonIssuesContent(parsed.sales?.commonIssues || "", "sales"),
        ]);
        if (parsed.intake) parsed.intake.commonIssues = intakeIssuesFormatted.formatted;
        if (parsed.sales) parsed.sales.commonIssues = salesIssuesFormatted.formatted;
        if (intakeIssuesFormatted.degraded) {
          console.warn(`[Reimport] Intake Common Issues used deterministic fallback (${intakeIssuesFormatted.reason}) for report ${report.id}`);
        }
        if (salesIssuesFormatted.degraded) {
          console.warn(`[Reimport] Sales Common Issues used deterministic fallback (${salesIssuesFormatted.reason}) for report ${report.id}`);
        }
      }

      const existingSections = normalizeSections(await storage.getReportSections(report.id));

      const existingMarketing = readOptionalMarketingSection(existingSections.find(s => s.sectionKey === 'marketing')?.data, { reportId: report.id, clientId: report.clientId });
      const existingIntake = readOptionalIntakeSection(existingSections.find(s => s.sectionKey === 'intake')?.data, { reportId: report.id, clientId: report.clientId });
      const existingSales = readOptionalSalesSection(existingSections.find(s => s.sectionKey === 'sales')?.data, { reportId: report.id, clientId: report.clientId });

      function mergeNonZero(newVal: number, existingVal: number | undefined): number {
        return (newVal === 0 && existingVal && existingVal > 0) ? existingVal : newVal;
      }

      // Task #2842 — webinar lead-quality breakdown reconciliation. When the
      // reimported PDF parses a NON-zero breakdown that differs from a
      // non-zero saved (possibly operator-edited) breakdown, the parsed
      // values win (matching GBP/etc. semantics) but the response flags it so
      // the editor can warn the operator instead of silently reverting edits.
      let webinarLeadQualityDiffers = false;

      if (existingMarketing) {
        const existingLocs: StoredGbpLocation[] = existingMarketing.gbp?.locations || [];
        const existingReviewGen = existingMarketing.reviewGeneration || {};

        if (parsed.marketing.gbpLocations.length === 0 && existingLocs.length > 0) {
          parsed.marketing.gbpLocations = existingLocs.map((loc) => ({
            name: loc.name || '',
            uniqueLeads: loc.uniqueLeads || 0,
            reviewsGenerated: loc.reviewsGenerated || 0,
            reviewsRespondedTo: loc.reviewsRespondedTo || 0,
            postsQaCount: loc.postsQaCount || 0,
            leadQuality: loc.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          }));
        } else if (parsed.marketing.gbpLocations.length > 0 && existingLocs.length > 0) {
          const matchedExistingNames = new Set<string>();
          for (const loc of parsed.marketing.gbpLocations) {
            const existingLoc = existingLocs.find((el) =>
              locNamesMatch(el.name || '', loc.name || '')
            );
            if (existingLoc) {
              matchedExistingNames.add((existingLoc.name || '').toLowerCase().trim());
              loc.reviewsGenerated = mergeNonZero(loc.reviewsGenerated, existingLoc.reviewsGenerated);
              loc.reviewsRespondedTo = mergeNonZero(loc.reviewsRespondedTo, existingLoc.reviewsRespondedTo);
              loc.postsQaCount = mergeNonZero(loc.postsQaCount, existingLoc.postsQaCount);
              loc.uniqueLeads = mergeNonZero(loc.uniqueLeads, existingLoc.uniqueLeads);
            }
          }
          for (const existingLoc of existingLocs) {
            const existingName = (existingLoc.name || '').toLowerCase().trim();
            if (!matchedExistingNames.has(existingName) && (existingLoc.uniqueLeads > 0 || existingLoc.reviewsGenerated > 0)) {
              parsed.marketing.gbpLocations.push({
                name: existingLoc.name || '',
                uniqueLeads: existingLoc.uniqueLeads || 0,
                reviewsGenerated: existingLoc.reviewsGenerated || 0,
                reviewsRespondedTo: existingLoc.reviewsRespondedTo || 0,
                postsQaCount: existingLoc.postsQaCount || 0,
                leadQuality: existingLoc.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
              });
              console.log(`[Reimport] Preserved unmatched existing GBP location: "${existingLoc.name}"`);
            }
          }
        }

        parsed.marketing.gbpLocations = deduplicateLocations(parsed.marketing.gbpLocations);

        const existingListReviews = existingReviewGen?.list?.reviews || 0;
        const existingListContacted = existingReviewGen?.list?.contacted || 0;
        const existingWebinarReviews = existingReviewGen?.webinar?.reviews || 0;
        const existingOtherReviews = existingReviewGen?.other?.count || 0;
        const existingTotalReviews = existingReviewGen?.totalReviews || 0;
        parsed.marketing.reviewGeneration.listReviews = mergeNonZero(parsed.marketing.reviewGeneration.listReviews, existingListReviews);
        parsed.marketing.reviewGeneration.listContacted = mergeNonZero(parsed.marketing.reviewGeneration.listContacted, existingListContacted);
        parsed.marketing.reviewGeneration.webinarReviews = mergeNonZero(parsed.marketing.reviewGeneration.webinarReviews, existingWebinarReviews);
        parsed.marketing.reviewGeneration.otherCount = mergeNonZero(parsed.marketing.reviewGeneration.otherCount, existingOtherReviews);
        parsed.marketing.reviewGeneration.totalReviews = mergeNonZero(parsed.marketing.reviewGeneration.totalReviews, existingTotalReviews);

        parsed.marketing.googleAds.adSpend = mergeNonZero(parsed.marketing.googleAds.adSpend, existingMarketing.googleAds?.adSpend);
        parsed.marketing.googleAds.uniqueLeads = mergeNonZero(parsed.marketing.googleAds.uniqueLeads, existingMarketing.googleAds?.uniqueLeads);
        parsed.marketing.lsa.adSpend = mergeNonZero(parsed.marketing.lsa.adSpend, existingMarketing.lsa?.adSpend);
        parsed.marketing.lsa.uniqueLeads = mergeNonZero(parsed.marketing.lsa.uniqueLeads, existingMarketing.lsa?.uniqueLeads);
        parsed.marketing.otherLeads.total = mergeNonZero(parsed.marketing.otherLeads.total, existingMarketing.otherLeads?.count);

        // Task #2842 — webinar merge. Counts follow the standard mergeNonZero
        // rule. The leadQuality breakdown is preserved AS A UNIT when the new
        // PDF parses all zeros and the saved breakdown is non-zero (mirrors
        // the editor semantics where a non-zero breakdown sum drives lead
        // totals); mixing per-field would blend two different distributions.
        const existingWebinar = existingMarketing.webinar;
        if (existingWebinar) {
          parsed.marketing.webinar.registrants = mergeNonZero(parsed.marketing.webinar.registrants, existingWebinar.registrants);
          parsed.marketing.webinar.attendees = mergeNonZero(parsed.marketing.webinar.attendees, existingWebinar.attendees);
          parsed.marketing.webinar.hotTransfers = mergeNonZero(parsed.marketing.webinar.hotTransfers, existingWebinar.hotTransfers);
          const lqSum = (lq?: { good?: number; notQuotable?: number; missedCalls?: number; noData?: number }): number =>
            (lq?.good || 0) + (lq?.notQuotable || 0) + (lq?.missedCalls || 0) + (lq?.noData || 0);
          const parsedLqSum = lqSum(parsed.marketing.webinar.leadQuality);
          const existingLqSum = lqSum(existingWebinar.leadQuality);
          if (parsedLqSum === 0 && existingLqSum > 0) {
            parsed.marketing.webinar.leadQuality = {
              good: existingWebinar.leadQuality?.good || 0,
              notQuotable: existingWebinar.leadQuality?.notQuotable || 0,
              missedCalls: existingWebinar.leadQuality?.missedCalls || 0,
              noData: existingWebinar.leadQuality?.noData || 0,
            };
            console.log(`[Reimport] Preserved existing webinar leadQuality breakdown (parsed all zeros) for report ${report.id}`);
          } else if (parsedLqSum > 0 && existingLqSum > 0) {
            const p = parsed.marketing.webinar.leadQuality;
            const e = existingWebinar.leadQuality || {};
            webinarLeadQualityDiffers =
              (p.good || 0) !== (e.good || 0) ||
              (p.notQuotable || 0) !== (e.notQuotable || 0) ||
              (p.missedCalls || 0) !== (e.missedCalls || 0) ||
              (p.noData || 0) !== (e.noData || 0);
            if (webinarLeadQualityDiffers) {
              console.log(`[Reimport] Parsed webinar leadQuality breakdown differs from saved breakdown for report ${report.id} — flagging for operator review`);
            }
          }
        }
      }

      if (existingIntake) {
        parsed.intake.totalConsults = mergeNonZero(parsed.intake.totalConsults, existingIntake.totalConsults);
        parsed.intake.qualityScore = mergeNonZero(parsed.intake.qualityScore, existingIntake.qualityScore);
        // Common Issues re-import rule (Task #830): never let parsed empty /
        // placeholder text overwrite existing non-empty content.
        // Task #4054 — normalize the winner: when the preserve-existing rule
        // picks stored text that predates structure normalization, the editor
        // would otherwise round-trip the malformed single-line shape back
        // through the section PUT.
        parsed.intake.commonIssues = finalizeCommonIssuesForStorage(
          resolveCommonIssuesOnReimport(
            parsed.intake.commonIssues,
            existingIntake.commonIssues,
          ),
        ).text;
      }

      if (existingSales) {
        parsed.sales.totalCases = mergeNonZero(parsed.sales.totalCases, existingSales.totalCases);
        parsed.sales.revenue = mergeNonZero(parsed.sales.revenue, existingSales.revenue);
        parsed.sales.qualityScore = mergeNonZero(parsed.sales.qualityScore, existingSales.qualityScore);
        parsed.sales.commonIssues = finalizeCommonIssuesForStorage(
          resolveCommonIssuesOnReimport(
            parsed.sales.commonIssues,
            existingSales.commonIssues,
          ),
        ).text;
      }

      // Task #1028: Re-apply the Active-Products gate AFTER the merge block.
      // The mergeNonZero / location-preservation logic above can otherwise
      // pull stale inactive-product values from the existing section back
      // into `parsed.marketing` (e.g. existing GBP locations on a now-Google-
      // Ads-only client), which would silently re-seed the storage invariant.
      applyActiveProductsFilter(parsed.marketing, reimportActiveProducts, {
        source: "reimport_post_merge",
        clientId: report.clientId,
        reportId: report.id,
      });

      // Task #3769 — broken-source import warning (reimport path). Uses the
      // POST-merge effective values: mergeNonZero keeps existing non-zero
      // Consults/Cases, so the warning only fires when BOTH the fresh PDF
      // and the stored section resolve to "not entered" while the client's
      // most recent prior report had the metric entered — or this parse's
      // raw Common Issues matched the "Missing data source" placeholder.
      // The warning persists onto the existing intake/sales rows immediately
      // (sections themselves persist later via editor autosave, and the
      // operator may cancel the review dialog — the warning must not depend
      // on that), is included in the response for an immediate banner, and
      // notifies the owner. Stale warnings from an earlier reimport clear
      // when the condition no longer holds; an operator save omitting the
      // key clears it too (gbpUnresolvedImports lifecycle). Best-effort:
      // never fails the reimport.
      let reimportImportWarnings: {
        missingMetrics: string[];
        placeholderSections: string[];
        priorReportMonth: string | null;
      } | null = null;
      try {
        const {
          BROKEN_SOURCE_WARNING_KEY,
          buildBrokenSourceNotification,
          computeBrokenSourceSectionWarning,
          loadPriorFunnelEntries,
          rawCommonIssuesMatchedPlaceholder,
        } = await import("../services/reportImportWarnings");
        const priorEntries = await loadPriorFunnelEntries(
          report.clientId,
          report.reportMonth,
          report.id,
        );
        const intakeWarning = computeBrokenSourceSectionWarning({
          sectionKey: "intake",
          effectiveValue: parsed.intake.totalConsults,
          noDataFlagged: existingIntake?.noDataFlags?.totalConsults === true,
          rawPlaceholder: rawCommonIssuesMatchedPlaceholder(parsed.fieldConfidence, "intake"),
          prior: priorEntries,
          source: "reimport",
        });
        const salesWarning = computeBrokenSourceSectionWarning({
          sectionKey: "sales",
          effectiveValue: parsed.sales.totalCases,
          noDataFlagged: existingSales?.noDataFlags?.totalCases === true,
          rawPlaceholder: rawCommonIssuesMatchedPlaceholder(parsed.fieldConfidence, "sales"),
          prior: priorEntries,
          source: "reimport",
        });

        const reimportWarnAttribution = {
          editor: req.user?.claims?.sub ? `user:${req.user.claims.sub}` : "system:reimport",
          source: "system" as const,
        };
        const persistSectionWarning = async (
          sectionKey: "intake" | "sales",
          warning: import("../services/reportImportWarnings").BrokenSourceSectionWarning | null,
          existingData: IntakeSectionRead | SalesSectionRead | undefined,
        ) => {
          if (!existingData) return;
          const hasStored = existingData[BROKEN_SOURCE_WARNING_KEY] !== undefined;
          if (!warning && !hasStored) return;
          const nextData: Record<string, any> = { ...existingData };
          if (warning) nextData[BROKEN_SOURCE_WARNING_KEY] = warning;
          else delete nextData[BROKEN_SOURCE_WARNING_KEY];
          await storage.upsertReportSection(
            { reportId: report.id, sectionKey, data: nextData },
            reimportWarnAttribution,
          );
        };
        await persistSectionWarning("intake", intakeWarning, existingIntake);
        await persistSectionWarning("sales", salesWarning, existingSales);

        if (intakeWarning || salesWarning) {
          reimportImportWarnings = {
            missingMetrics: [
              ...(intakeWarning?.missingMetrics ?? []),
              ...(salesWarning?.missingMetrics ?? []),
            ],
            placeholderSections: [
              ...(intakeWarning?.rawPlaceholder ? ["intake"] : []),
              ...(salesWarning?.rawPlaceholder ? ["sales"] : []),
            ],
            priorReportMonth:
              intakeWarning?.priorReportMonth ?? salesWarning?.priorReportMonth ?? null,
          };
          if (client?.ownerId) {
            const notification = buildBrokenSourceNotification({
              reportId: report.id,
              clientId: report.clientId,
              firmName: client.firmName,
              reportMonth: report.reportMonth,
              intakeWarning,
              salesWarning,
            });
            if (notification) {
              const { notifyUser } = await import("../services/notifications/userInbox");
              await notifyUser(client.ownerId, notification);
            }
          }
        }
      } catch (warnErr: any) {
        console.warn(
          `[Reimport] Broken-source import warning check skipped for report ${report.id}: ${warnErr?.message || warnErr}`,
        );
      }

      // Task #1848 — persist phase: log insert only. The parse + merge
      // work above is complete and the connection is reacquired here just
      // long enough for the audit row.
      try {
        await withDbAttribution("reports:reimport:persist", () =>
          db.insert(webhookImportLogs).values({
            clientId: report.clientId,
            clientName: client.firmName,
            reportMonth: report.reportMonth,
            reportId: report.id,
            status: "success",
            sectionsCreated: ["intake", "sales", "marketing"],
            fieldConfidence: parsed.fieldConfidence,
            pdfFileName: req.file?.originalname || "reimport.pdf",
            pdfSizeBytes: pdfBuffer.length,
            pdfSourceType: reimportSource,
            pdfExtractedText: (parsed as any)._extractedText || null,
          }),
        );
      } catch (logErr: any) {
        console.error("[Reimport] Failed to save import log:", logErr?.message);
      }

      // Task #2652 — refresh the saved private copy whenever the bytes did NOT
      // already come from the saved copy (manual upload, or a still-live
      // original-link fallback). This keeps subsequent "Re-parse from Source"
      // working and lets reports that previously had no saved copy gain one.
      // External I/O outside any held DB scope; non-fatal.
      if (!loadedFromSavedCopy) {
        try {
          const { saveReportSourcePdf } = await import("../services/reportSourcePdf");
          const sourcePdfKey = await saveReportSourcePdf(report.id, pdfBuffer);
          if (sourcePdfKey && sourcePdfKey !== report.sourcePdfStorageKey) {
            await db.update(reports).set({ sourcePdfStorageKey: sourcePdfKey }).where(eq(reports.id, report.id));
          }
        } catch (savePdfErr: any) {
          console.warn(`[Reimport] Failed to refresh source PDF copy for report ${report.id}: ${savePdfErr?.message || savePdfErr}`);
        }
      }

      const { _extractedText: _et, ...parsedResponse } = parsed as any;
      res.json({
        success: true,
        reimportSource,
        reportId: report.id,
        parsed: parsedResponse,
        // Task #2842 — reconciliation notes for the editor's review dialog.
        reconciliation: { webinarLeadQualityDiffers },
        // Task #3769 — broken-source warning for the immediate Report Form
        // banner (also persisted on the intake/sales sections).
        importWarnings: reimportImportWarnings,
      });
    } catch (error: any) {
      console.error("[Reimport] Failed:", error);
      res.status(500).json({ error: error?.message || "Reimport failed" });
    }
  });

  app.post("/api/reports", isAuthenticated, requireAccountManager, async (req: ValidatedBodyRequest<Record<string, unknown>>, res) => {
    try {
      const parsed = insertReportSchema.safeParse({
        ...req.body,
        createdBy: req.user?.claims?.sub,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      
      const userId = req.user?.claims?.sub;
      // F9: compile-only assertion — behavior is unchanged.
      const user = await storage.getUser(userId!);
      const client = await storage.getClient(parsed.data.clientId);
      
      if (!client) {
        return res.status(400).json({ error: "Client not found" });
      }
      
      // Check for existing report for this client/month combination
      const existingReports = await storage.getReportsByClient(parsed.data.clientId);
      const existingReport = existingReports.find(r => r.reportMonth === parsed.data.reportMonth);
      if (existingReport) {
        return res.status(409).json({ 
          error: "A report for this month already exists",
          existingReportId: existingReport.id
        });
      }
      
      const report = await storage.createReport(parsed.data);

      // Seed empty rows for every canonical section so the editor never sees a
      // "no row at all" state. Without this, sections were created lazily on
      // first save/PDF-reimport — and any report that was created manually
      // (no webhook/PDF, no operator save yet) would show blank fields that
      // bypass client-config defaulting (e.g. GBP locations didn't seed
      // because the load effect short-circuited on existing reports).
      const seedAttribution = {
        editor: userId || "system:report_create",
        source: "system" as const,
      };
      await Promise.all([
        storage.upsertReportSection({ reportId: report.id, sectionKey: "intake",      data: {} }, seedAttribution),
        storage.upsertReportSection({ reportId: report.id, sectionKey: "sales",       data: {} }, seedAttribution),
        storage.upsertReportSection({ reportId: report.id, sectionKey: "marketing",   data: {} }, seedAttribution),
        storage.upsertReportSection({ reportId: report.id, sectionKey: "nextActions", data: {} }, seedAttribution),
      ]);

      if (parsed.data.clientId && parsed.data.reportMonth) {
        try {
          const { onMonthlyReportGenerated } = await import("../services/semrushInventorySync");
          onMonthlyReportGenerated(parsed.data.clientId, parsed.data.reportMonth).catch((err: any) => {
            console.warn(`[Reports] Semrush refresh on report creation failed (non-fatal): ${err?.message}`);
          });
        } catch {
          // import-only guard; the refresh itself logs via .catch above
          // (F10 disposition: retained)
        }
      }

      res.status(201).json(report);
    } catch (error) {
      console.error("Error creating report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.patch("/api/reports/:id", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ id: string }, Record<string, unknown>>, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      const userId = req.user?.claims?.sub;
      // F9: compile-only assertion — behavior is unchanged.
      const user = await storage.getUser(userId!);
      const client = await storage.getClient(report.clientId);
      
      if (req.body.status === "final" && report.status !== "final") {
        const { isReviewedThisMonth, getCurrentMonthKey } = await import("../storage/commandCenterStorage");
        const panel = await storage.getCommandPanel(report.clientId);
        if (!isReviewedThisMonth(panel?.lastReviewedAt ?? null)) {
          try {
            const ownerId = client?.ownerId;
            if (ownerId) {
              const monthKey = getCurrentMonthKey();
              // Task #1713 — Stage B: per-user inbox via notifyUser().
              const { notifyReportFinalizationBlocked } = await import(
                "../services/notifications/monthlyReview"
              );
              await notifyReportFinalizationBlocked({
                ownerId,
                reportId: report.id,
                clientId: report.clientId,
                firmName: client?.firmName,
                monthKey,
              });
            }
          } catch (notifErr) {
            console.error("[Reports] Error creating review-blocked notification:", notifErr);
          }
          return res.status(422).json({
            error: "monthly_review_required",
            message: "This report cannot be finalized until the client's command panel has been reviewed this month.",
            clientId: report.clientId,
          });
        }

        // Task #3769 — broken-source finalize confirmation, enforced
        // SERVER-side (the Report Form dialog is UI sugar; a direct API
        // call must hit the same gate). When a persisted broken-source
        // import warning flags Consults/Cases that are STILL not entered,
        // finalizing requires the explicit `confirmBrokenSourceFinalize:
        // true` request field. A stale warning (metric since entered, or
        // warning cleared by an operator save) never blocks. A No-Data flag
        // does NOT resolve the warning — historical imports stamped flags on
        // the metrics they warned about, so a flag alone cannot prove an
        // operator decision (Task #3813).
        const { computeStillMissingBrokenSourceMetrics, funnelMetricLabel } =
          await import("../services/reportImportWarnings");
        const reportSections = await storage.getReportSections(report.id);
        const stillMissing = computeStillMissingBrokenSourceMetrics(reportSections);
        if (stillMissing.length > 0 && req.body.confirmBrokenSourceFinalize !== true) {
          return res.status(422).json({
            error: "broken_source_confirm_required",
            message: `This report's import flagged ${stillMissing
              .map(funnelMetricLabel)
              .join(" and ")} as missing from a broken upstream data source and ${
              stillMissing.length > 1 ? "they are" : "it is"
            } still not entered. Re-submit with confirmBrokenSourceFinalize: true to finalize anyway.`,
            missingMetrics: stillMissing,
          });
        }

        // Task #4273 — slide-verdict quality floor, enforced server-side at
        // finalize. Unlike the two confirm-able gates around it, this one is
        // a HARD 422: the mandate is that degenerate verdict copy can NEVER
        // reach a finalized report, and remediation is one click in the
        // editor (fix the sentence or clear it — an absent verdict is always
        // allowed). AI-generated verdicts are floor-filtered before storage,
        // so this gate bites only on operator-typed junk.
        {
          const verdictsRow = reportSections.find(
            (s) => s.sectionKey === SLIDE_VERDICTS_SECTION_KEY,
          );
          const verdictsData = readOptionalSectionDataObject(verdictsRow?.data, {
            sectionId: verdictsRow?.id,
            reportId: report.id,
            clientId: report.clientId,
          });
          const storedVerdicts = sanitizeSlideVerdictMap(verdictsData?.verdicts);
          const degenerateVerdicts: Array<{
            slideKey: SlideVerdictKey;
            reason: string;
            snippet: string;
          }> = [];
          for (const slideKey of SLIDE_VERDICT_KEYS) {
            const problem = findDegenerateVerdict(storedVerdicts[slideKey]);
            if (problem) {
              degenerateVerdicts.push({ slideKey, ...problem });
            }
          }
          if (degenerateVerdicts.length > 0) {
            const phrases = degenerateVerdicts.map(
              (d) =>
                `${SLIDE_VERDICT_LABELS[d.slideKey]} (${verdictProblemLabel(
                  d.reason as any,
                )}: ${JSON.stringify(d.snippet)})`,
            );
            return res.status(422).json({
              error: "verdict_quality_floor",
              message: `Slide verdicts below the publish floor — fix or clear them before finalizing: ${phrases.join("; ")}.`,
              degenerateVerdicts,
            });
          }
        }

        // Task #4227 — report-quality finalize gate. A real January 2026
        // report reached "Final" carrying degenerate AI Common Issues copy
        // ("Issue: Being Bad → Impact: Poor behavior"), and nothing stops a
        // report finalizing with an empty Next 30 Days (the report's climax
        // slide renders "No actions defined" in both columns). Both gaps now
        // require the explicit `confirmReportQualityFinalize: true` request
        // field (same server-side confirm pattern as the broken-source gate
        // above — the Report Form dialog is UI sugar; a direct API call hits
        // the same gate).
        const { findDegenerateCommonIssues } = await import(
          "../services/commonIssuesFormatter"
        );
        const degenerateCommonIssues: Array<{
          section: "intake" | "sales";
          problems: { reason: string; snippet: string }[];
        }> = [];
        for (const sectionKey of ["intake", "sales"] as const) {
          const sectionRow = reportSections.find((s) => s.sectionKey === sectionKey);
          const sectionData = readOptionalSectionDataObject(sectionRow?.data, {
            sectionId: sectionRow?.id,
            reportId: report.id,
            clientId: report.clientId,
          });
          const problems = findDegenerateCommonIssues(sectionData?.commonIssues);
          if (problems.length > 0) {
            degenerateCommonIssues.push({ section: sectionKey, problems });
          }
        }

        const nextActionsRow = reportSections.find((s) => s.sectionKey === "nextActions");
        const nextActionsData = readOptionalSectionDataObject(nextActionsRow?.data, {
          sectionId: nextActionsRow?.id,
          reportId: report.id,
          clientId: report.clientId,
        });
        const hasRealActions = (list: unknown): boolean =>
          Array.isArray(list) &&
          list.some(
            (a: any) => typeof a?.action === "string" && a.action.trim().length > 0,
          );
        const emptyNextActionsColumns: Array<"ours" | "theirs"> = [];
        if (!hasRealActions(nextActionsData?.ours)) emptyNextActionsColumns.push("ours");
        if (!hasRealActions(nextActionsData?.theirs)) emptyNextActionsColumns.push("theirs");

        if (
          (degenerateCommonIssues.length > 0 || emptyNextActionsColumns.length > 0) &&
          req.body.confirmReportQualityFinalize !== true
        ) {
          const gapPhrases: string[] = [];
          for (const d of degenerateCommonIssues) {
            gapPhrases.push(
              `${d.section === "intake" ? "Intake" : "Sales"} Common Issues copy is too thin to publish (e.g. ${JSON.stringify(
                d.problems[0]?.snippet ?? "",
              )})`,
            );
          }
          if (emptyNextActionsColumns.length > 0) {
            const colLabels = emptyNextActionsColumns
              .map((c) => (c === "ours" ? "Our Actions" : "Your Actions"))
              .join(" and ");
            gapPhrases.push(
              `Next 30 Days has no entries in ${colLabels} — the report will show "No actions defined"`,
            );
          }
          return res.status(422).json({
            error: "report_quality_confirm_required",
            message: `${gapPhrases.join("; ")}. Fix the content or re-submit with confirmReportQualityFinalize: true to finalize anyway.`,
            degenerateCommonIssues,
            emptyNextActionsColumns,
          });
        }
      }

      // Never persist the confirmation flags — they are request-level
      // fields, not report columns.
      const {
        confirmBrokenSourceFinalize: _confirmBrokenSource,
        confirmReportQualityFinalize: _confirmReportQuality,
        // Task #4537 — "Presented / Delivered" request field: validated by
        // the focused schema below and translated into a server-derived
        // stamp, never written through the generic update path.
        presented: presentedRaw,
        ...reportUpdates
      } = req.body ?? {};
      // F8 (Task #4153) — validate the remainder through the shared update
      // schema: unknown keys are stripped and the server-managed columns
      // (clientId, createdBy, shareToken, webhookImportLogId,
      // sourcePdfStorageKey, ceoPulseId, presentedAt, presentedBy) can never
      // be written via PATCH.
      const parsedUpdate = updateReportSchema.safeParse(reportUpdates);
      if (!parsedUpdate.success) {
        return res.status(400).json({ error: parsedUpdate.error.issues });
      }

      // Task #4537 — operator "Presented / Delivered" mark. The client sends
      // only a boolean; the server derives WHO and WHEN:
      //   true on an unpresented report  → { presentedAt: now, presentedBy: actor }
      //   true on a presented report     → no-op (Save loops never re-stamp
      //                                    or re-attribute the original mark)
      //   false                          → clears both (mistakes happen)
      //   absent                         → presented state untouched
      let presentedStamp:
        | { presentedAt: Date | null; presentedBy: string | null }
        | undefined;
      if (presentedRaw !== undefined) {
        const parsedPresented = reportPresentedUpdateSchema.safeParse({
          presented: presentedRaw,
        });
        if (!parsedPresented.success) {
          return res.status(400).json({ error: parsedPresented.error.issues });
        }
        if (parsedPresented.data.presented && !report.presentedAt) {
          presentedStamp = { presentedAt: new Date(), presentedBy: userId ?? null };
        } else if (
          !parsedPresented.data.presented &&
          (report.presentedAt !== null || report.presentedBy !== null)
        ) {
          presentedStamp = { presentedAt: null, presentedBy: null };
        }
      }

      const updated = await storage.updateReport(req.params.id, parsedUpdate.data);
      const finalReport =
        presentedStamp !== undefined
          ? await storage.setReportPresented(req.params.id, presentedStamp)
          : updated;
      res.json(finalReport ?? updated);

      // Task #4240 — finalize-time AI trend commentary cache. Generate the
      // "Current Position" / "Demand Shape Ahead" analysis ONCE here (an
      // auth-gated operator action) and store it with the report, so the
      // anonymous /api/share/:token payload can serve the SAME text without
      // ever reaching OpenAI. Fire-and-forget after the response: finalize
      // must never wait on (or be failed by) the AI layer; the helper logs
      // and no-ops on failure, and a failed run never clobbers a previously
      // stored good copy. Idempotent upsert on (report_id, section_key).
      if (parsedUpdate.data.status === "final" && report.status !== "final") {
        const finalizeAreas: string[] = Array.isArray(client?.practiceAreas)
          ? client.practiceAreas
          : [];
        if (finalizeAreas.length > 0) {
          void (async () => {
            const { generateAndStoreSeasonalTrendAiAnalysis } = await import(
              "../services/practiceAreaTrendAnalysis"
            );
            await generateAndStoreSeasonalTrendAiAnalysis({
              reportId: report.id,
              practiceAreas: finalizeAreas,
              openaiClient: openai,
            });
          })().catch((err) =>
            console.error(
              "[Reports] seasonal trend AI cache generation failed (report already finalized):",
              err,
            ),
          );
        }

        // Task #4902 — the Task #4273 finalize-time slide-verdict AI kick
        // that used to live here is REMOVED by owner mandate: finalizing a
        // report never generates verdict copy. Verdicts are operator-authored
        // via the editor's Verdicts tab (with its per-slide, human-in-the-loop
        // "Draft with AI" endpoint below); slides without a stored verdict
        // simply render without the line.
      }
    } catch (error) {
      console.error("Error updating report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Delete report - Team Lead+ only
  app.delete("/api/reports/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }

      await storage.deleteReport(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Duplicate report - creates a copy with a new month
  app.post("/api/reports/:id/duplicate", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ id: string }, { targetMonth?: string; newMonth?: string; newClientId?: string }>, res) => {
    try {
      // Task #1848 — read phase: pull every input the persist step needs
      // under a single labelled scope so the pool wrapper attributes any
      // checkout to `reports:duplicate:fetch` instead of the bare
      // route-level label. Each storage.* call still releases its
      // connection between hops; the label scope just names them.
      const userId = req.user?.claims?.sub;
      const { targetMonth, newMonth, newClientId } = req.body;
      const month = newMonth || targetMonth;
      if (!month) {
        return res.status(400).json({ error: "Target month is required" });
      }

      const fetchResult = await withDbAttribution("reports:duplicate:fetch", async () => {
        const originalReport = await storage.getReport(req.params.id);
        if (!originalReport) {
          return { error: { status: 404, body: { error: "Report not found" } } } as const;
        }
        const targetClientId = newClientId || originalReport.clientId;
        if (newClientId && newClientId !== originalReport.clientId) {
          const targetClient = await storage.getClient(newClientId);
          if (!targetClient) {
            return { error: { status: 404, body: { error: "Target client not found" } } } as const;
          }
        }
        const existingReports = await storage.getReportsByClient(targetClientId);
        const duplicate = existingReports.find(r => r.reportMonth === month);
        if (duplicate) {
          return { error: { status: 400, body: { error: "A report already exists for this client/month" } } } as const;
        }
        const originalSections = normalizeSections(await storage.getReportSections(originalReport.id));
        return { ok: { originalReport, targetClientId, originalSections } } as const;
      });

      if (fetchResult.error) {
        return res.status(fetchResult.error.status).json(fetchResult.error.body);
      }
      const { originalReport, targetClientId, originalSections } = fetchResult.ok;

      // Task #1848 — persist phase: short labelled transaction containing
      // only DB writes. No external/AI/compute work inside the hold.
      const newReport = await withDbAttribution("reports:duplicate:persist", () => db.transaction(async (tx) => {
        // Create new report with metadata copied from original
        const newId = crypto.randomUUID();
        const shareToken = crypto.randomUUID();
        const now = new Date();
        
        const [createdReport] = await tx.insert(reports).values({
          id: newId,
          clientId: targetClientId,
          reportMonth: month,
          status: "draft",
          createdBy: userId,
          shareToken,
          privacyMode: originalReport.privacyMode || false,
          hideLeadQuality: originalReport.hideLeadQuality || false,
          createdAt: now,
          updatedAt: now,
        }).returning();
        
        // Copy all sections from original report. Seed audit metadata + a
        // history row so the duplicated report has explicit attribution.
        const dupEditor = `user:${userId}`;
        const dupSource = "system";
        const dupNow = new Date();
        for (const section of originalSections) {
          const [inserted] = await tx.insert(reportSections).values({
            reportId: newId,
            sectionKey: section.sectionKey,
            data: section.data,
            lastEditedBy: dupEditor,
            lastEditSource: dupSource,
            lastEditAt: dupNow,
          }).returning();
          await tx.insert(reportSectionHistory).values({
            reportSectionId: inserted.id,
            reportId: newId,
            sectionKey: section.sectionKey,
            previousData: null,
            newData: section.data,
            editedBy: dupEditor,
            editSource: dupSource,
          });
        }
        
        return createdReport;
      }));
      
      res.status(201).json(newReport);
    } catch (error) {
      console.error("Error duplicating report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Report sections
  app.get("/api/reports/:id/sections", isAuthenticated, async (req: any, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const client = await storage.getClient(report.clientId);
      
      const sections = normalizeSections(await storage.getReportSections(report.id));
      res.json(sections);
    } catch (error) {
      console.error("Error fetching report sections:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  app.put("/api/reports/:id/sections/:sectionKey", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ id: string; sectionKey: string }, { expectedUpdatedAt?: string; data?: Record<string, any>; editSource?: unknown; importMeta?: { placeholderSections?: unknown } }>, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      const userId = req.user?.claims?.sub;
      // F9: compile-only assertion — behavior is unchanged.
      const user = await storage.getUser(userId!);
      const client = await storage.getClient(report.clientId);
      
      // Optimistic concurrency control - check if section was modified since client loaded it
      const sectionKey = req.params.sectionKey;
      const expectedUpdatedAt = req.body.expectedUpdatedAt;
      
      if (expectedUpdatedAt) {
        const existingSection = await storage.getReportSection(report.id, sectionKey);
        if (existingSection && existingSection.updatedAt) {
          const serverTime = new Date(existingSection.updatedAt).getTime();
          const clientTime = new Date(expectedUpdatedAt).getTime();
          // Allow 2 second tolerance for network delays
          if (serverTime > clientTime + 2000) {
            return res.status(409).json({ 
              error: "This section was modified by another user. Please refresh and try again.",
              code: "CONFLICT",
              serverUpdatedAt: existingSection.updatedAt,
            });
          }
        }
      }
      
      // Validate section data based on section key (uses .partial() for flexibility)
      let sectionData: Record<string, any> = req.body.data || {};

      // Task #4273 — the slideVerdicts key is an internal payload row, so
      // unlike the legacy log-only section schemas below its write path is
      // STRICT (persistence-write-boundary rules): focused zod parse, 400 on
      // shape violations, unknown keys stripped, values trimmed and empties
      // dropped. No quality floor here — mid-edit autosaves must succeed;
      // the floor bites at finalize (and on AI output before storage).
      if (sectionKey === SLIDE_VERDICTS_SECTION_KEY) {
        const parsedVerdicts = slideVerdictsSectionSchema.safeParse(sectionData);
        if (!parsedVerdicts.success) {
          return res.status(400).json({ error: parsedVerdicts.error.issues });
        }
        sectionData = { verdicts: sanitizeSlideVerdictMap(parsedVerdicts.data.verdicts) };
      }

      // Server-side sanitization helper for numeric values
      const safeNum = (v: any, min = 0, max?: number): number => {
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (isNaN(n) || !isFinite(n)) return min;
        const clamped = Math.max(min, max !== undefined ? Math.min(n, max) : n);
        return Math.round(clamped * 100) / 100; // Round to 2 decimal places
      };
      
      // Sanitize key numeric fields to prevent invalid values
      if (sectionKey === 'intake') {
        sectionData = {
          ...sectionData,
          totalConsults: sectionData.totalConsults !== undefined ? safeNum(sectionData.totalConsults) : undefined,
          missedCallRate: sectionData.missedCallRate !== undefined ? safeNum(sectionData.missedCallRate, 0, 100) : undefined,
          avgTimeToAnswer: sectionData.avgTimeToAnswer !== undefined ? safeNum(sectionData.avgTimeToAnswer) : undefined,
          qualityScore: sectionData.qualityScore !== undefined ? safeNum(sectionData.qualityScore, 0, 100) : undefined,
          leadToConsultRate: sectionData.leadToConsultRate !== undefined ? safeNum(sectionData.leadToConsultRate, 0, 100) : undefined,
        };
      } else if (sectionKey === 'sales') {
        sectionData = {
          ...sectionData,
          totalCases: sectionData.totalCases !== undefined ? safeNum(sectionData.totalCases) : undefined,
          consultToCaseRate: sectionData.consultToCaseRate !== undefined ? safeNum(sectionData.consultToCaseRate, 0, 100) : undefined,
          averageCaseValue: sectionData.averageCaseValue !== undefined ? safeNum(sectionData.averageCaseValue) : undefined,
          noShowRate: sectionData.noShowRate !== undefined ? safeNum(sectionData.noShowRate, 0, 100) : undefined,
          avgFollowUps: sectionData.avgFollowUps !== undefined ? safeNum(sectionData.avgFollowUps) : undefined,
          qualityScore: sectionData.qualityScore !== undefined ? safeNum(sectionData.qualityScore, 0, 100) : undefined,
        };
      } else if (sectionKey === 'nextActions') {
        // Task #4282 — focused sanitize for the NEW accountability fields
        // (persistence-write-boundary rules for additions; the legacy
        // action/why/notes fields keep their grandfathered log-only lane
        // below). owner/due: strings only, trimmed, hard-capped, empties
        // dropped. showExpansionQuestion: strict boolean — anything but
        // `true` stores false, so the expansion band can never be turned on
        // by a junk value.
        const sanitizeActionList = (list: unknown): unknown => {
          if (!Array.isArray(list)) return list;
          return list.map((item: any) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item;
            const out: Record<string, unknown> = { ...item };
            const cleanShortText = (v: unknown, maxChars: number): string | undefined => {
              if (typeof v !== "string") return undefined;
              const trimmed = v.trim().slice(0, maxChars).trim();
              return trimmed.length > 0 ? trimmed : undefined;
            };
            const owner = cleanShortText(out.owner, NEXT_ACTION_OWNER_MAX_CHARS);
            if (owner !== undefined) out.owner = owner;
            else delete out.owner;
            const due = cleanShortText(out.due, NEXT_ACTION_DUE_MAX_CHARS);
            if (due !== undefined) out.due = due;
            else delete out.due;
            return out;
          });
        };
        if (sectionData.ours !== undefined) sectionData.ours = sanitizeActionList(sectionData.ours);
        if (sectionData.theirs !== undefined) sectionData.theirs = sanitizeActionList(sectionData.theirs);
        if ('showExpansionQuestion' in sectionData) {
          sectionData.showExpansionQuestion = sectionData.showExpansionQuestion === true;
        }
      }
      
      const sectionSchemas: Record<string, any> = {
        'intake': intakeSectionSchema.partial().passthrough(),
        'sales': salesSectionSchema.partial().passthrough(),
        'marketing': marketingSectionSchema.deepPartial().passthrough(),
        'nextActions': nextActionsSectionSchema.partial().passthrough(),
      };
      
      const schema = sectionSchemas[sectionKey];
      if (schema) {
        const validation = schema.safeParse(sectionData);
        if (!validation.success) {
          console.warn(`Section ${sectionKey} validation warnings:`, validation.error.issues);
          // Log but don't block - allow partial data
        }
      }
      
      if (sectionKey === 'marketing' && report.clientId) {
        // Task #1028: Active-Products gate at the section-PUT boundary so
        // any UI edit, AI re-format, or manual-PDF upload that tries to set
        // platform fields for an inactive product is silently dropped before
        // it ever lands in storage.
        try {
          // Task #1028: canonical resolver for section-write Active-Products gate.
          const sectionResolution = await getActiveProductsForClient(report.clientId);
          logResolution("section_put", { ...sectionResolution, reportId: report.id });
          const sectionActiveProducts = sectionResolution.products;
          applyActiveProductsFilter(sectionData, sectionActiveProducts, {
            source: "section_put",
            clientId: report.clientId,
            reportId: report.id,
          });
        } catch (e: any) {
          console.warn("[Reports] Active-products filter skipped on section PUT:", e?.message);
        }

        const locations = sectionData.gbp?.locations || sectionData.gbpLocations || [];
        const locationsWithSnapshots = locations.filter((loc: any) => loc.heatmapSnapshotIds?.length > 0 || loc.heatmapSnapshotId);
        if (locationsWithSnapshots.length > 0) {
          try {
            // Task #1810 — bulk variant in place of per-location calls.
            const { getLocalDominanceDataForReportBulk } = await import("../services/localDominanceService");
            type IndexedLoc = { loc: any; idx: number; key: string; snapshotIds: string[] };
            const indexed: IndexedLoc[] = (locations as any[]).map((loc: any, idx: number) => {
              const snapshotIds = loc.heatmapSnapshotIds?.length > 0 ? loc.heatmapSnapshotIds : loc.heatmapSnapshotId ? [loc.heatmapSnapshotId] : [];
              return { loc, idx, key: `idx:${idx}`, snapshotIds };
            });
            const bulkInput = indexed
              .filter((p: IndexedLoc) => p.snapshotIds.length > 0 && !p.loc.localDominance)
              .map((p: IndexedLoc) => ({ locationId: p.key, snapshotIds: p.snapshotIds }));
            let dominanceMap = new Map<string, any>();
            if (bulkInput.length > 0) {
              try {
                dominanceMap = await getLocalDominanceDataForReportBulk(report.clientId, bulkInput);
              } catch (e: any) {
                console.warn(`[Reports] Bulk local-dominance enrichment failed:`, e?.message);
              }
            }
            const enrichedLocations = indexed.map(({ loc, key, snapshotIds }: IndexedLoc) => {
              if (snapshotIds.length === 0 || loc.localDominance) return loc;
              const localDominanceData = dominanceMap.get(key);
              return localDominanceData ? { ...loc, localDominance: localDominanceData } : loc;
            });
            if (sectionData.gbp?.locations) {
              sectionData.gbp.locations = enrichedLocations;
            } else if (sectionData.gbpLocations) {
              sectionData.gbpLocations = enrichedLocations;
            }
          } catch (e: any) {
            console.warn("[Reports] Failed to enrich marketing section with local dominance:", e?.message);
          }
        }
      }

      const requestedEditSource = req.body.editSource;
      // "curated_library" — Task #4254: operator explicitly replaced thin
      // Common Issues copy with curated blocks from the copy library.
      const allowedClientSources = new Set(["ui_edit", "ai_format", "manual_pdf_upload", "curated_library"]);
      const editSource = (typeof requestedEditSource === "string" && allowedClientSources.has(requestedEditSource))
        ? (requestedEditSource as "ui_edit" | "ai_format" | "manual_pdf_upload" | "curated_library")
        : "ui_edit";

      // Task #3533 — convergence-stamp preservation on operator/editor saves.
      // This PUT replaces the section's `data` wholesale, which used to wipe
      // the June-2026 lead-reparse stamps (marketing) and the Common Issues
      // reformat stamp (intake/sales) whenever an editor session saved data
      // loaded before a backfill stamped the row — silently re-arming the
      // one-time prod-actions. Stamps the client does not send are carried
      // forward from the stored section; client-sent values win. Additionally,
      // formatter-backed saves ('manual_pdf_upload' reimports and the editor's
      // 'ai_format' button) stamp intake/sales fresh — their Common Issues
      // just went through the shared formatter, so the back-catalog reformat
      // action must not re-count them.
      try {
        const stampKeys: string[] = [];
        if (sectionKey === "marketing") {
          const { JUNE_LEAD_REPARSE_STAMP_KEY, JUNE_LEAD_REPARSE_OUTCOME_KEY } =
            await import("../services/juneLeadReparse");
          stampKeys.push(JUNE_LEAD_REPARSE_STAMP_KEY, JUNE_LEAD_REPARSE_OUTCOME_KEY);
        } else if (sectionKey === "intake" || sectionKey === "sales") {
          const { REFORMAT_STAMP_KEY, COMMON_ISSUES_REFORMAT_BACKFILL_VERSION } =
            await import("../services/commonIssuesReformatBackfill");
          // Task #4054 — the PUT used to store client-sent Common Issues text
          // verbatim and stamp it fresh on formatter-backed saves without
          // verifying the text, so a malformed single-line section could be
          // born pre-stamped and only get caught days later by the backfill's
          // revival arm. Normalize on write; stamp (fresh OR carried forward)
          // ONLY when the stored text is well-formed.
          const hasClientIssuesText = typeof sectionData.commonIssues === "string";
          const issuesFinal = hasClientIssuesText
            ? finalizeCommonIssuesForStorage(sectionData.commonIssues)
            : null;
          if (issuesFinal) sectionData.commonIssues = issuesFinal.text;
          if (issuesFinal && !issuesFinal.stampable) {
            // Never persist the formatted stamp alongside text the malformed-
            // shape detector still flags — drop any client-sent stamp and skip
            // the carry-forward below so the regular reformat backfill picks
            // the row up (instead of the late revival arm).
            delete sectionData[REFORMAT_STAMP_KEY];
          } else {
            stampKeys.push(REFORMAT_STAMP_KEY);
            // Task #4862 — stamp at write time for ALL save paths (ui_edit and
            // curated_library included), not only formatter-backed ones. When
            // finalizeCommonIssuesForStorage marks the text stampable it means
            // the structure is already well-formed; an AI reformat pass would
            // return identical text ("0 changed") and just burn an OpenAI call.
            // Previously only manual_pdf_upload/ai_format stamped fresh here;
            // ui_edit and curated_library fell through to the carry-forward
            // path, which silently left rows un-stamped when the stored section
            // had no prior stamp — re-arming the backfill action on every
            // operator edit. Prod evidence (2026-08-14 and 2026-08-17 presses)
            // confirmed: every operator-edited candidate came back "0 changed".
            sectionData[REFORMAT_STAMP_KEY] = COMMON_ISSUES_REFORMAT_BACKFILL_VERSION;
          }
        }
        if (stampKeys.some((k) => sectionData[k] === undefined)) {
          const existingPutSections = normalizeSections(
            await storage.getReportSections(report.id),
          );
          const existingPutData = readOptionalSectionDataObject(
            existingPutSections.find((s) => s.sectionKey === sectionKey)?.data,
            { reportId: report.id, clientId: report.clientId },
          );
          if (existingPutData) {
            for (const key of stampKeys) {
              if (sectionData[key] === undefined && existingPutData[key] !== undefined) {
                sectionData[key] = existingPutData[key];
              }
            }
          }
        }
      } catch (stampErr: any) {
        console.warn(
          `[Reports] Convergence-stamp preservation skipped on section PUT (${sectionKey}):`,
          stampErr?.message,
        );
      }

      // Task #3769 — broken-source import warning (manual-upload path). The
      // create-with-import flow saves parsed sections through this PUT with
      // editSource 'manual_pdf_upload' (the import-pdf parse route is
      // stateless — no client/report in scope there), so the funnel
      // missing-vs-prior check runs here: warn when the saved Consults
      // (intake) / Cases (sales) resolve to "not entered" while the client's
      // most recent prior report had them entered, or when the parse's raw
      // Common Issues matched the "Missing data source" placeholder (echoed
      // back by the client as importMeta.placeholderSections). The warning
      // key is injected into the data object this PUT is about to write —
      // no extra write, no race with the parallel sibling-section save.
      // Normal saves (ui_edit/autosave) omit the key, clearing it — the
      // gbpUnresolvedImports lifecycle. Best-effort: never blocks the save.
      if (
        (sectionKey === "intake" || sectionKey === "sales") &&
        editSource === "manual_pdf_upload"
      ) {
        try {
          const {
            BROKEN_SOURCE_WARNING_KEY,
            buildBrokenSourceNotification,
            computeBrokenSourceSectionWarning,
            loadPriorFunnelEntries,
            rawCommonIssuesMatchedPlaceholder: _unusedRawCheck,
          } = await import("../services/reportImportWarnings");
          const importMeta = req.body?.importMeta;
          const rawPlaceholder =
            Array.isArray(importMeta?.placeholderSections) &&
            importMeta.placeholderSections.includes(sectionKey);
          const priorEntries = await loadPriorFunnelEntries(
            report.clientId,
            report.reportMonth,
            report.id,
          );
          const warning = computeBrokenSourceSectionWarning({
            sectionKey,
            effectiveValue:
              sectionKey === "intake" ? sectionData.totalConsults : sectionData.totalCases,
            noDataFlagged:
              sectionKey === "intake"
                ? sectionData.noDataFlags?.totalConsults === true
                : sectionData.noDataFlags?.totalCases === true,
            rawPlaceholder,
            prior: priorEntries,
            source: "manual_pdf_upload",
          });
          if (warning) {
            sectionData[BROKEN_SOURCE_WARNING_KEY] = warning;
            if (client?.ownerId) {
              const notification = buildBrokenSourceNotification({
                reportId: report.id,
                clientId: report.clientId,
                firmName: client.firmName,
                reportMonth: report.reportMonth,
                intakeWarning: sectionKey === "intake" ? warning : null,
                salesWarning: sectionKey === "sales" ? warning : null,
              });
              if (notification) {
                try {
                  const { notifyUser } = await import("../services/notifications/userInbox");
                  await notifyUser(client.ownerId, notification);
                } catch (notifyErr: any) {
                  console.warn(
                    `[Reports] Broken-source import notification failed for report ${report.id}: ${notifyErr?.message || notifyErr}`,
                  );
                }
              }
            }
          }
        } catch (warnErr: any) {
          console.warn(
            `[Reports] Broken-source import warning check skipped on section PUT (${sectionKey}):`,
            warnErr?.message,
          );
        }
      }

      const section = await storage.upsertReportSection({
        reportId: report.id,
        sectionKey: sectionKey,
        data: sectionData,
      }, {
        editor: `user:${userId}`,
        source: editSource,
      });
      
      // Auto-set data access based on section data (Command Panel tracking
      // metadata only — Task #3688 removed its effect on report rendering).
      // Task #3688 — a quality score alone is NOT consult-booking data; only
      // genuine consult fields (count or lead→consult rate) flip the category,
      // so a score-only save can't mark consult data "available".
      if (sectionKey === 'intake') {
        if (hasGenuineConsultBookingData(sectionData)) {
          await storage.upsertClientDataAccess({ clientId: report.clientId, category: 'consult_bookings', status: 'available' });
        }
      }
      
      if (sectionKey === 'sales') {
        const hasSalesData = sectionData.totalCases > 0 || sectionData.consultToCaseRate > 0 || sectionData.avgCaseValue > 0;
        if (hasSalesData) {
          await storage.upsertClientDataAccess({ clientId: report.clientId, category: 'sales_conversions', status: 'available' });
        }
      }

      // Task #2851 — if this save LEAVES the webinar breakdown disagreeing
      // with Hot Transfers (same predicate as the editor's inline warning +
      // the CEO review panel), proactively notify the editor/owner via the
      // standard notifyUser() inbox path. Best-effort: never blocks the save.
      if (sectionKey === 'marketing') {
        try {
          const { notifyWebinarBreakdownMismatchOnSave } = await import(
            "../services/webinarBreakdownMismatchReview"
          );
          await notifyWebinarBreakdownMismatchOnSave({
            report,
            client,
            savedData: section.data,
            actorUserId: userId,
          });
        } catch (e: any) {
          console.warn("[Reports] webinar mismatch notification skipped:", e?.message);
        }
      }

      res.json(section);
    } catch (error) {
      console.error("Error updating report section:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Task #829: Admin-only audit trail for a report section.
  // Task #4667 — intended role: team_lead+. The gate was previously a
  // hand-rolled in-handler role check (invisible to the route inventory's
  // protection column); it now uses the shared requireTeamLead middleware,
  // mirroring Task #4644. Note: the legacy "admin" role shortcut the old
  // check accepted is deliberately dropped — unknown roles rank 0 on the
  // ROLE_LEVELS ladder (reused-endpoint authz parity, no legacy-role
  // shortcuts).
  app.get("/api/reports/:id/sections/:sectionKey/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) return res.status(404).json({ error: "Report not found" });
      const history = await storage.getReportSectionHistory(req.params.id, req.params.sectionKey);
      const { resolveLastEditedUsers } = await import("./lastEditedHelper");
      const userIds = history
        .map((h) => {
          const m = /^user:(.+)$/.exec(h.editedBy || "");
          return m ? m[1] : null;
        })
        .filter((id): id is string => !!id);
      const userMap = await resolveLastEditedUsers(userIds);
      const enriched = history.map((h) => {
        const m = /^user:(.+)$/.exec(h.editedBy || "");
        const user = m ? userMap.get(m[1]) ?? null : null;
        return { ...h, editorUser: user };
      });
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching report section history:", error);
      res.status(500).json({ error: "Failed to fetch section history" });
    }
  });

  // Task #4273 — AI-draft a single slide verdict for the report editor.
  // Authenticated + rate-limited; returns the sentence WITHOUT storing it —
  // the operator applies/edits it in the form and the save flows through the
  // strict slideVerdicts branch of the section PUT (human in the loop).
  // Degenerate AI output is floor-filtered inside generateSlideVerdicts, so
  // a junk draft comes back as a 502 here, never as prefilled junk.
  app.post("/api/reports/:id/verdicts/draft", isAuthenticated, requireAccountManager, aiLimiter, async (req: AuthenticatedRequest<{ id: string }, { slideKey?: unknown }>, res: Response) => {
    try {
      const slideKey = req.body?.slideKey;
      if (
        typeof slideKey !== "string" ||
        !(SLIDE_VERDICT_KEYS as readonly string[]).includes(slideKey)
      ) {
        return res.status(400).json({
          error: "invalid_slide_key",
          message: `slideKey must be one of: ${SLIDE_VERDICT_KEYS.join(", ")}`,
        });
      }
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      const client = await storage.getClient(report.clientId);
      const sections = normalizeSections(await storage.getReportSections(report.id));

      // Seasonal phase context (marketContext slide only) — deterministic
      // local computation, best-effort.
      let seasonalPhases: Record<string, string> | null = null;
      const draftAreas: string[] = Array.isArray(client?.practiceAreas)
        ? client.practiceAreas
        : [];
      if (slideKey === "marketContext" && draftAreas.length > 0) {
        try {
          const { computePracticeAreaTrendData } = await import(
            "../services/practiceAreaTrendData"
          );
          const trend = await computePracticeAreaTrendData(draftAreas);
          seasonalPhases = {};
          for (const area of trend.practiceAreas) {
            const phase = area.data[trend.currentMonthIndex]?.phase;
            if (typeof phase === "string" && phase.length > 0) {
              seasonalPhases[area.practiceArea] = phase;
            }
          }
        } catch (phaseErr) {
          console.warn("[Reports] verdict draft phase context skipped:", phaseErr);
          seasonalPhases = null;
        }
      }

      const context = buildSlideVerdictContext({
        reportMonth: report.reportMonth,
        consultType: client?.consultType,
        practiceAreas: draftAreas,
        sections,
        reportId: report.id,
        clientId: report.clientId,
        hideOtherLeads: client?.hideOtherLeads === true,
        seasonalPhases,
      });
      const generated = await generateSlideVerdicts({
        context,
        slideKeys: [slideKey as SlideVerdictKey],
        openaiClient: openai,
      });
      const verdict = generated?.[slideKey as SlideVerdictKey];
      if (!verdict) {
        return res.status(502).json({
          error: "verdict_generation_failed",
          message:
            "The AI draft came back empty or below the quality floor. Try again, or write the verdict manually.",
        });
      }
      res.json({ verdict });
    } catch (error) {
      console.error("Error drafting slide verdict:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Task #4280 — ONE serve-time marketing sanitizer for BOTH public payload
  // builders (buildReportResponse below and its /api/demo-report parallel
  // twin): GBP locations project through an explicit field allowlist, and
  // internal operator-lifecycle keys are stripped so they never reach an
  // anonymous viewer — gbpUnresolvedImports (unmatched import location names
  // pending operator review; cleared on operator save) and the marketing slot
  // of the broken-source import warning (modeled on MarketingSectionRead;
  // written only for intake/sales today, stripped here in lock-step with them
  // as defense-in-depth).
  function sanitizePublicMarketingSectionData(
    sanitizedData: Record<string, unknown>,
    ctx: { sectionId?: string; reportId?: string; clientId?: string },
  ): void {
    // Typed view of the same copy (same reference, no clone): a stored
    // non-array gbpLocations still crashes .map exactly like before.
    const mktView = readMarketingSection(sanitizedData, ctx);
    const projectPublicGbpLocation = (loc: StoredGbpLocation): StoredGbpLocation => ({
      name: loc.name,
      uniqueLeads: loc.uniqueLeads,
      reviewsGenerated: loc.reviewsGenerated,
      reviewsRespondedTo: loc.reviewsRespondedTo,
      postsQaCount: loc.postsQaCount,
      leadQuality: loc.leadQuality,
      ...(loc.localDominance ? { localDominance: loc.localDominance } : {}),
      ...(loc.heatmapSnapshotIds ? { heatmapSnapshotIds: loc.heatmapSnapshotIds, heatmapSnapshotId: loc.heatmapSnapshotId } : {}),
      ...(loc.heatmapImageUrl ? { heatmapImageUrl: loc.heatmapImageUrl } : {}),
    });
    if (mktView.gbpLocations) {
      mktView.gbpLocations = mktView.gbpLocations.map(projectPublicGbpLocation);
    }
    if (mktView.gbp?.locations) {
      mktView.gbp.locations = mktView.gbp.locations.map(projectPublicGbpLocation);
    }
    delete sanitizedData.gbpUnresolvedImports;
    delete sanitizedData[BROKEN_SOURCE_WARNING_KEY];
  }

  // Task #4467/#4509 — ONE section-kind-agnostic strip of internal
  // bookkeeping keys for BOTH public payload builders (buildReportResponse
  // and the /api/demo-report twin), applied to EVERY served section. The
  // list + helper now live in server/services/reportPublicInternalKeys.ts
  // (imported at the top of this file) so the stamp-key guard test can load
  // them without booting the whole routes graph; new stamp keys are added
  // THERE, and tests/report-public-stamp-key-guard.test.ts fails when an
  // exported stamp-key constant under server/services is missing from it.

  // Task #4282 — closing-CTA account manager identity for the Next 30 Days
  // slide. The client's owner (clients.ownerId → users) IS the account
  // manager by existing convention (notification recipients already treat it
  // that way). Resolved at read time — no denormalized copy to rot. Returns
  // null when the client has no owner, the user row is gone, or the lookup
  // fails (the slide's CTA degrades to its generic line). Callers decide the
  // privacy gate; this helper only resolves identity.
  async function resolveAccountManager(
    client: { ownerId?: string | null } | null | undefined,
  ): Promise<{ name: string; email: string | null } | null> {
    try {
      const ownerId = client?.ownerId;
      if (!ownerId) return null;
      const owner = await storage.getUser(ownerId);
      if (!owner) return null;
      const name = [owner.firstName, owner.lastName]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .map((part) => part.trim())
        .join(" ");
      const email = typeof owner.email === "string" && owner.email.trim().length > 0 ? owner.email.trim() : null;
      if (!name && !email) return null;
      return { name: name || (email as string), email };
    } catch (err) {
      console.error("[Reports] account manager lookup failed (CTA degrades to generic):", err);
      return null;
    }
  }

  async function buildReportResponse(report: any, req: any) {
      
      const fullClient = await storage.getClient(report.clientId);
      const allStoredSections = await hydrateSectionEditors(
        normalizeSections(await storage.getReportSections(report.id)),
      );
      // Task #4240: the finalize-time AI trend commentary cache lives in
      // report_sections under an internal key. It is NOT a rendered report
      // section — strip it from the served list and surface it as
      // `seasonalTrends.aiAnalysis` below.
      const seasonalTrendsAiSection = allStoredSections.find(
        (s) => s.sectionKey === SEASONAL_TRENDS_AI_SECTION_KEY,
      );
      // Task #4273: the per-slide verdict map is the second internal row —
      // stripped here and surfaced as the `slideVerdicts` payload field.
      const slideVerdictsSection = allStoredSections.find(
        (s) => s.sectionKey === SLIDE_VERDICTS_SECTION_KEY,
      );
      const sections = allStoredSections.filter(
        (s) =>
          s.sectionKey !== SEASONAL_TRENDS_AI_SECTION_KEY &&
          s.sectionKey !== SLIDE_VERDICTS_SECTION_KEY,
      );
      // Task #2493: lazily heal manually-uploaded heatmap screenshots that
      // predate the explicit-public-ACL fix so their <img> renders in this
      // (often unauthenticated) public report. Scoped strictly to objects
      // already referenced as a location heatmap — never a blanket missing-ACL
      // flip. Best-effort; never blocks the response.
      try {
        const { ensureHeatmapImagesPublic } = await import(
          "../services/heatmapImageAcl"
        );
        await ensureHeatmapImagesPublic(
          new ObjectStorageService(),
          sections,
          report.createdBy ?? "heatmap-heal",
        );
      } catch (err) {
        console.warn("[reports] heatmap ACL heal (public) skipped:", err);
      }
      // Task #2703: lazily upgrade stale-shaped stored local dominance.
      // Reports finalized before the per-keyword fix (#2695) baked a
      // `localDominance` whose keyword snapshots carry only rank/SoV fields
      // and are missing the per-keyword `distributionBands` (plus per-keyword
      // sovHistory / competitors). Without those, switching the heatmap
      // keyword can't move the Ranking Distribution graph (or SoV history /
      // competitor leaderboard) — the frontend falls back to the single
      // primary set for every keyword. Recompute only those locations'
      // dominance from their heatmap snapshot ids via the existing bulk
      // service and swap the fresh object into the served section. Mirrors
      // the #2493 heatmap-ACL lazy-heal: best-effort, never blocks or fails
      // the response, and writes no stored data. Recently-saved reports
      // already carry per-keyword bands, so they trigger no DB work here.
      try {
        const marketingSection = sections.find(
          (s) => s.sectionKey === "marketing",
        );
        if (marketingSection && report.clientId) {
          const md = readMarketingSection(marketingSection.data, { sectionId: marketingSection.id, reportId: report.id, clientId: report.clientId });
          const locationGroups: StoredGbpLocation[][] = [];
          if (Array.isArray(md.gbp?.locations))
            locationGroups.push(md.gbp.locations);
          if (Array.isArray(md.gbpLocations))
            locationGroups.push(md.gbpLocations);

          const snapshotIdsFor = (loc: StoredGbpLocation): string[] =>
            (loc.heatmapSnapshotIds?.length ?? 0) > 0
              ? loc.heatmapSnapshotIds!
              : loc.heatmapSnapshotId
                ? [loc.heatmapSnapshotId]
                : [];

          const needsUpgrade = (loc: StoredGbpLocation): boolean => {
            const ld = loc.localDominance;
            if (
              !ld ||
              !Array.isArray(ld.keywordSnapshots) ||
              ld.keywordSnapshots.length === 0
            )
              return false;
            if (snapshotIdsFor(loc).length === 0) return false;
            // Stale shape: a keyword snapshot is missing the per-keyword
            // `distributionBands` key entirely (new ones always include it,
            // even when its value is null).
            // (kw: any) deliberately: a truthy non-object snapshot makes the
            // `in` check throw exactly like before this boundary was typed —
            // the outer catch downgrades that to the existing skip-warning.
            return ld.keywordSnapshots.some(
              (kw: any) => !(kw && "distributionBands" in kw),
            );
          };

          type StaleLoc = { loc: StoredGbpLocation; key: string; snapshotIds: string[] };
          const stale: StaleLoc[] = [];
          locationGroups.forEach((locs, gIdx) => {
            locs.forEach((loc, lIdx) => {
              if (!needsUpgrade(loc)) return;
              stale.push({
                loc,
                key: `g${gIdx}:l${lIdx}`,
                snapshotIds: snapshotIdsFor(loc),
              });
            });
          });

          if (stale.length > 0) {
            const { getLocalDominanceDataForReportBulk } = await import(
              "../services/localDominanceService"
            );
            const dominanceMap = await getLocalDominanceDataForReportBulk(
              report.clientId,
              stale.map((s) => ({
                locationId: s.key,
                snapshotIds: s.snapshotIds,
              })),
            );
            for (const { loc, key } of stale) {
              const fresh = dominanceMap.get(key);
              if (fresh) loc.localDominance = fresh;
            }
          }
        }
      } catch (err) {
        console.warn(
          "[reports] per-keyword dominance lazy upgrade skipped:",
          err,
        );
      }
      const commandPanel = await storage.getCommandPanel(report.clientId);
      const presentationMonth = getPresentationMonth(report.reportMonth);
      const ceoPulse = report.ceoPulseId 
        ? await storage.getCeoPulse(report.ceoPulseId)
        : await storage.getCeoPulseByMonth(presentationMonth);
      const dataAccess = await storage.getClientDataAccess(report.clientId);
      
      // Fetch historical trend data (up to 12 months prior)
      const allClientReports = await storage.getReportsByClient(report.clientId);
      // Sort by reportMonth ascending to ensure correct chronological order
      allClientReports.sort((a, b) => a.reportMonth.localeCompare(b.reportMonth));
      const currentMonthIndex = allClientReports.findIndex(r => r.id === report.id);
      // Get up to 12 prior months (before current), already in chronological order
      const startIndex = Math.max(0, currentMonthIndex - 12);
      const historicalReports = allClientReports.slice(startIndex, currentMonthIndex);
      
      // Extract trend metrics from historical reports.
      // Task #3688 — intake/sales entries come from the shared builders:
      // metric-months that weren't provided emit null (never a fake 0), and
      // IES/ESQ use the same shared computation as the client cards.
      const clientConsultType = fullClient?.consultType || 'free';

      const WEBINAR_LEAD_EQ = 1.6;
      const trendData: Array<{
        month: string;
        intake: IntakeTrendEntry;
        sales: SalesTrendEntry;
        marketing: { 
          totalLeads: number; 
          totalReviews: number; 
          // Stored counts may omit buckets on legacy rows (F5): the entries
          // pass through exactly what the section holds, so the annotation
          // mirrors the read type instead of over-claiming completeness.
          leadQuality: StoredLeadQualityCounts;
          gbpLeadQuality?: StoredLeadQualityCounts;
          googleAdsLeadQuality?: StoredLeadQualityCounts;
          lsaLeadQuality?: StoredLeadQualityCounts;
          leadsBySource?: { gbp: number; googleAds: number; lsa: number; webinar: number; webinarHT?: number };
        };
      }> = [];
      
      for (const histReport of historicalReports) {
        const histSections = normalizeSections(await storage.getReportSections(histReport.id));
        const intakeData = readIntakeSection(histSections.find(s => s.sectionKey === 'intake')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        const salesData = readSalesSection(histSections.find(s => s.sectionKey === 'sales')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        const marketingData = readMarketingSection(histSections.find(s => s.sectionKey === 'marketing')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        
        const gbpReviews = ((marketingData.gbp?.locations) || marketingData.gbpLocations || []).reduce(
          (sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0
        );
        const listReviews = marketingData.reviewGeneration?.list?.reviews || 0;
        const webinarReviews = marketingData.reviewGeneration?.webinar?.reviews || 0;
        const otherReviews = marketingData.reviewGeneration?.other?.count || 0;
        const totalReviews = marketingData.reviewGeneration?.totalReviews || (gbpReviews + listReviews + webinarReviews + otherReviews);
        
        // Task #3771: per-source GBP lead quality for the "% Good Leads by
        // Source" trend, via the canonical shared reader (rollup-first,
        // per-location sums as fallback) — the same counts the Leads Quality
        // Breakdown card and headline render for that month.
        const gbpLeadQuality = readGbpLeadQuality(marketingData).counts;
        
        trendData.push({
          month: histReport.reportMonth,
          intake: buildIntakeTrendEntry(intakeData, clientConsultType, sumMissedCallBucketInputs(marketingData, { hideOtherLeads: fullClient?.hideOtherLeads === true })),
          sales: buildSalesTrendEntry(salesData, clientConsultType),
          marketing: {
            totalLeads: marketingData.totalLeads || 0,
            totalReviews,
            leadQuality: marketingData.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            gbpLeadQuality,
            googleAdsLeadQuality: marketingData.googleAds?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            lsaLeadQuality: marketingData.lsa?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            leadsBySource: {
              gbp: ((marketingData.gbp?.locations) || marketingData.gbpLocations || []).reduce((sum: number, loc: any) => sum + (loc.uniqueLeads || 0), 0),
              googleAds: marketingData.googleAds?.uniqueLeads || 0,
              lsa: marketingData.lsa?.uniqueLeads || 0,
              webinar: Math.ceil((marketingData.webinar?.hotTransfers || 0) * WEBINAR_LEAD_EQ),
              webinarHT: marketingData.webinar?.hotTransfers || 0,
            },
          },
        });
      }
      
      // Add current month to trend data
      const currentIntake = readIntakeSection(sections.find(s => s.sectionKey === 'intake')?.data, { reportId: report.id, clientId: report.clientId });
      const currentSales = readSalesSection(sections.find(s => s.sectionKey === 'sales')?.data, { reportId: report.id, clientId: report.clientId });
      const currentMarketing = readMarketingSection(sections.find(s => s.sectionKey === 'marketing')?.data, { reportId: report.id, clientId: report.clientId });
      // Calculate current month reviews from all sources
      const currentGbpReviews = ((currentMarketing.gbp?.locations) || currentMarketing.gbpLocations || []).reduce(
        (sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0
      );
      const currentListReviews = currentMarketing.reviewGeneration?.list?.reviews || 0;
      const currentWebinarReviews = currentMarketing.reviewGeneration?.webinar?.reviews || 0;
      const currentOtherReviews = currentMarketing.reviewGeneration?.other?.count || 0;
      const currentTotalReviews = currentMarketing.reviewGeneration?.totalReviews || (currentGbpReviews + currentListReviews + currentWebinarReviews + currentOtherReviews);
      
      // Task #3771: current-month GBP lead quality through the same canonical
      // reader as the card/headline/trend. When the stored rollup and the
      // per-location buckets disagree (e.g. a manual aggregate edit after
      // ingest), every surface renders the rollup — log the divergence so
      // operators can spot and re-sync the stale shape.
      const currentGbpReading = readGbpLeadQuality(currentMarketing);
      if (currentGbpReading.divergent) {
        console.warn(
          `[LeadQuality] report ${report.id} (${report.reportMonth}): GBP rollup ${JSON.stringify(currentGbpReading.rollup)} ≠ per-location sum ${JSON.stringify(currentGbpReading.locationSum)} — all surfaces render the rollup`,
        );
      }
      const currentGbpLeadQuality = currentGbpReading.counts;
      
      trendData.push({
        month: report.reportMonth,
        intake: buildIntakeTrendEntry(currentIntake, clientConsultType, sumMissedCallBucketInputs(currentMarketing, { hideOtherLeads: fullClient?.hideOtherLeads === true })),
        sales: buildSalesTrendEntry(currentSales, clientConsultType),
        marketing: {
          totalLeads: currentMarketing.totalLeads || 0,
          totalReviews: currentTotalReviews,
          leadQuality: currentMarketing.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          gbpLeadQuality: currentGbpLeadQuality,
          googleAdsLeadQuality: currentMarketing.googleAds?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          lsaLeadQuality: currentMarketing.lsa?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          leadsBySource: {
            gbp: ((currentMarketing.gbp?.locations) || currentMarketing.gbpLocations || []).reduce((sum: number, loc: any) => sum + (loc.uniqueLeads || 0), 0),
            googleAds: currentMarketing.googleAds?.uniqueLeads || 0,
            lsa: currentMarketing.lsa?.uniqueLeads || 0,
            webinar: Math.ceil((currentMarketing.webinar?.hotTransfers || 0) * WEBINAR_LEAD_EQ),
            webinarHT: currentMarketing.webinar?.hotTransfers || 0,
          },
        },
      });
      
      // Only return safe, non-PII client fields for public share
      // Privacy mode can be enabled via query parameter (?private=true) or database field
      const isPrivacyMode = req.query.private === 'true' || report.privacyMode === true;
      // Task #1028: canonical Active-Products resolver for the public read.
      const publicResolution = await getActiveProductsForClient(report.clientId);
      logResolution("public_read", { ...publicResolution, reportId: report.id });
      const effectiveProducts = publicResolution.products;
      const safeClient = {
        firmName: isPrivacyMode ? "Confidential Client" : (fullClient?.firmName || "Unknown Firm"),
        contactName: isPrivacyMode ? null : (fullClient?.contactName || null),
        products: effectiveProducts,
        practiceAreas: fullClient?.practiceAreas || [],
        consultType: fullClient?.consultType || "free",
        terminology: fullClient?.terminology || null,
        // Task #2596 — per-client monthly review target so the Review
        // Generation velocity band can fall back to it when a report has no
        // per-report target. Not PII; safe to expose even in privacy mode.
        monthlyReviewTarget: fullClient?.monthlyReviewTarget ?? null,
        // Task #2667 — per-client toggle to suppress the "Other" lead bucket
        // from every figure/chart on the rendered report. Client-level (unlike
        // the report-level hideLeadQuality), so it applies to all of this
        // client's reports. Not PII.
        hideOtherLeads: fullClient?.hideOtherLeads === true,
      };
      
      // Sanitize sections for public consumption
      const sanitizedSections = sections.map(section => {
        const sanitizedData: Record<string, unknown> = { ...readSectionDataObject(section.data, { sectionId: section.id, reportId: report.id, clientId: report.clientId }) };

        // Task #1028: Defense-in-depth Active-Products gate on the rendered
        // surface. Even if a stale row pre-dates the write-side gates, the
        // public report can never display a platform block for an inactive
        // product.
        if (section.sectionKey === "marketing") {
          applyActiveProductsFilter(sanitizedData, effectiveProducts, {
            source: "public_read_sanitizer",
            clientId: report.clientId,
            reportId: report.id,
          });
        }
        
        // Keep all nextActions for public display - both agency and client actions
        if (section.sectionKey === "nextActions") {
          // Only remove internal notes, keep ours and theirs for display
          delete sanitizedData.internalNotes;
          // Task #4282 — privacy mode strips people-identity from the deck
          // (firm name, contact, rep names); the new per-action owner
          // initials are identity too, so they come off both columns here.
          // Due hints stay — they carry no identity.
          if (isPrivacyMode) {
            const stripOwners = (list: unknown): unknown =>
              Array.isArray(list)
                ? list.map((item: any) => {
                    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
                    const { owner: _owner, ...rest } = item;
                    return rest;
                  })
                : list;
            sanitizedData.ours = stripOwners(sanitizedData.ours);
            sanitizedData.theirs = stripOwners(sanitizedData.theirs);
          }
        }

        // Task #3769 — serve-time suppression: a stored Common Issues value
        // that is placeholder-only (literal "Missing data source …" incl.
        // "Name_Clean (N): <client>" tails, blank/artifact bodies, or the
        // AI-rewritten placeholder finding) must never reach a shared/preview
        // payload, regardless of rows poisoned before the import-time fix.
        // The renderer then shows its normal "No issues identified" state.
        // The broken-source import warning is an internal operator signal —
        // strip it too.
        if (section.sectionKey === "intake" || section.sectionKey === "sales") {
          if (isPlaceholderOnlyCommonIssues(sanitizedData.commonIssues)) {
            sanitizedData.commonIssues = "";
          } else if (typeof sanitizedData.commonIssues === "string") {
            // Task #3770 — serve-time safety net: rows poisoned before the
            // repair action runs may store the canonical 🔴/↳/➡️ markers on a
            // single line (markdown then shows literal "---"/">" walls of
            // text). Re-insert line structure so live share links render
            // correctly; no-op for well-formed or marker-less values.
            sanitizedData.commonIssues = normalizeCommonIssuesStructure(
              sanitizedData.commonIssues,
            );
          }
          delete sanitizedData[BROKEN_SOURCE_WARNING_KEY];
        }

        if (section.sectionKey === "marketing") {
          sanitizePublicMarketingSectionData(sanitizedData, { sectionId: section.id, reportId: report.id, clientId: report.clientId });
        }
        
        // Remove employee names from sales rep performance, keep only anonymous stats
        if (section.sectionKey === "sales") {
          const salesView = readSalesSection(sanitizedData, { sectionId: section.id, reportId: report.id, clientId: report.clientId });
          if (salesView.signedByRep) {
            const repValues = Object.values(salesView.signedByRep);
            sanitizedData.totalSignedCases = repValues.reduce((sum: number, val: number) => sum + val, 0);
            delete sanitizedData.signedByRep;
          }
        }

        // Task #4467 — internal backfill/convergence stamps come off EVERY
        // section (kind-agnostic), after the section-specific sanitizers.
        stripInternalSectionBookkeepingKeys(sanitizedData);

        return {
          sectionKey: section.sectionKey,
          data: sanitizedData,
        };
      });
      
      // Sanitize data access - only return category and status
      const sanitizedDataAccess = dataAccess.map(item => ({
        category: item.category,
        status: item.status,
      }));
      
      // Calculate lifetime value - sum from all reports plus client baseline
      // Webinar Lead Equivalency: Each booked consultation from webinar = 1.6 Lead Equivalents
      const WEBINAR_LEAD_EQUIVALENCY = 1.6;
      
      let cumulativeLeads = fullClient?.initialLeads || 0;
      let cumulativeReviews = fullClient?.initialReviews || 0;
      // Task #3687 — shared accumulator: the initialCases baseline counts as
      // HARD data only when genuinely provided (> 0), because the client edit
      // forms coerce an absent baseline to 0 on save.
      const lifetimeCases = createLifetimeCaseAccumulator(fullClient?.initialCases);
      
      // Sum up values from ALL reports for this client (not just historical)
      for (const r of allClientReports) {
        const rSections = r.id === report.id ? sections : normalizeSections(await storage.getReportSections(r.id));
        const mktData = readMarketingSection(rSections.find(s => s.sectionKey === 'marketing')?.data, { reportId: r.id, clientId: r.clientId });
        const salesData = readSalesSection(rSections.find(s => s.sectionKey === 'sales')?.data, { reportId: r.id, clientId: r.clientId });
        
        // Sum leads from all sources (GBP + ads + LSA + webinar at 3x)
        const gbpLeads = (mktData.gbp?.locations || mktData.gbpLocations || []).reduce(
          (sum: number, loc) => sum + (loc.uniqueLeads || 0), 0
        );
        const adsLeads = mktData.googleAds?.uniqueLeads || 0;
        const lsaLeads = mktData.lsa?.uniqueLeads || 0;
        const webinarLeadEquivalents = Math.ceil((mktData.webinar?.hotTransfers || 0) * WEBINAR_LEAD_EQUIVALENCY);
        cumulativeLeads += gbpLeads + adsLeads + lsaLeads + webinarLeadEquivalents;
        
        // Sum reviews — reviewGeneration sources (list/webinar/other) and GBP reviewsGenerated
        // overlap (the list campaign generates reviews that land on GBP), so use the GREATER
        // of the two to avoid double-counting while still capturing all reviews.
        const gbpReviews = (mktData.gbp?.locations || mktData.gbpLocations || []).reduce(
          (sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0
        );
        const listReviews = mktData.reviewGeneration?.list?.reviews || mktData.reviewGeneration?.list?.count || 0;
        const webinarReviews = mktData.reviewGeneration?.webinar?.reviews || mktData.reviewGeneration?.webinar?.count || 0;
        const otherReviews = mktData.reviewGeneration?.other?.count || 0;
        const channelReviews = listReviews + webinarReviews + otherReviews;
        cumulativeReviews += Math.max(gbpReviews, channelReviews);
        
        // Cases signed — only an unflagged POSITIVE totalCases is genuinely
        // provided: forms and the AI-parse path coerce absent case counts to
        // 0, so an unflagged 0 must never read as a confirmed figure (Task
        // #4849; flagged No-Data months already never counted, Task #3687).
        // The report month feeds the per-month coverage provenance.
        addReportCasesToLifetime(lifetimeCases, salesData, r.reportMonth);
      }
      
      // If no hard case data anywhere, estimate based on industry avg conversion rate (30%)
      const estimatedCases = !lifetimeCases.hasHardData && cumulativeLeads > 0 
        ? Math.round(cumulativeLeads * 0.3)
        : undefined;
      
      const lifetimeValue = {
        totalLeads: cumulativeLeads,
        totalReviews: cumulativeReviews,
        totalCases: lifetimeCases.totalCases,
        estimatedCases,
        hasHardData: lifetimeCases.hasHardData,
        // Task #4849 — additive per-month case-data provenance from the
        // shared accumulator: the deck's payoff card renders its honest
        // "Incomplete data — missing <months>" annotation from missingMonths
        // (calendar-complete over the accumulation span, so report-less
        // months count as missing too).
        casesCoverage: getLifetimeCaseCoverage(lifetimeCases),
      };

      // Task #4620 — serve-time twin of the Lifetime Value slide's Task #4592
      // gate: when the trend window's per-source lead sum exceeds the
      // lifetime headline, the slide hides its compounding-arc chart with
      // only a browser console.warn. Flag the same condition here, for the
      // exact payload about to be served, so operators see the data
      // inconsistency (bad backfill / edited month / formula drift).
      // Fire-and-forget, deduped per report; never affects the response.
      checkLifetimeLeadMismatch({
        reportId: report.id,
        clientId: report.clientId,
        reportMonth: report.reportMonth,
        totalLeads: lifetimeValue.totalLeads,
        // Mirror the served trendData gate below (length > 1 or the client
        // receives null and the slide never attempts the arc).
        monthlyLeadsBySource:
          trendData.length > 1 ? trendData.map((m) => m.marketing?.leadsBySource) : [],
      });
      
      const payload = {
        report: {
          id: report.id,
          reportMonth: report.reportMonth,
          status: report.status,
          privacyMode: report.privacyMode || false,
          // Task #4290 — EFFECTIVE privacy flag (DB column OR ?private=true).
          // The client keys every privacy fallback off this so a ?private
          // view masks identically to a stored privacy-mode report.
          privacyApplied: isPrivacyMode,
          hideLeadQuality: report.hideLeadQuality || false,
          // Task #4537 — deliberately NO presentedAt/presentedBy here: the
          // "Presented / Delivered" mark is internal operator state and must
          // never reach the anonymous share/demo payloads.
        },
        client: {
          ...safeClient,
          initialLeads: fullClient?.initialLeads || 0,
          initialReviews: fullClient?.initialReviews || 0,
          initialCases: fullClient?.initialCases || 0,
          clientStartDate: fullClient?.clientStartDate || null,
        },
        // Task #4282 — Next 30 Days closing CTA: the account manager's name +
        // mailto target, resolved read-time from clients.ownerId. DELIBERATE
        // public exposure on the share/preview payloads (the CTA is the
        // feature) — but privacy mode serves null, same rule that hides
        // firmName/contactName above. The slide degrades to its generic
        // closing line whenever this is null.
        accountManager: isPrivacyMode ? null : await resolveAccountManager(fullClient),
        sections: sanitizedSections,
        ceoPulse: ceoPulse ? await (async () => {
          let resolvedHtml = ceoPulse.fullLetterHtml;
          const graphsEnabled = ceoPulse.includeGraphs !== false;
          const chartCount = graphsEnabled ? (readCeoPulseAiAnalysis(ceoPulse.aiAnalysis, { ceoPulseId: ceoPulse.id })?.charts?.length || 0) : 0;
          if (resolvedHtml && ceoPulse.isPublished && graphsEnabled && chartCount > 0) {
            const availableIndices = await checkAvailableChartImages(ceoPulse.monthKey, chartCount);
            resolvedHtml = resolveChartPlaceholders(resolvedHtml, ceoPulse.monthKey, availableIndices);
          } else if (resolvedHtml) {
            resolvedHtml = resolveChartPlaceholders(resolvedHtml, ceoPulse.monthKey, new Set(), { stripMissing: true });
          }
          if (resolvedHtml) {
            // Task #4293 — {{image-N}} resolves only for published briefs
            // (drafts strip, mirroring charts): the resolver always strips
            // slots missing from the list it is given.
            resolvedHtml = resolveImagePlaceholders(
              resolvedHtml,
              ceoPulse.monthKey,
              ceoPulse.isPublished
                ? readCeoPulseSupportingImages(ceoPulse.supportingImages, { ceoPulseId: ceoPulse.id })
                : [],
            );
          }
          return { ...ceoPulse, fullLetterHtml: resolvedHtml };
        })() : ceoPulse,
        // Task #4216 — CEO Pulse "Product updates": live product-roadmap
        // block, assembled fresh on every fetch like the rest of this payload
        // (published reports tick between views with zero regeneration).
        // Built only when the report resolves a CEO Pulse — the block renders
        // inside that slide, and pulse-less reports stay unchanged (null).
        // Best-effort: a roadmap read failure must not 500 a client-facing
        // share/preview, so it logs loudly and the slide omits the block.
        productUpdates: ceoPulse
          ? await buildReportProductUpdates().catch((err) => {
              console.error(
                "[Reports] product updates block failed (report still served):",
                err,
              );
              return null;
            })
          : null,
        dataAccess: sanitizedDataAccess,
        trendData: trendData.length > 1 ? trendData : null,
        lifetimeValue,
        // Task #4273 — per-slide verdict sentences: STORED copy only
        // (finalize-time generation or operator authoring in the report
        // editor). Like seasonalTrends.aiAnalysis below, this path never
        // computes — an absent/garbled row serves null and slides simply
        // render without a verdict line.
        slideVerdicts: readStoredSlideVerdicts(slideVerdictsSection?.data),
        // Task #4210: embed the deterministic seasonal-trend payload so the
        // capability-token public share route (and demo/preview views) serve
        // REAL per-practice-area data to anonymous viewers. Previously they
        // 401'd on POST /api/trends/practice-areas (isAuthenticated) and the
        // client silently rendered hardcoded fallback numbers.
        // Task #4240: aiAnalysis is served ONLY from the copy generated and
        // stored at finalize time (seasonalTrendsAi section) — this path
        // must NEVER compute it, so an unauthenticated view can never
        // trigger an OpenAI call. Reports finalized before the cache existed
        // (or whose generation failed) serve null and the client renders its
        // deterministic derived analysis text as before. Best-effort:
        // failure degrades to null and the client falls back as before.
        seasonalTrends: await (async () => {
          try {
            const areas: string[] = Array.isArray(fullClient?.practiceAreas)
              ? fullClient.practiceAreas
              : [];
            if (areas.length === 0) return null;
            const { computePracticeAreaTrendData } = await import(
              "../services/practiceAreaTrendData"
            );
            const trend = await computePracticeAreaTrendData(areas);
            return {
              ...trend,
              aiAnalysis: readStoredSeasonalTrendAiAnalysis(
                seasonalTrendsAiSection?.data,
              ),
              source: "Google Trends - 5-Year Average Seasonal Patterns",
            };
          } catch (err) {
            console.warn("[reports] seasonal trend embed skipped:", err);
            return null;
          }
        })(),
      };

      // Task #4290 — privacy mode masks LOCATION identity, not just firm
      // identity: GBP location names → "Market A/B…", keyword phrases →
      // "Keyword A…", competitor names → "Competitor A…", plus a free-text
      // scrub of every payload string for those identifiers. Runs LAST so it
      // sees the exact served shape (post active-products filter, marketing
      // allowlist, localDominance rehydration, seasonalTrends embed). The
      // demo route builds its own curated payload and is untouched.
      if (isPrivacyMode) {
        maskReportPayloadForPrivacy(payload as unknown as Record<string, unknown>, {
          firmName: fullClient?.firmName ?? null,
          contactName: fullClient?.contactName ?? null,
        });
      }

      return payload;
  }

  // Public share link - no auth required, only for finalized reports
  app.get("/api/share/:token", async (req, res) => {
    try {
      const report = await storage.getReportByShareToken(req.params.token);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      if (report.status !== "final") {
        return res.status(403).json({ error: "This report is not yet finalized. Please mark it as Final before sharing." });
      }
      // Task #1796: do NOT mark client active here. This is the
      // unauthenticated public-share route — an anonymous browser
      // hitting a shared link must not refresh the demand-driven
      // SEMrush gate, otherwise a single forwarded URL keeps the
      // client permanently "active" with no operator engagement.
      // Authenticated operator views (`/api/reports/:id`, the
      // authenticated `/api/preview/:reportId`, the client dashboard,
      // and the Command Center) are the only entry points that bump
      // `clients.last_viewed_at`.
      const data = await buildReportResponse(report, req);
      res.json(data);
    } catch (error) {
      console.error("Error fetching shared report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Authenticated preview - requires login, works for any status (draft or final)
  app.get("/api/preview/:reportId", isAuthenticated, async (req: any, res) => {
    try {
      const report = await storage.getReport(req.params.reportId);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      // Task #1785 review-remediation: authenticated preview render
      // also counts as client activity.
      if (report.clientId) {
        try {
          const { markClientViewed } = await import(
            "../services/semrushCadenceGate"
          );
          void markClientViewed(report.clientId, "report:preview");
        } catch {}
      }
      const data = await buildReportResponse(report, req);
      res.json({ ...data, isPreview: true });
    } catch (error) {
      console.error("Error fetching report preview:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Get/Set demo report ID — CEO only (Task #4667: the CEO check was
  // previously hand-rolled inside each handler and invisible to the route
  // inventory; both routes now use the shared requireCeo middleware,
  // mirroring Task #4644).
  app.get("/api/admin/demo-report-setting", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const setting = await storage.getSystemSetting("demoReportId");
      res.json({ demoReportId: setting?.value || null });
    } catch (error) {
      console.error("Error fetching demo report setting:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Task #4667 — CEO only via requireCeo (was a hand-rolled ceo/'admin'
  // check; the legacy "admin" role shortcut is deliberately dropped —
  // unknown roles rank 0 on the ROLE_LEVELS ladder).
  app.post("/api/admin/demo-report-setting", isAuthenticated, requireCeo, async (req, res) => {
    try {
      // requireCeo attached the verified DB user row.
      const user = (req as any).dbUser;
      
      const { reportId } = req.body;
      if (!reportId) {
        return res.status(400).json({ error: "reportId is required" });
      }
      
      // Verify report exists
      const report = await storage.getReport(reportId);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      
      await storage.setSystemSetting("demoReportId", reportId, user.id);
      res.json({ success: true, demoReportId: reportId });
    } catch (error) {
      console.error("Error setting demo report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  // Task #4227 — curated Next 30 Days actions for the public demo report.
  // Used as a serve-time fill whenever the stored demo report's nextActions
  // columns are empty, so prospects never see "No actions defined" on the
  // climax slide. Realistic-but-generic: no firm names, no fabricated
  // metrics.
  const DEMO_NEXT_ACTIONS = {
    ours: [
      {
        action: "Launch review-generation campaign across all office locations",
        why: "Review velocity is the #1 lever for local map-pack rankings right now",
      },
      {
        action: "Refresh Google Business Profile posts and photos weekly",
        why: "Active profiles convert 2–3x more searchers into calls",
      },
      {
        action: "Rebalance ad spend toward the highest-converting practice area",
        why: "Concentrating budget where cost-per-case is lowest compounds results",
      },
    ],
    theirs: [
      {
        action: "Answer every inbound call within 3 rings during business hours",
        why: "Speed-to-answer is the single biggest driver of lead-to-consult rate",
      },
      {
        action: "Send us this month's signed-case list by the 5th",
        why: "Accurate case data keeps your ROI reporting honest and actionable",
      },
      {
        action: "Ask 5 recently closed clients for a Google review",
        why: "Fresh reviews from real clients outperform any ad we can run",
      },
    ],
  } as const;

  // Demo report - public, no auth required (uses specifically chosen report or fallback to most recent demo client report)
  // Task #4459 — demo-payload tenure start date. Prefers the stored
  // clientStartDate only when it plausibly belongs to the demo dataset
  // (within ~5 years before the earliest demo report month); placeholder or
  // missing values fall back to the earliest demo report month so the
  // Lifetime Value slide's tenure subtitle always renders on /demo-report.
  function resolveDemoClientStartDate(
    stored: Date | string | null | undefined,
    reportsAsc: Array<{ reportMonth: string }>,
  ): string | Date | null {
    const earliestMonth = reportsAsc.length > 0 ? reportsAsc[0].reportMonth : null;
    const derived = earliestMonth ? `${earliestMonth}-01` : null;
    if (!stored) return derived;
    if (!earliestMonth) return stored;
    const storedTime = new Date(stored).getTime();
    if (!Number.isFinite(storedTime)) return derived;
    const plausibilityFloor = new Date(`${earliestMonth}-01T00:00:00Z`).getTime() - 5 * 365 * 24 * 60 * 60 * 1000;
    return storedTime >= plausibilityFloor ? stored : derived;
  }

  app.get("/api/demo-report", async (_req, res) => {
    try {
      // First, check if a specific demo report is configured
      const demoSetting = await storage.getSystemSetting("demoReportId");
      let report;
      let demoClient;
      
      if (demoSetting?.value) {
        report = await storage.getReport(demoSetting.value);
        if (report) {
          demoClient = await storage.getClient(report.clientId);
        }
      }
      
      // Fallback to old behavior if no specific report set
      if (!report) {
        const allClients = await storage.getClients();
        demoClient = allClients.find((c: any) => c.isDemo === true);
        
        if (!demoClient) {
          return res.status(404).json({ error: "No demo client configured" });
        }
        
        const demoReports = await storage.getReportsByClient(demoClient.id);
        if (!demoReports || demoReports.length === 0) {
          return res.status(404).json({ error: "No demo reports available" });
        }
        
        demoReports.sort((a, b) => b.reportMonth.localeCompare(a.reportMonth));
        report = demoReports[0];
      }
      
      if (!report || !demoClient) {
        return res.status(404).json({ error: "No demo report available" });
      }
      
      const sections = normalizeSections(await storage.getReportSections(report.id));
      const demoCommandPanel = await storage.getCommandPanel(report.clientId);
      const presentationMonth = getPresentationMonth(report.reportMonth);
      const ceoPulse = report.ceoPulseId 
        ? await storage.getCeoPulse(report.ceoPulseId)
        : await storage.getCeoPulseByMonth(presentationMonth);
      const dataAccess = await storage.getClientDataAccess(report.clientId);
      
      const clientReports = await storage.getReportsByClient(demoClient.id);
      const allClientReports = [...clientReports];
      allClientReports.sort((a, b) => a.reportMonth.localeCompare(b.reportMonth));
      const currentMonthIndex = allClientReports.findIndex(r => r.id === report.id);
      const startIndex = Math.max(0, currentMonthIndex - 12);
      const historicalReports = allClientReports.slice(startIndex, currentMonthIndex);
      
      // Build trend data (simplified version). Task #3688 — same shared
      // builders as the main response: null for not-provided metric-months,
      // shared IES/ESQ computation, so demo and real reports behave alike.
      const demoConsultType = demoClient.consultType || 'free';

      const DEMO_WEBINAR_LEAD_EQ = 1.6;
      const trendData: Array<{
        month: string;
        intake: IntakeTrendEntry;
        sales: SalesTrendEntry;
        marketing: { totalLeads: number; totalReviews: number; leadQuality: StoredLeadQualityCounts; leadsBySource?: { gbp: number; googleAds: number; lsa: number; webinar: number; webinarHT?: number } };
      }> = [];
      
      for (const histReport of historicalReports) {
        const histSections = normalizeSections(await storage.getReportSections(histReport.id));
        const intakeData = readIntakeSection(histSections.find(s => s.sectionKey === 'intake')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        const salesData = readSalesSection(histSections.find(s => s.sectionKey === 'sales')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        const marketingData = readMarketingSection(histSections.find(s => s.sectionKey === 'marketing')?.data, { reportId: histReport.id, clientId: histReport.clientId });
        
        const gbpReviews = ((marketingData.gbp?.locations) || marketingData.gbpLocations || []).reduce(
          (sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0
        );
        const listReviews = marketingData.reviewGeneration?.list?.reviews || 0;
        const webinarReviews = marketingData.reviewGeneration?.webinar?.reviews || 0;
        const otherReviews = marketingData.reviewGeneration?.other?.count || 0;
        
        trendData.push({
          month: histReport.reportMonth,
          intake: buildIntakeTrendEntry(intakeData, demoConsultType, sumMissedCallBucketInputs(marketingData, { hideOtherLeads: demoClient?.hideOtherLeads === true })),
          sales: buildSalesTrendEntry(salesData, demoConsultType),
          marketing: {
            totalLeads: marketingData.totalLeads || 0,
            totalReviews: marketingData.reviewGeneration?.totalReviews || (gbpReviews + listReviews + webinarReviews + otherReviews),
            leadQuality: marketingData.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            leadsBySource: {
              gbp: ((marketingData.gbp?.locations) || marketingData.gbpLocations || []).reduce((sum: number, loc) => sum + (loc.uniqueLeads || 0), 0),
              googleAds: marketingData.googleAds?.uniqueLeads || 0,
              lsa: marketingData.lsa?.uniqueLeads || 0,
              webinar: Math.ceil((marketingData.webinar?.hotTransfers || 0) * DEMO_WEBINAR_LEAD_EQ),
              webinarHT: marketingData.webinar?.hotTransfers || 0,
            },
          },
        });
      }
      
      // Add current month
      const currentIntake = readIntakeSection(sections.find(s => s.sectionKey === 'intake')?.data, { reportId: report.id, clientId: report.clientId });
      const currentSales = readSalesSection(sections.find(s => s.sectionKey === 'sales')?.data, { reportId: report.id, clientId: report.clientId });
      const currentMarketing = readMarketingSection(sections.find(s => s.sectionKey === 'marketing')?.data, { reportId: report.id, clientId: report.clientId });
      const currentGbpReviews = ((currentMarketing.gbp?.locations) || currentMarketing.gbpLocations || []).reduce(
        (sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0
      );
      
      trendData.push({
        month: report.reportMonth,
        intake: buildIntakeTrendEntry(currentIntake, demoConsultType, sumMissedCallBucketInputs(currentMarketing, { hideOtherLeads: demoClient?.hideOtherLeads === true })),
        sales: buildSalesTrendEntry(currentSales, demoConsultType),
        marketing: {
          totalLeads: currentMarketing.totalLeads || 0,
          totalReviews: currentMarketing.reviewGeneration?.totalReviews || (currentGbpReviews + (currentMarketing.reviewGeneration?.list?.reviews || 0) + (currentMarketing.reviewGeneration?.webinar?.reviews || 0) + (currentMarketing.reviewGeneration?.other?.count || 0)),
          leadQuality: currentMarketing.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          leadsBySource: {
            gbp: ((currentMarketing.gbp?.locations) || currentMarketing.gbpLocations || []).reduce((sum: number, loc) => sum + (loc.uniqueLeads || 0), 0),
            googleAds: currentMarketing.googleAds?.uniqueLeads || 0,
            lsa: currentMarketing.lsa?.uniqueLeads || 0,
            webinar: Math.ceil((currentMarketing.webinar?.hotTransfers || 0) * DEMO_WEBINAR_LEAD_EQ),
            webinarHT: currentMarketing.webinar?.hotTransfers || 0,
          },
        },
      });
      
      const demoEffectiveProducts = resolveEffectiveProducts(demoCommandPanel, demoClient.products);
      const safeClient = {
        firmName: demoClient.firmName || "Demo Firm",
        contactName: demoClient.contactName || null,
        products: demoEffectiveProducts,
        practiceAreas: demoClient.practiceAreas || [],
        consultType: demoClient.consultType || "free",
        initialLeads: demoClient.initialLeads || 0,
        initialReviews: demoClient.initialReviews || 0,
        initialCases: demoClient.initialCases || 0,
        // Task #2596 — per-client monthly review target fallback.
        monthlyReviewTarget: demoClient.monthlyReviewTarget ?? null,
        // Task #4459 — the Lifetime Value slide leads with a tenure subtitle
        // computed from clientStartDate. The demo client has none in prod, so
        // the demo (the sales artifact) fell back to the generic line. Use a
        // stored value when it's plausible for the demo dataset; otherwise
        // derive the start from the earliest demo report month so the tenure
        // hook renders at full strength. (The dev clone carries a 2000-05-01
        // placeholder on the demo client — decades before any demo report —
        // which would render an absurd tenure, hence the plausibility guard.)
        // Real-client payloads are untouched.
        clientStartDate: resolveDemoClientStartDate(demoClient.clientStartDate, allClientReports),
      };
      
      // Sanitize sections
      // Task #4273 — the demo builder is a PARALLEL twin of
      // buildReportResponse, so it strips the internal AI-cache rows
      // (seasonalTrendsAi, slideVerdicts) itself. Before this, the demo
      // route leaked the raw seasonalTrendsAi row to anonymous viewers.
      const demoInternalSectionKeys = new Set<string>([
        SEASONAL_TRENDS_AI_SECTION_KEY,
        SLIDE_VERDICTS_SECTION_KEY,
      ]);
      const sanitizedSections = sections.filter(
        (section) => !demoInternalSectionKeys.has(section.sectionKey),
      ).map(section => {
        const sanitizedData: Record<string, unknown> = { ...readSectionDataObject(section.data, { sectionId: section.id, reportId: report.id, clientId: report.clientId }) };
        if (section.sectionKey === "nextActions") {
          delete sanitizedData.internalNotes;
          // Task #4227 — the demo report is the version PROSPECTS see, and
          // its Next 30 Days slide (the report's climax) rendered "No
          // actions defined" in both columns. Serve-time fill: any empty
          // column ships with realistic curated demo actions instead, no
          // matter what the underlying demo report row holds.
          const hasRealActions = (list: unknown): boolean =>
            Array.isArray(list) &&
            list.some((a: any) => typeof a?.action === "string" && a.action.trim().length > 0);
          if (!hasRealActions(sanitizedData.ours)) {
            sanitizedData.ours = DEMO_NEXT_ACTIONS.ours;
          }
          if (!hasRealActions(sanitizedData.theirs)) {
            sanitizedData.theirs = DEMO_NEXT_ACTIONS.theirs;
          }
        }
        // Task #3769 — same serve-time suppression as buildReportResponse:
        // the demo report serves a REAL report's sections publicly.
        if (section.sectionKey === "intake" || section.sectionKey === "sales") {
          if (isPlaceholderOnlyCommonIssues(sanitizedData.commonIssues)) {
            sanitizedData.commonIssues = "";
          } else if (typeof sanitizedData.commonIssues === "string") {
            // Task #3770 — same serve-time structure normalization as
            // buildReportResponse (single-line marker walls of text).
            sanitizedData.commonIssues = normalizeCommonIssuesStructure(
              sanitizedData.commonIssues,
            );
          }
          delete sanitizedData[BROKEN_SOURCE_WARNING_KEY];
        }
        // Task #4280 — same marketing sanitize as buildReportResponse: GBP
        // location field allowlist + internal operator-key strip
        // (gbpUnresolvedImports, broken-source warning slot).
        if (section.sectionKey === "marketing") {
          sanitizePublicMarketingSectionData(sanitizedData, { sectionId: section.id, reportId: report.id, clientId: report.clientId });
        }
        // Task #4467 — same section-kind-agnostic internal-stamp strip as
        // buildReportResponse (shared helper; the twins must not drift).
        stripInternalSectionBookkeepingKeys(sanitizedData);
        return {
          sectionKey: section.sectionKey,
          data: sanitizedData,
        };
      });
      
      // Calculate lifetime value
      const WEBINAR_LEAD_EQUIVALENCY = 1.6;
      let cumulativeLeads = demoClient.initialLeads || 0;
      let cumulativeReviews = demoClient.initialReviews || 0;
      // Task #3687 — same shared accumulator as the public/preview builder so
      // the demo report's lifetime card behaves identically.
      const lifetimeCases = createLifetimeCaseAccumulator(demoClient.initialCases);
      
      for (const r of allClientReports) {
        const rSections = r.id === report.id ? sections : normalizeSections(await storage.getReportSections(r.id));
        const mktData = readMarketingSection(rSections.find(s => s.sectionKey === 'marketing')?.data, { reportId: r.id, clientId: r.clientId });
        const salesData = readSalesSection(rSections.find(s => s.sectionKey === 'sales')?.data, { reportId: r.id, clientId: r.clientId });
        
        const gbpLocs = mktData.gbp?.locations || mktData.gbpLocations || [];
        const gbpLeads = gbpLocs.reduce((sum: number, loc) => sum + (loc.uniqueLeads || 0), 0);
        const webinarLeadEquivalents = Math.ceil((mktData.webinar?.hotTransfers || 0) * WEBINAR_LEAD_EQUIVALENCY);
        cumulativeLeads += gbpLeads + (mktData.googleAds?.uniqueLeads || 0) + (mktData.lsa?.uniqueLeads || 0) + webinarLeadEquivalents;
        
        const gbpRevs = gbpLocs.reduce((sum: number, loc) => sum + (loc.reviewsGenerated || 0), 0);
        const channelRevs = (mktData.reviewGeneration?.list?.reviews || 0) + (mktData.reviewGeneration?.webinar?.reviews || 0) + (mktData.reviewGeneration?.other?.count || 0);
        cumulativeReviews += mktData.reviewGeneration?.totalReviews || Math.max(gbpRevs, channelRevs);
        
        // Tasks #3687/#4849 — No-Data-flagged months AND unflagged zeros must
        // not count as hard data (only unflagged positives are genuine); the
        // report month feeds the per-month coverage provenance.
        addReportCasesToLifetime(lifetimeCases, salesData, r.reportMonth);
      }
      
      const lifetimeValue = {
        totalLeads: cumulativeLeads,
        totalReviews: cumulativeReviews,
        totalCases: lifetimeCases.totalCases,
        estimatedCases: !lifetimeCases.hasHardData && cumulativeLeads > 0 ? Math.round(cumulativeLeads * 0.3) : undefined,
        hasHardData: lifetimeCases.hasHardData,
        // Task #4849 — same additive coverage fields as the public/preview
        // builder (one shared accumulator, identical provenance).
        casesCoverage: getLifetimeCaseCoverage(lifetimeCases),
      };
      
      res.json({
        report: {
          id: report.id,
          reportMonth: report.reportMonth,
          status: report.status,
          hideLeadQuality: report.hideLeadQuality || false,
        },
        client: safeClient,
        // Task #4282 — same closing-CTA identity as buildReportResponse
        // (shared resolver). The demo report is the prospect-facing deck; its
        // demo client's owner is our own team member, so the CTA renders the
        // real "talk to a human" mechanism. Null (no owner) degrades the
        // slide to its generic closing line.
        accountManager: await resolveAccountManager(demoClient),
        sections: sanitizedSections,
        ceoPulse: ceoPulse ? await (async () => {
          let resolvedHtml = ceoPulse.fullLetterHtml;
          const graphsEnabled = ceoPulse.includeGraphs !== false;
          const chartCount = graphsEnabled ? (readCeoPulseAiAnalysis(ceoPulse.aiAnalysis, { ceoPulseId: ceoPulse.id })?.charts?.length || 0) : 0;
          if (resolvedHtml && ceoPulse.isPublished && graphsEnabled && chartCount > 0) {
            const availableIndices = await checkAvailableChartImages(ceoPulse.monthKey, chartCount);
            resolvedHtml = resolveChartPlaceholders(resolvedHtml, ceoPulse.monthKey, availableIndices);
          } else if (resolvedHtml) {
            resolvedHtml = resolveChartPlaceholders(resolvedHtml, ceoPulse.monthKey, new Set(), { stripMissing: true });
          }
          if (resolvedHtml) {
            // Task #4293 — {{image-N}} resolves only for published briefs
            // (drafts strip, mirroring charts): the resolver always strips
            // slots missing from the list it is given.
            resolvedHtml = resolveImagePlaceholders(
              resolvedHtml,
              ceoPulse.monthKey,
              ceoPulse.isPublished
                ? readCeoPulseSupportingImages(ceoPulse.supportingImages, { ceoPulseId: ceoPulse.id })
                : [],
            );
          }
          return { ...ceoPulse, fullLetterHtml: resolvedHtml };
        })() : ceoPulse,
        // Task #4216 — same live "Product updates" block as the share/preview
        // builder above (single helper), so the demo report shows the real
        // current-quarter product sample. Pulse-gated + best-effort likewise.
        productUpdates: ceoPulse
          ? await buildReportProductUpdates().catch((err) => {
              console.error(
                "[Reports] product updates block failed (demo report still served):",
                err,
              );
              return null;
            })
          : null,
        dataAccess: dataAccess.map(item => ({ category: item.category, status: item.status })),
        trendData: trendData.length > 1 ? trendData : null,
        lifetimeValue,
        // Task #4273 — same stored-copy-only contract as buildReportResponse:
        // the anonymous demo route never computes verdicts.
        slideVerdicts: readStoredSlideVerdicts(
          sections.find((s) => s.sectionKey === SLIDE_VERDICTS_SECTION_KEY)?.data,
        ),
      });
    } catch (error) {
      console.error("Error fetching demo report:", error);
      res.status(500).json({ error: "Report operation failed" });
    }
  });

  }
  
