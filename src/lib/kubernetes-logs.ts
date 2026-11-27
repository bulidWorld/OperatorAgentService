import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { beginHttpLog } from "./logger";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * 使用 Pod 的 ServiceAccount 凭证读取指定容器的近期日志。
 * @param input.namespace Kubernetes 命名空间。
 * @param input.pod Pod 名称。
 * @param input.container 可选的容器名称。
 * @param input.sinceMinutes 查询最近多少分钟的日志。
 * @param input.tailLines 返回的最大日志行数。
 * @returns 命名空间、Pod、容器、日志文本及是否发生截断。
 * @throws 参数无效、凭证缺失、请求超时或 Kubernetes API 返回错误时抛出异常。
 */
export async function getPodLogs(input: {
  namespace: string;
  pod: string;
  container?: string;
  sinceMinutes?: number;
  tailLines?: number;
}) {
  const { namespace, pod, container } = input;
  if (![namespace, pod, container].filter(Boolean).every(value => /^[a-zA-Z0-9_.-]+$/.test(value!)))
    throw new Error("namespace、pod 或 container 参数格式无效");
  const tailLines = input.tailLines ?? 300;
  const sinceMinutes = input.sinceMinutes ?? 60;
  if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > 5000) throw new Error("tailLines 须为 1 到 5000 的整数");
  if (!Number.isInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 10080) throw new Error("sinceMinutes 须为 1 到 10080 的整数");

  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
  ]);
  const query = new URLSearchParams({ timestamps: "true", tailLines: String(tailLines), sinceSeconds: String(sinceMinutes * 60) });
  if (container) query.set("container", container);
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query}`;
  const finishLog = beginHttpLog({
    method: "GET",
    path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`,
    operation: "Kubernetes Pod 日志查询",
    namespace,
    pod,
  });
  return new Promise<{ namespace: string; pod: string; container?: string; logs: string; truncated: boolean }>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path, method: "GET", ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" } }, response => {
      const status = response.statusCode ?? 500;
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 128 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) {
          const detail = parseKubernetesError(body);
          const error = Object.assign(
            new Error(detail ?? `Kubernetes 日志 API 返回 HTTP ${status}`),
            {
              code:
                status === 404 || detail?.startsWith("Pod 或容器不存在：")
                  ? "POD_NOT_FOUND"
                  : "UPSTREAM_ERROR",
            },
          );
          finishLog(status, error);
          return reject(error);
        }
        finishLog(status);
        resolve({ namespace, pod, container, logs: body, truncated: size > 128 * 1024 });
      });
      response.on("error", error => {
        finishLog(status, error);
        reject(error);
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes 日志请求超时")));
    req.on("error", error => {
      finishLog(undefined, error);
      reject(error);
    });
    req.end();
  });
}

/**
 * 从 Kubernetes API 响应中提取可读错误信息，避免直接回显任意响应体。
 * @param body API 返回的响应文本。
 * @returns 转换后的错误说明；无法解析时返回 undefined。
 */
function parseKubernetesError(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return undefined;
    const status = parsed as { reason?: unknown; message?: unknown };
    if (typeof status.message !== "string") return undefined;
    if (status.reason === "NotFound") return `Pod 或容器不存在：${status.message}`;
    return `Kubernetes 日志查询失败：${status.message}`;
  } catch {
    return undefined;
  }
}
