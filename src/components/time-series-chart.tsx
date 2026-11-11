"use client";
import { useState } from "react";
import { duration, formatMetric, nearestPoint, type ChartSeries, type ChartUnit } from "@/lib/chart";
const COLORS = ["#0eae9a", "#4687e8", "#e69525", "#9c6ade", "#dd637f", "#607d8b"];
/** 绘制可悬停、触摸、键盘查看数值的 SVG 时间序列图。
 * @param series 要显示的曲线及其采样点。
 * @param step 横轴采样间隔，单位为秒。
 * @param unit 曲线数值单位。
 * @param title 图表标题。
 * @param description 图表说明，可选。
 * @param start 图表时间范围起点，Unix 秒，可选；缺省时由数据计算。
 * @param end 图表时间范围终点，Unix 秒，可选；缺省时由数据计算。
 * @param loading 是否正在加载数据，默认 false。
 * @param windowSeconds PromQL rate 窗口秒数，可选，用于说明计算窗口。
 * @returns SVG 曲线、采样提示和图例组成的 React 元素。
 */
export default function TimeSeriesChart({ series, step, unit, title, description, start, end, loading = false, windowSeconds }: {
  series: ChartSeries[]; step: number; unit: ChartUnit; title: string; description?: string;
  start?: number; end?: number; loading?: boolean; windowSeconds?: number;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const visible = series.map((item, index) => ({ item, index })).filter(({ index }) => !hidden.has(index));
  const all = visible.flatMap(({ item }) => item.points);
  const from = start ?? Math.min(...all.map(point => point.time));
  const to = end ?? Math.max(...all.map(point => point.time));
  const span = Math.max(to - from, step);
  const max = Math.max(...all.map(point => point.value), unit === "percent" ? 100 : 0.001) * 1.08;
  /** 将 Unix 秒时间映射到 SVG 横坐标。
   * @param time 采样点时间，Unix 秒。
   * @returns SVG 坐标系中的横坐标。
   */
  const x = (time: number) => 78 + (time - from) / span * 690;
  /** 将指标值映射到 SVG 纵坐标。
   * @param value 采样点指标值。
   * @returns SVG 坐标系中的纵坐标。
   */
  const y = (value: number) => 180 - value / max * 150;
  const selected = cursor === null ? [] : visible.map(({ item, index }) => ({
    name: item.name, color: COLORS[index % COLORS.length], point: nearestPoint(item.points, cursor),
  })).filter(item => item.point && Math.abs(item.point.time - cursor) <= step / 2 + 0.001);
  const selectedTime = selected[0]?.point?.time;
  return <div className="series-chart">
    <div className="chart-info"><span>{title}</span><span className="chart-info-tip" tabIndex={0} aria-label={`${title}说明`}>ⓘ<span className="chart-info-content" role="tooltip">{description && <span>{description}<br /></span>}计算粒度 · step={duration(step)}{windowSeconds ? <span> · rate 窗口 {duration(windowSeconds)}</span> : null}</span></span></div>
    {!all.length ? <div className="chart-empty">{hidden.size === series.length && series.length ? "已隐藏全部曲线，可点击图例重新显示" : loading ? "正在加载指标…" : "暂无采集数据"}</div> : <>
      <svg viewBox="0 0 800 220" role="img" aria-label={`${title}时间序列图`} tabIndex={0}
        onPointerMove={event => {
          const matrix = event.currentTarget.getScreenCTM();
          if (!matrix) return;
          const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
          if (local.x < 78 || local.x > 768 || local.y < 25 || local.y > 185) { setCursor(null); return; }
          const time = from + (local.x - 78) / 690 * span;
          setCursor(Math.min(to, from + Math.round((time - from) / step) * step));
        }} onPointerLeave={() => setCursor(null)} onFocus={() => setCursor(from)} onBlur={() => setCursor(null)}
        onKeyDown={event => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault(); setCursor(Math.min(to, Math.max(from, (cursor ?? from) + (event.key === "ArrowRight" ? step : -step))));
          }
        }}>
        {[0, 1, 2, 3, 4].map(index => <g key={index}>
          <line x1="78" x2="768" y1={30 + index * 37.5} y2={30 + index * 37.5} stroke="#edf0f4" strokeDasharray="4 4" />
          <text x="70" y={34 + index * 37.5} textAnchor="end">{formatMetric(max * (1 - index / 4), unit)}</text>
        </g>)}
        {visible.map(({ item, index }) => {
          // Split paths across missing samples instead of joining gaps with an invented value.
          const paths: string[][] = [];
          item.points.forEach((point, pointIndex) => {
            if (!paths.length || (pointIndex && point.time - item.points[pointIndex - 1].time > step * 1.5)) paths.push([]);
            paths[paths.length - 1].push(`${x(point.time)},${y(point.value)}`);
          });
          return <g key={`${item.name}-${index}`}>{paths.map((path, part) => <polyline key={part} points={path.join(" ")} fill="none" stroke={COLORS[index % COLORS.length]} strokeWidth="2" strokeLinejoin="round" />)}
            {item.points.length === 1 && <circle cx={x(item.points[0].time)} cy={y(item.points[0].value)} r="3" fill={COLORS[index % COLORS.length]} />}
          </g>;
        })}
        {[0, .25, .5, .75, 1].map((fraction, index) => <text key={index} x={78 + fraction * 690} y="207" textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"}>{new Date((from + span * fraction) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}</text>)}
        {selectedTime !== undefined && <g pointerEvents="none"><line x1={x(selectedTime)} x2={x(selectedTime)} y1="25" y2="180" stroke="#8a9aac" strokeDasharray="4 3" />{selected.map(item => <circle key={item.name} cx={x(item.point!.time)} cy={y(item.point!.value)} r="4" fill={item.color} stroke="white" strokeWidth="2" />)}</g>}
      </svg>
      {selectedTime !== undefined && <div className="chart-tooltip" role="tooltip" style={{ left: `clamp(8px, calc(${x(selectedTime) / 8}% - 110px), calc(100% - 228px))` }}>
        <strong>{new Date(selectedTime * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</strong>
        {selected.map(item => <div key={item.name}><span style={{ color: item.color }}>{item.name}</span><b>{formatMetric(item.point!.value, unit, true)}</b></div>)}
      </div>}
    </>}
    <div className="series-legend">{series.map((item, index) => <button type="button" key={`${item.name}-${index}`} aria-pressed={!hidden.has(index)} aria-label={`${hidden.has(index) ? "显示" : "隐藏"}${item.name}曲线`} className={hidden.has(index) ? "is-hidden" : ""} onClick={() => setHidden(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    })}><i style={{ background: COLORS[index % COLORS.length] }} />{item.name}</button>)}</div>
  </div>;
}
