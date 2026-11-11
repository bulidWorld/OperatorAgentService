import { NextRequest, NextResponse } from "next/server";
import { errorLog, withAccessLog } from "@/lib/logger";
import { getStoredAlerts, syncKubernetesEvents } from "@/lib/kubernetes-events";
import type { operations } from "@/generated/api.types";

type AlertsResponse = operations["getAlerts"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["getAlerts"]["responses"][400]["content"]["application/json"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 查询统一数据库中的告警，并可在刷新请求中先同步 Kubernetes Events。
 * @param request 可选 refresh=true 查询参数。
 * @returns 数据库中的 Alertmanager 告警和 Kubernetes Events。
 */
export async function GET(request: NextRequest) {
  return withAccessLog(request, "统一告警查询", () => handleGet(request));
}

async function handleGet(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const refreshValue = params.get("refresh");
  if (refreshValue !== null && refreshValue !== "true" && refreshValue !== "false")
    return NextResponse.json({ error: "refresh 只能是 true 或 false" } satisfies ErrorResponse, { status: 400 });
  const rawLimit = params.get("limit") ?? "100";
  const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    return NextResponse.json({ error: "limit 必须是 1 到 500 的整数" } satisfies ErrorResponse, { status: 400 });
  const cursor = params.get("cursor") || undefined;
  const refresh = refreshValue === "true";
  try {
    let synchronizedEvents: number | null = null;
    if (refresh) {
      synchronizedEvents = await syncKubernetesEvents(true);
      if (synchronizedEvents === null)
        return NextResponse.json({ error: "等待其他实例完成事件同步超时" } satisfies ErrorResponse, { status: 502 });
    }
    const page = await getStoredAlerts(limit, cursor);
    return NextResponse.json({
      source: "database",
      refreshed: refresh,
      synchronizedEvents,
      ...page,
    } satisfies AlertsResponse);
  } catch (error) {
    errorLog("alerts.query.failed", error, { refresh, description: "统一告警查询失败" });
    const invalidCursor = error instanceof Error && error.message.includes("分页游标无效");
    return NextResponse.json({
      error: error instanceof Error ? error.message : "告警查询失败",
    } satisfies ErrorResponse, { status: invalidCursor ? 400 : refresh ? 502 : 500 });
  }
}
