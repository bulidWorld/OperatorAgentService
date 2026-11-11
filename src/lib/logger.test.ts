import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { businessLog, cleanupLogs, errorLog, withLogContext } from "./logger";
import { getAlerts } from "./prometheus/http";

test("separate logs, stack traces, retention and outbound request results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kube-logs-"));
  const previous = { log: process.env.LOG_DIR, url: process.env.PROMETHEUS_URL, fetch: globalThis.fetch, error: console.error };
  process.env.LOG_DIR = directory;
  process.env.PROMETHEUS_URL = "http://localhost:9090";
  const consoleRecords: unknown[][] = [];
  console.error = (...args) => { consoleRecords.push(args); };
  try {
    businessLog("test.business");
    errorLog("test.error", new Error("failure with stack"));
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "success", data: { alerts: [] } }));
    assert.deepEqual(await withLogContext({ traceId: "test-trace", feature: "Node节点资源监控" }, getAlerts), { alerts: [] });
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(getAlerts(), /HTTP 503/);
    globalThis.fetch = async () => { throw new Error("connection failed"); };
    await assert.rejects(getAlerts(), /connection failed/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "error", error: "bad query" }));
    await assert.rejects(getAlerts(), /bad query/);
    const records = (category: string) => readdirSync(directory)
      .filter(name => name.startsWith(`${category}-`))
      .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line.slice(line.indexOf(" | ") + 3))));
    assert.equal(records("business")[0].event, "test.business");
    assert.match(records("error")[0].stack, /Error: failure with stack\n\s+at/);
    assert.equal(consoleRecords.length, 4);
    const completed = records("http").filter(record => record.event === "request.completed");
    assert.equal(completed.length, 4);
    assert.equal(completed[0].traceId, "test-trace");
    assert.match(completed[0].description, /Node节点资源监控：HTTP请求成功/);
    assert.equal(completed[0].operation, "Prometheus告警查询");
    assert.equal(completed[0].resultSummary.itemCount, 0);
    assert.match(completed[2].description, /connection failed/);
    const httpText = readFileSync(join(directory, readdirSync(directory).find(name => name.startsWith("http-"))!), "utf8");
    assert.match(httpText, /\[HTTP请求日志\] Node节点资源监控：发起HTTP请求/);
    assert.deepEqual(completed.map(record => record.result), ["success", "error", "error", "error"]);
    assert.equal(completed[1].status, 503);
    for (const record of completed) {
      assert.ok(Date.parse(record.returnedAt) >= Date.parse(record.calledAt));
      assert.ok(record.durationMs >= 0);
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
  } finally {
    if (previous.log === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = previous.log;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
    globalThis.fetch = previous.fetch;
    console.error = previous.error;
    rmSync(directory, { recursive: true, force: true });
  }
});
