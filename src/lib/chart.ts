export const TIME_RANGES = [15, 60, 360, 1440] as const;
export const MANUAL_STEPS = [5, 15, 30, 60, 300] as const;
export type StepSelection = "auto" | (typeof MANUAL_STEPS)[number];
/** 判断计算间隔是否属于 Prometheus 图表支持的手动选项。
 * @param value 待检查的秒数。
 * @returns 支持时返回 true，同时将 value 收窄为手动间隔联合类型。
 */
export function isStepSelection(value: number): value is (typeof MANUAL_STEPS)[number] {
  return (MANUAL_STEPS as readonly number[]).includes(value);
}
/** 根据时间范围和用户选择计算 query_range 的采样间隔。
 * @param minutes 查询时间范围，单位为分钟。
 * @param selected 用户选择的间隔；auto 模式会将图表控制在约 120 个采样点。
 * @returns 采样间隔，单位为秒。
 */
export function queryStep(minutes: number, selected: StepSelection = "auto") {
  // Automatic mode keeps the graph to about 120 samples. Manual mode uses
  // one of Prometheus' accepted duration steps directly.
  return selected === "auto" ? Math.max(30, Math.ceil(minutes * 60 / 120)) : selected;
}
/** 计算 PromQL rate 函数使用的窗口长度。
 * @param step query_range 采样间隔，单位为秒。
 * @returns rate 窗口长度，至少为 300 秒。
 */
export function rateWindow(step: number) {
  // Allow enough samples for rate even when the evaluation interval grows.
  return Math.max(300, step * 4);
}
/** 将秒数格式化为 Prometheus 使用的时长字符串。
 * @param seconds 时长，单位为秒。
 * @returns 以 h、m 或 s 为单位的字符串。
 */
export function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
export type Point = { time: number; value: number };
export type ChartSeries = { name: string; points: Point[] };
export type ChartUnit = "percent" | "bytes" | "bytes/s" | "cores" | "iops" | "seconds" | "number";
/** 按指标单位格式化数值及其显示单位。
 * @param value 原始指标值。
 * @param unit 指标的单位类别。
 * @param precise 是否保留最多六位小数；默认最多两位。
 * @returns 带本地化数字和单位后缀的字符串。
 */
export function formatMetric(value: number, unit: ChartUnit, precise = false): string {
  /** 按当前精度设置格式化数字本身。
   * @param n 要格式化的数值。
   * @returns 使用 zh-CN 分组格式化的数字字符串。
   */
  const format = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: precise ? 6 : 2 });
  if (unit === "bytes" || unit === "bytes/s") {
    const index = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(Math.abs(value), 1)) / 10)));
    return `${format(value / 1024 ** index)} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}${unit === "bytes/s" ? "/s" : ""}`;
  }
  return `${format(value)}${{ percent: "%", cores: " cores", iops: " IOPS", seconds: " s", number: "" }[unit]}`;
}
/** 在采样点中查找距离目标时间最近的一点。
 * @param points 候选时间序列采样点。
 * @param time 目标时间戳，单位与 Point.time 相同。
 * @returns 最近采样点；数组为空时返回 undefined。
 */
export function nearestPoint(points: Point[], time: number) {
  return points.reduce<Point | undefined>((closest, point) =>
    !closest || Math.abs(point.time - time) < Math.abs(closest.time - time) ? point : closest, undefined);
}
