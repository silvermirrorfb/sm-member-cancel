import crypto from 'crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/**
 * Shared rate-limit helper.
 *
 * Behavior:
 * - Uses Upstash Redis when configured (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
 * - Falls back to in-memory counters when Redis is not configured or temporarily unavailable
 * - Supports per-route policies, shadow mode, and fail-open / fail-closed behavior
 *
 * Note: the in-memory fallback still resets on serverless cold starts.
 */

const requests = new Map();
const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_PREFIX = 'sm-cancel-bot:ratelimit';
const DEFAULT_BACKEND = 'auto';
const DEFAULT_ALGORITHM = 'sliding';
const DEFAULT_FAIL_MODE = 'open';
const FALLBACK_DENY_RETRY_MS = 30 * 1000;
const loggedWarnings = new Set();
const upstashLimiterCache = new Map();

const DEFAULT_ROUTE_SETTINGS = Object.freeze({
  start: { failMode: 'open' },
  message: { failMode: 'open' },
  'twilio-webhook': { failMode: 'open' },
  'qa-upgrade-check': { failMode: 'closed' },
});

const ROUTE_ENV_ALIASES = Object.freeze({
  'qa-upgrade-check': {
    maxRequests: ['QA_UPGRADE_CHECK_RATE_LIMIT_MAX'],
    windowMs: ['QA_UPGRADE_CHECK_RATE_LIMIT_WINDOW_MS'],
  },
});

let cachedRedis = null;
let cachedRedisSignature = '';

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requests) {
    if (now - data.windowStart > data.windowMs * 2) {
      requests.delete(key);
    }
  }
}, 5 * 60 * 1000);

function logRateLimitWarningOnce(key, message) {
  if (loggedWarnings.has(key)) return;
  loggedWarnings.add(key);
  console.warn(message);
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'upstash') return normalized;
  return DEFAULT_BACKEND;
}

function normalizeFailMode(value, fallback = DEFAULT_FAIL_MODE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'open' || normalized === 'closed') return normalized;
  return fallback;
}

function normalizeAlgorithm(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'fixed' ? 'fixed' : DEFAULT_ALGORITHM;
}

function normalizeRateLimitKeyPart(value, fallback) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function routeToEnvKey(route) {
  return String(route || 'default')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'DEFAULT';
}

function readFirstEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function readPositiveIntegerFromEnv(names, fallback) {
  const raw = readFirstEnvValue(names);
  return raw === undefined ? fallback : toPositiveInteger(raw, fallback);
}

function readBooleanFromEnv(names, fallback) {
  const raw = readFirstEnvValue(names);
  return raw === undefined ? fallback : parseBoolean(raw, fallback);
}

function getLegacyRouteEnvAliases(route) {
  return ROUTE_ENV_ALIASES[route] || {};
}

function getRateLimitPolicy(route, maxRequests = DEFAULT_MAX_REQUESTS, windowMs = DEFAULT_WINDOW_MS, options = {}) {
  const routeKey = normalizeRateLimitKeyPart(route, 'default');
  const envKey = routeToEnvKey(routeKey);
  const routeDefaults = DEFAULT_ROUTE_SETTINGS[routeKey] || {};
  const legacyAliases = getLegacyRouteEnvAliases(routeKey);

  const resolvedMaxRequests = readPositiveIntegerFromEnv(
    [`RATE_LIMIT_${envKey}_MAX`, ...(legacyAliases.maxRequests || [])],
    toPositiveInteger(options.maxRequests ?? maxRequests, DEFAULT_MAX_REQUESTS),
  );
  const resolvedWindowMs = readPositiveIntegerFromEnv(
    [`RATE_LIMIT_${envKey}_WINDOW_MS`, ...(legacyAliases.windowMs || [])],
    toPositiveInteger(options.windowMs ?? windowMs, DEFAULT_WINDOW_MS),
  );

  return {
    route: routeKey,
    maxRequests: resolvedMaxRequests,
    windowMs: resolvedWindowMs,
    backendPreference: normalizeBackend(
      readFirstEnvValue([`RATE_LIMIT_${envKey}_BACKEND`, 'RATE_LIMIT_BACKEND']) || options.backend,
    ),
    failMode: normalizeFailMode(
      readFirstEnvValue([`RATE_LIMIT_${envKey}_FAIL_MODE`, 'RATE_LIMIT_FAIL_MODE']) || options.failMode,
      routeDefaults.failMode || DEFAULT_FAIL_MODE,
    ),
    shadowMode: readBooleanFromEnv(
      [`RATE_LIMIT_${envKey}_SHADOW_MODE`, 'RATE_LIMIT_SHADOW_MODE'],
      parseBoolean(options.shadowMode, false),
    ),
    timeoutMs: readPositiveIntegerFromEnv(
      [`RATE_LIMIT_${envKey}_TIMEOUT_MS`, 'RATE_LIMIT_TIMEOUT_MS'],
      toPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    ),
    prefix: normalizeRateLimitKeyPart(
      readFirstEnvValue([`RATE_LIMIT_${envKey}_PREFIX`, 'RATE_LIMIT_PREFIX']) || options.prefix,
      DEFAULT_PREFIX,
    ),
    analytics: readBooleanFromEnv(
      [`RATE_LIMIT_${envKey}_ANALYTICS`, 'RATE_LIMIT_ANALYTICS'],
      parseBoolean(options.analytics, true),
    ),
    memoryFallback: readBooleanFromEnv(
      [`RATE_LIMIT_${envKey}_ENABLE_MEMORY_FALLBACK`, 'RATE_LIMIT_ENABLE_MEMORY_FALLBACK'],
      parseBoolean(options.memoryFallback, true),
    ),
    algorithm: normalizeAlgorithm(
      readFirstEnvValue([`RATE_LIMIT_${envKey}_ALGORITHM`, 'RATE_LIMIT_ALGORITHM']) || options.algorithm,
    ),
  };
}

function hashIdentifierForLogs(identifier) {
  return crypto
    .createHash('sha256')
    .update(String(identifier || ''))
    .digest('hex')
    .slice(0, 12);
}

function sanitizeLogMessage(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function maybeLogRateLimitEvent(result) {
  if (result.degraded && result.backendError) {
    console.warn(
      `[rate-limit] degraded route=${result.route} backend=${result.backend} failMode=${result.failMode} id=${result.identifierHash} error="${sanitizeLogMessage(result.backendError)}"`,
    );
    return;
  }
  if (result.wouldLimit && result.shadowMode) {
    console.warn(
      `[rate-limit] shadow-hit route=${result.route} backend=${result.backend} id=${result.identifierHash} remaining=${result.remaining} resetMs=${Math.max(result.resetAt - Date.now(), 0)}`,
    );
    return;
  }
  if (result.wouldLimit) {
    console.warn(
      `[rate-limit] blocked route=${result.route} backend=${result.backend} id=${result.identifierHash} remaining=${result.remaining} resetMs=${Math.max(result.resetAt - Date.now(), 0)}`,
    );
  }
}

function buildRateLimitHeaders(result) {
  const headers = {
    'X-RateLimit-Limit': String(Math.max(Number(result?.limit) || 0, 0)),
    'X-RateLimit-Remaining': String(Math.max(Number(result?.remaining) || 0, 0)),
    'X-RateLimit-Reset': String(Math.max(Number(result?.resetAt) || 0, 0)),
    'X-RateLimit-Backend': String(result?.backend || 'memory'),
    'X-RateLimit-Mode': result?.shadowMode ? 'shadow' : 'enforce',
  };
  if (result?.degraded) headers['X-RateLimit-Degraded'] = 'true';
  if (result?.wouldLimit && result?.shadowMode) headers['X-RateLimit-Would-Limit'] = 'true';
  if ((Number(result?.retryAfterMs) || 0) > 0) {
    headers['Retry-After'] = String(Math.ceil(Number(result.retryAfterMs) / 1000));
  }
  return headers;
}

function stripPortFromIp(candidate) {
  const value = String(candidate || '').trim();
  if (!value) return '';
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(value)) {
    return value.replace(/^\[([0-9a-f:.]+)\](?::\d+)?$/i, '$1').toLowerCase();
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    return value.replace(/:\d+$/, '');
  }
  return value.toLowerCase();
}

function normalizeIpCandidate(value) {
  const first = String(value || '').split(',')[0].trim();
  if (!first || /^(unknown|null|undefined)$/i.test(first)) return '';
  const candidate = stripPortFromIp(first);
  if (!candidate) return '';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) return candidate;
  if (/^[0-9a-f:]+$/i.test(candidate)) return candidate;
  return '';
}

function buildAnonymousClientKey(request) {
  const host = String(
    request?.headers?.get('x-forwarded-host') ||
    request?.headers?.get('host') ||
    request?.headers?.get('origin') ||
    '',
  ).trim();
  const userAgent = String(request?.headers?.get('user-agent') || '').trim();
  const source = `${host}|${userAgent}`.slice(0, 400);
  if (!source) return 'anonymous';
  return `anon:${Buffer.from(source).toString('base64url').slice(0, 32)}`;
}

function getClientIP(request) {
  const headers = request?.headers;
  const candidates = [
    headers?.get('x-vercel-forwarded-for'),
    headers?.get('cf-connecting-ip'),
    headers?.get('x-real-ip'),
    headers?.get('x-forwarded-for'),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeIpCandidate(candidate);
    if (normalized) return normalized;
  }

  return buildAnonymousClientKey(request);
}

function checkRateLimitInMemory(identifier, policy) {
  const key = `${identifier}:${policy.route}`;
  const now = Date.now();

  let data = requests.get(key);
  if (!data || now - data.windowStart > policy.windowMs) {
    data = { count: 1, windowStart: now, windowMs: policy.windowMs };
    requests.set(key, data);
    return {
      success: true,
      limit: policy.maxRequests,
      remaining: Math.max(policy.maxRequests - 1, 0),
      reset: now + policy.windowMs,
      pending: Promise.resolve(),
    };
  }

  data.count += 1;
  const reset = data.windowStart + policy.windowMs;
  if (data.count > policy.maxRequests) {
    return {
      success: false,
      limit: policy.maxRequests,
      remaining: 0,
      reset,
      pending: Promise.resolve(),
    };
  }

  return {
    success: true,
    limit: policy.maxRequests,
    remaining: Math.max(policy.maxRequests - data.count, 0),
    reset,
    pending: Promise.resolve(),
  };
}

function getUpstashRedis() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;

  const signature = `${url}|${token}`;
  if (cachedRedis && cachedRedisSignature === signature) return cachedRedis;

  cachedRedis = new Redis({ url, token });
  cachedRedisSignature = signature;
  return cachedRedis;
}

function getUpstashLimiter(policy) {
  const redis = getUpstashRedis();
  if (!redis) return null;

  const cacheKey = JSON.stringify({
    route: policy.route,
    maxRequests: policy.maxRequests,
    windowMs: policy.windowMs,
    timeoutMs: policy.timeoutMs,
    prefix: policy.prefix,
    analytics: policy.analytics,
    algorithm: policy.algorithm,
  });
  const cached = upstashLimiterCache.get(cacheKey);
  if (cached) return cached;

  const limiterFactory = policy.algorithm === 'fixed'
    ? Ratelimit.fixedWindow
    : Ratelimit.slidingWindow;
  const limiter = new Ratelimit({
    redis,
    limiter: limiterFactory(policy.maxRequests, `${policy.windowMs} ms`),
    analytics: policy.analytics,
    timeout: policy.timeoutMs,
    prefix: `${policy.prefix}:${routeToEnvKey(policy.route).toLowerCase()}`,
  });
  upstashLimiterCache.set(cacheKey, limiter);
  return limiter;
}

function finalizeRateLimitResult(raw, policy, backend, identifierHash, extras = {}) {
  const resetAt = Math.max(Number(raw?.reset) || (Date.now() + policy.windowMs), 0);
  const limit = Math.max(Number(raw?.limit) || policy.maxRequests, 0);
  const remaining = Math.max(Number(raw?.remaining) || 0, 0);
  const wouldLimit = raw?.success === false;
  const shadowMode = policy.shadowMode === true;
  const retryAfterMs = wouldLimit && !shadowMode
    ? Math.max(resetAt - Date.now(), 0)
    : 0;

  return {
    allowed: shadowMode ? true : !wouldLimit,
    wouldLimit,
    remaining,
    retryAfterMs,
    limit,
    resetAt,
    backend,
    route: policy.route,
    failMode: policy.failMode,
    shadowMode,
    degraded: extras.degraded === true,
    backendError: extras.backendError || null,
    identifierHash,
    pending: raw?.pending || Promise.resolve(),
  };
}

async function checkRateLimit(identifier, route, maxRequests = DEFAULT_MAX_REQUESTS, windowMs = DEFAULT_WINDOW_MS, options = {}) {
  const policy = getRateLimitPolicy(route, maxRequests, windowMs, options);
  const normalizedIdentifier = normalizeRateLimitKeyPart(identifier, 'anonymous');
  const identifierHash = hashIdentifierForLogs(normalizedIdentifier);

  if (policy.backendPreference !== 'memory') {
    const limiter = getUpstashLimiter(policy);
    if (limiter) {
      try {
        const raw = await limiter.limit(normalizedIdentifier);
        raw?.pending?.catch(err => {
          console.error('[rate-limit] pending analytics error:', sanitizeLogMessage(err?.message || err));
        });
        const result = finalizeRateLimitResult(raw, policy, 'upstash', identifierHash);
        maybeLogRateLimitEvent(result);
        return result;
      } catch (err) {
        if (policy.memoryFallback) {
          const fallbackRaw = checkRateLimitInMemory(normalizedIdentifier, policy);
          const fallbackResult = finalizeRateLimitResult(
            fallbackRaw,
            policy,
            'memory-fallback',
            identifierHash,
            { degraded: true, backendError: err?.message || String(err) },
          );
          maybeLogRateLimitEvent(fallbackResult);
          return fallbackResult;
        }

        const failOpen = policy.failMode === 'open' || policy.shadowMode;
        const denialResetAt = Date.now() + Math.min(policy.windowMs, FALLBACK_DENY_RETRY_MS);
        const errorResult = {
          allowed: failOpen,
          wouldLimit: !failOpen,
          remaining: failOpen ? policy.maxRequests : 0,
          retryAfterMs: failOpen ? 0 : Math.max(denialResetAt - Date.now(), 0),
          limit: policy.maxRequests,
          resetAt: failOpen ? Date.now() : denialResetAt,
          backend: 'unavailable',
          route: policy.route,
          failMode: policy.failMode,
          shadowMode: policy.shadowMode,
          degraded: true,
          backendError: err?.message || String(err),
          identifierHash,
          pending: Promise.resolve(),
        };
        maybeLogRateLimitEvent(errorResult);
        return errorResult;
      }
    } else if (policy.backendPreference === 'upstash') {
      logRateLimitWarningOnce(
        `missing-upstash:${policy.route}`,
        `[rate-limit] Upstash backend requested for route=${policy.route} but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not configured. Falling back to in-memory limits.`,
      );
    }
  }

  const memoryRaw = checkRateLimitInMemory(normalizedIdentifier, policy);
  const memoryResult = finalizeRateLimitResult(memoryRaw, policy, 'memory', identifierHash);
  maybeLogRateLimitEvent(memoryResult);
  return memoryResult;
}

function __resetRateLimitStateForTests() {
  requests.clear();
  upstashLimiterCache.clear();
  loggedWarnings.clear();
  cachedRedis = null;
  cachedRedisSignature = '';
}

export {
  buildRateLimitHeaders,
  checkRateLimit,
  getClientIP,
  getRateLimitPolicy,
  __resetRateLimitStateForTests,
};
