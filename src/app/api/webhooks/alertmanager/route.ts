import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { applyWebhook, parseWebhook } from "@/lib/alertmanager";
import { businessLog, errorLog, httpLog } from "@/lib/logger";
import type { operations } from "@/generated/api.types";
type WebhookResponse = operations["receiveAlertmanagerWebhook"]["responses"][200]["content"]["application/json"];
type ErrorResponse = operations["receiveAlertmanagerWebhook"]["responses"][400]["content"]["application/json"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(header: string | null, token: string) {
  if (!header?.startsWith("Bearer ")) return false;
  const received = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(received, expected);
}

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

export async function POST(request: NextRequest) {
  const calledAt = new Date().toISOString();
  const started = performance.now();
  const context = { direction: "inbound", method: "POST", path: "/api/webhooks/alertmanager", operation: "Alertmanager告警接收", calledAt };
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
