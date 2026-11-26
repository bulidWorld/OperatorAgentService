#!/usr/bin/env bash
# 将指定告警标记为已解决；替换为实际数据库告警 ID。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body -X DELETE "${BASE_URL}/api/alerts" \
  -H 'Content-Type: application/json' \
  --data '{"ids":[42]}'
