"use client";
import { TIME_RANGES } from "@/lib/chart";
export default function TimeRangeControl({ minutes, step }: { minutes: number; step: "auto" | number }) {
  return <form className="detail-range" method="get">
    <input type="hidden" name="step" value={step} />
    <label>时间范围 <select name="minutes" aria-label="时间范围" defaultValue={minutes} onChange={event => event.currentTarget.form?.requestSubmit()}>
      {TIME_RANGES.map(value => <option key={value} value={value}>{value < 60 ? `最近${value}分钟` : value < 1440 ? `最近${value / 60}小时` : "最近24小时"}</option>)}
    </select></label>
    <button className="button" type="submit">刷新指标</button>
  </form>;
}
