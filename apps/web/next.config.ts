import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  // The workspace packages ship raw TypeScript (their package.json "main"
  // points at src/index.ts), so Next has to compile them itself rather than
  // consume a prebuilt bundle.
  transpilePackages: ["@option-decode/analytics", "@option-decode/types"],
  webpack: (config) => {
    // Those packages use NodeNext-style ESM specifiers - `import ... from
    // "./strike-matrix.js"` referring to strike-matrix.ts. tsx and tsc
    // resolve that; webpack does not, and fails with "Can't resolve
    // './wave-screener.js'". extensionAlias teaches it the same mapping so
    // the browser bundle can share the exact analytics code the API runs,
    // instead of the dashboard keeping hand-maintained copies that drift.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"]
    };
    return config;
  }
};

export default nextConfig;
