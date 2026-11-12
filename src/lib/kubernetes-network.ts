import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const API_LIMIT = 250;
type KubeObject = Record<string, any>;

async function listResource(path: string) {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
  const [token, ca] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
  ]);
  const separator = path.includes("?") ? "&" : "?";
  const requestPath = `${path}${separator}limit=${API_LIMIT}`;
  return new Promise<{ items: KubeObject[]; truncated: boolean }>((resolve, reject) => {
    const req = httpsRequest({ hostname, port: Number(port), path: requestPath, method: "GET", ca,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 5 * 1024 * 1024) chunks.push(chunk); });
      response.on("end", () => {
        const status = response.statusCode ?? 500;
        const body = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) return reject(new Error(`Kubernetes 网络资源 API 返回 HTTP ${status}: ${body.slice(0, 500)}`));
        try {
          const data = JSON.parse(body) as { items?: KubeObject[]; metadata?: { continue?: string } };
          resolve({ items: Array.isArray(data.items) ? data.items : [], truncated: Boolean(data.metadata?.continue) || size > 5 * 1024 * 1024 });
        } catch { reject(new Error("Kubernetes API 返回了无效 JSON")); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Kubernetes 网络资源查询超时")));
    req.on("error", reject);
    req.end();
  });
}

function collection(base: string, namespace?: string) {
  return namespace ? `${base}/namespaces/${encodeURIComponent(namespace)}` : base;
}

function selectedBy(labels: Record<string, string> | undefined, selector: Record<string, string> | undefined) {
  return Boolean(selector && Object.entries(selector).every(([key, value]) => labels?.[key] === value));
}

/** Summarize Kubernetes service routing, endpoint, policy, pod and node readiness data. */
export async function queryKubernetesNetwork(input: { namespace?: string; service?: string }) {
  const namespace = input.namespace?.trim() || undefined;
  const serviceName = input.service?.trim() || undefined;
  if (namespace && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new Error("namespace 格式无效");
  if (serviceName && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceName)) throw new Error("service 名称格式无效");

  const nsPath = collection("/api/v1", namespace);
  const networkingPath = collection("/apis/networking.k8s.io/v1", namespace);
  const discoveryPath = collection("/apis/discovery.k8s.io/v1", namespace);
  const [serviceResult, sliceResult, policyResult, podResult, nodeResult] = await Promise.all([
    listResource(`${nsPath}/services`),
    listResource(`${discoveryPath}/endpointslices`),
    listResource(`${networkingPath}/networkpolicies`),
    listResource(`${nsPath}/pods`),
    namespace ? Promise.resolve({ items: [] as KubeObject[], truncated: false }) : listResource("/api/v1/nodes"),
  ]);
  const services = serviceResult.items.filter(item => !serviceName || item.metadata?.name === serviceName);
  const pods = podResult.items;
  const endpointSlices = sliceResult.items;

  const serviceSummaries = services.slice(0, 100).map(service => {
    const name = service.metadata?.name ?? "unknown";
    const ns = service.metadata?.namespace ?? namespace;
    const selector = service.spec?.selector ?? {};
    const selectedPods = pods.filter(pod => pod.metadata?.namespace === ns && selectedBy(pod.metadata?.labels, selector));
    const slices = endpointSlices.filter(slice => slice.metadata?.labels?.["kubernetes.io/service-name"] === name);
    const endpoints = slices.flatMap(slice => (slice.endpoints ?? []).map((endpoint: KubeObject) => ({
      addresses: endpoint.addresses ?? [], ready: endpoint.conditions?.ready ?? null,
      serving: endpoint.conditions?.serving ?? null, terminating: endpoint.conditions?.terminating ?? null,
      target: endpoint.targetRef ? `${endpoint.targetRef.kind ?? ""}/${endpoint.targetRef.name ?? ""}` : null,
    })));
    return {
      namespace: ns, name, type: service.spec?.type ?? "ClusterIP", clusterIP: service.spec?.clusterIP ?? null,
      externalName: service.spec?.externalName ?? null, selector,
      ports: (service.spec?.ports ?? []).map((p: KubeObject) => ({ name: p.name, protocol: p.protocol, port: p.port, targetPort: p.targetPort, nodePort: p.nodePort })),
      selectedPods: selectedPods.map(pod => ({
        name: pod.metadata?.name, phase: pod.status?.phase,
        ready: (pod.status?.conditions ?? []).some((condition: KubeObject) => condition.type === "Ready" && condition.status === "True"),
        podIP: pod.status?.podIP ?? null, nodeName: pod.spec?.nodeName ?? null,
      })),
      endpointSliceCount: slices.length,
      readyEndpointCount: endpoints.filter((endpoint: KubeObject) => endpoint.ready === true).length,
      endpoints: endpoints.slice(0, 300),
      diagnosisSignals: [
        ...(Object.keys(selector).length && selectedPods.length === 0 ? ["selector 未匹配到 Pod"] : []),
        ...(selectedPods.length > 0 && selectedPods.every(pod => !(pod.status?.conditions ?? []).some((condition: KubeObject) => condition.type === "Ready" && condition.status === "True")) ? ["匹配到的 Pod 均未 Ready"] : []),
        ...(Object.keys(selector).length && endpoints.length === 0 ? ["没有发现 EndpointSlice 后端地址"] : []),
        ...(endpoints.length > 0 && !endpoints.some((endpoint: KubeObject) => endpoint.ready === true) ? ["EndpointSlice 中没有 Ready 后端"] : []),
      ],
    };
  });

  const networkPolicies = policyResult.items.slice(0, 200).map(policy => ({
    namespace: policy.metadata?.namespace, name: policy.metadata?.name,
    podSelector: policy.spec?.podSelector ?? {},
    policyTypes: policy.spec?.policyTypes ?? [],
    ingressRules: policy.spec?.ingress ?? [], egressRules: policy.spec?.egress ?? [],
  }));
  const nodes = nodeResult.items.slice(0, 250).map(node => ({
    name: node.metadata?.name,
    ready: (node.status?.conditions ?? []).find((condition: KubeObject) => condition.type === "Ready")?.status ?? "Unknown",
    networkUnavailable: (node.status?.conditions ?? []).find((condition: KubeObject) => condition.type === "NetworkUnavailable")?.status ?? null,
    podCIDR: node.spec?.podCIDR ?? null,
  }));

  return {
    scope: { namespace: namespace ?? "all namespaces", service: serviceName ?? "all services" },
    totals: { services: serviceResult.items.length, endpointSlices: sliceResult.items.length, networkPolicies: policyResult.items.length, pods: podResult.items.length, nodes: nodeResult.items.length },
    services: serviceSummaries,
    networkPolicies,
    nodes,
    truncated: {
      services: serviceResult.truncated || services.length > 100,
      endpointSlices: sliceResult.truncated,
      networkPolicies: policyResult.truncated || policyResult.items.length > 200,
      pods: podResult.truncated,
      nodes: nodeResult.truncated || nodeResult.items.length > 250,
    },
    limitation: "这是 Kubernetes API 配置与状态快照，不会在 Pod 网络命名空间内执行 ping、curl 或 TCP 探测。NetworkPolicy 规则表示可能的流量约束，不单独证明具体数据包已被阻断。",
  };
}
