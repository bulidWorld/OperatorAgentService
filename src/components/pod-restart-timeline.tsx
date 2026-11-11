import type { PodRestartEvent } from "@/lib/prometheus/pod-detail";

/** 将 Unix 秒时间戳格式化为上海本地时间。
 * @param time 重启事件时间，Unix 秒。
 * @returns 精确到秒的本地日期时间字符串。
 */
function formatRestartTime(time: number): string {
  return new Date(time * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

/** 展示最近 24 小时的 Pod 重启时间轴和对应容器记录表。
 * @param events 最近 24 小时内按时间排序的容器重启事件。
 * @param start 时间轴起点，Unix 秒。
 * @param end 时间轴终点，Unix 秒。
 * @param warning 重启计数指标查询失败或无该 Pod 序列时为 true。
 * @returns 含可悬停时间点和重启记录表的服务端渲染面板。
 */
export default function PodRestartTimeline({
  events,
  start,
  end,
  warning,
}: {
  events: PodRestartEvent[];
  start: number;
  end: number;
  warning: boolean;
}) {
  const span = Math.max(1, end - start);
  return (
    <section className="panel pod-restart-history">
      <div className="panel-heading">
        <div>
          <h2>Pod 重启记录</h2>
          <p>最近 24 小时 · {events.length} 次</p>
        </div>
      </div>
      {warning ? (
        <div className="empty">重启计数指标暂不可用，请检查 kube-state-metrics 是否采集 kube_pod_container_status_restarts_total。</div>
      ) : !events.length ? (
        <div className="empty">最近 24 小时没有检测到重启记录。</div>
      ) : (
        <>
          <div className="restart-timeline" role="img" aria-label="最近24小时Pod容器重启时间轴">
            <div className="restart-axis" />
            <div className="restart-tick restart-tick-start"><i />24 小时前</div>
            <div className="restart-tick restart-tick-middle"><i />12 小时前</div>
            <div className="restart-tick restart-tick-end"><i />现在</div>
            {events.map((event, index) => {
              const fraction = Math.max(0, Math.min(1, (event.time - start) / span));
              const position = 6 + fraction * 88;
              const label = `${formatRestartTime(event.time)} · ${event.container}`;
              return (
                <button
                  className="restart-marker"
                  key={`${event.container}-${event.time}-${index}`}
                  type="button"
                  style={{ left: `${position}%` }}
                  title={label}
                  aria-label={`重启时间：${label}`}
                >
                  <span />
                </button>
              );
            })}
          </div>
          <div className="restart-table-wrap">
            <table className="restart-table">
              <thead><tr><th>容器</th><th>重启时间</th></tr></thead>
              <tbody>
                {[...events].reverse().map((event, index) => (
                  <tr key={`${event.container}-${event.time}-${index}`}>
                    <td>{event.container}</td>
                    <td>{formatRestartTime(event.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
