import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { applyWebhook, parseWebhook } from "@/lib/alertmanager";
import { businessLog, errorLog, httpLog } from "@/lib/logger";
import type { operations } from "@/generated/api.types";
type WebhookResponse = operations["receiveAlertmanagerWebhook"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["receiveAlertmanagerWebhook"]["responses"][400]["content"]["application/json"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 使用恒定时间比较校验 Bearer token。
 * @param header HTTP Authorization 请求头。
 * @param token 服务端配置的预期 token。
 * @returns 请求头中的 token 与预期 token 相同时返回 true。
 */
function authorized(header: string | null, token: string) {
  if (!header?.startsWith("Bearer ")) return false;
  const received = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(received, expected);
}

/** 读取并限制 Alertmanager webhook 请求体大小。
 * @param request 当前 Next.js webhook 请求。
 * @returns 请求体 UTF-8 字符串。
 * @throws 请求体为空或超过 1 MiB 时抛出错误。
 */
async function readBody(request: NextRequest): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("请求体不能为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("请求体超过 1 MiB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 接收、校验并持久化 Alertmanager v4 webhook 告警。
 * @param request Alertmanager 发来的 POST 请求，需包含 Bearer token 和 JSON 请求体。
 * @returns 接收数量与活动告警总数；按校验或存储结果返回对应 HTTP 状态。
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const calledAt = new Date().toISOString();
  const started = performance.now();
  const context = { requestId, traceId: requestId, direction: "inbound", method: "POST", path: "/api/webhooks/alertmanager", operation: "Alertmanager告警接收", calledAt };
  httpLog("request.started", context);
  let status = 200;
  let errorMessage: string | undefined;
  try {
    const token = process.env.ALERTMANAGER_WEBHOOK_TOKEN;
    if (!token) {
      status = 503;
      return NextResponse.json({ error: "未配置 ALERTMANAGER_WEBHOOK_TOKEN" } satisfies ErrorResponse, { status });
    }
    if (!authorized(request.headers.get("authorization"), token)) {
      status = 401;
      return NextResponse.json({ error: "未授权" } satisfies ErrorResponse, { status });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      status = 415;
      return NextResponse.json({ error: "需要 application/json" } satisfies ErrorResponse, { status });
    }
    let alerts;
    try {
      alerts = parseWebhook(JSON.parse(await readBody(request)));
    } catch (error) {
      status = 400;
      return NextResponse.json({ error: error instanceof Error ? error.message : "无效的请求体" } satisfies ErrorResponse, { status });
    }
    const activeCount = await applyWebhook(alerts);
    businessLog("alertmanager.webhook.received", { description: `Alertmanager告警接收：收到${alerts.length}条，当前活动${activeCount}条`, alertCount: alerts.length, activeCount });
    return NextResponse.json({ received: alerts.length, active: activeCount } satisfies WebhookResponse);
  } catch (error) {
    status = 500;
    errorMessage = error instanceof Error ? error.message : String(error);
    errorLog("alertmanager.webhook.failed", error, { description: "Alertmanager告警接收失败" });
    return NextResponse.json({ error: "告警保存失败" } satisfies ErrorResponse, { status });
  } finally {
    httpLog("request.completed", { ...context, returnedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), status, result: status < 400 ? "success" : "error", errorMessage });
  }
}
