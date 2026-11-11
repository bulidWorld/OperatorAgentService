export const TIME_RANGES = [15, 60, 360, 1440] as const;
export const MANUAL_STEPS = [5, 15, 30, 60, 300] as const;
export type StepSelection = "auto" | (typeof MANUAL_STEPS)[number];
export function isStepSelection(value: number): value is (typeof MANUAL_STEPS)[number] {
  return (MANUAL_STEPS as readonly number[]).includes(value);
}
export function queryStep(minutes: number, selected: StepSelection = "auto") {
  // Automatic mode keeps the graph to about 120 samples. Manual mode uses
  // one of Prometheus' accepted duration steps directly.
  return selected === "auto" ? Math.max(30, Math.ceil(minutes * 60 / 120)) : selected;
}
export function rateWindow(step: number) {
  // Allow enough samples for rate even when the evaluation interval grows.
  return Math.max(300, step * 4);
}
export function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
export type Point = { time: number; value: number };
export type ChartSeries = { name: string; points: Point[] };
export type ChartUnit = "percent" | "bytes" | "bytes/s" | "cores" | "iops" | "seconds" | "number";
export function formatMetric(value: number, unit: ChartUnit, precise = false): string {
  const format = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: precise ? 6 : 2 });
  if (unit === "bytes" || unit === "bytes/s") {
    const index = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(Math.abs(value), 1)) / 10)));
    return `${format(value / 1024 ** index)} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}${unit === "bytes/s" ? "/s" : ""}`;
  }
  return `${format(value)}${{ percent: "%", cores: " cores", iops: " IOPS", seconds: " s", number: "" }[unit]}`;
}
export function nearestPoint(points: Point[], time: number) {
  return points.reduce<Point | undefined>((closest, point) =>
    !closest || Math.abs(point.time - time) < Math.abs(closest.time - time) ? point : closest, undefined);
}
