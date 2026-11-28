import type {
  ActivityDeltaEvent,
  ActivityMessage,
  ActivitySnapshotEvent,
} from "@ag-ui/client";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "awaiting_auth"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";
export type ActivityStatus = RunStatus;

export type StepMessage = {
  messageId: string;
  type: "text" | "reasoning";
  text: string;
};

export type StepOutput = { messages: StepMessage[] };

export type AgentRunEvent = {
  id: string;
  sequence: number;
  type: string;
  title: string;
  status: ActivityStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  tool?: { name: string; server?: string };
  input?: Record<string, unknown> | null;
  output?: unknown;
  correlation?: {
    reasoningId?: string;
    messageId?: string;
    toolCallId?: string;
    [key: string]: unknown;
  };
  error?: string | null;
  approval?: {
    requestId?: string | null;
    status?: "awaiting_approval" | string;
    [key: string]: unknown;
  };
  /** MTAP 审批请求唯一标识；待审批工具活动用它关联中断载荷。 */
  request_id?: string;
  [key: string]: unknown;
};

/** A2A 任务生命周期状态，可使用协议字符串或对应数值。 */
export type A2ATaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** A2A 消息内容片段，支持文本、结构化数据和文件。 */
export type A2APart = {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
  [key: string]: unknown;
};

/** A2A 对话消息。 */
export type A2AMessage = {
  messageId?: string;
  role?: "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT" | number | string;
  parts?: A2APart[];
  [key: string]: unknown;
};

/** A2A 任务状态及可选说明消息。 */
export type A2ATaskStatus = {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
  [key: string]: unknown;
};

/** A2A 任务产物及其内容。 */
export type A2AArtifact = {
  artifactId?: string;
  name?: string;
  description?: string;
  parts?: A2APart[];
  [key: string]: unknown;
};

/** A2A 完整任务快照。 */
export type A2ATaskSnapshot = {
  id?: string;
  contextId?: string;
  status?: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  [key: string]: unknown;
};

/** A2A 进度更新中的原始协议事件。 */
export type A2AUpdate =
  | { task: A2ATaskSnapshot; [key: string]: unknown }
  | { message: A2AMessage; [key: string]: unknown }
  | { status: A2ATaskStatus; [key: string]: unknown }
  | { artifact: A2AArtifact; append?: boolean; lastChunk?: boolean; [key: string]: unknown };

/** A2A_PROGRESS_EVENT 对应的任务进度数据。 */
export type A2AProgress = {
  taskId: string;
  status: A2ATaskStatus;
  update: A2AUpdate;
  [key: string]: unknown;
};

export type AgentRunActivity = {
  schemaVersion: 1 | 2;
  run: {
    runId: string;
    threadId: string;
    status: RunStatus;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    error: string | null;
    [key: string]: unknown;
  };
  events: AgentRunEvent[];
  [key: string]: unknown;
};

export type ActivitySyncState = "ready" | "needs_snapshot";

/**
 * 判断输入是否为非数组对象。
 * @param value 待检查的输入值。
 * @returns 输入为非空对象且不是数组时返回 true。
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const activityTypes = {
  1: new Set([
    "model_inference",
    "reasoning",
    "tool_execution",
    "a2a_task",
    "system_step",
    "approval",
  ]),
  2: new Set([
    "mode_selection",
    "reasoning",
    "model_summary",
    "tool_execution",
    "a2a_tool_execution",
    "a2a_task",
  ]),
};

/**
 * 校验步骤输出是否符合消息列表结构。
 * @param value 待校验的步骤输出。
 * @returns 结构有效时返回 true。
 */
export function isStepOutput(value: unknown): value is StepOutput {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.messages)
  )
    return false;
  return value.messages.every(
    (message: unknown) =>
      isRecord(message) &&
      Object.keys(message).length === 3 &&
      typeof message.messageId === "string" &&
      message.messageId.length > 0 &&
      (message.type === "text" || message.type === "reasoning") &&
      typeof message.text === "string",
  );
}

/**
 * 校验并解析 Agent 运行活动数据，同时过滤当前版本不支持展示的事件。
 * @param value 待解析的活动数据。
 * @returns 数据有效时返回解析后的活动，无效时返回 null。
 */
export function parseAgentRunActivity(value: unknown): AgentRunActivity | null {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isRecord(value.run) ||
    !Array.isArray(value.events)
  )
    return null;
  const run = value.run;
  if (
    typeof run.runId !== "string" ||
    !run.runId ||
    typeof run.threadId !== "string" ||
    !run.threadId ||
    ![
      "queued",
      "running",
      "awaiting_approval",
      "completed",
      "failed",
      "cancelled",
      "awaiting_input",
      "awaiting_auth",
      "rejected",
    ].includes(String(run.status)) ||
    typeof run.startedAt !== "string" ||
    Number.isNaN(Date.parse(run.startedAt)) ||
    typeof run.updatedAt !== "string" ||
    Number.isNaN(Date.parse(run.updatedAt)) ||
    !(
      run.finishedAt === null ||
      (typeof run.finishedAt === "string" &&
        !Number.isNaN(Date.parse(run.finishedAt)))
    ) ||
    !(run.error === null || typeof run.error === "string")
  )
    return null;
  const supportedTypes = activityTypes[value.schemaVersion];
  // 只过滤展示数据；JSON Patch 仍按原始事件数组位置应用增量。
  const events = value.events.filter(
    (entry: unknown) =>
      !isRecord(entry) ||
      typeof entry.type !== "string" ||
      !entry.type ||
      supportedTypes.has(entry.type),
  );
  if (
    !events.every((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !entry.id ||
        !Number.isInteger(entry.sequence) ||
        Number(entry.sequence) < 1 ||
        typeof entry.type !== "string" ||
        typeof entry.title !== "string" ||
        !entry.title ||
        ![
          "queued",
          "running",
          "awaiting_approval",
          "completed",
          "failed",
          "cancelled",
          "awaiting_input",
          "awaiting_auth",
          "rejected",
        ].includes(String(entry.status)) ||
        typeof entry.startedAt !== "string" ||
        Number.isNaN(Date.parse(entry.startedAt)) ||
        typeof entry.updatedAt !== "string" ||
        Number.isNaN(Date.parse(entry.updatedAt)) ||
        !(
          entry.finishedAt === null ||
          (typeof entry.finishedAt === "string" &&
            !Number.isNaN(Date.parse(entry.finishedAt)))
        ) ||
        !(entry.error === null || typeof entry.error === "string")
      )
        return false;
      if (value.schemaVersion === 2) {
        if (
          !(entry.input === null || isRecord(entry.input)) ||
          !Object.hasOwn(entry, "output")
        )
          return false;
        if (entry.type === "mode_selection")
          return entry.title === "模式选择" && entry.output === null;
        if (entry.type === "reasoning" || entry.type === "model_summary") {
          const title = entry.type === "reasoning" ? "Thinking" : "模型总结";
          return (
            entry.title === title &&
            (entry.output === null || isStepOutput(entry.output))
          );
        }
        if (entry.type === "a2a_tool_execution")
          return (
            isRecord(entry.tool) &&
            typeof entry.tool.name === "string" &&
            entry.tool.name.length > 0 &&
            (entry.tool.server === undefined ||
              typeof entry.tool.server === "string") &&
            isRecord(entry.correlation) &&
            Object.keys(entry.correlation).length === 1 &&
            typeof entry.correlation.toolCallId === "string" &&
            entry.correlation.toolCallId.length > 0
          );
        if (entry.type === "a2a_task")
          return (
            isRecord(entry.correlation) &&
            Object.keys(entry.correlation).length === 1 &&
            typeof entry.correlation.taskId === "string" &&
            isRecord(entry.output) &&
            typeof entry.output.taskId === "string" &&
            isRecord(entry.output.status) &&
            Object.hasOwn(entry.output.status, "state") &&
            isRecord(entry.output.update) &&
            ["running", "awaiting_input", "awaiting_auth", "completed", "failed", "cancelled", "rejected"].includes(String(entry.status))
          );
        return (
          entry.type === "tool_execution" &&
          isRecord(entry.tool) &&
          typeof entry.tool.name === "string" &&
          entry.tool.name.length > 0 &&
          (entry.tool.server === undefined ||
            typeof entry.tool.server === "string") &&
          isRecord(entry.correlation) &&
          Object.keys(entry.correlation).length === 1 &&
          typeof entry.correlation.toolCallId === "string" &&
          entry.correlation.toolCallId.length > 0 &&
          (entry.request_id === undefined ||
            (typeof entry.request_id === "string" && entry.request_id.length > 0)) &&
          (entry.status !== "awaiting_approval" ||
            (typeof entry.request_id === "string" && entry.request_id.length > 0))
        );
      }
      if (entry.type === "model_inference")
        return (
          entry.correlation === undefined ||
          (isRecord(entry.correlation) &&
            typeof entry.correlation.messageId === "string" &&
            entry.correlation.messageId.length > 0)
        );
      if (entry.type === "reasoning")
        return (
          entry.correlation === undefined ||
          (isRecord(entry.correlation) &&
            typeof entry.correlation.reasoningId === "string" &&
            entry.correlation.reasoningId.length > 0)
        );
      if (entry.type === "tool_execution")
        return (
          isRecord(entry.tool) &&
          typeof entry.tool.name === "string" &&
          entry.tool.name.length > 0 &&
          (entry.correlation === undefined ||
            (isRecord(entry.correlation) &&
              typeof entry.correlation.toolCallId === "string" &&
              entry.correlation.toolCallId.length > 0)) &&
          (entry.request_id === undefined ||
            (typeof entry.request_id === "string" && entry.request_id.length > 0)) &&
          (entry.status !== "awaiting_approval" ||
            (typeof entry.request_id === "string" && entry.request_id.length > 0))
        );
      if (entry.type === "a2a_task")
        return (
          isRecord(entry.correlation) &&
          typeof entry.correlation.taskId === "string" &&
          isRecord(entry.output) &&
          typeof entry.output.taskId === "string" &&
          isRecord(entry.output.status) &&
          Object.hasOwn(entry.output.status, "state") &&
          isRecord(entry.output.update)
        );
      if (entry.type === "approval")
        return (
          isRecord(entry.approval) &&
          (typeof entry.approval.requestId === "string" ||
            entry.approval.requestId === null) &&
          entry.approval.status === "awaiting_approval"
        );
      return entry.type === "system_step";
    })
  )
    return null;
  return { ...value, events } as unknown as AgentRunActivity;
}

/**
 * 将 JSON Pointer 路径解码为路径片段。
 * @param path JSON Pointer 格式的路径。
 * @returns 解码后的路径片段数组。
 */
function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("JSON Patch 路径必须以 / 开头");
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?![01])/.test(part)) throw new Error("JSON Patch 路径转义无效");
      return part.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

/**
 * 校验并转换 JSON Patch 数组索引。
 * @param segment 路径中的索引文本。
 * @param length 目标数组长度。
 * @param allowEnd 是否允许索引指向数组末尾。
 * @returns 转换后的数组索引。
 */
function indexOf(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(segment))
    throw new Error("JSON Patch 数组索引无效");
  const index = Number(segment);
  if (index > length || (!allowEnd && index === length))
    throw new Error("JSON Patch 数组索引越界");
  return index;
}

/**
 * 从根对象读取指定路径的值。
 * @param root 要读取的根对象。
 * @param path 已解码的路径片段。
 * @returns 路径对应的值。
 */
function readAt(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current))
      current = current[indexOf(segment, current.length, false)];
    else if (isRecord(current) && Object.hasOwn(current, segment))
      current = current[segment];
    else throw new Error("JSON Patch 来源路径不存在");
  }
  return current;
}

/**
 * 按 JSON Patch 操作修改对象或数组中的指定路径。
 * @param root 要修改的根对象。
 * @param path 已解码的目标路径。
 * @param value 要写入的值。
 * @param mode 要执行的添加、替换或删除操作。
 * @returns 修改后的根对象。
 */
function setAt(
  root: unknown,
  path: string[],
  value: unknown,
  mode: "add" | "replace" | "remove",
): unknown {
  if (path.length === 0) {
    if (mode === "remove") throw new Error("不能移除活动快照根节点");
    return value;
  }
  let parent = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(parent))
      parent = parent[indexOf(segment, parent.length, false)];
    else if (isRecord(parent) && Object.hasOwn(parent, segment))
      parent = parent[segment];
    else throw new Error("JSON Patch 目标路径不存在");
  }
  const key = path[path.length - 1];
  if (Array.isArray(parent)) {
    if (mode === "add" && key === "-") parent.push(value);
    else {
      const index = indexOf(key, parent.length, mode === "add");
      if (mode === "add") parent.splice(index, 0, value);
      else if (mode === "replace") parent[index] = value;
      else parent.splice(index, 1);
    }
  } else if (isRecord(parent)) {
    if (mode === "replace" && !Object.hasOwn(parent, key))
      throw new Error("JSON Patch replace 目标不存在");
    if (mode === "remove") {
      if (!Object.hasOwn(parent, key))
        throw new Error("JSON Patch remove 目标不存在");
      delete parent[key];
    } else parent[key] = value;
  } else throw new Error("JSON Patch 目标父路径无效");
  return root;
}

/**
 * 按顺序将 JSON Patch 操作应用到活动内容副本。
 * @param content 当前活动内容。
 * @param patch 待应用的 JSON Patch 操作列表。
 * @returns 应用补丁后的活动内容。
 */
export function applyActivityPatch(
  content: Record<string, unknown>,
  patch: unknown,
): Record<string, unknown> {
  if (!Array.isArray(patch)) throw new Error("ACTIVITY_DELTA.patch 必须是数组");
  let next: unknown = structuredClone(content);
  for (const operation of patch) {
    if (
      !isRecord(operation) ||
      typeof operation.op !== "string" ||
      typeof operation.path !== "string"
    )
      throw new Error("JSON Patch 操作结构无效");
    const path = decodePointer(operation.path);
    if (operation.op === "add" || operation.op === "replace") {
      if (!Object.hasOwn(operation, "value"))
        throw new Error("JSON Patch 缺少 value");
      next = setAt(next, path, operation.value, operation.op);
    } else if (operation.op === "remove")
      next = setAt(next, path, undefined, "remove");
    else if (operation.op === "copy" || operation.op === "move") {
      if (typeof operation.from !== "string")
        throw new Error("JSON Patch 缺少 from");
      const from = decodePointer(operation.from);
      const copied = structuredClone(readAt(next, from));
      if (operation.op === "move")
        next = setAt(next, from, undefined, "remove");
      next = setAt(next, path, copied, "add");
    } else if (operation.op === "test") {
      if (
        !Object.hasOwn(operation, "value") ||
        JSON.stringify(readAt(next, path)) !== JSON.stringify(operation.value)
      )
        throw new Error("JSON Patch test 未通過");
    } else throw new Error(`不支持的 JSON Patch 操作：${operation.op}`);
  }
  if (!isRecord(next)) throw new Error("JSON Patch 结果不是对象");
  return next;
}

/**
 * 根据活动快照更新当前活动及其同步状态。
 * @param current 当前活动消息；没有活动时为 null。
 * @param event 收到的活动快照事件。
 * @param sync 当前同步状态，默认为 ready。
 * @returns 更新后的活动消息和同步状态。
 */
export function reduceActivitySnapshot(
  current: ActivityMessage | null,
  event: ActivitySnapshotEvent,
  sync: ActivitySyncState = "ready",
): { activity: ActivityMessage | null; sync: ActivitySyncState } {
  if (event.activityType !== "agent_run") return { activity: current, sync };
  // A non-replacing snapshot is informational only; it must not change either
  // the content or synchronization state of the current activity.
  if (event.replace === false) return { activity: current, sync };
  const activity: ActivityMessage = {
    id: event.messageId,
    role: "activity",
    activityType: event.activityType,
    content: structuredClone(event.content),
    ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}),
  };
  return {
    activity,
    sync: parseAgentRunActivity(activity.content) ? "ready" : "needs_snapshot",
  };
}

/**
 * 将活动增量应用到当前活动，并在数据不一致时请求新快照。
 * @param current 当前活动消息；没有活动时为 null。
 * @param event 收到的活动增量事件。
 * @param sync 当前同步状态。
 * @returns 更新后的活动消息和同步状态。
 */
export function reduceActivityDelta(
  current: ActivityMessage | null,
  event: ActivityDeltaEvent,
  sync: ActivitySyncState,
): { activity: ActivityMessage | null; sync: ActivitySyncState } {
  if (event.activityType !== "agent_run") return { activity: current, sync };
  if (
    !current ||
    current.id !== event.messageId ||
    current.activityType !== event.activityType ||
    sync === "needs_snapshot"
  )
    return { activity: current, sync: "needs_snapshot" };
  try {
    const content = applyActivityPatch(current.content, event.patch);
    if (!parseAgentRunActivity(content)) throw new Error("活动数据结构无效");
    return { activity: { ...current, content }, sync: "ready" };
  } catch {
    return { activity: current, sync: "needs_snapshot" };
  }
}
