import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApprovalRequest } from "./approval";

const request = {
  type: "approval_request",
  schema_version: 1,
  request_id: "request-1",
  action: "query_alert_details",
  title: "审批 MCP 工具调用",
  rationale: "工具策略要求审批",
  change_plan: '{"id":61880}',
  evidence: [],
  inputs: [],
};

test("approval action accepts any non-empty LangGraph action", () => {
  assert.deepEqual(parseApprovalRequest(request), request);
  assert.equal(parseApprovalRequest({ ...request, action: "  " }), null);
});

test("approval request from LangGraph interrupt metadata has the supported shape", () => {
  const metadata = {
    langgraph: {
      raw: {
        ...request,
        action: "restart_pod",
        request_id: "2d00162f-8c49-57a3-a852-9c1fa7636cf4",
        inputs: [{ key: "impact_confirmed", type: "confirm", label: "确认已了解重启影响", required: true, mustBeTrue: true }],
        execution: { mode: "approval_gate", onApproved: "execute_original_call", onRejected: "cancel_call" },
      },
    },
  };
  assert.deepEqual(parseApprovalRequest(metadata.langgraph.raw), metadata.langgraph.raw);
});
