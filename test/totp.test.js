import { describe, it, expect } from 'vitest';
import { generateTotp, verifyTotp, parseSecret } from '../server/lib/totp.js';

// RFC 6238 Appendix B test vectors (with HMAC-SHA1, 8-digit codes — we
// truncate to 6 digits, so we re-derive expectations against our own impl
// for the 6-digit happy path. The behavioral checks below are what
// matters: round-trip, skew window, base32 vs hex parsing.

describe('parseSecret', () => {
  it('decodes hex (≥ 16 chars, even length)', () => {
    const buf = parseSecret('00112233445566778899aabbccddeeff');
    expect(buf.length).toBe(16);
    expect(buf[0]).toBe(0x00);
    expect(buf[15]).toBe(0xff);
  });

  it('decodes base32 (RFC 4648)', () => {
    // 'JBSWY3DPEHPK3PXP' is the base32 encoding of 'Hello!\xde\xad\xbe\xef'
    const buf = parseSecret('JBSWY3DPEHPK3PXP');
    expect(buf.length).toBeGreaterThan(0);
    // Round-trip: encode our raw bytes back, ensure it decodes
    expect(buf[0]).toBe(0x48); // 'H'
  });

  it('falls back to utf-8 for free-form strings', () => {
    const buf = parseSecret('not-hex-or-base32!');
    expect(buf.length).toBe('not-hex-or-base32!'.length);
    expect(buf.toString('utf8')).toBe('not-hex-or-base32!');
  });

  it('throws on empty', () => {
    expect(() => parseSecret('')).toThrow('totp_invalid_secret');
  });
});

describe('generateTotp + verifyTotp round-trip', () => {
  const SECRET = '00112233445566778899aabbccddeeff00112233';
  const BASE_TIME_MS = 1700000000_000; // 2023-11-14T22:13:20Z

  it('generates a 6-digit code', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    expect(code).toMatch(/^\d{6}$/);
  });

  it('the same time + secret produces the same code', () => {
    const a = generateTotp(SECRET, { now: BASE_TIME_MS });
    const b = generateTotp(SECRET, { now: BASE_TIME_MS });
    expect(a).toBe(b);
  });

  it('codes change every 30 seconds', () => {
    const a = generateTotp(SECRET, { now: BASE_TIME_MS });
    const b = generateTotp(SECRET, { now: BASE_TIME_MS + 30_000 });
    expect(a).not.toBe(b);
  });

  it('codes do NOT change inside the same 30-second window', () => {
    // Snap to a window boundary: floor(now/30) → 30s window starts.
    const windowStart = Math.floor(BASE_TIME_MS / 30_000) * 30_000;
    const a = generateTotp(SECRET, { now: windowStart });
    const b = generateTotp(SECRET, { now: windowStart + 29_000 });
    expect(a).toBe(b);
  });

  it('verifies a freshly-generated code', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    expect(verifyTotp(SECRET, code, { now: BASE_TIME_MS })).toBe(true);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(SECRET, '000000', { now: BASE_TIME_MS })).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(verifyTotp(SECRET, '', { now: BASE_TIME_MS })).toBe(false);
    expect(verifyTotp(SECRET, '12345', { now: BASE_TIME_MS })).toBe(false);
    expect(verifyTotp(SECRET, '1234567', { now: BASE_TIME_MS })).toBe(false);
    expect(verifyTotp(SECRET, 'abcdef', { now: BASE_TIME_MS })).toBe(false);
    expect(verifyTotp(SECRET, null, { now: BASE_TIME_MS })).toBe(false);
  });

  it('accepts ±1 step skew by default', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    // Code generated at T=BASE should still verify ±29s either side.
    expect(verifyTotp(SECRET, code, { now: BASE_TIME_MS - 29_000 })).toBe(true);
    expect(verifyTotp(SECRET, code, { now: BASE_TIME_MS + 29_000 })).toBe(true);
  });

  it('rejects beyond the skew window', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    // 90 seconds away → outside ±1 step window
    expect(verifyTotp(SECRET, code, { now: BASE_TIME_MS + 90_000 })).toBe(false);
  });

  it('window=0 is strict (no skew tolerance)', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    // Cross a 30s boundary → different window, no slack allowed
    const otherWindow = Math.floor(BASE_TIME_MS / 30_000) * 30_000 + 30_000;
    expect(verifyTotp(SECRET, code, { now: otherWindow, window: 0 })).toBe(false);
  });

  it('rejects with a different secret', () => {
    const code = generateTotp(SECRET, { now: BASE_TIME_MS });
    const other = '0011223344556677889900112233445566778899';
    expect(verifyTotp(other, code, { now: BASE_TIME_MS })).toBe(false);
  });

  it('handles base32-encoded secrets the same as their hex equivalent', () => {
    // 16 bytes "Hello World\0\0\0\0\0" encoded both ways.
    const hex = '48656c6c6f20576f726c640000000000';
    const base32 = 'JBSWY3DPEBLW64TMMQAAAAAAAA';
    expect(generateTotp(base32, { now: BASE_TIME_MS })).toBe(
      generateTotp(hex, { now: BASE_TIME_MS })
    );
  });
});

describe('RFC 6238 Appendix B vectors (truncated to 6 digits)', () => {
  // The RFC vectors use the ASCII secret '12345678901234567890' (20 bytes)
  // with HMAC-SHA1. The 8-digit values from the RFC are:
  //   T = 59         → 94287082
  //   T = 1111111109 → 07081804
  //   T = 1111111111 → 14050471
  // Truncated to 6 digits (the last 6 characters):
  const SECRET_UTF8 = '12345678901234567890';
  const VECTORS = [
    { unixSeconds: 59,         expected6: '287082' },
    { unixSeconds: 1111111109, expected6: '081804' },
    { unixSeconds: 1111111111, expected6: '050471' },
  ];

  for (const v of VECTORS) {
    it(`matches RFC vector at unixSeconds=${v.unixSeconds}`, () => {
      const code = generateTotp(SECRET_UTF8, { now: v.unixSeconds * 1000 });
      expect(code).toBe(v.expected6);
    });
  }
});
