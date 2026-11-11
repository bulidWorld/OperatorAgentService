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
/** 发送 Prometheus HTTP API 请求，并统一处理认证、超时、错误和出站日志。
 * @param path `/api/v1/` 下的 Prometheus API 路径。
 * @param params 要编码为查询参数的键值映射；undefined 值会被忽略。
 * @returns Prometheus 响应中的 data 字段，类型由调用方指定。
 * @throws 未配置数据源、HTTP/API 请求失败或请求超时时抛出错误。
 */
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
/** 执行 Prometheus 即时查询。
 * @param query PromQL 查询表达式。
 * @param time 可选的查询时间戳，单位为 Unix 秒。
 * @returns 即时查询的结果类型和样本列表。
 */
export function query(query: string, time?: number) {
  return request<QueryResult>("query", { query, time });
}
/** 执行 Prometheus 历史区间查询。
 * @param query PromQL 查询表达式。
 * @param start 查询开始时间，Unix 秒。
 * @param end 查询结束时间，Unix 秒。
 * @param step 相邻采样点的间隔，单位为秒。
 * @returns 区间查询的结果类型和样本列表。
 */
export function queryRange(
  query: string,
  start: number,
  end: number,
  step: number,
) {
  return request<QueryResult>("query_range", { query, start, end, step });
}
/** 查询 Prometheus 当前告警。
 * @returns 告警数组。
 */
export function getAlerts() {
  return request<{ alerts: Alert[] }>("alerts");
}
/** 查询 Prometheus 告警规则组。
 * @returns 规则组数据；上游结构暂以 unknown 表示。
 */
export function getRules() {
  return request<{ groups: unknown[] }>("rules");
}
/** 查询 Prometheus 活动和已丢弃的抓取目标。
 * @returns 活动目标及已丢弃目标数组。
 */
export function getTargets() {
  return request<{ activeTargets: unknown[]; droppedTargets: unknown[] }>(
    "targets",
  );
}
/** 查询 Prometheus 已知标签名称。
 * @returns 标签名称数组。
 */
export function getLabels() {
  return request<string[]>("labels");
}
/** 查询一个标签下的所有可用值。
 * @param label 标签名称，会在构造 URL 路径前进行编码。
 * @returns 标签值数组。
 */
export function getLabelValues(label: string) {
  return request<string[]>(`label/${encodeURIComponent(label)}/values`);
}
/** 查询 Prometheus 指标元数据。
 * @param metric 可选的指标名过滤条件。
 * @returns 按指标名组织的元数据记录。
 */
export function getMetadata(metric?: string) {
  return request<Record<string, unknown[]>>("metadata", { metric });
}
/** 按标签匹配表达式查询时间序列。
 * @param match Prometheus series 匹配表达式。
 * @param start 可选的查询起始时间，Unix 秒。
 * @param end 可选的查询结束时间，Unix 秒。
 * @returns 匹配的时间序列标签集。
 */
export function getSeries(match: string, start?: number, end?: number) {
  return request<Record<string, string>[]>("series", {
    "match[]": match,
    start,
    end,
  });
}
