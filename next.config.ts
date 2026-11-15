import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/api/mcp": ["./api/mcp.yaml"] },
  // The local preview proxy does not forward the development HMR WebSocket.
  // Keep hydration independent of its React debug stream.
  experimental: { reactDebugChannel: false },
};
export default config;
