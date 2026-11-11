import type { Instrumentation } from "next";

/** 在 Node.js 服务启动时写入服务启动日志。
 * @returns Node.js runtime 中完成日志记录；其他 runtime 中直接完成。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { businessLog } = await import("./lib/logger");
    businessLog("service.started", { service: process.env.SERVICE_NAME || "operator-agent-service" });
  }
}

/** 记录 Next.js 请求处理过程中未捕获的服务端异常。
 * @param error Next.js 捕获的异常。
 * @param request 发生异常的请求信息。
 * @param context Next.js 提供的路由上下文。
 * @returns Node.js runtime 中写入异常日志；其他 runtime 中直接完成。
 */
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
