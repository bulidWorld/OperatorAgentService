# HTTP 接口

[openapi.yaml](openapi.yaml) 是接口契约，可导入 Swagger UI、Redoc 或 API 客户端查看。所有路由由 Next.js App Router 实现；OpenAPI 只描述本服务暴露的接口，不包含服务向 Prometheus 发起的请求。

| 方法 | 路径 | 用途 | 成功响应 | 错误响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/monitor` | Node/Pod 面板指标与告警 | `Dashboard` | 400 参数无效；502 数据源失败 |
| GET | `/api/node-status` | 节点可用状态映射 | `{ "statuses": { "node-1": true } }`；演示模式为 `null` | 502 查询失败 |
| GET | `/api/alerts` | 资源告警列表 | `{ "source": "alertmanager", "alerts": [...] }` | 502 查询失败 |
| POST | `/api/webhooks/alertmanager` | 接收 Alertmanager v4 告警 | `{ "received": 1, "active": 1 }` | 400、401、415、500、503 |

`GET /api/monitor` 支持 `scope=nodes|pods`（默认 `nodes`）、`minutes=15|60|360|1440`（默认 `60`）和 `step=auto|5|15|30|60|300`（默认 `auto`，数字单位为秒）。`Dashboard.resources` 的 CPU 和内存单位随 scope 变化：Node 是百分比，Pod 是 CPU 核数和内存字节；网络统一为字节/秒。`/api/alerts` 配置 webhook token 时读取 PostgreSQL，未配置时读取 Prometheus；演示模式返回 `{ "alerts": [] }`，没有 `source` 字段。

Webhook 使用 `Authorization: Bearer <ALERTMANAGER_WEBHOOK_TOKEN>` 和 `Content-Type: application/json`，请求体最多 1 MiB，每批最多 1000 条。示例：

```json
{
  "version": "4",
  "receiver": "operator-agent-service",
  "status": "firing",
  "groupKey": "{}:{namespace=\"production\"}",
  "groupLabels": { "namespace": "production" },
  "commonLabels": { "severity": "critical" },
  "commonAnnotations": {},
  "externalURL": "https://alertmanager.example.com",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "PodDown", "severity": "critical", "namespace": "production", "pod": "api-1" },
      "annotations": { "summary": "Pod 不可用" },
      "startsAt": "2026-11-11T00:00:00Z",
      "generatorURL": "https://prometheus.example.com/graph",
      "fingerprint": "example-fingerprint"
    }
  ]
}
```

Alertmanager 不提供统一的告警对象字段；服务从 `labels.pod`、`labels.node`、`labels.instance` 等标签推断对象，同时保存原始标签、注释和完整 webhook 数据。`resolved` 告警会从活动告警表删除；该接口不提供历史告警查询。

## 从契约生成代码

```bash
npm run api:generate  # 从 api/openapi.yaml 生成 src/generated/api.types.ts
npm run typecheck     # 检查生成结果是否最新，并检查路由响应类型
```

Node 生态有 OpenAPI Generator 等工具，可以生成 Express 服务端骨架和多种客户端。当前项目使用 Next.js App Router，因此采用 `openapi-typescript` 生成接口类型，并在路由响应中引用这些类型；[src/generated/api.ts](../src/generated/api.ts) 是手写的浏览器请求层，负责实际发起三个 GET 请求。路由方法仍由 Next.js 文件系统路由实现，请求运行时校验仍由现有处理器执行。逐步调用路径见 [调用链.md](调用链.md)。
