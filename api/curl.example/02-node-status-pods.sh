#!/usr/bin/env bash
# 查询 Pod 实时资源和 Ready 状态；将 scope 改为 nodes 可查询节点。
BASE_URL="${BASE_URL:-http://localhost:3000}"
curl --fail-with-body --get "${BASE_URL}/api/node-status" \
  --data-urlencode 'scope=pods'
