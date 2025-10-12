/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://uzdwveqm2f.us-east-1.awsapprunner.com//:path*',
      },
    ];
  },
};
module.exports = nextConfig;
