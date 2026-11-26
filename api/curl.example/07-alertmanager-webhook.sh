#!/usr/bin/env bash
# 推送一条 Alertmanager v4 firing 告警；WEBHOOK_TOKEN 须与服务端配置一致。
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${WEBHOOK_TOKEN:?请先设置 WEBHOOK_TOKEN}"
curl --fail-with-body -X POST "${BASE_URL}/api/webhooks/alertmanager" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${WEBHOOK_TOKEN}" \
  --data '{"version":"4","status":"firing","receiver":"operator-agent-service","alerts":[{"status":"firing","fingerprint":"demo-alert-001","labels":{"alertname":"DemoAlert","severity":"warning","namespace":"default","pod":"demo-pod"},"annotations":{"summary":"示例告警","description":"curl 示例推送的测试告警"},"startsAt":"2026-11-26T00:00:00Z","endsAt":"0001-01-01T00:00:00Z","generatorURL":"http://prometheus.example/graph"}]}'
