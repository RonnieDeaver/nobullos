/* test-registration
{
  "name": "Comms markdown rendering — bold/italic/code/blocks/quotes/lists, XSS-safe (Task #3307)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3307: comms markdown rendering — the shared renderContent helper (used by both components/comms/MessageItem.tsx and the local MessagePane copy in pages/Comms.tsx) must render bold/italic/inline code/strike, fenced code blocks, blockquotes, and ordered/unordered lists as real elements with no raw marker characters visible, keep mention/@channel/ URL-linkify tokens working through the block path, and stay XSS-safe (HTML in message content is escaped — no innerHTML anywhere). Pure renderToStaticMarkup test: fast, DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3307 — Messages render markdown formatting instead of raw text.
 *
 * Verifies the shared comms renderContent helper (used by both
 * components/comms/MessageItem.tsx and the local MessagePane copy inside
 * pages/Comms.tsx) renders the markdown subset as real elements:
 * bold, italic, inline code, strikethrough, fenced code blocks, blockquotes,
 * ordered/unordered lists — with no raw marker characters visible and no
 * innerHTML (output is built purely from React elements, so HTML in message
 * content stays escaped).
 *
 * Run: TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx tests/client/comms-markdown-render.test.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderContent, stripFormatting } from "../../client/src/components/comms/helpers";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

function render(content: string): string {
  return renderToStaticMarkup(<>{renderContent(content)}</>);
}

// ── Inline formatting ────────────────────────────────────────────────────────
{
  const html = render("**bold** and *italic* and `code` and ~~gone~~");
  check("bold renders as <strong>", html.includes("<strong>bold</strong>"), html);
  check("italic renders as <em>", html.includes("<em>italic</em>"), html);
  check("inline code renders as <code>", /<code[^>]*>code<\/code>/.test(html), html);
  check("strikethrough renders as <s>", html.includes("<s>gone</s>"), html);
  check("no raw ** visible", !html.includes("**"), html);
  check("no raw ~~ visible", !html.includes("~~"), html);
}

// ── Underscore italics ───────────────────────────────────────────────────────
{
  const html = render("this is _emphasized_ text");
  check("underscore italic renders as <em>", html.includes("<em>emphasized</em>"), html);
  check("no raw _ markers around italic", !html.includes("_emphasized_"), html);
}
{
  const html = render("call get_user_name and MY_ENV_VAR stay literal");
  check("snake_case is not italicized", html.includes("get_user_name") && !html.includes("<em>"), html);
  check("SCREAMING_SNAKE is not italicized", html.includes("MY_ENV_VAR"), html);
}

// ── Code blocks ──────────────────────────────────────────────────────────────
{
  const html = render("before\n```\nconst x = 1;\nconst y = 2;\n```\nafter");
  check("fenced block renders as <pre>", html.includes("<pre"), html);
  check("code block keeps content", html.includes("const x = 1;"), html);
  check("no raw ``` visible", !html.includes("```"), html);
  check("text before/after block preserved", html.includes("before") && html.includes("after"), html);
}

// ── Blockquotes ──────────────────────────────────────────────────────────────
{
  const html = render("> quoted line one\n> quoted **two**");
  check("blockquote renders as <blockquote>", html.includes("<blockquote"), html);
  check("quote content present", html.includes("quoted line one"), html);
  check("inline markdown inside quote", html.includes("<strong>two</strong>"), html);
  check("no raw > marker at line start", !/&gt;\s*quoted/.test(html), html);
}

// ── Lists ────────────────────────────────────────────────────────────────────
{
  const ul = render("- first\n- **second**\n- third");
  check("unordered list renders as <ul>", ul.includes("<ul"), ul);
  check("ul has 3 <li>", (ul.match(/<li>/g) ?? []).length === 3, ul);
  check("inline markdown inside li", ul.includes("<strong>second</strong>"), ul);

  const ol = render("1. one\n2. two");
  check("ordered list renders as <ol>", ol.includes("<ol"), ol);
  check("ol has 2 <li>", (ol.match(/<li>/g) ?? []).length === 2, ol);

  const olStart = render("3. three\n4. four");
  check("ol respects start number", olStart.includes('start="3"'), olStart);
}

// ── Mixed document ───────────────────────────────────────────────────────────
{
  const html = render("intro **bold**\n> a quote\n- item a\n- item b\n```\ncode here\n```");
  check("mixed: strong present", html.includes("<strong>bold</strong>"), html);
  check("mixed: blockquote present", html.includes("<blockquote"), html);
  check("mixed: ul present", html.includes("<ul"), html);
  check("mixed: pre present", html.includes("<pre"), html);
}

// ── XSS safety: HTML in content is escaped, not injected ─────────────────────
{
  const html = render('**hi** <img src=x onerror=alert(1)> <script>alert(2)</script>');
  check("img tag escaped", !html.includes("<img"), html);
  check("script tag escaped", !html.includes("<script"), html);
  check("escaped entities present", html.includes("&lt;script&gt;"), html);
}

// ── Existing token behaviors keep working through the block path ─────────────
{
  const mention = render("hello @[Jane Doe](user:abc123) **now**");
  check("mention chip still renders", mention.includes("@Jane Doe"), mention);
  check("mention + markdown coexist", mention.includes("<strong>now</strong>"), mention);

  const bcast = render("> heads up @channel");
  check("@channel token inside blockquote", bcast.includes("@channel"), bcast);

  const url = render("- see https://example.com/docs");
  check("URL linkified inside list item", /<a[^>]*href="https:\/\/example\.com\/docs"/.test(url), url);
}

// ── Plain single-paragraph messages stay simple (no wrapper blocks) ──────────
{
  const html = render("just a plain message");
  check("plain text has no block wrappers", !html.includes("<ul") && !html.includes("<pre") && !html.includes("<blockquote"), html);
  check("plain text content intact", html.includes("just a plain message"), html);
}

// ── Task #3321: stripFormatting — plain-text previews/snippets ───────────────
// Used by one-line quoted surfaces (rail previews, thread snippets, drafts,
// scheduled one-liners, desktop notifications). Must remove every markdown
// marker while keeping the readable text, and convert mention tokens to @Name.
{
  const t = stripFormatting("**bold** and *italic* and _under_ and `code` and ~~gone~~");
  check("strip: bold markers removed", t === "bold and italic and under and code and gone", t);
}
{
  const t = stripFormatting("> quoted line\n- item one\n2. item two");
  check("strip: quote/list markers removed", t === "quoted line item one 2. item two", t);
}
{
  const t = stripFormatting("before\n```js\nconst x = 1;\n```\nafter");
  check("strip: fence markers removed, code kept", !t.includes("```") && t.includes("const x = 1;") && t.includes("before") && t.includes("after"), t);
}
{
  const t = stripFormatting("hi @[Jane Doe](user:abc123), see https://example.com");
  check("strip: mention token → @Name", t.includes("@Jane Doe") && !t.includes("user:abc123"), t);
  check("strip: URL left literal", t.includes("https://example.com"), t);
}
{
  check("strip: snake_case untouched", stripFormatting("call get_user_name now") === "call get_user_name now");
  check("strip: empty input", stripFormatting("") === "");
}

// ── Task #3321: quoted surfaces render markdown, no raw markers ──────────────
// Search results, pins, saved messages, forward preview, and the reschedule
// dialog all pass message content through renderContent now; verify a
// representative quoted snippet has zero raw markers in its markup.
{
  const html = render("**deal terms**: see `clause 4` and ~~old draft~~\n> per client");
  check("quoted surface: no raw markers", !html.includes("**") && !html.includes("~~") && !html.includes("`"), html);
  check("quoted surface: formatted elements present", html.includes("<strong>") && html.includes("<blockquote"), html);
}

console.log(failures === 0 ? "\nAll comms markdown render checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
