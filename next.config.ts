/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Proxy all /api/* to your local FastAPI on 8000
      { source: "/api/:path*", destination: "http://localhost:8000/:path*" },
    ];
  },
};
module.exports = nextConfig;
