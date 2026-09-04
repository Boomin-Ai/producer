// Crypto primitives. Three jobs:
//  1. Bearer capabilities (media gateway ids, connect nonces/states,
//     one-time PUT tokens): >=128-bit CSPRNG, hex — never logged.
//  2. Platform OAuth tokens encrypted at rest in D1 with AES-GCM under
//     TOKEN_ENCRYPTION_KEY (a worker secret, never in the database).
//  3. Constant-time token comparison for bearer auth.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 hex chars = 128 bits — the minimum for any public capability. */
export const randomCapability = () => randomId(16);

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decryptSecret(encoded: string, secret: string): Promise<string> {
  const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const key = await aesKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) },
    key,
    raw.slice(12),
  );
  return decoder.decode(plain);
}

// ── Guest-layer primitives ───────────────────────────────────────────────────
// Base64url + HMAC-SHA256 back the 120-second signaling tickets, and
// randomToken mints the prefixed guest capability codes (gi_/gr_) that are
// stored hashed and shown exactly once.

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Prefixed so a code that leaks into a log or a screenshare is identifiable
 *  at a glance as to which secret it is and what to revoke. */
export function randomToken(prefix = "", bytes = 24): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return `${prefix}${base64Url(random)}`;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSign(input: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(input));
  return base64Url(new Uint8Array(signature));
}

export async function hmacVerify(input: string, signature: string, secret: string): Promise<boolean> {
  return crypto.subtle.verify("HMAC", await hmacKey(secret), base64UrlToBytes(signature), encoder.encode(input));
}
