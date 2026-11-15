import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { beginHttpLog } from "./logger";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * 校验 Pod 定位参数并读取集群内 Kubernetes API 连接信息。
 * @param input.namespace Kubernetes 命名空间。
 * @param input.pod Pod 名称。
 * @returns 标准化的名称、API 主机名和端口。
 * @throws 命名空间或 Pod 名称无效，或未检测到集群 API 地址时抛出错误。
 */
function target(input: { namespace: string; pod: string }) {
  const namespace = input.namespace.trim();
  const pod = input.pod.trim();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new Error("namespace 格式无效");
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(pod)) throw new Error("Pod 名称格式无效");
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
  return { namespace, pod, hostname, port };
}

/**
 * 使用 ServiceAccount 凭证向 Kubernetes API 发送指定 Pod 的请求。
 * @param input.namespace Kubernetes 命名空间。
 * @param input.pod Pod 名称。
 * @param method 要发送的 HTTP 方法，仅支持 GET 和 DELETE。
 * @param body DELETE 请求体；GET 请求不传。
 * @returns 将成功响应 JSON 解析为 T 后返回；DELETE 有请求体时返回 undefined。
 * @throws Kubernetes 凭证读取失败、请求超时、API 返回非 2xx 或响应 JSON 无效时抛出错误。
 */
async function apiRequest<T>(input: { namespace: string; pod: string }, method: "GET" | "DELETE", body?: unknown) {
  const { namespace, pod, hostname, port } = target(input);
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`;
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
  ]);
  const finishLog = beginHttpLog({
    method,
    path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`,
    operation: method === "DELETE" ? "Kubernetes Pod 删除" : "Kubernetes Pod 查询",
    namespace,
    pod,
  });
  return new Promise<T>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path, method, ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json", "Content-Type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          const error = new Error(`Kubernetes Pod ${method} 失败，HTTP ${status}: ${Buffer.concat(chunks).toString("utf8").slice(0, 500)}`);
          finishLog(status, error);
          return reject(error);
        }
        try {
          const result = (body === undefined ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined) as T;
          finishLog(status);
          resolve(result);
        } catch {
          const error = new Error("Kubernetes API 返回了无效 JSON");
          finishLog(status, error);
          reject(error);
        }
      });
      response.on("error", error => {
        finishLog(response.statusCode, error);
        reject(error);
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes API 请求超时")));
    req.on("error", error => {
      finishLog(undefined, error);
      reject(error);
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * 读取指定 Pod 的 Kubernetes UID，供安全删除的 UID 前置条件使用。
 * @param input.namespace Kubernetes 命名空间。
 * @param input.pod Pod 名称。
 * @returns 当前 Pod 的 metadata.uid。
 * @throws Pod 不存在、API 请求失败或响应缺少 UID 时抛出错误。
 */
export async function getPodUid(input: { namespace: string; pod: string }) {
  const pod = await apiRequest<{ metadata?: { uid?: string } }>(input, "GET");
  if (!pod.metadata?.uid) throw new Error("Kubernetes Pod 缺少 metadata.uid");
  return pod.metadata.uid;
}

/**
 * 删除指定 UID 的 Pod，避免调用期间同名 Pod 重建导致误删新对象。
 * @param input.namespace Kubernetes 命名空间。
 * @param input.pod Pod 名称。
 * @param input.uid 调用前读取的 Pod UID，Kubernetes API 会将其作为删除前置条件。
 * @returns 删除结果，标记 Pod 已删除及控制器是否负责重建。
 * @throws Pod 参数或 UID 无效、Kubernetes API 拒绝删除、请求超时或 API 调用失败时抛出错误。
 */
export async function restartPod(input: { namespace: string; pod: string; uid: string }) {
  const { namespace, pod } = target(input);
  if (!input.uid) throw new Error("Pod UID 必填");
  await apiRequest(input, "DELETE", {
    apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background",
    preconditions: { uid: input.uid },
  });
  return { namespace, pod, deleted: true as const, replacement: "controller-dependent" as const };
}
