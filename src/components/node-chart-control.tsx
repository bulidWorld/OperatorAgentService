"use client";
import { MANUAL_STEPS, queryStep } from "@/lib/chart";
import type {
  NodeGroup,
  NodeGroupSelection,
} from "@/lib/prometheus/node-detail";
import NodeCustomRange from "@/components/node-custom-range";

/** 渲染单个 Node 指标组的 step 和时间范围控件。
 * @param group 当前图表组名称。
 * @param selections 所有图表组当前选中的查询范围。
 * @param global 全局时间范围、step 和自定义起止时间。
 * @returns GET 表单形式的图表组控件。
 */
export default function NodeChartControl({
  group,
  selections,
  global,
}: {
  group: NodeGroup;
  selections: Record<NodeGroup, NodeGroupSelection>;
  global: NodeGroupSelection;
}) {
  const selected = selections[group];
  /** 将秒数转成 step 控件使用的标签。
   * @param seconds 采样间隔，单位为秒。
   * @returns 1min、5min 或以秒表示的标签。
   */
  const label = (seconds: number) =>
    seconds === 60 ? "1min" : seconds === 300 ? "5min" : `${seconds}s`;
  return (
    <form className="node-chart-controls" method="get">
      <input type="hidden" name="minutes" value={global.minutes} />
      <input type="hidden" name="step" value={global.step} />
      <input type="hidden" name="From" value={global.from ?? ""} />
      <input type="hidden" name="To" value={global.to ?? ""} />
      {Object.entries(selections)
        .filter(([key]) => key !== group)
        .flatMap(([key, value]) => [
          <input
            key={`${key}-minutes`}
            type="hidden"
            name={`${key}Minutes`}
            value={value.minutes}
          />,
          <input
            key={`${key}-step`}
            type="hidden"
            name={`${key}Step`}
            value={value.step}
          />,
          <input
            key={`${key}-from`}
            type="hidden"
            name={`${key}From`}
            value={value.from ?? ""}
          />,
          <input
            key={`${key}-to`}
            type="hidden"
            name={`${key}To`}
            value={value.to ?? ""}
          />,
        ])}
      <label>
        step 粒度{" "}
        <select
          name={`${group}Step`}
          aria-label={`${group} step 粒度`}
          defaultValue={selected.step}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          <option value="auto">
            自动（
            {label(
              queryStep(
                selected.from !== undefined && selected.to !== undefined
                  ? (selected.to - selected.from) / 60
                  : selected.minutes,
                "auto",
              ),
            )}
            ）
          </option>
          {MANUAL_STEPS.map((step) => (
            <option key={step} value={step}>
              {label(step)}
            </option>
          ))}
        </select>
      </label>
      <NodeCustomRange
        prefix={group}
        from={selected.from}
        to={selected.to}
        minutes={selected.minutes}
      />
    </form>
  );
}
