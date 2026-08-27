import { randomUUID } from "node:crypto";

import { parseChannelEnvelope } from "./protocol.js";

export class ChannelPlatformSimulator {
  #bootstrapTokens = new Map();
  #sessions = new Map();
  #outboundEventIds = new Set();

  outboundEvents = [];

  issueBootstrapToken(instanceId, bootstrapToken) {
    if (!instanceId || !bootstrapToken) {
      throw new TypeError("instanceId and bootstrapToken are required");
    }
    this.#bootstrapTokens.set(instanceId, {
      value: bootstrapToken,
      used: false,
    });
  }

  revokeBootstrapToken(instanceId) {
    this.#bootstrapTokens.delete(instanceId);
  }

  resetInstance(instanceId) {
    this.#bootstrapTokens.delete(instanceId);
    for (const [sessionToken, session] of this.#sessions) {
      if (session.instanceId === instanceId) this.#sessions.delete(sessionToken);
    }
    this.outboundEvents = this.outboundEvents.filter(
      (event) => event.instanceId !== instanceId,
    );
  }

  register({ instanceId, accountId, bootstrapToken, pluginVersion }) {
    const issued = this.#bootstrapTokens.get(instanceId);
    if (!issued || issued.value !== bootstrapToken) {
      throw new Error("invalid bootstrap token");
    }
    if (issued.used) {
      throw new Error("bootstrap token already used");
    }
    if (!accountId || !pluginVersion) {
      throw new TypeError("accountId and pluginVersion are required");
    }

    issued.used = true;
    const sessionToken = `channel_${randomUUID()}`;
    this.#sessions.set(sessionToken, { instanceId, accountId, pluginVersion });
    return { sessionToken, connectionId: randomUUID() };
  }

  reconnect({ instanceId, accountId, sessionToken, pluginVersion }) {
    const session = this.#sessions.get(sessionToken);
    if (!session) {
      throw new Error("invalid channel session token");
    }
    if (session.instanceId !== instanceId || session.accountId !== accountId) {
      throw new Error("channel session does not belong to this instance and account");
    }
    if (session.pluginVersion !== pluginVersion) {
      throw new Error("plugin version changed during channel session");
    }
    return { sessionToken, connectionId: randomUUID() };
  }

  acceptOutbound(sessionToken, input) {
    const session = this.#sessions.get(sessionToken);
    if (!session) {
      throw new Error("invalid channel session token");
    }
    const event = parseChannelEnvelope(input);
    if (event.eventType !== "message.outbound") {
      throw new Error("expected message.outbound event");
    }
    if (event.instanceId !== session.instanceId || event.accountId !== session.accountId) {
      throw new Error("channel event does not belong to this session");
    }

    if (this.#outboundEventIds.has(event.eventId)) {
      return { eventId: event.eventId, duplicate: true };
    }
    this.#outboundEventIds.add(event.eventId);
    this.outboundEvents.push(event);
    return { eventId: event.eventId, duplicate: false };
  }
}
