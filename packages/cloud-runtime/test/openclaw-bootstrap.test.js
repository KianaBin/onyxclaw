import assert from "node:assert/strict";
import test from "node:test";

import {
  BootstrapError,
  OpenClawBootstrapSaga,
} from "../src/openclaw-bootstrap.js";

function fixture({ writeFailure } = {}) {
  const calls = [];
  const adapter = {
    async createSandbox(options) {
      calls.push(["create", options]);
      return { sandboxId: "sandbox-1", status: "running" };
    },
    async writeFile(sandboxId, path, content) {
      calls.push(["write", sandboxId, path, content]);
      if (writeFailure) throw writeFailure;
    },
    async killSandbox(sandboxId) {
      calls.push(["kill", sandboxId]);
    },
  };
  const channel = {
    async issueBootstrapToken(instanceId, token) {
      calls.push(["issue-token", instanceId, token]);
    },
    async waitForConnection(instanceId) {
      calls.push(["wait-channel", instanceId]);
      return { connectionId: "connection-1" };
    },
    async revokeBootstrapToken(instanceId) {
      calls.push(["revoke-token", instanceId]);
    },
  };
  const gateway = {
    async waitUntilReady(sandboxId, options) {
      calls.push(["wait-gateway", sandboxId, options]);
      return { ready: true };
    },
  };
  const transitions = [];
  const saga = new OpenClawBootstrapSaga({
    adapter,
    channel,
    gateway,
    gatewayPort: 18789,
    instanceIdFactory: () => "instance-1",
    tokenFactory: () => "bootstrap-secret",
    traceIdFactory: () => "trace-1",
    onTransition: (transition) => transitions.push(transition),
  });
  return { calls, saga, transitions };
}

test("provisions OpenClaw and returns only public ready state", async () => {
  const { calls, saga, transitions } = fixture();
  const result = await saga.provision({
    soul: "# Friendly lobster",
    buildConfig: ({ instanceId, bootstrapToken }) => ({
      instanceId,
      bootstrapToken,
      modelApiKey: "model-secret",
    }),
  });

  assert.deepEqual(result, {
    sandboxId: "sandbox-1",
    instanceId: "instance-1",
    connectionId: "connection-1",
    traceId: "trace-1",
    status: "ready",
  });
  assert.doesNotMatch(JSON.stringify(result), /bootstrap-secret|model-secret/);
  assert.deepEqual(transitions.map(({ phase }) => phase), [
    "ALLOCATING",
    "PREPARING",
    "PREPARED",
    "BOOTSTRAPPING",
    "GATEWAY_READY",
    "CHANNEL_READY",
    "READY",
  ]);
  assert.deepEqual(calls.slice(0, 2), [
    ["create", { metadata: { traceId: "trace-1", instanceId: "instance-1" } }],
    ["issue-token", "instance-1", "bootstrap-secret"],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === "write"), [
    [
      "write",
      "sandbox-1",
      "/home/node/.openclaw/openclaw.json",
      '{"instanceId":"instance-1","bootstrapToken":"bootstrap-secret","modelApiKey":"model-secret"}',
    ],
    [
      "write",
      "sandbox-1",
      "/home/node/.openclaw/workspace/SOUL.md",
      "# Friendly lobster",
    ],
  ]);
});

test("kills a partially initialized Sandbox and revokes its token", async () => {
  const { calls, saga, transitions } = fixture({
    writeFailure: new Error("write failed with model-secret"),
  });

  await assert.rejects(
    saga.provision({
      soul: "# Soul",
      buildConfig: () => ({ modelApiKey: "model-secret" }),
    }),
    (error) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.phase, "PREPARING");
      assert.doesNotMatch(error.message, /model-secret/);
      return true;
    },
  );
  assert.deepEqual(calls.slice(-2), [
    ["revoke-token", "instance-1"],
    ["kill", "sandbox-1"],
  ]);
  assert.equal(transitions.at(-1).phase, "FAILED");
});

test("rejects an empty personality before allocating cloud resources", async () => {
  const { calls, saga } = fixture();
  await assert.rejects(
    saga.provision({ soul: "  ", buildConfig: () => ({}) }),
    /SOUL\.md content is required/,
  );
  assert.deepEqual(calls, []);
});

test("bootstraps an already allocated Sandbox without creating another one", async () => {
  const { calls, saga } = fixture();
  const result = await saga.bootstrapSandbox({
    sandboxId: "existing-sandbox",
    instanceId: "existing-instance",
    traceId: "existing-trace",
    soul: "# Existing soul",
    buildConfig: () => ({ ready: true }),
  });

  assert.equal(result.sandboxId, "existing-sandbox");
  assert.equal(result.instanceId, "existing-instance");
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(
    calls.some((call) => call[0] === "write" && call[1] === "existing-sandbox"),
    true,
  );
  const writes = calls.filter(([name]) => name === "write");
  assert.deepEqual(writes.map((call) => call[2]), [
    "/home/node/.openclaw/workspace/SOUL.md",
  ]);
});

test("resume bootstrap failure preserves the Sandbox for a lifecycle retry", async () => {
  const { calls, saga } = fixture({ writeFailure: new Error("Session ID not found") });

  await assert.rejects(
    saga.bootstrapSandbox({
      sandboxId: "resumed-sandbox",
      instanceId: "existing-instance",
      traceId: "existing-trace",
      soul: "# Persistent soul",
      cleanupOnFailure: false,
    }),
    (error) => error instanceof BootstrapError,
  );

  assert.equal(calls.some(([name]) => name === "kill"), false);
  assert.equal(calls.some(([name]) => name === "revoke-token"), false);
});

test("prepares an allocated Sandbox by writing only openclaw.json", async () => {
  const { calls, saga } = fixture();
  const result = await saga.prepareSandbox({
    sandboxId: "existing-sandbox",
    instanceId: "existing-instance",
    traceId: "existing-trace",
    buildConfig: ({ bootstrapToken }) => ({ bootstrapToken }),
  });

  assert.equal(result.status, "prepared");
  const writes = calls.filter(([name]) => name === "write");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2], "/home/node/.openclaw/openclaw.json");
  assert.doesNotMatch(writes[0][3], /SOUL/);
});
