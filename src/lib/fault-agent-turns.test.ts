import assert from "node:assert/strict";
import test from "node:test";
import { buildFaultAgentTurns } from "./fault-agent-turns";
import type { AgentRunActivity } from "./activity";

function activity(runId: string): AgentRunActivity {
  return { schemaVersion: 1, run: { runId, threadId: "thread", status: "completed", startedAt: "2026-11-18T08:00:00Z", updatedAt: "2026-11-18T08:01:00Z", finishedAt: "2026-11-18T08:01:00Z", error: null }, events: [] };
}

test("keeps multiple runs and final replies with their respective user turns", () => {
  const turns = buildFaultAgentTurns([
    { id: "u1", role: "user", content: "CPU 呢" },
    { id: "tool", role: "tool", content: "internal tool output" },
    { id: "a1", role: "assistant", content: "CPU 正常" },
    { id: "u2", role: "user", content: "磁盘呢" },
    { id: "reasoning", role: "reasoning", content: "hidden" },
    { id: "a2", role: "assistant", content: "磁盘正常" },
  ], { r1: { activity: activity("r1"), sync: "ready" }, r2: { activity: activity("r2"), sync: "ready" } }, { r1: "u1", r2: "u2" }, {});
  assert.deepEqual(turns.map((turn) => [turn.user.id, turn.runs[0].activity.run.runId, turn.reply]), [["u1", "r1", "CPU 正常"], ["u2", "r2", "磁盘正常"]]);
});

test("uses run result when no final text event was emitted, without duplicating a reply", () => {
  const turns = buildFaultAgentTurns([{ id: "u1", role: "user", content: "排查" }, { id: "a1", role: "assistant", content: "初步分析" }], {}, { r1: "u1" }, { r1: "最终结论" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reply, "最终结论");
});

test("renders RUN_ERROR as the final reply for its run's user turn", () => {
  const turns = buildFaultAgentTurns(
    [{ id: "u1", role: "user", content: "排查" }],
    {},
    { r1: "u1" },
    {},
    { r1: "MCP Server 配置文件不存在" },
  );

  assert.equal(turns[0].reply, "MCP Server 配置文件不存在");
});

test("hydrates run ownership from activity history and retains a pending next turn", () => {
  const run = activity("r1");
  const turns = buildFaultAgentTurns([{ id: "u1", role: "user", content: "排查" }, { id: "activity", role: "activity", content: run }, { id: "a1", role: "assistant", content: "完成" }, { id: "u2", role: "user", content: "继续" }], { r1: { activity: run, sync: "ready" } }, {}, {});
  assert.equal(turns[0].runs[0].activity.run.runId, "r1");
  assert.equal(turns[1].runs.length, 0);
  assert.equal(turns[1].reply, "");
});
