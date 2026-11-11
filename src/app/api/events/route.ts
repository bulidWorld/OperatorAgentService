import { NextRequest, NextResponse } from "next/server";
import { getKubernetesEvents } from "@/lib/kubernetes-events";
import { errorLog, withAccessLog } from "@/lib/logger";
import type { operations } from "@/generated/api.types";

type EventsResponse = operations["getKubernetesEvents"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["getKubernetesEvents"]["responses"][400]["content"]["application/json"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function integerParam(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** 从数据库分页读取 Kubernetes Events，可按对象及命名空间筛选。
 * @param request 接受 OpenAPI 中定义的筛选条件和分页游标。
 * @returns 数据库查询结果或参数错误。
 */
export async function GET(request: NextRequest) {
  return withAccessLog(request, "Kubernetes事件查询", () => handleGet(request));
}

async function handleGet(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const hours = integerParam(params.get("hours"), 24, 1, 720);
  const limit = integerParam(params.get("limit"), 100, 1, 500);
  if (hours === null || limit === null)
    return NextResponse.json({ error: "hours 或 limit 超出允许范围" } satisfies ErrorResponse, { status: 400 });
  const optional = ["namespace", "objectType", "objectName", "objectUid", "eventType", "cursor"] as const;
  const filters = Object.fromEntries(optional.map((key) => [key, params.get(key) || undefined]));
  try {
    const result = await getKubernetesEvents({ ...filters, hours, limit });
    return NextResponse.json(result satisfies EventsResponse);
  } catch (error) {
    errorLog("events.query.failed", error, { description: "Kubernetes事件查询失败" });
    const message = error instanceof Error ? error.message : "事件查询失败";
    const status = message.includes("游标无效") ? 400 : 500;
    return NextResponse.json({ error: message } satisfies ErrorResponse, { status });
  }
}
