import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedisCtor = vi.fn();
const mockLimit = vi.fn();
const mockSlidingWindow = vi.fn();
const mockFixedWindow = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class FakeRedis {
    constructor(config) {
      mockRedisCtor(config);
    }
  },
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class FakeRatelimit {
    constructor(config) {
      this.config = config;
    }

    limit(identifier) {
      return mockLimit(identifier, this.config);
    }

    static slidingWindow(...args) {
      return mockSlidingWindow(...args);
    }

    static fixedWindow(...args) {
      return mockFixedWindow(...args);
    }
  },
}));

describe('rate-limit Upstash integration', () => {
  const originalEnv = process.env;

  async function loadModule() {
    vi.resetModules();
    return import('../src/lib/rate-limit.js');
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token-123',
      RATE_LIMIT_BACKEND: 'upstash',
    };
    vi.clearAllMocks();
    mockSlidingWindow.mockReturnValue({ type: 'sliding' });
    mockFixedWindow.mockReturnValue({ type: 'fixed' });
    mockLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(),
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    const mod = await loadModule();
    mod.__resetRateLimitStateForTests();
  });

  it('uses Upstash when configured', async () => {
    const { __resetRateLimitStateForTests, checkRateLimit } = await loadModule();
    __resetRateLimitStateForTests();

    const result = await checkRateLimit('203.0.113.10', 'start', 10, 1000);

    expect(result.allowed).toBe(true);
    expect(result.backend).toBe('upstash');
    expect(mockRedisCtor).toHaveBeenCalledWith({
      url: 'https://example.upstash.io',
      token: 'token-123',
    });
    expect(mockSlidingWindow).toHaveBeenCalledWith(10, '1000 ms');
  });

  it('supports shadow mode without blocking traffic', async () => {
    process.env.RATE_LIMIT_MESSAGE_SHADOW_MODE = 'true';
    mockLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(),
    });

    const { __resetRateLimitStateForTests, checkRateLimit } = await loadModule();
    __resetRateLimitStateForTests();

    const result = await checkRateLimit('203.0.113.11', 'message', 30, 1000);

    expect(result.allowed).toBe(true);
    expect(result.wouldLimit).toBe(true);
    expect(result.shadowMode).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('falls back to memory when Upstash errors and memory fallback is enabled', async () => {
    mockLimit.mockRejectedValue(new Error('redis unavailable'));

    const { __resetRateLimitStateForTests, checkRateLimit } = await loadModule();
    __resetRateLimitStateForTests();

    expect((await checkRateLimit('203.0.113.12', 'start', 2, 1000)).backend).toBe('memory-fallback');
    expect((await checkRateLimit('203.0.113.12', 'start', 2, 1000)).backend).toBe('memory-fallback');

    const third = await checkRateLimit('203.0.113.12', 'start', 2, 1000);
    expect(third.allowed).toBe(false);
    expect(third.degraded).toBe(true);
    expect(third.backendError).toContain('redis unavailable');
  });

  it('fails closed when configured and memory fallback is disabled', async () => {
    process.env.RATE_LIMIT_QA_UPGRADE_CHECK_ENABLE_MEMORY_FALLBACK = 'false';
    process.env.RATE_LIMIT_QA_UPGRADE_CHECK_FAIL_MODE = 'closed';
    mockLimit.mockRejectedValue(new Error('redis unavailable'));

    const { __resetRateLimitStateForTests, checkRateLimit } = await loadModule();
    __resetRateLimitStateForTests();

    const result = await checkRateLimit('203.0.113.13', 'qa-upgrade-check', 40, 1000);

    expect(result.allowed).toBe(false);
    expect(result.backend).toBe('unavailable');
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.degraded).toBe(true);
  });
});
