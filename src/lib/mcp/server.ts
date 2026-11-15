import { createHash, timingSafeEqual } from "node:crypto";
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
import { queryKubernetesNetwork } from "../kubernetes-network";
import { runNetworkProbe } from "../network-probes";
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
  query_k8s_network: "mcp:read",
  check_network_connectivity: "mcp:probe",
  restart_pod: "mcp:restart",
};

/**
 * 使用 YAML 契约的 inputSchema 校验工具参数。
 * @param tool MCP 工具定义及其输入 JSON Schema。
 * @param args 调用方提交的工具参数对象。
 * @returns 参数校验通过时解析为 void。
 * @throws 参数不符合 JSON Schema 时抛出带 INVALID_PARAMS 错误码的错误。
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
 * @param caller 已认证且带有工具、命名空间和目标白名单的调用者。
 * @param tool 待检查的 MCP 工具。
 * @returns 所需权限及运行配置均满足时返回 true，否则返回 false。
 */
function canUse(caller: McpCaller, tool: ToolDefinition) {
  const scope = TOOL_SCOPES[tool.name];
  if (!caller.tools.includes(scope)) return false;
  if (
    scope === "mcp:read" &&
    !caller.clusterRead &&
    caller.namespaces.length === 0
  )
    return false;
  if (
    tool.name === "restart_pod" &&
    !caller.clusterRead &&
    caller.namespaces.length === 0
  )
    return false;
  if (tool.name === "query_promql" && !caller.clusterRead) return false;
  if (tool.name === "check_network_connectivity")
    return caller.probeTargets.length > 0;
  return true;
}

/**
 * 校验调用者是否可以访问指定命名空间。
 * @param caller 已认证调用者及其命名空间范围。
 * @param namespace 工具参数中的命名空间；集群级查询时可能缺省。
 * @returns 访问授权通过时解析为 void。
 * @throws 命名空间缺省但无集群权限，或指定命名空间不在授权范围时抛出 FORBIDDEN。
 */
function requireNamespace(caller: McpCaller, namespace: unknown) {
  if (typeof namespace !== "string" || !namespace) {
    if (!caller.clusterRead)
      throw Object.assign(new Error("此调用需要指定 namespace"), {
        code: "FORBIDDEN",
      });
    return;
  }
  if (!caller.clusterRead && !caller.namespaces.includes(namespace))
    throw Object.assign(new Error("无权访问该 namespace"), {
      code: "FORBIDDEN",
    });
}

/**
 * 要求调用者具有集群范围读取权限。
 * @param caller 已认证调用者。
 * @param tool 发起集群级读取的工具名称，用于错误描述。
 * @returns 授权通过时解析为 void。
 * @throws 调用者未获 clusterRead 权限时抛出 FORBIDDEN。
 */
function requireClusterRead(caller: McpCaller, tool: string) {
  if (!caller.clusterRead)
    throw Object.assign(new Error(tool + " 需要 clusterRead 权限"), {
      code: "FORBIDDEN",
    });
}

/**
 * 对当前进程内的单个调用者执行每分钟 120 次请求限流。
 * @param callerId 已认证调用者 ID。
 * @returns 未超过限额时解析为 void。
 * @throws 当前一分钟请求数超过上限时抛出 RATE_LIMITED。
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
 * 检查网络探测参数是否匹配调用者配置的精确目标白名单。
 * @param caller 已认证调用者及其 probeTargets 配置。
 * @param args 包含探测类型、主机、端口和可选 URL 的工具参数。
 * @returns 参数与白名单相符时解析为 void。
 * @throws host/type/port 或 HTTP URL 主机不在白名单时抛出 FORBIDDEN。
 */
function probeAllowed(caller: McpCaller, args: Record<string, unknown>) {
  const host = String(args.host).toLowerCase().replace(/\.$/, "");
  const type = args.type;
  const target = caller.probeTargets.find(
    (item) =>
      item.host.toLowerCase().replace(/\.$/, "") === host && item.type === type,
  );
  if (!target)
    throw Object.assign(new Error("此 host/type 不在调用者网络探测白名单内"), {
      code: "FORBIDDEN",
    });
  if (type === "tcp" && !target.ports?.includes(Number(args.port)))
    throw Object.assign(new Error("此 TCP 端口不在调用者白名单内"), {
      code: "FORBIDDEN",
    });
  if (type === "http") {
    const url = new URL(String(args.url));
    if (url.hostname.toLowerCase().replace(/\.$/, "") !== host)
      throw Object.assign(new Error("HTTP URL 主机与白名单目标不一致"), {
        code: "FORBIDDEN",
      });
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!target.ports?.includes(port))
      throw Object.assign(new Error("此 HTTP 端口不在调用者白名单内"), {
        code: "FORBIDDEN",
      });
  }
}

/**
 * 将工具执行异常归一化为可返回给 MCP 客户端的错误码和安全消息。
 * @param error 工具校验或业务执行产生的未知异常。
 * @returns 包含稳定 code 和 message 字段的错误对象。
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
  return {
    code,
    message:
      code === "UPSTREAM_ERROR" || code === "TIMEOUT"
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
async function execute(
  tool: ToolDefinition,
  caller: McpCaller,
  args: Record<string, unknown>,
) {
  validToolArguments(tool, args);
  switch (tool.name) {
    case "query_alerts": {
      if (args.namespace) requireNamespace(caller, args.namespace);
      else requireClusterRead(caller, tool.name);
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
      requireClusterRead(caller, tool.name);
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
      requireNamespace(caller, detail.namespace);
      return { found: true, ...detail };
    }
    case "query_pod_logs":
      requireNamespace(caller, args.namespace);
      return getPodLogs(args as Parameters<typeof getPodLogs>[0]);
    case "query_k8s_network":
      if (args.namespace) requireNamespace(caller, args.namespace);
      else requireClusterRead(caller, tool.name);
      return queryKubernetesNetwork(
        args as Parameters<typeof queryKubernetesNetwork>[0],
      );
    case "check_network_connectivity":
      if (args.type === "tcp" && args.port === undefined)
        throw Object.assign(new Error("TCP 检测必须提供 port"), {
          code: "INVALID_PARAMS",
        });
      if (args.type === "http" && args.url === undefined)
        throw Object.assign(new Error("HTTP 检测必须提供 url"), {
          code: "INVALID_PARAMS",
        });
      probeAllowed(caller, args);
      return runNetworkProbe(args as Parameters<typeof runNetworkProbe>[0], {
        followRedirects: false,
      });
    case "restart_pod": {
      requireNamespace(caller, args.namespace);
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
 * 通过 bearer token 的 SHA-256 摘要匹配调用者配置。
 * @param request 当前 HTTP 请求，读取 Authorization 请求头。
 * @param callers 已验证的 MCP 调用者授权列表。
 * @returns 匹配的调用者；凭证无效或缺失时返回 undefined。
 */
function authorizedCaller(request: Request, callers: McpCaller[]) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,512})$/.exec(header);
  if (!match) return undefined;
  const digest = createHash("sha256").update(match[1]).digest();
  return callers.find((caller) => {
    const expected = Buffer.from(caller.tokenSha256, "hex");
    return (
      expected.length === digest.length && timingSafeEqual(expected, digest)
    );
  });
}

/**
 * 检查带 Origin 的请求是否在 MCP_ALLOWED_ORIGINS 允许列表中。
 * @param request 当前 HTTP 请求。
 * @returns 不带 Origin 或 Origin 被配置允许时返回 true，否则返回 false。
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
     * @returns MCP 工具结果；业务失败通过 isError 和结构化错误内容返回。
     */
    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (requestParams) => {
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
                message: "未知或未授权工具",
              }),
            },
          ],
          structuredContent: { code: "FORBIDDEN", message: "未知或未授权工具" },
          isError: true,
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
        businessLog("mcp.tool.completed", {
          callerId: caller.callerId,
          tool: tool.name,
          durationMs: Date.now() - startedAt,
        });
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
          isError: true,
        };
      }
    });
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
