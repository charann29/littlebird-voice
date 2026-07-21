/**
 * Token encryption + OAuth state signing (section 40).
 *
 * - Tokens: AES-256-GCM via WebCrypto. Key = 32 bytes base64 in the
 *   `INTEGRATIONS_TOKEN_KEY` secret, imported once per isolate. Each encrypt
 *   uses a fresh random 12-byte IV; ciphertext is stored as
 *   base64(iv || ciphertext || tag) — WebCrypto appends the 16-byte tag to
 *   the ciphertext output already.
 * - State: `state = <id>.<hex hmac-sha256(id)>` using `OAUTH_STATE_SIGNING_KEY`
 *   so a forged id never even hits the DB. Verification is constant-time.
 */

const AES_KEY_CACHE = new Map<string, Promise<CryptoKey>>();
const HMAC_KEY_CACHE = new Map<string, Promise<CryptoKey>>();

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length leak only). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function getAesKey(keyB64: string): Promise<CryptoKey> {
  let cached = AES_KEY_CACHE.get(keyB64);
  if (!cached) {
    const raw = b64decode(keyB64);
    if (raw.length !== 32) {
      throw new Error(
        `INTEGRATIONS_TOKEN_KEY must be 32 bytes base64 (got ${raw.length} bytes)`,
      );
    }
    cached = crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    AES_KEY_CACHE.set(keyB64, cached);
  }
  return cached;
}

function getHmacKey(secret: string): Promise<CryptoKey> {
  let cached = HMAC_KEY_CACHE.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    HMAC_KEY_CACHE.set(secret, cached);
  }
  return cached;
}

/** Encrypt a plaintext token → base64(iv || ciphertext || tag). */
export async function encryptToken(
  plaintext: string,
  keyB64: string,
): Promise<string> {
  const key = await getAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

/** Decrypt base64(iv || ciphertext || tag) → plaintext. Throws on tampering. */
export async function decryptToken(
  encoded: string,
  keyB64: string,
): Promise<string> {
  const key = await getAesKey(keyB64);
  const bytes = b64decode(encoded);
  if (bytes.length < 12 + 16) throw new Error("Ciphertext too short");
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

/** Generate a random state id (32 bytes hex). */
export function generateStateId(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return hexEncode(new Uint8Array(sig));
}

/** `<id>` → `<id>.<hex hmac>` — the value sent as the OAuth `state` param. */
export async function signState(id: string, secret: string): Promise<string> {
  return `${id}.${await hmacHex(id, secret)}`;
}

/** Verify a `state` param; returns the id when the signature checks out,
 *  null otherwise (forged states never reach the DB). */
export async function verifyState(
  state: string,
  secret: string,
): Promise<string | null> {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const id = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = await hmacHex(id, secret);
  return constantTimeEqual(sig, expected) ? id : null;
}
