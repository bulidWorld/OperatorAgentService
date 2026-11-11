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

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function date(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  throw new Error("Kubernetes Event 缺少有效时间戳");
}

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
      const deleted = await client.query("DELETE FROM resource_alert_events WHERE source = 'kubernetes' AND last_seen_at < now() - interval '30 days'");
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

export function startKubernetesEventScheduler() {
  if (!process.env.KUBERNETES_SERVICE_HOST) return;
  businessLog("kubernetes.events.scheduler.started", { intervalMs: 5 * 60 * 1000,
    description: "Kubernetes Event 定时任务已启动，周期为 5 分钟" });
  let running = false;
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
  const timer = setInterval(() => void sync(), 5 * 60 * 1000);
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
  source: "alertmanager" | "kubernetes";
  name: string;
  severity: string;
  objectType: string | null;
  resource: string;
  description: string;
  activeAt: string;
};

export async function getStoredAlerts(limit = 100, cursorToken?: string) {
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
    WHERE $1::timestamptz IS NULL OR occurred_at < $1 OR (occurred_at = $1 AND id < $2)
    ORDER BY occurred_at DESC, id DESC LIMIT $3`, [cursor?.occurredAt ?? null, cursor?.id ?? null, limit + 1]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    occurredAt: last.occurred_at.toISOString(), id: last.id,
  })).toString("base64url") : null;
  const alerts = rows.map((row): StoredAlertRow => ({
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
