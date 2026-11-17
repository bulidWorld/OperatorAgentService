import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { businessLog, cleanupLogs, errorLog, httpLog, scheduleLog, withAccessLog, withLogContext } from "./logger";
import { getAlerts, query } from "./prometheus/http";

test("separate logs, stack traces, retention and outbound request results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kube-logs-"));
  const previous = { log: process.env.LOG_DIR, url: process.env.PROMETHEUS_URL, payload: process.env.HTTP_LOG_INCLUDE_PAYLOAD, fetch: globalThis.fetch, error: console.error, info: console.log };
  process.env.LOG_DIR = directory;
  process.env.PROMETHEUS_URL = "http://localhost:9090";
  const consoleRecords: string[] = [];
  console.error = (...args) => { consoleRecords.push(String(args[0])); };
  console.log = (...args) => { consoleRecords.push(String(args[0])); };
  try {
    businessLog("test.business");
    scheduleLog("test.schedule");
    withLogContext({ logTypes: ["schedule"] }, () => {
      httpLog("test.schedule.http", { direction: "outbound", method: "GET", path: "/scheduled" });
      errorLog("test.schedule.error", new Error("scheduled failure"));
    });
    errorLog("test.error", new Error("failure with stack"));
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "success", data: { alerts: [] } }));
    assert.deepEqual(await withLogContext({ traceId: "test-trace", feature: "Node节点资源监控" }, getAlerts), { alerts: [] });
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(getAlerts(), /HTTP 503/);
    globalThis.fetch = async () => { throw new Error("connection failed"); };
    await assert.rejects(getAlerts(), /connection failed/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "error", error: "bad query" }));
    await assert.rejects(getAlerts(), /bad query/);
    await withAccessLog(
      { method: "POST", url: "http://localhost/api/test?token=hidden" },
      "test.access",
      async () => ({ status: 204 }),
    );
    const records = (category: string) => readdirSync(directory)
      .filter(name => name.startsWith(`${category}-`))
      .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    assert.equal(records("business")[0].event, "test.business");
    assert.equal(records("business")[1].log_type, "schedule");
    assert.deepEqual(records("http")[0].log_type, ["schedule", "http"]);
    assert.deepEqual(records("error")[0].log_type, ["schedule", "exception"]);
    assert.match(records("error")[1].exceptionInfo, /Error: failure with stack\n\s+at/);
    assert.ok(consoleRecords.length > 4);
    for (const raw of consoleRecords) {
      const record = JSON.parse(raw);
      assert.ok(record.timestamp);
      assert.ok(["DEBUG", "INFO", "WARN", "ERROR"].includes(record.level));
      const logTypes = Array.isArray(record.log_type) ? record.log_type : [record.log_type];
      assert.ok(logTypes.every((logType: string) => ["business", "http", "access", "exception", "schedule"].includes(logType)));
    }
    const completed = records("http").filter(record => record.event === "request.completed");
    const started = records("http").filter(record => record.event === "request.started");
    assert.ok(started.length > 0);
    assert.ok(started.every(record => record.method && record.path && record.status === null && record.duration_ms === null));
    assert.equal(completed.length, 5);
    assert.equal(completed[0].trace_id, "test-trace");
    assert.match(completed[0].message, /Node节点资源监控：HTTP请求成功/);
    assert.equal(completed[0].operation, "Prometheus告警查询");
    assert.equal(completed[0].resultSummary.itemCount, 0);
    assert.equal(completed[0].requestParams, undefined);
    assert.equal(completed[0].responseResult, undefined);
    assert.match(completed[2].message, /connection failed/);
    const httpText = readFileSync(join(directory, readdirSync(directory).find(name => name.startsWith("http-"))!), "utf8");
    assert.doesNotMatch(httpText, /\[HTTP请求日志\]/);
    assert.deepEqual(completed.map(record => record.result), ["success", "error", "error", "error", "success"]);
    assert.equal(completed[1].status, 503);
    assert.equal(completed[1].level, "ERROR");
    assert.ok(completed.every(record => record.path && record.method && record.status !== undefined && record.duration_ms >= 0));
    assert.equal(completed[4].log_type, "access");
    assert.equal(completed[4].path, "/api/test");
    assert.equal(completed[4].status, 204);
    assert.equal(completed[4].duration_ms >= 0, true);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".log"))) {
      for (const line of readFileSync(join(directory, name), "utf8").trim().split("\n")) {
        const record = JSON.parse(line);
        assert.ok(record.timestamp && record.level && record.log_type);
      }
    }
    for (const record of completed) {
      assert.ok(Date.parse(record.returnedAt) >= Date.parse(record.calledAt));
      assert.ok(record.duration_ms >= 0);
    }
    const old = join(directory, "business-2020-01-01.log");
    const unrelated = join(directory, "keep.txt");
    writeFileSync(old, "old");
    writeFileSync(unrelated, "keep");
    const past = new Date(Date.now() - 15 * 86400000);
    utimesSync(old, past, past);
    cleanupLogs(directory);
    assert.ok(!readdirSync(directory).includes("business-2020-01-01.log"));
    assert.ok(readdirSync(directory).includes("keep.txt"));
    assert.ok(records("business").length > 0);

    process.env.HTTP_LOG_INCLUDE_PAYLOAD = "true";
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "success", data: { alerts: [{ state: "firing" }] } }));
    await getAlerts();
    const detailed = records("http").filter(record => record.event === "request.completed").at(-1);
    assert.deepEqual(detailed.requestParams, {});
    assert.deepEqual(detailed.responseResult, { status: "success", data: { alerts: [{ state: "firing" }] } });

    globalThis.fetch = async () => new Response(JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [], padding: "r".repeat(6000) },
    }));
    await query("q".repeat(6000));
    const detailedRecords = records("http");
    const truncatedRequest = detailedRecords.filter(record => record.event === "request.started").at(-1).requestParams;
    const truncatedResponse = detailedRecords.filter(record => record.event === "request.completed").at(-1).responseResult;
    assert.equal(typeof truncatedRequest, "string");
    assert.equal(typeof truncatedResponse, "string");
    assert.equal(truncatedRequest.length, 5000);
    assert.equal(truncatedResponse.length, 5000);
    assert.match(truncatedRequest, /\.\.\.\[已截断\]$/);
    assert.match(truncatedResponse, /\.\.\.\[已截断\]$/);
  } finally {
    if (previous.log === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = previous.log;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
    if (previous.payload === undefined) delete process.env.HTTP_LOG_INCLUDE_PAYLOAD; else process.env.HTTP_LOG_INCLUDE_PAYLOAD = previous.payload;
    globalThis.fetch = previous.fetch;
    console.error = previous.error;
    console.log = previous.info;
    rmSync(directory, { recursive: true, force: true });
  }
});
