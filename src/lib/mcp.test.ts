import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import Ajv from "ajv";

test("query_pod_details follows its advertised success and not-found contracts", async (t) => {
  const token = "pod-details-regression-test-token";
  const namespace = "default";
  const pod = "web-0";
  const podDetails = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { namespace, name: pod, uid: "pod-uid" },
    spec: { containers: [{ name: "web", image: "nginx" }] },
    status: { phase: "Running" },
  };

  const podPath = `/api/v1/namespaces/${namespace}/pods/${pod}`;
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    MCP_CALLERS_JSON: JSON.stringify([
      { callerId: "mcp-test", token, tools: ["mcp:read"] },
    ]),
    KUBERNETES_SERVICE_HOST: "kubernetes.test",
  };
  t.after(() => {
    process.env = originalEnv;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const readFile = fs.readFile;
  t.mock.method(fs, "readFile", (...args: Parameters<typeof readFile>) => {
    if (args[0] === "/var/run/secrets/kubernetes.io/serviceaccount/token")
      return Promise.resolve("test-service-account-token");
    if (args[0] === "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
      return Promise.resolve(Buffer.from("test-ca"));
    return readFile(...args);
  });
  let upstreamStatus = 200;
  const upstream = t.mock.method(
    https,
    "request",
    (options: https.RequestOptions, onResponse: (response: EventEmitter) => void) => {
      assert.equal(options.path, podPath);
      const request = new EventEmitter();
      return Object.assign(request, {
        setTimeout() {},
        end() {
          const response = Object.assign(new EventEmitter(), { statusCode: upstreamStatus });
          onResponse(response);
          const body = upstreamStatus === 404 ? { message: "Pod not found" } : podDetails;
          response.emit("data", Buffer.from(JSON.stringify(body)));
          response.emit("end");
        },
      });
    },
  );
  syncBuiltinESMExports();
  const { handleMcpRequest } = await import("./mcp/server");

  async function send(method: string, params?: Record<string, unknown>) {
    const response = await handleMcpRequest(new Request("http://localhost/api/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.error, undefined);
    return message.result;
  }

  const { tools } = await send("tools/list");
  const definition = tools.find((tool: { name: string }) => tool.name === "query_pod_details");
  assert.ok(definition?.outputSchema);

  const result = await send("tools/call", {
    name: "query_pod_details",
    arguments: { namespace, pod },
  });
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, podDetails);
  assert.equal(new Ajv().validate(definition.outputSchema, result.structuredContent), true);
  assert.deepEqual(result.content, [{
    type: "resource",
    resource: {
      uri: `k8s:///namespaces/${namespace}/pods/${pod}`,
      mimeType: "application/json",
      text: JSON.stringify(podDetails),
    },
  }]);

  upstreamStatus = 404;
  const failure = await send("tools/call", {
    name: "query_pod_details",
    arguments: { namespace, pod },
  });
  assert.equal(upstream.mock.callCount(), 2);
  assert.equal(failure.isError, false);
  assert.equal(failure.structuredContent.code, "POD_NOT_FOUND");
  assert.equal(typeof failure.structuredContent.errorMessage, "string");
  assert.deepEqual(failure.content, [{
    type: "text",
    text: JSON.stringify(failure.structuredContent),
  }]);
});
