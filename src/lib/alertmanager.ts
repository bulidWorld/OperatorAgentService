import { createHash } from "node:crypto";
import { getDatabase } from "./database";

export type WebhookAlert = {
  fingerprint: string;
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt?: string;
  generatorURL?: string;
  rawAlert: Record<string, unknown>;
  webhookContext: Record<string, unknown>;
};

type StoredAlert = WebhookAlert & {
  receivedAt: string;
  resourceType: string | null;
  resourceName: string | null;
  namespace: string | null;
};

const resourceLabels = ["pod", "node", "instance", "container", "deployment", "service", "namespace", "cluster"] as const;

export function alertResource(labels: Record<string, string>): { type: string | null; name: string | null; namespace: string | null } {
  const type = resourceLabels.find((key) => !!labels[key]) ?? null;
  return { type, name: type ? labels[type] : null, namespace: labels.namespace || null };
}

function stringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseWebhook(value: unknown): WebhookAlert[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的 Alertmanager webhook 数据");
  const body = value as Record<string, unknown>;
  if (body.version !== "4" || !Array.isArray(body.alerts) || body.alerts.length > 1000)
    throw new Error("需要 Alertmanager v4 webhook，且每次最多 1000 条告警");
  const webhookContext = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "alerts"));
  return body.alerts.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("无效的告警对象");
    const alert = item as Record<string, unknown>;
    if ((alert.status !== "firing" && alert.status !== "resolved") ||
        !stringMap(alert.labels) || !stringMap(alert.annotations) || !validDate(alert.startsAt) ||
        (alert.endsAt !== undefined && !validDate(alert.endsAt)) ||
        (alert.fingerprint !== undefined && (typeof alert.fingerprint !== "string" || !alert.fingerprint)) ||
        (alert.generatorURL !== undefined && typeof alert.generatorURL !== "string"))
      throw new Error("无效的告警字段");
    const fingerprint = typeof alert.fingerprint === "string" ? alert.fingerprint :
      createHash("sha256").update(JSON.stringify(Object.entries(alert.labels).sort())).digest("hex");
    return {
      fingerprint, status: alert.status, labels: alert.labels, annotations: alert.annotations,
      startsAt: alert.startsAt, ...(alert.endsAt ? { endsAt: alert.endsAt } : {}),
      ...(typeof alert.generatorURL === "string" ? { generatorURL: alert.generatorURL } : {}),
      rawAlert: alert, webhookContext,
    } as WebhookAlert;
  });
}

export async function getPushedAlerts(): Promise<StoredAlert[]> {
  const result = await getDatabase().query<{
    fingerprint: string; labels: Record<string, string>; annotations: Record<string, string>;
    starts_at: Date; ends_at: Date | null; received_at: Date; generator_url: string | null;
    resource_type: string | null; resource_name: string | null; namespace: string | null;
    alert_payload: Record<string, unknown> | null; webhook_context: Record<string, unknown> | null;
  }>(`SELECT fingerprint, labels, annotations, starts_at, ends_at, received_at,
    generator_url, resource_type, resource_name, namespace, alert_payload, webhook_context
    FROM alertmanager_active_alerts ORDER BY received_at DESC, id DESC`);
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint, status: "firing", labels: row.labels,
    annotations: row.annotations, startsAt: row.starts_at.toISOString(),
    ...(row.ends_at ? { endsAt: row.ends_at.toISOString() } : {}),
    ...(row.generator_url ? { generatorURL: row.generator_url } : {}),
    rawAlert: row.alert_payload ?? {}, webhookContext: row.webhook_context ?? {},
    resourceType: row.resource_type, resourceName: row.resource_name, namespace: row.namespace,
    receivedAt: row.received_at.toISOString(),
  }));
}

export async function applyWebhook(alerts: WebhookAlert[]): Promise<number> {
  const client = await getDatabase().connect();
  try {
    await client.query("BEGIN");
    // Serialize batches so the active-alert limit remains valid across replicas.
    await client.query("SELECT pg_advisory_xact_lock(487391, 1)");
    for (const alert of alerts) {
      if (alert.status === "resolved") {
        await client.query("DELETE FROM alertmanager_active_alerts WHERE fingerprint = $1", [alert.fingerprint]);
      } else {
        const resource = alertResource(alert.labels);
        await client.query(`INSERT INTO alertmanager_active_alerts
          (fingerprint, labels, annotations, starts_at, ends_at, received_at,
           alert_name, severity, resource_type, resource_name, namespace,
           summary, description, generator_url, alert_payload, webhook_context)
          VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now(),
                  $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
          ON CONFLICT (fingerprint) DO UPDATE SET
            labels = EXCLUDED.labels, annotations = EXCLUDED.annotations,
            starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
            received_at = EXCLUDED.received_at, alert_name = EXCLUDED.alert_name,
            severity = EXCLUDED.severity, resource_type = EXCLUDED.resource_type,
            resource_name = EXCLUDED.resource_name, namespace = EXCLUDED.namespace,
            summary = EXCLUDED.summary, description = EXCLUDED.description,
            generator_url = EXCLUDED.generator_url, alert_payload = EXCLUDED.alert_payload,
            webhook_context = EXCLUDED.webhook_context`, [
          alert.fingerprint, JSON.stringify(alert.labels), JSON.stringify(alert.annotations),
          alert.startsAt, alert.endsAt ?? null,
          alert.labels.alertname ?? null, alert.labels.severity ?? null,
          resource.type, resource.name, resource.namespace,
          alert.annotations.summary ?? null, alert.annotations.description ?? null,
          alert.generatorURL ?? null, JSON.stringify(alert.rawAlert), JSON.stringify(alert.webhookContext),
        ]);
      }
    }
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM alertmanager_active_alerts");
    const activeCount = Number(count.rows[0].count);
    if (activeCount > 10000) throw new Error("活动告警超过 10000 条");
    await client.query("COMMIT");
    return activeCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
