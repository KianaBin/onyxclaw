import assert from "node:assert/strict";
import test from "node:test";

import { ChannelPlatformSimulator } from "../src/simulator-core.js";

test("bootstrap token can register exactly once", () => {
  const simulator = new ChannelPlatformSimulator();
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");

  const session = simulator.register({
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
  });

  assert.match(session.sessionToken, /^channel_/);
  assert.throws(
    () =>
      simulator.register({
        instanceId: "local-mac",
        accountId: "default",
        bootstrapToken: "bootstrap-secret",
        pluginVersion: "0.1.0",
      }),
    /already used/,
  );
});

test("duplicate outbound event is acknowledged once and stored once", () => {
  const simulator = new ChannelPlatformSimulator();
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");
  const { sessionToken } = simulator.register({
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
  });
  const event = {
    protocolVersion: "1",
    eventId: "out-1",
    eventType: "message.outbound",
    timestamp: "2026-07-18T00:00:00.000Z",
    instanceId: "local-mac",
    accountId: "default",
    payload: { chatId: "phase0", text: "pong" },
  };

  const first = simulator.acceptOutbound(sessionToken, event);
  const duplicate = simulator.acceptOutbound(sessionToken, event);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(simulator.outboundEvents.length, 1);
});

test("session token reconnects only the original instance and account", () => {
  const simulator = new ChannelPlatformSimulator();
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");
  const session = simulator.register({
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
  });

  const reconnected = simulator.reconnect({
    instanceId: "local-mac",
    accountId: "default",
    sessionToken: session.sessionToken,
    pluginVersion: "0.1.0",
  });

  assert.notEqual(reconnected.connectionId, session.connectionId);
  assert.equal(reconnected.sessionToken, session.sessionToken);
  assert.throws(
    () =>
      simulator.reconnect({
        instanceId: "other-instance",
        accountId: "default",
        sessionToken: session.sessionToken,
        pluginVersion: "0.1.0",
      }),
    /does not belong/,
  );
});

test("resetInstance revokes bootstrap and session tokens for only that instance", () => {
  const simulator = new ChannelPlatformSimulator();
  simulator.issueBootstrapToken("old-instance", "old-bootstrap");
  simulator.issueBootstrapToken("other-instance", "other-bootstrap");
  const oldSession = simulator.register({
    instanceId: "old-instance",
    accountId: "default",
    bootstrapToken: "old-bootstrap",
    pluginVersion: "0.1.0",
  });

  simulator.resetInstance("old-instance");

  assert.throws(() => simulator.reconnect({
    instanceId: "old-instance",
    accountId: "default",
    sessionToken: oldSession.sessionToken,
    pluginVersion: "0.1.0",
  }), /invalid channel session token/);
  assert.doesNotThrow(() => simulator.register({
    instanceId: "other-instance",
    accountId: "default",
    bootstrapToken: "other-bootstrap",
    pluginVersion: "0.1.0",
  }));
});
