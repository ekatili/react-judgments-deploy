/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://bmwxmswpaa.us-east-1.awsapprunner.com/:path*',
      },
    ];
  },
};
module.exports = nextConfig;
