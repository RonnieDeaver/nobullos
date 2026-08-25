/**
 * Generate docs/brand/no-bull-brand-guidelines-v2.pdf from the Mockup
 * Sandbox brand-book route.
 *
 * Repeatable single command:
 *   npx tsx scripts/generate-brand-guidelines-pdf.ts
 *
 * What it does:
 *   1. Boots the sandbox Vite dev server on a free port (BASE_PATH=/),
 *      hitting the vite port directly (never the /__mockup proxy).
 *   2. Opens /preview/brand-book/BrandBook in headless Chromium (sRGB
 *      color profile so brand hexes reproduce exactly).
 *   3. Waits for every brand font face and every image to fully load —
 *      fails loudly if a font would fall back.
 *   4. Prints all sheets to a single landscape US-Letter PDF
 *      (11in × 8.5in pages, backgrounds on).
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import puppeteer from 'puppeteer';

const ROOT = path.resolve(import.meta.dirname, '..');
const SANDBOX_DIR = path.join(ROOT, 'artifacts', 'mockup-sandbox');
const OUT_PATH = path.join(ROOT, 'docs', 'brand', 'no-bull-brand-guidelines-v2.pdf');
const ROUTE = '/preview/brand-book/BrandBook';
const EXPECTED_PAGES = 22;

/** Font faces that MUST be real (never fallback) in the printed book. */
const REQUIRED_FONTS = [
  "200 13pt 'Crimson Pro'",
  "300 13pt 'Crimson Pro'",
  "400 13pt 'Crimson Pro'",
  "700 22pt 'Crimson Pro'",
  "800 13pt 'Crimson Pro'",
  "900 13pt 'Crimson Pro'",
  "400 10pt 'sweet-sans-pro'",
  "600 10pt 'sweet-sans-pro'",
  "italic 600 10pt 'sweet-sans-pro'",
  "700 10pt 'sweet-sans-pro'",
  "800 10pt 'sweet-sans-pro'",
  "900 10pt 'sweet-sans-pro'",
  "400 12pt 'Libre Baskerville'",
  "italic 400 12pt 'Libre Baskerville'",
  "700 12pt 'Libre Baskerville'",
  '400 12pt Arimo',
  '700 12pt Arimo',
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const p = address.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

async function main() {
  // Watchdog: fail loudly instead of hanging past the shell tool cap.
  const watchdog = setTimeout(() => {
    console.error('[pdf] WATCHDOG: still running after 240s, aborting');
    process.exit(2);
  }, 240_000);
  watchdog.unref();

  const port = await freePort();
  console.log(`[pdf] starting sandbox vite on port ${port}`);
  // detached => own process group, so we can kill npx AND the vite child it
  // spawns (a bare .kill() leaves vite orphaned and the script never exits).
  const vite = spawn('npx', ['vite'], {
    cwd: SANDBOX_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      BASE_PATH: '/',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stdout.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[vite] ${line}`);
  });
  vite.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.error(`[vite:err] ${line}`);
  });
  const viteExited = new Promise<void>((resolve) => {
    vite.on('exit', () => resolve());
  });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttp(base + '/', 60_000);

    const executablePath = execSync('which chromium').toString().trim();
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-proxy-server',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
      ],
    });
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[page:err] ${msg.text()}`);
    });
    page.on('requestfailed', (req) => {
      console.error(`[page:reqfail] ${req.url()} ${req.failure()?.errorText ?? ''}`);
    });

    console.log(`[pdf] loading ${base}${ROUTE}`);
    // 'load' + explicit font/image waits below — networkidle0 can starve on
    // Vite's HMR websocket + font preconnects.
    await page.goto(base + ROUTE, { waitUntil: 'load', timeout: 90_000 });

    // Sheets present?
    await page.waitForSelector('.bb-sheet', { timeout: 30_000 });
    const sheetCount = await page.evaluate(
      () => document.querySelectorAll('.bb-sheet').length,
    );
    if (sheetCount !== EXPECTED_PAGES) {
      throw new Error(`Expected ${EXPECTED_PAGES} sheets, found ${sheetCount}`);
    }

    // Load + verify every required font face. fonts.check() returns true
    // only when the face is actually available (not a fallback).
    const fontReport: Array<{ spec: string; ok: boolean }> = await page.evaluate(
      async (specs: string[]) => {
        await Promise.all(specs.map((s) => document.fonts.load(s, 'NoBull 0123')));
        await document.fonts.ready;
        return specs.map((spec) => ({ spec, ok: document.fonts.check(spec) }));
      },
      REQUIRED_FONTS,
    );
    const missing = fontReport.filter((f) => !f.ok);
    for (const f of fontReport) {
      console.log(`[fonts] ${f.ok ? 'OK  ' : 'MISS'} ${f.spec}`);
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing font faces (would print as fallback): ${missing
          .map((m) => m.spec)
          .join(', ')}`,
      );
    }

    // Every image finished decoding?
    const badImages: string[] = await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              }),
        ),
      );
      return imgs
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.src);
    });
    if (badImages.length > 0) {
      throw new Error(`Images failed to load: ${badImages.join(', ')}`);
    }

    // Give the renderer a beat to settle layout/paint after font swaps.
    await new Promise((r) => setTimeout(r, 500));

    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    console.log(`[pdf] printing ${EXPECTED_PAGES} pages -> ${OUT_PATH}`);
    await page.pdf({
      path: OUT_PATH,
      width: '11in',
      height: '8.5in',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: 120_000,
    });
    console.log('[pdf] done');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite.pid) {
      try {
        process.kill(-vite.pid, 'SIGTERM'); // whole process group
      } catch {
        vite.kill('SIGTERM');
      }
    }
    const killTimer = setTimeout(() => {
      if (vite.pid) {
        try {
          process.kill(-vite.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 5_000);
    await viteExited;
    clearTimeout(killTimer);
  }

  // Informational: page size + embedded fonts (Typekit names may be obfuscated).
  for (const cmd of [`pdfinfo ${JSON.stringify(OUT_PATH)}`, `pdffonts ${JSON.stringify(OUT_PATH)}`]) {
    try {
      console.log(`\n$ ${cmd}\n` + execSync(cmd).toString());
    } catch {
      console.log(`[pdf] (${cmd.split(' ')[0]} not available)`);
    }
  }
}

main()
  .then(() => {
    // Explicit exit: lingering child stdio/handles must not hang the script.
    process.exit(0);
  })
  .catch((err) => {
    console.error('[pdf] FAILED:', err);
    process.exit(1);
  });
