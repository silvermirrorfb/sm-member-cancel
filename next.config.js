/** @type {import('next').NextConfig} */
const accessControlAllowHeaders = [
  'Content-Type',
  'Authorization',
  'X-QA-Token',
  'X-QA-Synthetic-Token',
  'X-Idempotency-Key',
  'X-Request-Id',
].join(', ');

const accessControlExposeHeaders = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-RateLimit-Backend',
  'X-RateLimit-Mode',
  'X-RateLimit-Degraded',
  'X-RateLimit-Would-Limit',
  'Retry-After',
  'X-Request-Id',
  'X-Idempotency-Key',
  'X-Idempotency-Replayed',
].join(', ');

const nextConfig = {
  async headers() {
    return [
      {
        // Allow the widget to be embedded on silvermirror.com
        source: '/widget/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://*.silvermirror.com https://silvermirror.com http://localhost:*" },
        ],
      },
      {
        // Short TTL so loader updates propagate quickly
        source: '/embed.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600' },
        ],
      },
      {
        // CORS for API routes
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: process.env.ALLOWED_ORIGIN || 'https://silvermirror.com' },
          { key: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: accessControlAllowHeaders },
          { key: 'Access-Control-Expose-Headers', value: accessControlExposeHeaders },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
