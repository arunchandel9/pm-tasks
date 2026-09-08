import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The routing and noise rules are YAML read at runtime; make sure they ship with every API function.
  outputFileTracingIncludes: {
    "/api/**": ["./config/**"],
  },
};

export default nextConfig;
