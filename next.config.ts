/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL || 'https://ts38eztsnz.us-east-1.awsapprunner.com';

const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
