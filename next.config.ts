import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only packages that must not be bundled into client code.
  serverExternalPackages: ["pg", "@vercel/sandbox", "pdf-lib", "@pdf-lib/fontkit"],
  outputFileTracingIncludes: { "/api/**": ["./assets/fonts/**"] },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
