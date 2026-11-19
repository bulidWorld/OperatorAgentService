import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApprovalRequest } from "./approval";
import type { ApprovalRequest } from "./approval";

const request: ApprovalRequest = {
  type: "approval_request",
  schema_version: 1,
  request_id: "request-1",
  action: "query_alert_details",
  title: "审批 MCP 工具调用",
  rationale: "工具策略要求审批",
  change_plan: '{"id":61880}',
  evidence: [],
  inputs: [],
  mcp_server: "operator-agent-service",
  tool_name: "query_alert_details",
  execution: { mode: "approval_gate", onApproved: "execute_original_call", onRejected: "cancel_call" },
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

test("approval request accepts extensible evidence and schema field names", () => {
  const candidate = {
    ...request,
    evidence: [{ sourceId: "event-1", detail: "Pod restarted" }],
    inputs: [{ key: "note", type: "text", label: "说明", required: false, maxLength: 20 }],
  };
  assert.deepEqual(parseApprovalRequest(candidate), candidate);
});

test("rejection skips answers while mustBeTrue is enforced for approval", async () => {
  const { validateApprovalDecision } = await import("./approval");
  const gated = {
    ...request,
    inputs: [{ key: "confirm", type: "confirm" as const, label: "确认影响", required: true, mustBeTrue: true }],
  };
  assert.equal(validateApprovalDecision(gated, "rejected", {}), null);
  assert.match(validateApprovalDecision(gated, "approved", { confirm: false }) ?? "", /必须确认/);
  assert.equal(validateApprovalDecision(gated, "approved", { confirm: true }), null);
});
