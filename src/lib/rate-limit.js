/**
 * Simple in-memory rate limiter.
 * Tracks requests per IP within a rolling time window.
 * Note: On serverless (Vercel), this resets on cold starts,
 * but still protects against rapid bursts within warm instances.
 */

const requests = new Map();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requests) {
    if (now - data.windowStart > data.windowMs * 2) {
      requests.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check if a request should be rate-limited.
 * @param {string} ip - The client IP address
 * @param {string} route - The route name (e.g., 'start', 'message')
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Window size in milliseconds
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
function checkRateLimit(ip, route, maxRequests = 30, windowMs = 10 * 60 * 1000) {
  const key = `${ip}:${route}`;
  const now = Date.now();

  let data = requests.get(key);

  if (!data || now - data.windowStart > windowMs) {
    // New window
    data = { count: 1, windowStart: now, windowMs };
    requests.set(key, data);
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  data.count += 1;

  if (data.count > maxRequests) {
    const retryAfterMs = windowMs - (now - data.windowStart);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  return { allowed: true, remaining: maxRequests - data.count, retryAfterMs: 0 };
}

/**
 * Get client IP from Next.js request.
 */
function getClientIP(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

export { checkRateLimit, getClientIP };
