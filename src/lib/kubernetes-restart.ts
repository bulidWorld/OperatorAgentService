import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Delete exactly one approved Pod; its owning controller may create a replacement. */
export async function restartPod(input: { namespace: string; pod: string }) {
  const namespace = input.namespace.trim();
  const pod = input.pod.trim();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new Error("namespace 格式无效");
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(pod)) throw new Error("Pod 名称格式无效");
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
  ]);
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}`;
  return new Promise<{ namespace: string; pod: string; deleted: true; replacement: "controller-dependent" }>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path, method: "DELETE", ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json", "Content-Type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) return reject(new Error(`Kubernetes 删除 Pod 失败，HTTP ${status}: ${Buffer.concat(chunks).toString("utf8").slice(0, 500)}`));
        resolve({ namespace, pod, deleted: true, replacement: "controller-dependent" });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes API 请求超时")));
    req.on("error", reject);
    req.end(JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" }));
  });
}
