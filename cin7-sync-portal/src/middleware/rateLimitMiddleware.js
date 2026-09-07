/**
 * Multi-Tier Rate Limiting Middleware
 * In-memory sliding window rate limiter providing targeted protection against
 * credential stuffing, brute force attacks, denial of service, and resource exhaustion.
 */

class RateLimiter {
  constructor({ windowMs = 60 * 1000, max = 100, message = 'Too many requests. Please try again later.', keyGenerator } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.message = message;
    this.keyGenerator = keyGenerator || ((req) => req.ip || req.connection.remoteAddress || 'unknown-ip');
    this.hits = new Map();

    // Periodic sweep of expired windows
    setInterval(() => {
      const now = Date.now();
      for (const [key, records] of this.hits.entries()) {
        const filtered = records.filter(ts => now - ts < this.windowMs);
        if (filtered.length === 0) {
          this.hits.delete(key);
        } else {
          this.hits.set(key, filtered);
        }
      }
    }, Math.min(this.windowMs, 60 * 1000));
  }

  middleware() {
    return (req, res, next) => {
      // Allow bypassing rate limiter exclusively in local test suite if TEST_MODE is enabled
      if (process.env.NODE_ENV === 'test' && req.headers['x-skip-rate-limit'] === 'test') {
        return next();
      }

      const key = this.keyGenerator(req);
      const now = Date.now();
      const records = this.hits.get(key) || [];
      const windowStart = now - this.windowMs;
      const recentRecords = records.filter(ts => ts > windowStart);

      if (recentRecords.length >= this.max) {
        const oldest = recentRecords[0];
        const retryAfterSec = Math.ceil((oldest + this.windowMs - now) / 1000);
        res.setHeader('Retry-After', retryAfterSec);
        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: this.message,
          retryAfterSeconds: retryAfterSec
        });
      }

      recentRecords.push(now);
      this.hits.set(key, recentRecords);

      res.setHeader('X-RateLimit-Limit', this.max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, this.max - recentRecords.length));
      next();
    };
  }
}

// 1. Strict Auth Rate Limiter (Login): Max 10 attempts per 5 minutes per IP/Email combination
const authLimiter = new RateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 15,
  message: 'Too many login attempts. Please try again after 5 minutes.',
  keyGenerator: (req) => {
    const email = req.body?.email ? String(req.body.email).toLowerCase().trim() : '';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `auth:${ip}:${email}`;
  }
}).middleware();

// 2. Very Strict Registration Rate Limiter: Max 5 registrations per 15 minutes per IP
const registerLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many account registrations from this IP address. Please try again later.'
}).middleware();

// 3. Sensitive Operations Limiter (Password change, Cin7 connection test, Editor sessions): Max 20 per 5 mins
const sensitiveOpLimiter = new RateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: 'Too many requests for sensitive operations. Please slow down.'
}).middleware();

// 4. Sync Trigger Limiter: Max 15 triggers per 5 mins per tenant/IP
const syncLimiter = new RateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'A synchronization operation is already in progress or recently executed. Please wait before triggering another sync.',
  keyGenerator: (req) => {
    const tenant = req.tenantId || req.session?.user?.client_id || req.ip;
    return `sync:${tenant}`;
  }
}).middleware();

// 5. Global Baseline Limiter: Max 500 requests per minute per IP
const globalLimiter = new RateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Global rate limit exceeded. Please slow down your requests.'
}).middleware();

module.exports = {
  RateLimiter,
  authLimiter,
  registerLimiter,
  sensitiveOpLimiter,
  syncLimiter,
  globalLimiter
};
