import { queryStep, rateWindow, type StepSelection } from "../chart";
import { businessLog, errorLog, withLogContext } from "../logger";
import { query, queryRange, getAlerts, type Sample } from "./http";
export type Scope = "nodes" | "pods";
export type Resource = {
  name: string;
  namespace: string;
  cpu: number | null;
  memory: number | null;
  network: number | null;
  ready: boolean | null;
  restarts24h?: number | null;
};
export type Dashboard = {
  mode: "demo" | "live";
  resources: Resource[];
  alerts: {
    name: string;
    severity: string;
    state: string;
    resource: string;
    summary: string;
  }[];
  trend: { time: number; value: number }[];
  trendStep: number;
  trendWindow: number;
  stepSelection: StepSelection;
  updatedAt: string;
};
/** 查询每个 Node 的 CPU 使用率。
 * @returns 按 instance 聚合的即时 Prometheus 样本。
 */
export const getNodeCpuUsage = () =>
  query(
    '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  );
/** 查询 Node 内存使用百分比。
 * @returns 各 Node 的内存使用率即时样本。
 */
export const getNodeMemoryUsage = () =>
  query(
    "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
  );
/** 查询每个 Node 的网络接收速率。
 * @returns 排除 lo 网卡后按 instance 汇总的字节/秒样本。
 */
export const getNodeNetworkReceive = () =>
  query(
    'sum by (instance) (rate(node_network_receive_bytes_total{device!="lo"}[5m]))',
  );
/** 查询 Node exporter 抓取目标的可用状态。
 * @returns 按 instance 聚合的 up 指标样本。
 */
export const getNodeAvailability = () => query('max by (instance) (up{job=~".*node.*"})');
/** 查询 Kubernetes Node 清单及其标签。
 * @returns kube_node_info 即时样本。
 */
export const getNodeInventory = () => query('kube_node_info');
/** 将 Node 清单与性能、可用性指标合并为完整节点列表。
 * @param resources 从 exporter 指标生成的节点性能数据。
 * @param inventory kube-state-metrics 返回的 Node 清单。
 * @param availability 按 instance 返回的抓取可用性样本。
 * @returns 按节点名称排序的合并结果；缺失指标保留为 null。
 */
export function mergeNodeInventory(resources: Resource[], inventory: Sample[], availability: Sample[]): Resource[] {
  const used = new Set<Resource>();
  const inventoryByNode = new Map(inventory.filter((sample) => sample.metric.node).map((sample) => [sample.metric.node, sample]));
  const nodes = [...inventoryByNode.values()].map((sample) => {
    const name = sample.metric.node;
    const ip = sample.metric.internal_ip;
    /** 判断 Prometheus instance 地址是否对应当前 Node。
     * @param instance exporter 的 instance 标签值，通常包含端口。
     * @returns 地址主机名与节点名或内网 IP 匹配时返回 true。
     */
    const matches = (instance: string) => {
      const host = instance.replace(/:\d+$/, "");
      return host === name || (!!ip && host === ip);
    };
    const resource = resources.find((row) => !used.has(row) && matches(row.name));
    if (resource) used.add(resource);
    const status = availability.find((item) => item.metric.instance && matches(item.metric.instance));
    const value = status?.value ? Number(status.value[1]) : NaN;
    return {
      ...(resource || { name, namespace: "", cpu: null, memory: null, network: null, ready: null }),
      ready: Number.isFinite(value) ? value === 1 : null,
    } satisfies Resource;
  });
  const unmatched = resources.filter((row) => !used.has(row)).map((row) => {
    const status = availability.find((sample) => sample.metric.instance === row.name);
    const value = status?.value ? Number(status.value[1]) : NaN;
    return { ...row, ready: Number.isFinite(value) ? value === 1 : null };
  });
  return [...nodes, ...unmatched].sort((a, b) => a.name.localeCompare(b.name));
}
/** 查询 Pod CPU 使用核数。
 * @param namespace 可选的 Kubernetes namespace 过滤条件。
 * @returns 按 namespace 和 pod 聚合的 CPU 即时样本。
 */
export const getPodCpuUsage = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"${namespaceFilter(namespace)}}[5m]))`,
  );
/** 查询 Pod 容器 Working Set 内存用量。
 * @param namespace 可选的 Kubernetes namespace 过滤条件。
 * @returns 按 namespace 和 pod 聚合的字节数即时样本。
 */
export const getPodMemoryUsage = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"${namespaceFilter(namespace)}})`,
  );
/** 查询 Pod eth0 网络接收速率。
 * @param namespace 可选的 Kubernetes namespace 过滤条件。
 * @returns 按 namespace 和 pod 聚合的字节/秒即时样本。
 */
export const getPodNetworkReceive = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (rate(container_network_receive_bytes_total{interface="eth0"${namespaceFilter(namespace)}}[5m]))`,
  );
/** 查询 Pod Ready 状态。
 * @param namespace 可选的 Kubernetes namespace 过滤条件。
 * @returns 按 namespace 和 pod 聚合的 Ready 即时样本。
 */
export const getPodAvailability = (namespace?: string) =>
  query(
    `max by (namespace, pod) (kube_pod_status_ready{condition="true"${namespaceFilter(namespace)}})`,
  );
/** 查询 Pod 最近 24 小时的容器重启总次数，并为有清单但无重启序列的 Pod 补零。
 * @param namespace 可选的 Kubernetes namespace 过滤条件。
 * @returns 按 namespace 和 pod 聚合的重启次数样本；没有 kube_pod_info 时无对应样本。
 */
export const getPodRestarts24h = (namespace?: string) => {
  const selector = `pod!=""${namespaceFilter(namespace)}`;
  return query(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${selector}}[24h])) or on (namespace, pod) (0 * count by (namespace, pod) (kube_pod_container_status_restarts_total{${selector}}))`);
};
/** 将 namespace 转换为 PromQL 标签选择器片段。
 * @param namespace 可选的 namespace 名称。
 * @returns PromQL 标签过滤片段；未传 namespace 时返回空字符串。
 */
export function namespaceFilter(namespace?: string) {
  return namespace ? `,namespace=${JSON.stringify(namespace)}` : "";
}
/** 获取 Prometheus 当前告警。
 * @returns Prometheus 告警集合。
 */
export function getResourceAlerts() {
  return getAlerts();
}
/** 查询 Node 或 Pod 的 CPU 历史趋势。
 * @param scope 资源类型，nodes 表示节点，pods 表示 Pod。
 * @param minutes 趋势时间范围，单位为分钟。
 * @param stepSelection 采样间隔选择，auto 会按范围计算间隔。
 * @returns Prometheus 区间查询响应。
 */
export function getCpuTrend(scope: Scope, minutes: number, stepSelection: StepSelection = "auto") {
  const step = queryStep(minutes, stepSelection);
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const window = `${rateWindow(step)}s`;
  const expression =
    scope === "nodes"
      ? `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[${window}])))`
      : `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[${window}]))`;
  return queryRange(
    expression,
    end - minutes * 60,
    end,
    step,
  );
}
/** 按资源名称和 namespace 合并多组性能指标。
 * @param scope 指标所属资源类型，决定使用 instance 还是 pod 标签。
 * @param metrics 按 CPU、内存、网络、Ready 顺序传入的样本组。
 * @returns 合并并排序后的资源列表，未采集的指标保持为 null。
 */
export function mergeResources(scope: Scope, metrics: Sample[][]): Resource[] {
  const rows = new Map<string, Resource>();
  const fields = ["cpu", "memory", "network", "ready"] as const;
  metrics.forEach((samples, index) =>
    samples.forEach((sample) => {
      const name =
        scope === "nodes" ? sample.metric.instance : sample.metric.pod;
      if (!name) return;
      // Node namespaces describe the exporter deployment, not node identity.
      // Only Pods are namespaced resources.
      const namespace = scope === "pods" ? sample.metric.namespace || "" : "";
      const key = JSON.stringify([namespace, name]);
      const row = rows.get(key) || {
        name,
        namespace,
        cpu: null,
        memory: null,
        network: null,
        ready: null,
      };
      const value = Number(sample.value?.[1]);
      if (sample.value && Number.isFinite(value)) {
        const field = fields[index];
        if (field === "ready") row.ready = value === 1;
        else row[field] = value;
      }
      rows.set(key, row);
    }),
  );
  return [...rows.values()].sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
}
/** 查询并组装监控首页所需的资源、告警和图表参数。
 * @param scope 页面资源类型，支持 nodes 或 pods。
 * @param minutes 监控时间范围，单位为分钟。
 * @param stepSelection CPU 趋势采样间隔选择。
 * @returns 可直接提供给监控面板的聚合数据。
 * @throws 上游 Prometheus 查询失败时记录错误并继续向调用方抛出。
 */
export function getDashboard(scope: Scope, minutes: number, stepSelection: StepSelection = "auto"): Promise<Dashboard> {
  return withLogContext({ feature: scope === "nodes" ? "Node节点资源监控" : "Pod工作负载监控", scope, minutes, stepSelection }, async () => {
    const started = performance.now();
    businessLog("dashboard.query.started");
    try {
      const dashboard = await loadDashboard(scope, minutes, stepSelection);
      businessLog("dashboard.query.completed", {
        mode: dashboard.mode, resourceCount: dashboard.resources.length,
        alertCount: dashboard.alerts.length, durationMs: Math.round(performance.now() - started),
      });
      return dashboard;
    } catch (error) {
      errorLog("dashboard.query.failed", error);
      throw error;
    }
  });
}

/** 根据 DEMO_MODE 读取示例数据或并发查询实时监控数据。
 * @param scope 页面资源类型，支持 nodes 或 pods。
 * @param minutes 监控时间范围，单位为分钟。
 * @param stepSelection CPU 趋势采样间隔选择。
 * @returns 首页聚合数据。
 */
async function loadDashboard(scope: Scope, minutes: number, stepSelection: StepSelection): Promise<Dashboard> {
  if (process.env.DEMO_MODE === "true") return demoDashboard(scope, minutes, stepSelection);
  const functions =
    scope === "nodes"
      ? [
          getNodeCpuUsage,
          getNodeMemoryUsage,
          getNodeNetworkReceive,
          getNodeAvailability,
        ]
      : [
          getPodCpuUsage,
          getPodMemoryUsage,
          getPodNetworkReceive,
          getPodAvailability,
        ];
  const [metrics, alerts, inventory, restarts] = await Promise.all([
    Promise.all(functions.map((fn) => fn())),
    getResourceAlerts(),
    scope === "nodes" ? getNodeInventory() : Promise.resolve(null),
    scope === "pods" ? getPodRestarts24h() : Promise.resolve(null),
  ]);
  let resources = scope === "nodes"
    ? mergeNodeInventory(mergeResources(scope, [...metrics.slice(0, 3).map((m) => m.result), []]), inventory?.result || [], metrics[3].result)
    : mergeResources(scope, metrics.map((m) => m.result));
  if (scope === "pods") {
    const restartCounts = new Map<string, number | null>((restarts?.result || []).map((sample) => [
      JSON.stringify([sample.metric.namespace || "", sample.metric.pod || ""]),
      sample.value && Number.isFinite(Number(sample.value[1])) ? Math.round(Number(sample.value[1])) : null,
    ] as const));
    resources = resources.map((resource) => ({
      ...resource,
      restarts24h: restartCounts.get(JSON.stringify([resource.namespace, resource.name])) ?? null,
    }));
  }
  return {
    mode: "live",
    resources,
    alerts: alerts.alerts
      .filter((a) =>
        scope === "pods"
          ? !!a.labels.pod
          : !!a.labels.instance && !a.labels.pod,
      )
      .map((a) => ({
        name: a.labels.alertname || "Alert",
        severity: a.labels.severity || "info",
        state: a.state,
        resource: a.labels.pod || a.labels.instance || "",
        summary: a.annotations.summary || a.annotations.description || "",
      })),
    trendStep: queryStep(minutes, stepSelection),
    trendWindow: rateWindow(queryStep(minutes, stepSelection)),
    stepSelection,
    trend: [],
    updatedAt: new Date().toISOString(),
  };
}
/** 生成用于演示模式的 Node 或 Pod 样例面板数据。
 * @param scope 要生成的资源类型。
 * @param minutes 图表时间范围，单位为分钟。
 * @param stepSelection 采样间隔选择。
 * @returns 标记为 demo 模式的静态示例数据。
 */
function demoDashboard(scope: Scope, minutes: number, stepSelection: StepSelection): Dashboard {
  const resources: Resource[] = Array.from(
    { length: scope === "nodes" ? 6 : 14 },
    (_, i) => ({
      name:
        scope === "nodes"
          ? `k8s-${i < 3 ? "master" : "worker"}-${String((i % 3) + 1).padStart(2, "0")}`
          : `${["api-gateway", "order-service", "payment-service", "redis", "prometheus", "web-frontend", "coredns"][i % 7]}-${["7d8f9b", "6c4a2e"][i % 2]}-${i + 1}`,
      namespace:
        scope === "nodes"
          ? ""
          : [
              "production",
              "production",
              "production",
              "data",
              "monitoring",
              "production",
              "kube-system",
            ][i % 7],
      cpu:
        scope === "nodes"
          ? [32.4, 24.8, 41.2, 76.8, 38.6, 19.5][i]
          : 0.03 + (i % 5) * 0.18,
      memory:
        scope === "nodes"
          ? [48.2, 36.5, 62.1, 84.3, 51.7, 29.4][i]
          : (128 + i * 41) * 1024 * 1024,
      network: 1024 * (120 + i * 47),
      ready: i !== 3,
      ...(scope === "pods" ? { restarts24h: [0, 2, 0, 5, 1, 0, 3][i % 7] } : {}),
    }),
  );
  return {
    mode: "demo",
    resources,
    alerts: [
      {
        name: scope === "nodes" ? "NodeMemoryHigh" : "PodNotReady",
        severity: "warning",
        state: "firing",
        resource: resources[3].name,
        summary:
          scope === "nodes"
            ? "节点内存使用率超过 80%，请关注资源压力。"
            : "Pod 未处于 Ready 状态，请检查容器事件。",
      },
    ],
    trendStep: queryStep(minutes, stepSelection),
    trendWindow: rateWindow(queryStep(minutes, stepSelection)),
    stepSelection,
    trend: [],
    updatedAt: new Date().toISOString(),
  };
}
