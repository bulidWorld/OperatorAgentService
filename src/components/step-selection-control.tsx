"use client";
import { MANUAL_STEPS, type StepSelection } from "@/lib/chart";
const LABELS: Record<number, string> = { 60: "1min", 300: "5min" };
export default function StepSelectionControl({ step, minutes, stepSeconds, pod = false, onSelect }: {
  step: StepSelection; minutes?: number; stepSeconds: number; pod?: boolean; onSelect?: (step: StepSelection) => void;
}) {
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
