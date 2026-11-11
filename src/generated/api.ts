import type { operations } from "./api.types";

type MonitorQuery = NonNullable<operations["getMonitor"]["parameters"]["query"]>;
type MonitorResponse = operations["getMonitor"]["responses"][200]["content"]["application/json"];
type NodeStatusResponse = operations["getNodeStatus"]["responses"][200]["content"]["application/json"];
type AlertsResponse = operations["getAlerts"]["responses"][200]["content"]["application/json"];
type ApiError = operations["getMonitor"]["responses"][400]["content"]["application/json"];

/**
 * Browser request path:
 * component -> getMonitor/getNodeStatus/getAlerts -> getJson -> fetch
 * -> Next.js route -> business service -> Prometheus or PostgreSQL
 * -> NextResponse.json -> getJson -> component state.
 *
 * The Alertmanager webhook is called by Alertmanager, not by this browser client.
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

export function getMonitor(query: MonitorQuery, signal?: AbortSignal): Promise<MonitorResponse> {
  const params = new URLSearchParams();
  if (query.scope) params.set("scope", query.scope);
  if (query.minutes !== undefined) params.set("minutes", String(query.minutes));
  if (query.step) params.set("step", query.step);
  return getJson<MonitorResponse>(`/api/monitor?${params}`, signal);
}

export function getNodeStatus(signal?: AbortSignal): Promise<NodeStatusResponse> {
  return getJson<NodeStatusResponse>("/api/node-status", signal);
}

export function getAlerts(signal?: AbortSignal): Promise<AlertsResponse> {
  return getJson<AlertsResponse>("/api/alerts", signal);
}
