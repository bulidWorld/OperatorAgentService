#!/usr/bin/env bash
# 列出当前 MCP 凭证获准使用的工具。
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MCP_TOKEN:?请先设置 MCP_TOKEN}"
curl --fail-with-body -X POST "${BASE_URL}/api/v1/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
