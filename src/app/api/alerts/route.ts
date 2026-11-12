import { NextRequest, NextResponse } from "next/server";
import { errorLog, withAccessLog } from "@/lib/logger";
import { clearStoredAlerts, getStoredAlerts, syncKubernetesEvents } from "@/lib/kubernetes-events";
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

/** 清除选中的告警或匹配筛选条件的告警。 */
export async function DELETE(request: NextRequest) {
  return withAccessLog(request, "清除资源告警", async () => {
    try {
      const body = await request.json() as Record<string, unknown>;
      if (Array.isArray(body.ids)) {
        if (!body.ids.length || body.ids.some(id => !Number.isSafeInteger(id) || (id as number) < 1))
          return NextResponse.json({ error: "ids 必须是非空正整数数组" }, { status: 400 });
        const count = await clearStoredAlerts(body.ids as number[]);
        return NextResponse.json({ cleared: count });
      }
      const filters = body.filters as Record<string, unknown> | undefined;
      if (!filters || typeof filters !== "object")
        return NextResponse.json({ error: "请提供 ids 或 filters" }, { status: 400 });
      const source = typeof filters.source === "string" && filters.source ? filters.source : undefined;
      const alertType = typeof filters.alertType === "string" && filters.alertType ? filters.alertType : undefined;
      const severity = typeof filters.severity === "string" && filters.severity ? filters.severity : undefined;
      const from = typeof filters.from === "string" && filters.from ? filters.from : undefined;
      const to = typeof filters.to === "string" && filters.to ? filters.to : undefined;
      if (source && !["alertmanager", "kubernetes"].includes(source)) return NextResponse.json({ error: "source 无效" }, { status: 400 });
      if ([from, to].some(value => value && !Number.isFinite(Date.parse(value)))) return NextResponse.json({ error: "时间范围无效" }, { status: 400 });
      if (from && to && Date.parse(from) > Date.parse(to)) return NextResponse.json({ error: "开始时间不能晚于结束时间" }, { status: 400 });
      const count = await clearStoredAlerts(undefined, { source, alertType, severity, from, to });
      return NextResponse.json({ cleared: count });
    } catch (error) {
      errorLog("alerts.clear.failed", error, { description: "清除告警失败" });
      return NextResponse.json({ error: "清除告警失败" }, { status: 500 });
    }
  });
}

/** 校验分页与刷新参数，执行可选的事件同步并读取统一告警页。
 * @param request 当前告警查询请求及查询参数。
 * @returns 告警数据响应；参数错误、同步超时或查询失败时返回相应错误状态。
 */
async function handleGet(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const refreshValue = params.get("refresh");
  if (refreshValue !== null && refreshValue !== "true" && refreshValue !== "false")
    return NextResponse.json({ error: "refresh 只能是 true 或 false" } satisfies ErrorResponse, { status: 400 });
  const rawLimit = params.get("limit") ?? "50";
  const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    return NextResponse.json({ error: "limit 必须是 1 到 500 的整数" } satisfies ErrorResponse, { status: 400 });
  const cursor = params.get("cursor") || undefined;
  const source = params.get("source") || undefined;
  const alertType = params.get("alertType") || undefined;
  const severity = params.get("severity") || undefined;
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  if (source && !["alertmanager", "kubernetes"].includes(source)) return NextResponse.json({ error: "source 无效" }, { status: 400 });
  for (const [key, value] of [["from", from], ["to", to]] as const) {
    if (value && !Number.isFinite(Date.parse(value))) return NextResponse.json({ error: `${key} 必须是有效时间` }, { status: 400 });
  }
  if (from && to && Date.parse(from) > Date.parse(to)) return NextResponse.json({ error: "开始时间不能晚于结束时间" }, { status: 400 });
  const refresh = refreshValue === "true";
  try {
    let synchronizedEvents: number | null = null;
    if (refresh) {
      synchronizedEvents = await syncKubernetesEvents(true);
      if (synchronizedEvents === null)
        return NextResponse.json({ error: "等待其他实例完成事件同步超时" } satisfies ErrorResponse, { status: 502 });
    }
    const page = await getStoredAlerts(limit, cursor, { source, alertType, severity, from, to });
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
