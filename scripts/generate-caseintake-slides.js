#!/usr/bin/env node
// CaseIntake Sales Deck — 22 Slides → PNG Images
// Brand: cream #EDE8DC, burgundy #8B292F, gold #B08D57, charcoal #524B3A
// Fonts: Crimson Pro (serif headlines) + Montserrat (sans body)

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'slide-output');

// ─── SHARED STYLES ───────────────────────────────────────────────────────────
const FONTS = `
  @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400&family=Montserrat:wght@300;400;500;600;700&display=swap');
`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #EDE8DC;
    font-family: 'Montserrat', sans-serif;
    color: #524B3A;
  }
  .slide {
    position: relative;
    width: 1920px;
    height: 1080px;
    background: #EDE8DC;
    display: flex;
    flex-direction: column;
  }
  /* HEADER */
  .header {
    width: 100%;
    height: 64px;
    background: #8B292F;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 56px;
    flex-shrink: 0;
  }
  .header-left {
    font-family: 'Montserrat', sans-serif;
    font-size: 17px;
    font-weight: 600;
    color: #F3EEE5;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .header-right {
    font-family: 'Montserrat', sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: #B08D57;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  /* FOOTER */
  .footer {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 56px;
    border-top: 1px solid rgba(176,141,87,0.25);
  }
  .footer-url {
    font-family: 'Montserrat', sans-serif;
    font-size: 13px;
    font-weight: 500;
    color: #8B292F;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .footer-num {
    font-family: 'Montserrat', sans-serif;
    font-size: 13px;
    font-weight: 500;
    color: #8B292F;
    letter-spacing: 0.05em;
  }
  /* CONTENT AREA */
  .content {
    flex: 1;
    padding: 48px 80px 60px;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* TYPOGRAPHY */
  .headline {
    font-family: 'Crimson Pro', serif;
    font-size: 58px;
    font-weight: 700;
    color: #1F1F1F;
    line-height: 1.12;
    margin-bottom: 10px;
  }
  .headline-lg {
    font-family: 'Crimson Pro', serif;
    font-size: 66px;
    font-weight: 700;
    color: #1F1F1F;
    line-height: 1.1;
  }
  .subhead {
    font-family: 'Montserrat', sans-serif;
    font-size: 22px;
    font-weight: 400;
    color: #524B3A;
    line-height: 1.45;
    margin-bottom: 14px;
  }
  .body-text {
    font-family: 'Montserrat', sans-serif;
    font-size: 19px;
    font-weight: 400;
    color: #524B3A;
    line-height: 1.55;
  }
  .bottom-line {
    font-family: 'Montserrat', sans-serif;
    font-size: 17px;
    font-weight: 600;
    color: #8B292F;
    font-style: italic;
    margin-top: auto;
    padding-top: 16px;
  }
  /* GOLD DIVIDER */
  .gold-divider {
    height: 3px;
    background: linear-gradient(90deg, #B08D57, #D4AF6A, #B08D57);
    border-radius: 2px;
    margin: 14px 0;
    width: 120px;
  }
  .gold-divider-full {
    height: 2px;
    background: linear-gradient(90deg, #B08D57, #D4AF6A, #B08D57);
    border-radius: 2px;
    margin: 16px 0;
    width: 100%;
    opacity: 0.5;
  }
  /* CARD BASE */
  .card {
    background: #F3EEE5;
    border-radius: 12px;
    padding: 32px;
    border: 1px solid rgba(176,141,87,0.2);
  }
  /* NUMBERED CIRCLE */
  .num-circle {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #B08D57;
    color: #fff;
    font-family: 'Montserrat', sans-serif;
    font-size: 18px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  /* GOLD CHECKMARK */
  .gold-check {
    color: #B08D57;
    font-size: 22px;
    margin-right: 14px;
    flex-shrink: 0;
  }
  /* BURGUNDY ACCENT */
  .burgundy { color: #8B292F; }
  .gold { color: #B08D57; }
`;

function slideHTML(slideNum, bodyContent, totalSlides = 22) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${FONTS}
${BASE_CSS}
</style>
</head>
<body>
<div class="slide">
  <div class="header">
    <div class="header-left">The CaseIntake System™</div>
    <div class="header-right">NOBULL MARKETING</div>
  </div>
  ${bodyContent}
  <div class="footer">
    <div class="footer-url">NOBULLMARKETING.COM</div>
    <div class="footer-num">${String(slideNum).padStart(2, '0')} / ${totalSlides}</div>
  </div>
</div>
</body>
</html>`;
}

// ─── SLIDE DEFINITIONS ────────────────────────────────────────────────────────

const slides = [];

// SLIDE 01 — Before We Get Started
slides.push(slideHTML(1, `
<div class="content" style="flex-direction:row; gap:80px; align-items:flex-start; padding-top:60px;">
  <div style="flex:1.1;">
    <div class="headline-lg" style="font-size:72px; color:#8B292F; margin-bottom:8px;">Before We<br>Get Started</div>
    <div class="gold-divider" style="width:160px; margin:20px 0;"></div>
    <div class="subhead" style="font-size:20px; color:#524B3A; max-width:560px; line-height:1.5;">
      A quick look at what we'll cover together in the next few minutes.
    </div>
  </div>
  <div style="flex:1; padding-top:16px;">
    <div style="font-family:'Montserrat',sans-serif; font-size:18px; font-weight:700; color:#8B292F; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:28px;">Today we'll cover:</div>
    <div style="display:flex; flex-direction:column; gap:24px;">
      ${[
        "Why most firms leak revenue after the lead comes in",
        "The 6 silent intake leaks that keep good leads from booking consults",
        "How CaseIntake™ turns intake into a repeatable operating system",
        "How implementation works",
        "Whether this is the right next step for your firm"
      ].map(item => `
        <div style="display:flex; align-items:flex-start; gap:16px;">
          <div style="width:36px; height:36px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 4.5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div style="font-family:'Montserrat',sans-serif; font-size:20px; font-weight:400; color:#1F1F1F; line-height:1.45;">${item}</div>
        </div>
      `).join('')}
    </div>
  </div>
</div>
`));

// SLIDE 02 — The Opportunity
slides.push(slideHTML(2, `
<div class="content" style="flex-direction:row; gap:60px; align-items:flex-start; padding-top:50px;">
  <div style="flex:1.2;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:16px;">The Opportunity</div>
    <div class="headline" style="font-size:52px; line-height:1.1; margin-bottom:20px;">The Cheapest Growth Is Usually Already in Your Lead Flow</div>
    <div class="gold-divider"></div>
    <div class="subhead" style="font-size:20px; margin-top:16px; margin-bottom:28px;">You do not always need more leads. Sometimes you need to capture more of the leads you already paid for.</div>
    <div style="background:#F3EEE5; border-radius:12px; padding:24px 28px; border:1px solid rgba(139,41,47,0.15); margin-top:8px;">
      <div style="font-family:'Montserrat',sans-serif; font-size:18px; font-weight:500; color:#524B3A; line-height:1.55;">
        Every missed call, slow follow-up, weak script, no-show, or extra step turns <strong style="color:#8B292F;">paid opportunity into waste.</strong>
      </div>
    </div>
  </div>
  <div style="flex:0.85; display:flex; flex-direction:column; align-items:center; padding-top:20px;">
    <!-- Leaky Funnel -->
    <div style="position:relative; width:340px;">
      ${[
        { label: 'LEADS', sub: 'You paid for these', w: 340, bg: '#8B292F', color: '#fff', h: 90 },
        { label: 'CONSULTS', sub: 'Fewer make it here', w: 260, bg: '#A84B51', color: '#fff', h: 82 },
        { label: 'CLIENTS', sub: 'Even fewer here', w: 190, bg: '#C07C42', color: '#fff', h: 74 },
      ].map((tier, i) => `
        <div style="display:flex; justify-content:center; margin-bottom:4px;">
          <div style="width:${tier.w}px; height:${tier.h}px; background:${tier.bg}; border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; position:relative;">
            <div style="font-family:'Montserrat',sans-serif; font-size:20px; font-weight:700; color:${tier.color}; letter-spacing:0.08em;">${tier.label}</div>
            <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:400; color:rgba(255,255,255,0.8);">${tier.sub}</div>
            ${i < 2 ? `<div style="position:absolute; right:-60px; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; align-items:center; gap:2px;">
              <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57;">LEAKS</div>
              <div style="font-size:20px;">💧</div>
            </div>` : ''}
          </div>
        </div>
        ${i < 2 ? `<div style="display:flex; justify-content:center; margin-bottom:4px;">
          <svg width="32" height="24"><path d="M16 0 L16 24" stroke="#B08D57" stroke-width="2.5" stroke-dasharray="4,3"/><polygon points="16,24 10,14 22,14" fill="#B08D57"/></svg>
        </div>` : ''}
      `).join('')}
    </div>
  </div>
</div>
`));

// SLIDE 03 — Revenue Engine Context
slides.push(slideHTML(3, `
<div class="content" style="padding-top:44px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:12px;">The Law Firm Revenue Engine</div>
  <div class="headline" style="font-size:46px; line-height:1.15; max-width:1400px; margin-bottom:8px;">CaseGen Creates the Opportunity. <span style="color:#8B292F;">CaseIntake Captures It.</span> CaseConvert Turns It Into Revenue.</div>
  <div class="gold-divider" style="margin:16px 0 32px;"></div>
  <div style="display:flex; gap:36px; align-items:stretch; flex:1;">
    <!-- Card 1 CaseGen -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:36px 32px; border:1px solid rgba(176,141,87,0.2); opacity:0.72; display:flex; flex-direction:column;">
      <div style="font-family:'Crimson Pro',serif; font-size:38px; font-weight:700; color:#524B3A; margin-bottom:12px;">CaseGen™</div>
      <div class="gold-divider" style="width:60px; margin:0 0 16px;"></div>
      <div style="font-family:'Montserrat',sans-serif; font-size:19px; color:#524B3A; line-height:1.5; flex:1;">Generates more leads and reputation for your firm.</div>
      <div style="margin-top:24px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; color:#8B292F; letter-spacing:0.08em; text-transform:uppercase;">Lead Generation</div>
    </div>
    <!-- Card 2 CaseIntake — HIGHLIGHTED -->
    <div style="flex:1.15; background:#8B292F; border-radius:14px; padding:36px 32px; border:3px solid #B08D57; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(139,41,47,0.32);">
      <div style="font-family:'Crimson Pro',serif; font-size:42px; font-weight:700; color:#fff; margin-bottom:12px;">CaseIntake™</div>
      <div style="height:3px; background:linear-gradient(90deg,#B08D57,#D4AF6A,#B08D57); border-radius:2px; width:80px; margin-bottom:16px;"></div>
      <div style="font-family:'Montserrat',sans-serif; font-size:21px; color:#F3EEE5; line-height:1.5; flex:1; font-weight:500;">Turns more leads into booked consults.</div>
      <div style="margin-top:24px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#B08D57; letter-spacing:0.08em; text-transform:uppercase;">← TODAY'S FOCUS →</div>
    </div>
    <!-- Card 3 CaseConvert -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:36px 32px; border:1px solid rgba(176,141,87,0.2); opacity:0.72; display:flex; flex-direction:column;">
      <div style="font-family:'Crimson Pro',serif; font-size:38px; font-weight:700; color:#524B3A; margin-bottom:12px;">CaseConvert™</div>
      <div class="gold-divider" style="width:60px; margin:0 0 16px;"></div>
      <div style="font-family:'Montserrat',sans-serif; font-size:19px; color:#524B3A; line-height:1.5; flex:1;">Turns more consults into signed clients.</div>
      <div style="margin-top:24px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; color:#8B292F; letter-spacing:0.08em; text-transform:uppercase;">Conversion</div>
    </div>
  </div>
  <div class="bottom-line" style="font-size:16px; padding-top:20px; border-top:1px solid rgba(176,141,87,0.25); margin-top:16px;">Today, we're focused on the part of the engine where most firms quietly lose the leads they already paid for.</div>
</div>
`));

// SLIDE 04 — You Already Paid for the Lead
slides.push(slideHTML(4, `
<div class="content" style="padding-top:50px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:12px;">The Real Problem</div>
  <div class="headline" style="font-size:64px; color:#8B292F; margin-bottom:6px;">You Already Paid for the Lead</div>
  <div class="subhead" style="font-size:20px; margin-bottom:32px;">The question is whether your intake system turns that lead into a booked consult — or lets it leak out.</div>
  <div style="display:flex; gap:48px; align-items:stretch; flex:1;">
    <!-- Left card -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:44px 40px; border:2px solid rgba(176,141,87,0.25); display:flex; flex-direction:column;">
      <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#595959; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:20px;">What Firms Think Is Happening</div>
      <div style="font-family:'Crimson Pro',serif; font-size:42px; font-weight:600; color:#524B3A; line-height:1.2; flex:1;">"We need<br>more leads."</div>
      <div style="margin-top:24px; padding:16px 20px; background:#E8E2D8; border-radius:8px; border-left:4px solid #595959;">
        <div style="font-family:'Montserrat',sans-serif; font-size:16px; color:#595959;">The default assumption — spend more, get more.</div>
      </div>
    </div>
    <!-- Arrow -->
    <div style="display:flex; align-items:center; color:#B08D57; font-size:48px;">→</div>
    <!-- Right card -->
    <div style="flex:1; background:#8B292F; border-radius:14px; padding:44px 40px; display:flex; flex-direction:column; box-shadow:0 12px 36px rgba(139,41,47,0.25);">
      <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#B08D57; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:20px;">What Is Often Happening</div>
      <div style="font-family:'Crimson Pro',serif; font-size:36px; font-weight:600; color:#fff; line-height:1.3; flex:1;">Good leads are being<br>missed, delayed,<br>mishandled,<br>or left unfollowed.</div>
      <div style="margin-top:24px; padding:16px 20px; background:rgba(255,255,255,0.12); border-radius:8px; border-left:4px solid #B08D57;">
        <div style="font-family:'Montserrat',sans-serif; font-size:16px; color:#F3EEE5; font-weight:500;">CaseIntake protects your marketing investment.</div>
      </div>
    </div>
  </div>
</div>
`));

// SLIDE 05 — The 6 Silent Intake Leaks
slides.push(slideHTML(5, `
<div class="content" style="padding-top:44px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The Problem</div>
  <div class="headline" style="font-size:54px; margin-bottom:6px;">The 6 Silent Intake Leaks</div>
  <div class="subhead" style="font-size:19px; margin-bottom:24px;">Most firms do not lose leads all at once. They lose them one friction point at a time.</div>
  <div style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr 1fr; gap:16px; flex:1;">
    ${[
      ['01', 'Missed Calls', 'High-intent leads call once, hit voicemail, and move on.'],
      ['02', 'Slow Speed to Lead', 'The lead was interested when they reached out. Later, they may already be talking to someone else.'],
      ['03', 'Intake Staff Winging It', 'Good people, bad system. No consistent script, qualification path, consult offer, or next step.'],
      ['04', 'Poor Consult Offer', 'The prospect does not understand why the consult is valuable enough to book or attend.'],
      ['05', 'Little to No Follow-Up', 'Unbooked leads, no-shows, and undecided prospects disappear.'],
      ['06', 'Friction Everywhere', 'Hard to schedule. Hard to meet. Hard to sign. Hard to pay. Too many steps.'],
    ].map(([num, title, desc]) => `
      <div style="background:#F3EEE5; border-radius:10px; padding:22px 24px; border:1px solid rgba(176,141,87,0.18); display:flex; align-items:flex-start; gap:16px;">
        <div style="width:46px; height:46px; border-radius:50%; background:#8B292F; color:#fff; font-family:'Montserrat',sans-serif; font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${num}</div>
        <div>
          <div style="font-family:'Montserrat',sans-serif; font-size:17px; font-weight:700; color:#1F1F1F; margin-bottom:6px;">${title}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:#524B3A; line-height:1.5;">${desc}</div>
        </div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:16px; padding-top:14px;">CaseIntake plugs the leaks between lead and consult.</div>
</div>
`));

// SLIDE 06 — Where Is Your Intake Leaking?
slides.push(slideHTML(6, `
<div class="content" style="padding-top:50px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:12px;">Self-Diagnosis</div>
  <div class="headline" style="font-size:60px; color:#8B292F; margin-bottom:8px;">Where Is Your Intake Leaking?</div>
  <div class="gold-divider" style="margin:16px 0 28px; width:140px;"></div>
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px 80px; flex:1; align-content:start;">
    ${[
      'Are calls ever missed during business hours?',
      'Are form leads contacted immediately?',
      'Does every intake person follow the same script?',
      'Is your consultation clearly positioned as valuable?',
      'Do unbooked leads and no-shows get consistent follow-up?',
      'Is it easy for prospects to schedule, meet, sign, and pay?',
    ].map((q, i) => `
      <div style="display:flex; align-items:flex-start; gap:20px; padding:22px 24px; background:#F3EEE5; border-radius:10px; border:1px solid rgba(176,141,87,0.2);">
        <div style="width:32px; height:32px; border:2px solid #B08D57; border-radius:6px; flex-shrink:0; margin-top:2px; display:flex; align-items:center; justify-content:center;">
          <div style="width:10px; height:10px; background:#B08D57; border-radius:2px; opacity:0;"></div>
        </div>
        <div style="font-family:'Montserrat',sans-serif; font-size:20px; color:#1F1F1F; line-height:1.45; font-weight:400;">${q}</div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:16px; padding-top:20px; border-top:1px solid rgba(176,141,87,0.25);">If even one leak is happening consistently, revenue is slipping through intake.</div>
</div>
`));

// SLIDE 07 — What These Leaks Cost You
slides.push(slideHTML(7, `
<div class="content" style="padding-top:44px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The ROI Case</div>
  <div class="headline" style="font-size:52px; margin-bottom:6px;">A Small Intake Lift Can Pay for the Whole System</div>
  <div class="gold-divider" style="margin:14px 0 28px;"></div>
  <div style="display:flex; gap:32px; flex:1; align-items:stretch;">
    <!-- Math flow -->
    <div style="flex:1.3; display:flex; flex-direction:column; gap:14px;">
      ${[
        ['300', 'leads / month', '#524B3A'],
        ['25% → 75', 'Current lead-to-consult = 75 consults', '#524B3A'],
        ['35% → 105', 'Improved lead-to-consult = 105 consults', '#8B292F'],
        ['+30', 'additional consults / month', '#8B292F'],
      ].map(([big, label, col], i) => `
        <div style="background:#F3EEE5; border-radius:10px; padding:18px 24px; border:1px solid rgba(176,141,87,0.2); display:flex; align-items:center; gap:20px; ${i===2||i===3 ? 'border-color:#8B292F; border-width:1.5px;' : ''}">
          <div style="font-family:'Crimson Pro',serif; font-size:42px; font-weight:700; color:${col}; min-width:140px;">${big}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#524B3A;">${label}</div>
        </div>
      `).join('')}
    </div>
    <!-- Result boxes -->
    <div style="flex:1; display:flex; flex-direction:column; gap:14px;">
      <div style="background:#F3EEE5; border-radius:10px; padding:18px 24px; border:1px solid rgba(176,141,87,0.2);">
        <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:600; color:#B08D57; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px;">If 30% become clients</div>
        <div style="font-family:'Crimson Pro',serif; font-size:52px; font-weight:700; color:#8B292F;">+9 clients</div>
        <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#524B3A;">per month</div>
      </div>
      <div style="background:#8B292F; border-radius:10px; padding:18px 24px; flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:600; color:#B08D57; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:8px;">At $8,000 avg case value</div>
        <div style="font-family:'Crimson Pro',serif; font-size:60px; font-weight:700; color:#fff; line-height:1;">$72,000</div>
        <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#F3EEE5; margin-top:4px;">per month in added revenue</div>
      </div>
    </div>
  </div>
  <div style="font-family:'Montserrat',sans-serif; font-size:12px; color:#595959; font-style:italic; margin-top:10px;">Example only. Actual results depend on lead volume, consult rate, close rate, and average case value.</div>
  <div class="bottom-line" style="font-size:15px; padding-top:8px;">Fixing intake can create growth without buying more leads.</div>
</div>
`));

// SLIDE 08 — Introducing The CaseIntake System™
slides.push(slideHTML(8, `
<div class="content" style="padding-top:50px; align-items:center; text-align:center;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:14px;">The Solution</div>
  <div class="headline-lg" style="font-size:64px; color:#8B292F; max-width:1100px; text-align:center; margin:0 auto 10px;">Introducing The CaseIntake System™</div>
  <div class="gold-divider" style="margin:18px auto 16px;"></div>
  <div class="subhead" style="font-size:21px; max-width:800px; text-align:center; margin:0 auto 40px;">A lead-to-consult operating system built specifically for law firms.</div>
  <div style="display:flex; gap:36px; justify-content:center; width:100%; flex:1; align-items:stretch;">
    ${[
      ['Answer Faster', 'Reduce missed and delayed response — capture every lead at the moment they reach out.', '📞'],
      ['Book Better', 'Improve qualification, scripting, and consult positioning so more leads say yes.', '📅'],
      ['Follow Up Relentlessly', 'Automate reminders, no-show recovery, and long-term nurture so no lead disappears.', '🔄'],
    ].map(([title, desc, icon]) => `
      <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:44px 36px; border:1px solid rgba(176,141,87,0.25); display:flex; flex-direction:column; align-items:center; text-align:center; max-width:480px;">
        <div style="font-size:40px; margin-bottom:16px;">${icon}</div>
        <div style="width:56px; height:3px; background:linear-gradient(90deg,#B08D57,#D4AF6A); border-radius:2px; margin-bottom:20px;"></div>
        <div style="font-family:'Crimson Pro',serif; font-size:36px; font-weight:700; color:#8B292F; margin-bottom:16px;">${title}</div>
        <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#524B3A; line-height:1.55;">${desc}</div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:16px; text-align:center; padding-top:20px;">CaseIntake turns intake from "who remembered to follow up?" into a system.</div>
</div>
`));

// SLIDE 09 — The CaseIntake Operating System (7-step pipeline)
slides.push(slideHTML(9, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The Operating System</div>
  <div class="headline" style="font-size:52px; margin-bottom:6px;">Every Lead Gets a Path. Every Path Gets Tracked.</div>
  <div class="gold-divider" style="margin:16px 0 32px;"></div>
  <!-- 7-step pipeline -->
  <div style="display:flex; align-items:stretch; gap:0; flex:1; margin-bottom:16px;">
    ${[
      ['Lead Arrives', 'Call / form / chat / referral'],
      ['Lead Captured', 'Source, status, contact, urgency'],
      ['Lead Qualified', 'Fit, area, value, urgency'],
      ['Consult Offered', 'Clear value, clear next step'],
      ['Consult Booked', 'Calendar, reminders, assignment'],
      ['Follow-Up Runs', 'Unbooked, no-show, undecided'],
      ['Reporting Updates', 'Lead-to-consult visibility'],
    ].map(([step, sub], i) => `
      <div style="flex:1; display:flex; flex-direction:column; position:relative;">
        <div style="background:${i===0 ? '#8B292F' : i===6 ? '#B08D57' : '#F3EEE5'}; border:1px solid ${i===0||i===6 ? 'transparent' : 'rgba(176,141,87,0.25)'}; border-radius:${i===0 ? '12px 0 0 12px' : i===6 ? '0 12px 12px 0' : '0'}; padding:24px 18px; flex:1; display:flex; flex-direction:column; align-items:center; text-align:center; justify-content:center; position:relative;">
          <div style="width:40px; height:40px; border-radius:50%; background:${i===0 ? '#B08D57' : i===6 ? '#8B292F' : '#8B292F'}; color:#fff; font-family:'Montserrat',sans-serif; font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; margin-bottom:14px;">${i+1}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:15px; font-weight:700; color:${i===0||i===6 ? '#fff' : '#1F1F1F'}; line-height:1.3; margin-bottom:8px;">${step}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:13px; color:${i===0||i===6 ? 'rgba(255,255,255,0.8)' : '#524B3A'}; line-height:1.4;">${sub}</div>
        </div>
        ${i < 6 ? `<div style="position:absolute; right:-18px; top:50%; transform:translateY(-50%); z-index:10; width:36px; height:36px; background:#B08D57; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:18px; font-weight:700; box-shadow:0 2px 8px rgba(0,0,0,0.15);">›</div>` : ''}
      </div>
    `).join('')}
  </div>
</div>
`));

// SLIDE 10 — What We Install
slides.push(slideHTML(10, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The Deliverables</div>
  <div class="headline" style="font-size:58px; margin-bottom:6px;">What We Install</div>
  <div class="subhead" style="font-size:20px; margin-bottom:28px;">Not advice. Not a CRM tweak. A real intake operating system.</div>
  <div style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr 1fr; gap:18px; flex:1;">
    ${[
      ['01', 'Intake Discovery + Workflow Map', 'Current state audit, team interviews, bottleneck identification, and full workflow documentation.'],
      ['02', 'Call Handling + Routing Rules', 'Coverage plan, escalation rules, overflow routing, and missed-call recovery workflows.'],
      ['03', 'Consult Offer + Intake Scripts', 'Approved qualification paths, consult framing, objection handling, and next-step language.'],
      ['04', 'Automated Follow-Up Sequences', 'Multi-step nurture for unbooked leads, no-shows, and undecided prospects.'],
      ['05', 'Appointment Reminders + No-Show Recovery', 'Automated prep, reminder, and rebook sequences for every scheduled consult.'],
      ['06', 'Lead-to-Consult Reporting + Data Hygiene', 'Dashboards, source tracking, status definitions, and clean data standards.'],
    ].map(([num, title, desc]) => `
      <div style="background:#F3EEE5; border-radius:10px; padding:22px 24px; border:1px solid rgba(176,141,87,0.2); display:flex; align-items:flex-start; gap:16px;">
        <div style="width:42px; height:42px; border-radius:50%; background:#B08D57; color:#fff; font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${num}</div>
        <div>
          <div style="font-family:'Montserrat',sans-serif; font-size:16px; font-weight:700; color:#1F1F1F; margin-bottom:6px;">${title}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:14px; color:#524B3A; line-height:1.5;">${desc}</div>
        </div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:14px;">We build the workflows, scripts, automations, reporting, and documentation your team needs to run intake consistently.</div>
</div>
`));

// SLIDE 11 — How CaseIntake Plugs the 6 Leaks (mapping table)
slides.push(slideHTML(11, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">Leak → Solution Map</div>
  <div class="headline" style="font-size:52px; margin-bottom:6px;">How CaseIntake Plugs the 6 Intake Leaks</div>
  <div class="gold-divider" style="margin:14px 0 28px;"></div>
  <!-- Table -->
  <div style="flex:1; border-radius:12px; overflow:hidden; border:1px solid rgba(176,141,87,0.25);">
    <!-- Header row -->
    <div style="display:grid; grid-template-columns:1fr 1fr; background:#8B292F;">
      <div style="padding:18px 28px; font-family:'Montserrat',sans-serif; font-size:15px; font-weight:700; color:#B08D57; letter-spacing:0.1em; text-transform:uppercase;">The Leak</div>
      <div style="padding:18px 28px; font-family:'Montserrat',sans-serif; font-size:15px; font-weight:700; color:#B08D57; letter-spacing:0.1em; text-transform:uppercase; border-left:1px solid rgba(176,141,87,0.3);">What We Install</div>
    </div>
    ${[
      ['Missed Calls', 'Call routing + coverage plan'],
      ['Slow Speed to Lead', 'Speed-to-lead workflows'],
      ['Staff Winging It', 'Scripts + qualification paths'],
      ['Poor Consult Offer', 'Consult positioning + offer language'],
      ['No Follow-Up', 'Automated follow-up + reminders'],
      ['Friction Everywhere', 'Scheduling, signing, payment, and workflow cleanup'],
    ].map(([leak, install], i) => `
      <div style="display:grid; grid-template-columns:1fr 1fr; background:${i%2===0 ? '#F3EEE5' : '#EDE8DC'}; border-top:1px solid rgba(176,141,87,0.15);">
        <div style="padding:20px 28px; display:flex; align-items:center; gap:16px;">
          <div style="width:32px; height:32px; border-radius:50%; background:#8B292F; color:#fff; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${String(i+1).padStart(2,'0')}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:18px; font-weight:600; color:#1F1F1F;">${leak}</div>
        </div>
        <div style="padding:20px 28px; display:flex; align-items:center; border-left:1px solid rgba(176,141,87,0.2);">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:20px; height:20px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4.5 7.5L8.5 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#524B3A;">${install}</div>
          </div>
        </div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:14px;">We turn intake from a person-dependent process into a system.</div>
</div>
`));

// SLIDE 12 — Capture Every Lead Faster
slides.push(slideHTML(12, `
<div class="content" style="flex-direction:row; gap:64px; padding-top:52px; align-items:flex-start;">
  <div style="flex:1.1;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:12px;">Speed to Lead</div>
    <div class="headline" style="font-size:54px; color:#8B292F; margin-bottom:8px;">Capture Every Lead Faster</div>
    <div class="gold-divider" style="margin:16px 0 18px;"></div>
    <div class="subhead" style="font-size:19px; margin-bottom:28px;">The first intake job is simple: do not let qualified leads disappear before the conversation starts.</div>
    <!-- Visual: routing box -->
    <div style="background:#8B292F; border-radius:12px; padding:28px 32px;">
      <div style="display:flex; align-items:center; gap:24px; margin-bottom:20px;">
        <div style="font-size:36px;">📞</div>
        <div style="height:2px; flex:1; background:linear-gradient(90deg, #B08D57, rgba(176,141,87,0));"></div>
        <div style="font-size:36px;">⚡</div>
        <div style="height:2px; flex:1; background:linear-gradient(90deg, rgba(176,141,87,0), #B08D57);"></div>
        <div style="font-size:36px;">✅</div>
      </div>
      <div style="display:flex; justify-content:space-between; font-family:'Montserrat',sans-serif; font-size:13px; color:rgba(255,255,255,0.7);">
        <div>Lead Contacts</div><div style="text-align:center;">Routed Instantly</div><div>Right Person</div>
      </div>
    </div>
  </div>
  <div style="flex:0.9; padding-top:12px;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#8B292F; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:20px;">What We Build</div>
    <div style="display:flex; flex-direction:column; gap:16px;">
      ${[
        'Call routing rules',
        'Missed-call workflows',
        'Form lead response workflows',
        'Clear ownership of new leads',
        'Internal task creation',
        'Fast handoff to the right person',
      ].map(item => `
        <div style="display:flex; align-items:center; gap:16px; padding:16px 20px; background:#F3EEE5; border-radius:8px; border:1px solid rgba(176,141,87,0.2);">
          <div style="width:28px; height:28px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#1F1F1F;">${item}</div>
        </div>
      `).join('')}
    </div>
    <div class="bottom-line" style="padding-top:18px; font-size:15px;">Speed matters because the lead is hottest when they reach out.</div>
  </div>
</div>
`));

// SLIDE 13 — Stop Winging It / Before + After
slides.push(slideHTML(13, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">Scripting + Systems</div>
  <div class="headline" style="font-size:56px; margin-bottom:6px;">Good People Still Need a System</div>
  <div class="subhead" style="font-size:19px; margin-bottom:28px;">CaseIntake gives your team the words, workflows, and next steps to follow.</div>
  <div style="display:flex; gap:40px; flex:1; align-items:stretch;">
    <!-- Before -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:36px 36px; border:2px solid rgba(139,41,47,0.15); display:flex; flex-direction:column;">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#595959; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:16px;">Before CaseIntake</div>
      <div style="font-family:'Crimson Pro',serif; font-size:34px; font-weight:700; color:#524B3A; margin-bottom:20px;">Winging It</div>
      <div class="gold-divider" style="width:60px; background:linear-gradient(90deg,#595959,#999); opacity:0.4;"></div>
      <div style="display:flex; flex-direction:column; gap:16px; flex:1; justify-content:center;">
        ${['Every intake person says it differently', 'Qualification is inconsistent', 'Consult value is unclear', 'Next steps depend on memory'].map(item => `
          <div style="display:flex; align-items:center; gap:14px;">
            <div style="width:24px; height:24px; border-radius:50%; background:#595959; opacity:0.4; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
              <div style="width:8px; height:2px; background:white;"></div>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#595959;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <!-- Arrow -->
    <div style="display:flex; align-items:center; color:#B08D57; font-size:56px; font-weight:300;">→</div>
    <!-- After -->
    <div style="flex:1; background:#8B292F; border-radius:14px; padding:36px 36px; display:flex; flex-direction:column; box-shadow:0 12px 36px rgba(139,41,47,0.25);">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:16px;">After CaseIntake</div>
      <div style="font-family:'Crimson Pro',serif; font-size:34px; font-weight:700; color:#fff; margin-bottom:20px;">A Repeatable System</div>
      <div style="height:3px; background:linear-gradient(90deg,#B08D57,#D4AF6A); border-radius:2px; width:80px; margin-bottom:20px;"></div>
      <div style="display:flex; flex-direction:column; gap:16px; flex:1; justify-content:center;">
        ${['Approved intake script', 'Clear qualification path', 'Strong consult offer', 'Repeatable next step'].map(item => `
          <div style="display:flex; align-items:center; gap:14px;">
            <div style="width:24px; height:24px; border-radius:50%; background:#B08D57; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#F3EEE5; font-weight:500;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:16px;">The goal is not to make intake robotic. The goal is to make success repeatable.</div>
</div>
`));

// SLIDE 14 — Follow-Up + Friction Removal
slides.push(slideHTML(14, `
<div class="content" style="padding-top:44px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">Follow-Up & Friction</div>
  <div class="headline" style="font-size:54px; margin-bottom:6px;">No Lead Left Behind. No Extra Friction Added.</div>
  <div class="gold-divider" style="margin:14px 0 24px;"></div>
  <div style="display:flex; gap:36px; flex:1; align-items:stretch;">
    <!-- Follow-up section -->
    <div style="flex:1; background:#8B292F; border-radius:14px; padding:36px 32px; display:flex; flex-direction:column;">
      <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:8px;">Follow-Up Automation</div>
      <div style="height:2px; background:#B08D57; width:60px; border-radius:2px; margin-bottom:20px;"></div>
      <div style="display:flex; flex-direction:column; gap:14px; flex:1;">
        ${['Unbooked lead follow-up', 'No-show recovery', 'Appointment reminders', 'Long-term nurture', 'Internal task prompts'].map(item => `
          <div style="display:flex; align-items:center; gap:14px; padding:14px 18px; background:rgba(255,255,255,0.1); border-radius:8px;">
            <div style="width:24px; height:24px; border-radius:50%; background:#B08D57; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4 7.5L8 2.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#F3EEE5;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <!-- Divider -->
    <div style="display:flex; align-items:center; color:#B08D57; font-size:28px; padding:0 8px;">+</div>
    <!-- Friction removal section -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:36px 32px; border:1px solid rgba(176,141,87,0.25); display:flex; flex-direction:column;">
      <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#8B292F; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:8px;">Friction Removal</div>
      <div class="gold-divider" style="width:60px; margin-bottom:20px;"></div>
      <div style="display:flex; flex-direction:column; gap:14px; flex:1;">
        ${['Easier scheduling', 'Cleaner forms', 'Fewer unnecessary questions', 'Easier signing', 'Easier payment', 'Cleaner handoffs'].map(item => `
          <div style="display:flex; align-items:center; gap:14px; padding:14px 18px; background:#EDE8DC; border-radius:8px;">
            <div style="width:24px; height:24px; border-radius:50%; background:#B08D57; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4 7.5L8 2.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#1F1F1F;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:14px;">CaseIntake makes it easier for prospects to take the next step.</div>
</div>
`));

// SLIDE 15 — Reporting + Data Hygiene
slides.push(slideHTML(15, `
<div class="content" style="padding-top:44px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">Visibility & Data</div>
  <div class="headline" style="font-size:54px; margin-bottom:6px;">If You Can't See the Leak, You Can't Fix It</div>
  <div class="subhead" style="font-size:19px; margin-bottom:24px;">CaseIntake gives your team lead-to-consult visibility.</div>
  <!-- Dashboard mock -->
  <div style="background:#F3EEE5; border-radius:14px; padding:28px 32px; border:1px solid rgba(176,141,87,0.25); flex:1;">
    <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#595959; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:20px; padding-bottom:12px; border-bottom:1px solid rgba(176,141,87,0.25);">Lead-to-Consult Dashboard</div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:16px;">
      ${[
        ['Leads Received', '300', 'This Month'],
        ['Calls Answered', '91%', 'Answer Rate'],
        ['Contact Rate', '87%', 'of Form Leads'],
      ].map(([label, val, sub]) => `
        <div style="background:#EDE8DC; border-radius:10px; padding:20px 22px; text-align:center; border:1px solid rgba(176,141,87,0.2);">
          <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:8px;">${label}</div>
          <div style="font-family:'Crimson Pro',serif; font-size:44px; font-weight:700; color:#8B292F; line-height:1;">${val}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:13px; color:#595959; margin-top:4px;">${sub}</div>
        </div>
      `).join('')}
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:16px;">
      ${[
        ['Booked Consult Rate', '35%', 'Lead-to-Consult'],
        ['No-Show Rate', '12%', 'of Consults'],
        ['Reschedule Rate', '8%', 'of Consults'],
      ].map(([label, val, sub]) => `
        <div style="background:#EDE8DC; border-radius:10px; padding:20px 22px; text-align:center; border:1px solid rgba(176,141,87,0.2);">
          <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:8px;">${label}</div>
          <div style="font-family:'Crimson Pro',serif; font-size:44px; font-weight:700; color:#8B292F; line-height:1;">${val}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:13px; color:#595959; margin-top:4px;">${sub}</div>
        </div>
      `).join('')}
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:16px;">
      ${[
        ['Lead-to-Consult by Source', 'Google · Referral · Web', ''],
        ['Intake Task Completion', '94%', 'of Assigned Tasks'],
        ['Consult Outcome Visibility', 'Signed · Pending · Lost', ''],
      ].map(([label, val, sub]) => `
        <div style="background:#EDE8DC; border-radius:10px; padding:16px 22px; border:1px solid rgba(176,141,87,0.2);">
          <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px;">${label}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:15px; font-weight:600; color:#8B292F;">${val}</div>
          ${sub ? `<div style="font-family:'Montserrat',sans-serif; font-size:12px; color:#595959;">${sub}</div>` : ''}
        </div>
      `).join('')}
    </div>
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:14px;">This is how we improve the engine from Click to Close.</div>
</div>
`));

// SLIDE 16 — Implementation Path (3-stage timeline)
slides.push(slideHTML(16, `
<div class="content" style="padding-top:48px; align-items:center;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px; align-self:flex-start;">The Implementation Path</div>
  <div class="headline" style="font-size:52px; margin-bottom:6px; align-self:flex-start;">We Install Intensively. Then We Optimize. Then We Steward.</div>
  <div class="gold-divider" style="margin:14px 0 32px; align-self:flex-start;"></div>
  <!-- Timeline -->
  <div style="position:relative; width:100%; flex:1; display:flex; flex-direction:column; justify-content:center;">
    <!-- Timeline line -->
    <div style="position:absolute; top:50%; left:0; right:0; height:4px; background:linear-gradient(90deg,#8B292F,#B08D57,#C4A06A); border-radius:2px; transform:translateY(-50%);"></div>
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:36px; position:relative; z-index:1;">
      ${[
        ['Phase 1', 'CaseIntake Install', '6 months', 'Heavy development', '$5,000/mo', '#8B292F', '#fff', '#B08D57'],
        ['Phase 2', 'CaseIntake Optimize', '3 months', 'Medium development', '$3,750/mo', '#F3EEE5', '#1F1F1F', '#8B292F'],
        ['Phase 3', 'CaseIntake Stewardship', 'Ongoing', 'Maintenance', '$2,500/mo', '#EDE8DC', '#1F1F1F', '#8B292F'],
      ].map(([phase, title, duration, intensity, price, bg, textCol, accentCol]) => `
        <div style="background:${bg}; border-radius:14px; padding:32px 28px; border:${bg==='#8B292F' ? '2px solid #B08D57' : '1px solid rgba(176,141,87,0.25)'}; display:flex; flex-direction:column; gap:12px; box-shadow:${bg==='#8B292F' ? '0 12px 36px rgba(139,41,47,0.3)' : 'none'};">
          <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:${accentCol}; letter-spacing:0.12em; text-transform:uppercase;">${phase}</div>
          <div style="font-family:'Crimson Pro',serif; font-size:32px; font-weight:700; color:${textCol}; line-height:1.2;">${title}</div>
          <div style="height:2px; background:${accentCol}; width:50px; border-radius:2px; opacity:0.6;"></div>
          <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:${bg==='#8B292F' ? 'rgba(255,255,255,0.8)' : '#524B3A'}; font-weight:500;">${duration}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:${bg==='#8B292F' ? 'rgba(255,255,255,0.65)' : '#595959'};">${intensity}</div>
          <div style="font-family:'Crimson Pro',serif; font-size:44px; font-weight:700; color:${accentCol}; margin-top:8px;">${price}</div>
        </div>
      `).join('')}
    </div>
  </div>
  <div class="bottom-line" style="font-size:16px; padding-top:20px; align-self:flex-start;">Build the system. Improve the system. Keep the system clean.</div>
</div>
`));

// SLIDE 17 — Phase 1: Install
slides.push(slideHTML(17, `
<div class="content" style="padding-top:44px;">
  <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
    <div>
      <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:8px;">Phase 1 of 3</div>
      <div class="headline" style="font-size:54px; color:#8B292F; margin-bottom:6px;">Phase 1: CaseIntake Install</div>
      <div class="subhead" style="font-size:18px;">6 months of heavy development to build the intake operating system.</div>
    </div>
    <div style="text-align:right; flex-shrink:0; padding-top:8px;">
      <div style="font-family:'Crimson Pro',serif; font-size:56px; font-weight:700; color:#8B292F; line-height:1;">$5,000<span style="font-size:24px; color:#524B3A;">/mo</span></div>
      <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:#524B3A; margin-top:4px;">Weekly meetings with Builder + Strategist</div>
    </div>
  </div>
  <div class="gold-divider" style="margin:0 0 24px;"></div>
  <div style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr 1fr; gap:16px; flex:1;">
    ${[
      ['01', 'Discovery', 'Current intake, software, team, scripts, bottlenecks.'],
      ['02', 'Development', 'Workflows, automations, reporting, routing, tracking.'],
      ['03', 'Train & Launch', 'Team training, launch support, adoption monitoring.'],
      ['04', 'Refine', 'Scripts, automations, fields, statuses, handoffs.'],
      ['05', 'Reporting & Data Hygiene', 'Clean source data, outcome tracking, dashboards.'],
      ['06', 'Documentation & Final Handoff', 'Processes, ownership, system notes, final documentation.'],
    ].map(([num, title, desc]) => `
      <div style="background:#F3EEE5; border-radius:10px; padding:22px 24px; border:1px solid rgba(176,141,87,0.2); display:flex; align-items:flex-start; gap:14px;">
        <div style="width:42px; height:42px; border-radius:50%; background:#8B292F; color:#fff; font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${num}</div>
        <div>
          <div style="font-family:'Montserrat',sans-serif; font-size:16px; font-weight:700; color:#1F1F1F; margin-bottom:5px;">${title}</div>
          <div style="font-family:'Montserrat',sans-serif; font-size:14px; color:#524B3A; line-height:1.5;">${desc}</div>
        </div>
      </div>
    `).join('')}
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:14px;">This is not minor setup. This is the build phase.</div>
</div>
`));

// SLIDE 18 — Phase 2: Optimize
slides.push(slideHTML(18, `
<div class="content" style="padding-top:44px; flex-direction:row; gap:48px;">
  <div style="flex:1.1; display:flex; flex-direction:column;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:8px;">Phase 2 of 3</div>
    <div class="headline" style="font-size:50px; color:#8B292F; margin-bottom:6px;">Phase 2: CaseIntake Optimize</div>
    <div class="subhead" style="font-size:18px; margin-bottom:16px;">3 months of custom feature development and refinement after the system is live.</div>
    <div class="gold-divider"></div>
    <div style="display:flex; gap:24px; margin:16px 0 24px;">
      <div style="flex:1; background:#8B292F; border-radius:10px; padding:20px 22px; text-align:center;">
        <div style="font-family:'Crimson Pro',serif; font-size:48px; font-weight:700; color:#fff; line-height:1;">$3,750<span style="font-size:20px; color:#B08D57;">/mo</span></div>
        <div style="font-family:'Montserrat',sans-serif; font-size:13px; color:rgba(255,255,255,0.8); margin-top:4px;">3 months</div>
      </div>
      <div style="flex:1; background:#F3EEE5; border-radius:10px; padding:20px 22px; border:1px solid rgba(176,141,87,0.2);">
        <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#B08D57; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:8px;">Meeting Cadence</div>
        <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:#524B3A; line-height:1.6;">2 meetings/month<br>Builder every meeting<br>Strategist every other</div>
      </div>
    </div>
    <!-- Live system dashboard mock -->
    <div style="background:#F3EEE5; border-radius:12px; padding:20px 24px; border:1px solid rgba(176,141,87,0.2); flex:1;">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#8B292F; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:14px;">Live System Status</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        ${[['Workflows', 'Active'], ['Automations', 'Running'], ['Scripts', 'Deployed'], ['Reporting', 'Live']].map(([k,v]) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#EDE8DC; border-radius:6px;">
            <span style="font-family:'Montserrat',sans-serif; font-size:14px; color:#524B3A;">${k}</span>
            <span style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; background:rgba(176,141,87,0.12); padding:3px 10px; border-radius:20px;">${v}</span>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
  <div style="flex:0.9; display:flex; flex-direction:column; padding-top:60px;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#8B292F; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:20px;">Optimization Work</div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      ${['Build custom features', 'Add new automations', 'Refine reporting', 'Improve lead statuses', 'Adjust intake workflows', 'Tune follow-up sequences', 'Resolve post-launch friction'].map(item => `
        <div style="display:flex; align-items:center; gap:14px; padding:14px 18px; background:#F3EEE5; border-radius:8px; border:1px solid rgba(176,141,87,0.2);">
          <div style="width:26px; height:26px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#1F1F1F;">${item}</div>
        </div>
      `).join('')}
    </div>
    <div class="bottom-line" style="font-size:14px; padding-top:16px;">Once the system is live, we use real usage data to make it better.</div>
  </div>
</div>
`));

// SLIDE 19 — Phase 3: Stewardship
slides.push(slideHTML(19, `
<div class="content" style="padding-top:44px; flex-direction:row; gap:48px;">
  <div style="flex:1.1; display:flex; flex-direction:column;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:8px;">Phase 3 of 3</div>
    <div class="headline" style="font-size:48px; color:#8B292F; margin-bottom:6px;">Phase 3: CaseIntake Stewardship</div>
    <div class="subhead" style="font-size:18px; margin-bottom:16px;">Ongoing maintenance so the system stays clean, current, and useful.</div>
    <div class="gold-divider"></div>
    <div style="display:flex; gap:24px; margin:16px 0 24px;">
      <div style="flex:1; background:#8B292F; border-radius:10px; padding:20px 22px; text-align:center;">
        <div style="font-family:'Crimson Pro',serif; font-size:48px; font-weight:700; color:#fff; line-height:1;">$2,500<span style="font-size:20px; color:#B08D57;">/mo</span></div>
        <div style="font-family:'Montserrat',sans-serif; font-size:13px; color:rgba(255,255,255,0.8); margin-top:4px;">Ongoing</div>
      </div>
      <div style="flex:1; background:#F3EEE5; border-radius:10px; padding:20px 22px; border:1px solid rgba(176,141,87,0.2);">
        <div style="font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#B08D57; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:8px;">Meeting Cadence</div>
        <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:#524B3A; line-height:1.6;">1 meeting/month<br>with Builder</div>
      </div>
    </div>
    <!-- Health gauge -->
    <div style="background:#F3EEE5; border-radius:12px; padding:24px; border:1px solid rgba(176,141,87,0.2); flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#8B292F; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:16px;">System Health</div>
      <div style="position:relative; width:180px; height:90px; overflow:hidden; margin-bottom:16px;">
        <div style="position:absolute; bottom:0; left:0; width:180px; height:180px; border-radius:50%; background:conic-gradient(from 180deg, #8B292F 0deg, #B08D57 60deg, #4a9e6b 120deg, #e0e0e0 180deg); box-shadow:inset 0 0 0 50px #F3EEE5;"></div>
        <div style="position:absolute; bottom:10px; left:50%; transform:translateX(-50%); font-family:'Crimson Pro',serif; font-size:32px; font-weight:700; color:#8B292F;">98%</div>
      </div>
      <div style="font-family:'Montserrat',sans-serif; font-size:15px; font-weight:600; color:#524B3A;">Intake System Health Score</div>
    </div>
  </div>
  <div style="flex:0.9; display:flex; flex-direction:column; padding-top:60px;">
    <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#8B292F; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:20px;">What's Included</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; flex:1; align-content:start;">
      ${['Minor updates', 'Workflow adjustments', 'Small automation edits', 'Reporting checks', 'Data hygiene review', 'Intake system health check', 'Light documentation updates'].map(item => `
        <div style="display:flex; align-items:center; gap:12px; padding:14px 16px; background:#F3EEE5; border-radius:8px; border:1px solid rgba(176,141,87,0.2);">
          <div style="width:22px; height:22px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4 7.5L8 2.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
          <div style="font-family:'Montserrat',sans-serif; font-size:15px; color:#1F1F1F;">${item}</div>
        </div>
      `).join('')}
    </div>
    <div class="bottom-line" style="font-size:14px; padding-top:16px;">Systems decay when no one owns them. Stewardship keeps CaseIntake working.</div>
  </div>
</div>
`));

// SLIDE 20 — Who You Work With
slides.push(slideHTML(20, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The Delivery Team</div>
  <div class="headline" style="font-size:50px; margin-bottom:6px;">You Don't Get a Software Vendor.<br>You Get an Intake Build Team.</div>
  <div class="gold-divider" style="margin:14px 0 24px;"></div>
  <div style="display:flex; gap:36px; flex:1; align-items:stretch;">
    <!-- Role cards -->
    <div style="flex:1; display:flex; flex-direction:column; gap:24px;">
      <div style="flex:1; background:#8B292F; border-radius:14px; padding:32px 28px; display:flex; flex-direction:column; box-shadow:0 8px 28px rgba(139,41,47,0.2);">
        <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:10px;">Role 1</div>
        <div style="font-family:'Crimson Pro',serif; font-size:36px; font-weight:700; color:#fff; margin-bottom:12px;">CaseIntake Strategist</div>
        <div style="height:2px; background:#B08D57; width:60px; border-radius:2px; margin-bottom:16px;"></div>
        <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#F3EEE5; line-height:1.6; flex:1;">Owns intake design, conversion strategy, scripts, priorities, training, and refinement.</div>
      </div>
      <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:32px 28px; border:2px solid rgba(176,141,87,0.25); display:flex; flex-direction:column;">
        <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:10px;">Role 2</div>
        <div style="font-family:'Crimson Pro',serif; font-size:36px; font-weight:700; color:#8B292F; margin-bottom:12px;">CaseIntake Builder</div>
        <div class="gold-divider" style="width:60px; margin-bottom:16px;"></div>
        <div style="font-family:'Montserrat',sans-serif; font-size:17px; color:#524B3A; line-height:1.6; flex:1;">Owns workflows, automations, CRM/PMS configuration, reporting, documentation, and updates.</div>
      </div>
    </div>
    <!-- Cadence table -->
    <div style="flex:1.1; display:flex; flex-direction:column;">
      <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#8B292F; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:16px;">Engagement Cadence</div>
      <div style="border-radius:12px; overflow:hidden; border:1px solid rgba(176,141,87,0.25); flex:1;">
        <!-- Header -->
        <div style="display:grid; grid-template-columns:1.2fr 1fr 1fr; background:#8B292F;">
          ${['Phase', 'Builder', 'Strategist'].map(h => `<div style="padding:16px 20px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:700; color:#B08D57; letter-spacing:0.08em; text-transform:uppercase;">${h}</div>`).join('')}
        </div>
        ${[
          ['Install', 'Weekly', 'Weekly', '#F3EEE5'],
          ['Optimize', '2x / month', '1x / month', '#EDE8DC'],
          ['Stewardship', '1x / month', 'As scoped', '#F3EEE5'],
        ].map(([phase, builder, strat, bg]) => `
          <div style="display:grid; grid-template-columns:1.2fr 1fr 1fr; background:${bg}; border-top:1px solid rgba(176,141,87,0.15);">
            <div style="padding:20px; font-family:'Montserrat',sans-serif; font-size:17px; font-weight:600; color:#1F1F1F;">${phase}</div>
            <div style="padding:20px; font-family:'Montserrat',sans-serif; font-size:17px; color:#524B3A; border-left:1px solid rgba(176,141,87,0.15);">${builder}</div>
            <div style="padding:20px; font-family:'Montserrat',sans-serif; font-size:17px; color:#524B3A; border-left:1px solid rgba(176,141,87,0.15);">${strat}</div>
          </div>
        `).join('')}
      </div>
      <div class="bottom-line" style="font-size:15px; padding-top:16px;">Strategy decides what should happen. Building makes it real.</div>
    </div>
  </div>
</div>
`));

// SLIDE 21 — What You're Really Buying (Not this / This)
slides.push(slideHTML(21, `
<div class="content" style="padding-top:48px;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:10px;">The Investment</div>
  <div class="headline" style="font-size:60px; color:#8B292F; margin-bottom:6px;">What You're Really Buying</div>
  <div class="gold-divider" style="margin:14px 0 28px;"></div>
  <div style="display:flex; gap:40px; flex:1; align-items:stretch;">
    <!-- Not this -->
    <div style="flex:1; background:#F3EEE5; border-radius:14px; padding:36px 32px; border:1px solid rgba(89,89,89,0.2); display:flex; flex-direction:column; opacity:0.85;">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#595959; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:16px;">Not This</div>
      <div style="height:2px; background:#e0d8cc; width:50px; border-radius:2px; margin-bottom:24px;"></div>
      <div style="display:flex; flex-direction:column; gap:20px; flex:1; justify-content:center;">
        ${['Not a CRM tweak', 'Not a one-time automation project', 'Not generic intake advice', 'Not another software subscription'].map(item => `
          <div style="display:flex; align-items:center; gap:16px;">
            <div style="width:28px; height:28px; border-radius:50%; background:#e0d8cc; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <div style="width:12px; height:2px; background:#999; border-radius:1px;"></div>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:19px; color:#595959; text-decoration:line-through; text-decoration-color:#999;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <!-- Arrow -->
    <div style="display:flex; align-items:center; font-size:56px; color:#B08D57; font-weight:300;">→</div>
    <!-- This -->
    <div style="flex:1; background:#8B292F; border-radius:14px; padding:36px 32px; display:flex; flex-direction:column; box-shadow:0 12px 36px rgba(139,41,47,0.28);">
      <div style="font-family:'Montserrat',sans-serif; font-size:12px; font-weight:700; color:#B08D57; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:16px;">This</div>
      <div style="height:2px; background:#B08D57; width:50px; border-radius:2px; margin-bottom:24px;"></div>
      <div style="display:flex; flex-direction:column; gap:20px; flex:1; justify-content:center;">
        ${[
          'A lead-to-consult operating system',
          'Scripts, workflows, automations, reporting, and documentation',
          'A team that builds, launches, refines, and maintains it',
          'A system that protects the revenue currently leaking between lead and consult',
        ].map(item => `
          <div style="display:flex; align-items:flex-start; gap:16px;">
            <div style="width:28px; height:28px; border-radius:50%; background:#B08D57; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5L5.5 10L11 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:#F3EEE5; line-height:1.45; font-weight:500;">${item}</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
  <div class="bottom-line" style="font-size:16px; padding-top:16px;">You are buying back the revenue your intake process is currently losing.</div>
</div>
`));

// SLIDE 22 — Next Steps
slides.push(slideHTML(22, `
<div class="content" style="padding-top:50px; align-items:center; text-align:center;">
  <div style="font-family:'Montserrat',sans-serif; font-size:14px; font-weight:700; color:#B08D57; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:14px;">Let's Get Started</div>
  <div class="headline-lg" style="font-size:60px; color:#8B292F; max-width:1100px; margin:0 auto 8px;">Ready to Build Your CaseIntake System?</div>
  <div class="gold-divider" style="margin:18px auto 32px;"></div>
  <!-- 4-step process -->
  <div style="display:flex; align-items:center; gap:0; justify-content:center; width:100%; margin-bottom:36px;">
    ${[
      ['01', 'Approve CaseIntake\nEngagement'],
      ['02', 'Schedule\nDiscovery'],
      ['03', 'Map Current Intake\nWorkflow'],
      ['04', 'Begin\nBuild Sprint'],
    ].map(([num, label], i) => `
      <div style="display:flex; align-items:center;">
        <div style="display:flex; flex-direction:column; align-items:center; gap:12px; width:220px;">
          <div style="width:80px; height:80px; border-radius:50%; background:#8B292F; border:3px solid #B08D57; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 20px rgba(139,41,47,0.25);">
            <div style="font-family:'Montserrat',sans-serif; font-size:24px; font-weight:700; color:#fff;">${num}</div>
          </div>
          <div style="font-family:'Montserrat',sans-serif; font-size:17px; font-weight:600; color:#1F1F1F; text-align:center; line-height:1.4; white-space:pre-line;">${label}</div>
        </div>
        ${i < 3 ? `<div style="width:60px; height:2px; background:linear-gradient(90deg,#B08D57,rgba(176,141,87,0.4)); margin-bottom:40px;"></div>` : ''}
      </div>
    `).join('')}
  </div>
  <!-- CTA box -->
  <div style="background:#8B292F; border-radius:16px; padding:36px 64px; border:2px solid #B08D57; box-shadow:0 16px 48px rgba(139,41,47,0.32); max-width:860px; width:100%;">
    <div style="font-family:'Crimson Pro',serif; font-size:36px; font-weight:700; color:#fff; margin-bottom:12px;">Schedule Your CaseIntake Discovery Session</div>
    <div style="height:2px; background:#B08D57; width:120px; border-radius:2px; margin:0 auto 16px;"></div>
    <div style="font-family:'Montserrat',sans-serif; font-size:18px; color:rgba(255,255,255,0.85);">NOBULLMARKETING.COM</div>
  </div>
  <div class="bottom-line" style="font-size:15px; padding-top:20px; text-align:center;">We start by finding the biggest intake leak, then build the system that plugs it.</div>
</div>
`));

// ─── RENDER ───────────────────────────────────────────────────────────────────
async function renderSlides() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
      '--disable-font-subpixel-positioning',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (let i = 0; i < slides.length; i++) {
    const num = String(i + 1).padStart(2, '0');
    const outPath = path.join(OUTPUT_DIR, `slide-${num}.png`);

    process.stdout.write(`Rendering slide ${num}/${slides.length}...`);

    await page.setContent(slides[i], {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 600));

    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    console.log(` ✓ ${outPath}`);
  }

  await browser.close();
  console.log(`\n✅ All ${slides.length} slides rendered to: ${OUTPUT_DIR}`);
}

renderSlides().catch(err => {
  console.error('Render failed:', err);
  process.exit(1);
});
