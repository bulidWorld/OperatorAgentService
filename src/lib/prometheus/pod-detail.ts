import {
  queryStep,
  rateWindow,
  TIME_RANGES,
  type StepSelection,
} from "../chart";
import { queryRange, type Sample } from "./http";
import { withLogContext } from "../logger";
import type { NodeGroupDetail, NodeGroupSelection } from "./node-detail";

export const POD_GROUPS = {
  cpu: ["cpu", "cpuLimit", "throttling"],
  memory: ["memory", "memoryLimit"],
  disk: ["diskRead", "diskWrite", "diskLatency", "diskWait", "diskUtilization"],
  network: [
    "receive",
    "transmit",
    "receiveDrops",
    "transmitDrops",
    "receiveErrors",
    "transmitErrors",
  ],
} as const;
export type PodGroup = keyof typeof POD_GROUPS;
export function podDetailQueries(
  namespace: string,
  pod: string,
  windowSeconds = 300,
) {
  const selector = `namespace=${JSON.stringify(namespace)},pod=${JSON.stringify(pod)}`;
  const container = `${selector},container!="",container!="POD"`;
  const window = `${windowSeconds}s`;
  const cpu = `sum(rate(container_cpu_usage_seconds_total{${container}}[${window}]))`;
  const cpuLimit = `sum(kube_pod_container_resource_limits{${selector},resource="cpu",unit="core"})`;
  const memory = `sum(container_memory_working_set_bytes{${container}})`;
  const memoryLimit = `sum(kube_pod_container_resource_limits{${selector},resource="memory",unit="byte"})`;
  const io = `${container},device!=""`;
  const ops = `sum(rate(container_fs_reads_total{${io}}[${window}]) + rate(container_fs_writes_total{${io}}[${window}]))`;
  const seconds = `sum(rate(container_fs_io_time_seconds_total{${io}}[${window}]))`;
  return {
    cpu: `100 * (${cpu})`,
    cpuLimit: `100 * (${cpu}) / ${cpuLimit}`,
    throttling: `100 * sum(rate(container_cpu_cfs_throttled_periods_total{${container}}[${window}])) / clamp_min(sum(rate(container_cpu_cfs_periods_total{${container}}[${window}])), 1e-9)`,
    memory,
    memoryLimit: `100 * (${memory}) / ${memoryLimit}`,
    diskRead: `sum(rate(container_fs_reads_bytes_total{${io}}[${window}]))`,
    diskWrite: `sum(rate(container_fs_writes_bytes_total{${io}}[${window}]))`,
    diskLatency: `(${seconds}) / clamp_min(${ops}, 1e-9)`,
    diskWait: `sum(rate(container_fs_io_time_weighted_seconds_total{${io}}[${window}]))`,
    diskUtilization: `100 * (${seconds})`,
    receive: `sum(rate(container_network_receive_bytes_total{${selector},interface!="lo"}[${window}]))`,
    transmit: `sum(rate(container_network_transmit_bytes_total{${selector},interface!="lo"}[${window}]))`,
    receiveDrops: `sum(rate(container_network_receive_packets_dropped_total{${selector},interface!="lo"}[${window}]))`,
    transmitDrops: `sum(rate(container_network_transmit_packets_dropped_total{${selector},interface!="lo"}[${window}]))`,
    receiveErrors: `sum(rate(container_network_receive_errors_total{${selector},interface!="lo"}[${window}]))`,
    transmitErrors: `sum(rate(container_network_transmit_errors_total{${selector},interface!="lo"}[${window}]))`,
  };
}
export type PodMetric = keyof ReturnType<typeof podDetailQueries>;
export type PodDetail = {
  groups: Record<PodGroup, NodeGroupDetail>;
  metrics: Record<PodMetric, Sample[]>;
  warnings: PodMetric[];
  updatedAt: string;
};
export async function getPodDetail(
  namespace: string,
  pod: string,
  minutes = 60,
  stepSelection: StepSelection = "auto",
  selections?: Partial<Record<PodGroup, NodeGroupSelection>>,
): Promise<PodDetail> {
  if (
    !namespace ||
    !pod ||
    !(TIME_RANGES as readonly number[]).includes(minutes)
  )
    throw new Error("无效的 Pod 或时间范围");
  const groups = {} as PodDetail["groups"];
  for (const group of Object.keys(POD_GROUPS) as PodGroup[]) {
    const selected = selections?.[group] ?? { minutes, step: stepSelection };
    if (!(TIME_RANGES as readonly number[]).includes(selected.minutes))
      throw new Error("无效的时间范围");
    const custom = selected.from !== undefined && selected.to !== undefined;
    if (
      custom &&
      (!Number.isSafeInteger(selected.from) ||
        !Number.isSafeInteger(selected.to) ||
        selected.from! >= selected.to! ||
        selected.to! > Math.floor(Date.now() / 1000) + 60)
    )
      throw new Error("无效的起始或结束时间");
    const stepSeconds = queryStep(
      custom ? (selected.to! - selected.from!) / 60 : selected.minutes,
      selected.step,
    );
    const end = custom
      ? selected.to!
      : Math.floor(Date.now() / 1000 / stepSeconds) * stepSeconds;
    groups[group] = {
      ...selected,
      stepSeconds,
      start: custom ? selected.from! : end - selected.minutes * 60,
      end,
      windowSeconds: rateWindow(stepSeconds),
    };
  }
  return withLogContext(
    { feature: "Pod性能详情", namespace, pod },
    async () => {
      const metricGroups = Object.fromEntries(
        Object.entries(POD_GROUPS).flatMap(([group, keys]) =>
          keys.map((key) => [key, group]),
        ),
      ) as Record<PodMetric, PodGroup>;
      const keys = Object.keys(podDetailQueries(namespace, pod)) as PodMetric[];
      const results = await Promise.allSettled(
        keys.map((key) => {
          const range = groups[metricGroups[key]];
          return queryRange(
            podDetailQueries(namespace, pod, range.windowSeconds)[key],
            range.start,
            range.end,
            range.stepSeconds,
          );
        }),
      );
      const metrics = {} as PodDetail["metrics"];
      const warnings: PodMetric[] = [];
      results.forEach((result, index) => {
        const key = keys[index];
        metrics[key] = result.status === "fulfilled" ? result.value.result : [];
        if (result.status === "rejected") warnings.push(key);
      });
      if (warnings.length === keys.length)
        throw new Error("Pod 性能指标查询失败，请检查 Prometheus 连接。");
      return { groups, metrics, warnings, updatedAt: new Date().toISOString() };
    },
  );
}
