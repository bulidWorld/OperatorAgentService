"use client";
import { MANUAL_STEPS, queryStep, type StepSelection } from "@/lib/chart";
import NodeCustomRange from "@/components/node-custom-range";

export default function NodeGlobalControl({ minutes, step, from, to }: { minutes: number; step: StepSelection; from?: number; to?: number }) {
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
