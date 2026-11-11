# KubeScope

Next.js App Router + React + TypeScript 实现的 Kubernetes Prometheus 监控台，包含 **Node 监控**、**Pod 监控**两个菜单。支持 CPU、内存、网络接收速率、Ready 状态、Pod CPU 历史趋势、关联告警、名称搜索、Pod 命名空间筛选、时间范围选择和 30 秒自动刷新。界面适配桌面及手机。

## 启动

```bash
npm ci
cp .env.example .env.local
# 设置 PROMETHEUS_URL 和 DB_HOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD
# 首次启动前按下文“PostgreSQL 数据库”执行表结构同步
npm run dev
```

访问 http://localhost:3000 。若在集群外开发，可先 `kubectl -n monitoring port-forward svc/prometheus 9090:9090`，再配置 `PROMETHEUS_URL=http://127.0.0.1:9090`。实际 Service 名称以集群为准。

没有数据源时，可在 `.env.local` 显式设置 `DEMO_MODE=true` 体验示例。页面会标注演示模式；真实数据源失败不会回退成演示数据。

```bash
npm test
npm run typecheck
npm run build
npm start
```

## 分层与 Agent 接入

HTTP 接口的 OpenAPI 契约见 [api/openapi.yaml](api/openapi.yaml)，请求参数、响应结构、错误码和 webhook 示例见 [api/README.md](api/README.md)，详细调用路径见 [api/调用链.md](api/调用链.md)。修改接口时先更新 YAML，运行 `npm run api:generate` 生成 TypeScript 类型，再实现路由；`npm run typecheck` 会检查生成代码是否与 YAML 同步，并检查路由响应类型。

- `src/lib/prometheus/http.ts`：原始 HTTP 适配层，一个接口对应一个函数：`query`、`queryRange`、`getAlerts`、`getRules`、`getTargets`、`getLabels`、`getLabelValues`、`getMetadata`、`getSeries`。保留 Prometheus 原始响应结构，有超时、HTTP/API 错误处理及可选 Bearer Token。
- `src/lib/prometheus/business.ts`：明确的业务 PromQL 函数，分别导出 `getNodeCpuUsage`、`getNodeMemoryUsage`、`getNodeNetworkReceive`、`getNodeAvailability`、`getPodCpuUsage`、`getPodMemoryUsage`、`getPodNetworkReceive`、`getPodAvailability`、`getCpuTrend`、`getResourceAlerts`。Pod 查询接受可选 namespace。`getDashboard` 仅负责页面聚合；`mergeResources` 按实例或 namespace/pod 合并，缺失值为 null。
- `src/app/api/monitor/route.ts`：供 Web 调用的服务端入口，校验 scope、minutes，不向浏览器暴露 Prometheus 地址、Token 或任意 PromQL 执行入口。
- `src/components/dashboard.tsx`：交互界面，不直接调用 Prometheus。

后续 Agent 的工具处理器可直接导入业务函数，例如：

```ts
import {
  getPodCpuUsage,
  getNodeMemoryUsage,
} from "./src/lib/prometheus/business";
const podCpu = await getPodCpuUsage("production");
const nodeMemory = await getNodeMemoryUsage();
```

这些函数属于服务端模块，只能从服务端 Agent 工具执行器导入，不应引入浏览器代码。目前未实现 MCP 协议或 Agent 工具注册。

## 指标口径

Node 列表以 kube-state-metrics 的 `kube_node_info` 为节点清单，按节点名或内网 IP 关联 node-exporter 指标；缺失的性能指标显示“—”。CPU 为 5 分钟非空闲比例，内存为 `1 - MemAvailable/MemTotal`，网络为排除 lo 后各网卡接收速率总和。状态沿用 `up{job=~".*node.*"}`，表示监控目标抓取可用性；没有对应目标时显示“未知”。

Pod 指标依赖 kubelet/cAdvisor；CPU 单位是 cores，内存为容器 Working Set 字节总和，网络取 eth0 接收速率。Pod Ready 来自 kube-state-metrics 的 `kube_pod_status_ready`。趋势是全部资源聚合；页面搜索和 namespace 筛选仅作用于列表。统计卡与告警不随列表筛选变化。当前瞬时指标不随历史时间范围变化，时间选择仅在 Pod 页面显示并控制 CPU 趋势。

Node/Pod 监控面板仍读取 Prometheus `/api/v1/alerts`，按资源标签筛选。资源告警页统一从 PostgreSQL 读取 Alertmanager firing 告警和 Kubernetes Events；收到 resolved 后移除对应 Alertmanager 告警。页面自动刷新只查询数据库，点击“同步并刷新”会先立即从集群同步 Events。未实现 Alertmanager 的静默、通知和告警历史功能。部分指标缺失时显示“—”或未知，不当作零值；上游请求失败则显示错误。

若采用 HA 副本采集，应通过 Prometheus/Thanos 查询层进行去重；多集群需增加 cluster 标签过滤，当前版本面向单一集群。生产环境请通过内网访问或在 Ingress 前配置组织认证，本项目未内置登录。

## 容器 / K8s

```bash
docker build -t your-registry/operator-agent-service:1.0.0 .
docker push your-registry/operator-agent-service:1.0.0
# 生成并保存强随机 token；将同一 token 配置给 Alertmanager
kubectl -n monitoring create secret generic operator-agent-service-alertmanager --from-literal=webhook-token='替换为随机密钥'
kubectl -n monitoring create secret generic operator-agent-service-db \
  --from-literal=host='数据库地址' --from-literal=port='5432' \
  --from-literal=name='operator_agent_service' --from-literal=user='数据库用户' \
  --from-literal=password='数据库密码'
# 修改 deploy/kubernetes.yaml 中镜像地址、namespace 和 Prometheus URL
kubectl apply -f deploy/kubernetes.yaml
# Pod 启动时会先运行 scripts/sync_schema.py；同步成功后再启动 Next.js
kubectl -n monitoring port-forward svc/operator-agent-service 3000:80
```

需要提前存在 monitoring namespace，并允许本服务访问 Prometheus。可选认证设置 `PROMETHEUS_TOKEN`，在生产中建议通过 Kubernetes Secret 的 secretKeyRef 注入。凭据仅保留在服务器端环境变量中。

## PostgreSQL 数据库

数据库连接使用 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 环境变量。数据库及用户需先创建；容器启动会先从 `db/*.xml` 同步 PostgreSQL 表结构，同步成功后才启动 Node 服务。应用数据库用户需要统一表 `resource_alert_events` 的 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 权限，并有权限创建和变更表、索引及同步审计表。表结构依照 `contexat/开发/数据库/database.xsd` 编写。Docker 镜像内包含 Python 3 和 `py3-psycopg2` 驱动，脚本优先使用 psycopg v3，未安装时自动回退 psycopg2。

手动检查或在本地执行同步时：

```bash
python3 -m pip install 'psycopg[binary]'
# 将 DB_* 变量导出到当前 shell，再同步数据库
python3 contexat/开发/数据库/sync_schema.py --dry-run
python3 contexat/开发/数据库/sync_schema.py
```

同步脚本默认读取仓库根目录 `db/`，也可以通过 `--dir` 指定目录；会记录执行历史，并用 PostgreSQL advisory lock 串行化并发实例的启动同步。重复运行不会重复创建表。数据库集成测试可在已同步的测试库中设置 `TEST_DATABASE=1` 后运行 `npm test`。原 JSON 告警文件不会自动导入 PostgreSQL；若需保留旧活动告警，请在切换前迁移数据或让 Alertmanager 重新发送 firing 告警。

统一表 `resource_alert_events` 以 `object_type`（发生对象类型，如 `Pod`、`Node`、`Deployment`）、`object_name`（对象名称）、`description`、`severity`、`occurred_at`、`alert_type`（告警类型）表示核心数据。`source` 区分 `alertmanager` 与 `kubernetes`，`(source, external_id)` 唯一：Alertmanager 使用 fingerprint，Kubernetes 使用 Event UID。Alertmanager 的 `alertname` 与 Kubernetes 的 `reason` 合并为 `alert_type`；Alertmanager 的 `startsAt` 与 Event 首次发生时间合并为 `occurred_at`；两种原始对象统一存入 `raw_payload`。`summary`、`labels`、`annotations`、`generator_url`、`ends_at`、`webhook_context` 和 `event_type`、`event_count`、`source_component`、`source_host`、`last_seen_at` 分别保留各来源独有信息。Alertmanager 对象类型和名称从标签推断；无法推断时 `object_type` 为空。Kubernetes Event 的 `object_type` 来自 `involvedObject.kind`，`object_api_version` 保留其 API 版本，适用于 Pod、Node 及其他对象。

本次为非兼容性表设计：旧的 `alertmanager_active_alerts` 和 `kubernetes_pod_events` 不会由同步脚本自动删除或迁移；切换前需使用新数据库，或自行处理旧表及数据。新建环境只生成统一表。

## Alertmanager webhook

接口为 `POST /api/webhooks/alertmanager`，只接受 Alertmanager v4 JSON、`Content-Type: application/json` 和 `Authorization: Bearer <token>`。服务端必须配置 `ALERTMANAGER_WEBHOOK_TOKEN`；未配置时返回 503，凭据错误返回 401，数据无效返回 400。成功返回 `{"received":1,"active":1}`。推送按 fingerprint 去重，resolved 状态会删除对应活动告警。请在 Alertmanager 接收器中启用 `send_resolved`：

v4 webhook 顶层通常包含 `version`、`receiver`、`status`、`groupKey`、`groupLabels`、`commonLabels`、`commonAnnotations`、`externalURL`、`alerts`，可能还有 `truncatedAlerts`。`alerts` 中每项通常包含 `status`、`labels`、`annotations`、`startsAt`、`endsAt`、`generatorURL`、`fingerprint`；其他版本或配置增加的字段也保留在原始 JSON 中。`labels` 和 `annotations` 的具体键由告警规则决定，例如 `alertname`、`severity`、`namespace`、`pod`、`instance`、`summary`、`description`。

```yaml
route:
  receiver: operator-agent-service
receivers:
  - name: operator-agent-service
    webhook_configs:
      - url: http://operator-agent-service.monitoring.svc.cluster.local/api/webhooks/alertmanager
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/operator-agent-service-alertmanager/webhook-token
```

以上是 Alertmanager 配置片段，需合并进现有配置；`credentials_file` 路径应改为 Alertmanager Pod 中实际挂载该 Secret 的路径。Prometheus Operator 的 `AlertmanagerConfig` 也可配置同等的 webhook URL、Bearer Secret 和 `sendResolved`。活动告警保存在 PostgreSQL 中，按 fingerprint 去重；数据库事务支持多副本并发写入。部署前必须创建数据库、配置 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 并同步表结构。

本地可设置 `ALERTMANAGER_WEBHOOK_TOKEN` 和数据库环境变量，再用以下请求验证：

```bash
curl -i http://localhost:3000/api/webhooks/alertmanager \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 替换为随机密钥' \
  --data '{"version":"4","alerts":[{"status":"firing","fingerprint":"demo-1","labels":{"alertname":"DemoAlert","severity":"warning"},"annotations":{"summary":"测试告警"},"startsAt":"2026-11-11T00:00:00Z"}]}'
```

## 日志

默认服务名 `operator-agent-service`，日志写入 `/var/service/operator-agent-service/log`（按要求使用 `serivce` 拼写）。可通过 `SERVICE_NAME` 设置服务名，`LOG_DIR` 覆盖完整目录用于本地开发；运行用户必须有目录写权限。

- `business-YYYY-MM-DD.log`：监控查询开始、完成、模式和资源/告警数量。
- `http-YYYY-MM-DD.log`：监控 API 入站请求及所有 Prometheus 出站请求。记录请求 ID、调用时间 `calledAt`、返回时间 `returnedAt`、耗时、HTTP 状态和成功/失败结果；出站结果覆盖响应体解析和 Prometheus API 业务错误。开始与完成记录通过请求 ID 关联，业务及出站调用通过 traceId 关联。记录显式查询参数（如 PromQL）及返回条数摘要，不记录认证头、URL 凭据和完整响应数据。HTTP 日志单独写入同目录下的 `http-YYYY-MM-DD.log`；首页服务端加载与 API 刷新均记录业务及出站 HTTP 日志。
- `error-YYYY-MM-DD.log`：异常信息及完整堆栈，同时输出到标准错误控制台。

控制台日志为 JSON，每条包含 `timestamp`、`level`、`log_type` 和 `message`，供 Kubernetes 收集；日志文件按业务、HTTP、异常分类并每日轮转，首次写入及每小时清理最后修改时间超过 14 天的文件。写入失败会输出控制台，避免中断业务。容器已创建默认目录并赋予 node 用户权限。K8s 示例使用 `emptyDir`，Pod 删除后日志会丢失；需要跨 Pod 保存时，将日志卷替换为 PVC 并确保运行用户可写。本地示例：`LOG_DIR=/tmp/operator-agent-service/log npm run dev`。

## 页面导航与本地预览

Node 与 Pod 菜单分别使用 `/?scope=nodes`、`/?scope=pods`，服务端按地址加载对应数据，刷新后保留当前页面。当前本地预览代理不转发开发 HMR WebSocket，因此在 `next.config.ts` 关闭 `experimental.reactDebugChannel`，避免调试数据流阻塞 React 交互初始化；此配置不影响业务 HTTP 请求。

## Node 性能详情

Node 概览将节点总数、活跃告警、健康状态并排展示，并保留节点列表，列表“操作 → 查看详情”进入 `/nodes/{instance}`。详情严格按节点 instance 筛选，展示 CPU 使用率与核数、内存使用率/总量/可用量、1 分钟负载、运行时间、网络收发速率、按设备的磁盘读写吞吐/IOPS/I/O 忙碌率，以及文件系统空间使用率。所有指标以时间序列图表展示；磁盘按设备、文件系统按挂载点区分曲线，避免父磁盘与分区累加。

详情可选择最近15分钟、1小时、6小时、24小时，手动刷新并返回列表。指标缺失显示“—”，部分查询失败显示提示并保留成功指标；所有查询失败显示错误及重试入口。新增详情查询也记录中文业务日志、出站 HTTP 日志和异常堆栈。

### 图表交互与计算粒度

详情指标使用 Prometheus `query_range`，`step = max(30, ceil(范围秒数 / 120))`。图表左上角的 step 下拉框可选择自动或 Prometheus 支持的 `5s`、`15s`、`30s`、`1min`、`5min` 间隔；手动选择会直接用于 `query_range`。这是时间序列计算间隔，不是 exporter 抓取间隔。使用 `rate()` 的 PromQL 窗口为 `max(300, 4 × step)` 秒，图表同时标明实际窗口。Pod CPU 趋势使用相同规则。

鼠标悬停或触摸图表可查看上海时区的具体时间、曲线名称和数值（含单位），也可以聚焦图表后用左右方向键选择采样点。缺失采样不补零，较长数据空隙不会连接成虚构曲线。

## Pod 性能详情

Pod 列表显示最近 24 小时重启次数，“查看详情”进入 `/pods/{namespace}/{pod}`，按 namespace 和 Pod 名称精确查询。详情页新增重启记录时间轴和容器/时间表；时间点来自 `kube_pod_container_status_restarts_total` 计数器首次观测到增长的 Prometheus 采样时间，因此是近似时间。重启记录仅依赖该重启计数指标。详情其余部分沿用 Node 页的双列图表、全局与面板独立时间范围、step 和自定义区间。CPU 使用率以单核为 100%；CPU Limit 和内存 Limit 比例依赖 kube-state-metrics 的 `kube_pod_container_resource_limits`。CPU 限流、内存、磁盘和网络指标依赖 kubelet/cAdvisor。磁盘延迟、等待时间和利用率还依赖 `container_fs_io_time_seconds_total` 与 `container_fs_io_time_weighted_seconds_total`；采集端缺少对应序列时图表显示空数据。网络丢包与错误数显示每秒速率。

## Kubernetes Events 同步

部署清单已加入 `operator-agent-service` ServiceAccount 和仅允许对 core/v1 Events 执行 `list` 的 ClusterRole/ClusterRoleBinding，供服务每 5 分钟分页采集集群内所有对象类型的 Events，包括 Pod、Node、Deployment 及集群级对象。多副本时由 PostgreSQL advisory lock 保证一个实例执行同步；页面“同步并刷新”会立即同步一次，再从数据库读取。统一表写入时 `source=kubernetes`，按 Event UID 去重。`GET /api/events` 可按命名空间、对象类型/名称/UID、Event 类型筛选并分页，接口细节见 [api/README.md](api/README.md)。
