import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { getDatabase } from "./database";
import { businessLog, errorLog, httpLog } from "./logger";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const SYNC_LOCK = 3;
const PAGE_SIZE = 500;

type KubernetesEvent = Record<string, unknown> & {
  metadata?: Record<string, unknown>;
  involvedObject?: Record<string, unknown>;
  source?: Record<string, unknown>;
  series?: Record<string, unknown>;
};

type EventRow = {
  eventUid: string;
  source: "kubernetes";
  objectType: string | null;
  objectName: string | null;
  namespace: string | null;
  objectUid: string | null;
  objectApiVersion: string | null;
  description: string | null;
  severity: string | null;
  occurredAt: string;
  alertType: string | null;
  eventType: string | null;
  count: number;
  sourceComponent: string | null;
  sourceHost: string | null;
  lastSeenAt: string;
};

/** 将任意值读取为非空字符串。
 * @param value 待转换的值。
 * @returns 非空字符串；类型不符或为空时返回 null。
 */
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 从候选值中选择首个有效日期并规范为 ISO 8601 格式。
 * @param values 按优先顺序排列的候选日期值。
 * @returns 首个有效日期的 ISO 字符串。
 * @throws 所有候选值都无效时抛出错误。
 */
function date(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  throw new Error("Kubernetes Event 缺少有效时间戳");
}

/** 将 Kubernetes Event 对象映射为数据库字段结构。
 * @param event Kubernetes API 返回的原始 Event。
 * @returns 用于写入 resource_alert_events 的字段记录。
 */
function eventRecord(event: KubernetesEvent) {
  const metadata = event.metadata ?? {};
  const object = event.involvedObject ?? {};
  const source = event.source ?? {};
  const series = event.series ?? {};
  const occurredAt = date(event.firstTimestamp, event.eventTime, metadata.creationTimestamp);
  const lastSeenAt = date(series.lastObservedTime, event.lastTimestamp, event.eventTime, event.firstTimestamp, metadata.creationTimestamp);
  const type = text(event.type);
  const rawCount = Number(series.count ?? event.count ?? 1);
  return {
    external_id: text(metadata.uid),
    object_type: text(object.kind),
    object_name: text(object.name),
    namespace: text(object.namespace),
    object_uid: text(object.uid),
    object_api_version: text(object.apiVersion),
    description: text(event.message) ?? text(event.note),
    severity: type === "Warning" ? "warning" : type === "Normal" ? "info" : null,
    occurred_at: occurredAt,
    alert_type: text(event.reason),
    event_type: type,
    event_count: Number.isInteger(rawCount) && rawCount > 0 ? rawCount : 1,
    source_component: text(source.component) ?? text(event.reportingController),
    source_host: text(source.host) ?? text(event.reportingInstance),
    last_seen_at: lastSeenAt,
    raw_payload: event,
  };
}

/** 使用 ServiceAccount 凭据请求 Kubernetes API 并记录请求日志。
 * @param path API Server 上的请求路径。
 * @param page 当前分页序号，仅用于请求日志。
 * @returns JSON 解码后的 API 响应。
 * @throws 集群配置缺失、请求失败、超时或响应状态异常时抛出错误。
 */
async function apiGet(path: string, page: number): Promise<unknown> {
  const requestId = randomUUID();
  const calledAt = new Date().toISOString();
  const started = performance.now();
  const context = { requestId, traceId: requestId, direction: "outbound", method: "GET", path: "/api/v1/events", page,
    operation: "Kubernetes Event 分页查询", calledAt };
  httpLog("request.started", context);
  let status: number | undefined;
  let errorMessage: string | undefined;
  try {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    if (!host) throw new Error("未检测到集群内 Kubernetes API Server 地址");
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || "443";
    const [token, ca] = await Promise.all([
      readFile(`${SERVICE_ACCOUNT_DIR}/token`, "utf8"),
      readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
    ]);
    const response = await new Promise<{ body: string; status: number }>((resolve, reject) => {
      const request = httpsRequest({
        hostname,
        port: Number(port),
        path,
        method: "GET",
        ca,
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve({
          body: Buffer.concat(chunks).toString("utf8"), status: incoming.statusCode ?? 500,
        }));
      });
      request.setTimeout(20000, () => request.destroy(new Error("Kubernetes API 请求超时")));
      request.on("error", reject);
      request.end();
    });
    status = response.status;
    if (status < 200 || status >= 300)
      throw new Error(`Kubernetes API 返回 HTTP ${status}: ${response.body.slice(0, 500)}`);
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    errorLog("kubernetes.api.request.failed", error, { ...context, description: "Kubernetes API 请求失败" });
    throw error;
  } finally {
    httpLog("request.completed", { ...context, returnedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), status,
      result: !errorMessage && status !== undefined && status >= 200 && status < 300 ? "success" : "error", errorMessage });
  }
}

/** 使用 continue token 遍历 Kubernetes Events，并逐页交给调用方处理。
 * @param onPage 每页 Event 的异步处理函数。
 * @returns 读取的 Event 总数及请求页数。
 * @throws API 返回结构无效或任一页请求失败时抛出错误。
 */
async function fetchEventPages(onPage: (events: KubernetesEvent[]) => Promise<void>) {
  let continuation = "";
  let total = 0;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (continuation) query.set("continue", continuation);
    const payload = await apiGet(`/api/v1/events?${query}`, pages + 1);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items))
      throw new Error("Kubernetes API 返回了无效的 Event 列表");
    const page = payload as { items: KubernetesEvent[]; metadata?: { continue?: string } };
    await onPage(page.items);
    total += page.items.length;
    pages += 1;
    continuation = page.metadata?.continue || "";
  } while (continuation);
  return { eventsRead: total, pages };
}

/** 将一页 Kubernetes Events 批量插入或更新到事件表。
 * @param events 当前页的 Kubernetes Event 对象。
 * @returns 数据库报告的插入或更新行数。
 */
async function upsertPage(events: KubernetesEvent[]): Promise<number> {
  const records = events.map(eventRecord).filter((row) => row.external_id);
  if (!records.length) return 0;
  const result = await getDatabase().query(`
    INSERT INTO resource_alert_events
      (source, external_id, object_type, object_name, namespace, object_uid, object_api_version,
       description, severity, occurred_at, alert_type, event_type, event_count,
       source_component, source_host, last_seen_at, raw_payload, updated_at)
    SELECT 'kubernetes', r.external_id, r.object_type, r.object_name, r.namespace, r.object_uid,
       r.object_api_version, r.description, r.severity, r.occurred_at, r.alert_type,
       r.event_type, r.event_count, r.source_component, r.source_host, r.last_seen_at,
       r.raw_payload, now()
    FROM jsonb_to_recordset($1::jsonb) AS r(
       external_id text, object_type text, object_name text, namespace text, object_uid text,
       object_api_version text, description text, severity text, occurred_at timestamptz,
       alert_type text, event_type text, event_count integer, source_component text,
       source_host text, last_seen_at timestamptz, raw_payload jsonb)
    ON CONFLICT (source, external_id) DO UPDATE SET
       object_type = EXCLUDED.object_type, object_name = EXCLUDED.object_name,
       namespace = EXCLUDED.namespace, object_uid = EXCLUDED.object_uid,
       object_api_version = EXCLUDED.object_api_version, description = EXCLUDED.description,
       severity = EXCLUDED.severity, occurred_at = EXCLUDED.occurred_at,
       alert_type = EXCLUDED.alert_type, event_type = EXCLUDED.event_type,
       event_count = EXCLUDED.event_count, source_component = EXCLUDED.source_component,
       source_host = EXCLUDED.source_host, last_seen_at = EXCLUDED.last_seen_at,
       raw_payload = EXCLUDED.raw_payload, updated_at = EXCLUDED.updated_at`, [JSON.stringify(records)]);
  return result.rowCount ?? 0;
}

/** 等待指定毫秒数后继续执行。
 * @param ms 等待时长，单位为毫秒。
 * @returns 等待结束时完成的 Promise。
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Synchronize the cluster's complete core/v1 Event list and upsert by source plus Event UID.
 * @param waitForLock Manual refreshes wait for the active synchronizer; scheduled runs skip if another instance owns the lock.
 * @returns Number of Event objects read from the API Server.
 */
export async function syncKubernetesEvents(waitForLock = false): Promise<number | null> {
  const syncId = randomUUID();
  const trigger = waitForLock ? "manual" : "scheduled";
  const started = performance.now();
  const calledAt = new Date().toISOString();
  businessLog("kubernetes.events.sync.started", { syncId, traceId: syncId, trigger, calledAt,
    description: `Kubernetes Event 同步开始，触发方式：${trigger}` });
  const deadline = Date.now() + (waitForLock ? 60000 : 0);
  const lockWaitStarted = performance.now();
  let eventsRead = 0;
  let eventsUpserted = 0;
  let pages = 0;
  while (true) {
    let client: PoolClient | undefined;
    let locked = false;
    let released = false;
    try {
      client = await getDatabase().connect();
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(487391, $1) AS locked", [SYNC_LOCK]);
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        client.release();
        released = true;
        if (Date.now() >= deadline) {
          const durationMs = Math.round(performance.now() - started);
          if (waitForLock) errorLog("kubernetes.events.sync.failed", new Error("等待同步锁超时"), {
            syncId, traceId: syncId, trigger, calledAt, durationMs, lockWaitMs: Math.round(performance.now() - lockWaitStarted),
            description: "Kubernetes Event 同步等待锁超时",
          });
          else businessLog("kubernetes.events.sync.skipped", { syncId, traceId: syncId, trigger, calledAt, durationMs, reason: "another_sync_running",
            description: "Kubernetes Event 同步跳过：其他实例正在同步" });
          return null;
        }
        await sleep(250);
        continue;
      }
      await fetchEventPages(async (events) => {
        pages += 1;
        eventsRead += events.length;
        eventsUpserted += await upsertPage(events);
      });
      const deleted = await client.query(`UPDATE resource_alert_events SET resolution_status = 'resolved',
        resolution_source = 'automatic', resolved_at = now(), updated_at = now()
        WHERE source = 'kubernetes' AND resolution_status = 'active' AND last_seen_at < now() - interval '30 days'`);
      const durationMs = Math.round(performance.now() - started);
      businessLog("kubernetes.events.sync.completed", { syncId, traceId: syncId, trigger, calledAt,
        returnedAt: new Date().toISOString(), durationMs, lockWaitMs: Math.round(performance.now() - lockWaitStarted),
        eventsRead, eventsUpserted, pages,
        eventsDeleted: deleted.rowCount ?? 0,
        description: `Kubernetes Event 同步完成，读取${eventsRead}条，写入${eventsUpserted}条，清理${deleted.rowCount ?? 0}条，耗时${durationMs}毫秒`,
      });
      return eventsRead;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      errorLog("kubernetes.events.sync.failed", error, { syncId, traceId: syncId, trigger, calledAt,
        durationMs, lockWaitMs: Math.round(performance.now() - lockWaitStarted),
        eventsRead, eventsUpserted, pages, description: "Kubernetes Event 同步失败",
      });
      throw error;
    } finally {
      if (locked) {
        try { await client!.query("SELECT pg_advisory_unlock(487391, $1)", [SYNC_LOCK]); }
        finally { client!.release(); }
      } else if (client && !released) client.release();
    }
  }
}

/** 在集群环境中启动 Kubernetes Event 的首次及定时同步任务。
 * @returns 无返回值；非集群环境下直接结束。
 */
export function startKubernetesEventScheduler() {
  if (!process.env.KUBERNETES_SERVICE_HOST) return;
  businessLog("kubernetes.events.scheduler.started", { intervalMs: 5 * 60 * 1000,
    description: "Kubernetes Event 定时任务已启动，周期为 5 分钟" });
  let running = false;
  /** 执行一次定时同步，并避免同一进程内的任务重叠。
   * @returns 同步完成后兑现的 Promise。
   */
  const sync = async () => {
    if (running) {
      const syncId = randomUUID();
      businessLog("kubernetes.events.sync.skipped", { syncId, traceId: syncId, trigger: "scheduled", calledAt: new Date().toISOString(),
        durationMs: 0, reason: "same_process_sync_running",
        description: "Kubernetes Event 同步跳过：当前实例已有同步任务运行" });
      return;
    }
    running = true;
    try {
      await syncKubernetesEvents();
    } catch {
      // syncKubernetesEvents records the failure with its timing and partial counts.
    } finally {
      running = false;
    }
  };
  void sync();
  const timer = setInterval(() => void sync(), 3 * 60 * 1000);
  timer.unref();
}

export type KubernetesEventFilters = {
  namespace?: string;
  objectType?: string;
  objectName?: string;
  objectUid?: string;
  eventType?: string;
  hours: number;
  limit: number;
  cursor?: string;
};

type Cursor = { lastSeenAt: string; id: number; filterKey: string };

/** 按筛选条件分页读取已保存的 Kubernetes Events。
 * @param filters 命名空间、对象、事件类型、时间范围及分页参数。
 * @returns 查询时间、事件列表和后续页游标。
 * @throws 游标格式错误或与当前筛选条件不匹配时抛出错误。
 */
export async function getKubernetesEvents(filters: KubernetesEventFilters) {
  const filterKey = JSON.stringify({ namespace: filters.namespace, objectType: filters.objectType,
    objectName: filters.objectName, objectUid: filters.objectUid, eventType: filters.eventType, hours: filters.hours });
  let cursor: Cursor | undefined;
  if (filters.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as Cursor;
      if (cursor.filterKey !== filterKey || !Number.isInteger(cursor.id) || cursor.id < 1 || cursor.id > 2147483647 ||
          !Number.isFinite(Date.parse(cursor.lastSeenAt)))
        throw new Error();
    } catch {
      throw new Error("分页游标无效或与当前筛选条件不匹配");
    }
  }
  const result = await getDatabase().query<{
    id: number; external_id: string; object_type: string | null; object_name: string | null;
    namespace: string | null; object_uid: string | null; object_api_version: string | null;
    description: string | null; severity: string | null; occurred_at: Date; alert_type: string | null;
    event_type: string | null; event_count: number; source_component: string | null;
    source_host: string | null; last_seen_at: Date;
  }>(`SELECT id, external_id, object_type, object_name, namespace, object_uid, object_api_version,
       description, severity, occurred_at, alert_type, event_type, event_count,
       source_component, source_host, last_seen_at
    FROM resource_alert_events
    WHERE source = 'kubernetes'
      AND last_seen_at >= now() - ($1::int * interval '1 hour')
      AND ($2::text IS NULL OR namespace = $2)
      AND ($3::text IS NULL OR object_type = $3)
      AND ($4::text IS NULL OR object_name = $4)
      AND ($5::text IS NULL OR object_uid = $5)
      AND ($6::text IS NULL OR event_type = $6)
      AND ($7::timestamptz IS NULL OR last_seen_at < $7 OR (last_seen_at = $7 AND id < $8))
    ORDER BY last_seen_at DESC, id DESC LIMIT $9`, [filters.hours, filters.namespace ?? null,
    filters.objectType ?? null, filters.objectName ?? null, filters.objectUid ?? null, filters.eventType ?? null,
    cursor?.lastSeenAt ?? null, cursor?.id ?? null, filters.limit + 1]);
  const hasMore = result.rows.length > filters.limit;
  const rows = result.rows.slice(0, filters.limit);
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    lastSeenAt: last.last_seen_at.toISOString(), id: last.id, filterKey,
  })).toString("base64url") : null;
  return {
    queriedAt: new Date().toISOString(),
    events: rows.map((row): EventRow => ({
      eventUid: row.external_id, source: "kubernetes", objectType: row.object_type,
      objectName: row.object_name, namespace: row.namespace, objectUid: row.object_uid,
      objectApiVersion: row.object_api_version, description: row.description, severity: row.severity,
      occurredAt: row.occurred_at.toISOString(), alertType: row.alert_type, eventType: row.event_type,
      count: row.event_count, sourceComponent: row.source_component, sourceHost: row.source_host,
      lastSeenAt: row.last_seen_at.toISOString(),
    })),
    nextCursor,
  };
}

export type StoredAlertRow = {
  id: number;
  source: "alertmanager" | "kubernetes";
  name: string;
  severity: string;
  objectType: string | null;
  resource: string;
  description: string;
  activeAt: string;
};

/** 按发生时间倒序分页读取告警和 Kubernetes Event 的统一列表。
 * @param limit 本页最多返回的记录数，默认 100。
 * @param cursorToken 上一页返回的游标；省略时从最新记录开始。
 * @returns 当前页告警数组及下一页游标；没有后续记录时游标为 null。
 * @throws 游标无法解析或字段无效时抛出错误。
 */
export type StoredAlertFilters = { source?: string; alertType?: string; severity?: string; from?: string; to?: string; includeResolved?: boolean; namespace?: string; objectType?: string; objectName?: string };

export async function getStoredAlerts(limit = 50, cursorToken?: string, filters: StoredAlertFilters = {}) {
  let cursor: { occurredAt: string; id: number } | undefined;
  if (cursorToken) {
    try {
      cursor = JSON.parse(Buffer.from(cursorToken, "base64url").toString("utf8")) as { occurredAt: string; id: number };
      if (!Number.isInteger(cursor.id) || cursor.id < 1 || cursor.id > 2147483647 ||
          !Number.isFinite(Date.parse(cursor.occurredAt))) throw new Error();
    } catch {
      throw new Error("告警分页游标无效");
    }
  }
  const result = await getDatabase().query<{
    id: number;
    source: "alertmanager" | "kubernetes"; alert_type: string | null; severity: string | null;
    object_type: string | null; object_name: string | null; namespace: string | null;
    description: string | null; occurred_at: Date;
  }>(`SELECT id, source, alert_type, severity, object_type, object_name, namespace, description, occurred_at
    FROM resource_alert_events
    WHERE ($1::timestamptz IS NULL OR occurred_at < $1 OR (occurred_at = $1 AND id < $2))
      AND ($3::text IS NULL OR source = $3)
      AND ($4::text IS NULL OR alert_type = $4)
      AND ($5::text IS NULL OR severity = $5)
      AND ($6::timestamptz IS NULL OR occurred_at >= $6)
      AND ($7::timestamptz IS NULL OR occurred_at <= $7)
      AND ($8::boolean OR resolution_status = 'active')
      AND ($9::text IS NULL OR namespace = $9)
      AND ($10::text IS NULL OR object_type = $10)
      AND ($11::text IS NULL OR object_name = $11)
    ORDER BY occurred_at DESC, id DESC LIMIT $12`, [cursor?.occurredAt ?? null, cursor?.id ?? null,
    filters.source ?? null, filters.alertType ?? null, filters.severity ?? null, filters.from ?? null, filters.to ?? null,
    filters.includeResolved ?? false, filters.namespace ?? null, filters.objectType ?? null, filters.objectName ?? null, limit + 1]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    occurredAt: last.occurred_at.toISOString(), id: last.id,
  })).toString("base64url") : null;
  const alerts = rows.map((row): StoredAlertRow => ({
    id: row.id,
    source: row.source,
    name: row.alert_type || "Event",
    severity: row.severity || "—",
    objectType: row.object_type,
    resource: row.namespace ? `${row.namespace}/${row.object_name || "—"}` : row.object_name || "—",
    description: row.description || "—",
    activeAt: row.occurred_at.toISOString(),
  }));
  return { alerts, nextCursor };
}

/** Retrieve the diagnostic fields and current resolution state for one alert row. */
export async function getStoredAlertDetails(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("告警 ID 必须为正整数");
  const result = await getDatabase().query<{
    id: number; source: "alertmanager" | "kubernetes"; alert_type: string | null; severity: string | null;
    object_type: string | null; object_name: string | null; namespace: string | null; description: string | null;
    summary: string | null; labels: Record<string, string> | null; annotations: Record<string, string> | null;
    occurred_at: Date; ends_at: Date | null; resolution_status: "active" | "resolved"; resolution_source: string | null;
    resolved_at: Date | null; event_type: string | null; event_count: number | null; source_component: string | null;
    source_host: string | null; last_seen_at: Date | null; raw_payload: unknown;
  }>(`SELECT id, source, alert_type, severity, object_type, object_name, namespace, description, summary,
      labels, annotations, occurred_at, ends_at, resolution_status, resolution_source, resolved_at,
      event_type, event_count, source_component, source_host, last_seen_at, raw_payload
    FROM resource_alert_events WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id, source: row.source, alertType: row.alert_type, severity: row.severity,
    objectType: row.object_type, objectName: row.object_name, namespace: row.namespace,
    description: row.description, summary: row.summary, labels: row.labels, annotations: row.annotations,
    occurredAt: row.occurred_at.toISOString(), endsAt: row.ends_at?.toISOString() ?? null,
    resolutionStatus: row.resolution_status, resolutionSource: row.resolution_source,
    resolvedAt: row.resolved_at?.toISOString() ?? null, eventType: row.event_type,
    eventCount: row.event_count, sourceComponent: row.source_component, sourceHost: row.source_host,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null, rawPayload: row.raw_payload,
  };
}

/** 清除指定告警，或清除符合筛选条件的全部告警。 */
export async function clearStoredAlerts(ids?: number[], filters: StoredAlertFilters = {}) {
  if (ids) {
    const result = await getDatabase().query(`UPDATE resource_alert_events SET resolution_status = 'resolved',
      resolution_source = 'manual', resolved_at = now(), updated_at = now()
      WHERE id = ANY($1::integer[]) AND resolution_status = 'active'`, [ids]);
    return result.rowCount ?? 0;
  }
  const result = await getDatabase().query(`UPDATE resource_alert_events SET resolution_status = 'resolved',
    resolution_source = 'manual', resolved_at = now(), updated_at = now()
    WHERE ($1::text IS NULL OR source = $1)
      AND ($2::text IS NULL OR alert_type = $2)
      AND ($3::text IS NULL OR severity = $3)
      AND ($4::timestamptz IS NULL OR occurred_at >= $4)
      AND ($5::timestamptz IS NULL OR occurred_at <= $5)
      AND resolution_status = 'active'`,
  [filters.source ?? null, filters.alertType ?? null, filters.severity ?? null, filters.from ?? null, filters.to ?? null]);
  return result.rowCount ?? 0;
}
