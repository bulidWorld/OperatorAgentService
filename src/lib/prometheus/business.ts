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
// Explicit PromQL business functions are independently callable by future Agent tools.
export const getNodeCpuUsage = () =>
  query(
    '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  );
export const getNodeMemoryUsage = () =>
  query(
    "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
  );
export const getNodeNetworkReceive = () =>
  query(
    'sum by (instance) (rate(node_network_receive_bytes_total{device!="lo"}[5m]))',
  );
export const getNodeAvailability = () => query('max by (instance) (up{job=~".*node.*"})');
export const getNodeInventory = () => query('kube_node_info');
export function mergeNodeInventory(resources: Resource[], inventory: Sample[], availability: Sample[]): Resource[] {
  const used = new Set<Resource>();
  const inventoryByNode = new Map(inventory.filter((sample) => sample.metric.node).map((sample) => [sample.metric.node, sample]));
  const nodes = [...inventoryByNode.values()].map((sample) => {
    const name = sample.metric.node;
    const ip = sample.metric.internal_ip;
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
export const getPodCpuUsage = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"${namespaceFilter(namespace)}}[5m]))`,
  );
export const getPodMemoryUsage = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"${namespaceFilter(namespace)}})`,
  );
export const getPodNetworkReceive = (namespace?: string) =>
  query(
    `sum by (namespace, pod) (rate(container_network_receive_bytes_total{interface="eth0"${namespaceFilter(namespace)}}[5m]))`,
  );
export const getPodAvailability = (namespace?: string) =>
  query(
    `max by (namespace, pod) (kube_pod_status_ready{condition="true"${namespaceFilter(namespace)}})`,
  );
export function namespaceFilter(namespace?: string) {
  return namespace ? `,namespace=${JSON.stringify(namespace)}` : "";
}
export function getResourceAlerts() {
  return getAlerts();
}
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
  const [metrics, alerts, inventory] = await Promise.all([
    Promise.all(functions.map((fn) => fn())),
    getResourceAlerts(),
    scope === "nodes" ? getNodeInventory() : Promise.resolve(null),
  ]);
  const resources = scope === "nodes"
    ? mergeNodeInventory(mergeResources(scope, [...metrics.slice(0, 3).map((m) => m.result), []]), inventory?.result || [], metrics[3].result)
    : mergeResources(scope, metrics.map((m) => m.result));
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
