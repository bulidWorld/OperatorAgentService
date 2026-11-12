import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Read recent logs for a specific Kubernetes container using the pod's ServiceAccount. */
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
  return new Promise<{ namespace: string; pod: string; container?: string; logs: string; truncated: boolean }>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path, method: "GET", ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "text/plain" } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 128 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        const body = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) return reject(new Error(`Kubernetes 日志 API 返回 HTTP ${status}: ${body.slice(0, 500)}`));
        resolve({ namespace, pod, container, logs: body, truncated: size > 128 * 1024 });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes 日志请求超时")));
    req.on("error", reject);
    req.end();
  });
}
