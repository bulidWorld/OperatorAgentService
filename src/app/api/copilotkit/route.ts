import { HttpAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import { errorLog, withAccessLog, withHttpLog } from "@/lib/logger";

export const runtime = "nodejs";

/** Process 内缓存：每个 worker 只创建一次 HttpAgent 和 HTTP handler。 */
let handler: ReturnType<typeof createCopilotHonoHandler> | undefined;

class LoggedAgentFetch {
  fetch(url: string, requestInit: RequestInit): Promise<Response> {
    const target = new URL(url);
    return withHttpLog(
      {
        method: requestInit.method ?? "POST",
        path: target.pathname,
        operation: "远端 AG-UI Agent 请求",
      },
      () => globalThis.fetch(url, requestInit),
    );
  }
}

/**
 * 创建并缓存连接远端 AG-UI endpoint 的 CopilotKit handler。
 * @returns 已配置 HttpAgent 的 CopilotKit HTTP handler。
 * @throws 未配置或格式无效的 LANGGRAPH_DEPLOYMENT_URL 时抛出错误。
 */
function getHandler() {
  if (handler) return handler;
  const deploymentUrl = process.env.LANGGRAPH_DEPLOYMENT_URL;
  if (!deploymentUrl) throw new Error("请配置 LANGGRAPH_DEPLOYMENT_URL");
  try {
    const endpoint = new URL(deploymentUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error("invalid endpoint");
  } catch {
    throw new Error("LANGGRAPH_DEPLOYMENT_URL 必须是有效的 AG-UI HTTP(S) endpoint，例如 http://localhost:8123/agent");
  }
  const loggedFetch = new LoggedAgentFetch();
  const agent = new HttpAgent({
    url: deploymentUrl,
    fetch: loggedFetch.fetch.bind(loggedFetch),
  });
  const copilotRuntime = new CopilotRuntime({ agents: { default: agent } });
  handler = createCopilotHonoHandler({
    runtime: copilotRuntime,
    basePath: "/api/copilotkit",
    mode: "single-route",
  });
  return handler;
}

/**
 * 将浏览器发起的请求转发给 CopilotKit 与远端 AG-UI Agent。
 * @param request 来自 CopilotKit 前端的 HTTP 请求。
 * @returns Agent 流式响应；配置或运行错误时返回 HTTP 500 JSON。
 */
async function handle(request: Request) {
  return withAccessLog(request, "CopilotKit AG-UI 转发", async () => {
    try {
      return await getHandler().fetch(request);
    } catch (error) {
      errorLog("copilotkit.proxy.failed", error, { description: "转发远端 AG-UI Agent 请求失败" });
      return Response.json(
        { error: error instanceof Error ? error.message : "远端 Agent 请求失败" },
        { status: 500 },
      );
    }
  });
}

export const GET = handle;
export const POST = handle;
