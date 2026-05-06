// RFC 6238 TOTP — HMAC-SHA1, 30-second step, 6 digits.
//
// Used by the /cron/recurring-tick endpoint to authenticate inbound pings
// from a GitHub Action without a session cookie. The same logic ships as
// scripts/totp-code.js so the GH Action can compute the current code with
// nothing but Node's standard library.
//
// Secret format: this module accepts a hex string, a base32 string (RFC
// 4648, the format used by Google Authenticator etc.), or a raw utf-8
// string. parseSecret() picks based on the character set. We do NOT throw
// for ambiguous inputs — both "DEADBEEFCAFE" (12 valid hex chars) and
// "deadbeef" (8 valid hex chars) decode as hex, while "deadbeef-secret"
// falls through to utf-8.

import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALGORITHM = 'sha1';

function counterFor(unixSeconds) {
  return Math.floor(unixSeconds / STEP_SECONDS);
}

function counterBuffer(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

function hotp(secretBuf, counter) {
  const digest = crypto.createHmac(ALGORITHM, secretBuf).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset]     & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) <<  8) |
     (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Generate the current TOTP code for a given secret. Mainly used by tests
// and scripts/totp-code.js; verifyTotp is what the route calls.
export function generateTotp(secret, { now = Date.now() } = {}) {
  const secretBuf = parseSecret(secret);
  return hotp(secretBuf, counterFor(Math.floor(now / 1000)));
}

// Verify a 6-digit code against the secret. The window parameter controls
// clock-skew tolerance: window=1 (default) accepts the previous, current,
// and next 30-second windows (±30s). Constant-time comparison so a
// network-timing attacker can't probe digit-by-digit.
export function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const secretBuf = parseSecret(secret);
  const t = counterFor(Math.floor(now / 1000));
  const codeBuf = Buffer.from(code, 'utf8');
  let match = false;
  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = Buffer.from(hotp(secretBuf, t + drift), 'utf8');
    // Don't short-circuit — keep loop time ≈ constant across the window.
    if (crypto.timingSafeEqual(candidate, codeBuf)) match = true;
  }
  return match;
}

export function parseSecret(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('totp_invalid_secret');
  }
  // Hex: require at least one a-f letter so an all-digits ASCII string
  // (e.g. RFC 6238's test secret "12345678901234567890") doesn't get
  // mis-decoded as hex. Real-world `openssl rand -hex 20` output has
  // a-f letters with overwhelming probability.
  if (
    /^[0-9a-fA-F]+$/.test(secret) &&
    /[a-fA-F]/.test(secret) &&
    secret.length % 2 === 0 &&
    secret.length >= 16
  ) {
    return Buffer.from(secret, 'hex');
  }
  // Base32 (RFC 4648; otpauth:// standard format). Disjoint from hex —
  // base32 alphabet is A-Z + 2-7, so all-digit hex strings never match.
  if (/^[A-Z2-7]+=*$/i.test(secret) && /[A-Z]/i.test(secret) && secret.length >= 8) {
    return base32Decode(secret);
  }
  // Fallback: utf-8 raw bytes (covers the RFC test secret + anything else).
  return Buffer.from(secret, 'utf8');
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const stripped = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of stripped) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('totp_invalid_base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}
