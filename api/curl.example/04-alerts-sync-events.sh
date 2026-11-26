#!/usr/bin/env bash
# 先立即同步 Kubernetes Events，再查询告警。需要服务端可访问 Kubernetes API。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body --get "${BASE_URL}/api/alerts" \
  --data-urlencode 'refresh=true' \
  --data-urlencode 'limit=100'
