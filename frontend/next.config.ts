import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{
      source: "/api/process",
      destination: `${process.env.API_URL ?? "http://127.0.0.1:4000"}/api/process`,
    }];
  },
  experimental: {
    agentFeedback: true,
    proxyTimeout: 600_000,
    proxyClientMaxBodySize: "251mb",
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
