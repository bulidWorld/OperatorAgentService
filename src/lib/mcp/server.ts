import { timingSafeEqual } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getStoredAlertDetails, getStoredAlerts } from "../kubernetes-events";
import { getPodLogs } from "../kubernetes-logs";
import { getPodDetails, getPods } from "../kubernetes-pods";
import {
  query as queryPrometheus,
  queryRange as queryPrometheusRange,
} from "../prometheus/http";
import {
  getMcpCallers,
  getMcpContract,
  type McpCaller,
  type ToolDefinition,
} from "./contract";
import { getPodUid, restartPod } from "../kubernetes-restart";
import { businessLog, errorLog } from "../logger";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const requestCounts = new Map<string, { start: number; count: number }>();
const TOOL_SCOPES: Record<string, string> = {
  query_alerts: "mcp:read",
  query_promql: "mcp:read",
  query_alert_details: "mcp:read",
  query_pod_logs: "mcp:read",
  query_pods: "mcp:read",
  query_pod_details: "mcp:read",
  restart_pod: "mcp:restart",
};

/**
 * 使用 YAML 契约的 inputSchema 校验工具参数。
 * @param tool MCP 工具定义及其输入 JSON Schema。
 * @param args 调用方提交的工具参数对象。
 * @returns 参数校验通过时解析为 void。
 * @throws 参数不符合 JSON Schema 时抛出带 INVALID_PARAMS 错误码的错误。
 */
/**
 * 使用工具输入 Schema 校验调用参数。
 * @param tool MCP 工具定义。
 * @param value 客户端提交的参数对象。
 * @returns 参数符合 Schema 时返回 true。
 */
function validToolArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
) {
  let validate = compiled.get(tool.name);
  if (!validate) {
    validate = ajv.compile(tool.inputSchema);
    compiled.set(tool.name, validate);
  }
  if (validate(args)) return;
  const issue = validate.errors?.[0];
  throw Object.assign(
    new Error(
      (issue?.instancePath || "arguments") + " " + (issue?.message ?? "无效"),
    ),
    { code: "INVALID_PARAMS" },
  );
}

/**
 * 使用 YAML 契约的 outputSchema 校验工具执行结果。
 * @param tool MCP 工具定义及其输出 JSON Schema。
 * @param result 工具执行所得的业务结果。
 * @returns 结果符合接口 Schema 时解析为 void。
 * @throws 返回结果违反契约时抛出 UPSTREAM_ERROR。
 */
/**
 * 使用工具输出 Schema 校验执行结果。
 * @param tool MCP 工具定义。
 * @param result 工具执行产生的结果。
 * @returns 结果符合 Schema 时返回 true。
 */
function validToolResult(tool: ToolDefinition, result: unknown) {
  const key = tool.name + ":output";
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(tool.outputSchema);
    compiled.set(key, validate);
  }
  if (!validate(result))
    throw Object.assign(new Error("工具结果格式与接口契约不符"), {
      code: "UPSTREAM_ERROR",
    });
}

/**
 * 判断调用者是否有权发现并调用指定工具。
 * @param caller 已认证且带有工具权限的调用者。
 * @param tool 待检查的 MCP 工具。
 * @returns 所需权限满足时返回 true，否则返回 false。
 * tools 含 "ALL" 时视为拥有全部工具权限。
 */
/**
 * 判断指定调用者是否拥有调用工具所需权限。
 * @param caller 已鉴权的 MCP 调用者。
 * @param tool 待检查的工具定义。
 * @returns 调用者被授权调用该工具时返回 true。
 */
function canUse(caller: McpCaller, tool: ToolDefinition) {
  const scope = TOOL_SCOPES[tool.name];
  if (!caller.tools.includes(scope) && !caller.tools.includes("ALL"))
    return false;
  return true;
}

/**
 * 对当前进程内的单个调用者执行每分钟 120 次请求限流。
 * @param callerId 已认证调用者 ID。
 * @returns 未超过限额时解析为 void。
 * @throws 当前一分钟请求数超过上限时抛出 RATE_LIMITED。
 */
/**
 * 检查并更新调用者的每分钟请求计数。
 * @param callerId 已鉴权的调用者编号。
 * @returns 未超过速率限制时返回 true。
 */
function checkRateLimit(callerId: string) {
  const now = Date.now();
  let item = requestCounts.get(callerId);
  if (!item || now - item.start >= 60_000) {
    item = { start: now, count: 0 };
    requestCounts.set(callerId, item);
  }
  item.count++;
  if (item.count > 120)
    throw Object.assign(new Error("调用频率超限"), { code: "RATE_LIMITED" });
  if (requestCounts.size > 10_000)
    for (const [key, value] of requestCounts)
      if (now - value.start > 60_000) requestCounts.delete(key);
}

/**
 * 将工具执行异常归一化为可返回给 MCP 客户端的错误码和安全消息。
 * @param error 工具校验或业务执行产生的未知异常。
 * @returns 包含稳定 code 和 errorMessage 字段的错误对象。
 */
/**
 * 将内部异常转换为适合 MCP 响应的错误码和消息。
 * @param error 捕获到的未知异常。
 * @returns 包含 MCP 错误码与安全错误说明的对象。
 */
function codedError(error: unknown) {
  const message = error instanceof Error ? error.message : "工具执行失败";
  const known = [
    "FORBIDDEN",
    "INVALID_PARAMS",
    "RATE_LIMITED",
    "RESULT_TOO_LARGE",
    "UPSTREAM_ERROR",
    "POD_CHANGED",
    "POD_NOT_FOUND",
  ];
  const ownCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const code =
    (ownCode && known.includes(ownCode) ? ownCode : undefined) ??
    known.find((value) => message.includes(value)) ??
    (message.includes("超时") ? "TIMEOUT" : "UPSTREAM_ERROR");
  const isExpectedToolError = [
    "INVALID_PARAMS",
    "FORBIDDEN",
    "POD_CHANGED",
    "POD_NOT_FOUND",
    "RESULT_TOO_LARGE",
    "RATE_LIMITED",
  ].includes(code);
  return {
    code,
    errorMessage:
      !isExpectedToolError && (code === "UPSTREAM_ERROR" || code === "TIMEOUT")
        ? "上游服务暂时不可用"
        : message,
  };
}

/**
 * 校验权限与参数后执行对应 MCP 工具的业务逻辑。
 * @param tool 来自 MCP YAML 契约的工具定义。
 * @param caller 当前已通过 bearer 认证的调用者。
 * @param args 工具参数对象。
 * @returns 对应工具的业务结果对象。
 * @throws 工具参数、调用权限或上游服务不满足要求时抛出错误。
 */
/**
 * 按工具名称调用对应业务操作并校验其输出。
 * @param tool 待执行的 MCP 工具定义。
 * @param args 已校验的工具参数。
 * @returns 工具的业务执行结果。
 * @throws 工具执行失败或结果不符合输出 Schema 时抛出错误。
 */
async function execute(
  tool: ToolDefinition,
  caller: McpCaller,
  args: Record<string, unknown>,
) {
  validToolArguments(tool, args);
  switch (tool.name) {
    case "query_alerts": {
      const alerts: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await getStoredAlerts(500, cursor, {
          ...args,
          namespace: args.namespace as string | undefined,
        });
        alerts.push(...page.alerts);
        if (alerts.length > 5000)
          throw Object.assign(new Error("RESULT_TOO_LARGE"), {
            code: "RESULT_TOO_LARGE",
          });
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { total: alerts.length, alerts };
    }
    case "query_promql": {
      const promql = String(args.promql).trim();
      const rangeMinutes = args.rangeMinutes as number | undefined;
      const stepSeconds = args.stepSeconds as number | undefined;
      if (rangeMinutes === undefined) {
        if (stepSeconds !== undefined)
          throw Object.assign(new Error("区间查询需要同时指定 rangeMinutes"), {
            code: "INVALID_PARAMS",
          });
        return { mode: "instant", promql, ...(await queryPrometheus(promql)) };
      }
      const step = stepSeconds ?? 60;
      const end = Math.floor(Date.now() / 1000);
      const start = end - rangeMinutes * 60;
      if (Math.ceil((end - start) / step) > 3000)
        throw Object.assign(new Error("区间采样点过多"), {
          code: "INVALID_PARAMS",
        });
      return {
        mode: "range",
        promql,
        rangeMinutes,
        stepSeconds: step,
        ...(await queryPrometheusRange(promql, start, end, step)),
      };
    }
    case "query_alert_details": {
      const detail = await getStoredAlertDetails(Number(args.id));
      if (!detail)
        return { found: false, id: args.id, message: "未找到该告警记录" };
      return { found: true, ...detail };
    }
    case "query_pod_logs":
      return getPodLogs(args as Parameters<typeof getPodLogs>[0]);
    case "query_pods":
      return getPods(args as Parameters<typeof getPods>[0]);
    case "query_pod_details":
      return getPodDetails(args as Parameters<typeof getPodDetails>[0]);
    case "restart_pod": {
      const namespace = String(args.namespace);
      const pod = String(args.pod);
      const uid = await getPodUid({ namespace, pod });
      const result = await restartPod({ namespace, pod, uid });
      businessLog("mcp.kubernetes.pod.restart.executed", {
        callerId: caller.callerId,
        namespace: result.namespace,
        pod: result.pod,
        deleted: true,
      });
      return result;
    }
    default:
      throw Object.assign(new Error("未知工具"), { code: "INVALID_PARAMS" });
  }
}

/**
 * 用请求中的 bearer token 与调用者配置的原始 token 直接比对。
 * @param request 当前 HTTP 请求，读取 Authorization 请求头。
 * @param callers 已验证的 MCP 调用者授权列表。
 * @returns 匹配的调用者；凭证无效或缺失时返回 undefined。
 */
/**
 * 根据 Authorization bearer token 查找已配置的调用者。
 * @param request 当前 MCP HTTP 请求。
 * @param callers 已校验的调用者配置列表。
 * @returns 匹配的调用者；未提供或凭证无效时返回 undefined。
 */
function authorizedCaller(request: Request, callers: McpCaller[]) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,512})$/.exec(header);
  if (!match) return undefined;
  const provided = Buffer.from(match[1]);
  return callers.find((caller) => {
    const expected = Buffer.from(caller.token);
    return (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    );
  });
}

/**
 * 检查带 Origin 的请求是否在 MCP_ALLOWED_ORIGINS 允许列表中。
 * @param request 当前 HTTP 请求。
 * @returns 不带 Origin 或 Origin 被配置允许时返回 true，否则返回 false。
 */
/**
 * 校验请求来源是否允许访问 MCP HTTP 接口。
 * @param request 当前 MCP HTTP 请求。
 * @returns 来源检查通过时返回 true。
 */
function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

/**
 * 处理一次无状态 MCP Streamable HTTP 请求。
 * @param request Next.js App Router 收到的 MCP POST 请求。
 * @returns MCP JSON-RPC 响应，或包含 HTTP 错误状态的 JSON 响应。
 * @throws 正常请求错误会转换为 HTTP/MCP 错误响应；函数不会将请求处理异常传给路由层。
 */
/**
 * 处理 MCP Streamable HTTP 请求并执行协议及工具权限校验。
 * @param request 当前进入 MCP 接口的 HTTP 请求。
 * @returns 符合 MCP 协议的 HTTP 响应。
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const jsonHeaders = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  try {
    const callers = getMcpCallers();
    if (!callers.length)
      return Response.json(
        { error: "MCP 尚未配置调用者凭证" },
        { status: 503, headers: jsonHeaders },
      );
    const caller = authorizedCaller(request, callers);
    if (!caller)
      return Response.json(
        { error: "未授权" },
        {
          status: 401,
          headers: {
            ...jsonHeaders,
            "www-authenticate": 'Bearer realm="operator-agent-service-mcp"',
          },
        },
      );
    if (!checkOrigin(request))
      return Response.json(
        { error: "Origin 不允许" },
        { status: 403, headers: jsonHeaders },
      );
    checkRateLimit(caller.callerId);
    if (
      request.headers.get("content-length") &&
      Number(request.headers.get("content-length")) > 1024 * 1024
    )
      return Response.json(
        { error: "请求体超过 1 MiB" },
        { status: 413, headers: jsonHeaders },
      );
    const chunks: Uint8Array[] = [];
    let bodySize = 0;
    if (request.body) {
      const reader = request.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bodySize += part.value.byteLength;
        if (bodySize > 1024 * 1024) {
          await reader.cancel();
          return Response.json(
            { error: "请求体超过 1 MiB" },
            { status: 413, headers: jsonHeaders },
          );
        }
        chunks.push(part.value);
      }
    }
    const mcpRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
      signal: request.signal,
      duplex: "half",
    } as RequestInit);
    const contract = await getMcpContract();
    const incoming = (await mcpRequest
      .clone()
      .json()
      .catch(() => undefined)) as
      | { method?: unknown; params?: { protocolVersion?: unknown } }
      | undefined;
    if (incoming?.method === "initialize") {
      if (
        typeof incoming.params?.protocolVersion !== "string" ||
        !contract.server.transport.protocolVersions.includes(
          incoming.params.protocolVersion,
        )
      )
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "不支持的 MCP 协议版本" },
          },
          { status: 400, headers: jsonHeaders },
        );
    } else if (incoming) {
      const version = request.headers.get("mcp-protocol-version");
      if (
        !version ||
        !contract.server.transport.protocolVersions.includes(version)
      )
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: "缺少或不支持 MCP-Protocol-Version",
            },
          },
          { status: 400, headers: jsonHeaders },
        );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1024 * 1024,
    });
    const mcpServer = new McpServer(
      { name: contract.server.name, version: contract.server.version },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: contract.server.instructions,
      },
    );
    // YAML 提供原生 JSON Schema，且 tools/list 需按调用者过滤，因此在 McpServer 下使用底层协议 handler。
    /**
     * 仅发布当前调用者权限和运行配置均允许使用的 MCP 工具。
     * @returns 当前调用者可发现的 MCP Tool 定义数组。
     */
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: contract.tools.filter((tool) => canUse(caller, tool)),
    }));
    /**
     * 处理单项工具调用，并记录授权结果、执行结果和耗时。
     * @param requestParams MCP SDK 校验后的工具名称与调用参数。
     * @returns MCP 工具结果；工具失败通过结构化 errorMessage 返回。
     */
    mcpServer.server.setRequestHandler(
      CallToolRequestSchema,
      async (requestParams) => {
        const startedAt = Date.now();
        const tool = contract.tools.find(
          (candidate) => candidate.name === requestParams.params.name,
        );
        if (!tool || !canUse(caller, tool)) {
          businessLog("mcp.tool.denied", {
            level: "WARN",
            callerId: caller.callerId,
            tool: requestParams.params.name,
            description: "MCP 工具调用被权限策略拒绝",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: "FORBIDDEN",
                  errorMessage: "未知或未授权工具",
                }),
              },
            ],
            structuredContent: {
              code: "FORBIDDEN",
              errorMessage: "未知或未授权工具",
            },
            isError: false,
          };
        }
        try {
          const args = (requestParams.params.arguments ?? {}) as Record<
            string,
            unknown
          >;
          const result = await execute(tool, caller, args);
          validToolResult(tool, result);
          const serialized = JSON.stringify(result);
          if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024)
            throw Object.assign(new Error("RESULT_TOO_LARGE"), {
              code: "RESULT_TOO_LARGE",
            });
          if (
            result &&
            typeof result === "object" &&
            "errorMessage" in result &&
            typeof result.errorMessage === "string"
          ) {
            businessLog("mcp.tool.completed_with_error", {
              level: "WARN",
              callerId: caller.callerId,
              tool: tool.name,
              durationMs: Date.now() - startedAt,
              errorMessage: result.errorMessage,
            });
            return {
              content: [{ type: "text", text: serialized }],
              structuredContent: result as Record<string, unknown>,
              isError: false,
            };
          }
          businessLog("mcp.tool.completed", {
            callerId: caller.callerId,
            tool: tool.name,
            durationMs: Date.now() - startedAt,
          });
          if (tool.name === "query_pod_logs") {
            const podLogs = result as Awaited<ReturnType<typeof getPodLogs>>;
            return {
              content: [
                {
                  type: "resource" as const,
                  resource: {
                    type: "text" as const,
                    uri: `log:///k8s/${podLogs.namespace}/${podLogs.pod}.log`,
                    mimeType: "text/plain; charset=utf-8",
                    text: podLogs.logs,
                  },
                },
              ],
              structuredContent: podLogs,
              isError: false,
            };
          }
          if (tool.name === "query_pod_details") {
            const podArgs = args as Parameters<typeof getPodDetails>[0];
            return {
              content: [
                {
                  type: "resource" as const,
                  resource: {
                    type: "text" as const,
                    uri: `k8s:///namespaces/${encodeURIComponent(podArgs.namespace)}/pods/${encodeURIComponent(podArgs.pod)}`,
                    mimeType: "application/json",
                    text: serialized,
                  },
                },
              ],
              structuredContent: result as Record<string, unknown>,
              isError: false,
            };
          }
          return {
            content: [{ type: "text", text: serialized }],
            structuredContent: result as Record<string, unknown>,
            isError: false,
          };
        } catch (error) {
          const failure = codedError(error);
          errorLog("mcp.tool.failed", error, {
            callerId: caller.callerId,
            tool: tool.name,
            code: failure.code,
            durationMs: Date.now() - startedAt,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(failure) }],
            structuredContent: failure,
            isError: false,
          };
        }
      },
    );
    await mcpServer.connect(transport);
    try {
      return await transport.handleRequest(mcpRequest);
    } finally {
      await mcpServer.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "调用频率超限")
      return Response.json(
        { error: "调用频率超限" },
        { status: 429, headers: jsonHeaders },
      );
    errorLog("mcp.request.failed", error, { description: "MCP 请求处理失败" });
    return Response.json(
      { error: "MCP 服务暂时不可用" },
      { status: 500, headers: jsonHeaders },
    );
  }
}
