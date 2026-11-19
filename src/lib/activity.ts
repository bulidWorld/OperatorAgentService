import type { ActivityDeltaEvent, ActivityMessage, ActivitySnapshotEvent } from "@ag-ui/client";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
export type ActivityStatus = RunStatus;

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
  input?: Record<string, unknown>;
  output?: { text?: string; content?: unknown[]; structuredContent?: unknown; resources?: unknown[]; [key: string]: unknown };
  correlation?: { reasoningId?: string; messageId?: string; toolCallId?: string; [key: string]: unknown };
  error?: string | null;
  approval?: { requestId?: string | null; status?: "awaiting_approval" | string; [key: string]: unknown };
  [key: string]: unknown;
};

export type AgentRunActivity = {
  schemaVersion: number;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseAgentRunActivity(value: unknown): AgentRunActivity | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.run) || !Array.isArray(value.events)) return null;
  const run = value.run;
  if (
    typeof run.runId !== "string" || !run.runId || typeof run.threadId !== "string" || !run.threadId ||
    !["queued", "running", "awaiting_approval", "completed", "failed", "cancelled"].includes(String(run.status)) ||
    typeof run.startedAt !== "string" || Number.isNaN(Date.parse(run.startedAt)) ||
    typeof run.updatedAt !== "string" || Number.isNaN(Date.parse(run.updatedAt)) ||
    !(run.finishedAt === null || (typeof run.finishedAt === "string" && !Number.isNaN(Date.parse(run.finishedAt)))) ||
    !(run.error === null || typeof run.error === "string")
  ) return null;
  const events = value.events as unknown[];
  if (!events.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || !Number.isInteger(entry.sequence) || Number(entry.sequence) < 1 || typeof entry.type !== "string" || typeof entry.title !== "string" || !entry.title || !["queued", "running", "awaiting_approval", "completed", "failed", "cancelled"].includes(String(entry.status)) || typeof entry.startedAt !== "string" || Number.isNaN(Date.parse(entry.startedAt)) || typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt)) || !(entry.finishedAt === null || (typeof entry.finishedAt === "string" && !Number.isNaN(Date.parse(entry.finishedAt)))) || !(entry.error === null || typeof entry.error === "string")) return false;
    if (entry.type === "model_inference") return entry.correlation === undefined || (isRecord(entry.correlation) && typeof entry.correlation.messageId === "string" && entry.correlation.messageId.length > 0);
    if (entry.type === "reasoning") return entry.correlation === undefined || (isRecord(entry.correlation) && typeof entry.correlation.reasoningId === "string" && entry.correlation.reasoningId.length > 0);
    if (entry.type === "tool_execution") return isRecord(entry.tool) && typeof entry.tool.name === "string" && entry.tool.name.length > 0 && (entry.correlation === undefined || (isRecord(entry.correlation) && typeof entry.correlation.toolCallId === "string" && entry.correlation.toolCallId.length > 0));
    if (entry.type === "approval") return isRecord(entry.approval) && (typeof entry.approval.requestId === "string" || entry.approval.requestId === null) && entry.approval.status === "awaiting_approval";
    return ["system_step", "approval"].includes(entry.type);
  })) return null;
  return value as unknown as AgentRunActivity;
}

function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("JSON Patch 路径必须以 / 开头");
  return path.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("JSON Patch 路径转义无效");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function indexOf(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error("JSON Patch 数组索引无效");
  const index = Number(segment);
  if (index > length || (!allowEnd && index === length)) throw new Error("JSON Patch 数组索引越界");
  return index;
}

function readAt(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[indexOf(segment, current.length, false)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else throw new Error("JSON Patch 来源路径不存在");
  }
  return current;
}

function setAt(root: unknown, path: string[], value: unknown, mode: "add" | "replace" | "remove"): unknown {
  if (path.length === 0) {
    if (mode === "remove") throw new Error("不能移除活动快照根节点");
    return value;
  }
  let parent = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[indexOf(segment, parent.length, false)];
    else if (isRecord(parent) && Object.hasOwn(parent, segment)) parent = parent[segment];
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
    if (mode === "replace" && !Object.hasOwn(parent, key)) throw new Error("JSON Patch replace 目标不存在");
    if (mode === "remove") {
      if (!Object.hasOwn(parent, key)) throw new Error("JSON Patch remove 目标不存在");
      delete parent[key];
    } else parent[key] = value;
  } else throw new Error("JSON Patch 目标父路径无效");
  return root;
}

export function applyActivityPatch(content: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (!Array.isArray(patch)) throw new Error("ACTIVITY_DELTA.patch 必须是数组");
  let next: unknown = structuredClone(content);
  for (const operation of patch) {
    if (!isRecord(operation) || typeof operation.op !== "string" || typeof operation.path !== "string") throw new Error("JSON Patch 操作结构无效");
    const path = decodePointer(operation.path);
    if (operation.op === "add" || operation.op === "replace") {
      if (!Object.hasOwn(operation, "value")) throw new Error("JSON Patch 缺少 value");
      next = setAt(next, path, operation.value, operation.op);
    } else if (operation.op === "remove") next = setAt(next, path, undefined, "remove");
    else if (operation.op === "copy" || operation.op === "move") {
      if (typeof operation.from !== "string") throw new Error("JSON Patch 缺少 from");
      const from = decodePointer(operation.from);
      const copied = structuredClone(readAt(next, from));
      if (operation.op === "move") next = setAt(next, from, undefined, "remove");
      next = setAt(next, path, copied, "add");
    } else if (operation.op === "test") {
      if (!Object.hasOwn(operation, "value") || JSON.stringify(readAt(next, path)) !== JSON.stringify(operation.value)) throw new Error("JSON Patch test 未通過");
    } else throw new Error(`不支持的 JSON Patch 操作：${operation.op}`);
  }
  if (!isRecord(next)) throw new Error("JSON Patch 结果不是对象");
  return next;
}

export function reduceActivitySnapshot(
  current: ActivityMessage | null,
  event: ActivitySnapshotEvent,
): { activity: ActivityMessage | null; sync: ActivitySyncState } {
  if (event.activityType !== "agent_run") return { activity: current, sync: "ready" };
  if (event.replace === false) return { activity: current, sync: "ready" };
  const activity: ActivityMessage = {
    id: event.messageId,
    role: "activity",
    activityType: event.activityType,
    content: structuredClone(event.content),
    ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}),
  };
  return { activity, sync: parseAgentRunActivity(activity.content) ? "ready" : "needs_snapshot" };
}

export function reduceActivityDelta(
  current: ActivityMessage | null,
  event: ActivityDeltaEvent,
  sync: ActivitySyncState,
): { activity: ActivityMessage | null; sync: ActivitySyncState } {
  if (event.activityType !== "agent_run") return { activity: current, sync };
  if (!current || current.id !== event.messageId || current.activityType !== event.activityType || sync === "needs_snapshot") return { activity: current, sync: "needs_snapshot" };
  try {
    const content = applyActivityPatch(current.content, event.patch);
    if (!parseAgentRunActivity(content)) throw new Error("活动数据结构无效");
    return { activity: { ...current, content }, sync: "ready" };
  } catch {
    return { activity: current, sync: "needs_snapshot" };
  }
}
