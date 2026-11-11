import { getNodeDetail, NODE_GROUPS, type NodeDetail, type NodeGroup, type NodeGroupSelection } from "@/lib/prometheus/node-detail";
import NodeMetricPanel from "@/components/node-metric-panel";
import NodeGlobalControl from "@/components/node-global-control";
import { TIME_RANGES, isStepSelection, type ChartUnit, type StepSelection } from "@/lib/chart";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const definitions: { key: keyof NodeDetail["metrics"]; title: string; unit: ChartUnit; note: string; rate?: boolean }[] = [
  { key: "cpu", title: "CPU 使用率", unit: "percent", note: "非空闲 CPU 比例", rate: true },
  { key: "memory", title: "内存使用率", unit: "percent", note: "(总内存 − 可用内存) / 总内存" },
  { key: "cores", title: "CPU 核数", unit: "number", note: "逻辑处理器数量" },
  { key: "load", title: "系统负载", unit: "number", note: "最近1分钟平均负载" },
  { key: "memoryTotal", title: "内存总量", unit: "bytes", note: "物理内存总量" },
  { key: "memoryAvailable", title: "可用内存", unit: "bytes", note: "包含可回收缓存" },
  { key: "receive", title: "网络接收", unit: "bytes/s", note: "非lo网卡合计接收速率", rate: true },
  { key: "transmit", title: "网络发送", unit: "bytes/s", note: "非lo网卡合计发送速率", rate: true },
  { key: "diskRead", title: "磁盘读取吞吐", unit: "bytes/s", note: "各设备读取速率，设备之间不累加", rate: true },
  { key: "diskWrite", title: "磁盘写入吞吐", unit: "bytes/s", note: "各设备写入速率，设备之间不累加", rate: true },
  { key: "diskReadIops", title: "磁盘读取 IOPS", unit: "iops", note: "各设备每秒读取次数", rate: true },
  { key: "diskWriteIops", title: "磁盘写入 IOPS", unit: "iops", note: "各设备每秒写入次数", rate: true },
  { key: "diskBusy", title: "磁盘 I/O 忙碌率", unit: "percent", note: "各设备执行 I/O 的时间占比", rate: true },
  { key: "filesystem", title: "文件系统空间使用率", unit: "percent", note: "按挂载点展示，基于普通用户可用空间" },
];
const groups: { key: NodeGroup; title: string; metrics: (keyof NodeDetail["metrics"])[] }[] = [
  { key: "cpu", title: "CPU 与系统负载", metrics: ["cpu", "cores", "load"] },
  { key: "memory", title: "内存", metrics: ["memory", "memoryTotal", "memoryAvailable"] },
  { key: "network", title: "网络吞吐", metrics: ["receive", "transmit"] },
  { key: "disk", title: "磁盘 I/O", metrics: ["diskRead", "diskWrite", "diskReadIops", "diskWriteIops", "diskBusy"] },
  { key: "filesystem", title: "文件系统", metrics: ["filesystem"] },
];
const combined: Partial<Record<NodeGroup, (keyof NodeDetail["metrics"])[][]>> = {
  cpu: [["cpu"], ["cores", "load"]],
  memory: [["memory"], ["memoryTotal", "memoryAvailable"]],
  network: [["receive", "transmit"]],
  disk: [["diskRead", "diskWrite"], ["diskReadIops", "diskWriteIops"], ["diskBusy"]],
};
export default async function NodeDetailPage({ params, searchParams }: {
  params: Promise<{ instance: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { instance } = await params;
  const search = await searchParams;
  const selected = Number(search.minutes || 60);
  const minutes = (TIME_RANGES as readonly number[]).includes(selected) ? selected : 60;
  const rawStep = search.step || "auto";
  const stepSelection: StepSelection = rawStep === "auto" ? "auto" : isStepSelection(Number(rawStep)) ? Number(rawStep) as StepSelection : "auto";
  const timestamp = (value: string | string[] | undefined) => typeof value === "string" && value !== "" && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const globalFrom = timestamp(search.From);
  const globalTo = timestamp(search.To);
  const selections = {} as Record<NodeGroup, NodeGroupSelection>;
  for (const group of Object.keys(NODE_GROUPS) as NodeGroup[]) {
    const hasLocal = search[`${group}Minutes`] !== undefined || search[`${group}Step`] !== undefined;
    const rawMinutes = Number(search[`${group}Minutes`] ?? minutes);
    const rawGroupStep = search[`${group}Step`] ?? stepSelection;
    selections[group] = {
      minutes: (TIME_RANGES as readonly number[]).includes(rawMinutes) ? rawMinutes : minutes,
      step: rawGroupStep === "auto" ? "auto" : isStepSelection(Number(rawGroupStep)) ? Number(rawGroupStep) as StepSelection : "auto",
      from: hasLocal ? timestamp(search[`${group}From`]) : globalFrom,
      to: hasLocal ? timestamp(search[`${group}To`]) : globalTo,
    };
  }
  let detail;
  try { detail = await getNodeDetail(instance, minutes, stepSelection, selections); }
  catch (error) {
    return <main className="node-detail"><a className="button" href="/?scope=nodes">← 返回Node监控</a><h1>{instance} · 节点详情</h1><div className="error" role="alert">{error instanceof Error ? error.message : "节点详情加载失败"}</div></main>;
  }
  return <main className="node-detail">
    <a className="detail-back" href="/?scope=nodes">← 返回Node监控</a>
    <div className="page-heading"><div><div className="eyebrow">NODE PERFORMANCE</div><h1>{instance} <span>节点性能详情</span></h1><p>悬停查看时间与数值；全局设置应用于所有面板，也可单独调整。</p></div><NodeGlobalControl minutes={minutes} step={stepSelection} from={globalFrom} to={globalTo} /></div>
    {detail.warnings.length > 0 && <div className="error" role="alert">部分性能指标查询失败，可刷新重试；已成功的指标仍然显示。</div>}
    <div className="performance-charts">{[["cpu", "network", "filesystem"], ["memory", "disk"]].map((column, index) => <div className="performance-column" key={index}>{column.map(key => {
      const group = groups.find(item => item.key === key)!;
      const range = detail.groups[group.key];
      const charts = (combined[group.key] ?? group.metrics.map(key => [key])).map(keys => {
          const definitionsForChart = keys.map(key => definitions.find(definition => definition.key === key)!);
          const series = definitionsForChart.flatMap(definition => detail.metrics[definition.key].map(sample => ({
            name: [definition.title, sample.metric.device, sample.metric.mountpoint].filter(Boolean).join(" · "),
            device: sample.metric.device,
            points: (sample.values || []).filter(([, value]) => Number.isFinite(Number(value))).map(([time, value]) => ({ time, value: Number(value) })),
          })));
          const title = definitionsForChart.map(definition => definition.title).join(" / ");
          return { title, series, rate: definitionsForChart.some(definition => definition.rate), description: definitionsForChart.map(definition => `${definition.title}：${definition.note}`).join("；"), unit: definitionsForChart[0].unit };
        });
      return <NodeMetricPanel key={group.key} group={group.key} title={group.title} charts={charts} range={range} selections={selections} global={{ minutes, step: stepSelection, from: globalFrom, to: globalTo }} />;
    })}</div>)}</div>
    <footer>更新于 {new Date(detail.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · 数据来源 Prometheus / node-exporter</footer>
  </main>;
}
