/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Frontend → your FastAPI in AWS (prod)
      { source: "/api/:path*", destination: "https://bmwxmswpaa.us-east-1.awsapprunner.com/:path*" },
    ];
  },
};

module.exports = nextConfig;
