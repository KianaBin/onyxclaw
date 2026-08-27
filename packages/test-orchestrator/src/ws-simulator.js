import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

import { createEnvelope, parseChannelEnvelope } from "./protocol.js";
import { ChannelPlatformSimulator } from "./simulator-core.js";

function deferred(timeoutMs, label) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  timer.unref?.();
  return {
    promise,
    resolve(value) {
      clearTimeout(timer);
      resolve(value);
    },
    reject(error) {
      clearTimeout(timer);
      reject(error);
    },
  };
}

export class WsPlatformSimulator {
  #port;
  #host;
  #server;
  #core = new ChannelPlatformSimulator();
  #connections = new Map();
  #connectionWaiters = new Map();
  #outboundWaiters = new Map();
  #nextOutboundWaiters = [];
  #unconsumedOutbound = [];

  constructor({ port = 0, host = "127.0.0.1" } = {}) {
    this.#port = port;
    this.#host = host;
  }

  get url() {
    if (!this.#server) throw new Error("simulator is not started");
    return `ws://${this.#host}:${this.#server.address().port}`;
  }

  issueBootstrapToken(instanceId, token) {
    this.#core.issueBootstrapToken(instanceId, token);
  }

  revokeBootstrapToken(instanceId) {
    this.#core.revokeBootstrapToken(instanceId);
  }

  resetInstance(instanceId) {
    if (!instanceId) return;
    const resetError = new Error(`channel instance ${instanceId} was reset`);
    const connection = this.#connections.get(instanceId);
    this.#connections.delete(instanceId);
    connection?.socket.close(1000, "session reset");
    for (const waiter of this.#connectionWaiters.get(instanceId) ?? []) {
      waiter.reject(resetError);
    }
    this.#connectionWaiters.delete(instanceId);
    for (const waiter of this.#outboundWaiters.values()) waiter.reject(resetError);
    this.#outboundWaiters.clear();
    for (const waiter of this.#nextOutboundWaiters) waiter.reject(resetError);
    this.#nextOutboundWaiters.length = 0;
    this.#unconsumedOutbound = this.#unconsumedOutbound.filter(
      (event) => event.instanceId !== instanceId,
    );
    this.#core.resetInstance(instanceId);
  }

  start() {
    this.#server = new WebSocketServer({ port: this.#port, host: this.#host });
    this.#server.on("connection", (socket) => this.#handleConnection(socket));
    return new Promise((resolve, reject) => {
      this.#server.once("listening", resolve);
      this.#server.once("error", reject);
    });
  }

  async stop() {
    for (const connection of this.#connections.values()) connection.socket.close();
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
  }

  async waitForConnection(instanceId, options = 2_000) {
    const { timeoutMs, afterConnectionId } =
      typeof options === "number"
        ? { timeoutMs: options, afterConnectionId: undefined }
        : { timeoutMs: options.timeoutMs ?? 2_000, afterConnectionId: options.afterConnectionId };
    const current = this.#connections.get(instanceId);
    if (current && current.connectionId !== afterConnectionId) return current;
    const waiter = deferred(timeoutMs, `connection for ${instanceId}`);
    const waiters = this.#connectionWaiters.get(instanceId) ?? [];
    waiters.push({ ...waiter, afterConnectionId });
    this.#connectionWaiters.set(instanceId, waiters);
    return waiter.promise;
  }

  forceDisconnect(instanceId) {
    const connection = this.#connections.get(instanceId);
    if (!connection) throw new Error(`no connected channel for ${instanceId}`);
    connection.socket.close(1012, "simulated interruption");
  }

  sendInbound(instanceId, event) {
    const connection = this.#connections.get(instanceId);
    if (!connection) throw new Error(`no connected channel for ${instanceId}`);
    connection.socket.send(JSON.stringify(parseChannelEnvelope(event)));
  }

  async waitForOutbound(eventId, timeoutMs = 5_000) {
    const existing = this.#core.outboundEvents.find((event) => event.eventId === eventId);
    if (existing) return existing;
    const waiter = deferred(timeoutMs, `outbound event ${eventId}`);
    this.#outboundWaiters.set(eventId, waiter);
    return waiter.promise;
  }

  async waitForNextOutbound(timeoutMs = 120_000) {
    const existing = this.#unconsumedOutbound.shift();
    if (existing) return existing;
    const waiter = deferred(timeoutMs, "next outbound event");
    this.#nextOutboundWaiters.push(waiter);
    return waiter.promise;
  }

  #handleConnection(socket) {
    let sessionToken;
    socket.on("message", (data) => {
      try {
        const event = parseChannelEnvelope(JSON.parse(data.toString()));
        if (event.eventType === "channel.register") {
          const session = event.payload.sessionToken
            ? this.#core.reconnect({
                instanceId: event.instanceId,
                accountId: event.accountId,
                sessionToken: event.payload.sessionToken,
                pluginVersion: event.payload.pluginVersion,
              })
            : this.#core.register({
                instanceId: event.instanceId,
                accountId: event.accountId,
                bootstrapToken: event.payload.bootstrapToken,
                pluginVersion: event.payload.pluginVersion,
              });
          sessionToken = session.sessionToken;
          const connection = { socket, ...session, accountId: event.accountId };
          this.#connections.set(event.instanceId, connection);
          socket.send(
            JSON.stringify(
              createEnvelope({
                eventId: randomUUID(),
                eventType: "channel.registered",
                instanceId: event.instanceId,
                accountId: event.accountId,
                payload: {
                  connectionId: session.connectionId,
                  sessionToken: session.sessionToken,
                },
              }),
            ),
          );
          const waiters = this.#connectionWaiters.get(event.instanceId) ?? [];
          const remaining = [];
          for (const waiter of waiters) {
            if (waiter.afterConnectionId !== connection.connectionId) waiter.resolve(connection);
            else remaining.push(waiter);
          }
          if (remaining.length > 0) this.#connectionWaiters.set(event.instanceId, remaining);
          else this.#connectionWaiters.delete(event.instanceId);
          return;
        }
        if (event.eventType === "message.outbound") {
          const result = this.#core.acceptOutbound(sessionToken, event);
          socket.send(
            JSON.stringify(
              createEnvelope({
                eventId: randomUUID(),
                eventType: "message.ack",
                instanceId: event.instanceId,
                accountId: event.accountId,
                payload: result,
              }),
            ),
          );
          this.#outboundWaiters.get(event.eventId)?.resolve(event);
          this.#outboundWaiters.delete(event.eventId);
          const nextWaiter = this.#nextOutboundWaiters.shift();
          if (nextWaiter) nextWaiter.resolve(event);
          else this.#unconsumedOutbound.push(event);
        }
      } catch (error) {
        socket.close(1008, error.message.slice(0, 120));
      }
    });
    socket.on("close", () => {
      for (const [instanceId, connection] of this.#connections) {
        if (connection.socket === socket) this.#connections.delete(instanceId);
      }
    });
  }
}
