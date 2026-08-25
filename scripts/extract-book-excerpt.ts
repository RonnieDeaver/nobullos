// One-time content importer for the /free-chapters/ excerpt reader (Task #3920).
//
//   npx tsx scripts/extract-book-excerpt.ts
//
// Reads the owner-supplied manuscript DOCX (attached_assets/) and writes:
//   - website/content/book-excerpt.json        (Introduction + Chapters 1-2,
//     verbatim text with inline bold/italic preserved, as bodyHtml blocks)
//   - website/public/assets/book/figures/*.webp (the six branded diagrams the
//     excerpt references, compressed to web-appropriate derivatives — the
//     multi-MB originals stay in the DOCX only)
//
// The excerpt scope (Introduction + first two chapters, no email gate) was
// chosen by the owner. Everything between the chapter headings is imported
// verbatim IN ORDER — no summarising, no rewriting. The only exclusion is the
// manuscript's own back-matter CTA line at the very end of Chapter 2
// ("Schedule a High Impact Revenue Session today: https://nobullmarketing.com/talk")
// because that printed URL does not exist on this site; the reader page ends
// the excerpt at the preceding sentence and the page's own conversion endcap
// (Book a High Impact Revenue Session → homepage #booking) takes over. Documented in
// docs/website-claim-ledger.md §5.
//
// Heading levels are normalised for a consistent reader outline (the DOCX
// mixes ad-hoc font sizes): chapter titles are rendered by the page module;
// inside a chapter, big bold heads (≥28 half-pt = 14pt) → h3, short bold
// body-size standalone lines + Heading3 style → h4. Figures keep their
// in-text positions.
//
// Re-run only if the owner supplies a revised manuscript; output is committed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCX = path.join(
  ROOT,
  "attached_assets",
  "The_Law_Firm_Revenue_Engine_(7)_1786036148174.docx",
);
const OUT_JSON = path.join(ROOT, "website", "content", "book-excerpt.json");
const FIG_DIR = path.join(ROOT, "website", "public", "assets", "book", "figures");

// ---- figure manifest: media file in the DOCX -> committed derivative ----
const FIGURES: Record<string, { slug: string; alt: string }> = {
  "media/image6.png": {
    slug: "fig-million-dollar-gap",
    alt: "Diagram from the book: The Million Dollar Gap — two law firms with the same lead flow end up $1,000,000 apart in yearly revenue.",
  },
  "media/image7.png": {
    slug: "fig-revenue-engine",
    alt: "Diagram from the book: how the Law Firm Revenue Engine works — Marketing, Intake, and Sales running as one machine that turns leads into signed cases.",
  },
  "media/image5.png": {
    slug: "fig-casegen",
    alt: "Diagram from the book: the CaseGen system — Google Business Profile, paid search, and reviews feeding the firm's tank of qualified leads.",
  },
  "media/image2.png": {
    slug: "fig-expansion-play",
    alt: "Diagram from the book: the Expansion Play — the CaseGen growth turbocharger for expanding into new locations.",
  },
  "media/image1.png": {
    slug: "fig-caseintake",
    alt: "Diagram from the book: the CaseIntake system — hybrid call answering and automated follow-up that converts qualified leads into booked consultations.",
  },
  "media/image4.png": {
    slug: "fig-caseconvert",
    alt: "Diagram from the book: the CaseConvert system — consultation scripting, a great offer, and automated follow-up that converts consultations into signed cases.",
  },
};

interface Run {
  b: boolean;
  i: boolean;
  sz: number; // half-points; 0 = inherit (document default = body size)
  text: string;
}
interface Para {
  style: string;
  numId: string;
  jc: string;
  runs: Run[];
  text: string;
  imgs: string[]; // media/* paths
}

function parseParas(xml: string, relMap: Record<string, string>): Para[] {
  const paras: Para[] = [];
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(xml))) {
    const inner = pm[1] || "";
    const pPr = (inner.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || "";
    const style = (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
    const numId = (pPr.match(/<w:numId w:val="([^"]+)"/) || [])[1] || "";
    const jc = (pPr.match(/<w:jc w:val="([^"]+)"/) || [])[1] || "";
    const runs: Run[] = [];
    const imgs: string[] = [];
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm: RegExpExecArray | null;
    while ((rm = runRe.exec(inner))) {
      const rinner = rm[1];
      const rPr = (rinner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || "";
      const b =
        /<w:b(?: w:val="(?:true|1)")?\s*\/>/.test(rPr) &&
        !/<w:b w:val="(?:false|0)"\s*\/>/.test(rPr);
      const i =
        /<w:i(?: w:val="(?:true|1)")?\s*\/>/.test(rPr) &&
        !/<w:i w:val="(?:false|0)"\s*\/>/.test(rPr);
      const sz = parseInt((rPr.match(/<w:sz w:val="([^"]+)"/) || [])[1] || "0", 10);
      let text = "";
      for (const tm of rinner.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) text += tm[1];
      for (const em of rinner.matchAll(/r:embed="([^"]+)"/g)) {
        const target = relMap[em[1]];
        if (target) imgs.push(target.replace(/^\//, ""));
      }
      if (text || imgs.length) runs.push({ b, i, sz, text });
    }
    paras.push({
      style,
      numId,
      jc,
      runs,
      text: runs.map((r) => r.text).join(""),
      imgs,
    });
  }
  return paras;
}

// Decode the XML entities kept verbatim in run text (only for length/shape
// heuristics — emitted HTML keeps the escaped form, which is valid HTML).
function decoded(t: string): string {
  return t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function inlineHtml(runs: Run[]): string {
  // Merge adjacent runs with identical formatting, then wrap.
  const merged: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = merged[merged.length - 1];
    const sameAsPrev = prev && prev.b === r.b && prev.i === r.i;
    // Whitespace-only runs adopt the previous run's formatting so bold/italic
    // phrases split across runs don't produce broken tag pairs.
    if (prev && (sameAsPrev || !r.text.trim())) prev.text += r.text;
    else merged.push({ ...r });
  }
  return merged
    .map((r) => {
      let t = r.text;
      if (r.i) t = `<em>${t}</em>`;
      if (r.b) t = `<strong>${t}</strong>`;
      return t;
    })
    .join("");
}

function maxSize(p: Para): number {
  let m = 0;
  for (const r of p.runs) if (r.text.trim()) m = Math.max(m, r.sz || 24); // default body = 24 half-pt
  return m;
}
function allBold(p: Para): boolean {
  const tr = p.runs.filter((r) => r.text.trim());
  return tr.length > 0 && tr.every((r) => r.b);
}

interface FigureOut {
  slug: string;
  alt: string;
  width: number;
  height: number;
}

async function main(): Promise<void> {
  const zip = unzipSync(new Uint8Array(fs.readFileSync(DOCX)));
  const xml = Buffer.from(zip["word/document.xml"]).toString("utf8");
  const relsXml = Buffer.from(zip["word/_rels/document.xml.rels"]).toString("utf8");
  const relMap: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g))
    relMap[m[1]] = m[2];

  const paras = parseParas(xml, relMap);

  // ---- locate section boundaries (centered 20pt bold headings) ----
  const isTitle = (p: Para, text: RegExp) =>
    p.jc === "center" && maxSize(p) >= 40 && text.test(p.text.trim());
  const idxIntro = paras.findIndex((p) => isTitle(p, /^Introduction$/));
  const idxCh1 = paras.findIndex((p) => isTitle(p, /^Chapter 1:$/));
  const idxCh2 = paras.findIndex((p) => isTitle(p, /^Chapter 2:$/));
  const idxCh3 = paras.findIndex((p) => isTitle(p, /^Chapter 3:$/));
  if (idxIntro < 0 || idxCh1 < 0 || idxCh2 < 0 || idxCh3 < 0)
    throw new Error(`boundary headings not found: ${idxIntro}/${idxCh1}/${idxCh2}/${idxCh3}`);
  const ch1Title = paras[idxCh1 + 1].text.trim();
  const ch2Title = paras[idxCh2 + 1].text.trim();

  // Table of contents (plain "Chapter N: Title" lines before the Introduction)
  // supplies the real titles for the what-comes-next teaser.
  const tocTitles: Record<number, string> = {};
  for (let i = 0; i < idxIntro; i++) {
    const m = paras[i].text.trim().match(/^Chapter (\d+): (.+)$/);
    if (m && paras[i].jc !== "center") tocTitles[parseInt(m[1], 10)] = m[2].trim();
  }
  for (const n of [3, 4, 5])
    if (!tocTitles[n]) throw new Error(`ToC title for chapter ${n} not found`);

  // Chapter 2's tail: drop the manuscript's back-matter CTA line (printed URL
  // that does not exist on this site — see header comment) plus trailing blanks.
  let ch2End = idxCh3 - 1;
  while (
    ch2End > idxCh2 &&
    (!paras[ch2End].text.trim() ||
      /Schedule a High Impact Revenue Session/i.test(paras[ch2End].text))
  )
    ch2End--;

  // ---- figures: decode from the DOCX, emit compressed derivatives ----
  fs.mkdirSync(FIG_DIR, { recursive: true });
  const figOut: Record<string, FigureOut> = {};
  for (const [media, meta] of Object.entries(FIGURES)) {
    const bytes = zip[`word/${media}`];
    if (!bytes) throw new Error(`figure ${media} missing from DOCX`);
    const img = sharp(Buffer.from(bytes)).resize(1400, 1400, {
      fit: "inside",
      withoutEnlargement: true,
    });
    const outPath = path.join(FIG_DIR, `${meta.slug}.webp`);
    const info = await img.webp({ quality: 80 }).toFile(outPath);
    figOut[media] = { slug: meta.slug, alt: meta.alt, width: info.width, height: info.height };
    console.log(
      `figure ${meta.slug}.webp ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)}KB (from ${media}, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  // ---- paragraph -> HTML block classifier ----
  const blocks = (from: number, to: number): string[] => {
    const out: string[] = [];
    let listItems: string[] | null = null;
    const flushList = () => {
      if (listItems && listItems.length) {
        out.push(`<ol>\n${listItems.map((li) => `  <li>${li}</li>`).join("\n")}\n</ol>`);
      }
      listItems = null;
    };
    for (let i = from; i <= to; i++) {
      const p = paras[i];
      const txt = p.text.trim();
      if (!txt && !p.imgs.length) continue; // spacing paragraph

      if (p.imgs.length) {
        flushList();
        for (const media of p.imgs) {
          const fig = figOut[media];
          if (!fig) throw new Error(`unmapped figure ${media} at paragraph ${i}`);
          out.push(
            `<figure class="fc-figure"><img src="__R__assets/book/figures/${fig.slug}.webp" alt="${fig.alt.replace(/"/g, "&quot;")}" width="${fig.width}" height="${fig.height}" loading="lazy" decoding="async"></figure>`,
          );
        }
        if (!txt) continue;
      }

      if (p.numId) {
        if (!listItems) listItems = [];
        listItems.push(inlineHtml(p.runs));
        continue;
      }
      flushList();

      const sz = maxSize(p);
      const bold = allBold(p);
      const plain = decoded(txt);
      const inline = inlineHtml(p.runs);
      const bare = inline.replace(/<\/?(strong|em)>/g, ""); // headings carry their own weight

      if (/^The Case(Gen|Intake|Convert) System$/.test(plain)) {
        out.push(`<p class="fc-syssub">${bare}</p>`); // subtitle of its Core Component h3
      } else if (p.style === "Heading3") {
        out.push(`<h4>${bare}</h4>`);
      } else if (p.style === "Heading2" || sz >= 30 || (sz >= 28 && bold)) {
        out.push(`<h3>${bare}</h3>`);
      } else if (sz >= 28) {
        out.push(`<p class="fc-lede">${inline}</p>`); // emphasized transition line
      } else if (
        bold &&
        plain.length <= 48 &&
        !/[.!?…]$/.test(plain) &&
        !/^\d/.test(plain)
      ) {
        out.push(`<h4>${bare}</h4>`);
      } else {
        out.push(`<p>${inline}</p>`);
      }
    }
    flushList();
    return out;
  };

  const chapters = [
    {
      id: "introduction",
      kicker: "Introduction",
      title: "Introduction",
      nav: "Introduction",
      bodyHtml: blocks(idxIntro + 1, idxCh1 - 1).join("\n"),
    },
    {
      id: "chapter-1",
      kicker: "Chapter One",
      title: ch1Title,
      nav: `Chapter 1 · ${ch1Title}`,
      bodyHtml: blocks(idxCh1 + 2, idxCh2 - 1).join("\n"),
    },
    {
      id: "chapter-2",
      kicker: "Chapter Two",
      title: ch2Title,
      nav: `Chapter 2 · ${ch2Title}`,
      bodyHtml: blocks(idxCh2 + 2, ch2End).join("\n"),
    },
  ];

  const json = {
    source:
      "attached_assets/The_Law_Firm_Revenue_Engine_(7)_1786036148174.docx — imported verbatim by scripts/extract-book-excerpt.ts (Task #3920). Do not hand-edit chapter text here; re-run the importer against a revised manuscript instead.",
    bookTitle: "The Law Firm Revenue Engine",
    author: "Ronnie Deaver",
    chapters,
    whatsNext: [
      { n: 3, title: tocTitles[3] },
      { n: 4, title: tocTitles[4] },
      { n: 5, title: tocTitles[5] },
    ],
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(json, null, 1) + "\n");

  for (const c of chapters) {
    const h3s = (c.bodyHtml.match(/<h3>/g) || []).length;
    const h4s = (c.bodyHtml.match(/<h4>/g) || []).length;
    const ps = (c.bodyHtml.match(/<p[ >]/g) || []).length;
    const figs = (c.bodyHtml.match(/<figure/g) || []).length;
    const words = decoded(c.bodyHtml.replace(/<[^>]+>/g, " "))
      .split(/\s+/)
      .filter(Boolean).length;
    console.log(
      `${c.id}: "${c.title}" — ${words} words, ${ps} paragraphs, ${h3s} h3, ${h4s} h4, ${figs} figures`,
    );
  }
  console.log(`wrote ${path.relative(ROOT, OUT_JSON)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
