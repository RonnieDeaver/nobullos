// Tiny synchronous image-dimension reader used at GENERATE time to stamp
// intrinsic width/height attributes onto <img> tags (CLS hardening — lazy
// images must reserve their box before they load). Supports the formats
// present in the bundle: PNG, JPEG, WebP (lossy/lossless/extended), GIF.
// Returns null for anything it cannot parse — callers then omit the
// attributes rather than guessing.

import fs from "node:fs";

export interface ImgDims {
  width: number;
  height: number;
}

export function imageDims(absPath: string): ImgDims | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.length < 30) return null;

  // PNG: 8-byte signature, IHDR width/height at offsets 16/20 (big-endian).
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF8" + 16-bit LE logical screen size.
  if (buf.toString("ascii", 0, 4) === "GIF8") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: RIFF container, dimensions depend on the first chunk type.
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      // Extended: 24-bit canvas size minus one at offsets 24/27.
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8 ") {
      // Lossy: 14-bit dimensions after the 3-byte frame tag + start code.
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      // Lossless: signature byte then 14+14 bits (minus one) packed LE.
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return null;
  }

  // JPEG: scan segment markers for the first SOFn frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      // Standalone markers (SOI/EOI/RSTn/TEM) carry no length field.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          width: buf.readUInt16BE(off + 7),
          height: buf.readUInt16BE(off + 5),
        };
      }
      if (marker === 0xda) return null; // entropy data reached without SOF
      off += 2 + len;
    }
    return null;
  }

  // SVG: text markup — width/height attributes (px or unitless), falling
  // back to the viewBox size.
  const head = buf.toString("utf8", 0, Math.min(buf.length, 2048));
  const svgAt = head.indexOf("<svg");
  if (svgAt !== -1) {
    const tag = head.slice(svgAt, head.indexOf(">", svgAt) + 1 || undefined);
    const attr = (name: string): number | null => {
      const m = tag.match(new RegExp(`[\\s"']${name}\\s*=\\s*["']([0-9.]+)(?:px)?["']`));
      return m ? Math.round(parseFloat(m[1])) : null;
    };
    const w = attr("width");
    const h = attr("height");
    if (w && h) return { width: w, height: h };
    const vb = tag.match(
      /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/,
    );
    if (vb) {
      return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
    }
    return null;
  }

  return null;
}
