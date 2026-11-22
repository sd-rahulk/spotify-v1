import type { NextConfig } from 'next';
const config: NextConfig = { agentRules:false, transpilePackages: ['@resonant/types','@resonant/shared','@resonant/api-client'],
  async rewrites() { return [{ source: '/gateway/:path*', destination: (process.env.API_ORIGIN ?? 'http://localhost:4100') + '/:path*' }]; },
};
export default config;
