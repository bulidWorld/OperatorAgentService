#!/usr/bin/env bash
# 查询 Kubernetes Events；可组合 namespace、objectType、objectName、eventType、hours、limit、cursor。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body --get "${BASE_URL}/api/events" \
  --data-urlencode 'namespace=default' \
  --data-urlencode 'hours=24' \
  --data-urlencode 'limit=100'
