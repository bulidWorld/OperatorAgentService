import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { alertResource, applyWebhook, getPushedAlerts, parseWebhook } from "./alertmanager";

test("Alertmanager payload rejects invalid alert fields", () => {
  assert.throws(() => parseWebhook({ version: "3", alerts: [] }));
  assert.throws(() => parseWebhook({ version: "4", alerts: [{ status: "firing", labels: {}, annotations: {}, startsAt: "invalid" }] }));
});

test("Alertmanager payload retains object labels and webhook metadata", () => {
  const alerts = parseWebhook({
    version: "4", receiver: "operations", groupKey: "{}:{namespace=\"prod\"}",
    groupLabels: { namespace: "prod" }, commonLabels: { severity: "critical" },
    commonAnnotations: { summary: "Pods unavailable" }, externalURL: "https://alerts.example.test",
    truncatedAlerts: 0,
    alerts: [{
      status: "firing", fingerprint: "pod-1", labels: { alertname: "PodDown", pod: "api-1", namespace: "prod" },
      annotations: { summary: "Pod unavailable" }, startsAt: "2026-11-11T01:00:00Z",
      generatorURL: "https://prometheus.example.test/graph", values: { A: 1 },
    }],
  });
  assert.deepEqual(alertResource(alerts[0].labels), { type: "Pod", name: "api-1", namespace: "prod" });
  assert.deepEqual(alertResource({ node: "worker-1" }), { type: "Node", name: "worker-1", namespace: null });
  assert.equal(alerts[0].generatorURL, "https://prometheus.example.test/graph");
  assert.deepEqual(alerts[0].rawAlert.values, { A: 1 });
  assert.equal(alerts[0].webhookContext.receiver, "operations");
  assert.deepEqual(alerts[0].webhookContext.groupLabels, { namespace: "prod" });
});

test("PostgreSQL persists firing and resolved alerts", { skip: !process.env.TEST_DATABASE }, async () => {
  const fingerprint = `test-${randomUUID()}`;
  const payload = { version: "4", receiver: "operations", alerts: [{
    status: "firing", fingerprint, labels: { alertname: "PodDown", pod: "api-1", namespace: "prod", severity: "critical" },
    annotations: { summary: "Pod is down" }, startsAt: "2026-11-11T01:00:00Z",
    generatorURL: "https://prometheus.example.test/graph",
  }] };
  try {
    const firing = parseWebhook(payload);
    await applyWebhook(firing);
    await applyWebhook(firing);
    const matching = (await getPushedAlerts()).filter((alert) => alert.fingerprint === fingerprint);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].labels.alertname, "PodDown");
    assert.equal(matching[0].resourceType, "Pod");
    assert.equal(matching[0].resourceName, "api-1");
    assert.equal(matching[0].namespace, "prod");
    assert.equal(matching[0].webhookContext.receiver, "operations");
    assert.equal(matching[0].generatorURL, "https://prometheus.example.test/graph");
  } finally {
    await applyWebhook(parseWebhook({ ...payload, alerts: [{ ...payload.alerts[0], status: "resolved" }] }));
  }
  assert.equal((await getPushedAlerts()).some((alert) => alert.fingerprint === fingerprint), false);
});
