import assert from "node:assert/strict";
import test from "node:test";
import {
  appendMessageText,
  correlatedModelText,
  correlatedToolResult,
  storeToolResult,
} from "./activity-details";

// Shortened from the user's AG-UI stream sample: consecutive TEXT_MESSAGE_CONTENT events.
const textEvents = [
  { type: "TEXT_MESSAGE_CONTENT", messageId: "resp_model_1", delta: "ClickHouse 查询到 " },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "resp_model_1", delta: "2 个 Pod，状态均为 Running。" },
];

// Shortened from the user's stream sample: TOOL_CALL_RESULT for query_pods.
const toolResultEvent = {
  type: "TOOL_CALL_RESULT",
  toolCallId: "call_3c96456275fa4e47a6207bf0c597ac74",
  content: [{ type: "text", text: "{\"total\":2,\"pods\":[{\"namespace\":\"clickhouse\",\"name\":\"chi-clickhouse-installation-ck-db01-0-0-0\",\"phase\":\"Running\"}]}" }],
};

test("concatenates TEXT_MESSAGE_CONTENT deltas by messageId", () => {
  const messages = textEvents.reduce(
    (current, event) => appendMessageText(current, event.messageId, event.delta),
    {} as Record<string, string>,
  );

  assert.equal(correlatedModelText(messages, "resp_model_1"), "ClickHouse 查询到 2 个 Pod，状态均为 Running。");
  assert.equal(correlatedModelText(messages, "another_message"), undefined);
});

test("stores TOOL_CALL_RESULT content by toolCallId for its activity entry", () => {
  const results = storeToolResult({}, toolResultEvent.toolCallId, toolResultEvent.content);

  assert.deepEqual(correlatedToolResult(results, "call_3c96456275fa4e47a6207bf0c597ac74"), toolResultEvent.content);
  assert.equal(correlatedToolResult(results, "another_tool_call"), undefined);
});
