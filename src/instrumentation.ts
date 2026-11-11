import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { businessLog } = await import("./lib/logger");
    businessLog("service.started", { service: process.env.SERVICE_NAME || "operator-agent-service" });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { errorLog } = await import("./lib/logger");
    errorLog("request.unhandled", error, {
      method: request.method,
      path: request.path.split("?")[0],
      route: context.routePath,
    });
  }
};
