# curl 调用示例

每个脚本对应一个接口功能，可直接运行。默认请求 `http://localhost:3000`，也可通过 `BASE_URL` 指定服务地址：

```bash
BASE_URL=http://127.0.0.1:3000 bash api/curl.example/01-monitor-nodes.sh
```

webhook 示例需设置 `WEBHOOK_TOKEN`，MCP 示例需设置 `MCP_TOKEN`；两者分别对应服务端配置的 Alertmanager webhook token 和 MCP caller token。MCP 示例需先初始化，再调用后续方法；每个脚本独立发送一次 JSON-RPC 请求。`curl --fail-with-body` 会在 HTTP 错误时保留并显示响应体。
