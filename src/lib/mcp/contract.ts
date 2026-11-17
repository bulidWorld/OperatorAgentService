import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ApprovalInput } from "../approval";

export type SecurityPolicy = {
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalMode: "none" | "required" | "conditional";
  approvalRole?: string;
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
    toolName: string;
    security: SecurityPolicy;
    approval: ApprovalMetadata | Record<string, never>;
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
        const security = tool._meta?.security;
        const approval = tool._meta?.approval;
        if (
          tool._meta?.toolName !== tool.name ||
          !["low", "medium", "high", "critical"].includes(
            security?.riskLevel,
          ) ||
          !["none", "conditional", "required"].includes(
            security?.approvalMode,
          ) ||
          !["allow", "deny", "require_approval"].includes(
            security?.defaultAction,
          ) || !approval || typeof approval !== "object" || Array.isArray(approval)
        )
          throw new Error(
            "MCP 工具缺少有效 _meta.security 或 _meta.approval：" + tool.name,
          );
        if (security.approvalMode === "none") {
          if (security.approvalRole !== undefined || Object.keys(approval).length !== 0)
            throw new Error("approvalMode=none 时必须省略 approvalRole 且 approval 必须为空对象：" + tool.name);
          continue;
        }
        const approvalMetadata = approval as ApprovalMetadata;
        if (
          !["fixed", "model_assisted"].includes(approvalMetadata.inputPolicy) ||
          approvalMetadata.schema_version !== 1 ||
          !Array.isArray(approvalMetadata.allowedInputTypes) ||
          !approvalMetadata.allowedInputTypes.every((type) =>
            ["confirm", "single_select", "multi_select", "text"].includes(type),
          ) ||
          !validApprovalInputs(approvalMetadata.inputs)
        )
          throw new Error("MCP 工具缺少有效审批交互定义：" + tool.name);
        if (
          (security.approvalMode === "required" &&
            (typeof security.approvalRole !== "string" || !security.approvalRole.trim())) ||
          (security.approvalMode === "conditional" &&
            (typeof security.approvalRole !== "string" || !security.approvalRole.trim())) ||
          (approvalMetadata.inputPolicy === "model_assisted" &&
            (new Set(approvalMetadata.allowedInputTypes).size !==
              approvalMetadata.allowedInputTypes.length ||
              approvalMetadata.inputs.some(
                (input) => !approvalMetadata.allowedInputTypes.includes(input.type),
              )))
        )
          throw new Error("MCP 工具安全策略与审批定义不兼容：" + tool.name);
      }
      return contract;
    });
  return contractPromise;
}

export type McpCaller = {
  callerId: string;
  token: string;
  tools: string[];
};

/**
 * 解析并验证环境变量中的 MCP 调用者授权配置。
 * @returns 已校验的调用者列表；未设置 MCP_CALLERS_JSON 时返回空数组。
 * @throws JSON 格式、调用者字段、权限名或唯一性校验失败时抛出错误。
 * 调用者 token 以明文保存，须为 32～512 字节的可传输字符，与客户端发送的
 * bearer token 直接比对。
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
    if (
      typeof caller.callerId !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(caller.callerId) ||
      typeof caller.token !== "string" ||
      !/^[A-Za-z0-9._~+/-]{32,512}$/.test(caller.token) ||
      !Array.isArray(caller.tools) ||
      !caller.tools.every((tool) => typeof tool === "string") ||
      caller.tools.some(
        (tool) =>
          !["ALL", "mcp:read", "mcp:restart"].includes(tool),
      )
    )
      throw new Error("MCP_CALLERS_JSON[" + index + "] 字段无效");
    return caller as McpCaller;
  });
  if (
    new Set(callers.map((caller) => caller.callerId)).size !== callers.length ||
    new Set(callers.map((caller) => caller.token)).size !== callers.length
  )
    throw new Error("MCP_CALLERS_JSON 中 callerId 和 token 必须唯一");
  return callers;
}
