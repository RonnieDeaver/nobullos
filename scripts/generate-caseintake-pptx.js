#!/usr/bin/env node
// CaseIntake Sales Deck — 22 Slides → editable PowerPoint (.pptx)
// Recreates scripts/generate-caseintake-slides.js as native, editable PptxGenJS
// shapes + text boxes (live/editable copy) with the same layout & branding.
// Brand: cream #EDE8DC, burgundy #8B292F, gold #B08D57, charcoal #524B3A
// Fonts: Crimson Pro (serif headlines) + Montserrat (sans body)

import PptxGenJS from 'pptxgenjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'slide-output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'caseintake-sales-deck.pptx');

// ─── COLORS ───────────────────────────────────────────────────────────────────
const CREAM = 'EDE8DC';
const CREAM_CARD = 'F3EEE5';
const CREAM_INSET = 'E8E2D8';
const BURGUNDY = '8B292F';
const BURGUNDY_MID = 'A84B51';
const BURGUNDY_ORANGE = 'C07C42';
const GOLD = 'B08D57';
const GOLD_LIGHT = 'D4AF6A';
const CHARCOAL = '524B3A';
const INK = '1F1F1F';
const GRAY = '595959';
const WHITE = 'FFFFFF';
const HEADER_TEXT = 'F3EEE5';
const BORDER = 'D8CBB0';       // approximates rgba(176,141,87,0.2) on cream
const BORDER_STRONG = 'C9B48C';

const SERIF = 'Crimson Pro';
const SANS = 'Montserrat';

// ─── GEOMETRY (1920x1080 px source → 13.333 x 7.5 in canvas) ───────────────────
const IN_W = 13.333;
const IN_H = 7.5;
const K = IN_W / 1920;         // px → inches (same for x and y)
const X = (px) => +(px * K).toFixed(3);
const Y = (px) => +(px * K).toFixed(3);
const F = (px) => +(px * 0.5).toFixed(1); // px → points (960pt / 1920px)

const RIGHT = 1840;            // content right edge px (80px margin)

// ─── PRIMITIVES ────────────────────────────────────────────────────────────────
function T(slide, text, o) {
  slide.addText(text, {
    x: X(o.x), y: Y(o.y), w: X(o.w), h: Y(o.h),
    fontFace: o.font || SANS,
    fontSize: F(o.size || 19),
    bold: !!o.bold,
    italic: !!o.italic,
    color: o.color || CHARCOAL,
    align: o.align || 'left',
    valign: o.valign || 'top',
    charSpacing: o.cs,
    lineSpacingMultiple: o.lh,
    strike: o.strike || false,
    margin: o.margin !== undefined ? o.margin : 0,
    wrap: o.wrap !== undefined ? o.wrap : true,
  });
}

function rrect(slide, o) {
  const line = o.line === false
    ? { type: 'none' }
    : { color: o.lineColor || BORDER, width: o.lw || 1 };
  slide.addShape('roundRect', {
    x: X(o.x), y: Y(o.y), w: X(o.w), h: Y(o.h),
    rectRadius: X(o.r !== undefined ? o.r : 12),
    fill: o.fill === false ? { type: 'none' } : { color: o.fill || CREAM_CARD },
    line,
    shadow: o.shadow ? { type: 'outer', color: '000000', opacity: 0.25, blur: 12, offset: 6, angle: 90 } : undefined,
  });
}

function rect(slide, o) {
  slide.addShape('rect', {
    x: X(o.x), y: Y(o.y), w: X(o.w), h: Y(o.h),
    fill: o.fill === false ? { type: 'none' } : { color: o.fill },
    line: o.line || { type: 'none' },
  });
}

function line(slide, o) {
  slide.addShape('line', {
    x: X(o.x), y: Y(o.y), w: X(o.w), h: Y(o.h || 0),
    line: { color: o.color || GOLD, width: o.width || 1, dashType: o.dash },
  });
}

function goldDivider(slide, x, y, w = 120) {
  slide.addShape('roundRect', {
    x: X(x), y: Y(y), w: X(w), h: Y(3),
    rectRadius: X(2), fill: { color: GOLD }, line: { type: 'none' },
  });
}

function ellipse(slide, o) {
  slide.addShape('ellipse', {
    x: X(o.x), y: Y(o.y), w: X(o.d), h: Y(o.d),
    fill: { color: o.fill }, line: { type: 'none' },
  });
}

function numCircle(slide, x, y, d, num, fill = BURGUNDY, fontSize = 16) {
  ellipse(slide, { x, y, d, fill });
  T(slide, num, {
    x, y: y - 1, w: d, h: d, size: fontSize, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
  });
}

function checkCircle(slide, x, y, d, fill = GOLD) {
  ellipse(slide, { x, y, d, fill });
  T(slide, '✓', {
    x, y: y - 1, w: d, h: d, size: d * 0.5, bold: true, color: WHITE,
    align: 'center', valign: 'middle',
  });
}

function eyebrow(slide, text, x, y, color = GOLD, w = 900) {
  T(slide, text.toUpperCase(), {
    x, y, w, h: 24, size: 14, bold: true, color, cs: 1.4, valign: 'middle',
  });
}

function bottomLine(slide, text, y, opts = {}) {
  const { border = false, align = 'left', size = 16, w = 1760, x = 80 } = opts;
  if (border) line(slide, { x, y: y - 16, w, color: BORDER, width: 1 });
  T(slide, text, {
    x, y, w, h: 40, size, bold: true, italic: true, color: BURGUNDY, align,
  });
}

// ─── BASE SLIDE (header + footer chrome) ────────────────────────────────────────
function baseSlide(pptx, slideNum, total = 22) {
  const slide = pptx.addSlide();
  slide.background = { color: CREAM };

  // Header bar
  rect(slide, { x: 0, y: 0, w: 1920, h: 64, fill: BURGUNDY });
  T(slide, 'The CaseIntake System™', {
    x: 56, y: 0, w: 900, h: 64, size: 17, bold: true, color: HEADER_TEXT,
    cs: 1, valign: 'middle',
  });
  T(slide, 'NOBULL MARKETING', {
    x: RIGHT - 700, y: 0, w: 644, h: 64, size: 15, bold: true, color: GOLD,
    cs: 1.5, align: 'right', valign: 'middle',
  });

  // Footer
  line(slide, { x: 56, y: 1032, w: 1808, color: GOLD, width: 1 });
  T(slide, 'NOBULLMARKETING.COM', {
    x: 56, y: 1032, w: 600, h: 48, size: 13, bold: true, color: BURGUNDY,
    cs: 1, valign: 'middle',
  });
  T(slide, `${String(slideNum).padStart(2, '0')} / ${total}`, {
    x: RIGHT - 300, y: 1032, w: 300, h: 48, size: 13, color: BURGUNDY,
    align: 'right', valign: 'middle',
  });

  return slide;
}

// Reusable numbered card (num circle + title + desc), flex-start layout
function numDescCard(slide, o) {
  rrect(slide, { x: o.x, y: o.y, w: o.w, h: o.h, r: 10 });
  const d = o.circleD || 46;
  numCircle(slide, o.x + 24, o.y + 22, d, o.num, o.numFill || BURGUNDY, o.numSize || 15);
  const tx = o.x + 24 + d + 16;
  const tw = o.x + o.w - tx - 20;
  T(slide, o.title, {
    x: tx, y: o.y + 20, w: tw, h: 40, size: o.titleSize || 16, bold: true, color: INK, lh: 1.05,
  });
  T(slide, o.desc, {
    x: tx, y: o.y + 20 + (o.titleGap || 30), w: tw, h: o.h - 60, size: o.descSize || 14,
    color: CHARCOAL, lh: 1.4,
  });
}

// ─── DECK ────────────────────────────────────────────────────────────────────
function build(pptx) {
  pptx.defineLayout({ name: 'CI', width: IN_W, height: IN_H });
  pptx.layout = 'CI';
  pptx.author = 'NoBull Marketing';
  pptx.company = 'NoBull Marketing';
  pptx.subject = 'The CaseIntake System';
  pptx.title = 'CaseIntake Sales Deck';

  // ── SLIDE 01 — Before We Get Started ─────────────────────────────────────────
  {
    const s = baseSlide(pptx, 1);
    T(s, 'Before We\nGet Started', {
      x: 80, y: 120, w: 800, h: 240, font: SERIF, size: 72, bold: true, color: BURGUNDY, lh: 1.05,
    });
    goldDivider(s, 80, 380, 160);
    T(s, "A quick look at what we'll cover together in the next few minutes.", {
      x: 80, y: 420, w: 620, h: 120, size: 20, color: CHARCOAL, lh: 1.4,
    });
    eyebrow(s, "Today we'll cover:", 1010, 150, BURGUNDY, 700);
    const items = [
      'Why most firms leak revenue after the lead comes in',
      'The 6 silent intake leaks that keep good leads from booking consults',
      'How CaseIntake™ turns intake into a repeatable operating system',
      'How implementation works',
      'Whether this is the right next step for your firm',
    ];
    items.forEach((it, i) => {
      const y = 210 + i * 96;
      checkCircle(s, 1010, y, 36);
      T(s, it, { x: 1066, y: y - 4, w: 700, h: 90, size: 20, color: INK, lh: 1.35 });
    });
  }

  // ── SLIDE 02 — The Opportunity ────────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 2);
    eyebrow(s, 'The Opportunity', 80, 120);
    T(s, 'The Cheapest Growth Is Usually Already in Your Lead Flow', {
      x: 80, y: 150, w: 980, h: 190, font: SERIF, size: 52, bold: true, color: INK, lh: 1.08,
    });
    goldDivider(s, 80, 360, 120);
    T(s, 'You do not always need more leads. Sometimes you need to capture more of the leads you already paid for.', {
      x: 80, y: 400, w: 980, h: 110, size: 20, color: CHARCOAL, lh: 1.45,
    });
    rrect(s, { x: 80, y: 540, w: 980, h: 150, r: 12, lineColor: BORDER });
    s.addText([
      { text: 'Every missed call, slow follow-up, weak script, no-show, or extra step turns ', options: { color: CHARCOAL, bold: false } },
      { text: 'paid opportunity into waste.', options: { color: BURGUNDY, bold: true } },
    ], {
      x: X(112), y: Y(560), w: X(916), h: Y(110), fontFace: SANS, fontSize: F(18),
      valign: 'middle', lineSpacingMultiple: 1.45, margin: 0,
    });
    // Leaky funnel (right)
    const tiers = [
      { label: 'LEADS', sub: 'You paid for these', w: 340, bg: BURGUNDY },
      { label: 'CONSULTS', sub: 'Fewer make it here', w: 260, bg: BURGUNDY_MID },
      { label: 'CLIENTS', sub: 'Even fewer here', w: 190, bg: BURGUNDY_ORANGE },
    ];
    const cx = 1440;
    let ty = 200;
    tiers.forEach((t, i) => {
      const h = i === 0 ? 90 : i === 1 ? 82 : 74;
      rrect(s, { x: cx - t.w / 2, y: ty, w: t.w, h, r: 8, fill: t.bg, line: false });
      T(s, t.label, { x: cx - t.w / 2, y: ty + 14, w: t.w, h: 34, size: 20, bold: true, color: WHITE, align: 'center', cs: 1 });
      T(s, t.sub, { x: cx - t.w / 2, y: ty + 48, w: t.w, h: 24, size: 13, color: 'F0D9DB', align: 'center' });
      if (i < 2) {
        T(s, 'LEAKS 💧', { x: cx + t.w / 2 + 8, y: ty + h / 2 - 16, w: 160, h: 40, size: 12, bold: true, color: GOLD, valign: 'middle' });
        line(s, { x: cx, y: ty + h + 4, w: 0, h: 24, color: GOLD, width: 2, dash: 'dash' });
        ty += h + 32;
      }
    });
  }

  // ── SLIDE 03 — Revenue Engine Context ─────────────────────────────────────────
  {
    const s = baseSlide(pptx, 3);
    eyebrow(s, 'The Law Firm Revenue Engine', 80, 116);
    s.addText([
      { text: 'CaseGen Creates the Opportunity. ', options: { color: INK } },
      { text: 'CaseIntake Captures It. ', options: { color: BURGUNDY } },
      { text: 'CaseConvert Turns It Into Revenue.', options: { color: INK } },
    ], {
      x: X(80), y: Y(148), w: X(1500), h: Y(150), fontFace: SERIF, fontSize: F(46),
      bold: true, lineSpacingMultiple: 1.12, valign: 'top', margin: 0,
    });
    goldDivider(s, 80, 320, 120);
    const cardY = 380, cardH = 500;
    const cards = [
      { title: 'CaseGen™', body: 'Generates more leads and reputation for your firm.', tag: 'Lead Generation', hl: false },
      { title: 'CaseIntake™', body: 'Turns more leads into booked consults.', tag: "← TODAY'S FOCUS →", hl: true },
      { title: 'CaseConvert™', body: 'Turns more consults into signed clients.', tag: 'Conversion', hl: false },
    ];
    // widths: middle wider
    const gap = 36, totalW = 1760;
    const unit = (totalW - 2 * gap) / 3.15;
    const ws = [unit, unit * 1.15, unit];
    let x = 80;
    cards.forEach((c) => {
      const w = ws.shift();
      if (c.hl) {
        rrect(s, { x, y: cardY, w, h: cardH, r: 14, fill: BURGUNDY, lineColor: GOLD, lw: 3, shadow: true });
        T(s, c.title, { x: x + 32, y: cardY + 36, w: w - 64, h: 60, font: SERIF, size: 42, bold: true, color: WHITE });
        goldDivider(s, x + 32, cardY + 108, 80);
        T(s, c.body, { x: x + 32, y: cardY + 150, w: w - 64, h: 200, size: 21, bold: true, color: HEADER_TEXT, lh: 1.5 });
        T(s, c.tag, { x: x + 32, y: cardY + cardH - 60, w: w - 64, h: 40, size: 13, bold: true, color: GOLD, cs: 1, valign: 'middle' });
      } else {
        rrect(s, { x, y: cardY, w, h: cardH, r: 14, fill: CREAM_CARD, lineColor: BORDER });
        T(s, c.title, { x: x + 32, y: cardY + 36, w: w - 64, h: 56, font: SERIF, size: 38, bold: true, color: CHARCOAL });
        goldDivider(s, x + 32, cardY + 104, 60);
        T(s, c.body, { x: x + 32, y: cardY + 140, w: w - 64, h: 200, size: 19, color: CHARCOAL, lh: 1.5 });
        T(s, c.tag, { x: x + 32, y: cardY + cardH - 60, w: w - 64, h: 40, size: 13, bold: true, color: BURGUNDY, cs: 1, valign: 'middle' });
      }
      x += w + gap;
    });
    bottomLine(s, "Today, we're focused on the part of the engine where most firms quietly lose the leads they already paid for.", 916, { border: true, size: 16 });
  }

  // ── SLIDE 04 — You Already Paid for the Lead ──────────────────────────────────
  {
    const s = baseSlide(pptx, 4);
    eyebrow(s, 'The Real Problem', 80, 120);
    T(s, 'You Already Paid for the Lead', {
      x: 80, y: 150, w: 1760, h: 90, font: SERIF, size: 64, bold: true, color: BURGUNDY,
    });
    T(s, 'The question is whether your intake system turns that lead into a booked consult — or lets it leak out.', {
      x: 80, y: 250, w: 1760, h: 60, size: 20, color: CHARCOAL, lh: 1.4,
    });
    const cY = 350, cH = 560;
    // Left card
    rrect(s, { x: 80, y: cY, w: 780, h: cH, r: 14, lineColor: BORDER_STRONG, lw: 2 });
    T(s, 'WHAT FIRMS THINK IS HAPPENING', { x: 120, y: cY + 40, w: 700, h: 30, size: 13, bold: true, color: GRAY, cs: 1 });
    T(s, '"We need\nmore leads."', { x: 120, y: cY + 100, w: 700, h: 200, font: SERIF, size: 42, bold: true, color: CHARCOAL, lh: 1.2 });
    rrect(s, { x: 120, y: cY + cH - 130, w: 700, h: 90, r: 8, fill: CREAM_INSET, line: false });
    rect(s, { x: 120, y: cY + cH - 130, w: 6, h: 90, fill: GRAY });
    T(s, 'The default assumption — spend more, get more.', { x: 148, y: cY + cH - 130, w: 660, h: 90, size: 16, color: GRAY, valign: 'middle' });
    // Arrow
    T(s, '→', { x: 880, y: cY, w: 160, h: cH, size: 48, color: GOLD, align: 'center', valign: 'middle' });
    // Right card
    rrect(s, { x: 1060, y: cY, w: 780, h: cH, r: 14, fill: BURGUNDY, line: false, shadow: true });
    T(s, 'WHAT IS OFTEN HAPPENING', { x: 1100, y: cY + 40, w: 700, h: 30, size: 13, bold: true, color: GOLD, cs: 1 });
    T(s, 'Good leads are being\nmissed, delayed,\nmishandled,\nor left unfollowed.', { x: 1100, y: cY + 100, w: 700, h: 260, font: SERIF, size: 36, bold: true, color: WHITE, lh: 1.25 });
    rrect(s, { x: 1100, y: cY + cH - 130, w: 700, h: 90, r: 8, fill: '9A3A40', line: false });
    rect(s, { x: 1100, y: cY + cH - 130, w: 6, h: 90, fill: GOLD });
    T(s, 'CaseIntake protects your marketing investment.', { x: 1128, y: cY + cH - 130, w: 660, h: 90, size: 16, bold: true, color: HEADER_TEXT, valign: 'middle' });
  }

  // ── SLIDE 05 — The 6 Silent Intake Leaks ──────────────────────────────────────
  {
    const s = baseSlide(pptx, 5);
    eyebrow(s, 'The Problem', 80, 112);
    T(s, 'The 6 Silent Intake Leaks', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 54, bold: true, color: INK });
    T(s, 'Most firms do not lose leads all at once. They lose them one friction point at a time.', {
      x: 80, y: 232, w: 1760, h: 50, size: 19, color: CHARCOAL, lh: 1.4,
    });
    const leaks = [
      ['01', 'Missed Calls', 'High-intent leads call once, hit voicemail, and move on.'],
      ['02', 'Slow Speed to Lead', 'The lead was interested when they reached out. Later, they may already be talking to someone else.'],
      ['03', 'Intake Staff Winging It', 'Good people, bad system. No consistent script, qualification path, consult offer, or next step.'],
      ['04', 'Poor Consult Offer', 'The prospect does not understand why the consult is valuable enough to book or attend.'],
      ['05', 'Little to No Follow-Up', 'Unbooked leads, no-shows, and undecided prospects disappear.'],
      ['06', 'Friction Everywhere', 'Hard to schedule. Hard to meet. Hard to sign. Hard to pay. Too many steps.'],
    ];
    const startY = 300, cardH = 176, gap = 16, cardW = (1760 - gap) / 2;
    leaks.forEach(([num, title, desc], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 80 + col * (cardW + gap);
      const y = startY + row * (cardH + gap);
      numDescCard(s, { x, y, w: cardW, h: cardH, num, title, desc, titleSize: 17, descSize: 15, titleGap: 32 });
    });
    bottomLine(s, 'If even one leak is happening consistently, revenue is slipping through intake.', 942, { size: 16 });
  }

  // ── SLIDE 06 — Where Is Your Intake Leaking? ──────────────────────────────────
  {
    const s = baseSlide(pptx, 6);
    eyebrow(s, 'Self-Diagnosis', 80, 120);
    T(s, 'Where Is Your Intake Leaking?', { x: 80, y: 150, w: 1760, h: 90, font: SERIF, size: 60, bold: true, color: BURGUNDY });
    goldDivider(s, 80, 260, 140);
    const qs = [
      'Are calls ever missed during business hours?',
      'Are form leads contacted immediately?',
      'Does every intake person follow the same script?',
      'Is your consultation clearly positioned as valuable?',
      'Do unbooked leads and no-shows get consistent follow-up?',
      'Is it easy for prospects to schedule, meet, sign, and pay?',
    ];
    const startY = 320, cardH = 120, gap = 20, colGap = 80, cardW = (1760 - colGap) / 2;
    qs.forEach((q, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 80 + col * (cardW + colGap);
      const y = startY + row * (cardH + gap);
      rrect(s, { x, y, w: cardW, h: cardH, r: 10, lineColor: BORDER });
      // checkbox square
      slideRoundBox(s, x + 24, y + (cardH - 32) / 2, 32);
      T(s, q, { x: x + 76, y, w: cardW - 100, h: cardH, size: 20, color: INK, lh: 1.35, valign: 'middle' });
    });
    bottomLine(s, 'If even one leak is happening consistently, revenue is slipping through intake.', 942, { border: true, size: 16 });
  }

  // ── SLIDE 07 — What These Leaks Cost You ──────────────────────────────────────
  {
    const s = baseSlide(pptx, 7);
    eyebrow(s, 'The ROI Case', 80, 112);
    T(s, 'A Small Intake Lift Can Pay for the Whole System', { x: 80, y: 142, w: 1760, h: 90, font: SERIF, size: 52, bold: true, color: INK, lh: 1.08 });
    goldDivider(s, 80, 250, 120);
    const rows = [
      ['300', 'leads / month', CHARCOAL, false],
      ['25% → 75', 'Current lead-to-consult = 75 consults', CHARCOAL, false],
      ['35% → 105', 'Improved lead-to-consult = 105 consults', BURGUNDY, true],
      ['+30', 'additional consults / month', BURGUNDY, true],
    ];
    const leftW = 980, rowH = 96, rowGap = 14, ry0 = 320;
    rows.forEach(([big, label, col, hl], i) => {
      const y = ry0 + i * (rowH + rowGap);
      rrect(s, { x: 80, y, w: leftW, h: rowH, r: 10, lineColor: hl ? BURGUNDY : BORDER, lw: hl ? 1.5 : 1 });
      T(s, big, { x: 104, y, w: 300, h: rowH, font: SERIF, size: 42, bold: true, color: col, valign: 'middle' });
      T(s, label, { x: 420, y, w: leftW - 340, h: rowH, size: 18, color: CHARCOAL, valign: 'middle' });
    });
    // Right result boxes
    const rx = 1100, rw = 740;
    rrect(s, { x: rx, y: 320, w: rw, h: 190, r: 10, lineColor: BORDER });
    eyebrow(s, 'If 30% become clients', rx + 24, 340, GOLD, rw - 48);
    T(s, '+9 clients', { x: rx + 24, y: 372, w: rw - 48, h: 90, font: SERIF, size: 52, bold: true, color: BURGUNDY });
    T(s, 'per month', { x: rx + 24, y: 462, w: rw - 48, h: 36, size: 17, color: CHARCOAL });
    rrect(s, { x: rx, y: 524, w: rw, h: 236, r: 10, fill: BURGUNDY, line: false });
    eyebrow(s, 'At $8,000 avg case value', rx + 24, 550, GOLD, rw - 48);
    T(s, '$72,000', { x: rx + 24, y: 588, w: rw - 48, h: 100, font: SERIF, size: 60, bold: true, color: WHITE });
    T(s, 'per month in added revenue', { x: rx + 24, y: 692, w: rw - 48, h: 40, size: 18, color: HEADER_TEXT });
    T(s, 'Example only. Actual results depend on lead volume, consult rate, close rate, and average case value.', {
      x: 80, y: 800, w: 1760, h: 30, size: 12, italic: true, color: GRAY,
    });
    bottomLine(s, 'Fixing intake can create growth without buying more leads.', 850, { size: 15 });
  }

  // ── SLIDE 08 — Introducing The CaseIntake System™ ─────────────────────────────
  {
    const s = baseSlide(pptx, 8);
    eyebrow(s, 'The Solution', 80, 120, GOLD, 1760);
    T(s, 'Introducing The CaseIntake System™', {
      x: 410, y: 150, w: 1100, h: 90, font: SERIF, size: 64, bold: true, color: BURGUNDY, align: 'center',
    });
    goldDivider(s, (1920 - 120) / 2, 268, 120);
    T(s, 'A lead-to-consult operating system built specifically for law firms.', {
      x: 560, y: 300, w: 800, h: 50, size: 21, color: CHARCOAL, align: 'center', lh: 1.4,
    });
    const cols = [
      ['Answer Faster', 'Reduce missed and delayed response — capture every lead at the moment they reach out.', '📞'],
      ['Book Better', 'Improve qualification, scripting, and consult positioning so more leads say yes.', '📅'],
      ['Follow Up Relentlessly', 'Automate reminders, no-show recovery, and long-term nurture so no lead disappears.', '🔄'],
    ];
    const cY = 400, cH = 470, gap = 36, cardW = (1760 - 2 * gap) / 3;
    cols.forEach(([title, desc, icon], i) => {
      const x = 80 + i * (cardW + gap);
      rrect(s, { x, y: cY, w: cardW, h: cH, r: 14, lineColor: BORDER });
      T(s, icon, { x, y: cY + 40, w: cardW, h: 60, size: 40, align: 'center' });
      goldDivider(s, x + (cardW - 56) / 2, cY + 120, 56);
      T(s, title, { x: x + 24, y: cY + 150, w: cardW - 48, h: 60, font: SERIF, size: 36, bold: true, color: BURGUNDY, align: 'center' });
      T(s, desc, { x: x + 30, y: cY + 230, w: cardW - 60, h: 200, size: 18, color: CHARCOAL, align: 'center', lh: 1.5 });
    });
    bottomLine(s, 'CaseIntake turns intake from "who remembered to follow up?" into a system.', 916, { align: 'center', size: 16 });
  }

  // ── SLIDE 09 — The CaseIntake Operating System (7-step pipeline) ──────────────
  {
    const s = baseSlide(pptx, 9);
    eyebrow(s, 'The Operating System', 80, 112);
    T(s, 'Every Lead Gets a Path. Every Path Gets Tracked.', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 52, bold: true, color: INK });
    goldDivider(s, 80, 250, 120);
    const steps = [
      ['Lead Arrives', 'Call / form / chat / referral'],
      ['Lead Captured', 'Source, status, contact, urgency'],
      ['Lead Qualified', 'Fit, area, value, urgency'],
      ['Consult Offered', 'Clear value, clear next step'],
      ['Consult Booked', 'Calendar, reminders, assignment'],
      ['Follow-Up Runs', 'Unbooked, no-show, undecided'],
      ['Reporting Updates', 'Lead-to-consult visibility'],
    ];
    const n = steps.length;
    const py = 340, ph = 480, gap = 6;
    const pw = (1760 - (n - 1) * gap) / n;
    steps.forEach(([step, sub], i) => {
      const x = 80 + i * (pw + gap);
      const bg = i === 0 ? BURGUNDY : i === n - 1 ? GOLD : CREAM_CARD;
      const isDark = i === 0 || i === n - 1;
      rrect(s, { x, y: py, w: pw, h: ph, r: 10, fill: bg, line: isDark ? false : true, lineColor: BORDER });
      const circFill = i === 0 ? GOLD : BURGUNDY;
      numCircle(s, x + (pw - 40) / 2, py + 40, 40, String(i + 1), circFill, 16);
      T(s, step, { x: x + 10, y: py + 110, w: pw - 20, h: 90, size: 15, bold: true, color: isDark ? WHITE : INK, align: 'center', lh: 1.25 });
      T(s, sub, { x: x + 12, y: py + 210, w: pw - 24, h: 200, size: 13, color: isDark ? 'ECE0D5' : CHARCOAL, align: 'center', lh: 1.35 });
      if (i < n - 1) {
        T(s, '›', { x: x + pw - 18, y: py + ph / 2 - 22, w: 40, h: 44, size: 24, bold: true, color: BURGUNDY, align: 'center', valign: 'middle' });
      }
    });
  }

  // ── SLIDE 10 — What We Install ────────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 10);
    eyebrow(s, 'The Deliverables', 80, 112);
    T(s, 'What We Install', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 58, bold: true, color: INK });
    T(s, 'Not advice. Not a CRM tweak. A real intake operating system.', { x: 80, y: 236, w: 1760, h: 50, size: 20, color: CHARCOAL, lh: 1.4 });
    const items = [
      ['01', 'Intake Discovery + Workflow Map', 'Current state audit, team interviews, bottleneck identification, and full workflow documentation.'],
      ['02', 'Call Handling + Routing Rules', 'Coverage plan, escalation rules, overflow routing, and missed-call recovery workflows.'],
      ['03', 'Consult Offer + Intake Scripts', 'Approved qualification paths, consult framing, objection handling, and next-step language.'],
      ['04', 'Automated Follow-Up Sequences', 'Multi-step nurture for unbooked leads, no-shows, and undecided prospects.'],
      ['05', 'Appointment Reminders + No-Show Recovery', 'Automated prep, reminder, and rebook sequences for every scheduled consult.'],
      ['06', 'Lead-to-Consult Reporting + Data Hygiene', 'Dashboards, source tracking, status definitions, and clean data standards.'],
    ];
    const startY = 300, cardH = 172, gap = 18, cardW = (1760 - gap) / 2;
    items.forEach(([num, title, desc], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 80 + col * (cardW + gap);
      const y = startY + row * (cardH + gap);
      numDescCard(s, { x, y, w: cardW, h: cardH, num, numFill: GOLD, title, desc, titleSize: 16, descSize: 14, circleD: 42, numSize: 14, titleGap: 30 });
    });
    bottomLine(s, 'We build the workflows, scripts, automations, reporting, and documentation your team needs to run intake consistently.', 946, { size: 15 });
  }

  // ── SLIDE 11 — Mapping table ──────────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 11);
    eyebrow(s, 'Leak → Solution Map', 80, 112);
    T(s, 'How CaseIntake Plugs the 6 Intake Leaks', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 52, bold: true, color: INK });
    goldDivider(s, 80, 250, 120);
    const rowsData = [
      ['Missed Calls', 'Call routing + coverage plan'],
      ['Slow Speed to Lead', 'Speed-to-lead workflows'],
      ['Staff Winging It', 'Scripts + qualification paths'],
      ['Poor Consult Offer', 'Consult positioning + offer language'],
      ['No Follow-Up', 'Automated follow-up + reminders'],
      ['Friction Everywhere', 'Scheduling, signing, payment, and workflow cleanup'],
    ];
    const tx = 80, tw = 1760, colW = tw / 2;
    let ty = 320;
    const headH = 64;
    rect(s, { x: tx, y: ty, w: tw, h: headH, fill: BURGUNDY });
    T(s, 'THE LEAK', { x: tx + 28, y: ty, w: colW - 40, h: headH, size: 15, bold: true, color: GOLD, cs: 1.2, valign: 'middle' });
    T(s, 'WHAT WE INSTALL', { x: tx + colW + 28, y: ty, w: colW - 40, h: headH, size: 15, bold: true, color: GOLD, cs: 1.2, valign: 'middle' });
    line(s, { x: tx + colW, y: ty, w: 0, h: headH, color: GOLD, width: 1 });
    ty += headH;
    const rowH = 84;
    rowsData.forEach(([leak, install], i) => {
      const bg = i % 2 === 0 ? CREAM_CARD : CREAM;
      rect(s, { x: tx, y: ty, w: tw, h: rowH, fill: bg });
      line(s, { x: tx, y: ty, w: tw, color: BORDER, width: 0.75 });
      numCircle(s, tx + 28, ty + (rowH - 32) / 2, 32, String(i + 1).padStart(2, '0'), BURGUNDY, 13);
      T(s, leak, { x: tx + 80, y: ty, w: colW - 100, h: rowH, size: 18, bold: true, color: INK, valign: 'middle' });
      line(s, { x: tx + colW, y: ty, w: 0, h: rowH, color: BORDER, width: 0.75 });
      checkCircle(s, tx + colW + 28, ty + (rowH - 20) / 2, 20);
      T(s, install, { x: tx + colW + 60, y: ty, w: colW - 90, h: rowH, size: 18, color: CHARCOAL, valign: 'middle' });
      ty += rowH;
    });
    // table outer border
    rrect(s, { x: tx, y: 320, w: tw, h: ty - 320, r: 12, fill: false, lineColor: BORDER_STRONG });
    bottomLine(s, 'We turn intake from a person-dependent process into a system.', 946, { size: 15 });
  }

  // ── SLIDE 12 — Capture Every Lead Faster ──────────────────────────────────────
  {
    const s = baseSlide(pptx, 12);
    eyebrow(s, 'Speed to Lead', 80, 120);
    T(s, 'Capture Every Lead Faster', { x: 80, y: 150, w: 960, h: 80, font: SERIF, size: 54, bold: true, color: BURGUNDY });
    goldDivider(s, 80, 250, 120);
    T(s, 'The first intake job is simple: do not let qualified leads disappear before the conversation starts.', {
      x: 80, y: 300, w: 900, h: 90, size: 19, color: CHARCOAL, lh: 1.45,
    });
    // routing box
    rrect(s, { x: 80, y: 420, w: 940, h: 200, r: 12, fill: BURGUNDY, line: false });
    T(s, '📞', { x: 120, y: 460, w: 80, h: 60, size: 34, align: 'center' });
    T(s, '⚡', { x: 500, y: 460, w: 80, h: 60, size: 34, align: 'center' });
    T(s, '✅', { x: 880, y: 460, w: 80, h: 60, size: 34, align: 'center' });
    line(s, { x: 210, y: 490, w: 280, color: GOLD, width: 2 });
    line(s, { x: 590, y: 490, w: 280, color: GOLD, width: 2 });
    T(s, 'Lead Contacts', { x: 100, y: 550, w: 200, h: 30, size: 13, color: 'D9B9BB' });
    T(s, 'Routed Instantly', { x: 420, y: 550, w: 240, h: 30, size: 13, color: 'D9B9BB', align: 'center' });
    T(s, 'Right Person', { x: 780, y: 550, w: 160, h: 30, size: 13, color: 'D9B9BB', align: 'right' });
    // Right col: what we build
    eyebrow(s, 'What We Build', 1080, 160, BURGUNDY, 700);
    const items = ['Call routing rules', 'Missed-call workflows', 'Form lead response workflows', 'Clear ownership of new leads', 'Internal task creation', 'Fast handoff to the right person'];
    items.forEach((it, i) => {
      const y = 220 + i * 76;
      rrect(s, { x: 1080, y, w: 760, h: 60, r: 8, lineColor: BORDER });
      checkCircle(s, 1100, y + 16, 28);
      T(s, it, { x: 1144, y, w: 680, h: 60, size: 18, color: INK, valign: 'middle' });
    });
    bottomLine(s, 'Speed matters because the lead is hottest when they reach out.', 700, { size: 15, x: 1080, w: 760 });
  }

  // ── SLIDE 13 — Before + After ─────────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 13);
    eyebrow(s, 'Scripting + Systems', 80, 112);
    T(s, 'Good People Still Need a System', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 56, bold: true, color: INK });
    T(s, 'CaseIntake gives your team the words, workflows, and next steps to follow.', { x: 80, y: 240, w: 1760, h: 50, size: 19, color: CHARCOAL, lh: 1.4 });
    const cY = 320, cH = 560, cW = 800;
    // Before
    rrect(s, { x: 80, y: cY, w: cW, h: cH, r: 14, lineColor: BORDER });
    T(s, 'BEFORE CASEINTAKE', { x: 116, y: cY + 36, w: cW - 60, h: 30, size: 12, bold: true, color: GRAY, cs: 1 });
    T(s, 'Winging It', { x: 116, y: cY + 76, w: cW - 60, h: 60, font: SERIF, size: 34, bold: true, color: CHARCOAL });
    goldDivider(s, 116, cY + 150, 60);
    ['Every intake person says it differently', 'Qualification is inconsistent', 'Consult value is unclear', 'Next steps depend on memory'].forEach((it, i) => {
      const y = cY + 210 + i * 78;
      ellipse(s, { x: 116, y, d: 24, fill: '9A968C' });
      rect(s, { x: 122, y: y + 11, w: 12, h: 3, fill: WHITE });
      T(s, it, { x: 156, y, w: cW - 100, h: 40, size: 18, color: GRAY, valign: 'middle' });
    });
    // Arrow
    T(s, '→', { x: 880, y: cY, w: 160, h: cH, size: 56, color: GOLD, align: 'center', valign: 'middle' });
    // After
    rrect(s, { x: 1040, y: cY, w: cW, h: cH, r: 14, fill: BURGUNDY, line: false, shadow: true });
    T(s, 'AFTER CASEINTAKE', { x: 1076, y: cY + 36, w: cW - 60, h: 30, size: 12, bold: true, color: GOLD, cs: 1 });
    T(s, 'A Repeatable System', { x: 1076, y: cY + 76, w: cW - 60, h: 60, font: SERIF, size: 34, bold: true, color: WHITE });
    goldDivider(s, 1076, cY + 150, 80);
    ['Approved intake script', 'Clear qualification path', 'Strong consult offer', 'Repeatable next step'].forEach((it, i) => {
      const y = cY + 210 + i * 78;
      checkCircle(s, 1076, y, 24);
      T(s, it, { x: 1116, y, w: cW - 100, h: 40, size: 18, bold: true, color: HEADER_TEXT, valign: 'middle' });
    });
    bottomLine(s, 'The goal is not to make intake robotic. The goal is to make success repeatable.', 916, { size: 15 });
  }

  // ── SLIDE 14 — Follow-Up + Friction Removal ───────────────────────────────────
  {
    const s = baseSlide(pptx, 14);
    eyebrow(s, 'Follow-Up & Friction', 80, 112);
    T(s, 'No Lead Left Behind. No Extra Friction Added.', { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 54, bold: true, color: INK });
    goldDivider(s, 80, 250, 120);
    const cY = 310, cH = 560, cW = 820;
    // Follow-up (dark)
    rrect(s, { x: 80, y: cY, w: cW, h: cH, r: 14, fill: BURGUNDY, line: false });
    T(s, 'FOLLOW-UP AUTOMATION', { x: 112, y: cY + 36, w: cW - 60, h: 30, size: 14, bold: true, color: GOLD, cs: 1 });
    line(s, { x: 112, y: cY + 78, w: 60, color: GOLD, width: 2 });
    ['Unbooked lead follow-up', 'No-show recovery', 'Appointment reminders', 'Long-term nurture', 'Internal task prompts'].forEach((it, i) => {
      const y = cY + 110 + i * 84;
      rrect(s, { x: 112, y, w: cW - 64, h: 64, r: 8, fill: '9A3A40', line: false });
      checkCircle(s, 136, y + 20, 24);
      T(s, it, { x: 176, y, w: cW - 130, h: 64, size: 17, color: HEADER_TEXT, valign: 'middle' });
    });
    // plus
    T(s, '+', { x: 900, y: cY, w: 120, h: cH, size: 28, color: GOLD, align: 'center', valign: 'middle' });
    // Friction removal (light)
    rrect(s, { x: 1020, y: cY, w: cW, h: cH, r: 14, lineColor: BORDER });
    T(s, 'FRICTION REMOVAL', { x: 1052, y: cY + 36, w: cW - 60, h: 30, size: 14, bold: true, color: BURGUNDY, cs: 1 });
    goldDivider(s, 1052, cY + 78, 60);
    ['Easier scheduling', 'Cleaner forms', 'Fewer unnecessary questions', 'Easier signing', 'Easier payment', 'Cleaner handoffs'].forEach((it, i) => {
      const y = cY + 110 + i * 70;
      rrect(s, { x: 1052, y, w: cW - 64, h: 54, r: 8, fill: CREAM, line: false });
      checkCircle(s, 1076, y + 15, 24);
      T(s, it, { x: 1116, y, w: cW - 130, h: 54, size: 17, color: INK, valign: 'middle' });
    });
    bottomLine(s, 'CaseIntake makes it easier for prospects to take the next step.', 946, { size: 15 });
  }

  // ── SLIDE 15 — Reporting + Data Hygiene ───────────────────────────────────────
  {
    const s = baseSlide(pptx, 15);
    eyebrow(s, 'Visibility & Data', 80, 112);
    T(s, "If You Can't See the Leak, You Can't Fix It", { x: 80, y: 142, w: 1760, h: 80, font: SERIF, size: 54, bold: true, color: INK });
    T(s, 'CaseIntake gives your team lead-to-consult visibility.', { x: 80, y: 232, w: 1760, h: 50, size: 19, color: CHARCOAL, lh: 1.4 });
    // Dashboard panel
    const dx = 80, dy = 300, dw = 1760, dh = 620;
    rrect(s, { x: dx, y: dy, w: dw, h: dh, r: 14, lineColor: BORDER });
    T(s, 'LEAD-TO-CONSULT DASHBOARD', { x: dx + 32, y: dy + 24, w: dw - 64, h: 30, size: 13, bold: true, color: GRAY, cs: 1 });
    line(s, { x: dx + 32, y: dy + 68, w: dw - 64, color: BORDER, width: 0.75 });
    const bigRow1 = [['Leads Received', '300', 'This Month'], ['Calls Answered', '91%', 'Answer Rate'], ['Contact Rate', '87%', 'of Form Leads']];
    const bigRow2 = [['Booked Consult Rate', '35%', 'Lead-to-Consult'], ['No-Show Rate', '12%', 'of Consults'], ['Reschedule Rate', '8%', 'of Consults']];
    const smallRow = [['Lead-to-Consult by Source', 'Google · Referral · Web', ''], ['Intake Task Completion', '94%', 'of Assigned Tasks'], ['Consult Outcome Visibility', 'Signed · Pending · Lost', '']];
    const cellGap = 16, cellW = (dw - 64 - 2 * cellGap) / 3;
    const drawBig = (arr, yy) => arr.forEach(([label, val, sub], i) => {
      const x = dx + 32 + i * (cellW + cellGap);
      rrect(s, { x, y: yy, w: cellW, h: 150, r: 10, fill: CREAM, lineColor: BORDER });
      T(s, label.toUpperCase(), { x: x + 12, y: yy + 20, w: cellW - 24, h: 24, size: 12, bold: true, color: GOLD, align: 'center', cs: 1 });
      T(s, val, { x: x + 12, y: yy + 46, w: cellW - 24, h: 66, font: SERIF, size: 44, bold: true, color: BURGUNDY, align: 'center' });
      T(s, sub, { x: x + 12, y: yy + 112, w: cellW - 24, h: 30, size: 13, color: GRAY, align: 'center' });
    });
    drawBig(bigRow1, dy + 92);
    drawBig(bigRow2, dy + 258);
    smallRow.forEach(([label, val, sub], i) => {
      const x = dx + 32 + i * (cellW + cellGap);
      const yy = dy + 424;
      rrect(s, { x, y: yy, w: cellW, h: 120, r: 10, fill: CREAM, lineColor: BORDER });
      T(s, label.toUpperCase(), { x: x + 16, y: yy + 18, w: cellW - 32, h: 40, size: 12, bold: true, color: GOLD, cs: 1, lh: 1.2 });
      T(s, val, { x: x + 16, y: yy + 62, w: cellW - 32, h: 30, size: 15, bold: true, color: BURGUNDY });
      if (sub) T(s, sub, { x: x + 16, y: yy + 90, w: cellW - 32, h: 24, size: 12, color: GRAY });
    });
    bottomLine(s, 'This is how we improve the engine from Click to Close.', 946, { size: 15 });
  }

  // ── SLIDE 16 — Implementation Path (3-stage timeline) ─────────────────────────
  {
    const s = baseSlide(pptx, 16);
    eyebrow(s, 'The Implementation Path', 80, 112);
    T(s, 'We Install Intensively. Then We Optimize. Then We Steward.', { x: 80, y: 142, w: 1760, h: 90, font: SERIF, size: 52, bold: true, color: INK, lh: 1.1 });
    goldDivider(s, 80, 260, 120);
    // timeline line
    line(s, { x: 80, y: 560, w: 1760, color: GOLD, width: 4 });
    const phases = [
      ['Phase 1', 'CaseIntake Install', '6 months', 'Heavy development', '$5,000/mo', BURGUNDY, WHITE, GOLD, true],
      ['Phase 2', 'CaseIntake Optimize', '3 months', 'Medium development', '$3,750/mo', CREAM_CARD, INK, BURGUNDY, false],
      ['Phase 3', 'CaseIntake Stewardship', 'Ongoing', 'Maintenance', '$2,500/mo', CREAM, INK, BURGUNDY, false],
    ];
    const gap = 36, cardW = (1760 - 2 * gap) / 3, cY = 330, cH = 460;
    phases.forEach(([phase, title, duration, intensity, price, bg, textCol, accent, hl], i) => {
      const x = 80 + i * (cardW + gap);
      rrect(s, { x, y: cY, w: cardW, h: cH, r: 14, fill: bg, line: hl ? false : true, lineColor: BORDER, lw: hl ? 0 : 1, shadow: hl });
      if (hl) rrect(s, { x, y: cY, w: cardW, h: cH, r: 14, fill: false, lineColor: GOLD, lw: 2 });
      T(s, phase.toUpperCase(), { x: x + 28, y: cY + 32, w: cardW - 56, h: 26, size: 12, bold: true, color: accent, cs: 1.2 });
      T(s, title, { x: x + 28, y: cY + 66, w: cardW - 56, h: 90, font: SERIF, size: 32, bold: true, color: textCol, lh: 1.15 });
      line(s, { x: x + 28, y: cY + 176, w: 50, color: accent, width: 2 });
      T(s, duration, { x: x + 28, y: cY + 196, w: cardW - 56, h: 36, size: 17, bold: true, color: hl ? 'ECE0D5' : CHARCOAL });
      T(s, intensity, { x: x + 28, y: cY + 236, w: cardW - 56, h: 34, size: 15, color: hl ? 'D9B9BB' : GRAY });
      T(s, price, { x: x + 28, y: cY + 290, w: cardW - 56, h: 80, font: SERIF, size: 44, bold: true, color: accent });
    });
    bottomLine(s, 'Build the system. Improve the system. Keep the system clean.', 916, { size: 16 });
  }

  // ── SLIDE 17 — Phase 1: Install ───────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 17);
    eyebrow(s, 'Phase 1 of 3', 80, 112);
    T(s, 'Phase 1: CaseIntake Install', { x: 80, y: 142, w: 1200, h: 80, font: SERIF, size: 54, bold: true, color: BURGUNDY });
    T(s, '6 months of heavy development to build the intake operating system.', { x: 80, y: 232, w: 1200, h: 40, size: 18, color: CHARCOAL });
    s.addText([
      { text: '$5,000', options: { fontSize: F(56), color: BURGUNDY, bold: true, fontFace: SERIF } },
      { text: '/mo', options: { fontSize: F(24), color: CHARCOAL, bold: false, fontFace: SERIF } },
    ], { x: X(1340), y: Y(140), w: X(500), h: Y(70), align: 'right', valign: 'top', margin: 0 });
    T(s, 'Weekly meetings with Builder + Strategist', { x: 1340, y: 220, w: 500, h: 40, size: 15, color: CHARCOAL, align: 'right' });
    goldDivider(s, 80, 290, 120);
    const items = [
      ['01', 'Discovery', 'Current intake, software, team, scripts, bottlenecks.'],
      ['02', 'Development', 'Workflows, automations, reporting, routing, tracking.'],
      ['03', 'Train & Launch', 'Team training, launch support, adoption monitoring.'],
      ['04', 'Refine', 'Scripts, automations, fields, statuses, handoffs.'],
      ['05', 'Reporting & Data Hygiene', 'Clean source data, outcome tracking, dashboards.'],
      ['06', 'Documentation & Final Handoff', 'Processes, ownership, system notes, final documentation.'],
    ];
    const startY = 340, cardH = 176, gap = 16, cardW = (1760 - gap) / 2;
    items.forEach(([num, title, desc], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 80 + col * (cardW + gap);
      const y = startY + row * (cardH + gap);
      numDescCard(s, { x, y, w: cardW, h: cardH, num, title, desc, titleSize: 16, descSize: 14, circleD: 42, numSize: 14, titleGap: 30 });
    });
    bottomLine(s, 'This is not minor setup. This is the build phase.', 942, { size: 15 });
  }

  // ── SLIDE 18 — Phase 2: Optimize ──────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 18);
    eyebrow(s, 'Phase 2 of 3', 80, 112);
    T(s, 'Phase 2: CaseIntake Optimize', { x: 80, y: 142, w: 960, h: 80, font: SERIF, size: 50, bold: true, color: BURGUNDY });
    T(s, '3 months of custom feature development and refinement after the system is live.', { x: 80, y: 230, w: 940, h: 70, size: 18, color: CHARCOAL, lh: 1.4 });
    goldDivider(s, 80, 320, 120);
    // price box + cadence box
    rrect(s, { x: 80, y: 360, w: 450, h: 130, r: 10, fill: BURGUNDY, line: false });
    s.addText([
      { text: '$3,750', options: { fontSize: F(48), color: WHITE, bold: true, fontFace: SERIF } },
      { text: '/mo', options: { fontSize: F(20), color: GOLD, fontFace: SERIF } },
    ], { x: X(104), y: Y(384), w: X(400), h: Y(64), align: 'center', margin: 0 });
    T(s, '3 months', { x: 104, y: 450, w: 400, h: 30, size: 13, color: 'D9B9BB', align: 'center' });
    rrect(s, { x: 554, y: 360, w: 466, h: 130, r: 10, lineColor: BORDER });
    T(s, 'MEETING CADENCE', { x: 578, y: 380, w: 420, h: 26, size: 13, bold: true, color: GOLD, cs: 1 });
    T(s, '2 meetings/month\nBuilder every meeting\nStrategist every other', { x: 578, y: 408, w: 420, h: 80, size: 15, color: CHARCOAL, lh: 1.5 });
    // live status
    rrect(s, { x: 80, y: 520, w: 940, h: 340, r: 12, lineColor: BORDER });
    T(s, 'LIVE SYSTEM STATUS', { x: 104, y: 544, w: 900, h: 30, size: 12, bold: true, color: BURGUNDY, cs: 1 });
    const st = [['Workflows', 'Active'], ['Automations', 'Running'], ['Scripts', 'Deployed'], ['Reporting', 'Live']];
    const sgap = 12, sw = (940 - 48 - sgap) / 2, shh = 100;
    st.forEach(([k, v], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 104 + col * (sw + sgap);
      const y = 592 + row * (shh + sgap);
      rrect(s, { x, y, w: sw, h: shh, r: 6, fill: CREAM, line: false });
      T(s, k, { x: x + 18, y, w: sw - 120, h: shh, size: 14, color: CHARCOAL, valign: 'middle' });
      rrect(s, { x: x + sw - 130, y: y + (shh - 34) / 2, w: 110, h: 34, r: 17, fill: 'E7DBC4', line: false });
      T(s, v, { x: x + sw - 130, y: y + (shh - 34) / 2, w: 110, h: 34, size: 12, bold: true, color: GOLD, align: 'center', valign: 'middle' });
    });
    // Right col optimization work
    eyebrow(s, 'Optimization Work', 1080, 200, BURGUNDY, 700);
    ['Build custom features', 'Add new automations', 'Refine reporting', 'Improve lead statuses', 'Adjust intake workflows', 'Tune follow-up sequences', 'Resolve post-launch friction'].forEach((it, i) => {
      const y = 254 + i * 84;
      rrect(s, { x: 1080, y, w: 760, h: 66, r: 8, lineColor: BORDER });
      checkCircle(s, 1102, y + 20, 26);
      T(s, it, { x: 1146, y, w: 680, h: 66, size: 17, color: INK, valign: 'middle' });
    });
  }

  // ── SLIDE 19 — Phase 3: Stewardship ───────────────────────────────────────────
  {
    const s = baseSlide(pptx, 19);
    eyebrow(s, 'Phase 3 of 3', 80, 112);
    T(s, 'Phase 3: CaseIntake Stewardship', { x: 80, y: 142, w: 960, h: 80, font: SERIF, size: 48, bold: true, color: BURGUNDY });
    T(s, 'Ongoing maintenance so the system stays clean, current, and useful.', { x: 80, y: 230, w: 940, h: 60, size: 18, color: CHARCOAL, lh: 1.4 });
    goldDivider(s, 80, 310, 120);
    rrect(s, { x: 80, y: 350, w: 450, h: 130, r: 10, fill: BURGUNDY, line: false });
    s.addText([
      { text: '$2,500', options: { fontSize: F(48), color: WHITE, bold: true, fontFace: SERIF } },
      { text: '/mo', options: { fontSize: F(20), color: GOLD, fontFace: SERIF } },
    ], { x: X(104), y: Y(374), w: X(400), h: Y(64), align: 'center', margin: 0 });
    T(s, 'Ongoing', { x: 104, y: 440, w: 400, h: 30, size: 13, color: 'D9B9BB', align: 'center' });
    rrect(s, { x: 554, y: 350, w: 466, h: 130, r: 10, lineColor: BORDER });
    T(s, 'MEETING CADENCE', { x: 578, y: 372, w: 420, h: 26, size: 13, bold: true, color: GOLD, cs: 1 });
    T(s, '1 meeting/month\nwith Builder', { x: 578, y: 404, w: 420, h: 70, size: 15, color: CHARCOAL, lh: 1.5 });
    // Health gauge
    rrect(s, { x: 80, y: 510, w: 940, h: 350, r: 12, lineColor: BORDER });
    T(s, 'SYSTEM HEALTH', { x: 104, y: 540, w: 900, h: 30, size: 12, bold: true, color: BURGUNDY, cs: 1, align: 'center' });
    // arc via a large gold ring segment approximation: donut using pie
    s.addShape('pie', { x: X(390), y: Y(590), w: X(320), h: Y(320), fill: { color: GOLD }, line: { type: 'none' }, angleRange: [180, 360] });
    s.addShape('pie', { x: X(390), y: Y(590), w: X(320), h: Y(320), fill: { color: '4A9E6B' }, line: { type: 'none' }, angleRange: [300, 360] });
    ellipse(s, { x: 430, y: 630, d: 240, fill: CREAM_CARD });
    T(s, '98%', { x: 430, y: 700, w: 240, h: 80, font: SERIF, size: 40, bold: true, color: BURGUNDY, align: 'center' });
    T(s, 'Intake System Health Score', { x: 104, y: 810, w: 900, h: 36, size: 15, bold: true, color: CHARCOAL, align: 'center' });
    // Right col: what's included (2col)
    eyebrow(s, "What's Included", 1080, 200, BURGUNDY, 700);
    const incl = ['Minor updates', 'Workflow adjustments', 'Small automation edits', 'Reporting checks', 'Data hygiene review', 'Intake system health check', 'Light documentation updates'];
    const iGap = 12, iW = (760 - iGap) / 2, iH = 90;
    incl.forEach((it, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 1080 + col * (iW + iGap);
      const y = 254 + row * (iH + iGap);
      rrect(s, { x, y, w: iW, h: iH, r: 8, lineColor: BORDER });
      checkCircle(s, x + 16, y + (iH - 22) / 2, 22);
      T(s, it, { x: x + 48, y, w: iW - 60, h: iH, size: 15, color: INK, valign: 'middle', lh: 1.2 });
    });
  }

  // ── SLIDE 20 — Who You Work With ──────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 20);
    eyebrow(s, 'The Delivery Team', 80, 112);
    T(s, "You Don't Get a Software Vendor.\nYou Get an Intake Build Team.", { x: 80, y: 142, w: 1760, h: 130, font: SERIF, size: 50, bold: true, color: INK, lh: 1.1 });
    goldDivider(s, 80, 300, 120);
    // Left role cards
    const cX = 80, cW = 820, cY = 360, cH = 260, cGap = 24;
    rrect(s, { x: cX, y: cY, w: cW, h: cH, r: 14, fill: BURGUNDY, line: false, shadow: true });
    T(s, 'ROLE 1', { x: cX + 28, y: cY + 28, w: cW - 56, h: 26, size: 12, bold: true, color: GOLD, cs: 1.2 });
    T(s, 'CaseIntake Strategist', { x: cX + 28, y: cY + 58, w: cW - 56, h: 56, font: SERIF, size: 36, bold: true, color: WHITE });
    line(s, { x: cX + 28, y: cY + 126, w: 60, color: GOLD, width: 2 });
    T(s, 'Owns intake design, conversion strategy, scripts, priorities, training, and refinement.', { x: cX + 28, y: cY + 150, w: cW - 56, h: 90, size: 17, color: HEADER_TEXT, lh: 1.5 });
    const c2Y = cY + cH + cGap;
    rrect(s, { x: cX, y: c2Y, w: cW, h: cH, r: 14, lineColor: BORDER_STRONG, lw: 2 });
    T(s, 'ROLE 2', { x: cX + 28, y: c2Y + 28, w: cW - 56, h: 26, size: 12, bold: true, color: GOLD, cs: 1.2 });
    T(s, 'CaseIntake Builder', { x: cX + 28, y: c2Y + 58, w: cW - 56, h: 56, font: SERIF, size: 36, bold: true, color: BURGUNDY });
    goldDivider(s, cX + 28, c2Y + 126, 60);
    T(s, 'Owns workflows, automations, CRM/PMS configuration, reporting, documentation, and updates.', { x: cX + 28, y: c2Y + 150, w: cW - 56, h: 90, size: 17, color: CHARCOAL, lh: 1.5 });
    // Right cadence table
    eyebrow(s, 'Engagement Cadence', 960, 340, BURGUNDY, 800);
    const tx = 960, tw = 880, ty0 = 388;
    const headH = 60;
    const colX = [tx, tx + tw * 0.4, tx + tw * 0.7];
    const colW = [tw * 0.4, tw * 0.3, tw * 0.3];
    rect(s, { x: tx, y: ty0, w: tw, h: headH, fill: BURGUNDY });
    ['Phase', 'Builder', 'Strategist'].forEach((h, i) => {
      T(s, h.toUpperCase(), { x: colX[i] + 20, y: ty0, w: colW[i] - 30, h: headH, size: 13, bold: true, color: GOLD, cs: 1, valign: 'middle' });
    });
    const cad = [['Install', 'Weekly', 'Weekly', CREAM_CARD], ['Optimize', '2x / month', '1x / month', CREAM], ['Stewardship', '1x / month', 'As scoped', CREAM_CARD]];
    let ty = ty0 + headH;
    const rowH = 108;
    cad.forEach(([phase, b, st, bg]) => {
      rect(s, { x: tx, y: ty, w: tw, h: rowH, fill: bg });
      line(s, { x: tx, y: ty, w: tw, color: BORDER, width: 0.75 });
      T(s, phase, { x: colX[0] + 20, y: ty, w: colW[0] - 30, h: rowH, size: 17, bold: true, color: INK, valign: 'middle' });
      line(s, { x: colX[1], y: ty, w: 0, h: rowH, color: BORDER, width: 0.75 });
      T(s, b, { x: colX[1] + 20, y: ty, w: colW[1] - 30, h: rowH, size: 17, color: CHARCOAL, valign: 'middle' });
      line(s, { x: colX[2], y: ty, w: 0, h: rowH, color: BORDER, width: 0.75 });
      T(s, st, { x: colX[2] + 20, y: ty, w: colW[2] - 30, h: rowH, size: 17, color: CHARCOAL, valign: 'middle' });
      ty += rowH;
    });
    rrect(s, { x: tx, y: ty0, w: tw, h: ty - ty0, r: 12, fill: false, lineColor: BORDER_STRONG });
    bottomLine(s, 'Strategy decides what should happen. Building makes it real.', 800, { size: 15, x: 960, w: 880 });
  }

  // ── SLIDE 21 — What You're Really Buying ──────────────────────────────────────
  {
    const s = baseSlide(pptx, 21);
    eyebrow(s, 'The Investment', 80, 112);
    T(s, "What You're Really Buying", { x: 80, y: 142, w: 1760, h: 90, font: SERIF, size: 60, bold: true, color: BURGUNDY });
    goldDivider(s, 80, 250, 120);
    const cY = 320, cH = 560, cW = 800;
    // Not this
    rrect(s, { x: 80, y: cY, w: cW, h: cH, r: 14, lineColor: BORDER });
    T(s, 'NOT THIS', { x: 116, y: cY + 36, w: cW - 60, h: 30, size: 12, bold: true, color: GRAY, cs: 1 });
    line(s, { x: 116, y: cY + 82, w: 50, color: 'E0D8CC', width: 2 });
    ['Not a CRM tweak', 'Not a one-time automation project', 'Not generic intake advice', 'Not another software subscription'].forEach((it, i) => {
      const y = cY + 140 + i * 96;
      ellipse(s, { x: 116, y, d: 28, fill: 'E0D8CC' });
      rect(s, { x: 122, y: y + 13, w: 16, h: 3, fill: '999999' });
      T(s, it, { x: 160, y, w: cW - 110, h: 40, size: 19, color: GRAY, strike: true, valign: 'middle' });
    });
    // Arrow
    T(s, '→', { x: 880, y: cY, w: 160, h: cH, size: 56, color: GOLD, align: 'center', valign: 'middle' });
    // This
    rrect(s, { x: 1040, y: cY, w: cW, h: cH, r: 14, fill: BURGUNDY, line: false, shadow: true });
    T(s, 'THIS', { x: 1076, y: cY + 36, w: cW - 60, h: 30, size: 12, bold: true, color: GOLD, cs: 1 });
    line(s, { x: 1076, y: cY + 82, w: 50, color: GOLD, width: 2 });
    [
      'A lead-to-consult operating system',
      'Scripts, workflows, automations, reporting, and documentation',
      'A team that builds, launches, refines, and maintains it',
      'A system that protects the revenue currently leaking between lead and consult',
    ].forEach((it, i) => {
      const y = cY + 130 + i * 100;
      checkCircle(s, 1076, y, 28);
      T(s, it, { x: 1120, y: y - 4, w: cW - 90, h: 90, size: 18, bold: true, color: HEADER_TEXT, lh: 1.35 });
    });
    bottomLine(s, 'You are buying back the revenue your intake process is currently losing.', 916, { size: 16 });
  }

  // ── SLIDE 22 — Next Steps ─────────────────────────────────────────────────────
  {
    const s = baseSlide(pptx, 22);
    eyebrow(s, "Let's Get Started", 80, 120, GOLD, 1760);
    T(s, 'Ready to Build Your CaseIntake System?', {
      x: 410, y: 150, w: 1100, h: 90, font: SERIF, size: 60, bold: true, color: BURGUNDY, align: 'center',
    });
    goldDivider(s, (1920 - 120) / 2, 270, 120);
    const steps = [
      ['01', 'Approve CaseIntake\nEngagement'],
      ['02', 'Schedule\nDiscovery'],
      ['03', 'Map Current Intake\nWorkflow'],
      ['04', 'Begin\nBuild Sprint'],
    ];
    const stepW = 220, connW = 60;
    const totalStepsW = steps.length * stepW + (steps.length - 1) * connW;
    let sx = (1920 - totalStepsW) / 2;
    steps.forEach(([num, label], i) => {
      const cxCenter = sx + stepW / 2;
      ellipse(s, { x: cxCenter - 40, y: 340, d: 80, fill: BURGUNDY });
      s.addShape('ellipse', { x: X(cxCenter - 40), y: Y(340), w: X(80), h: Y(80), fill: { type: 'none' }, line: { color: GOLD, width: 2.5 } });
      T(s, num, { x: cxCenter - 40, y: 340, w: 80, h: 80, size: 24, bold: true, color: WHITE, align: 'center', valign: 'middle' });
      T(s, label, { x: sx, y: 436, w: stepW, h: 80, size: 17, bold: true, color: INK, align: 'center', lh: 1.35 });
      if (i < steps.length - 1) {
        line(s, { x: sx + stepW, y: 380, w: connW, color: GOLD, width: 2 });
      }
      sx += stepW + connW;
    });
    // CTA box
    const boxW = 860, bx = (1920 - boxW) / 2;
    rrect(s, { x: bx, y: 580, w: boxW, h: 240, r: 16, fill: BURGUNDY, lineColor: GOLD, lw: 2, shadow: true });
    T(s, 'Schedule Your CaseIntake Discovery Session', { x: bx + 40, y: 620, w: boxW - 80, h: 70, font: SERIF, size: 36, bold: true, color: WHITE, align: 'center' });
    goldDivider(s, (1920 - 120) / 2, 706, 120);
    T(s, 'NOBULLMARKETING.COM', { x: bx + 40, y: 740, w: boxW - 80, h: 40, size: 18, color: 'E0C9CB', align: 'center', cs: 1 });
    bottomLine(s, 'We start by finding the biggest intake leak, then build the system that plugs it.', 916, { align: 'center', size: 15 });
  }
}

// checkbox square used by slide 6
function slideRoundBox(slide, x, y, d) {
  slide.addShape('roundRect', {
    x: X(x), y: Y(y), w: X(d), h: Y(d), rectRadius: X(6),
    fill: { type: 'none' }, line: { color: GOLD, width: 2 },
  });
}

// ─── RUN ────────────────────────────────────────────────────────────────────
async function main() {
  const pptx = new PptxGenJS();
  build(pptx);
  await pptx.writeFile({ fileName: OUTPUT_FILE });
  console.log(`✅ 22-slide editable deck written to: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('PPTX generation failed:', err);
  process.exit(1);
});
