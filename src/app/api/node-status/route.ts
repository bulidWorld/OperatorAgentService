import { NextResponse } from "next/server";
import { errorLog, withAccessLog } from "@/lib/logger";
import { getNodeAvailability, getNodeInventory } from "@/lib/prometheus/business";
import type { operations } from "@/generated/api.types";
type NodeStatusResponse = operations["getNodeStatus"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["getNodeStatus"]["responses"][502]["content"]["application/json"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 返回节点名称到可用状态的映射。
 * @returns DEMO_MODE 下返回 null；实时模式并发查询状态与节点清单，失败返回 502。
 */
export async function GET(request: Request) {
  return withAccessLog(request, "Node状态查询", handleGet);
}

async function handleGet() {
  try {
    if (process.env.DEMO_MODE === "true") return NextResponse.json({ statuses: null } satisfies NodeStatusResponse);
    const [availability, inventory] = await Promise.all([getNodeAvailability(), getNodeInventory()]);
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
    return NextResponse.json({ statuses } satisfies NodeStatusResponse);
  } catch (error) {
    errorLog("node.status.failed", error, { description: "Node状态查询失败" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Node 状态查询失败" } satisfies ErrorResponse, { status: 502 });
  }
}
