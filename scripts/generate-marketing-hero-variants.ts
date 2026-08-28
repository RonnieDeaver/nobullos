// Generates the lightweight WebP derivatives of the redesigned homepage's
// hero art (Task #3795 mobile hardening) AND the heaviest shared-chrome
// subpage uploads (Task #3800 — manifest lives in website/src/html.ts as
// UPLOAD_MOBILE_VARIANTS, the same module whose uploadImg()/upgradeBodyImages()
// emit the <picture> swaps). Sources are the approved art and stay untouched;
// viewports ≤850px are served these compressed WebP variants instead
// (CSS background swap for the machinery, <picture> sources everywhere else).
//
//   npx tsx scripts/generate-marketing-hero-variants.ts
//
// Derivatives are DERIVED from the same approved art — never redrawn.
// Re-run whenever a source changes; output is committed alongside it.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { UPLOAD_MOBILE_VARIANTS, UPLOAD_ALLWIDTH_VARIANTS } from "../website/src/html";

const WEBSITE_PUBLIC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "website",
  "public",
);
const BRAND_DIR = path.join(WEBSITE_PUBLIC, "nobull-redesign", "brand");
const UPLOADS_DIR = path.join(WEBSITE_PUBLIC, "assets", "uploads");

interface Variant {
  source: string;
  out: string;
  /** Resize target; omitted = keep source resolution, re-encode only. */
  width?: number;
  quality: number;
}

// The machinery backdrop covers up to ~850 CSS px on the widths that load it
// (its 1024px source already caps DPR≥2 rendering), so it keeps full
// resolution and only changes encoding. The book cover renders at ≤300 CSS px
// on phones, so 640px covers DPR 2 with margin.
const VARIANTS: Variant[] = [
  {
    source: "machinery-hero.png",
    out: "machinery-hero-mobile.webp",
    quality: 72,
  },
  {
    source: "front-cover.jpg",
    out: "law-firm-revenue-engine-cover-mobile.webp",
    width: 640,
    quality: 80,
  },
  // Desktop full-resolution WebP re-encodes (Task #4127, WEBSITE.md F-06):
  // same approved art, visually lossless quality, served to >850px viewports
  // in place of the multi-MB source files. The standalone front-cover.jpg
  // export stays committed byte-for-byte as the cover's canonical source and
  // <img> fallback; print-wrap proofs are reference-only and never enter this
  // derivative manifest.
  {
    source: "machinery-hero.png",
    out: "machinery-hero.webp",
    quality: 90,
  },
  {
    source: "front-cover.jpg",
    out: "law-firm-revenue-engine-cover.webp",
    quality: 90,
  },
];

async function generate(dir: string, v: Variant): Promise<void> {
  const src = path.join(dir, v.source);
  const dst = path.join(dir, v.out);
  let img = sharp(src);
  if (v.width) img = img.resize({ width: v.width, withoutEnlargement: true });
  await img.webp({ quality: v.quality }).toFile(dst);
  const before = fs.statSync(src).size;
  const after = fs.statSync(dst).size;
  console.log(
    `${v.out}: ${(after / 1024).toFixed(0)}KB (source ${(before / 1024).toFixed(0)}KB)`,
  );
}

// Sitewide default og:image/twitter:image (SEO/OG audit): a single ~1200x630
// landscape crop of the approved homepage machinery hero art, replacing the
// old WordPress background image every page used to share
// (website/src/html.ts DEFAULT_OG_IMAGE). Cropped/re-encoded only from the
// same 1024x1024 approved source — never new or AI-generated imagery. JPEG
// (not WebP) for broad link-unfurl scraper compatibility.
const OG_SOCIAL_IMAGE = {
  source: "machinery-hero.png",
  out: "og-social-default.jpg",
  width: 1200,
  height: 630,
};

async function generateOgSocialImage(dir: string): Promise<void> {
  const src = path.join(dir, OG_SOCIAL_IMAGE.source);
  const dst = path.join(dir, OG_SOCIAL_IMAGE.out);
  await sharp(src)
    .resize({
      width: OG_SOCIAL_IMAGE.width,
      height: OG_SOCIAL_IMAGE.height,
      fit: "cover",
      position: "centre",
    })
    .jpeg({ quality: 85 })
    .toFile(dst);
  const after = fs.statSync(dst).size;
  console.log(
    `${OG_SOCIAL_IMAGE.out}: ${(after / 1024).toFixed(0)}KB (${OG_SOCIAL_IMAGE.width}x${OG_SOCIAL_IMAGE.height} crop of ${OG_SOCIAL_IMAGE.source})`,
  );
}

async function main(): Promise<void> {
  for (const v of VARIANTS) await generate(BRAND_DIR, v);
  for (const v of UPLOAD_MOBILE_VARIANTS) await generate(UPLOADS_DIR, v);
  for (const v of UPLOAD_ALLWIDTH_VARIANTS) await generate(UPLOADS_DIR, v);
  await generateOgSocialImage(BRAND_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
