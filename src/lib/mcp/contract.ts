import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ApprovalInput } from "../approval";

export type SecurityPolicy = {
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalMode: "none" | "required" | "conditional";
  approvalRole: string;
  defaultAction: "allow" | "deny" | "require_approval";
};

export type ApprovalMetadata = {
  schema_version: 1;
  inputPolicy: "fixed" | "model_assisted";
  allowedInputTypes: ApprovalInput["type"][];
  inputs: ApprovalInput[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  _meta: {
    serverId: string;
    toolName: string;
    security: SecurityPolicy;
    approval: ApprovalMetadata;
  };
};

type Contract = {
  document: { version: string };
  server: {
    name: string;
    version: string;
    instructions: string;
    transport: { protocolVersions: string[] };
  };
  tools: ToolDefinition[];
};

/** 缓存解析成功的 YAML 契约，避免每个 MCP 请求重复读取文件。 */
let contractPromise: Promise<Contract> | undefined;

function validApprovalInputs(inputs: unknown): inputs is ApprovalInput[] {
  if (!Array.isArray(inputs)) return false;
  const keys = new Set<string>();
  return inputs.every((input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.key !== "string" ||
      !input.key.trim() ||
      keys.has(input.key) ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      typeof input.required !== "boolean" ||
      (input.placeholder !== undefined && typeof input.placeholder !== "string")
    )
      return false;
    keys.add(input.key);
    if (input.type === "confirm")
      return input.options === undefined && input.max_length === undefined;
    if (input.type === "single_select" || input.type === "multi_select") {
      if (
        !Array.isArray(input.options) ||
        input.options.length === 0 ||
        input.max_length !== undefined
      )
        return false;
      const values = new Set<string>();
      return input.options.every((option: unknown) => {
        if (
          !option ||
          typeof option !== "object" ||
          typeof (option as Record<string, unknown>).value !== "string" ||
          !(option as Record<string, unknown>).value ||
          typeof (option as Record<string, unknown>).label !== "string" ||
          !(option as Record<string, unknown>).label ||
          values.has((option as Record<string, unknown>).value as string)
        )
          return false;
        values.add((option as Record<string, unknown>).value as string);
        return true;
      });
    }
    return (
      input.type === "text" &&
      input.options === undefined &&
      (input.max_length === undefined ||
        (Number.isInteger(input.max_length) && input.max_length >= 0))
    );
  });
}

/**
 * 从 MCP YAML 契约读取并缓存服务端与工具定义。
 * @returns 解析后的 MCP 契约；并发首次调用共享同一个读取任务。
 * @throws YAML 无法读取、解析失败或工具元数据/协议版本与服务实现不一致时抛出错误。
 */
export function getMcpContract(): Promise<Contract> {
  contractPromise ??= readFile(path.join(process.cwd(), "api/mcp.yaml"), "utf8")
    .then((source) => parse(source) as Contract)
    .then((contract) => {
      if (!Array.isArray(contract.tools) || contract.tools.length === 0)
        throw new Error("api/mcp.yaml 必须定义 MCP 工具");
      if (
        contract.server.transport.protocolVersions.join(",") !==
        "2025-11-25,2025-06-18"
      )
        throw new Error("api/mcp.yaml 的 MCP 协议版本与服务实现不一致");
      const names = new Set<string>();
      for (const tool of contract.tools) {
        if (!tool.name || names.has(tool.name))
          throw new Error("api/mcp.yaml 中的 MCP 工具名称缺失或重复");
        names.add(tool.name);
        if (
          tool._meta?.serverId !== "kubernetes-mcp" ||
          tool._meta.toolName !== tool.name ||
          !["low", "medium", "high", "critical"].includes(
            tool._meta.security?.riskLevel,
          ) ||
          !["none", "conditional", "required"].includes(
            tool._meta.security?.approvalMode,
          ) ||
          typeof tool._meta.security?.approvalRole !== "string" ||
          !["allow", "deny", "require_approval"].includes(
            tool._meta.security?.defaultAction,
          ) ||
          !["fixed", "model_assisted"].includes(
            tool._meta.approval?.inputPolicy,
          ) ||
          tool._meta.approval?.schema_version !== 1 ||
          !Array.isArray(tool._meta.approval?.allowedInputTypes) ||
          !tool._meta.approval.allowedInputTypes.every((type) =>
            ["confirm", "single_select", "multi_select", "text"].includes(type),
          ) ||
          !validApprovalInputs(tool._meta.approval?.inputs)
        )
          throw new Error(
            "MCP 工具缺少有效 _meta.security 或 _meta.approval：" + tool.name,
          );
        const { security, approval } = tool._meta;
        if (
          (security.approvalMode === "required" &&
            !security.approvalRole.trim()) ||
          (security.approvalMode === "conditional" &&
            !security.approvalRole.trim()) ||
          (approval.inputPolicy === "model_assisted" &&
            (new Set(approval.allowedInputTypes).size !==
              approval.allowedInputTypes.length ||
              approval.inputs.some(
                (input) => !approval.allowedInputTypes.includes(input.type),
              )))
        )
          throw new Error("MCP 工具安全策略与审批定义不兼容：" + tool.name);
      }
      return contract;
    });
  return contractPromise;
}

export type ProbeTarget = {
  host: string;
  type: "icmp" | "tcp" | "http";
  ports?: number[];
};
export type McpCaller = {
  callerId: string;
  tokenSha256: string;
  tools: string[];
  namespaces: string[];
  clusterRead: boolean;
  probeTargets: ProbeTarget[];
};

/**
 * 解析并验证环境变量中的 MCP 调用者授权配置。
 * @returns 已校验的调用者列表；未设置 MCP_CALLERS_JSON 时返回空数组。
 * @throws JSON 格式、调用者字段、权限名、探测目标或唯一性校验失败时抛出错误。
 */
export function getMcpCallers(): McpCaller[] {
  const raw = process.env.MCP_CALLERS_JSON;
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("MCP_CALLERS_JSON 必须是有效 JSON");
  }
  if (!Array.isArray(value)) throw new Error("MCP_CALLERS_JSON 必须是数组");
  if (value.length > 500)
    throw new Error("MCP_CALLERS_JSON 最多支持 500 个调用者");
  const callers = value.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error("MCP_CALLERS_JSON[" + index + "] 无效");
    const caller = entry as Partial<McpCaller>;
    const validProbeTargets =
      Array.isArray(caller.probeTargets) &&
      caller.probeTargets.every((target) => {
        if (!target || typeof target !== "object") return false;
        return (
          typeof target.host === "string" &&
          target.host.length <= 253 &&
          /^[a-zA-Z0-9.-]+$/.test(target.host) &&
          !target.host.startsWith(".") &&
          !target.host.endsWith(".") &&
          ["icmp", "tcp", "http"].includes(target.type) &&
          (target.ports === undefined ||
            (Array.isArray(target.ports) &&
              target.ports.every(
                (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
              )))
        );
      });
    if (
      typeof caller.callerId !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(caller.callerId) ||
      typeof caller.tokenSha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(caller.tokenSha256) ||
      !Array.isArray(caller.tools) ||
      !caller.tools.every((tool) => typeof tool === "string") ||
      !Array.isArray(caller.namespaces) ||
      !caller.namespaces.every(
        (namespace) =>
          typeof namespace === "string" &&
          /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace),
      ) ||
      typeof caller.clusterRead !== "boolean" ||
      !validProbeTargets ||
      caller.tools.some(
        (tool) => !["mcp:read", "mcp:probe", "mcp:restart"].includes(tool),
      )
    )
      throw new Error("MCP_CALLERS_JSON[" + index + "] 字段无效");
    return caller as McpCaller;
  });
  if (
    new Set(callers.map((caller) => caller.callerId)).size !== callers.length ||
    new Set(callers.map((caller) => caller.tokenSha256.toLowerCase())).size !==
      callers.length
  )
    throw new Error("MCP_CALLERS_JSON 中 callerId 和 tokenSha256 必须唯一");
  return callers;
}
