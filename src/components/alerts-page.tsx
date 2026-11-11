"use client";

import { Bell, Boxes, ChevronDown, Layers3, Radio, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getAlerts } from "@/generated/api";
import type { components } from "@/generated/api.types";

type AlertRow = components["schemas"]["AlertRow"];

/** 渲染统一告警页面，并每 30 秒从数据库刷新列表。
 * @returns 告警列表、数据源状态及错误提示组成的 React 页面。
 */
export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState("PostgreSQL");
  /** 请求最新告警并更新页面的加载、数据源和错误状态。
   * @returns 请求完成后结束加载状态；接口错误会保存到 error 状态。
   */
  const load = useCallback(async (syncEvents = false, cursor?: string, append = false) => {
    setLoading(true);
    try {
      const body = await getAlerts(syncEvents, cursor);
      setAlerts((current) => append ? [...current, ...body.alerts] : body.alerts);
      setNextCursor(body.nextCursor);
      setSource("PostgreSQL");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "告警查询失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [load]);
  return <div className="shell">
    <aside>
      <a className="brand" href="/"><span className="brand-icon"><Layers3 size={23} /></span>KubeScope<span className="brand-dot">•</span></a>
      <div className="workspace"><span className="workspace-icon">K</span><div><b>Kubernetes</b><small>Infrastructure workspace</small></div><ChevronDown size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>
        <a href="/?scope=nodes"><Server size={18} />Node 监控<span className="nav-count">↗</span></a>
        <a href="/?scope=pods"><Boxes size={18} />Pod 监控<span className="nav-count">↗</span></a>
        <a href="/alerts" className="selected" aria-current="page"><Bell size={18} />资源告警<span className="nav-count">{alerts.length}</span></a>
      </nav>
      <div className="side-bottom"><div className="source"><span className={`status-dot ${error ? "bad" : ""}`} /><div><b>{source}</b><small>{error ? "连接待检查" : "数据源已连接"}</small></div><Radio size={16} /></div></div>
    </aside>
    <main>
      <header><div className="breadcrumbs">工作空间 <span>/</span> 集群监控 <span>/</span><b>资源告警</b></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow">KUBERNETES OBSERVABILITY</div><h1>资源告警</h1><p>{source} 当前告警</p></div><button className="button" onClick={() => void load(true)} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />同步并刷新</button></div>
        {error && <div className="error" role="alert">{error}</div>}
        <section className="panel alert-list"><div className="panel-heading"><div className="list-title"><h2>告警列表</h2><span className="count-pill">{alerts.length}</span></div></div>
          <div className="table-wrap"><table><thead><tr><th>来源</th><th>告警类型</th><th>告警级别</th><th>对象类型</th><th>告警对象</th><th>告警描述</th><th>发生时间</th></tr></thead><tbody>{alerts.map((alert, index) => <tr key={`${alert.source}-${alert.name}-${alert.resource}-${alert.activeAt}-${index}`}><td>{alert.source === "kubernetes" ? "Kubernetes" : "Alertmanager"}</td><td>{alert.name}</td><td>{alert.severity}</td><td>{alert.objectType || "—"}</td><td>{alert.resource}</td><td className="alert-description">{alert.description}</td><td>{alert.activeAt ? new Date(alert.activeAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"}</td></tr>)}</tbody></table>{!alerts.length && <div className="empty">{loading ? "正在获取告警…" : error ? "告警数据暂不可用" : "暂无告警"}</div>}</div>
          {nextCursor && <div className="panel-heading"><button className="button" onClick={() => void load(false, nextCursor, true)} disabled={loading}>{loading ? "正在加载…" : "加载更多"}</button></div>}
        </section>
      </div>
    </main>
  </div>;
}
