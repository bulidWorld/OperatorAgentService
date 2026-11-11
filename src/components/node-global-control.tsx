"use client";
import { MANUAL_STEPS, queryStep, type StepSelection } from "@/lib/chart";
import NodeCustomRange from "@/components/node-custom-range";

/** 渲染应用到所有 Node 性能图表的全局范围和 step 控件。
 * @param minutes 当前全局时间范围，单位为分钟。
 * @param step 当前全局 step 选择。
 * @param from 自定义查询起始时间，Unix 秒，可选。
 * @param to 自定义查询结束时间，Unix 秒，可选。
 * @returns 全局设置表单。
 */
export default function NodeGlobalControl({ minutes, step, from, to }: { minutes: number; step: StepSelection; from?: number; to?: number }) {
  /** 将秒数转成 step 控件显示标签。
   * @param seconds 采样间隔，单位为秒。
   * @returns 1min、5min 或以秒表示的标签。
   */
  const label = (seconds: number) => seconds === 60 ? "1min" : seconds === 300 ? "5min" : `${seconds}s`;
  return <form className="node-global-controls" method="get">
    <span>全局设置</span>
    <label>step 粒度 <select name="step" aria-label="全局 step 粒度" defaultValue={step} onChange={event => event.currentTarget.form?.requestSubmit()}>
      <option value="auto">自动（{label(queryStep(from !== undefined && to !== undefined ? (to - from) / 60 : minutes))}）</option>
      {MANUAL_STEPS.map(value => <option key={value} value={value}>{label(value)}</option>)}
    </select></label>
    <NodeCustomRange prefix="" from={from} to={to} minutes={minutes} />
  </form>;
}
