import { handleMcpRequest } from "@/lib/mcp/server";
import { withAccessLog } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * 接收 MCP Streamable HTTP JSON-RPC 请求并转交 MCP 协议处理器。
 * @param request Next.js App Router 收到的 MCP POST 请求。
 * @returns MCP JSON-RPC 响应或包含错误状态的 JSON 响应。
 */
export async function POST(request: Request): Promise<Response> {
  return withAccessLog(request, "MCP Streamable HTTP", () => handleMcpRequest(request));
}

/**
 * 处理 MCP GET 请求；当前服务不提供服务端 SSE 推送。
 * @returns HTTP 405 JSON 响应，并通过 Allow 头声明只允许 POST。
 */
export async function GET(request: Request) {
  return withAccessLog(request, "MCP Streamable HTTP SSE", async () => Response.json({ error: "此 MCP 端点使用无状态 Streamable HTTP；GET SSE 尚未启用" }, { status: 405, headers: { allow: "POST" } }));
}

/**
 * 处理无状态 MCP 会话的终止请求；服务不创建需终止的会话。
 * @returns HTTP 405 JSON 响应，并通过 Allow 头声明只允许 POST。
 */
export async function DELETE(request: Request) {
  return withAccessLog(request, "MCP Streamable HTTP 会话终止", async () => Response.json({ error: "无状态 MCP 端点不支持 DELETE" }, { status: 405, headers: { allow: "POST" } }));
}

