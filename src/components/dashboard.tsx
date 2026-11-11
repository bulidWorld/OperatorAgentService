"use client";
import { type StepSelection } from "@/lib/chart";
import { useEffect, useState } from "react";
import {
  Activity,
  Boxes,
  Server,
  Bell,
  Search,
  RefreshCw,
  ChevronDown,
  CircleHelp,
  Layers3,
  Radio,
  Check,
  TriangleAlert,
} from "lucide-react";
import type { Dashboard as Data, Scope } from "@/lib/prometheus/business";
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : `${(n / 1024).toFixed(1)} KiB`;
export default function Dashboard({
  initialData = null,
  initialScope = "nodes",
  initialMinutes = 60,
  initialStep = "auto",
  initialError = "",
}: {
  initialData?: Data | null;
  initialScope?: Scope;
  initialMinutes?: number;
  initialStep?: StepSelection;
  initialError?: string;
}) {
  const scope = initialScope;
  const minutes = initialMinutes;
  const step = initialStep;
  const [search, setSearch] = useState("");
  const [namespace, setNamespace] = useState("");
  const [data, setData] = useState<Data | null>(initialData);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(!initialData && !initialError);
  const [refresh, setRefresh] = useState(0);
  const [auto, setAuto] = useState(true);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20000);
    fetch(`/api/monitor?scope=${scope}&minutes=${minutes}&step=${step}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = await r.json().catch(() => {
          throw new Error(`监控接口返回非 JSON 响应（HTTP ${r.status}），请检查服务或代理配置。`);
        });
        if (!r.ok) throw new Error(body.error || `监控请求失败（HTTP ${r.status}）`);
        return body;
      })
      .then((body: Data) => {
        if (!controller.signal.aborted) setData(body);
      })
      .catch((e: unknown) => {
        if (timedOut) setError("监控请求超过 20 秒，请检查网络或稍后重试。");
        else if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "监控请求失败");
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setLoading(false);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [scope, minutes, step, refresh]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setRefresh((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, [auto]);
  useEffect(() => {
    if (scope !== "nodes" || !auto || data?.mode === "demo") return;
    let stopped = false;
    let pending = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/node-status", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const body: { statuses: Record<string, boolean> | null } = await response.json();
        if (!stopped && body.statuses) setNodeStatuses(body.statuses);
      } catch {
        // Keep the last known status until the next successful poll.
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => { if (!stopped) void poll(); }, 3000);
    return () => { stopped = true; clearInterval(timer); controller?.abort(); };
  }, [scope, auto, data?.mode]);
  const rows = (data?.resources || []).map((row) =>
    scope === "nodes" && nodeStatuses
      ? { ...row, ready: nodeStatuses[row.name] ?? nodeStatuses[row.name.replace(/:\d+$/, "")] ?? null }
      : row,
  );
  const filtered = rows.filter(
    (r) =>
      (!namespace || r.namespace === namespace) &&
      `${r.name} ${r.namespace}`.toLowerCase().includes(search.toLowerCase()),
  );
  if (scope === "pods") filtered.sort((a, b) => (b.cpu ?? -Infinity) - (a.cpu ?? -Infinity) || a.name.localeCompare(b.name));
  const active = data?.alerts.filter((a) => a.state === "firing").length || 0;
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          <span className="brand-icon">
            <Layers3 size={23} />
          </span>
          KubeScope<span className="brand-dot">•</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">K</span>
          <div>
            <b>Kubernetes</b>
            <small>Infrastructure workspace</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <a
            href="/?scope=nodes"
            aria-current={scope === "nodes" ? "page" : undefined}
            className={scope === "nodes" ? "selected" : ""}
          >
            <Server size={18} />
            Node 监控
            <span className="nav-count">
              {scope === "nodes" && data ? rows.length : "↗"}
            </span>
          </a>
          <a
            href="/?scope=pods"
            aria-current={scope === "pods" ? "page" : undefined}
            className={scope === "pods" ? "selected" : ""}
          >
            <Boxes size={18} />
            Pod 监控
            <span className="nav-count">
              {scope === "pods" && data ? rows.length : "↗"}
            </span>
          </a>
          <a href="/alerts"><Bell size={18} />资源告警<span className="nav-count">↗</span></a>
        </nav>
        <div className="side-bottom">
          <div className="source">
            <span className={`status-dot ${error ? "bad" : ""}`} />
            <div>
              <b>Prometheus</b>
              <small>
                {error
                  ? "连接待检查"
                  : data?.mode === "demo"
                    ? "演示数据源"
                    : data
                      ? "数据源已连接"
                      : loading ? "正在连接…" : "暂无监控数据"}
              </small>
            </div>
            <Radio size={16} />
          </div>
          <div className="side-foot">
            <span className="avatar">OP</span>
            <div>
              <b>运维工作空间</b>
              <small>KubeScope / v1.0</small>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            工作空间 <span>/</span> 集群监控 <span>/</span>
            <b>{scope === "nodes" ? "Node" : "Pod"} 监控</b>
          </div>
          <div className="header-right">
            <span className="live-chip">
              <span className="status-dot" /> Prometheus
            </span>
            <span className="header-divider" />
            <a href="/alerts" aria-label="查看告警">
              <Bell size={18} />
              {active > 0 && <i />}
            </a>
            <span className="avatar small">OP</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">KUBERNETES OBSERVABILITY</div>
              <h1>
                {scope === "nodes" ? "Node" : "Pod"} 监控{" "}
                <span>{scope === "nodes" ? "节点概览" : "工作负载概览"}</span>
              </h1>
              <p>
                实时洞察
                {scope === "nodes"
                  ? "节点资源使用情况，掌握集群运行状态。"
                  : "容器资源使用情况，追踪工作负载运行状态。"}
              </p>
            </div>
            <button
              className="button"
              onClick={() => setRefresh((n) => n + 1)}
              disabled={loading}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
              刷新数据
            </button>
          </div>
          <div className="toolbar">
            <div className="toolbar-left">
              <span className="cluster-label">
                <span className="status-dot" />
                {data?.mode === "demo" ? "演示集群" : "Prometheus 集群"}
              </span>
              <span className="separator" />
              <span className="muted">
                {data?.mode === "demo"
                  ? "DEMO · 示例数据"
                  : "数据来源 · Prometheus API"}
              </span>
            </div>
            <div className="toolbar-right">
              <label className="auto">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                自动刷新 <span>{scope === "nodes" ? "状态 3s · 指标 30s" : "30s"}</span>
              </label>
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              <TriangleAlert size={20} />
              <div>
                <b>无法获取监控数据</b>
                <p>{error}</p>
              </div>
              <button onClick={() => setRefresh((n) => n + 1)}>重试</button>
            </div>
          )}
          <div className={`stats overview-stats ${scope === "nodes" ? "node-overview-stats" : ""}`}>
            <Stat
              title={`${scope === "nodes" ? "Node" : "Pod"} 总数`}
              value={data ? String(rows.length) : "—"}
              unit="个"
              icon={<Server size={19} />}
              footer={`${rows.filter((r) => r.ready === true).length} ${scope === "nodes" ? "在线" : "就绪"} · ${rows.filter((r) => r.ready === false).length} ${scope === "nodes" ? "离线" : "未就绪"} · ${rows.filter((r) => r.ready === null).length} 未知`}
            />
            <Stat
              title="活跃告警"
              value={data ? String(active) : "—"}
              unit="条"
              icon={<Bell size={19} />}
              footer={active ? "有资源需要关注" : "暂无触发中的告警"}
              warning={active > 0}
            />
            <section className="panel health">
              <div className="panel-heading">
                <div>
                  <h2>资源健康状态</h2>
                  <p>
                    {scope === "nodes"
                      ? "Exporter 抓取可用性分布"
                      : "当前就绪状态分布"}
                  </p>
                </div>
                <Activity size={17} className="muted" />
              </div>
              <div className="health-body">
                <div
                  className="donut"
                  style={{
                    background: `conic-gradient(#14b8a6 0 ${rows.length ? (rows.filter((r) => r.ready === true).length / rows.length) * 100 : 0}%, #f59e0b 0 ${rows.length ? (rows.filter((r) => r.ready !== null).length / rows.length) * 100 : 0}%, #e9edf2 0 100%)`,
                  }}
                >
                  <div>
                    <strong>{data ? rows.length : "—"}</strong>
                    <span>资源总数</span>
                  </div>
                </div>
                <div className="health-legend">
                  {[
                    [
                      scope === "nodes" ? "在线" : "就绪",
                      rows.filter((r) => r.ready === true).length,
                      "green",
                    ],
                    [
                      scope === "nodes" ? "离线" : "未就绪",
                      rows.filter((r) => r.ready === false).length,
                      "orange",
                    ],
                    [
                      "未知",
                      rows.filter((r) => r.ready === null).length,
                      "gray",
                    ],
                  ].map(([label, count, color]) => (
                    <div key={label}>
                      <span>
                        <i className={String(color)} />
                        {label}
                      </span>
                      <b>{count}</b>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
          <section className="panel resource-panel">
            <div className="panel-heading resource-heading">
              <div className="list-title">
                <h2>{scope === "nodes" ? "Node" : "Pod"} 列表</h2>
                <span className="count-pill">{filtered.length}</span>
              </div>
              <div className="filters">
                {scope === "pods" && (
                  <select
                    aria-label="命名空间"
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                  >
                    <option value="">全部命名空间</option>
                    {[...new Set(rows.map((r) => r.namespace))]
                      .sort()
                      .map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                  </select>
                )}
                <div className="search">
                  <Search size={15} />
                  <input
                    placeholder={`搜索 ${scope === "nodes" ? "Node" : "Pod"} 名称…`}
                    aria-label="搜索资源"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      {scope === "nodes" ? "节点名称 / Instance" : "Pod 名称"}
                    </th>
                    {scope === "pods" && <th>命名空间</th>}
                    <th>状态</th>
                    <th>CPU {scope === "nodes" ? "使用率" : "核数"}</th>
                    <th>内存{scope === "nodes" ? "使用率" : ""}</th>
                    <th>
                      网络接收 <span>↓</span>
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={`${r.namespace}/${r.name}`}>
                      <td>
                        <span className="resource-name">
                          <span className="resource-icon">
                            {scope === "nodes" ? (
                              <Server size={15} />
                            ) : (
                              <Boxes size={15} />
                            )}
                          </span>
                          {r.name}
                        </span>
                      </td>
                      {scope === "pods" && (
                        <td>
                          <span className="namespace">{r.namespace}</span>
                        </td>
                      )}
                      <td>
                        <span
                          className={`badge ${r.ready === true ? "ready" : r.ready === false ? "warning" : "unknown"}`}
                        >
                          {r.ready === true ? (
                            <Check size={11} />
                          ) : r.ready === false ? (
                            <TriangleAlert size={11} />
                          ) : null}
                          {r.ready === null
                            ? "未知"
                            : scope === "nodes"
                              ? r.ready
                                ? "在线"
                                : "离线"
                              : r.ready
                                ? "Ready"
                                : "Not Ready"}
                        </span>
                      </td>
                      <td>
                        <Meter
                          value={r.cpu}
                          percent={scope === "nodes"}
                          format={(v) =>
                            scope === "nodes"
                              ? `${v.toFixed(1)}%`
                              : v.toFixed(3)
                          }
                        />
                      </td>
                      <td>
                        <Meter
                          value={r.memory}
                          percent={scope === "nodes"}
                          format={(v) =>
                            scope === "nodes" ? `${v.toFixed(1)}%` : bytes(v)
                          }
                        />
                      </td>
                      <td className="network-value">
                        {r.network === null ? "—" : `${bytes(r.network)}/s`}
                      </td>
                      <td><a className="detail-link" href={scope === "nodes" ? `/nodes/${encodeURIComponent(r.name)}` : `/pods/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`}>查看详情</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filtered.length && (
                <div className="empty">
                  {loading
                    ? "正在查询 Prometheus…"
                    : error
                      ? "连接数据源后显示资源"
                      : "没有匹配的资源，请检查筛选条件或指标采集配置。"}
                </div>
              )}
            </div>
            <div className="table-footer">
              <span>
                显示 {filtered.length} / {rows.length} 个资源
              </span>
              <span>
                <span className="status-dot" /> 数据由 Prometheus 提供
              </span>
            </div>
          </section>
          <footer>
            <span>
              <CircleHelp size={13} /> Node 依赖 node-exporter；Pod 依赖
              kubelet/cAdvisor 与 kube-state-metrics。
            </span>
            <span>
              {data
                ? `更新于 ${new Date(data.updatedAt).toLocaleTimeString("zh-CN")}`
                : "等待监控数据"}
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function Stat({
  title,
  value,
  unit,
  icon,
  footer,
  warning = false,
}: {
  title: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
  footer: string;
  warning?: boolean;
}) {
  return (
    <section className={`stat ${warning ? "warn-stat" : ""}`}>
      <div className="stat-top">
        <span>{title}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <div className="stat-value">
        {value}
        <span>{unit}</span>
      </div>
      <div className="stat-footer">
        {warning ? <TriangleAlert size={12} /> : <span className="tiny-dot" />}
        {footer}
      </div>
    </section>
  );
}
function Meter({
  value,
  percent,
  format,
}: {
  value: number | null;
  percent: boolean;
  format: (v: number) => string;
}) {
  return (
    <div className="meter-cell">
      <span>{value === null ? "—" : format(value)}</span>
      {percent && value !== null && (
        <div className="meter">
          <i
            style={{
              width: `${Math.min(100, Math.max(0, value))}%`,
              background:
                value > 80 ? "#f59e0b" : value > 65 ? "#60a5fa" : "#14b8a6",
            }}
          />
        </div>
      )}
    </div>
  );
}
