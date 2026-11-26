是的，你当前的 Kubernetes 运维 Agent 还缺少一些关键工具。但我不建议直接照搬 Pi Coding Agent 的 `read`、`edit`、`bash` 工具集。

你的 Agent 已经具备了初步的故障发现、指标查询、日志分析和人工审批重启能力。

下一步应该把它升级成一个完整的 Kubernetes AIOps Agent（智能运维智能体），实现：

发现问题 → 收集证据 → 定位根因 → 制定修复方案 → 人工审批 → 执行修复 → 验证结果。

其中，Pi 的工具设计值得借鉴，尤其是它的通用搜索和文件编辑能力，但 Kubernetes 运维比 Coding Agent 更需要结构化操作、安全权限控制和状态验证。

## 一、先看你当前工具集的能力

你已经实现了 7 个工具：

| 现有工具                                           | 功能               | 评价       |
| ---------------------------------------------- | ---------------- | -------- |
| `query_alerts`                                 | 查询告警历史           | 已具备      |
| `query_alert_details`                          | 查询单条告警详情         | 已具备      |
| `query_promql`                                 | 查询 Prometheus 指标 | 已具备      |
| `query_pod_logs`                               | 查看 Pod 日志        | 已具备      |
| `query_k8s_network`                            | 查询网络资源           | 已具备      |
| `check_network_connectivity`                   | 网络连通性测试          | 已具备      |
| `request_pod_restart_approval` + `restart_pod` | 审批后重启 Pod        | 安全机制需要加强 |

目前最大的缺陷是：Agent 能够知道哪里出了问题，但缺少足够的工具判断为什么出问题，以及应该如何修复。

例如，一个 Pod 出现 `CrashLoopBackOff`：

- 你可以查看告警。
- 你可以查看日志。
- 你可以查询 CPU、内存指标。
- 但无法直接读取 Pod 的 `status`、`lastState`、`exitCode`、`reason`、`restartCount` 等完整状态。
- 无法读取关联 Deployment、ConfigMap、Secret 的配置。
- 无法查询 Deployment 的变更历史。
- 无法直接判断是否存在探针配置问题、资源配置问题或调度问题。

所以我认为，优先补充的不是 `edit`，而是 Kubernetes 资源查询、关联分析和历史状态查询工具。

## 二、推荐的完整工具集

我建议按六类组织工具，而不是全部平铺。

| 分类        | 建议工具                                   | 优先级 |
| --------- | -------------------------------------- | --- |
| 资源发现      | `list_k8s_resources`                   | P0  |
| 资源详情      | `get_k8s_resource`                     | P0  |
| 事件查询      | `query_k8s_events`                     | P0  |
| 资源关联      | `get_resource_relations`               | P0  |
| 日志检索      | `search_pod_logs`                      | P0  |
| 资源变更历史    | `get_rollout_history`                  | P1  |
| 配置差异      | `diff_k8s_resource`                    | P1  |
| 集群搜索      | `search_k8s_resources`                 | P1  |
| 修复方案      | `propose_k8s_patch`                    | P1  |
| 修复审批执行    | `apply_approved_patch`                 | P1  |
| 修复验证      | `verify_remediation`                   | P1  |
| 诊断命令      | `run_diagnostic_command`               | P2  |
| GitOps 集成 | `read_repo_file` / `propose_repo_edit` | P2  |
| 复杂诊断      | `start_diagnostic_job`                 | P2  |

其中 P0 是我认为现在最应该实现的。

## 三、Pi Coding Agent 的工具哪些值得借鉴？

Pi 的核心工具主要是 `read`、`bash`、`edit`、`write`，还提供可选的 `grep`、`find`、`ls`。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



把这些能力映射到 Kubernetes 运维场景，我建议这样设计：

| Pi 工具   | 运维 Agent 对应工具                              | 是否推荐     |
| ------- | ------------------------------------------ | -------- |
| `read`  | `get_k8s_resource` / `read_repo_file`      | 强烈推荐     |
| `grep`  | `search_pod_logs` / `search_k8s_resources` | 强烈推荐     |
| `find`  | `list_k8s_resources`                       | 强烈推荐     |
| `ls`    | `list_namespaces` / `list_resources`       | 推荐       |
| `edit`  | `propose_k8s_patch`                        | 推荐，审批后执行 |
| `write` | `generate_k8s_manifest`                    | 推荐，先生成草案 |
| `bash`  | `run_diagnostic_command`                   | 有条件推荐    |

一个重要区别是：

- Coding Agent 的 `read` 主要读取文件系统。
- 运维 Agent 的 `read` 应该优先读取 Kubernetes API 对象。
- Coding Agent 的 `edit` 修改文件。
- 运维 Agent 的 `edit` 应该生成 Kubernetes Patch，或者修改 GitOps 仓库中的 YAML。
- Coding Agent 的 `bash` 能执行各种系统命令。
- 运维 Agent 不应该默认拥有任意 Shell 执行能力。

尤其是你的 Agent 运行在 K8s 集群内部，直接提供不受限制的 `bash` 或 `kubectl exec`，风险远高于普通编程环境。

## 四、最值得补充的 5 个工具及代码示例

### 1. `get_k8s_resource`：通用资源读取工具

这是我认为最重要的工具。

你目前只能查询几种特定的数据。如果遇到 PVC Pending、Deployment 不可用、Node NotReady，Agent 没有统一读取资源详情的能力。

建议设计：

```
defineTool({
  name: "get_k8s_resource",
  description:
    "读取 Kubernetes 资源的配置和当前状态，支持 Pod、Deployment、Node、PVC 等资源。",
  parameters: z.object({
    kind: z.enum([
      "Pod",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "Node",
      "PersistentVolumeClaim",
      "PersistentVolume",
      "Service",
      "ReplicaSet",
      "ConfigMap",
    ]),
    namespace: z.string().optional(),
    name: z.string().min(1),
  }),
  execute: async (args) => {
    return getKubernetesResource(args);
  },
});
```

这里的 `getKubernetesResource()` 是你需要实现的服务端方法，不是现成的 CopilotKit API。

通过 Kubernetes API，你能获取：

```
kind: Pod
metadata:
  name: nginx-xxx
  namespace: default
status:
  phase: Running
  containerStatuses:
    - name: nginx
      ready: false
      restartCount: 5
      lastState:
        terminated:
          reason: OOMKilled
          exitCode: 137
```

当 Agent 得到这个结果，就能够明确发现容器发生过 OOMKilled，然后使用 PromQL 查询内存指标，再分析内存 Limit 是否合理。

实现时需要注意：ConfigMap 可能包含敏感数据，即使它不是 Secret，也应该对返回内容做脱敏和大小限制。不要把 `get_k8s_resource` 扩展为任意读取 Secret 明文的接口。

### 2. `query_k8s_events`：Kubernetes 原生事件查询

你现有的 `query_alerts` 可能包含已持久化的 Kubernetes Event，但它不一定覆盖全部原始事件，也不一定支持实时事件查询。

建议单独提供：

```
defineTool({
  name: "query_k8s_events",
  description: "查询指定 Kubernetes 资源相关的原始事件。",
  parameters: z.object({
    namespace: z.string().optional(),
    kind: z.string().optional(),
    name: z.string().optional(),
    reason: z.string().optional(),
    sinceMinutes: z.number().int().min(1).max(1440).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (args) => {
    return queryKubernetesEvents(args);
  },
});
```

典型事件包括：

- `FailedScheduling`
- `FailedMount`
- `BackOff`
- `Unhealthy`
- `FailedCreatePodSandBox`
- `FailedPull` / `ErrImagePull`

需要注意，K8s Event 是临时诊断数据，API 查询无法保证能拿到较早的历史事件。你已有的数据库存储机制可以作为历史事件的数据源。

### 3. `search_pod_logs`：跨 Pod 日志检索

这是对 `query_pod_logs` 的重要补充。

现有工具必须知道 Pod 名称。但用户可能只会问：

> 为什么最近 30 分钟 part-service 的 HTTP 请求出现大量 500？

Agent 应该能根据 Deployment、标签或应用名称搜索多个 Pod 的日志，而不必先手动指定每个 Pod。

建议参数：

```
{
  namespace: "part-app",
  labelSelector: "app=part-service",
  pattern: "ERROR|Exception|HTTP 500",
  sinceMinutes: 30,
  maxMatches: 100
}
```

对于容器重启故障，还应该给现有 `query_pod_logs` 增加：

```
previous: z.boolean().optional(),
timestamps: z.boolean().optional()
```

`previous=true` 对应 Kubernetes API 的 previous container logs，能够读取同一个 Pod 内上一个已终止容器实例的日志（如果还保留着）。

[image](https://www.google.com/s2/favicons?domain=https://kubernetes.io\&sz=32)

Kubernetes+1



如果未来需要搜索数天前的日志，建议接入 Loki，而不是不断扩展直接读取 Pod 日志的接口。

### 4. `get_resource_relations`：查询资源依赖关系

这个工具很适合 Kubernetes Agent，因为集群故障往往涉及多种资源的关联。

例如：

示意：从 Deployment 追踪到 ReplicaSet、Pod、PVC、Node 等相关资源。实际依赖关系需由 ownerReferences、标签、引用字段及调度信息推导。

如果某个 Pod 无法启动，Agent 能一次性拿到：

```
{
  "resource": "Pod/part-service-abc",
  "owner": "ReplicaSet/part-service-123",
  "deployment": "part-service",
  "node": "worker-01",
  "configMaps": ["part-service-config"],
  "pvcs": ["part-service-data"],
  "services": ["part-service"]
}
```

这样 Agent 不需要反复猜测下一步应该查询哪个对象。

### 5. `get_rollout_history`：获取变更历史

智能运维非常重要的一项能力是判断：

故障是否由最近一次发布引起？

例如：

- 10:00 Deployment 更新镜像
- 10:02 Pod 开始重启
- 10:03 Prometheus 出现告警

这种情况下，新版本部署可能就是原因。

建议查询：

```
{
  namespace: "part-app",
  kind: "Deployment",
  name: "part-service",
  includeRevisions: true
}
```

返回 Deployment 修订历史、ReplicaSet 创建时间、镜像版本、当前 rollout 状态。

Kubernetes 原生 Deployment revision 记录主要依赖保留的 ReplicaSet，不能当成无限期、完整的变更审计记录。

[image](https://www.google.com/s2/favicons?domain=https://kubernetes.io\&sz=32)

Kubernetes



如果需要精确知道是谁、在什么时间修改了哪个字段，还应该接入 Kubernetes Audit Log 或 GitOps 提交历史。

## 五、关于 `edit` 和 `bash`：我建议这样实现

这两项能力对自动修复特别重要，但应该拆成生成方案和执行方案两个阶段。

### 1. `edit`：不直接改 YAML，先生成 Patch

例如，Agent 确定一个 Deployment 的内存 Limit 太低。

建议它生成：

```
{
  "target": {
    "kind": "Deployment",
    "namespace": "part-app",
    "name": "part-service"
  },
  "patch": {
    "spec": {
      "template": {
        "spec": {
          "containers": [
            {
              "name": "part-service",
              "resources": {
                "limits": {
                  "memory": "2Gi"
                }
              }
            }
          ]
        }
      }
    }
  },
  "reason": "容器出现 OOMKilled，建议提高内存限制"
}
```

注意：以上是修复方案示意，不能直接当作通用的安全补丁。生产实现中应采用针对容器名称的 Strategic Merge Patch，或带前置条件的 JSON Patch，避免覆盖其他容器配置。

推荐执行流程：

Agent 生成修复方案

propose_k8s_patch

服务端检查差异及影响

dry-run + diff + policy check

用户审批精确变更内容

服务端执行已批准的 Patch

apply_approved_patch

验证资源状态和告警恢复

verify_remediation

如果你使用 GitOps 管理 Kubernetes YAML，那么更应该修改 Git 仓库并提交 PR，而不是直接 Patch 集群资源，以避免后续被 GitOps Controller 覆盖。

### 2. `bash`：建议分成三级执行权限

| 工具                       | 能力              | 权限   |
| ------------------------ | --------------- | ---- |
| `run_diagnostic_command` | 执行预定义的只读诊断命令    | 自动   |
| `run_debug_job`          | 在隔离 Job 中执行诊断程序 | 需授权  |
| `execute_remediation`    | 执行经过批准的修复动作     | 强制审批 |

例如，网络故障时允许执行：

```
nslookup
curl --head
traceroute
ss
```

但不能通过模型自由拼接 Shell 命令。

Kubernetes 本身支持 `exec` 进入容器，也支持临时调试容器，但这些能力应作为受控的高级诊断工具，而不是开放的通用执行入口。

[image](https://www.google.com/s2/favicons?domain=https://kubernetes.io\&sz=32)

Kubernetes+1



## 六、你当前代码还有一个比较严重的审批安全问题

你写的：

```
approved: z.literal(true)
```

以及：

```
if (approved !== true)
  throw new Error("没有有效的人工审批");
```

并不能真正保证用户批准过重启。

原因是 `approved` 参数仍然由模型生成。

即使 Prompt 要求先调用 `request_pod_restart_approval`，模型在技术上仍可能直接调用：

```
{
  "namespace": "part-app",
  "pod": "part-service-abc",
  "reason": "修复故障",
  "approved": true
}
```

服务端会认为审批已通过。

`interrupt: true` 能提供交互中断，但你还需要确认 CopilotKit 的恢复流程是否在可信服务端校验审批状态；不能只依赖 Prompt 和工具参数。

推荐改成：

```
defineTool({
  name: "restart_pod",
  description: "执行已经批准的 Pod 重启操作",
  parameters: z.object({
    operationId: z.string().uuid()
  }),
  execute: async ({ operationId }) => {
    return executeApprovedOperation(operationId);
  },
});
```

服务端 `executeApprovedOperation()` 负责：

1. 从 PostgreSQL 查询操作及审批记录。
2. 校验审批状态、审批人权限和有效期。
3. 校验 Namespace、Pod UID 和操作内容与审批时完全一致。
4. 原子地将操作标记为执行中，防止重复提交。
5. 使用独立的有限权限执行身份操作。
6. 记录审计日志及执行结果。

建议审批绑定 `operationId` 和变更内容哈希，防止审批后模型替换参数。

此外，删除 Pod 不等同于重启容器：删除受 Deployment 管理的 Pod 通常会触发新 Pod 创建；独立 Pod 不一定会被重新创建。要在审批界面明确实际动作。

## 七、推荐的最终架构

你的 Agent 现在把所有工具都放在 `BuiltInAgent` 里，这适合第一阶段。

未来工具增加到 20～30 个后，我建议做成：

CopilotKit / AG-UI

用户交互、Agent Streaming、人工审批

AIOps Orchestrator Agent

任务规划、故障诊断、工具选择、结果汇总

K8s Tools

资源、事件、关系

Observability Tools

PromQL、日志、Tracing

Diagnostic Tools

网络、诊断 Job

Remediation Tools

Patch、重启、回滚

Tool Execution Gateway

权限检查、参数校验、审批、安全审计、限流

Kubernetes API

Prometheus / Loki

GitOps / PostgreSQL

所有工具执行都应该经过 Gateway；不要仅靠 Agent Prompt 决定能执行什么。

Kubernetes RBAC 也应按最小权限原则配置，避免给 Agent 的 ServiceAccount 授予 `cluster-admin` 或通配符写权限。

[image](https://www.google.com/s2/favicons?domain=https://kubernetes.io\&sz=32)

Kubernetes



对于通用运维查询能力，你可以考虑采用 MCP 形式封装工具，之后复用到其他 Agent，而不必绑定在 CopilotKit 内部。

## 八、我建议你下一阶段优先做什么？

我会按下面的顺序开发：

实施清单

0/7

增加 get_k8s_resource，统一读取资源状态

增加 query_k8s_events，读取原始事件

增加 get_resource_relations，分析对象依赖关系

扩展 query_pod_logs，支持 previous 和时间戳

增加 get_rollout_history，关联故障与发布历史

重构审批机制，保证服务端强制授权

增加 propose_k8s_patch 和 verify_remediation

另外，你的 `query_alerts` 当前自动遍历全部分页，可能一次性返回上万条告警；`query_promql` 的采样点检查也只计算了每条时序的点数，没有限制返回的时序数量。建议统一增加结果条数、输出字节数、超时和最大时序数限制，防止工具结果挤占模型上下文。

最终建议：保留你的 CopilotKit + BuiltInAgent 架构，不必为了获得 Pi 的工具而更换 Agent 框架。

真正值得借鉴的是 Pi 的工具设计思想：少量通用工具覆盖大量任务，再按需求扩展。

但在 Kubernetes 运维场景中，我更推荐 通用只读查询 + 专项诊断工具 + 受控写操作 的组合。这样既可以让 Agent 自主排查大部分故障，又能避免开放 Shell、文件编辑和 Kubernetes 写权限带来的安全风险。