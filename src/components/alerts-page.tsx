"use client";

import { Bell, Boxes, ChevronDown, Layers3, Radio, RefreshCw, Server, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { clearAlerts, getAlerts } from "@/generated/api";
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
  const [filters, setFilters] = useState({ source: "", alertType: "", severity: "", from: "", to: "" });
  const [draft, setDraft] = useState(filters);
  const [pageCursors, setPageCursors] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [clearing, setClearing] = useState(false);
  const [detailAlert, setDetailAlert] = useState<AlertRow | null>(null);
  /** 请求最新告警并更新页面的加载、数据源和错误状态。
   * @returns 请求完成后结束加载状态；接口错误会保存到 error 状态。
   */
  const load = useCallback(async (syncEvents = false, cursor?: string, append = false) => {
    setLoading(true);
    try {
      const body = await getAlerts(syncEvents, cursor, undefined, { ...filters, limit: pageSize });
      setAlerts((current) => append ? [...current, ...body.alerts] : body.alerts);
      setNextCursor(body.nextCursor);
      setSource("PostgreSQL");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "告警查询失败");
    } finally {
      setLoading(false);
    }
  }, [filters, pageSize]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(false, pageCursors[pageIndex]), 30000);
    return () => clearInterval(timer);
  }, [load, pageCursors, pageIndex]);
  useEffect(() => {
    if (!detailAlert) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setDetailAlert(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailAlert]);
  const applyFilters = () => { setFilters(draft); setPageCursors([]); setPageIndex(0); };
  const changeSize = (size: number) => { setPageSize(size); setPageCursors([]); setPageIndex(0); };
  const clearSelection = async () => {
    if (!selectedIds.length || !window.confirm(`确定手动清除选中的 ${selectedIds.length} 条告警？`)) return;
    setClearing(true);
    try { const result = await clearAlerts({ ids: selectedIds }); setSelectedIds([]); await load(); window.alert(`已将 ${result.cleared} 条告警标记为已解决（人工清除）`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "清除告警失败"); }
    finally { setClearing(false); }
  };
  const clearFiltered = async () => {
    if (!window.confirm("确定手动清除当前筛选条件匹配的全部告警？此操作会标记为已解决。")) return;
    setClearing(true);
    try { const result = await clearAlerts({ filters }); setSelectedIds([]); setPageCursors([]); setPageIndex(0); await load(); window.alert(`已将 ${result.cleared} 条告警标记为已解决（人工清除）`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "清除告警失败"); }
    finally { setClearing(false); }
  };
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
        <section className="panel alert-list"><div className="panel-heading"><div className="list-title"><h2>告警列表</h2><span className="count-pill">本页 {alerts.length} 条</span></div></div>
          <div className="alert-filters">
            <label>来源<select value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })}><option value="">全部来源</option><option value="kubernetes">Kubernetes</option><option value="alertmanager">Alertmanager</option></select></label>
            <label>告警类型<input value={draft.alertType} onChange={e => setDraft({ ...draft, alertType: e.target.value })} placeholder="输入类型" /></label>
            <label>告警级别<input value={draft.severity} onChange={e => setDraft({ ...draft, severity: e.target.value })} placeholder="如 warning / critical" /></label>
            <label>开始时间<input type="datetime-local" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
            <label>结束时间<input type="datetime-local" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
            <button className="button" onClick={applyFilters}>筛选</button><button className="button secondary" onClick={() => { const empty = { source: "", alertType: "", severity: "", from: "", to: "" }; setDraft(empty); setFilters(empty); setPageCursors([]); setPageIndex(0); }}>重置</button>
          </div>
          <div className="clear-actions"><button className="button" disabled={clearing || loading || !selectedIds.length} onClick={() => void clearSelection()}>手动清除选中（{selectedIds.length}）</button><button className="button danger" disabled={clearing || loading} onClick={() => void clearFiltered()}>手动清除当前筛选全部</button><span>自动清除及 Alertmanager 已解决由后台分别记录</span></div>
          <div className="table-wrap"><table><thead><tr><th className="alert-select"><input type="checkbox" aria-label="选择本页全部告警" checked={alerts.length > 0 && alerts.every(alert => selectedIds.includes(alert.id))} onChange={event => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...alerts.map(alert => alert.id)])] : selectedIds.filter(id => !alerts.some(alert => alert.id === id)))} /></th><th>来源</th><th>告警类型</th><th>告警级别</th><th>对象类型</th><th>告警对象</th><th>告警描述</th><th>发生时间</th></tr></thead><tbody>{alerts.map((alert) => <tr key={alert.id} onDoubleClick={() => setDetailAlert(alert)} title="双击查看告警详情"><td className="alert-select" onDoubleClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`选择告警 ${alert.name}`} checked={selectedIds.includes(alert.id)} onChange={event => setSelectedIds(event.target.checked ? [...selectedIds, alert.id] : selectedIds.filter(id => id !== alert.id))} /></td><td title={alert.source === "kubernetes" ? "Kubernetes" : "Alertmanager"}>{alert.source === "kubernetes" ? "Kubernetes" : "Alertmanager"}</td><td title={alert.name}>{alert.name}</td><td title={alert.severity}>{alert.severity}</td><td title={alert.objectType || "—"}>{alert.objectType || "—"}</td><td title={alert.resource}>{alert.resource}</td><td className="alert-description" title={alert.description}>{alert.description}</td><td title={alert.activeAt || "—"}>{alert.activeAt ? new Date(alert.activeAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"}</td></tr>)}</tbody></table>{!alerts.length && <div className="empty">{loading ? "正在获取告警…" : error ? "告警数据暂不可用" : "暂无告警"}</div>}</div>
          <div className="pagination"><label>每页<select value={pageSize} onChange={e => changeSize(Number(e.target.value))}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select>条</label><span>第 {pageIndex + 1} 页</span><button className="button secondary" disabled={loading || pageIndex === 0} onClick={() => { const next = pageIndex - 1; setPageIndex(next); void load(false, pageCursors[next]); }}>上一页</button><button className="button secondary" disabled={loading || !nextCursor} onClick={() => { const cursor = nextCursor!; const cursors = [...pageCursors]; cursors[pageIndex + 1] = cursor; setPageCursors(cursors); setPageIndex(pageIndex + 1); void load(false, cursor); }}>下一页</button></div>
        </section>
      </div>
    </main>
    {detailAlert && <div className="alert-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDetailAlert(null); }}><section className="alert-modal" role="dialog" aria-modal="true" aria-labelledby="alert-modal-title"><div className="alert-modal-heading"><div><span className="eyebrow">ALERT DETAILS</span><h2 id="alert-modal-title">告警详细内容</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setDetailAlert(null)}><X size={20} /></button></div><dl className="alert-detail-grid"><dt>来源</dt><dd>{detailAlert.source === "kubernetes" ? "Kubernetes" : "Alertmanager"}</dd><dt>告警类型</dt><dd>{detailAlert.name}</dd><dt>告警级别</dt><dd>{detailAlert.severity}</dd><dt>对象类型</dt><dd>{detailAlert.objectType || "—"}</dd><dt>告警对象</dt><dd>{detailAlert.resource}</dd><dt>发生时间</dt><dd>{detailAlert.activeAt ? new Date(detailAlert.activeAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"}</dd><dt>告警描述</dt><dd className="alert-detail-description">{detailAlert.description}</dd><dt>记录 ID</dt><dd>{detailAlert.id}</dd></dl></section></div>}
  </div>;
}
