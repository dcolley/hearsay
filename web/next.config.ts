import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Keep Node-only ONNX bindings out of the browser bundle
  serverExternalPackages: ["onnxruntime-node", "sharp"],
  transpilePackages: ["kokoro-js", "@huggingface/transformers"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    resolveAlias: {
      // kokoro-js / transformers pull these in Node builds
      fs: { browser: "./src/lib/empty-module.ts" },
      "fs/promises": { browser: "./src/lib/empty-module.ts" },
      path: { browser: "./src/lib/empty-module.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        "fs/promises": false,
        "onnxruntime-node": false,
      };
    }
    return config;
  },
};

export default nextConfig;
