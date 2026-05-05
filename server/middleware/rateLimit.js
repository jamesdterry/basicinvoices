// In-memory token bucket. Single-machine; doesn't survive restart. Both fine here.

const MAX_BUCKETS = 10_000;

class LruBuckets {
  constructor(max = MAX_BUCKETS) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

export function makeRateLimiter({ capacity, refillPerSec, name = 'rl' }) {
  const buckets = new LruBuckets();

  function consume(key, now = Date.now()) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updated: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = (now - bucket.updated) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
      bucket.updated = now;
    }
    if (bucket.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - bucket.tokens) / refillPerSec);
      return { ok: false, retryAfterSec };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  function middleware(keyFn) {
    return function rateLimitMiddleware(req, res, next) {
      const key = keyFn(req);
      if (!key) return next();
      const result = consume(`${name}:${key}`);
      if (!result.ok) {
        res.set('Retry-After', String(result.retryAfterSec));
        return res.status(429).json({ error: 'rate_limited', retry_after: result.retryAfterSec });
      }
      next();
    };
  }

  return { consume, middleware, _buckets: buckets };
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
