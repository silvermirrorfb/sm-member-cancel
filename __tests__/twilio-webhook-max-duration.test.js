import { describe, expect, it, vi } from 'vitest';

// The webhook replies with TwiML in milliseconds, but the slow YES work
// (Boulevard reverify + collision gates + the four-mutation apply) runs in
// deferWork()/after(), which Vercel only keeps alive until the route's
// maxDuration. The 2026-07-21 live activation proved 60 seconds is not
// enough: the deferred apply was killed mid-flight ("Vercel Runtime Timeout
// Error: Task timed out after 60 seconds", POST 504) with Boulevard verified
// untouched. 300 matches the budget the pre-appointment automation route
// already declares and deploys with on this project.
vi.mock('../src/lib/rate-limit.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  resolveClientRateLimitKey: vi.fn(() => 'test-key'),
  buildInternalRateLimitHeaders: vi.fn(() => ({})),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

describe('twilio webhook function budget', () => {
  it('declares maxDuration 300 so the deferred YES apply outlives its gates', async () => {
    const route = await import('../src/app/api/sms/twilio/webhook/route.js');
    expect(route.maxDuration).toBe(300);
  });
});
