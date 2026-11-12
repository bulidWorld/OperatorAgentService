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
const objectTypes: Record<(typeof resourceLabels)[number], string> = {
  pod: "Pod", node: "Node", instance: "Instance", container: "Container",
  deployment: "Deployment", service: "Service", namespace: "Namespace", cluster: "Cluster",
};

/** 从 Alertmanager 标签中推断告警对象及其命名空间。
 * @param labels 单条告警携带的标签映射。
 * @returns 推断出的对象类型、对象名称和命名空间；无法推断时对应字段为 null。
 */
export function alertResource(labels: Record<string, string>): { type: string | null; name: string | null; namespace: string | null } {
  const label = resourceLabels.find((key) => !!labels[key]) ?? null;
  return { type: label ? objectTypes[label] : null, name: label ? labels[label] : null, namespace: labels.namespace || null };
}

/** 检查值是否为只包含字符串值的对象。
 * @param value 待检查的任意值。
 * @returns 值符合字符串映射结构时返回 true。
 */
function stringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

/** 检查字符串能否解析为有效日期。
 * @param value 待检查的日期值。
 * @returns value 是有效日期字符串时返回 true。
 */
function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** 校验并规范化 Alertmanager v4 webhook 中的告警列表。
 * @param value JSON 解码后的 webhook 请求体。
 * @returns 单条告警数组，包含指纹、原始告警内容和批次元数据。
 * @throws webhook 版本、条数或告警字段不符合要求时抛出错误。
 */
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

/** 查询 PostgreSQL 中当前所有活动告警，并映射为应用使用的结构。
 * @returns 按接收时间倒序排列的 firing 告警列表。
 */
export async function getPushedAlerts(): Promise<StoredAlert[]> {
  const result = await getDatabase().query<{
    fingerprint: string; labels: Record<string, string>; annotations: Record<string, string>;
    occurred_at: Date; ends_at: Date | null; updated_at: Date; generator_url: string | null;
    object_type: string | null; object_name: string | null; namespace: string | null;
    raw_payload: Record<string, unknown>; webhook_context: Record<string, unknown> | null;
  }>(`SELECT external_id AS fingerprint, labels, annotations, occurred_at, ends_at, updated_at,
    generator_url, object_type, object_name, namespace, raw_payload, webhook_context
    FROM resource_alert_events WHERE source = 'alertmanager' AND resolution_status = 'active' ORDER BY updated_at DESC, id DESC`);
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint, status: "firing", labels: row.labels,
    annotations: row.annotations, startsAt: row.occurred_at.toISOString(),
    ...(row.ends_at ? { endsAt: row.ends_at.toISOString() } : {}),
    ...(row.generator_url ? { generatorURL: row.generator_url } : {}),
    rawAlert: row.raw_payload, webhookContext: row.webhook_context ?? {},
    resourceType: row.object_type, resourceName: row.object_name, namespace: row.namespace,
    receivedAt: row.updated_at.toISOString(),
  }));
}

/** 在单个事务中应用一批 firing/resolved 告警更新。
 * @param alerts 已解析的 webhook 告警列表。
 * @returns 提交后数据库中的活动告警数量。
 * @throws 数据库操作失败或活动告警数超过 10000 条时回滚并抛出错误。
 */
export async function applyWebhook(alerts: WebhookAlert[]): Promise<number> {
  const client = await getDatabase().connect();
  try {
    await client.query("BEGIN");
    // Serialize batches so the active-alert limit remains valid across replicas.
    await client.query("SELECT pg_advisory_xact_lock(487391, 1)");
    for (const alert of alerts) {
      if (alert.status === "resolved") {
        await client.query(`UPDATE resource_alert_events SET resolution_status = 'resolved',
          resolution_source = 'alertmanager', resolved_at = now(), updated_at = now()
          WHERE source = 'alertmanager' AND external_id = $1`, [alert.fingerprint]);
      } else {
        const resource = alertResource(alert.labels);
        await client.query(`INSERT INTO resource_alert_events
          (source, external_id, object_type, object_name, namespace, description,
           severity, occurred_at, alert_type, summary, labels, annotations,
           generator_url, ends_at, webhook_context, raw_payload, updated_at)
          VALUES ('alertmanager', $1, $2, $3, $4, $5,
                  $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                  $12, $13, $14::jsonb, $15::jsonb, now())
          ON CONFLICT (source, external_id) DO UPDATE SET
            object_type = EXCLUDED.object_type, object_name = EXCLUDED.object_name,
            namespace = EXCLUDED.namespace, description = EXCLUDED.description,
            severity = EXCLUDED.severity, occurred_at = EXCLUDED.occurred_at,
            alert_type = EXCLUDED.alert_type, summary = EXCLUDED.summary,
            labels = EXCLUDED.labels, annotations = EXCLUDED.annotations,
            generator_url = EXCLUDED.generator_url, ends_at = EXCLUDED.ends_at,
            webhook_context = EXCLUDED.webhook_context, raw_payload = EXCLUDED.raw_payload,
            resolution_status = 'active', resolution_source = NULL, resolved_at = NULL,
            updated_at = EXCLUDED.updated_at`, [
          alert.fingerprint, resource.type, resource.name, resource.namespace,
          alert.annotations.description ?? alert.annotations.summary ?? null,
          alert.labels.severity ?? null, alert.startsAt, alert.labels.alertname ?? null,
          alert.annotations.summary ?? null, JSON.stringify(alert.labels), JSON.stringify(alert.annotations),
          alert.generatorURL ?? null, alert.endsAt ?? null,
          JSON.stringify(alert.webhookContext), JSON.stringify(alert.rawAlert),
        ]);
      }
    }
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM resource_alert_events WHERE source = 'alertmanager' AND resolution_status = 'active'");
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
