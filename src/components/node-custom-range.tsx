"use client";
import { useState } from "react";
import { TIME_RANGES } from "@/lib/chart";

export default function NodeCustomRange({ prefix, from, to, minutes }: { prefix: string; from?: number; to?: number; minutes: number }) {
  const localValue = (seconds?: number) => seconds === undefined ? "" : new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16);
  const [mode, setMode] = useState<"range" | "custom">(from !== undefined && to !== undefined ? "custom" : "range");
  const [start, setStart] = useState(localValue(from));
  const [end, setEnd] = useState(localValue(to));
  const startSeconds = start ? Math.floor(new Date(`${start}:00+08:00`).getTime() / 1000) : undefined;
  const endSeconds = end ? Math.floor(new Date(`${end}:00+08:00`).getTime() / 1000) : undefined;
  const valid = startSeconds !== undefined && endSeconds !== undefined && Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && startSeconds < endSeconds && endSeconds <= Math.floor(Date.now() / 1000) + 60;
  return <span className="node-custom-range">
    <label>查询方式 <select aria-label={`${prefix || "全局"}查询方式`} value={mode} onChange={event => setMode(event.target.value as "range" | "custom")}>
      <option value="range">时间范围</option><option value="custom">起止时间</option>
    </select></label>
    {mode === "range" ? <label>时间范围 <select name={`${prefix}Minutes`} aria-label={`${prefix || "全局"}时间范围`} defaultValue={minutes} onChange={event => event.currentTarget.form?.requestSubmit()}>
      {TIME_RANGES.map(value => <option key={value} value={value}>{value < 60 ? `最近${value}分钟` : value < 1440 ? `最近${value / 60}小时` : "最近24小时"}</option>)}
    </select></label> : <>
      <input type="hidden" name={`${prefix}Minutes`} value={minutes} />
      <label>起始时间 <input type="datetime-local" aria-label={`${prefix || "全局"}起始时间`} value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>结束时间 <input type="datetime-local" aria-label={`${prefix || "全局"}结束时间`} value={end} onChange={event => setEnd(event.target.value)} /></label>
      <button type="submit" disabled={!valid}>查询</button>
    </>}
    <input type="hidden" name={`${prefix}From`} value={mode === "custom" && valid ? startSeconds : ""} />
    <input type="hidden" name={`${prefix}To`} value={mode === "custom" && valid ? endSeconds : ""} />
  </span>;
}
