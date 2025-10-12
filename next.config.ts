/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://ts38eztsnz.us-east-1.awsapprunner.com/:path*',
      },
    ];
  },
};
module.exports = nextConfig;
