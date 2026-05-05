import { describe, it, expect } from 'vitest';
import { makeRateLimiter } from '../server/middleware/rateLimit.js';

describe('makeRateLimiter', () => {
  it('allows up to capacity then trips', () => {
    const rl = makeRateLimiter({ capacity: 3, refillPerSec: 0, name: 't' });
    const now = 1_000_000;
    expect(rl.consume('k', now).ok).toBe(true);
    expect(rl.consume('k', now).ok).toBe(true);
    expect(rl.consume('k', now).ok).toBe(true);
    expect(rl.consume('k', now).ok).toBe(false);
  });

  it('refills over time', () => {
    const rl = makeRateLimiter({ capacity: 1, refillPerSec: 1, name: 't' });
    const now = 1_000_000;
    expect(rl.consume('k', now).ok).toBe(true);
    expect(rl.consume('k', now).ok).toBe(false);
    expect(rl.consume('k', now + 1100).ok).toBe(true);
  });

  it('isolates buckets by key', () => {
    const rl = makeRateLimiter({ capacity: 1, refillPerSec: 0, name: 't' });
    const now = 1_000_000;
    expect(rl.consume('a', now).ok).toBe(true);
    expect(rl.consume('a', now).ok).toBe(false);
    expect(rl.consume('b', now).ok).toBe(true);
  });

  it('returns retryAfterSec when tripped', () => {
    const rl = makeRateLimiter({ capacity: 1, refillPerSec: 1 / 60, name: 't' });
    const now = 1_000_000;
    rl.consume('k', now);
    const tripped = rl.consume('k', now);
    expect(tripped.ok).toBe(false);
    expect(tripped.retryAfterSec).toBeGreaterThan(0);
  });
});
