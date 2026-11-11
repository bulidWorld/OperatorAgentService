import { test } from "node:test";
import assert from "node:assert/strict";
import { getNodeDetail, nodeDetailQueries, nodeSelector, scalar } from "./node-detail";

test("node performance queries select the exact instance and escape label contents", () => {
  const instance = 'node"\\host';
  assert.equal(nodeSelector(instance), `instance=${JSON.stringify(instance)}`);
  for (const expression of Object.values(nodeDetailQueries(instance))) {
    assert.ok(expression.includes(nodeSelector(instance)));
  }
  assert.match(nodeDetailQueries("k8s").diskRead, /rate\(node_disk_read_bytes_total/);
  assert.match(nodeDetailQueries("k8s").diskWrite, /rate\(node_disk_written_bytes_total/);
  assert.equal(scalar([]), null);
  assert.equal(scalar([{ metric: {}, value: [1, "NaN"] }]), null);
  assert.equal(scalar([{ metric: {}, value: [1, "0"] }]), 0);
});

test("node details preserve successful metrics when a disk query fails", async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.PROMETHEUS_URL };
  process.env.PROMETHEUS_URL = "http://prometheus:9090";
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/query_range");
      assert.equal(url.searchParams.get("step"), "30");
      assert.equal(Number(url.searchParams.get("end")) - Number(url.searchParams.get("start")), 3600);
      const expression = url.searchParams.get("query")!;
      if (expression.includes("node_disk_read_bytes_total")) throw new Error("read metric unavailable");
      return Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[1, "12"]] }] } });
    };
    const detail = await getNodeDetail("worker-01");
    assert.deepEqual(detail.metrics.cpu[0].values, [[1, "12"]]);
    assert.equal(detail.step, 30);
    assert.equal(detail.windowSeconds, 300);
    assert.deepEqual(detail.metrics.diskRead, []);
    assert.deepEqual(detail.warnings, ["diskRead"]);
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    await assert.rejects(getNodeDetail("worker-01"), /节点性能指标查询失败/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
  }
});

test("longer ranges change query_range step and PromQL rate window together", async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.PROMETHEUS_URL };
  process.env.PROMETHEUS_URL = "http://prometheus:9090";
  try {
    globalThis.fetch = async input => {
      const params = new URL(String(input)).searchParams;
      assert.equal(params.get("step"), "720");
      assert.equal(Number(params.get("end")) - Number(params.get("start")), 86400);
      const expression = params.get("query")!;
      if (expression.includes("rate(")) assert.ok(expression.includes("[2880s]"));
      return Response.json({ status: "success", data: { resultType: "matrix", result: [] } });
    };
    const detail = await getNodeDetail("k8s", 1440);
    assert.equal(detail.step, 720);
    assert.equal(detail.windowSeconds, 2880);
    await assert.rejects(getNodeDetail("k8s", 123), /无效的时间范围/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
  }
});

test("each node panel uses its own time range, step, and rate window", async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.PROMETHEUS_URL };
  process.env.PROMETHEUS_URL = "http://prometheus:9090";
  try {
    globalThis.fetch = async input => {
      const params = new URL(String(input)).searchParams;
      const expression = params.get("query")!;
      if (expression.includes("node_network_")) {
        assert.equal(params.get("step"), "300");
        assert.equal(Number(params.get("end")) - Number(params.get("start")), 86400);
        assert.match(expression, /\[1200s\]/);
      } else {
        assert.equal(params.get("step"), "30");
        assert.equal(Number(params.get("end")) - Number(params.get("start")), 3600);
      }
      return Response.json({ status: "success", data: { resultType: "matrix", result: [] } });
    };
    const detail = await getNodeDetail("k8s", 60, "auto", { network: { minutes: 1440, step: 300 } });
    assert.equal(detail.groups.network.stepSeconds, 300);
    assert.equal(detail.groups.cpu.stepSeconds, 30);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
  }
});

test("custom start and end times are used for the selected panel", async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.PROMETHEUS_URL };
  process.env.PROMETHEUS_URL = "http://prometheus:9090";
  const to = Math.floor(Date.now() / 1000) - 60;
  const from = to - 7200;
  try {
    globalThis.fetch = async input => {
      const params = new URL(String(input)).searchParams;
      if (params.get("query")!.includes("node_network_")) {
        assert.equal(Number(params.get("start")), from);
        assert.equal(Number(params.get("end")), to);
        assert.equal(params.get("step"), "60");
      }
      return Response.json({ status: "success", data: { resultType: "matrix", result: [] } });
    };
    const detail = await getNodeDetail("k8s", 60, "auto", { network: { minutes: 60, step: "auto", from, to } });
    assert.equal(detail.groups.network.start, from);
    assert.equal(detail.groups.network.end, to);
    assert.equal(detail.groups.cpu.stepSeconds, 30);
    await assert.rejects(getNodeDetail("k8s", 60, "auto", { network: { minutes: 60, step: "auto", from: to, to: from } }), /无效的起始或结束时间/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.PROMETHEUS_URL; else process.env.PROMETHEUS_URL = previous.url;
  }
});
