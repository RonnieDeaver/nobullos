/* test-registration
{
  "name": "Upload content verification engine (audit A-006, Task #3964) — magic-byte sniffing, per-kind caps, reader flow, delete entitlement, ATS namespace binding",
  "regression": true,
  "smoke": true,
  "smokeReason": "Presigned PUT URLs are unconstrained at mint time (the sidecar signing protocol binds only host+method+expiry), so this evaluate/sniff layer is the ONLY enforcement between an uploader and storing arbitrary oversized or mistyped bytes that the feedback, ATS, and heatmap accept flows would then attach. A regression here (a format misclassified, a cap comparison inverted, unrecognized bytes accepted) silently reopens A-006. DB-free, pure functions plus an in-memory fake reader; fast and deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #3964 (audit A-006) — unit coverage for
 * server/replit_integrations/object_storage/uploadContentVerification.ts:
 *
 *   A. sniffUploadFormat classifies every supported container from real
 *      magic bytes (images: png/jpeg/gif/webp/bmp/tiff/heic/avif; videos:
 *      mp4-family/quicktime/webm/mkv/ogg/avi) and returns null for
 *      arbitrary/HTML/truncated bytes — null is a rejection, never a pass.
 *   B. evaluateUploadContent verdict order: empty → unrecognized →
 *      disallowed kind → cap, with exact boundary semantics (== cap passes,
 *      cap+1 rejects).
 *   C. verifyUploadObjectContent reads size first and skips the head read
 *      entirely for empty objects (a ranged GET on a zero-byte object can
 *      416), and requests at most UPLOAD_SNIFF_HEAD_BYTES.
 *   D. rejectedUploadDeleteAllowed pins the race-safe delete entitlement
 *      table, and the ATS candidate-bound namespace helpers pin the exact
 *      accept/reject set for portal video object paths (generic-namespace
 *      submissions being accepted is the review-flagged regression).
 *
 * Everything runs against in-memory bytes and a fake reader: no DB, no
 * object storage, no network.
 */
import assert from "node:assert/strict";

import {
  evaluateUploadContent,
  rejectedUploadDeleteAllowed,
  sniffUploadFormat,
  verifyUploadObjectContent,
  UPLOAD_SNIFF_HEAD_BYTES,
  type UploadContentConstraints,
  type UploadObjectReader,
} from "../server/replit_integrations/object_storage/uploadContentVerification";
import {
  atsCandidateVideoUploadPrefix,
  isAtsCandidateVideoObjectPath,
} from "../server/services/atsVideoUploads";

let failures = 0;
function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err: any) => {
      failures += 1;
      console.error(`  FAIL ${name}:`, err?.message ?? err);
      if (err?.stack) console.error(err.stack);
    });
}

// ── Byte builders ─────────────────────────────────────────────────────────────

function bytes(...parts: Array<number[] | string | Uint8Array>): Uint8Array {
  const chunks: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) chunks.push(ch.charCodeAt(0));
    } else {
      chunks.push(...Array.from(part));
    }
  }
  return new Uint8Array(chunks);
}

const pad = (n: number) => new Uint8Array(n); // zero filler

const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], pad(64));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], pad(64));
const GIF = bytes("GIF89a", pad(64));
const WEBP = bytes("RIFF", [0x10, 0x00, 0x00, 0x00], "WEBP", pad(64));
const BMP = bytes("BM", pad(64));
const TIFF_LE = bytes([0x49, 0x49, 0x2a, 0x00], pad(64));
const TIFF_BE = bytes([0x4d, 0x4d, 0x00, 0x2a], pad(64));
const HEIC = bytes([0x00, 0x00, 0x00, 0x18], "ftypheic", pad(64));
const AVIF = bytes([0x00, 0x00, 0x00, 0x18], "ftypavif", pad(64));
const MP4 = bytes([0x00, 0x00, 0x00, 0x18], "ftypisom", pad(64));
const M4V = bytes([0x00, 0x00, 0x00, 0x18], "ftypM4V ", pad(64));
const QT_FTYP = bytes([0x00, 0x00, 0x00, 0x14], "ftypqt  ", pad(64));
const QT_LEGACY = bytes([0x00, 0x00, 0x10, 0x00], "mdat", pad(64));
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], pad(16), "webm", pad(64));
const MKV = bytes([0x1a, 0x45, 0xdf, 0xa3], pad(16), "matroska", pad(64));
const OGG = bytes("OggS", pad(64));
const AVI = bytes("RIFF", [0x10, 0x00, 0x00, 0x00], "AVI ", pad(64));
const HTML = bytes("<html><script>alert(1)</script>", pad(64));
const RANDOM = bytes([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07], pad(64));
const TRUNCATED = bytes([0x89, 0x50]); // 2 bytes — below every magic length

// ── Constraint fixtures ───────────────────────────────────────────────────────

const IMAGE_10MB: UploadContentConstraints = { kinds: { image: { maxBytes: 10 * 1024 * 1024 } } };
const VIDEO_50MB: UploadContentConstraints = { kinds: { video: { maxBytes: 50 * 1024 * 1024 } } };
const BOTH: UploadContentConstraints = {
  kinds: { image: { maxBytes: 1000 }, video: { maxBytes: 2000 } },
};

async function main(): Promise<void> {
  console.log("Upload content verification engine (audit A-006, Task #3964)");

  // ── A. Sniffing ─────────────────────────────────────────────────────────────
  await step("images classify with canonical MIME types", () => {
    const cases: Array<[Uint8Array, string, string]> = [
      [PNG, "png", "image/png"],
      [JPEG, "jpeg", "image/jpeg"],
      [GIF, "gif", "image/gif"],
      [WEBP, "webp", "image/webp"],
      [BMP, "bmp", "image/bmp"],
      [TIFF_LE, "tiff", "image/tiff"],
      [TIFF_BE, "tiff", "image/tiff"],
      [HEIC, "heif", "image/heic"],
      [AVIF, "avif", "image/avif"],
    ];
    for (const [buf, format, mime] of cases) {
      const sniffed = sniffUploadFormat(buf);
      assert.ok(sniffed, `${format} sniffed`);
      assert.equal(sniffed.kind, "image", `${format} is image`);
      assert.equal(sniffed.format, format);
      assert.equal(sniffed.mime, mime);
    }
  });

  await step("videos classify with canonical MIME types", () => {
    const cases: Array<[Uint8Array, string, string]> = [
      [MP4, "mp4-family", "video/mp4"],
      [M4V, "mp4-family", "video/mp4"],
      [QT_FTYP, "quicktime", "video/quicktime"],
      [QT_LEGACY, "quicktime-legacy", "video/quicktime"],
      [WEBM, "webm", "video/webm"],
      [MKV, "mkv", "video/x-matroska"],
      [OGG, "ogg", "video/ogg"],
      [AVI, "avi", "video/x-msvideo"],
    ];
    for (const [buf, format, mime] of cases) {
      const sniffed = sniffUploadFormat(buf);
      assert.ok(sniffed, `${format} sniffed`);
      assert.equal(sniffed.kind, "video", `${format} is video`);
      assert.equal(sniffed.format, format);
      assert.equal(sniffed.mime, mime);
    }
  });

  await step("unsupported bytes sniff to null (rejection, never a pass)", () => {
    assert.equal(sniffUploadFormat(HTML), null, "HTML is not a media container");
    assert.equal(sniffUploadFormat(RANDOM), null, "arbitrary bytes");
    assert.equal(sniffUploadFormat(TRUNCATED), null, "2 bytes is below every magic length");
    assert.equal(sniffUploadFormat(new Uint8Array(0)), null, "empty head");
    // RIFF containers other than WEBP/AVI (e.g. WAV audio) are not accepted.
    assert.equal(sniffUploadFormat(bytes("RIFF", pad(4), "WAVE", pad(16))), null, "RIFF/WAVE");
  });

  // ── B. evaluateUploadContent ────────────────────────────────────────────────
  await step("empty object rejects before sniffing", () => {
    for (const sizeBytes of [0, -1, NaN]) {
      const v = evaluateUploadContent({ sizeBytes, headBytes: PNG, constraints: IMAGE_10MB });
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.reason, "empty_object", `size=${sizeBytes}`);
    }
  });

  await step("unrecognized content rejects", () => {
    const v = evaluateUploadContent({ sizeBytes: 500, headBytes: HTML, constraints: BOTH });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.reason, "unrecognized_content");
      assert.equal(v.sniffed, null);
    }
  });

  await step("kind not in constraints rejects as disallowed_type", () => {
    const v = evaluateUploadContent({ sizeBytes: 500, headBytes: MP4, constraints: IMAGE_10MB });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.reason, "disallowed_type");
      assert.equal(v.sniffed?.kind, "video");
    }
    const w = evaluateUploadContent({ sizeBytes: 500, headBytes: PNG, constraints: VIDEO_50MB });
    assert.equal(w.ok, false);
    if (!w.ok) assert.equal(w.reason, "disallowed_type");
  });

  await step("cap boundary: exactly maxBytes passes, maxBytes+1 rejects as too_large", () => {
    const atCap = evaluateUploadContent({ sizeBytes: 1000, headBytes: PNG, constraints: BOTH });
    assert.equal(atCap.ok, true, "size == cap passes");
    const overCap = evaluateUploadContent({ sizeBytes: 1001, headBytes: PNG, constraints: BOTH });
    assert.equal(overCap.ok, false);
    if (!overCap.ok) assert.equal(overCap.reason, "too_large");
    // Video cap is independent of the image cap.
    const videoUnder = evaluateUploadContent({ sizeBytes: 1500, headBytes: WEBM, constraints: BOTH });
    assert.equal(videoUnder.ok, true, "1500 is within the 2000 video cap");
  });

  await step("ok verdict carries size + sniffed format", () => {
    const v = evaluateUploadContent({ sizeBytes: 700, headBytes: HEIC, constraints: IMAGE_10MB });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.sizeBytes, 700);
      assert.equal(v.sniffed.mime, "image/heic");
    }
  });

  // ── C. verifyUploadObjectContent reader flow ────────────────────────────────
  function makeReader(sizeBytes: number, head: Uint8Array) {
    const calls: { size: number; heads: number[] } = { size: 0, heads: [] };
    const reader: UploadObjectReader = {
      async getSizeBytes() {
        calls.size += 1;
        return sizeBytes;
      },
      async readHead(maxBytes: number) {
        calls.heads.push(maxBytes);
        return head.slice(0, maxBytes);
      },
    };
    return { reader, calls };
  }

  await step("empty object short-circuits without a head read", async () => {
    const { reader, calls } = makeReader(0, PNG);
    const v = await verifyUploadObjectContent(reader, IMAGE_10MB);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "empty_object");
    assert.equal(calls.heads.length, 0, "no ranged read on an empty object");
  });

  await step("head read is capped at UPLOAD_SNIFF_HEAD_BYTES and at the object size", async () => {
    const big = makeReader(10 * UPLOAD_SNIFF_HEAD_BYTES, PNG);
    const v1 = await verifyUploadObjectContent(big.reader, IMAGE_10MB);
    assert.equal(v1.ok, true);
    assert.deepEqual(big.calls.heads, [UPLOAD_SNIFF_HEAD_BYTES], "large object → sniff window only");

    const small = makeReader(100, PNG);
    const v2 = await verifyUploadObjectContent(small.reader, IMAGE_10MB);
    assert.equal(v2.ok, true);
    assert.deepEqual(small.calls.heads, [100], "small object → its own size");
  });

  await step("reader flow rejects a lying upload end-to-end (video bytes, image-only flow)", async () => {
    const { reader } = makeReader(4096, QT_FTYP);
    const v = await verifyUploadObjectContent(reader, IMAGE_10MB);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "disallowed_type");
  });

  // ── D. race-safe delete entitlement + ATS candidate-bound namespace ──

  await step("rejectedUploadDeleteAllowed: unclaimed objects are always deletable", () => {
    assert.equal(rejectedUploadDeleteAllowed(null, null), true);
    assert.equal(rejectedUploadDeleteAllowed(undefined, null), true);
    assert.equal(rejectedUploadDeleteAllowed(null, "user-1"), true);
    assert.equal(rejectedUploadDeleteAllowed("", "user-1"), true, "empty owner = unclaimed");
  });

  await step("rejectedUploadDeleteAllowed: claimed objects need an exact owner match", () => {
    assert.equal(rejectedUploadDeleteAllowed("user-1", "user-1"), true, "still owned by the entitled claimant");
    assert.equal(
      rejectedUploadDeleteAllowed("user-1", null),
      false,
      "unclaimed-only entitlement must never delete a claimed object (the TOCTOU race)",
    );
    assert.equal(rejectedUploadDeleteAllowed("user-1", "user-2"), false, "foreign owner never deletable");
  });

  const CANDIDATE = "0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b";
  const OTHER_CANDIDATE = "ffffffff-ffff-4fff-9fff-ffffffffffff";

  await step("atsCandidateVideoUploadPrefix binds the mint namespace to the candidate", () => {
    assert.equal(atsCandidateVideoUploadPrefix(CANDIDATE), `ats-${CANDIDATE}`);
    // sanitizeObjectKeyPrefix caps a segment at 40 chars — "ats-" + UUID is exactly 40,
    // so the candidate-bound prefix can never silently fall back to `uploads`.
    assert.equal(`ats-${CANDIDATE}`.length, 40);
    // Bad ids must yield null (mint refuses), NEVER a degraded generic prefix.
    assert.equal(atsCandidateVideoUploadPrefix(""), null);
    assert.equal(atsCandidateVideoUploadPrefix("UPPER-Case-Id"), null);
    assert.equal(atsCandidateVideoUploadPrefix("has/slash"), null);
    assert.equal(atsCandidateVideoUploadPrefix("under_score"), null);
    assert.equal(atsCandidateVideoUploadPrefix("a".repeat(37)), null);
  });

  await step("isAtsCandidateVideoObjectPath accepts ONLY this candidate's namespace", () => {
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/abc123.webm`, CANDIDATE), true);
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/0f3a-uuid-tail`, CANDIDATE), true);
  });

  await step("REGRESSION: generic and other-flow upload paths are rejected for ATS submit", () => {
    // The exact hole review round 1 flagged: an unclaimed object minted by
    // any OTHER presigned-upload flow must never be submittable as an ATS
    // video response.
    assert.equal(isAtsCandidateVideoObjectPath("/objects/uploads/abc123", CANDIDATE), false, "generic mint namespace");
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${OTHER_CANDIDATE}/abc123`, CANDIDATE), false, "another candidate's namespace");
    assert.equal(isAtsCandidateVideoObjectPath("/objects/feedback-uploads/abc123", CANDIDATE), false, "feedback namespace");
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/nested/extra`, CANDIDATE), false, "extra path segment");
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/`, CANDIDATE), false, "empty object id");
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/.dotfirst`, CANDIDATE), false, "tail must start alphanumeric");
    assert.equal(isAtsCandidateVideoObjectPath(`ats-${CANDIDATE}/abc`, CANDIDATE), false, "must be /objects/-rooted");
    assert.equal(isAtsCandidateVideoObjectPath(42, CANDIDATE), false, "non-string path");
    assert.equal(isAtsCandidateVideoObjectPath(`/objects/ats-${CANDIDATE}/abc`, "UPPER"), false, "invalid candidate id matches nothing");
  });

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("\nAll upload content verification steps passed");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
