#!/usr/bin/env bash
# MCP Streamable HTTP 初始化。后续请求需带服务端返回/协商的 MCP-Protocol-Version。
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MCP_TOKEN:?请先设置 MCP_TOKEN}"
curl --fail-with-body -X POST "${BASE_URL}/api/v1/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-example","version":"1.0.0"}}}'
