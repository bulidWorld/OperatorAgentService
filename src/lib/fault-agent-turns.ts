import type { AgentRunActivity, ActivitySyncState } from "./activity";

type ChatMessage = { id: string; role: string; content?: unknown };
type RunEntry = { activity: AgentRunActivity; sync: ActivitySyncState };

/** Group protocol messages by user turn, independently of CopilotKit's rendered rows. */
/**
 * 将用户消息、Agent 活动、成功结果和失败状态归并为会话轮次。
 * @param messages CopilotKit 会话中的消息列表。
 * @param activities 按运行编号索引的活动及其同步状态。
 * @param results 按运行编号索引的最终回复。
 * @param failedRuns 按运行编号索引的失败说明。
 * @param owners 按运行编号记录所属用户消息编号。
 * @returns 按会话顺序排列的用户轮次及其运行信息。
 */
export function buildFaultAgentTurns(
  messages: readonly ChatMessage[],
  activities: Record<string, RunEntry>,
  runUsers: Record<string, string>,
  results: Record<string, string>,
  failedRuns: Record<string, boolean> = {},
) {
  const turns: Array<{ user: { id: string; content: string }; runs: RunEntry[]; reply: string; failed: boolean }> = [];
  const owners = { ...runUsers };
  let current: (typeof turns)[number] | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      current = { user: { id: message.id, content: typeof message.content === "string" ? message.content : "" }, runs: [], reply: "", failed: false };
      turns.push(current);
    } else if (current && message.role === "activity") {
      const runId = (message.content as AgentRunActivity | undefined)?.run?.runId;
      if (runId && !owners[runId]) owners[runId] = current.user.id;
    }
  }
  for (const entry of Object.values(activities).sort((a, b) => a.activity.run.startedAt.localeCompare(b.activity.run.startedAt))) {
    const turn = turns.find((item) => item.user.id === owners[entry.activity.run.runId]);
    if (turn) turn.runs.push(entry);
  }
  for (const [runId, reply] of Object.entries(results)) {
    const turn = turns.find((item) => item.user.id === owners[runId]);
    if (turn && reply.trim()) turn.reply = reply;
  }
  for (const [runId, failed] of Object.entries(failedRuns)) {
    const turn = turns.find((item) => item.user.id === owners[runId]);
    if (turn && failed) turn.failed = true;
  }
  return turns;
}
