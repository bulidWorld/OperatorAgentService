import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const logContext = new AsyncLocalStorage<Record<string, unknown>>();
/** 在当前异步调用链中附加日志字段，并在 action 完成后恢复原上下文。
 * @param fields 要附加到本次调用链日志中的字段。
 * @param action 需要在新日志上下文中执行的同步或异步操作。
 * @returns action 的返回值；action 抛出的异常会继续向调用方传播。
 */
export function withLogContext<T>(fields: Record<string, unknown>, action: () => T): T {
  return logContext.run({ traceId: randomUUID(), ...logContext.getStore(), ...fields }, action);
}

/** 将日志事件和字段转换为面向运维人员的中文说明。
 * @param event 日志事件标识。
 * @param fields 事件附带的结构化日志字段。
 * @returns 可读的日志说明文本。
 */
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

/** 返回当前服务使用的日志目录。
 * @returns LOG_DIR 配置值或服务默认日志目录。
 * @throws SERVICE_NAME 含非法字符时抛出错误。
 */
export function logDirectory() {
  const service = process.env.SERVICE_NAME || "operator-agent-service";
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) throw new Error("Invalid SERVICE_NAME");
  return process.env.LOG_DIR || `/var/service/${service}/log`;
}

/** 删除超过保留期限的服务日志文件。
 * @param directory 要清理的目录，默认使用服务日志目录。
 * @param now 当前时间的毫秒时间戳，默认使用系统当前时间。
 * @returns 无返回值；目录不存在时会先创建目录。
 */
export function cleanupLogs(directory = logDirectory(), now = Date.now()) {
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(/* turbopackIgnore: true */ directory)) {
    if (!/^(business|http|error)-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const file = join(directory, name);
    const stat = statSync(file);
    if (stat.isFile() && now - stat.mtimeMs >= RETENTION_MS) unlinkSync(file);
  }
}

/** 格式化并写入一条业务、HTTP 或错误日志。
 * @param category 日志分类，决定文件名和日志级别。
 * @param event 日志事件标识。
 * @param fields 与事件相关的结构化字段。
 * @returns 无返回值；写入失败时将错误输出到控制台。
 */
function write(category: Category, event: string, fields: Record<string, unknown>) {
  const now = new Date();
  fields = { ...logContext.getStore(), ...fields };
  const description = describe(event, fields).replace(/[\r\n]/g, " ");
  const timestamp = now.toISOString();
  const inferredLevel = fields.level ?? (
    fields.result === "error"
      ? fields.status === null || fields.status === undefined || Number(fields.status) >= 500 ? "ERROR" : "WARN"
      : Number(fields.status) >= 500 ? "ERROR"
        : Number(fields.status) >= 400 ? "WARN"
          : "INFO"
  );
  const requestedLevel = String(inferredLevel).toUpperCase();
  const level = category === "error" ? "ERROR"
    : ["DEBUG", "WARN", "ERROR"].includes(requestedLevel) ? requestedLevel : "INFO";
  const logType = category === "error" ? "exception"
    : category === "http" && fields.direction === "inbound" ? "access"
    : category;
  const path = typeof fields.path === "string"
    ? fields.path
    : typeof fields.url === "string"
      ? (() => { try { return new URL(fields.url).pathname; } catch { return fields.url; } })()
      : null;
  const { stack, traceId, durationMs, ...recordFields } = fields;
  const structuredRecord = JSON.stringify({
    ...recordFields,
    timestamp,
    level,
    log_type: logType,
    trace_id: traceId ?? fields.trace_id,
    ...(logType === "http" || logType === "access" ? {
      method: fields.method ?? null,
      path,
      status: fields.status ?? null,
      duration_ms: durationMs ?? fields.duration_ms ?? null,
    } : durationMs !== undefined || fields.duration_ms !== undefined
      ? { duration_ms: durationMs ?? fields.duration_ms }
      : {}),
    exceptionInfo: category === "error" ? stack : undefined,
    message: description,
    event,
  });
  if (category === "error") console.error(structuredRecord);
  else console.log(structuredRecord);
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
        catch (error) { writeInternalException("logger.cleanup.failed", error); }
      }, 60 * 60 * 1000);
      cleanupTimer.unref();
    }
    appendFileSync(join(directory, `${category}-${now.toISOString().slice(0, 10)}.log`), `${structuredRecord}\n`, { mode: 0o640 });
  } catch (error) {
    // Logging failures must remain visible without breaking monitoring requests.
    writeInternalException("logger.write.failed", error);
  }
}

/** 将日志系统自身错误作为 JSON 异常输出，避免回退成不合规范的文本日志。 */
function writeInternalException(event: string, error: unknown) {
  const exception = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "ERROR",
    log_type: "exception",
    message: exception.message,
    exceptionInfo: exception.stack,
    event,
  }));
}

/** 写入业务日志。
 * @param event 业务事件标识。
 * @param fields 业务事件字段，默认为空对象。
 * @returns 无返回值。
 */
export const businessLog = (event: string, fields: Record<string, unknown> = {}) => write("business", event, fields);
/** 写入 HTTP 入站或出站日志。
 * @param event HTTP 日志事件标识。
 * @param fields 请求、响应及耗时字段。
 * @returns 无返回值。
 */
export const httpLog = (event: string, fields: Record<string, unknown>) => write("http", event, fields);
/** 记录入站请求的开始、状态和耗时，并为请求链附加 traceId。
 * @param request HTTP 方法和完整 URL。
 * @param operation 面向业务的接口名称。
 * @param action 返回 Response 的请求处理函数。
 * @returns action 返回的 Response；异常会记录后继续抛出。
 */
export async function withAccessLog<T extends { status: number }>(
  request: { method: string; url: string },
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const requestId = randomUUID();
  const traceId = requestId;
  const calledAt = new Date().toISOString();
  const started = performance.now();
  const context = {
    requestId, traceId, direction: "inbound", method: request.method,
    path: new URL(request.url).pathname, operation, calledAt,
  };
  return withLogContext({ requestId, traceId, operation }, async () => {
    httpLog("request.started", context);
    let status = 500;
    let errorMessage: string | undefined;
    try {
      const response = await action();
      status = response.status;
      return response;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      errorLog("request.unhandled", error, context);
      throw error;
    } finally {
      httpLog("request.completed", {
        ...context, returnedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started), status,
        result: status < 400 ? "success" : "error", errorMessage,
      });
    }
  });
}
/** 写入异常日志，包括异常消息和堆栈。
 * @param event 异常事件标识。
 * @param error 捕获到的异常或其他错误值。
 * @param fields 与异常相关的上下文，默认为空对象。
 * @returns 无返回值。
 */
export function errorLog(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const exception = error instanceof Error ? error : new Error(String(error));
  write("error", event, {
    ...fields,
    description: fields.description ?? exception.message,
    message: exception.message,
    stack: exception.stack || new Error(exception.message).stack,
  });
}

/** 开始记录一次出站 HTTP 请求，并返回用于写入最终状态和耗时的完成函数。
 * @param fields 请求方法、路径、操作名及关联上下文；不得包含认证头或敏感凭证。
 * @returns 接收响应状态和可选异常、并只完成一次日志记录的函数。
 */
export function beginHttpLog(fields: Record<string, unknown>) {
  const started = performance.now();
  const context = {
    requestId: typeof fields.requestId === "string" ? fields.requestId : randomUUID(),
    traceId: logContext.getStore()?.traceId ?? randomUUID(),
    direction: "outbound",
    calledAt: new Date().toISOString(),
    ...fields,
  };
  httpLog("request.started", context);
  let completed = false;
  return (status?: number, error?: unknown) => {
    if (completed) return;
    completed = true;
    const errorMessage = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    httpLog("request.completed", {
      ...context,
      returnedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      status: status ?? null,
      result: !error && status !== undefined && status >= 200 && status < 400 ? "success" : "error",
      errorMessage,
    });
    if (error) errorLog("outbound.request.failed", error, context);
  };
}

/** 包装一次出站 HTTP 操作，自动记录开始、状态、耗时和异常。
 * @param fields 请求方法、路径、操作名及关联上下文；不得包含认证头或敏感凭证。
 * @param action 要执行的同步或异步操作；返回值若含数值 status 字段，会作为响应状态记录。
 * @returns action 的结果；action 抛出的异常会先记录再继续向调用方传播。
 */
export async function withHttpLog<T>(
  fields: Record<string, unknown>,
  action: () => T | Promise<T>,
): Promise<T> {
  const finishLog = beginHttpLog(fields);
  try {
    const result = await action();
    const status = result && typeof result === "object" && "status" in result
      && typeof result.status === "number"
      ? result.status
      : undefined;
    finishLog(status);
    return result;
  } catch (error) {
    finishLog(undefined, error);
    throw error;
  }
}

/** 将出站 HTTP 日志包装为 TypeScript 方法装饰器。
 * @param getFields 根据方法参数生成请求方法、路径、操作名等日志字段。
 * @returns 自动记录请求生命周期的异步方法装饰器。
 */
export function HttpLog(getFields: (...args: any[]) => Record<string, unknown>) {
  return function <This, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Promise<Result>,
    _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Result>>,
  ) {
    return function (this: This, ...args: Args) {
      return withHttpLog(getFields(...args), () => method.apply(this, args));
    };
  };
}
