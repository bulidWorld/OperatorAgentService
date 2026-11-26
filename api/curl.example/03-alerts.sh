#!/usr/bin/env bash
# 查询告警，可组合 source、alertType、severity、from、to、limit 和 cursor。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body --get "${BASE_URL}/api/alerts" \
  --data-urlencode 'source=kubernetes' \
  --data-urlencode 'limit=50'
