import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/v1/mcp": ["./api/mcp.yaml", "./models/mtap-tool.schema.yaml"],
  },
  // The local preview proxy does not forward the development HMR WebSocket.
  // Keep hydration independent of its React debug stream.
  experimental: { reactDebugChannel: false },
};
export default config;
