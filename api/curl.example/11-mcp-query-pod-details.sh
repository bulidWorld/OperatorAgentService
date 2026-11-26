#!/usr/bin/env bash
# 调用 MCP query_pod_details 工具查询指定 Pod 的完整详情。
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MCP_TOKEN:?请先设置 MCP_TOKEN}"
NAMESPACE="${NAMESPACE:-default}"
POD="${POD:?请设置 POD，例如 POD=nginx-abc123}"

curl --fail-with-body -X POST "${BASE_URL}/api/v1/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  --data "$(jq -n --arg namespace "${NAMESPACE}" --arg pod "${POD}" \
    '{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"query_pod_details",arguments:{namespace:$namespace,pod:$pod}}}')"
