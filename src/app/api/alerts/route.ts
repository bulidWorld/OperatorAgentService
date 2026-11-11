import { NextResponse } from "next/server";
import { getResourceAlerts } from "@/lib/prometheus/business";
import { alertResource, getPushedAlerts } from "@/lib/alertmanager";
import type { operations } from "@/generated/api.types";
type AlertsResponse =
  operations["getAlerts"]["responses"][200]["content"]["application/json"];
type ErrorResponse =
  operations["getAlerts"]["responses"][502]["content"]["application/json"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 查询并格式化当前资源告警。
 * @returns 演示、Alertmanager PostgreSQL 或 Prometheus 告警列表；查询失败返回 502。
 */
export async function GET() {
  try {
    if (process.env.DEMO_MODE === "true")
      return NextResponse.json({ alerts: [] } satisfies AlertsResponse);
    if (process.env.ALERTMANAGER_WEBHOOK_TOKEN) {
      const alerts = await getPushedAlerts();
      return NextResponse.json({
        source: "alertmanager",
        alerts: alerts.map((alert) => ({
          name: alert.labels.alertname || "Alert",
          severity: alert.labels.severity || "—",
          resource:
            alert.resourceName || alertResource(alert.labels).name || "—",
          description:
            alert.annotations.description || alert.annotations.summary || "—",
          activeAt: alert.startsAt,
        })),
      } satisfies AlertsResponse);
    }
    const { alerts } = await getResourceAlerts();
    return NextResponse.json({
      source: "prometheus",
      alerts: alerts.map((alert) => ({
        name: alert.labels.alertname || "Alert",
        severity: alert.labels.severity || "—",
        resource:
          alert.labels.pod ||
          alert.labels.instance ||
          alert.labels.container ||
          alert.labels.node ||
          alert.labels.namespace ||
          alert.labels.cluster ||
          "—",
        description:
          alert.annotations.description || alert.annotations.summary || "—",
        activeAt: alert.activeAt || null,
      })),
    } satisfies AlertsResponse);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "告警查询失败",
      } satisfies ErrorResponse,
      { status: 502 },
    );
  }
}
