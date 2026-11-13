import { NextResponse } from "next/server";
import { errorLog, withAccessLog } from "@/lib/logger";
import { getNodeAvailability, getNodeInventory, getNodeCpuUsage, getNodeMemoryUsage, getNodeNetworkReceive, getPodAvailability, getPodCpuUsage, getPodMemoryUsage, getPodNetworkReceive, getPodRestarts24h, mergeResources, mergeNodeInventory, type Resource } from "@/lib/prometheus/business";
import type { operations } from "@/generated/api.types";
type NodeStatusResponse = operations["getNodeStatus"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["getNodeStatus"]["responses"][502]["content"]["application/json"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type LiveResources = { statuses: Record<string, boolean>; resources: Resource[] };
const statusCache = new Map<string, { expires: number; value: Promise<LiveResources> }>();

/** 返回节点名称到可用状态的映射。
 * @returns DEMO_MODE 下返回 null；实时模式并发查询状态与节点清单，失败返回 502。
 */
export async function GET(request: Request) {
  return withAccessLog(request, "资源状态查询", () => handleGet(request));
}

/** 查询 Prometheus 节点可用性并将状态关联到节点名称。
 * @returns 节点状态映射；演示模式返回 null，查询失败返回 502 响应。
 */
async function handleGet(request: Request) {
  try {
    if (process.env.DEMO_MODE === "true") return NextResponse.json({ statuses: null, resources: [] } satisfies NodeStatusResponse);
    const scope = new URL(request.url).searchParams.get("scope") === "pods" ? "pods" : "nodes";
    const cached = statusCache.get(scope);
    if (cached && cached.expires > Date.now()) return NextResponse.json(await cached.value satisfies NodeStatusResponse);
    const value = loadResources(scope);
    statusCache.set(scope, { expires: Date.now() + 5000, value });
    void value.catch(() => { if (statusCache.get(scope)?.value === value) statusCache.delete(scope); });
    return NextResponse.json(await value satisfies NodeStatusResponse);
  } catch (error) {
    errorLog("node.status.failed", error, { description: "资源状态查询失败" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "资源状态查询失败" } satisfies ErrorResponse, { status: 502 });
  }
}

async function loadResources(scope: "nodes" | "pods"): Promise<LiveResources> {
  if (scope === "pods") {
    const [cpu, memory, network, availability, restarts] = await Promise.all([getPodCpuUsage(), getPodMemoryUsage(), getPodNetworkReceive(), getPodAvailability(), getPodRestarts24h()]);
    const resources = mergeResources("pods", [cpu.result, memory.result, network.result, availability.result]);
    const restartCounts = new Map(restarts.result.map((sample) => [JSON.stringify([sample.metric.namespace || "", sample.metric.pod || ""]), Number(sample.value?.[1]) || 0]));
    return {
      statuses: Object.fromEntries(resources.map((row) => [JSON.stringify([row.namespace, row.name]), row.ready === true])),
      resources: resources.map((row) => ({ ...row, restarts24h: restartCounts.get(JSON.stringify([row.namespace, row.name])) ?? null })),
    };
  }
    const [cpu, memory, network, availability, inventory] = await Promise.all([getNodeCpuUsage(), getNodeMemoryUsage(), getNodeNetworkReceive(), getNodeAvailability(), getNodeInventory()]);
    const statuses: Record<string, boolean> = {};
    for (const sample of availability.result) {
      const instance = sample.metric.instance;
      const value = Number(sample.value?.[1]);
      if (instance && sample.value && Number.isFinite(value)) statuses[instance] = value === 1;
    }
    for (const node of inventory.result) {
      const name = node.metric.node;
      const ip = node.metric.internal_ip;
      if (!name) continue;
      const match = availability.result.find((sample) => {
        const host = sample.metric.instance?.replace(/:\d+$/, "");
        return host === name || (!!ip && host === ip);
      });
      if (match?.value && Number.isFinite(Number(match.value[1]))) statuses[name] = Number(match.value[1]) === 1;
    }
    return { statuses, resources: mergeNodeInventory(mergeResources("nodes", [cpu.result, memory.result, network.result, []]), inventory.result, availability.result) };
}
