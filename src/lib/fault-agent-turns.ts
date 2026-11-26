import type { AgentRunActivity, ActivitySyncState } from "./activity";

type ChatMessage = { id: string; role: string; content?: unknown };
type RunEntry = { activity: AgentRunActivity; sync: ActivitySyncState };

/** Group protocol messages by user turn, independently of CopilotKit's rendered rows. */
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
