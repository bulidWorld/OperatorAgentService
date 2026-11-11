import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNodeInventory, mergeResources, namespaceFilter } from "./business";
import { query } from "./http";
test("merges pods by namespace and name, retaining missing data as null", () => {
  const rows = mergeResources("pods", [
    [
      { metric: { pod: "api", namespace: "a" }, value: [1, "0.5"] },
      { metric: { pod: "api", namespace: "b" }, value: [1, "NaN"] },
    ],
    [],
    [],
    [{ metric: { pod: "api", namespace: "b" }, value: [1, "0"] }],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cpu, 0.5);
  assert.equal(rows[0].memory, null);
  assert.equal(rows[0].ready, null);
  assert.equal(rows[1].cpu, null);
  assert.equal(rows[1].ready, false);
});
test("namespace selectors escape user input", () => {
  assert.equal(namespaceFilter('a"b\\c'), ',namespace="a\\"b\\\\c"');
  assert.equal(namespaceFilter(), "");
});
test("node inventory includes nodes without exporter metrics and maps up by internal IP", () => {
  const existing = mergeResources("nodes", [
    [{ metric: { instance: "10.0.0.1:9100" }, value: [1, "42"] }], [], [], [],
  ]);
  const rows = mergeNodeInventory(existing, [
    { metric: { node: "worker-1", internal_ip: "10.0.0.1" } },
    { metric: { node: "worker-2", internal_ip: "10.0.0.2" } },
    { metric: { node: "worker-3", internal_ip: "10.0.0.3" } },
  ], [
    { metric: { instance: "10.0.0.1:9100" }, value: [1, "1"] },
    { metric: { instance: "10.0.0.2:9100" }, value: [1, "0"] },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cpu, 42);
  assert.deepEqual(rows.map((row) => row.ready), [true, false, null]);
});
test("HTTP adapter passes query and bearer token and rejects upstream errors", async () => {
  const previous = {
    url: process.env.PROMETHEUS_URL,
    token: process.env.PROMETHEUS_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.PROMETHEUS_URL = "http://prometheus:9090";
  process.env.PROMETHEUS_TOKEN = "test-token";
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(
        new URL(String(input)).searchParams.get("query"),
        'up{job="node"}',
      );
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-token",
      );
      return Response.json({
        status: "success",
        data: { resultType: "vector", result: [] },
      });
    };
    assert.deepEqual((await query('up{job="node"}')).result, []);
    globalThis.fetch = async () =>
      Response.json({ status: "error", error: "bad expression" });
    await assert.rejects(query("up"), /bad expression/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL;
    else process.env.PROMETHEUS_URL = previous.url;
    if (previous.token === undefined) delete process.env.PROMETHEUS_TOKEN;
    else process.env.PROMETHEUS_TOKEN = previous.token;
  }
});

test("merges node memory exporter labels with CPU, network and availability by instance", () => {
  const names = ["k8s", "worker-01", "worker-02"];
  const rows = mergeResources("nodes", [
    names.map(instance => ({ metric: { instance }, value: [1, "6.4"] })),
    names.map(instance => ({
      metric: { instance, namespace: "monitoring", pod: `node-exporter-${instance}`, job: "node-exporter" },
      value: [1, "30.3"],
    })),
    names.map(instance => ({ metric: { instance }, value: [1, "8192"] })),
    names.map(instance => ({ metric: { instance }, value: [1, "1"] })),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.name), names);
  for (const row of rows) {
    assert.equal(row.namespace, "");
    assert.equal(row.cpu, 6.4);
    assert.equal(row.memory, 30.3);
    assert.equal(row.network, 8192);
    assert.equal(row.ready, true);
  }
});

test("node metrics retain missing values and keep distinct instances separate", () => {
  const rows = mergeResources("nodes", [
    [{ metric: { instance: "k8s" }, value: [1, "5"] }],
    [{ metric: { instance: "worker-01", namespace: "monitoring" }, value: [1, "25"] }],
    [], [],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].memory, null);
  assert.equal(rows[1].cpu, null);
  assert.equal(rows[1].memory, 25);
});
