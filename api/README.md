# HTTP 接口

[openapi.yaml](openapi.yaml) 是接口契约，可导入 Swagger UI、Redoc 或 API 客户端查看。路由由 Next.js App Router 提供。OpenAPI 只描述本服务暴露的接口，不包含服务向上游发起的请求。

| 方法 | 路径 | 用途 | 成功响应 | 错误响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/monitor` | Node/Pod 面板指标与告警 | `Dashboard` | 400 参数无效；502 数据源失败 |
| GET | `/api/node-status` | 节点可用状态映射 | `{ "statuses": { "node-1": true } }`；演示模式为 `null` | 502 查询失败 |
| GET | `/api/alerts` | 数据库告警列表；`refresh=true` 先同步 Kubernetes Events | `AlertsResponse` | 400、500、502 |
| GET | `/api/events` | 按对象筛选并分页查询 Kubernetes Events | `KubernetesEventsResponse` | 400、500 |
| POST | `/api/webhooks/alertmanager` | 接收 Alertmanager v4 告警 | `{ "received": 1, "active": 1 }` | 400、401、415、500、503 |

`GET /api/monitor` 支持 `scope=nodes|pods`（默认 `nodes`）、`minutes=15|60|360|1440`（默认 `60`）和 `step=auto|5|15|30|60|300`（默认 `auto`，数字单位为秒）。`Dashboard.resources` 的 CPU 和内存单位随 scope 变化：Node 是百分比，Pod 是 CPU 核数和内存字节；网络统一为字节/秒。Pod scope 另含 `restarts24h`，表示最近 24 小时容器重启次数；Prometheus 未提供该指标时为 `null`。`/api/alerts` 始终从 PostgreSQL 统一表读取 Alertmanager 告警和 Kubernetes Events；`refresh=true` 会先同步事件，默认只查库。告警列表支持 `limit=1..500` 和 `cursor` 分页；页面自动轮询第一页，点击“同步并刷新”后也回到第一页。

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

Alertmanager 不提供统一的告警对象字段；服务从 `labels.pod`、`labels.node`、`labels.instance` 等标签推断对象，同时保存原始标签、注释和完整 webhook 数据。`resolved` 告警保留在统一表，并标记 `resolution_status=resolved`、`resolution_source=alertmanager`；当前活动告警查询会隐藏已解决记录。

告警页面的人工清除同样保留记录，`resolution_source=manual`；Kubernetes Event 超过保留时间后自动清理会记录为 `automatic`。三种解决来源可通过 `resolution_source` 区分。

## Kubernetes Events

服务启动后立即通过 ServiceAccount 的 token 和 CA 访问 Kubernetes API Server，再每 5 分钟对 core/v1 Events 执行一次全命名空间分页 LIST。不按 `involvedObject.kind` 限制，因此 Pod、Node、Deployment、ReplicaSet、Job、PVC 等对象的事件，以及集群级对象事件，都进入统一表 `resource_alert_events`。同一时刻用 PostgreSQL advisory lock 选出一个实例执行同步；其余实例跳过该周期。手动刷新会等待锁并立即同步。Event 按 `(source, external_id)=(kubernetes, metadata.uid)` 去重。`object_type`、`object_name`、`object_uid`、`object_api_version` 来自 `involvedObject`；`namespace` 取 `involvedObject.namespace`，没有命名空间时为 `null`。Event 无关联对象时对象字段可以为 `null`，原始对象仍保存在 `raw_payload`。

`GET /api/events?hours=24&limit=100` 从数据库读取已采集事件。`hours` 为 1～720，`limit` 为 1～500；可按 `namespace`、`objectType`、`objectName`、`objectUid`、`eventType` 筛选。不传 `namespace` 会包含所有命名空间和集群级事件。`cursor` 使用上一页的 `nextCursor`，翻页时筛选条件须保持一致。结果按 `lastSeenAt DESC, id DESC` 排序；时间窗口按 `lastSeenAt` 过滤。该接口不在每次请求时调用 API Server；数据库查询失败返回 500，参数无效返回 400。

`occurred_at` 取 Event 首次发生时间，缺失时回退到 `metadata.creationTimestamp`。`last_seen_at` 依次取 `series.lastObservedTime`、`lastTimestamp`、`eventTime`、`firstTimestamp`、`metadata.creationTimestamp`。`alert_type` 存 Event reason；`severity` 将 Warning 映射为 warning、Normal 映射为 info，`event_type` 保留上游原值；`event_count` 缺失时为 1。响应示例：

```json
{
  "queriedAt": "2026-11-11T08:00:00Z",
  "events": [
    {
      "eventUid": "c2d734d4-0a38-4b62-b440-42b8db4b583a",
      "source": "kubernetes",
      "objectType": "Pod",
      "objectName": "api-1",
      "namespace": "production",
      "objectUid": "f132fdb4-17f4-47a0-a3d6-f7fb53983278",
      "objectApiVersion": "v1",
      "description": "Back-off restarting failed container",
      "severity": "warning",
      "occurredAt": "2026-11-11T07:50:00Z",
      "alertType": "BackOff",
      "eventType": "Warning",
      "count": 3,
      "sourceComponent": "kubelet",
      "sourceHost": "worker-1",
      "lastSeenAt": "2026-11-11T07:59:00Z"
    }
  ],
  "nextCursor": null
}
```

`raw_payload` 保存完整 core/v1 Event，`updated_at` 是最近同步时间。每次同步会删除最近一次发生时间超过 30 天的 Kubernetes 记录。API Server 的 Event TTL 已清除的历史事件无法补采。

## 从契约生成代码

```bash
npm run api:generate  # 从 api/openapi.yaml 生成 src/generated/api.types.ts
npm run typecheck     # 检查生成结果是否最新，并检查路由响应类型
```

Node 生态有 OpenAPI Generator 等工具，可以生成 Express 服务端骨架和多种客户端。当前项目使用 Next.js App Router，因此采用 `openapi-typescript` 生成接口类型，并在路由响应中引用这些类型；[src/generated/api.ts](../src/generated/api.ts) 是手写的浏览器请求层，负责实际发起三个 GET 请求。路由方法仍由 Next.js 文件系统路由实现，请求运行时校验仍由现有处理器执行。逐步调用路径见 [调用链.md](调用链.md)。
