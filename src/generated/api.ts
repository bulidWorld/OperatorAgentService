/** Handwritten browser client. Regenerate api.types.ts from OpenAPI; keep this file as the runtime call layer. */
import type { operations } from "./api.types";

type MonitorQuery = NonNullable<operations["getMonitor"]["parameters"]["query"]>;
type MonitorResponse = operations["getMonitor"]["responses"][200]["content"]["application/json"];
type NodeStatusResponse = operations["getNodeStatus"]["responses"][200]["content"]["application/json"];
type AlertsResponse = operations["getAlerts"]["responses"][200]["content"]["application/json"];
type ApiError = operations["getMonitor"]["responses"][400]["content"]["application/json"];

/** 发送 GET 请求、解析 JSON 并将服务端错误转换成 Error。
 * @param path 本服务 API 的相对路径，可包含查询参数。
 * @param signal 可选的 AbortSignal，用于取消浏览器请求。
 * @returns 解析后的响应对象；类型由调用方依据 OpenAPI 契约指定。
 * @throws 响应非 JSON 或 HTTP 状态码非 2xx 时抛出错误。
 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`接口返回非 JSON 响应（HTTP ${response.status}），请检查服务或代理配置。`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body &&
      typeof (body as ApiError).error === "string"
      ? (body as ApiError).error
      : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  // The route validates inputs and its response is checked against generated
  // OpenAPI types at compile time. This cast does not validate JSON at runtime.
  return body as T;
}

/** 请求 Node/Pod 监控聚合数据。
 * @param query 面板资源类型、时间范围和采样间隔。
 * @param signal 可选的 AbortSignal，用于组件卸载或请求超时时取消请求。
 * @returns Dashboard 契约响应。
 * @throws 请求失败或服务端返回错误时抛出错误。
 * @remarks 调用链：Dashboard.useEffect → getMonitor → getJson → fetch →
 * `/api/monitor` GET → getDashboard → Prometheus HTTP API → 页面状态更新。
 */
export function getMonitor(query: MonitorQuery, signal?: AbortSignal): Promise<MonitorResponse> {
  const params = new URLSearchParams();
  if (query.scope) params.set("scope", query.scope);
  if (query.minutes !== undefined) params.set("minutes", String(query.minutes));
  if (query.step) params.set("step", query.step);
  return getJson<MonitorResponse>(`/api/monitor?${params}`, signal);
}

/** 请求节点可用状态映射。
 * @param signal 可选的 AbortSignal，用于停止轮询中的请求。
 * @returns 节点状态映射；演示模式下 statuses 为 null。
 * @throws 请求失败或服务端返回错误时抛出错误。
 * @remarks 调用链：Dashboard 节点轮询 → getNodeStatus → getJson → fetch →
 * `/api/node-status` GET → 可用性与节点清单查询 → 页面 nodeStatuses 状态。
 */
export function getNodeStatus(signal?: AbortSignal): Promise<NodeStatusResponse> {
  return getJson<NodeStatusResponse>("/api/node-status", signal);
}

/** 请求当前资源告警列表。
 * @param signal 可选的 AbortSignal，用于取消当前请求。
 * @returns 告警列表和数据来源。
 * @throws 请求失败或服务端返回错误时抛出错误。
 * @remarks 调用链：AlertsPage.load → getAlerts → getJson → fetch →
 * `/api/alerts` GET → PostgreSQL 统一告警表；refresh=true 时先同步 Kubernetes Events。
 */
export function getAlerts(refresh = false, cursor?: string, signal?: AbortSignal): Promise<AlertsResponse> {
  const params = new URLSearchParams();
  if (refresh) params.set("refresh", "true");
  if (cursor) params.set("cursor", cursor);
  return getJson<AlertsResponse>(`/api/alerts${params.size ? `?${params}` : ""}`, signal);
}
