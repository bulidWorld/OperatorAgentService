import { queryStep, rateWindow, TIME_RANGES, type StepSelection } from "../chart";
import { queryRange, type Sample } from "./http";
import { businessLog, errorLog, withLogContext } from "../logger";

export function nodeSelector(instance: string) {
  return `instance=${JSON.stringify(instance)}`;
}
export function nodeDetailQueries(instance: string, windowSeconds = 300) {
  const selector = nodeSelector(instance);
  const window = `${windowSeconds}s`;
  const disk = `${selector},device!~"loop.*|ram.*|fd.*|sr.*"`;
  return {
    cpu: `100 * (1 - avg(rate(node_cpu_seconds_total{${selector},mode="idle"}[${window}])))`,
    cores: `count(node_cpu_seconds_total{${selector},mode="idle"})`,
    memory: `100 * (1 - avg(node_memory_MemAvailable_bytes{${selector}} / node_memory_MemTotal_bytes{${selector}}))`,
    memoryTotal: `max(node_memory_MemTotal_bytes{${selector}})`,
    memoryAvailable: `max(node_memory_MemAvailable_bytes{${selector}})`,
    load: `max(node_load1{${selector}})`,
    receive: `sum(rate(node_network_receive_bytes_total{${selector},device!="lo"}[${window}]))`,
    transmit: `sum(rate(node_network_transmit_bytes_total{${selector},device!="lo"}[${window}]))`,
    diskRead: `max by (device) (rate(node_disk_read_bytes_total{${disk}}[${window}]))`,
    diskWrite: `max by (device) (rate(node_disk_written_bytes_total{${disk}}[${window}]))`,
    diskReadIops: `max by (device) (rate(node_disk_reads_completed_total{${disk}}[${window}]))`,
    diskWriteIops: `max by (device) (rate(node_disk_writes_completed_total{${disk}}[${window}]))`,
    diskBusy: `100 * max by (device) (rate(node_disk_io_time_seconds_total{${disk}}[${window}]))`,
    filesystem: `100 * (1 - node_filesystem_avail_bytes{${selector},fstype!~"tmpfs|devtmpfs|overlay|squashfs"} / node_filesystem_size_bytes{${selector},fstype!~"tmpfs|devtmpfs|overlay|squashfs"})`,
  };
}
export const NODE_GROUPS = {
  cpu: ["cpu", "cores", "load"],
  memory: ["memory", "memoryTotal", "memoryAvailable"],
  network: ["receive", "transmit"],
  disk: ["diskRead", "diskWrite", "diskReadIops", "diskWriteIops", "diskBusy"],
  filesystem: ["filesystem"],
} as const;
export type NodeGroup = keyof typeof NODE_GROUPS;
export type NodeGroupSelection = { minutes: number; step: StepSelection; from?: number; to?: number };
export type NodeGroupDetail = NodeGroupSelection & { start: number; end: number; stepSeconds: number; windowSeconds: number };
export type NodeDetail = {
  groups: Record<NodeGroup, NodeGroupDetail>;
  instance: string;
  metrics: Record<keyof ReturnType<typeof nodeDetailQueries>, Sample[]>;
  warnings: string[];
  updatedAt: string;
  start: number;
  end: number;
  step: number;
  windowSeconds: number;
  minutes: number;
  stepSelection: StepSelection;
};
export async function getNodeDetail(instance: string, minutes = 60, stepSelection: StepSelection = "auto", selections?: Partial<Record<NodeGroup, NodeGroupSelection>>): Promise<NodeDetail> {
  if (!(TIME_RANGES as readonly number[]).includes(minutes)) throw new Error("无效的时间范围");
  const groups = {} as NodeDetail["groups"];
  for (const group of Object.keys(NODE_GROUPS) as NodeGroup[]) {
    const selected = selections?.[group] ?? { minutes, step: stepSelection };
    if (!(TIME_RANGES as readonly number[]).includes(selected.minutes)) throw new Error("无效的时间范围");
    const custom = selected.from !== undefined && selected.to !== undefined;
    if (custom && (!Number.isSafeInteger(selected.from) || !Number.isSafeInteger(selected.to) || selected.from! >= selected.to! || selected.to! > Math.floor(Date.now() / 1000) + 60)) throw new Error("无效的起始或结束时间");
    const rangeMinutes = custom ? (selected.to! - selected.from!) / 60 : selected.minutes;
    const stepSeconds = queryStep(rangeMinutes, selected.step);
    const end = custom ? selected.to! : Math.floor(Date.now() / 1000 / stepSeconds) * stepSeconds;
    groups[group] = { ...selected, stepSeconds, start: custom ? selected.from! : end - selected.minutes * 60, end, windowSeconds: rateWindow(stepSeconds) };
  }
  const step = queryStep(minutes, stepSelection);
  const windowSeconds = rateWindow(step);
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const start = end - minutes * 60;
  return withLogContext({ feature: "Node节点性能详情", instance, minutes, step, stepSelection, windowSeconds }, async () => {
    businessLog("node.detail.started", { description: `节点${instance}：开始查询CPU、内存、磁盘及网络性能` });
    const metricGroups = Object.fromEntries(Object.entries(NODE_GROUPS).flatMap(([group, keys]) => keys.map(key => [key, group]))) as Record<keyof ReturnType<typeof nodeDetailQueries>, NodeGroup>;
    const entries = Object.keys(nodeDetailQueries(instance, windowSeconds)) as (keyof ReturnType<typeof nodeDetailQueries>)[];
    const results = await Promise.allSettled(entries.map(key => {
      const group = groups[metricGroups[key]];
      return queryRange(nodeDetailQueries(instance, group.windowSeconds)[key], group.start, group.end, group.stepSeconds);
    }));
    const metrics = {} as NodeDetail["metrics"];
    const warnings: string[] = [];
    results.forEach((result, index) => {
      const key = entries[index];
      metrics[key] = result.status === "fulfilled" ? result.value.result : [];
      if (result.status === "rejected") warnings.push(key);
    });
    if (warnings.length === entries.length) {
      const error = new Error("节点性能指标查询失败，请检查Prometheus连接。");
      errorLog("node.detail.failed", error, { description: `节点${instance}：全部性能指标查询失败，${error.message}` });
      throw error;
    }
    businessLog("node.detail.completed", {
      description: `节点${instance}：性能详情查询完成，共${entries.length}项查询，失败${warnings.length}项`,
      failedMetrics: warnings,
    });
    return { instance, metrics, warnings, groups, start, end, step, windowSeconds, minutes, stepSelection, updatedAt: new Date().toISOString() };
  });
}
export function scalar(samples: Sample[]): number | null {
  const value = samples[0]?.value?.[1];
  return value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
}
