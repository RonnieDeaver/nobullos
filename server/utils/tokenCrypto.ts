import crypto from "crypto";

/**
 * Symmetric AES-256-GCM encryption helper used to protect long-lived OAuth
 * tokens at rest. The encryption key is derived from `TOKEN_ENCRYPTION_KEY`
 * (or, as a development fallback only, `SESSION_SECRET`) via SHA-256 so any
 * length input becomes a valid 32-byte key.
 *
 * Output format: `<iv-hex>:<auth-tag-hex>:<ciphertext-hex>` so a single string
 * column can store the full envelope.
 */
const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const raw =
    process.env.TOKEN_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    "";
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY (or SESSION_SECRET) must be set to encrypt tokens at rest.",
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptToken(envelope: string | null | undefined): string {
  if (!envelope) return "";
  const parts = envelope.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token envelope.");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Hash a public-facing opaque token before storing. Public tokens never live
 * in the database in plaintext — only their SHA-256 hash is persisted.
 */
export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a URL-safe random opaque token. Default 32 bytes → 43 char base64url.
 */
export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// HMAC-signed payload helpers (Task #1032E).
//
// Used to mint stateless "signed link" tokens (e.g. public booking
// cancel links) that don't require a database row. Format:
//
//   <purpose>.<base64url-payload>.<base64url-hmac>
//
// The HMAC is keyed by the same server secret used for encryptToken,
// so rotating that secret invalidates all outstanding signed tokens.
// ---------------------------------------------------------------------------

function getHmacKey(): Buffer {
  return getKey();
}

export function signHmacPayload(purpose: string, payload: string): string {
  const body = `${purpose}.${Buffer.from(payload, "utf8").toString("base64url")}`;
  const sig = crypto
    .createHmac("sha256", getHmacKey())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifyHmacPayload(
  purpose: string,
  token: string,
): string | null {
  if (typeof token !== "string" || token.length < 8 || token.length > 1024) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [tokenPurpose, payloadB64, sig] = parts;
  if (tokenPurpose !== purpose) return null;
  const expected = crypto
    .createHmac("sha256", getHmacKey())
    .update(`${tokenPurpose}.${payloadB64}`)
    .digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
