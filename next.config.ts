import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The domain and inventory layers are plain TypeScript with no bundler-specific
  // syntax, so they can run on the server without transpilation surprises.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Paystack must be able to POST to this endpoint from its own network.
        source: '/api/webhooks/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }]
      }
    ];
  }
};

export default nextConfig;
