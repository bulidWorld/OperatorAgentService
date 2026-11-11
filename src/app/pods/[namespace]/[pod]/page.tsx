import { getPodDetail, POD_GROUPS, type PodDetail, type PodGroup, type PodMetric } from "@/lib/prometheus/pod-detail";
import type { NodeGroup, NodeGroupSelection } from "@/lib/prometheus/node-detail";
import NodeMetricPanel from "@/components/node-metric-panel";
import NodeGlobalControl from "@/components/node-global-control";
import { TIME_RANGES, isStepSelection, type ChartUnit, type StepSelection } from "@/lib/chart";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const definitions: Record<PodMetric, { title: string; unit: ChartUnit; note: string; rate?: boolean }> = {
  cpu: { title: "CPU 使用率", unit: "percent", note: "以单核为 100%，多核 Pod 可超过 100%", rate: true },
  cpuLimit: { title: "CPU Limit 使用比例", unit: "percent", note: "CPU 使用核数 / CPU Limit；未设置 Limit 时无数据", rate: true },
  throttling: { title: "CPU Throttling（限流）", unit: "percent", note: "被限流周期占总调度周期比例", rate: true },
  memory: { title: "内存使用量", unit: "bytes", note: "容器 Working Set 总量" },
  memoryLimit: { title: "内存 Limit 使用比例", unit: "percent", note: "Working Set / 内存 Limit；未设置 Limit 时无数据" },
  diskRead: { title: "磁盘读取速率", unit: "bytes/s", note: "容器文件系统读取字节速率", rate: true },
  diskWrite: { title: "磁盘写入速率", unit: "bytes/s", note: "容器文件系统写入字节速率", rate: true },
  diskLatency: { title: "磁盘 I/O 延迟", unit: "seconds", note: "I/O 执行时间 / 完成操作数；取决于 cAdvisor 指标", rate: true },
  diskWait: { title: "磁盘 I/O 等待时间", unit: "seconds", note: "加权 I/O 时间每秒增量，表示队列等待量；取决于 cAdvisor 指标", rate: true },
  diskUtilization: { title: "磁盘 I/O 利用率", unit: "percent", note: "执行 I/O 的时间占比；共享设备可能超过 100%", rate: true },
  receive: { title: "网络接收流量", unit: "bytes/s", note: "非 lo 接口接收速率", rate: true },
  transmit: { title: "网络发送流量", unit: "bytes/s", note: "非 lo 接口发送速率", rate: true },
  receiveDrops: { title: "网络接收丢包", unit: "number", note: "每秒接收丢包数", rate: true },
  transmitDrops: { title: "网络发送丢包", unit: "number", note: "每秒发送丢包数", rate: true },
  receiveErrors: { title: "网络接收错误数", unit: "number", note: "每秒接收错误数", rate: true },
  transmitErrors: { title: "网络发送错误数", unit: "number", note: "每秒发送错误数", rate: true },
};
const layout: { key: PodGroup; title: string; charts: PodMetric[][] }[] = [
  { key: "cpu", title: "CPU", charts: [["cpu"], ["cpuLimit", "throttling"]] },
  { key: "memory", title: "内存", charts: [["memory"], ["memoryLimit"]] },
  { key: "disk", title: "磁盘 I/O", charts: [["diskRead", "diskWrite"], ["diskLatency", "diskWait"], ["diskUtilization"]] },
  { key: "network", title: "网络", charts: [["receive", "transmit"], ["receiveDrops", "transmitDrops"], ["receiveErrors", "transmitErrors"]] },
];
/** 服务端渲染指定 namespace/Pod 的性能详情页。
 * @param params 动态路由参数，包含 namespace 和 Pod 名称。
 * @param searchParams 全局和分组时间范围、step 以及自定义起止时间。
 * @returns Pod 详情图表页面；查询失败时返回带错误提示的页面内容。
 */
export default async function PodDetailPage({ params, searchParams }: {
  params: Promise<{ namespace: string; pod: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { namespace, pod } = await params;
  const search = await searchParams;
  const selected = Number(search.minutes || 60);
  const minutes = (TIME_RANGES as readonly number[]).includes(selected) ? selected : 60;
  /** 将 URL 中的 step 参数解析为支持的采样间隔。
   * @param value URL 参数值，可能是字符串、数组、数字或未设置。
   * @returns 支持的 step；auto、缺失或无效输入返回 auto。
   */
  const parseStep = (value: string | string[] | number | undefined): StepSelection => value === "auto" || value === undefined ? "auto" : isStepSelection(Number(value)) ? Number(value) as StepSelection : "auto";
  const stepSelection = parseStep(search.step);
  /** 将 URL 查询参数转换为 Unix 秒时间戳。
   * @param value 单个字符串、重复参数数组或未提供的值。
   * @returns 安全整数时间戳；非单值或无效值返回 undefined。
   */
  const timestamp = (value: string | string[] | undefined) => typeof value === "string" && value !== "" && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const globalFrom = timestamp(search.From), globalTo = timestamp(search.To);
  const selections = {} as Record<PodGroup, NodeGroupSelection>;
  for (const group of Object.keys(POD_GROUPS) as PodGroup[]) {
    const hasLocal = search[`${group}Minutes`] !== undefined || search[`${group}Step`] !== undefined;
    const rawMinutes = Number(search[`${group}Minutes`] ?? minutes);
    selections[group] = { minutes: (TIME_RANGES as readonly number[]).includes(rawMinutes) ? rawMinutes : minutes, step: parseStep(search[`${group}Step`] ?? stepSelection), from: hasLocal ? timestamp(search[`${group}From`]) : globalFrom, to: hasLocal ? timestamp(search[`${group}To`]) : globalTo };
  }
  let detail: PodDetail;
  try { detail = await getPodDetail(namespace, pod, minutes, stepSelection, selections); }
  catch (error) { return <main className="node-detail"><a className="button" href="/?scope=pods">← 返回 Pod 监控</a><h1>{pod} · Pod 详情</h1><div className="error" role="alert">{error instanceof Error ? error.message : "Pod 详情加载失败"}</div></main>; }
  return <main className="node-detail">
    <a className="detail-back" href="/?scope=pods">← 返回 Pod 监控</a>
    <div className="page-heading"><div><div className="eyebrow">POD PERFORMANCE · {namespace}</div><h1>{pod} <span>Pod 性能详情</span></h1><p>悬停查看时间与数值；全局设置应用于所有面板，也可单独调整。</p></div><NodeGlobalControl minutes={minutes} step={stepSelection} from={globalFrom} to={globalTo} /></div>
    {detail.warnings.length > 0 && <div className="error" role="alert">部分性能指标查询失败，可刷新重试；已成功的指标仍然显示。</div>}
    <div className="performance-charts">{[["cpu", "network"], ["memory", "disk"]].map((column, index) => <div className="performance-column" key={index}>{column.map(key => {
      const group = layout.find(item => item.key === key)!;
      const range = detail.groups[group.key];
      const charts = group.charts.map(keys => ({
        title: keys.map(metric => definitions[metric].title).join(" / "),
        description: keys.map(metric => `${definitions[metric].title}：${definitions[metric].note}`).join("；"),
        unit: definitions[keys[0]].unit,
        rate: keys.some(metric => definitions[metric].rate),
        series: keys.flatMap(metric => detail.metrics[metric].map(sample => ({ name: definitions[metric].title, points: (sample.values || []).filter(([, value]) => Number.isFinite(Number(value))).map(([time, value]) => ({ time, value: Number(value) })) }))),
      }));
      return <NodeMetricPanel key={group.key} group={group.key as NodeGroup} title={group.title} charts={charts} range={range} selections={selections as unknown as Record<NodeGroup, NodeGroupSelection>} global={{ minutes, step: stepSelection, from: globalFrom, to: globalTo }} />;
    })}</div>)}</div>
    <footer>更新于 {new Date(detail.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · 数据来源 Prometheus / kubelet / cAdvisor</footer>
  </main>;
}
