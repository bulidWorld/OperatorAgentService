import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isStepSelection, type StepSelection } from "@/lib/chart";
import { getDashboard } from "@/lib/prometheus/business";
import { errorLog, httpLog, withLogContext } from "@/lib/logger";
import type { operations } from "@/generated/api.types";
type MonitorResponse = operations["getMonitor"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["getMonitor"]["responses"][400]["content"]["application/json"];
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** 处理监控面板 GET 请求，并为请求链建立日志上下文。
 * @param request Next.js 请求，查询参数可包含 scope、minutes 和 step。
 * @returns Dashboard JSON；参数错误返回 400，监控查询失败返回 502。
 */
export async function GET(request: NextRequest) {
  return withLogContext({ traceId: randomUUID(), feature: "监控数据API" }, () => handleGet(request));
}
/** 校验监控查询参数、调用业务聚合层并记录入站请求结果。
 * @param request 当前 Next.js GET 请求。
 * @returns 符合 OpenAPI Dashboard 契约的 JSON 响应。
 */
async function handleGet(request: NextRequest) {
  const requestId = randomUUID();
  const started = performance.now();
  const context = {
    requestId, direction: "inbound", method: request.method,
    path: request.nextUrl.pathname, requestParams: { scope: request.nextUrl.searchParams.get("scope"), minutes: request.nextUrl.searchParams.get("minutes") }, calledAt: new Date().toISOString(),
  };
  httpLog("request.started", context);
  let status = 200;
  try {
    const scope = request.nextUrl.searchParams.get("scope") || "nodes";
    const minutes = Number(request.nextUrl.searchParams.get("minutes") || 60);
    const rawStep = request.nextUrl.searchParams.get("step") || "auto";
    const step: StepSelection = rawStep === "auto" ? "auto" : isStepSelection(Number(rawStep)) ? Number(rawStep) as StepSelection : "auto";
    if (!["nodes", "pods"].includes(scope) || ![15, 60, 360, 1440].includes(minutes) || (rawStep !== "auto" && !isStepSelection(Number(rawStep)))) {
      status = 400;
      return NextResponse.json({ error: "无效的查询参数" } satisfies ErrorResponse, { status });
    }
    const dashboard = await getDashboard(scope as "nodes" | "pods", minutes, step, request.nextUrl.searchParams.get("refresh") === "true");
    return NextResponse.json(dashboard satisfies MonitorResponse);
  } catch (error) {
    status = 502;
    errorLog("monitor.api.failed", error, { requestId, description: "监控数据API：查询失败，返回HTTP 502" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "监控查询失败" } satisfies ErrorResponse,
      { status },
    );
  } finally {
    httpLog("request.completed", {
      ...context, returnedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), status,
      result: status < 400 ? "success" : "error",
    });
  }
}
