import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // All four workspace packages currently ship raw TypeScript from
  // src/index.ts (see their package.json `main`/`exports`), so Next must
  // transpile them rather than assume pre-built JS. Re-check this list if
  // any package ever gains a real build step.
  transpilePackages: [
    "@workspace-video/shared",
    "@workspace-video/proximity",
    "@workspace-video/db",
    "@workspace-video/realtime-core",
  ],
  // Prisma's generated client and engine binaries should not be bundled by
  // webpack/turbopack; @workspace-video/db is server-only (route handlers / RSC).
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
