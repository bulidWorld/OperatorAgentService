import assert from "node:assert/strict";
import test from "node:test";
import { buildFaultAgentTurns } from "./fault-agent-turns";
import type { AgentRunActivity } from "./activity";

/**
 * 执行 activity 相关处理。
 * @param runId runId 参数。
 * @returns 执行结果。
 */
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
  ], { r1: { activity: activity("r1"), sync: "ready" }, r2: { activity: activity("r2"), sync: "ready" } }, { r1: "u1", r2: "u2" }, { r1: "CPU 最终结论", r2: "磁盘最终结论" });
  assert.deepEqual(turns.map((turn) => [turn.user.id, turn.runs[0].activity.run.runId, turn.reply]), [["u1", "r1", "CPU 最终结论"], ["u2", "r2", "磁盘最终结论"]]);
});

test("uses RUN_FINISHED.result as the reply even when assistant messages are present", () => {
  const turns = buildFaultAgentTurns([{ id: "u1", role: "user", content: "排查" }, { id: "a1", role: "assistant", content: "初步分析" }], {}, { r1: "u1" }, { r1: "最终结论" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reply, "最终结论");
});

test("marks the turn failed without using RUN_ERROR as the reply", () => {
  const turns = buildFaultAgentTurns(
    [{ id: "u1", role: "user", content: "排查" }],
    {},
    { r1: "u1" },
    {},
    { r1: true },
  );

  assert.equal(turns[0].reply, "");
  assert.equal(turns[0].failed, true);
});

test("hydrates run ownership from activity history and retains a pending next turn", () => {
  const run = activity("r1");
  const turns = buildFaultAgentTurns([{ id: "u1", role: "user", content: "排查" }, { id: "activity", role: "activity", content: run }, { id: "a1", role: "assistant", content: "完成" }, { id: "u2", role: "user", content: "继续" }], { r1: { activity: run, sync: "ready" } }, {}, {});
  assert.equal(turns[0].runs[0].activity.run.runId, "r1");
  assert.equal(turns[0].reply, "");
  assert.equal(turns[1].runs.length, 0);
  assert.equal(turns[1].reply, "");
});
