import assert from "node:assert/strict";
import { test } from "node:test";
import { getAlerts, getMonitor, getNodeStatus } from "../generated/api";

test("typed API client builds monitor request and returns JSON", async () => {
  const original = globalThis.fetch;
  let called = "";
  globalThis.fetch = async (input, init) => {
    called = String(input);
    assert.equal(init?.cache, "no-store");
    return Response.json({ mode: "demo", resources: [], alerts: [], trend: [], trendStep: 30,
      trendWindow: 300, stepSelection: "auto", updatedAt: "2026-11-11T00:00:00Z" });
  };
  try {
    const result = await getMonitor({ scope: "pods", minutes: 60, step: "auto" });
    assert.equal(called, "/api/monitor?scope=pods&minutes=60&step=auto");
    assert.equal(result.mode, "demo");
  } finally {
    globalThis.fetch = original;
  }
});

test("typed API client propagates server errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "数据库不可用" }, { status: 502 });
  try {
    await assert.rejects(getAlerts(), /数据库不可用/);
  } finally {
    globalThis.fetch = original;
  }
});

test("typed API client reports a non JSON response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("proxy failure", { status: 502 });
  try {
    await assert.rejects(getNodeStatus(), /非 JSON 响应（HTTP 502）/);
  } finally {
    globalThis.fetch = original;
  }
});
