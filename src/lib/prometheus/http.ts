import { randomUUID } from "node:crypto";
import { errorLog, httpLog } from "../logger";
/** One exported function per Prometheus HTTP endpoint. Server-side only. */
export type Sample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
};
export type QueryResult = { resultType: string; result: Sample[] };
export type Alert = {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt?: string;
  value: string;
};
async function request<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const base = process.env.PROMETHEUS_URL;
  if (!base)
    throw new Error(
      "请配置服务端 PROMETHEUS_URL，或设置 DEMO_MODE=true 体验演示。",
    );
  const url = new URL(`${base.replace(/\/$/, "")}/api/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) url.searchParams.set(k, String(v));
  });
  const requestId = randomUUID();
  const calledAt = new Date().toISOString();
  const started = performance.now();
  // Only log our explicit endpoint parameters; never log credentials or headers.
  const endpoint = new URL(url);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  const operations: Record<string, string> = {
    query: "Prometheus即时指标查询", query_range: "Prometheus历史趋势查询",
    alerts: "Prometheus告警查询", rules: "Prometheus规则查询", targets: "Prometheus采集目标查询",
    labels: "Prometheus标签查询", metadata: "Prometheus指标元数据查询", series: "Prometheus时间序列查询",
  };
  const context = {
    requestId, direction: "outbound", method: "GET", url: endpoint.toString(), calledAt,
    operation: operations[path] || "Prometheus标签值查询", requestParams: params,
  };
  httpLog("request.started", context);
  let status: number | undefined;
  let result = "error";
  let errorMessage: string | undefined;
  let resultSummary: Record<string, unknown> | undefined;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: process.env.PROMETHEUS_TOKEN
        ? { Authorization: `Bearer ${process.env.PROMETHEUS_TOKEN}` }
        : {},
    });
    status = response.status;
    if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== "success")
      throw new Error(body.error || "Prometheus 查询失败");
    const data = body.data;
    resultSummary = {
      apiStatus: body.status, resultType: data?.resultType,
      itemCount: Array.isArray(data) ? data.length
        : Array.isArray(data?.result) ? data.result.length
        : Array.isArray(data?.alerts) ? data.alerts.length
        : undefined,
    };
    result = "success";
    return body.data as T;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    errorLog("prometheus.request.failed", error, context);
    throw error;
  } finally {
    httpLog("request.completed", {
      ...context, returnedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), status, result, resultSummary, errorMessage,
    });
  }
}
export function query(query: string, time?: number) {
  return request<QueryResult>("query", { query, time });
}
export function queryRange(
  query: string,
  start: number,
  end: number,
  step: number,
) {
  return request<QueryResult>("query_range", { query, start, end, step });
}
export function getAlerts() {
  return request<{ alerts: Alert[] }>("alerts");
}
export function getRules() {
  return request<{ groups: unknown[] }>("rules");
}
export function getTargets() {
  return request<{ activeTargets: unknown[]; droppedTargets: unknown[] }>(
    "targets",
  );
}
export function getLabels() {
  return request<string[]>("labels");
}
export function getLabelValues(label: string) {
  return request<string[]>(`label/${encodeURIComponent(label)}/values`);
}
export function getMetadata(metric?: string) {
  return request<Record<string, unknown[]>>("metadata", { metric });
}
export function getSeries(match: string, start?: number, end?: number) {
  return request<Record<string, string>[]>("series", {
    "match[]": match,
    start,
    end,
  });
}
