import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type ActivityDeltaEvent, type ActivityMessage, type ActivitySnapshotEvent } from "@ag-ui/client";
import { parseAgentRunActivity, reduceActivityDelta, reduceActivitySnapshot } from "./activity";

// Real event content and arrival order from the reported AG-UI stream.
const messageId = "2d8c3a7d-ce79-4849-94ef-2265bcd51ab1:agent_run";
const snapshot: ActivitySnapshotEvent = {
  type: EventType.ACTIVITY_SNAPSHOT,
  timestamp: 1795051110661,
  messageId,
  activityType: "agent_run",
  content: {
    schemaVersion: 1,
    run: {
      runId: "05504594-6867-4bc6-9591-09539fee9ef3",
      threadId: "2d8c3a7d-ce79-4849-94ef-2265bcd51ab1",
      status: "running",
      startedAt: "2026-11-19T01:18:30.606Z",
      updatedAt: "2026-11-19T01:18:30.606Z",
      finishedAt: null,
      error: null,
    },
    events: [],
  },
};

const deltas: ActivityDeltaEvent[] = [
  {
    type: EventType.ACTIVITY_DELTA,
    timestamp: 1795051110671,
    messageId,
    activityType: "agent_run",
    patch: [
      {
        op: "add",
        path: "/events/-",
        value: {
          id: "model_inference-36a1830347bd408e9d63de51573b824e",
          sequence: 1,
          type: "model_inference",
          title: "大模型回复",
          status: "running",
          startedAt: "2026-11-19T01:18:30.671Z",
          updatedAt: "2026-11-19T01:18:30.671Z",
          finishedAt: null,
          input: {},
          output: null,
          error: null,
        },
      },
      { op: "replace", path: "/run/updatedAt", value: "2026-11-19T01:18:30.671Z" },
    ],
  },
  {
    type: EventType.ACTIVITY_DELTA,
    timestamp: 1795051112451,
    messageId,
    activityType: "agent_run",
    patch: [
      { op: "replace", path: "/events/0/status", value: "failed" },
      { op: "replace", path: "/events/0/finishedAt", value: "2026-11-19T01:18:32.451Z" },
      { op: "replace", path: "/events/0/updatedAt", value: "2026-11-19T01:18:32.451Z" },
      { op: "replace", path: "/run/updatedAt", value: "2026-11-19T01:18:32.451Z" },
    ],
  },
  {
    type: EventType.ACTIVITY_DELTA,
    timestamp: 1795051112452,
    messageId,
    activityType: "agent_run",
    patch: [
      { op: "replace", path: "/run/status", value: "failed" },
      { op: "replace", path: "/run/updatedAt", value: "2026-11-19T01:18:32.452Z" },
      { op: "replace", path: "/run/finishedAt", value: "2026-11-19T01:18:32.452Z" },
      { op: "replace", path: "/run/error", value: "MCP Server 配置文件不存在：/etc/langgraph-service/secrets/MCP_SERVERS_CONFIG" },
    ],
  },
];

/**
 * 验证真实快照及增量事件可以持续同步且不会显示不可用提示。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("the real snapshot and activity deltas stay synchronized without the unavailable notice", () => {
  let state = reduceActivitySnapshot(null, snapshot);
  assert.equal(state.sync, "ready");

  for (const delta of deltas) {
    state = reduceActivityDelta(state.activity, delta, state.sync);
    assert.equal(state.sync, "ready");
    assert.ok(state.activity);
  }

  const activity = state.activity as ActivityMessage;
  assert.equal(activity.content.run.status, "failed");
  assert.equal(activity.content.run.error, "MCP Server 配置文件不存在：/etc/langgraph-service/secrets/MCP_SERVERS_CONFIG");
  assert.equal(activity.content.events[0].status, "failed");
});

/**
 * 验证非替换快照不会覆盖活动内容或修复失步状态。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("non-replacing snapshots preserve the activity and its out-of-sync state", () => {
  const content = structuredClone(snapshot.content);
  content.events.push({
    id: "step-1",
    sequence: 1,
    type: "system_step",
    title: "检查服务状态",
    status: "completed",
    startedAt: "2026-11-19T01:18:30.671Z",
    updatedAt: "2026-11-19T01:18:31.000Z",
    finishedAt: "2026-11-19T01:18:31.000Z",
    error: null,
  });
  let state = reduceActivitySnapshot(null, { ...snapshot, content });
  const activity = state.activity;
  assert.ok(activity);

  state = reduceActivityDelta(activity, { ...deltas[0], patch: [{ op: "replace", path: "/missing", value: true }] }, state.sync);
  assert.equal(state.sync, "needs_snapshot");
  assert.equal(parseAgentRunActivity(state.activity?.content)?.events[0].title, "检查服务状态");

  state = reduceActivitySnapshot(state.activity, { ...snapshot, replace: false, content: {} }, state.sync);
  assert.equal(state.sync, "needs_snapshot");
  assert.equal(parseAgentRunActivity(state.activity?.content)?.events[0].title, "检查服务状态");

  state = reduceActivitySnapshot(state.activity, snapshot, state.sync);
  assert.equal(state.sync, "ready");
});

/**
 * 验证推理事件可通过校验并保留其摘要展示数据。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("accepts reasoning events and keeps only their summary available for display", () => {
  const content = structuredClone(snapshot.content);
  content.events.push({
    id: "reasoning-1",
    sequence: 1,
    type: "reasoning",
    title: "推理摘要",
    status: "completed",
    startedAt: "2026-11-19T01:18:30.671Z",
    updatedAt: "2026-11-19T01:18:30.671Z",
    finishedAt: "2026-11-19T01:18:31.000Z",
    input: {},
    output: { summary: [{ type: "summary_text", text: "正在分析相关信息。" }] },
    error: null,
    correlation: { reasoningId: "rs_123" },
  });

  const parsed = parseAgentRunActivity(content);
  assert.ok(parsed);
  assert.equal(parsed.events[0].type, "reasoning");
});

/**
 * 验证审批事件在请求编号为空或存在时均可正确校验。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("accepts approval events with or without a request id", () => {
  const content = structuredClone(snapshot.content);
  content.events.push({
    id: "approval-1",
    sequence: 1,
    type: "approval",
    title: "等待人工审批",
    status: "awaiting_approval",
    startedAt: "2026-11-19T01:18:30.671Z",
    updatedAt: "2026-11-19T01:18:30.671Z",
    finishedAt: null,
    input: {},
    output: null,
    error: null,
    approval: { requestId: null, status: "awaiting_approval" },
  });

  assert.equal(parseAgentRunActivity(content)?.events[0].type, "approval");
  content.events[0].approval = { requestId: "approval-123", status: "awaiting_approval" };
  assert.equal(parseAgentRunActivity(content)?.events[0].approval?.requestId, "approval-123");
  content.events[0].approval = { requestId: null, status: "completed" };
  assert.equal(parseAgentRunActivity(content), null);
});

/**
 * 验证待审批工具活动必须携带有效 request_id，普通工具活动可省略。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("requires request_id only for tool executions awaiting approval", () => {
  const content = structuredClone(snapshot.content);
  const event: Record<string, unknown> = {
    id: "tool_execution-1",
    sequence: 1,
    type: "tool_execution",
    title: "restart_pod",
    status: "awaiting_approval",
    startedAt: "2026-11-19T01:18:30.671Z",
    updatedAt: "2026-11-19T01:18:30.671Z",
    finishedAt: null,
    input: {},
    output: null,
    error: null,
    tool: { name: "restart_pod" },
    correlation: { toolCallId: "call-1" },
  };
  content.events.push(event);
  assert.equal(parseAgentRunActivity(content), null);

  event.request_id = "request-1";
  assert.equal(parseAgentRunActivity(content)?.events[0].request_id, "request-1");
  event.request_id = "";
  assert.equal(parseAgentRunActivity(content), null);
});

/**
 * 验证 v2 模式选择完成后，后续步骤仍能保持同步。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("v2 mode selection stays synchronized through completion and the next step", () => {
  const content = { ...structuredClone(snapshot.content), schemaVersion: 2 };
  const first = deltas[0].patch[0];
  assert.ok(first.op === "add");
  const mode = { ...first.value, id: "mode-1", type: "mode_selection", title: "模式选择" };
  let state = reduceActivitySnapshot(null, { ...snapshot, content });
  const patches: ActivityDeltaEvent["patch"][] = [
    [{ op: "add", path: "/events/-", value: mode }],
    [
      { op: "replace", path: "/events/0/status", value: "completed" },
      { op: "replace", path: "/events/0/finishedAt", value: "2026-11-19T01:18:31.000Z" },
      { op: "replace", path: "/events/0/output", value: null },
    ],
    [{ op: "add", path: "/events/-", value: { ...first.value, sequence: 2, type: "reasoning", title: "Thinking" } }],
  ];
  for (const patch of patches) {
    state = reduceActivityDelta(state.activity, { ...deltas[0], patch }, state.sync);
    assert.equal(state.sync, "ready");
  }
  const events = parseAgentRunActivity(state.activity?.content)?.events;
  assert.equal(events?.[0].status, "completed");
  assert.equal(events?.[1].type, "reasoning");
});

/**
 * 验证未知事件类型不展示，且补丁仍按原始数组索引更新。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("unknown activity types are hidden without shifting JSON Patch indices", () => {
  const unknown = { type: "future_step", status: "running" };
  const first = deltas[0].patch[0];
  assert.ok(first.op === "add");
  const step = { ...first.value, sequence: 2, type: "reasoning", title: "Thinking" };
  for (const schemaVersion of [1, 2]) {
    const content = { ...snapshot.content, schemaVersion, events: [unknown] };
    let state = reduceActivitySnapshot(null, { ...snapshot, content });
    assert.equal(state.sync, "ready");
    assert.deepEqual(parseAgentRunActivity(state.activity?.content)?.events, []);
    state = reduceActivityDelta(state.activity, {
      ...deltas[0],
      patch: [
        { op: "add", path: "/events/-", value: step },
        { op: "add", path: "/events/-", value: { type: "another_future_step" } },
        { op: "replace", path: "/events/0/status", value: "completed" },
        { op: "replace", path: "/events/1/status", value: "failed" },
      ],
    }, state.sync);
    assert.equal(state.sync, "ready");
    assert.equal(state.activity?.content.events[0].status, "completed");
    assert.deepEqual(parseAgentRunActivity(state.activity?.content)?.events, [{ ...step, status: "failed" }]);
  }
});

/**
 * 验证 v2 步骤允许空输出并按顺序应用消息增量。
 * @returns 无返回值；断言失败时由测试框架报告错误。
 */
test("v2 step activities accept null output and apply ordered message deltas", () => {
  const content = { ...structuredClone(snapshot.content), schemaVersion: 2 };
  let state = reduceActivitySnapshot(null, { ...snapshot, content });
  const legacyStep = deltas[0].patch[0];
  assert.ok(legacyStep.op === "add");
  const step = { ...legacyStep.value, type: "reasoning", title: "Thinking" };
    /**
 * 执行 apply 相关处理。
 * @param patch patch 参数。
 * @returns 执行结果。
 */
    const apply = (patch: ActivityDeltaEvent["patch"]) => {
    state = reduceActivityDelta(state.activity, { ...deltas[0], patch }, state.sync);
    assert.equal(state.sync, "ready");
  };
  apply([
    { op: "add", path: "/events/-", value: step },
    { op: "add", path: "/events/-", value: { ...step, id: "summary-1", sequence: 2, type: "model_summary", title: "模型总结" } },
  ]);

  const messages = [
    { messageId: "reasoning-1", type: "reasoning", text: "检查服务状态" },
    { messageId: "text-1", type: "text", text: "服务运行正常" },
  ];
  apply([
    { op: "replace", path: "/events/0/output", value: { messages: [messages[0]] } },
    { op: "add", path: "/events/0/output/messages/-", value: messages[1] },
    { op: "replace", path: "/events/1/output", value: { messages: [messages[1]] } },
  ]);
  assert.deepEqual(parseAgentRunActivity(state.activity?.content)?.events.map(({ output }) => output), [
    { messages },
    { messages: [messages[1]] },
  ]);

  const invalid = reduceActivityDelta(state.activity, {
    ...deltas[0],
    patch: [{ op: "replace", path: "/events/1/output", value: { text: "旧格式" } }],
  }, state.sync);
  assert.equal(invalid.sync, "needs_snapshot");
  assert.equal(invalid.activity, state.activity);
  assert.deepEqual(parseAgentRunActivity({ ...content, events: [legacyStep.value] })?.events, []);
});
