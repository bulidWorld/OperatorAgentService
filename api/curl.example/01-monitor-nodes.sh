#!/usr/bin/env bash
# 查询 Node 监控面板；可选 scope=pods、minutes=15|60|360|1440、step=auto|5|15|30|60|300。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body --get "${BASE_URL}/api/monitor" \
  --data-urlencode 'scope=nodes' \
  --data-urlencode 'minutes=60' \
  --data-urlencode 'step=auto'
