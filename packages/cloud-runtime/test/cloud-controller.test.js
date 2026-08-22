import assert from "node:assert/strict";
import test from "node:test";

import { CloudConsoleController } from "../src/cloud-controller.js";

function fixture() {
  const calls = [];
  const adapter = {
    async createSandbox(options) {
      calls.push(["create", options]);
      return { sandboxId: "sandbox-1", status: "running" };
    },
    async connectSandbox(id) {
      calls.push(["connect", id]);
      return { sandboxId: id, status: "running" };
    },
    async killSandbox(id) {
      calls.push(["kill", id]);
    },
    async pauseSandbox(id) {
      calls.push(["pause", id]);
    },
  };
  const saga = {
    async prepareSandbox(options) {
      calls.push(["prepare", options]);
      return { ...options, status: "prepared" };
    },
    async bootstrapSandbox(options) {
      calls.push(["bootstrap", options]);
      return { ...options, connectionId: "connection-1", status: "ready" };
    },
  };
  const controller = new CloudConsoleController({
    adapter,
    saga,
    instanceIdFactory: () => "instance-1",
    traceIdFactory: () => "trace-1",
    defaultSoul: "# Default lobster",
    buildConfig: ({ instanceId }) => ({ instanceId }),
  });
  return { calls, controller };
}

test("new users allocate first, then bootstrap the same Sandbox after SOUL confirmation", async () => {
  const { calls, controller } = fixture();

  assert.deepEqual(await controller.startLobsterMode(), {
    mode: "allocated",
    currentStep: "soul",
    soulConfirmed: false,
    sandboxId: "sandbox-1",
    instanceId: "instance-1",
    connectionId: null,
    traceId: "trace-1",
    error: null,
  });
  const soul = await controller.getSoul();
  assert.equal(soul.content, "# Default lobster");
  await controller.confirmSoul("# Brave lobster");
  assert.equal(controller.getStatus().currentStep, "chat");
  assert.equal(controller.getStatus().soulConfirmed, true);
  assert.deepEqual(calls.map(([name]) => name), ["create", "prepare", "bootstrap"]);
  assert.equal(calls[1][1].sandboxId, "sandbox-1");
  assert.equal(calls[2][1].sandboxId, "sandbox-1");
});

test("existing users connect by Sandbox ID and skip personality confirmation", async () => {
  const { calls, controller } = fixture();
  const status = await controller.startLobsterMode({ sandboxId: "saved-sandbox" });

  assert.equal(status.mode, "connected");
  assert.equal(status.currentStep, "chat");
  assert.equal(status.soulConfirmed, true);
  assert.deepEqual(calls.map(([name]) => name), ["connect", "bootstrap"]);
});

test("existing users wait for the resumed OpenClaw Channel before chat is enabled", async () => {
  const { calls } = fixture();
  const controller = new CloudConsoleController({
    adapter: {
      async connectSandbox(id) {
        calls.push(["connect", id]);
        return { sandboxId: id, status: "running" };
      },
    },
    saga: {
      async bootstrapSandbox(options) {
        calls.push(["bootstrap", options]);
        return { connectionId: "resumed-connection" };
      },
    },
    buildConfig: () => ({}),
    timeoutMs: 30_000,
  });

  const status = await controller.startLobsterMode({
    sandboxId: "saved-sandbox",
    instanceId: "saved-claw",
  });

  assert.equal(calls[1][0], "bootstrap");
  assert.equal(calls[1][1].instanceId, "saved-claw");
  assert.equal(status.connectionId, "resumed-connection");
  assert.equal(status.mode, "connected");
});

test("pause and resume use the E2B lifecycle and bootstrap the persistent workspace again", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  await controller.confirmSoul("# Persistent lobster");

  const paused = await controller.pauseLobsterMode();
  assert.equal(paused.mode, "paused");
  assert.equal(paused.connectionId, null);

  const resumed = await controller.resumeLobsterMode();
  assert.equal(resumed.mode, "connected");
  assert.equal(resumed.connectionId, "connection-1");
  assert.deepEqual(calls.slice(-3).map(([name]) => name), [
    "pause",
    "connect",
    "bootstrap",
  ]);
  assert.equal(calls.at(-1)[1].soul, "# Persistent lobster");
});

test("a failed resume remains paused so the user can retry connect", async () => {
  let connectAttempts = 0;
  const controller = new CloudConsoleController({
    adapter: {
      async createSandbox() {
        return { sandboxId: "sandbox-1" };
      },
      async pauseSandbox() {},
      async connectSandbox() {
        connectAttempts += 1;
        if (connectAttempts === 1) throw new Error("temporary auth failure");
        return { sandboxId: "sandbox-1" };
      },
    },
    saga: {
      async prepareSandbox() {},
      async bootstrapSandbox() {
        return { connectionId: "connection-2" };
      },
    },
    buildConfig: () => ({}),
  });
  await controller.startLobsterMode();
  await controller.confirmSoul("# Retry lobster");
  await controller.pauseLobsterMode();

  await assert.rejects(controller.resumeLobsterMode(), /temporary auth failure/);
  assert.equal(controller.getStatus().mode, "paused");
  assert.equal(controller.getStatus().connectionId, null);

  const resumed = await controller.resumeLobsterMode();
  assert.equal(resumed.mode, "connected");
  assert.equal(resumed.connectionId, "connection-2");
});

test("stop kills the cloud Sandbox and resets the serial flow", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  const status = await controller.stopLobsterMode();

  assert.equal(status.mode, "idle");
  assert.equal(status.currentStep, "mode");
  assert.deepEqual(calls.at(-1), ["kill", "sandbox-1"]);
});

test("resetNewUser uses cloud cleanup and returns to onboarding", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  await controller.confirmSoul("# Confirmed");

  const reset = await controller.resetNewUser();

  assert.equal(reset.mode, "idle");
  assert.equal(reset.currentStep, "mode");
  assert.equal(reset.soulConfirmed, false);
  assert.deepEqual(calls.at(-1), ["kill", "sandbox-1"]);
});
