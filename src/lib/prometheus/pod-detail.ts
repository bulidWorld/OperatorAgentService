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
/** 为指定 namespace 和 Pod 构造详情页使用的 PromQL 表达式。
 * @param namespace Kubernetes namespace 名称。
 * @param pod Pod 名称。
 * @param windowSeconds rate 函数计算窗口，单位为秒，默认 300 秒。
 * @returns Pod 各项性能指标的 PromQL 表达式映射。
 */
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
  restartEvents: PodRestartEvent[];
  restartWindowStart: number;
  restartWindowEnd: number;
  restartWarning: boolean;
  updatedAt: string;
};
export type PodRestartEvent = { time: number; container: string };

/** 从最后终止时间指标的历史采样中提取过去 24 小时的容器重启事件。
 * @param samples Pod 容器最后终止时间的 Prometheus range 样本。
 * @param start 查询窗口起点，Unix 秒。
 * @param end 查询窗口终点，Unix 秒。
 * @returns 按时间升序、按容器和时间去重后的重启事件。
 */
function extractRestartEvents(samples: Sample[], start: number, end: number): PodRestartEvent[] {
  const events = new Map<string, PodRestartEvent>();
  for (const sample of samples) {
    for (const [, rawTimestamp] of sample.values || []) {
      const time = Math.round(Number(rawTimestamp));
      if (!Number.isFinite(time) || time < start || time > end) continue;
      const container = sample.metric.container || "未知容器";
      events.set(`${container}:${time}`, { time, container });
    }
  }
  return [...events.values()].sort((left, right) => left.time - right.time);
}
/** 查询单个 Pod 在选定分组时间范围内的性能指标。
 * @param namespace Kubernetes namespace 名称。
 * @param pod Pod 名称。
 * @param minutes 全局时间范围，单位为分钟，默认 60。
 * @param stepSelection 全局采样间隔选择，默认自动计算。
 * @param selections 各指标分组的时间范围、间隔或自定义起止时间。
 * @returns Pod 指标、分组范围、更新时间和失败指标列表。
 * @throws Pod 名称或时间范围无效，或全部指标查询失败时抛出错误。
 */
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
      const restartWindowEnd = Math.floor(Date.now() / 30) * 30;
      const restartWindowStart = restartWindowEnd - 24 * 60 * 60;
      const restartQuery = `kube_pod_container_status_last_terminated_timestamp{namespace=${JSON.stringify(namespace)},pod=${JSON.stringify(pod)}}`;
      const [results, restartSamples] = await Promise.all([
        Promise.allSettled(
          keys.map((key) => {
            const range = groups[metricGroups[key]];
            return queryRange(
              podDetailQueries(namespace, pod, range.windowSeconds)[key],
              range.start,
              range.end,
              range.stepSeconds,
            );
          }),
        ),
        queryRange(restartQuery, restartWindowStart, restartWindowEnd, 30)
          .then((result) => result.result)
          .catch(() => null),
      ]);
      const metrics = {} as PodDetail["metrics"];
      const warnings: PodMetric[] = [];
      results.forEach((result, index) => {
        const key = keys[index];
        metrics[key] = result.status === "fulfilled" ? result.value.result : [];
        if (result.status === "rejected") warnings.push(key);
      });
      if (warnings.length === keys.length)
        throw new Error("Pod 性能指标查询失败，请检查 Prometheus 连接。");
      return {
        groups, metrics, warnings,
        restartEvents: restartSamples ? extractRestartEvents(restartSamples, restartWindowStart, restartWindowEnd) : [],
        restartWindowStart, restartWindowEnd, restartWarning: restartSamples === null,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}
