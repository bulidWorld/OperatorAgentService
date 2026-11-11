"use client";
import { useState } from "react";
import TimeSeriesChart from "@/components/time-series-chart";
import NodeChartControl from "@/components/node-chart-control";
import type { ChartSeries, ChartUnit } from "@/lib/chart";
import type { NodeGroup, NodeGroupDetail, NodeGroupSelection } from "@/lib/prometheus/node-detail";

type DeviceSeries = ChartSeries & { device?: string };
export type NodePanelChart = { title: string; description: string; unit: ChartUnit; rate: boolean; series: DeviceSeries[] };

export default function NodeMetricPanel({ group, title, charts, range, selections, global }: {
  group: NodeGroup; title: string; charts: NodePanelChart[]; range: NodeGroupDetail;
  selections: Record<NodeGroup, NodeGroupSelection>; global: NodeGroupSelection;
}) {
  const [device, setDevice] = useState("all");
  const devices = group === "disk" ? [...new Set(charts.flatMap(chart => chart.series.map(series => series.device).filter((value): value is string => !!value)))].sort() : [];
  return <section className="panel">
    <div className="panel-heading">
      <div className="node-panel-title"><h2>{title}</h2>{group === "disk" && <label>磁盘 <select aria-label="选择磁盘" value={device} onChange={event => setDevice(event.target.value)}>
        <option value="all">全部磁盘</option>
        {devices.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>}</div>
      <NodeChartControl group={group} selections={selections} global={global} />
    </div>
    <div className="node-panel-charts">{charts.map(chart => <TimeSeriesChart key={chart.title} series={device === "all" ? chart.series : chart.series.filter(series => series.device === device)} step={range.stepSeconds} windowSeconds={chart.rate ? range.windowSeconds : undefined} title={chart.title} description={chart.description} unit={chart.unit} start={range.start} end={range.end} />)}</div>
  </section>;
}
