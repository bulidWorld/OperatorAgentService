import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const logContext = new AsyncLocalStorage<Record<string, unknown>>();
export function withLogContext<T>(fields: Record<string, unknown>, action: () => T): T {
  return logContext.run({ traceId: randomUUID(), ...logContext.getStore(), ...fields }, action);
}

function describe(event: string, fields: Record<string, unknown>): string {
  const feature = String(fields.feature || "监控服务");
  switch (event) {
    case "service.started": return `服务启动，日志目录：${logDirectory()}，日志保留14天`;
    case "dashboard.query.started": return `${feature}：开始查询，时间范围${fields.minutes}分钟`;
    case "dashboard.query.completed": return `${feature}：查询完成，${fields.mode === "demo" ? "演示" : "实时"}数据，资源${fields.resourceCount}个，告警${fields.alertCount}条，耗时${fields.durationMs}毫秒`;
    case "dashboard.query.failed": return `${feature}：查询失败，${fields.message}`;
    case "request.started": return `${feature}：${fields.direction === "outbound" ? "发起HTTP请求" : "收到HTTP请求"}，${fields.operation || "监控数据接口"}，${fields.method} ${fields.url || fields.path}，调用时间${fields.calledAt}`;
    case "request.completed": return `${feature}：HTTP请求${fields.result === "success" ? "成功" : "失败"}，${fields.operation || "监控数据接口"}，${fields.method} ${fields.url || fields.path}，状态码${fields.status ?? "未收到响应"}，调用时间${fields.calledAt}，返回时间${fields.returnedAt}，耗时${fields.durationMs}毫秒${fields.errorMessage ? `，原因：${fields.errorMessage}` : ""}`;
    case "prometheus.request.failed": return `${feature}：${fields.operation}失败，${fields.message}`;
    case "dashboard.initial.failed": return `监控首页：首次加载失败，${fields.message}`;
    case "request.unhandled": return `服务请求发生未处理异常：${fields.message}`;
    default: return String(fields.description || event);
  }
}

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
type Category = "business" | "http" | "error";
let lastCleanup = 0;
let activeDirectory = "";
let cleanupTimer: NodeJS.Timeout | undefined;

export function logDirectory() {
  const service = process.env.SERVICE_NAME || "operator-agent-service";
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) throw new Error("Invalid SERVICE_NAME");
  return process.env.LOG_DIR || `/var/serivce/${service}/log`;
}

export function cleanupLogs(directory = logDirectory(), now = Date.now()) {
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(/* turbopackIgnore: true */ directory)) {
    if (!/^(business|http|error)-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const file = join(directory, name);
    const stat = statSync(file);
    if (stat.isFile() && now - stat.mtimeMs >= RETENTION_MS) unlinkSync(file);
  }
}

function write(category: Category, event: string, fields: Record<string, unknown>) {
  const now = new Date();
  fields = { ...logContext.getStore(), ...fields };
  const description = describe(event, fields).replace(/[\r\n]/g, " ");
  const timestamp = now.toISOString();
  const categoryLabel = { business: "业务日志", http: "HTTP请求日志", error: "报错日志" }[category];
  const record = `[${timestamp}] [${category === "error" ? "ERROR" : "INFO"}] [${categoryLabel}] ${description} | ${JSON.stringify({ ...fields, timestamp, category, event, description })}`;
  if (category === "error") console.error(record);
  try {
    const directory = logDirectory();
    if (directory !== activeDirectory || now.getTime() - lastCleanup >= 60 * 60 * 1000) {
      cleanupLogs(directory, now.getTime());
      activeDirectory = directory;
      lastCleanup = now.getTime();
    }
    if (!cleanupTimer) {
      cleanupTimer = setInterval(() => {
        try { cleanupLogs(); }
        catch (error) { console.error("Log cleanup failed", error); }
      }, 60 * 60 * 1000);
      cleanupTimer.unref();
    }
    appendFileSync(join(directory, `${category}-${now.toISOString().slice(0, 10)}.log`), `${record}\n`, { mode: 0o640 });
  } catch (error) {
    // Logging failures must remain visible without breaking monitoring requests.
    console.error("Log write failed", error);
  }
}

export const businessLog = (event: string, fields: Record<string, unknown> = {}) => write("business", event, fields);
export const httpLog = (event: string, fields: Record<string, unknown>) => write("http", event, fields);
export function errorLog(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const exception = error instanceof Error ? error : new Error(String(error));
  write("error", event, { ...fields, message: exception.message, stack: exception.stack || new Error(exception.message).stack });
}
