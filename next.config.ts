import type { NextConfig } from "next";

// Cache Components and partial prefetching (scaffold defaults in Next 16) are
// intentionally off: Livento's pages are client-rendered from localStorage and
// its API routes are request-time handlers, so the classic App Router model is
// simpler and less error-prone for a 24-hour build.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // /api/insights reads the labeled sample statement from disk at request time;
  // make sure the file ships with the serverless function on Vercel.
  outputFileTracingIncludes: {
    "/api/insights": ["./data/sample-statement.csv"],
  },
};

export default nextConfig;
