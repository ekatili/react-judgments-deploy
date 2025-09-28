// next.config.ts
import type { NextConfig } from "next";

function norm(url = "") {
  return url.trim().replace(/\/+$/, ""); // strip trailing slash
}

const nextConfig: NextConfig = {
  async rewrites() {
    // Use BACKEND_URL in prod; fallback to localhost in dev
    const backend = norm(process.env.BACKEND_URL);
    if (backend) {
      return [{ source: "/api/:path*", destination: `${backend}/:path*` }];
    }
    return [{ source: "/api/:path*", destination: "http://localhost:8000/:path*" }];
  },

  // optional QoL
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
