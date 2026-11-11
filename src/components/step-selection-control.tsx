"use client";
import { MANUAL_STEPS, type StepSelection } from "@/lib/chart";
const LABELS: Record<number, string> = { 60: "1min", 300: "5min" };
/** 渲染 Prometheus 图表采样间隔控件。
 * @param step 当前间隔选择；可为 auto 或手动秒数。
 * @param minutes 当前时间范围，Node 表单使用，可选。
 * @param stepSeconds 当前实际计算间隔，单位为秒。
 * @param pod 是否为 Pod 页面；为 true 时通过回调更新，为 false 时提交 GET 表单。
 * @param onSelect Pod 模式下的间隔变更回调，可选。
 * @returns 图表 step 选择控件。
 */
export default function StepSelectionControl({ step, minutes, stepSeconds, pod = false, onSelect }: {
  step: StepSelection; minutes?: number; stepSeconds: number; pod?: boolean; onSelect?: (step: StepSelection) => void;
}) {
  /** 将 step 秒数映射为简短标签。
   * @param seconds 采样间隔，单位为秒。
   * @returns 已配置的分钟标签或秒数标签。
   */
  const label = (seconds: number) => LABELS[seconds] || `${seconds}s`;
  if (pod) return <label className="chart-step-control">step 粒度
    <select aria-label="step 粒度" value={step} onChange={event => onSelect?.(event.target.value === "auto" ? "auto" : Number(event.target.value) as StepSelection)}>
      <option value="auto">自动（{label(stepSeconds)}）</option>
      {MANUAL_STEPS.map(seconds => <option key={seconds} value={seconds}>{label(seconds)}</option>)}
    </select>
  </label>;
  return <form className="chart-step-control" method="get"><input type="hidden" name="minutes" value={minutes} />
    <label>step 粒度
      <select name="step" aria-label="step 粒度" defaultValue={step} onChange={event => event.currentTarget.form?.requestSubmit()}>
        <option value="auto">自动（{label(stepSeconds)}）</option>
        {MANUAL_STEPS.map(seconds => <option key={seconds} value={seconds}>{label(seconds)}</option>)}
      </select>
    </label>
  </form>;
}
