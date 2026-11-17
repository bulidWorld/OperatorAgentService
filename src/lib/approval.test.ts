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
