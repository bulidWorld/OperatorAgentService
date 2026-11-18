import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { beginHttpLog } from "./logger";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

type PodList = {
  items?: Array<{
    metadata?: { name?: string; namespace?: string };
    status?: { phase?: string };
    spec?: { containers?: Array<{ name?: string }> };
  }>;
};

/** 查询集群全部 Pod，可选按容器名称子串过滤。 */
export async function getPods(input: { containerName?: string }) {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
  ]);
  const path = "/api/v1/pods";
  const finishLog = beginHttpLog({ method: "GET", path, operation: "Kubernetes Pod 列表查询" });
  const result = await new Promise<PodList>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path, method: "GET", ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        const body = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) {
          const error = new Error(`Kubernetes Pod 列表 API 返回 HTTP ${status}: ${body.slice(0, 500)}`);
          finishLog(status, error);
          return reject(error);
        }
        try { finishLog(status); resolve(JSON.parse(body) as PodList); }
        catch { const error = new Error("Kubernetes API 返回了无效 JSON"); finishLog(status, error); reject(error); }
      });
      response.on("error", error => { finishLog(response.statusCode, error); reject(error); });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes API 请求超时")));
    req.on("error", error => { finishLog(undefined, error); reject(error); });
    req.end();
  });

  const needle = input.containerName?.trim().toLocaleLowerCase();
  const pods = (result.items ?? []).flatMap(item => {
    const containers = (item.spec?.containers ?? []).map(container => container.name ?? "");
    if (needle && !containers.some(name => name.toLocaleLowerCase().includes(needle))) return [];
    if (!item.metadata?.name || !item.metadata.namespace) return [];
    return [{ namespace: item.metadata.namespace, name: item.metadata.name, phase: item.status?.phase ?? "Unknown", containers }];
  });
  return { total: pods.length, pods };
}
