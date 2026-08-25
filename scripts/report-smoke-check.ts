/**
 * Task #4690 — pre-Publish report smoke check (re-runnable).
 *
 * Re-runs a small slice of the Task #4671 go-live parity audit
 * (`audits/go-live-parity-audit-2026-08-13.md`) against the CURRENT build so
 * the parity guarantee covers the exact commit being published. The #4671
 * harness was uncommitted and died with its task environment; this script is
 * the committed, rerunnable replacement (§8/§10.3 of the audit doc).
 *
 * What it does, per selected final report (~20, spanning the 2025-12..2026-07
 * era mix, always including at least one webinar-lead client and one legacy
 * no-noDataFlags report):
 *   1. Served-payload check — anonymous `GET /api/share/:token` against prod
 *      (https://reports.nobullmarketing.com) vs the local build; every
 *      difference must match the §3 allowlist (privacyApplied / accountManager
 *      / slideVerdicts adds, internal-key strips, pulse edition + supporting
 *      images, localDominance compared by key presence). Anything else BLOCKS.
 *   2. Render health — headless render of the local build's /share/:token:
 *      no state page, no section error boundaries, no page errors, no broken
 *      images, sane slide census. Capture stability = per-slide innerText
 *      lengths stable across two 1.5 s samples after a pre-sleep (marketing
 *      charts mount async ~5-6.5 s; body-length polling races).
 *   3. Print validity — headless PDF of the share page; magic bytes + size.
 *   4. Displayed-info numeric parity — numeric token SET-diff (SET semantics,
 *      per the audit method) between prod and local renders; prod-only tokens
 *      must classify to a §4 allowlist class (seconds-rounded#4279,
 *      webinar-lead-equiv#4511 exact math, est-revenue-real-acv#4278,
 *      marketshare-leaderboard-removed#4280, pulse-charts-capped#4276,
 *      market-context-conditional-drop#4277, tokenizer-artifact). Residue
 *      BLOCKS with the raw evidence printed for manual classification.
 *      Note (#4717): the Marketing slide's map cards now render a LOCAL-only
 *      competitor-standing line ("You rank #N of M firms detected in this
 *      market — top competitors: …", averageRank-derived) under each map
 *      takeaway. Local-only additive tokens sit outside this check's
 *      prod-only diff direction by construction — the new numerals/names are
 *      an intended additive change, never parity residue.
 * Plus: the tokened NoBull Brief (CEO pulse) share links load OK on both
 * prod and local (API 200 + page renders non-trivially).
 *
 * Plus (#4721, once per invocation / offset-0 chunk): the sparse-deck
 * page-break regression check — seeds a disposable legacy-shaped sparse
 * report (no sections, final, tokened), prints it with a marker stylesheet,
 * rasterizes the pages (pdftoppm) and BLOCKS if a no-data upsell callout or
 * dashed chart-placeholder frame is fragmented across a page boundary (the
 * atomic-card print CSS contract in client/src/index.css). See the
 * "Page-break regression check" section below. `--page-break-only` runs
 * just this check; `--skip-page-break` omits it.
 *
 * Plus (#4728, same cadence): a dense-deck companion pass — deterministically
 * picks the data-RICHEST restored final report (most sections, then most
 * section-data bytes, id tiebreak), prints it with the card-family marker
 * tint (the atomic-card break-inside contract's own selectors) and BLOCKS if
 * any leaf card (stat card, list row, chart card) fragments across a page
 * boundary. Read-only over the restored corpus; same detector + liveness
 * guard. Controlled by the same --page-break-only / --skip-page-break flags.
 *
 * Prerequisites:
 *   - Local DB restored/refreshed from the latest prod backup
 *     (`scripts/refresh-dev-db-from-backup.ts`) so local rows byte-match the
 *     prod content each baseline was served from — otherwise payload value
 *     diffs are data drift, not code. The script prints a per-report
 *     content fingerprint so drift can be told apart from regressions.
 *   - The app running locally (default http://127.0.0.1:5000).
 *   - Prod is touched via anonymous GETs ONLY (share path is side-effect
 *     free); draft previews are deliberately out of scope here — the authed
 *     preview route stamps client activity and must never be hit on prod.
 *
 * Usage:
 *   npx tsx scripts/report-smoke-check.ts                # full smoke (~20)
 *   npx tsx scripts/report-smoke-check.ts --count=6      # quicker slice
 *   npx tsx scripts/report-smoke-check.ts --local-only   # skip prod baseline
 *     (render/print health only — payload+info parity need prod)
 *   npx tsx scripts/report-smoke-check.ts --page-break-selftest
 *     # negative-path proof (#4735/#4747): sabotage the print contracts of
 *     # BOTH page-break checks — sparse (upsell callouts + chart-placeholder
 *     # frames) and dense (atomic-card family) — and require each to report
 *     # a BLOCKING split finding
 *     # (exit 0 = both checks block as promised; exit 1 = a check is blind)
 *
 * Exit codes: 0 = PASS (no blocking findings); 1 = BLOCKING findings —
 * do not Publish until each is classified to a task-cited intended change
 * (extend the audit doc's allowlist) or fixed.
 */
import { Client } from "pg";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { PUBLIC_INTERNAL_SECTION_DATA_KEYS } from "../server/services/reportPublicInternalKeys";
import {
  PAGE_BREAK_MARKER_CSS,
  DENSE_PAGE_BREAK_MARKER_CSS,
  DENSE_PAGE_BREAK_SABOTAGE_CSS,
  SPARSE_PAGE_BREAK_SABOTAGE_CSS,
  parsePpm,
  countMarkerPixels,
  sortPpmPageFiles,
  detectSplitBoundaries,
} from "./reportSmokePageBreak";

function findChromium(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return execSync("which chromium || which chromium-browser", { encoding: "utf8" }).trim().split("\n")[0];
}

const PROD_BASE = "https://reports.nobullmarketing.com";
const LOCAL_BASE = process.env.SMOKE_LOCAL_BASE || "http://127.0.0.1:5000";
const OUT_DIR = path.join(".local", "runs", "report-smoke");

interface ReportRow {
  id: string;
  report_month: string;
  share_token: string;
  webinar: boolean;
  legacy_no_ndf: boolean;
  fingerprint: string;
}

interface Finding {
  reportId: string;
  kind: string;
  detail: string;
  blocking: boolean;
}

const findings: Finding[] = [];
function addFinding(f: Finding): void {
  findings.push(f);
  console.log(`  ${f.blocking ? "✗ BLOCKING" : "• note"} [${f.kind}] ${f.detail}`);
}

function parseArgs(): { count: number; localOnly: boolean; offset: number; limit: number; skipPulses: boolean; pageBreakOnly: boolean; skipPageBreak: boolean; pageBreakSelftest: boolean } {
  let count = 20;
  let localOnly = false;
  let offset = 0;
  let limit = Number.MAX_SAFE_INTEGER;
  let skipPulses = false;
  let pageBreakOnly = false;
  let skipPageBreak = false;
  let pageBreakSelftest = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--count=")) count = parseInt(a.slice(8), 10);
    if (a === "--local-only") localOnly = true;
    // Chunked runs (agent shell caps): selection stays stable for a given
    // --count; --offset/--limit slice it. Findings are per-run — aggregate
    // across chunks yourself.
    if (a.startsWith("--offset=")) offset = parseInt(a.slice(9), 10);
    if (a.startsWith("--limit=")) limit = parseInt(a.slice(8), 10);
    if (a === "--skip-pulses") skipPulses = true;
    // Page-break regression check (Task #4721): --page-break-only runs just
    // the sparse-deck pagination check; --skip-page-break omits it (it
    // otherwise runs once per invocation, on the offset-0 chunk only).
    if (a === "--page-break-only") pageBreakOnly = true;
    if (a === "--skip-page-break") skipPageBreak = true;
    // Negative-path self-test (Tasks #4735/#4747): --page-break-selftest
    // runs ONLY the two page-break checks, each with a sabotage stylesheet
    // that defeats its print contract (sparse: upsell/chart-placeholder
    // break-inside; dense: atomic-card break-inside — both plus the
    // slide-level page fitting), then asserts EACH check produced a
    // BLOCKING split finding. Exit 0 = both checks proved they block when
    // their print rules break; exit 1 = a pipeline (marker injection,
    // pdftoppm, edge-strip detector) silently passed a known-broken print —
    // that check is blind and must be fixed.
    if (a === "--page-break-selftest") pageBreakSelftest = true;
  }
  return { count, localOnly, offset, limit, skipPulses, pageBreakOnly, skipPageBreak, pageBreakSelftest };
}

// ── Selection ───────────────────────────────────────────────────────────────

async function selectCorpus(pg: Client, count: number): Promise<{ reports: ReportRow[]; pulses: { id: string; month_key: string; share_token: string }[] }> {
  const { rows: all } = await pg.query<ReportRow>(`
    with finals as (
      select r.id, r.report_month, r.share_token
      from reports r
      where r.status = 'final' and r.share_token is not null
        and r.report_month between '2025-12' and '2026-07'
    ),
    webinar as (
      select rs.report_id from report_sections rs
      where rs.section_key = 'marketing'
        and coalesce(nullif(coalesce(rs.data->'webinar'->>'hotTransfers', rs.data->'webinars'->>'hotTransfers'), ''), '0')::numeric > 0
    ),
    fp as (
      select rs.report_id, substr(md5(string_agg(md5(rs.data::text), '' order by rs.section_key)), 1, 8) as fingerprint
      from report_sections rs group by rs.report_id
    )
    select f.id, f.report_month, f.share_token,
      (f.id in (select report_id from webinar)) as webinar,
      (not exists (select 1 from report_sections rs where rs.report_id = f.id and rs.data ? 'noDataFlags')) as legacy_no_ndf,
      coalesce(fp.fingerprint, '-') as fingerprint
    from finals f left join fp on fp.report_id = f.id
    order by f.report_month, f.id
  `);

  // Era-spread pick: round-robin across months; force in >=1 webinar and
  // >=1 legacy no-noDataFlags report (the two era edge cases from the plan).
  const byMonth = new Map<string, ReportRow[]>();
  for (const r of all) {
    const arr = byMonth.get(r.report_month) ?? [];
    arr.push(r);
    byMonth.set(r.report_month, arr);
  }
  const picked = new Map<string, ReportRow>();
  const forceWebinar = all.find((r) => r.webinar);
  const forceLegacy = all.find((r) => r.legacy_no_ndf);
  if (forceWebinar) picked.set(forceWebinar.id, forceWebinar);
  if (forceLegacy) picked.set(forceLegacy.id, forceLegacy);
  const months = [...byMonth.keys()].sort();
  let idx = 0;
  while (picked.size < Math.min(count, all.length)) {
    const month = months[idx % months.length];
    idx++;
    const candidates = (byMonth.get(month) ?? []).filter((r) => !picked.has(r.id));
    if (candidates.length === 0) {
      if (months.every((m) => (byMonth.get(m) ?? []).every((r) => picked.has(r.id)))) break;
      continue;
    }
    picked.set(candidates[0].id, candidates[0]);
  }

  const { rows: pulses } = await pg.query(
    `select id, month_key, share_token from ceo_pulses where share_token is not null order by month_key`,
  );
  return { reports: [...picked.values()], pulses };
}

// ── Payload diff (§3 allowlist) ─────────────────────────────────────────────

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** §3 allowlist judgment for a single diff path. Returns the allow class or null. */
function allowPayloadDiff(pathParts: string[], kind: "local-only" | "prod-only" | "value"): string | null {
  const p = pathParts.join(".");
  // localDominance is re-hydrated live at serve time by design — key
  // presence only (established serve-path seam).
  if (pathParts.includes("localDominance") && pathParts[pathParts.length - 1] !== "localDominance") {
    return "localDominance-live-rehydration";
  }
  if (kind === "local-only") {
    if (p === "privacyApplied" || p === "report.privacyApplied") return "privacyApplied-add#4290";
    if (pathParts[0] === "accountManager") return "accountManager-add#4282";
    if (pathParts[0] === "slideVerdicts") return "slideVerdicts-add#4273";
    if (pathParts[0] === "ceoPulse" && (pathParts[1] === "edition" || pathParts[1] === "editionLabel")) return "pulse-edition-add#4268/#4304";
    if (pathParts[0] === "ceoPulse" && pathParts[1] === "supportingImages") return "pulse-supporting-images-add#4293";
  }
  if (kind === "prod-only") {
    const leaf = pathParts[pathParts.length - 1];
    if (PUBLIC_INTERNAL_SECTION_DATA_KEYS.includes(leaf)) return "internal-key-strip#4467/#4509";
  }
  return null;
}

/**
 * Arrays whose order is presentation, not information (audit method: "slide
 * sets compared as sets", deck order is #4522's spec). Matched key-wise by a
 * stable identity field so a reordered array is not a diff.
 */
const KEYED_ARRAY_IDENTITY: Record<string, string> = {
  sections: "sectionKey",
  dataAccess: "category",
};

function diffPayload(prod: Json, local: Json, pathParts: string[], out: { path: string; kind: string; allow: string | null }[]): void {
  if (isObj(prod) && isObj(local)) {
    const keys = new Set([...Object.keys(prod), ...Object.keys(local)]);
    for (const k of keys) {
      const next = [...pathParts, k];
      if (!(k in local)) out.push({ path: next.join("."), kind: "prod-only", allow: allowPayloadDiff(next, "prod-only") });
      else if (!(k in prod)) out.push({ path: next.join("."), kind: "local-only", allow: allowPayloadDiff(next, "local-only") });
      else diffPayload(prod[k], local[k], next, out);
    }
    return;
  }
  if (Array.isArray(prod) && Array.isArray(local)) {
    if (JSON.stringify(prod) === JSON.stringify(local)) return;
    const idField = KEYED_ARRAY_IDENTITY[pathParts[pathParts.length - 1] ?? ""];
    if (idField && prod.every((e) => isObj(e) && idField in e) && local.every((e) => isObj(e) && idField in e)) {
      // Order-insensitive: match by identity field, diff matched pairs.
      const prodById = new Map(prod.map((e) => [String((e as Record<string, Json>)[idField]), e]));
      const localById = new Map(local.map((e) => [String((e as Record<string, Json>)[idField]), e]));
      for (const [id, pe] of prodById) {
        const le = localById.get(id);
        const next = [...pathParts, `{${idField}=${id}}`];
        if (le === undefined) out.push({ path: next.join("."), kind: "prod-only", allow: allowPayloadDiff([...pathParts.slice(0, -1), pathParts[pathParts.length - 1]], "prod-only") });
        else diffPayload(pe, le, next, out);
      }
      for (const id of localById.keys()) {
        if (!prodById.has(id)) {
          const next = [...pathParts, `{${idField}=${id}}`];
          out.push({ path: next.join("."), kind: "local-only", allow: allowPayloadDiff(next, "local-only") });
        }
      }
      return;
    }
    if (prod.length === local.length) {
      for (let i = 0; i < prod.length; i++) diffPayload(prod[i], local[i], [...pathParts, String(i)], out);
    } else {
      // Order-insensitive multiset compare for scalar/leaf arrays.
      const ps = [...prod].map((e) => JSON.stringify(e)).sort();
      const ls = [...local].map((e) => JSON.stringify(e)).sort();
      if (JSON.stringify(ps) !== JSON.stringify(ls)) {
        out.push({ path: pathParts.join("."), kind: "value", allow: allowPayloadDiff(pathParts, "value") });
      }
    }
    return;
  }
  if (JSON.stringify(prod) !== JSON.stringify(local)) {
    out.push({ path: pathParts.join("."), kind: "value", allow: allowPayloadDiff(pathParts, "value") });
  }
}

// ── Render capture ──────────────────────────────────────────────────────────

interface RenderCapture {
  slides: { id: string; text: string }[];
  statePage: boolean;
  sectionErrors: string[];
  pageErrors: string[];
  consoleErrors: string[];
  brokenImages: number;
}

async function captureRender(browser: Browser, url: string): Promise<RenderCapture> {
  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Pre-sleep: marketing charts mount asynchronously ~5-6.5 s on the deck.
    await new Promise((r) => setTimeout(r, 6_500));
    // Stability: per-slide innerText-length concatenation stable across two
    // 1.5 s samples (audit capture rule — body-length polling races).
    const sample = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("section.slide, .slide")).map((s) => (s as HTMLElement).innerText.length).join(","),
      );
    let prev = await sample();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1_500));
      const cur = await sample();
      if (cur === prev && cur.length > 0) break;
      prev = cur;
    }
    const data = await page.evaluate(() => {
      const slides = Array.from(document.querySelectorAll("section.slide, .slide")).map((s, i) => ({
        id: (s as HTMLElement).id || `slide-${i}`,
        text: (s as HTMLElement).innerText,
      }));
      const statePage = !!document.querySelector('[data-testid="report-state-page"]');
      const sectionErrors = Array.from(document.querySelectorAll('[data-testid^="section-error-"]')).map(
        (e) => e.getAttribute("data-testid") || "",
      );
      const brokenImages = Array.from(document.querySelectorAll("img")).filter(
        (img) => img.complete && img.naturalWidth === 0 && !!img.getAttribute("src"),
      ).length;
      return { slides, statePage, sectionErrors, brokenImages };
    });
    return { ...data, pageErrors, consoleErrors };
  } finally {
    await page.close();
  }
}

async function capturePdf(browser: Browser, url: string, injectCss?: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 8_000));
    if (injectCss) await page.addStyleTag({ content: injectCss });
    const pdf = await page.pdf({ printBackground: true, timeout: 120_000 });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

// ── Page-break regression check (Task #4721) ────────────────────────────────
//
// Pagination of the no-data deck is guarded only by print CSS (the
// atomic-card `break-inside: avoid` family in client/src/index.css @media
// print — `[class*="rounded-lg"]:not([class*="p-8"])` etc.). Task #4715
// verified manually that SectionUpsellCallout gold bands and
// ChartPlaceholderFrame dashed frames never split across a page boundary;
// this check makes that verification automatic and deterministic:
//
//   1. Seed a DISPOSABLE legacy-shaped sparse report (fresh client, zero
//      report_sections rows, status=final, share_token) — the deck renders
//      every major section as an empty skeleton with exactly one gold
//      upsell callout per section plus dashed placeholder frames
//      (client/src/pages/publicReport/EmptyState.tsx convention, #4693).
//   2. Print the share page to PDF with a layout-neutral marker stylesheet
//      injected: every `[data-testid^="upsell-"]` and
//      `[data-testid^="chart-placeholder-"]` element gets a solid magenta
//      background. Background color never affects fragmentation, so the
//      REAL print CSS still decides where pages break — the tint only makes
//      the atomic elements machine-detectable in rasters (the real gold/10
//      band and 3%-alpha dashed frame are too faint to threshold reliably).
//   3. Rasterize pages via pdftoppm (PPM, dependency-free parse) and flag a
//      fragment: marker pixels touching the BOTTOM edge strip of page N and
//      the TOP edge strip of page N+1 in overlapping x-columns. Slides have
//      padding, so an intact callout/frame never touches a page edge —
//      edge-touching marker ink on both sides of a boundary = a split.
//   4. Detector liveness: zero marker pixels across the whole deck is
//      itself BLOCKING ("0 of 0" would otherwise silently pass after a
//      testid rename or an empty-state regression).
//
// The fixture rows are deleted in a finally block; nothing persists.

async function checkSparseDeckPageBreaks(browser: Browser, opts?: { sabotageCss?: string }): Promise<void> {
  console.log(`\n── Page-break regression check (sparse no-data deck)${opts?.sabotageCss ? " [SELFTEST — break-inside contract sabotaged]" : ""}`);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const token = `sparse-smoke-${randomUUID()}`;
  let clientId: string | null = null;
  let reportId: string | null = null;
  const rasterDir = path.join(OUT_DIR, "page-break-rasters");
  try {
    // Disposable legacy-shaped sparse fixture: fresh client (empty products),
    // final tokened report, ZERO report_sections rows — the deck renders all
    // major sections as empty skeletons regardless (sectionPresence.ts).
    const { rows: cr } = await pg.query(
      `insert into clients (firm_name, products) values ($1, '{}'::text[]) returning id`,
      [`ZZ Sparse Page-Break Smoke ${token.slice(-8)}`],
    );
    clientId = cr[0].id;
    const { rows: rr } = await pg.query(
      `insert into reports (client_id, report_month, status, share_token) values ($1, '2026-01', 'final', $2) returning id`,
      [clientId, token],
    );
    reportId = rr[0].id;

    const api = await fetchJson(`${LOCAL_BASE}/api/share/${token}`);
    if (api.status !== 200) {
      addFinding({ reportId: "sparse-fixture", kind: "page-break", detail: `sparse fixture /api/share returned ${api.status}`, blocking: true });
      return;
    }

    const render = await captureRender(browser, `${LOCAL_BASE}/share/${token}`);
    if (render.statePage || render.pageErrors.length > 0) {
      addFinding({
        reportId: "sparse-fixture",
        kind: "page-break",
        detail: `sparse deck failed to render (statePage=${render.statePage}; ${render.pageErrors.join("; ")})`,
        blocking: true,
      });
      return;
    }

    // Selftest sabotage CSS is appended AFTER the marker tint so its
    // equal-specificity !important break-inside overrides win by source order.
    const pdf = await capturePdf(browser, `${LOCAL_BASE}/share/${token}`, PAGE_BREAK_MARKER_CSS + (opts?.sabotageCss ?? ""));
    const pdfPath = path.join(OUT_DIR, "sparse-page-break.pdf");
    writeFileSync(pdfPath, pdf);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      addFinding({ reportId: "sparse-fixture", kind: "page-break", detail: "sparse deck PDF capture invalid (no %PDF- magic)", blocking: true });
      return;
    }

    rmSync(rasterDir, { recursive: true, force: true });
    mkdirSync(rasterDir, { recursive: true });
    execSync(`pdftoppm -r 60 "${pdfPath}" "${path.join(rasterDir, "page")}"`, { stdio: "inherit" });
    // Numeric page-order sort — pdftoppm zero-pads only to the deck's digit
    // width, so lexicographic order interleaves pages across digit
    // boundaries (page-1, page-10, page-2 …) and would compare non-adjacent
    // pages at the boundary detector.
    const pageFiles = sortPpmPageFiles(
      readdirSync(rasterDir).filter((f) => f.startsWith("page") && f.endsWith(".ppm")),
    );
    if (pageFiles.length < 8) {
      addFinding({ reportId: "sparse-fixture", kind: "page-break", detail: `only ${pageFiles.length} PDF pages rasterized (expected a full deck)`, blocking: true });
      return;
    }
    const pages = pageFiles.map((f) => parsePpm(readFileSync(path.join(rasterDir, f))));

    // Detector liveness: the sparse deck must show marker ink somewhere, or
    // the selectors/empty-state convention regressed and the check is blind.
    const totalMarker = pages.reduce((a, p) => a + countMarkerPixels(p), 0);
    if (totalMarker < 100) {
      addFinding({
        reportId: "sparse-fixture",
        kind: "page-break",
        detail: `page-break detector saw ~no marker pixels (${totalMarker}) — upsell/chart-placeholder testids or the sparse empty-state deck regressed; check is blind`,
        blocking: true,
      });
      return;
    }

    // A split = marker ink touching the bottom edge strip of page N AND the
    // top edge strip of page N+1 in overlapping columns (≥3 to dodge noise).
    const splits = detectSplitBoundaries(pages);
    for (const s of splits) {
      addFinding({
        reportId: "sparse-fixture",
        kind: "page-break",
        detail: `callout/placeholder fragmented across page boundary ${s.pageAbove}→${s.pageAbove + 1} (${s.overlap} overlapping marker columns) — atomic-card print CSS regressed`,
        blocking: true,
      });
    }
    if (splits.length === 0) {
      console.log(`  page-break: PASS — ${pages.length} pages, ${totalMarker} marker px, no callout/frame split across any boundary`);
    }
  } finally {
    try {
      if (reportId) await pg.query(`delete from report_sections where report_id = $1`, [reportId]);
      if (reportId) await pg.query(`delete from reports where id = $1`, [reportId]);
      if (clientId) await pg.query(`delete from clients where id = $1`, [clientId]);
    } catch (e) {
      console.error("  page-break: fixture cleanup failed:", e);
    }
    await pg.end();
    rmSync(rasterDir, { recursive: true, force: true });
  }
}

// ── Dense-deck page-break check (Task #4728) ────────────────────────────────
//
// Companion pass to the sparse check above: data-heavy decks have many more
// atomic print units (stat cards, list rows, chart cards — the card /
// [class*="rounded-lg"]:not([class*="p-8"]) family in client/src/index.css
// @media print) that the sparse fixture never renders. This pass prints a
// representative data-RICH final report with the card-family marker tint
// (DENSE_PAGE_BREAK_MARKER_CSS, selector list lockstep-tested against the
// live print CSS) and applies the same PPM edge-overlap detector.
//
// Deterministic selection rule over the restored prod corpus: the tokened
// final report (2025-12..2026-07 era, same window as the smoke corpus) with
// the MOST report_sections rows, ties broken by total section-data bytes
// descending, then id ascending — a stable "densest deck" pick for a given
// restore. Read-only: nothing is seeded or deleted.

async function checkDenseDeckPageBreaks(browser: Browser, opts?: { sabotageCss?: string }): Promise<void> {
  console.log(`\n── Page-break regression check (dense data-rich deck)${opts?.sabotageCss ? " [SELFTEST — break-inside contract sabotaged]" : ""}`);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const rasterDir = path.join(OUT_DIR, "page-break-rasters-dense");
  try {
    const { rows } = await pg.query<{ id: string; report_month: string; share_token: string; sections: number; bytes: string }>(`
      select r.id, r.report_month, r.share_token,
        count(rs.id)::int as sections,
        coalesce(sum(length(rs.data::text)), 0)::text as bytes
      from reports r
      join report_sections rs on rs.report_id = r.id
      where r.status = 'final' and r.share_token is not null
        and r.report_month between '2025-12' and '2026-07'
      group by r.id, r.report_month, r.share_token
      order by count(rs.id) desc, sum(length(rs.data::text)) desc, r.id asc
      limit 1
    `);
    if (rows.length === 0) {
      addFinding({
        reportId: "dense-pick",
        kind: "page-break-dense",
        detail: "no tokened final report with sections found — local DB is not a prod restore; dense page-break check cannot run",
        blocking: true,
      });
      return;
    }
    const pick = rows[0];
    console.log(`  dense pick: ${pick.report_month} ${pick.id.slice(0, 8)} (${pick.sections} sections, ${pick.bytes} data bytes)`);

    const render = await captureRender(browser, `${LOCAL_BASE}/share/${pick.share_token}`);
    if (render.statePage || render.pageErrors.length > 0) {
      addFinding({
        reportId: pick.id,
        kind: "page-break-dense",
        detail: `dense deck failed to render (statePage=${render.statePage}; ${render.pageErrors.join("; ")})`,
        blocking: true,
      });
      return;
    }

    // Selftest sabotage CSS is appended AFTER the marker tint so its
    // equal-specificity !important break-inside overrides win by source order.
    const pdf = await capturePdf(
      browser,
      `${LOCAL_BASE}/share/${pick.share_token}`,
      DENSE_PAGE_BREAK_MARKER_CSS + (opts?.sabotageCss ?? ""),
    );
    const pdfPath = path.join(OUT_DIR, "dense-page-break.pdf");
    writeFileSync(pdfPath, pdf);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      addFinding({ reportId: pick.id, kind: "page-break-dense", detail: "dense deck PDF capture invalid (no %PDF- magic)", blocking: true });
      return;
    }

    rmSync(rasterDir, { recursive: true, force: true });
    mkdirSync(rasterDir, { recursive: true });
    execSync(`pdftoppm -r 60 "${pdfPath}" "${path.join(rasterDir, "page")}"`, { stdio: "inherit" });
    const pageFiles = sortPpmPageFiles(
      readdirSync(rasterDir).filter((f) => f.startsWith("page") && f.endsWith(".ppm")),
    );
    if (pageFiles.length < 8) {
      addFinding({ reportId: pick.id, kind: "page-break-dense", detail: `only ${pageFiles.length} PDF pages rasterized (expected a full dense deck)`, blocking: true });
      return;
    }
    const pages = pageFiles.map((f) => parsePpm(readFileSync(path.join(rasterDir, f))));

    // Detector liveness: a dense deck is card-saturated — near-zero marker
    // ink means the card-family selectors drifted from the print CSS (or the
    // tint never applied) and the check is blind. Blocking, same as sparse.
    const totalMarker = pages.reduce((a, p) => a + countMarkerPixels(p), 0);
    if (totalMarker < 100) {
      addFinding({
        reportId: pick.id,
        kind: "page-break-dense",
        detail: `dense page-break detector saw ~no marker pixels (${totalMarker}) — card-family marker selectors or the deck regressed; check is blind`,
        blocking: true,
      });
      return;
    }

    const splits = detectSplitBoundaries(pages);
    for (const s of splits) {
      addFinding({
        reportId: pick.id,
        kind: "page-break-dense",
        detail: `leaf card fragmented across page boundary ${s.pageAbove}→${s.pageAbove + 1} (${s.overlap} overlapping marker columns) — atomic-card print CSS regressed`,
        blocking: true,
      });
    }
    if (splits.length === 0) {
      console.log(`  page-break-dense: PASS — ${pages.length} pages, ${totalMarker} marker px, no leaf card split across any boundary`);
    }
  } finally {
    await pg.end();
    rmSync(rasterDir, { recursive: true, force: true });
  }
}

// ── Info-token parity (§4, numeric SET semantics) ───────────────────────────

const NUM_TOKEN_RE = /\$?\d[\d,]*(?:\.\d+)?%?s?/g;

function numericTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(NUM_TOKEN_RE) ?? []) out.add(m);
  return out;
}

function normNum(tok: string): number | null {
  const cleaned = tok.replace(/[$,%s]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Occurrence contexts of removed old-build modules (git-archaeology-cited in
 * the audit): #4280 market-share leaderboard + explainer + keyword-ranking +
 * coverage-trend, #4280 marketing restructure (per-source paid table, donut
 * cluster, ops chrome), and old-build template metric-card copy (#4287).
 * Judged per-occurrence on a ±150-char window around the token, per the
 * audit method ("every prod-only occurrence individually matched against
 * removed-module contexts").
 */
const REMOVED_MODULE_CONTEXT_RE =
  /market share|how it'?s calculated|keyword ranking|coverage trend|visibility leaderboard|total spend|blended cpl|paid search advertising|pipeline momentum|target: ?≥|registrants:|attendees:|leads quality breakdown|shown separately|reviews trend|leads sources over time|good leads by source|leads by source \(monthly\)|ranking distribution|market[’']?s visibility|total visibility|scan grid|local search dominance|% coverage|avg #/i;

interface InfoClassification {
  token: string;
  cls: string | null;
  context: string;
}

function classifyProdOnlyToken(
  token: string,
  prodSlides: { id: string; text: string }[],
  localAllText: string,
  payload: Record<string, Json>,
): InfoClassification {
  // Per-occurrence windows (±150 chars) — classification must hold for EVERY
  // occurrence, per the audit method.
  const windows: { id: string; win: string }[] = [];
  for (const s of prodSlides) {
    let i = s.text.indexOf(token);
    while (i >= 0) {
      windows.push({ id: s.id, win: s.text.slice(Math.max(0, i - 220), i + token.length + 220) });
      i = s.text.indexOf(token, i + 1);
    }
  }
  const occurrences = prodSlides.filter((s) => s.text.includes(token));
  const context = occurrences.map((o) => o.id).join(",");
  const n = normNum(token);

  // tokenizer-artifact: token exists locally only as substring of a longer number.
  if (localAllText.includes(token.replace(/[$%s]/g, ""))) {
    return { token, cls: "tokenizer-artifact", context };
  }
  // seconds-rounded#4279: prod "31.28s"-style decimal seconds; rounded value present locally.
  if (/^\d+\.\d+s$/.test(token) && n !== null && localAllText.includes(`${Math.round(n)}s`)) {
    return { token, cls: "seconds-rounded#4279", context };
  }
  // removed-module#4280/#4287: every prod occurrence window sits in a
  // removed-module context (leaderboard, per-source paid table, template
  // metric-card copy).
  if (windows.length > 0 && windows.every((w) => REMOVED_MODULE_CONTEXT_RE.test(w.win))) {
    return { token, cls: "removed-module#4280/#4287", context };
  }
  // leak-recompute#4511: pipeline-leak math is derived from the lead total,
  // so the webinar lead-equiv shift recomputes every leak figure. Every
  // occurrence must sit in leak/engine-math context (or a removed module),
  // and at least one in leak context, on a report that has webinar data.
  const LEAK_CONTEXT_RE =
    /pipeline leak|leakage|slipping through|cases lost|recoverable|top-line revenue|leads generated|total leads generated|avg(erage)? case value|est\. top-line/i;
  {
    const marketing = (payload.sections as Json[] | undefined)?.map((s) => s as Record<string, Json>).find((s) => s.sectionKey === "marketing");
    const webinar = ((marketing?.data as Record<string, Json> | undefined)?.webinar ?? (marketing?.data as Record<string, Json> | undefined)?.webinars) as Record<string, Json> | undefined;
    if (
      webinar &&
      windows.length > 0 &&
      windows.some((w) => LEAK_CONTEXT_RE.test(w.win)) &&
      windows.every((w) => LEAK_CONTEXT_RE.test(w.win) || REMOVED_MODULE_CONTEXT_RE.test(w.win))
    ) {
      return { token, cls: "leak-recompute#4511", context };
    }
  }
  // webinar-lead-equiv#4511: prod total == localTotal − (ceil(c×1.6) − c),
  // where c is the webinar count the deck rides (webinar leads or hot
  // transfers — payload-verified candidates, exact math per the audit).
  if (n !== null) {
    const marketing = (payload.sections as Json[] | undefined)?.map((s) => s as Record<string, Json>).find((s) => s.sectionKey === "marketing");
    const data = marketing?.data as Record<string, Json> | undefined;
    const webinar = (data?.webinar ?? data?.webinars) as Record<string, Json> | undefined;
    const lq = (webinar?.leadQuality ?? {}) as Record<string, Json>;
    const lqSum = Object.values(lq).reduce<number>((a, v) => a + (Number(v) || 0), 0);
    const candidates = new Set<number>([Number(webinar?.hotTransfers ?? 0), Number(lq.good ?? 0), lqSum].filter((c) => c > 0));
    for (const c of candidates) {
      const shifted = n + (Math.ceil(c * 1.6) - c);
      if (localAllText.includes(shifted.toLocaleString("en-US")) || localAllText.includes(String(shifted))) {
        return { token, cls: "webinar-lead-equiv#4511", context };
      }
    }
  }
  // est-revenue-real-acv#4278: prod top-line == totalCases × $5,000 heuristic
  // (payload-verified; the "$270" of a "$270k" chip arrives k-stripped).
  if (n !== null && n > 0 && token.startsWith("$")) {
    const sales = (payload.sections as Json[] | undefined)?.map((s) => s as Record<string, Json>).find((s) => s.sectionKey === "sales");
    const totalCases = Number((sales?.data as Record<string, Json> | undefined)?.totalCases ?? 0);
    if (totalCases > 0) {
      const expected = totalCases * 5000;
      if (n === expected || n * 1000 === expected) {
        return { token, cls: "est-revenue-real-acv#4278", context };
      }
    }
  }
  // pulse-charts-capped#4276: token present only in aiAnalysis.charts[2:].
  const pulse = payload.ceoPulse as Record<string, Json> | undefined;
  const analysis = pulse?.aiAnalysis as Record<string, Json> | undefined;
  const charts = (analysis?.charts as Json[]) ?? [];
  if (charts.length > 2) {
    const tail = JSON.stringify(charts.slice(2));
    const bare = token.replace(/[$,%s]/g, "");
    if (tail.includes(bare)) return { token, cls: "pulse-charts-capped#4276", context };
    // Chart chrome (axis ticks, generated labels) of capped charts never
    // appears in the payload JSON — classify by slide containment instead.
    if (windows.length > 0 && windows.every((w) => w.id === "ceo-pulse")) {
      return { token, cls: "pulse-charts-capped#4276", context };
    }
  }
  return { token, cls: null, context };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body: Json = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const { count, localOnly, offset, limit, skipPulses, pageBreakOnly, skipPageBreak, pageBreakSelftest } = parseArgs();
  mkdirSync(OUT_DIR, { recursive: true });
  if (pageBreakSelftest) {
    // Negative-path proof (Task #4735): sabotage the atomic-card
    // break-inside contract and require the dense check to BLOCK. This mode
    // never mixes with real runs — it exits on its own inverted verdict.
    const browser = await puppeteer.launch({
      executablePath: findChromium(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      await checkSparseDeckPageBreaks(browser, { sabotageCss: SPARSE_PAGE_BREAK_SABOTAGE_CSS });
      await checkDenseDeckPageBreaks(browser, { sabotageCss: DENSE_PAGE_BREAK_SABOTAGE_CSS });
    } finally {
      await browser.close();
    }
    finishPageBreakSelftest();
    return;
  }
  if (pageBreakOnly) {
    const browser = await puppeteer.launch({
      executablePath: findChromium(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      await checkSparseDeckPageBreaks(browser);
      await checkDenseDeckPageBreaks(browser);
    } finally {
      await browser.close();
    }
    finishRun(offset);
    return;
  }
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const { rows: sanity } = await pg.query(
    `select (select count(*)::int from reports) as reports, (select count(*)::int from reports where status='final' and share_token is not null) as finals`,
  );
  console.log(`Local DB: ${sanity[0].reports} reports / ${sanity[0].finals} tokened finals`);
  if (sanity[0].finals < 50) {
    console.log(
      "WARNING: local DB does not look like a prod restore (few tokened finals). " +
        "Run scripts/refresh-dev-db-from-backup.ts first or payload parity is meaningless.",
    );
  }

  const { reports: allReports, pulses } = await selectCorpus(pg, count);
  await pg.end();
  const reports = allReports.slice(offset, offset + limit);
  console.log(`Selected ${allReports.length} finals (webinar=${allReports.filter((r) => r.webinar).length}, legacy-no-noDataFlags=${allReports.filter((r) => r.legacy_no_ndf).length}) + ${pulses.length} pulse tokens; running ${reports.length} (offset ${offset})`);

  const browser = await puppeteer.launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    for (const r of reports) {
      const label = `${r.report_month} ${r.id.slice(0, 8)}${r.webinar ? " [webinar]" : ""}${r.legacy_no_ndf ? " [legacy]" : ""} fp=${r.fingerprint}`;
      console.log(`\n── ${label}`);

      // 1. Payload parity.
      const local = await fetchJson(`${LOCAL_BASE}/api/share/${r.share_token}`);
      if (local.status !== 200 || !isObj(local.body)) {
        addFinding({ reportId: r.id, kind: "payload", detail: `local /api/share ${local.status}`, blocking: true });
        continue;
      }
      let prodPayload: Record<string, Json> | null = null;
      if (!localOnly) {
        const prod = await fetchJson(`${PROD_BASE}/api/share/${r.share_token}`);
        if (prod.status !== 200 || !isObj(prod.body)) {
          addFinding({ reportId: r.id, kind: "payload", detail: `prod /api/share ${prod.status}`, blocking: true });
        } else {
          prodPayload = prod.body;
          const diffs: { path: string; kind: string; allow: string | null }[] = [];
          diffPayload(prod.body, local.body, [], diffs);
          const blocked = diffs.filter((d) => !d.allow);
          const allowed = diffs.filter((d) => d.allow);
          console.log(`  payload: ${diffs.length} diffs (${allowed.length} allowlisted)`);
          for (const d of blocked) {
            addFinding({ reportId: r.id, kind: "payload", detail: `${d.kind} at ${d.path} — outside §3 allowlist`, blocking: true });
          }
          writeFileSync(path.join(OUT_DIR, `payload-diff-${r.id.slice(0, 8)}.json`), JSON.stringify(diffs, null, 2));
        }
      }

      // 2+4. Renders.
      const localRender = await captureRender(browser, `${LOCAL_BASE}/share/${r.share_token}`);
      if (localRender.statePage) addFinding({ reportId: r.id, kind: "render", detail: "local render landed on a state page", blocking: true });
      for (const se of localRender.sectionErrors) addFinding({ reportId: r.id, kind: "render", detail: `section error boundary: ${se}`, blocking: true });
      for (const pe of localRender.pageErrors) addFinding({ reportId: r.id, kind: "render", detail: `page error: ${pe}`, blocking: true });
      if (localRender.brokenImages > 0) addFinding({ reportId: r.id, kind: "render", detail: `${localRender.brokenImages} broken image(s)`, blocking: true });
      if (localRender.slides.length < 8) addFinding({ reportId: r.id, kind: "render", detail: `only ${localRender.slides.length} slides rendered`, blocking: true });
      const realConsoleErrors = localRender.consoleErrors.filter((c) => !c.startsWith("Warning:"));
      for (const ce of realConsoleErrors) addFinding({ reportId: r.id, kind: "render", detail: `console error: ${ce}`, blocking: true });
      console.log(`  render: ${localRender.slides.length} slides, ${localRender.consoleErrors.length - realConsoleErrors.length} dev warning(s)`);

      // 3. Print validity.
      const pdf = await capturePdf(browser, `${LOCAL_BASE}/share/${r.share_token}`);
      const validPdf = pdf.subarray(0, 5).toString("latin1") === "%PDF-" && pdf.length > 200_000 && pdf.length < 20_000_000;
      if (!validPdf) addFinding({ reportId: r.id, kind: "print", detail: `invalid PDF (magic/size ${pdf.length} bytes)`, blocking: true });
      else console.log(`  print: valid PDF (${(pdf.length / 1e6).toFixed(1)} MB)`);

      // 4. Info parity (prod render vs local render, numeric SET semantics).
      if (!localOnly && prodPayload) {
        const prodRender = await captureRender(browser, `${PROD_BASE}/share/${r.share_token}`);
        writeFileSync(path.join(OUT_DIR, `render-prod-${r.id.slice(0, 8)}.json`), JSON.stringify(prodRender.slides, null, 2));
        writeFileSync(path.join(OUT_DIR, `render-local-${r.id.slice(0, 8)}.json`), JSON.stringify(localRender.slides, null, 2));
        const prodTokens = numericTokens(prodRender.slides.map((s) => s.text).join("\n"));
        const localAllText = localRender.slides.map((s) => s.text).join("\n");
        const localTokens = numericTokens(localAllText);
        const prodOnly = [...prodTokens].filter((t) => !localTokens.has(t));
        const unclassified: InfoClassification[] = [];
        const classCounts = new Map<string, number>();
        for (const tok of prodOnly) {
          const c = classifyProdOnlyToken(tok, prodRender.slides, localAllText, prodPayload);
          if (c.cls) classCounts.set(c.cls, (classCounts.get(c.cls) ?? 0) + 1);
          else unclassified.push(c);
        }
        console.log(`  info: ${prodOnly.length} prod-only numeric tokens; classes: ${[...classCounts.entries()].map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`);
        for (const u of unclassified) {
          addFinding({ reportId: r.id, kind: "info", detail: `prod-only token "${u.token}" (slides: ${u.context}) — no §4 class matched; classify or treat as regression`, blocking: true });
        }
        writeFileSync(
          path.join(OUT_DIR, `info-diff-${r.id.slice(0, 8)}.json`),
          JSON.stringify({ prodOnly, classes: Object.fromEntries(classCounts), unclassified }, null, 2),
        );
      }
    }

    // Pulse smoke.
    if (!skipPulses) console.log(`\n── NoBull Brief share links (${pulses.length})`);
    for (const p of skipPulses ? [] : pulses) {
      for (const [envName, base] of localOnly ? ([["local", LOCAL_BASE]] as const) : ([["prod", PROD_BASE], ["local", LOCAL_BASE]] as const)) {
        const api = await fetchJson(`${base}/api/ceo-pulse/share/${p.share_token}`);
        if (api.status !== 200) {
          addFinding({ reportId: p.id, kind: "pulse", detail: `${envName} pulse API ${api.status} (${p.month_key})`, blocking: true });
          continue;
        }
        const render = await captureRender(browser, `${base}/pulse/${p.share_token}`);
        const textLen = render.slides.map((s) => s.text).join("").length;
        const ok = render.pageErrors.length === 0 && !render.statePage;
        if (!ok) addFinding({ reportId: p.id, kind: "pulse", detail: `${envName} pulse render errors (${p.month_key}): ${render.pageErrors.join("; ")}`, blocking: true });
        else console.log(`  ${p.month_key} ${envName}: OK${textLen ? "" : " (non-slide layout)"}`);
      }
    }

    // Page-break regression check — once per invocation (offset-0 chunk only,
    // so chunked runs don't repeat it); local-only by nature (never hits prod).
    if (!skipPageBreak && offset === 0) {
      await checkSparseDeckPageBreaks(browser);
      await checkDenseDeckPageBreaks(browser);
    }
  } finally {
    await browser.close();
  }

  finishRun(offset);
}

function finishRun(offset: number): void {
  const blocking = findings.filter((f) => f.blocking);
  writeFileSync(path.join(OUT_DIR, `findings-${offset}.json`), JSON.stringify(findings, null, 2));
  console.log(`\n════════ REPORT SMOKE ════════`);
  console.log(`Findings: ${findings.length} (${blocking.length} blocking) — details in ${OUT_DIR}/`);
  if (blocking.length > 0) {
    console.log("VERDICT: BLOCK — classify each finding to a task-cited intended change or fix before Publish.");
    process.exit(1);
  }
  console.log("VERDICT: PASS — smoke slice clean on this build.");
  process.exit(0);
}

/**
 * Inverted verdict for --page-break-selftest: with their print contracts
 * sabotaged, BOTH checks — sparse (#4747, kind=page-break) and dense
 * (#4735, kind=page-break-dense) — MUST each have produced a blocking split
 * finding (the exact findings that make a real run exit 1). Split findings
 * present for both = the checks demonstrably block when their print rules
 * break → selftest PASS (exit 0). Either check missing a split finding =
 * that pipeline silently passed a known-broken print → selftest FAIL
 * (exit 1). Non-split blocking findings (render/PDF/liveness failures)
 * also FAIL — they mean that negative path never actually ran the detector.
 */
function finishPageBreakSelftest(): void {
  writeFileSync(path.join(OUT_DIR, `findings-selftest.json`), JSON.stringify(findings, null, 2));
  console.log(`\n════════ PAGE-BREAK SELFTEST ════════`);
  let failed = false;
  // Both checks must independently prove they block: sparse (#4747,
  // kind=page-break) and dense (#4735, kind=page-break-dense).
  for (const [label, kind] of [["sparse", "page-break"], ["dense", "page-break-dense"]] as const) {
    const blocking = findings.filter((f) => f.kind === kind && f.blocking);
    const splits = blocking.filter((f) => f.detail.includes("fragmented across page boundary"));
    const nonSplit = blocking.filter((f) => !f.detail.includes("fragmented across page boundary"));
    if (nonSplit.length > 0) {
      console.log(`${label}: FAIL — check errored before the detector could judge the sabotaged print:`);
      for (const f of nonSplit) console.log(`  - ${f.detail}`);
      failed = true;
    } else if (splits.length === 0) {
      console.log(
        `${label}: FAIL — break-inside contract was sabotaged but the ${label} page-break check reported NO split finding. ` +
          "The pipeline (marker CSS injection, pdftoppm rasterization, edge-strip detector) is blind; a real regression would pass silently.",
      );
      failed = true;
    } else {
      console.log(`${label}: PASS — sabotaged print produced ${splits.length} BLOCKING ${kind} split finding(s).`);
    }
  }
  if (failed) {
    console.log("VERDICT: FAIL — at least one page-break check did not demonstrably block on a sabotaged print.");
    process.exit(1);
  }
  console.log(
    "VERDICT: PASS — both sparse and dense sabotaged prints produced BLOCKING split findings; " +
      "a real run of this build+deck would exit 1. Both page-break checks demonstrably block when their print rules break.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[report-smoke-check] fatal:", err);
  process.exit(1);
});
