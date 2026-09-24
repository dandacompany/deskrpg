import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  // Even when dynamic file access traces the whole project, do not ship development files.
  outputFileTracingExcludes: {
    "**/*": [
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
      "./scripts/**",
      "./e2e/**",
      "./playwright*.config.*",
      "./tsconfig.tsbuildinfo",
      "./src/test-setup/**",
      "./.artifacts/**",
      "./test-results/**",
      "./docs/**",
      "./public/**",
      "./.superpowers/**",
      "./.claude/**",
      "./.codex/**",
      "./.agents/**",
      "./.gemini/**",
      "./.dryforge/**",
      "./AGENTS.md",
      "./CLAUDE.md",
      "./GEMINI.md",
    ],
  },
  devIndicators: false,
  // This repository is independent from any npm project above its root.
  turbopack: {
    root: __dirname,
  },
  // Loopback-only second origin lets local QA use two independent login sessions.
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["ssh2"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
