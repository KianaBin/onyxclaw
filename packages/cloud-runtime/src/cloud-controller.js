import { createHash, randomUUID } from "node:crypto";

import { createInboundMessage } from "../../test-orchestrator/src/protocol.js";

function soulFile(content) {
  return {
    content,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function isMissingDataSession(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/session(?: id)? not found/i.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export class CloudConsoleController {
  #adapter;
  #saga;
  #instanceIdFactory;
  #traceIdFactory;
  #buildConfig;
  #defaultSoul;
  #simulator;
  #accountId;
  #timeoutMs;
  #eventIdFactory;
  #chatId;
  #helloResponse;
  #soul;
  #soulRestore;
  #status;

  constructor({
    adapter,
    saga,
    instanceIdFactory = randomUUID,
    traceIdFactory = randomUUID,
    defaultSoul = "# OnyxClaw\n",
    buildConfig,
    simulator,
    accountId = "default",
    timeoutMs = 120_000,
    eventIdFactory = randomUUID,
    chatId = `cloud-${randomUUID()}`,
  }) {
    this.#adapter = adapter;
    this.#saga = saga;
    this.#instanceIdFactory = instanceIdFactory;
    this.#traceIdFactory = traceIdFactory;
    this.#buildConfig = buildConfig;
    this.#defaultSoul = defaultSoul;
    this.#simulator = simulator;
    this.#accountId = accountId;
    this.#timeoutMs = timeoutMs;
    this.#eventIdFactory = eventIdFactory;
    this.#chatId = chatId;
    this.#soul = defaultSoul;
    this.#soulRestore = defaultSoul;
    this.#status = {
      mode: "idle",
      currentStep: "mode",
      soulConfirmed: false,
      sandboxId: null,
      instanceId: null,
      connectionId: null,
      traceId: null,
      error: null,
    };
  }

  getStatus() {
    return { ...this.#status };
  }

  async startLobsterMode({ sandboxId, instanceId: savedInstanceId } = {}) {
    if (this.#status.mode !== "idle") return this.getStatus();
    this.#status = { ...this.#status, mode: "starting", error: null };
    try {
      if (sandboxId) {
        const instanceId = savedInstanceId || sandboxId;
        this.#status = {
          ...this.#status,
          sandboxId,
          instanceId,
          connectionId: null,
        };
        await this.#adapter.connectSandbox(sandboxId);
        const ready = await this.#saga.bootstrapSandbox({
          sandboxId,
          instanceId,
          traceId: this.#status.traceId,
          soul: this.#soul,
        });
        this.#status = {
          ...this.#status,
          mode: "connected",
          currentStep: "chat",
          soulConfirmed: true,
          connectionId: ready.connectionId,
        };
        return this.getStatus();
      }
      const instanceId = this.#instanceIdFactory();
      const traceId = this.#traceIdFactory();
      const created = await this.#adapter.createSandbox({
        metadata: { instanceId, traceId },
      });
      await this.#saga.prepareSandbox({
        sandboxId: created.sandboxId,
        instanceId,
        traceId,
        buildConfig: this.#buildConfig,
      });
      this.#status = {
        ...this.#status,
        mode: "allocated",
        currentStep: "soul",
        soulConfirmed: false,
        sandboxId: created.sandboxId,
        instanceId,
        connectionId: null,
        traceId,
        error: null,
      };
      return this.getStatus();
    } catch (error) {
      this.#status = {
        ...this.#status,
        mode: "error",
        currentStep: "mode",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  getSoul() {
    return soulFile(this.#soul);
  }

  saveSoul(content) {
    if (typeof content !== "string") throw new TypeError("SOUL.md 内容必须是字符串");
    this.#soul = content;
    return soulFile(content);
  }

  restoreSoul() {
    this.#soul = this.#soulRestore;
    return soulFile(this.#soul);
  }

  async confirmSoul(content) {
    const resumeConfirmation = this.#status.mode === "resume-confirmation";
    if (this.#status.mode !== "allocated" && !resumeConfirmation) {
      throw new Error("请先创建云端 Sandbox 或恢复暂停的 Sandbox");
    }
    const file = this.saveSoul(content);
    try {
      const ready = await this.#saga.bootstrapSandbox({
        sandboxId: this.#status.sandboxId,
        instanceId: this.#status.instanceId,
        traceId: this.#status.traceId,
        soul: content,
        cleanupOnFailure: !resumeConfirmation,
      });
      this.#soulRestore = content;
      this.#status = {
        ...this.#status,
        mode: "connected",
        currentStep: "chat",
        soulConfirmed: true,
        connectionId: ready.connectionId,
        error: null,
      };
      return { ...file, soulConfirmed: true, currentStep: "chat" };
    } catch (error) {
      if (resumeConfirmation) {
        try {
          await this.#adapter.pauseSandbox(this.#status.sandboxId);
        } catch {}
        this.#status = {
          ...this.#status,
          mode: "paused",
          currentStep: "chat",
          soulConfirmed: true,
          connectionId: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  async pauseLobsterMode() {
    if (this.#status.mode !== "connected" || !this.#status.sandboxId) {
      throw new Error("云端 OpenClaw 尚未连接，不能暂停");
    }
    this.#status = { ...this.#status, mode: "pausing", error: null };
    try {
      await this.#adapter.pauseSandbox(this.#status.sandboxId);
      this.#status = {
        ...this.#status,
        mode: "paused",
        currentStep: "chat",
        connectionId: null,
      };
      return this.getStatus();
    } catch (error) {
      this.#status = {
        ...this.#status,
        mode: "connected",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async resumeLobsterMode() {
    const retryDataSession = this.#status.mode === "resume-data-pending";
    if ((this.#status.mode !== "paused" && !retryDataSession) || !this.#status.sandboxId) {
      throw new Error("Sandbox 当前不是暂停状态");
    }
    this.#status = { ...this.#status, mode: "resuming", error: null };
    let connectedForResume = retryDataSession;
    try {
      if (!retryDataSession) {
        await this.#adapter.connectSandbox(this.#status.sandboxId);
        connectedForResume = true;
      }
      // AgentSphere restores a paused Sandbox by rebuilding its runtime while
      // preserving the logical Sandbox ID. Recreate the non-persistent config
      // immediately so the image entrypoint can start the Gateway. Keep using
      // the personality already held by the APP instead of blocking recovery
      // on a read from the SFS-backed workspace.
      await this.#saga.prepareSandbox({
        sandboxId: this.#status.sandboxId,
        instanceId: this.#status.instanceId,
        traceId: this.#status.traceId,
        buildConfig: this.#buildConfig,
        cleanupOnFailure: false,
      });
      this.#status = {
        ...this.#status,
        mode: "resume-confirmation",
        currentStep: "soul",
        soulConfirmed: false,
        connectionId: null,
      };
      return this.getStatus();
    } catch (error) {
      const dataSessionPending = connectedForResume && isMissingDataSession(error);
      if (connectedForResume && !dataSessionPending) {
        try {
          await this.#adapter.pauseSandbox(this.#status.sandboxId);
        } catch {}
      }
      this.#status = {
        ...this.#status,
        mode: dataSessionPending ? "resume-data-pending" : "paused",
        currentStep: "chat",
        soulConfirmed: true,
        connectionId: null,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stopLobsterMode() {
    if (this.#status.sandboxId) {
      await this.#adapter.killSandbox(this.#status.sandboxId);
    }
    return this.#clearLocalState();
  }

  #clearLocalState(extra = {}) {
    this.#soul = this.#defaultSoul;
    this.#soulRestore = this.#defaultSoul;
    this.#helloResponse = undefined;
    this.#status = {
      mode: "idle",
      currentStep: "mode",
      soulConfirmed: false,
      sandboxId: null,
      instanceId: null,
      connectionId: null,
      traceId: null,
      error: null,
    };
    return { ...this.getStatus(), ...extra };
  }

  resetNewUser({ skipSandboxCleanup = false } = {}) {
    if (!skipSandboxCleanup) return this.stopLobsterMode();
    const orphanedSandboxId = this.#status.sandboxId;
    return this.#clearLocalState({
      cleanupSkipped: true,
      orphanedSandboxId,
    });
  }

  async sendMessage(text) {
    if (this.#status.mode !== "connected" || !this.#status.soulConfirmed) {
      throw new Error("云端 OpenClaw 尚未就绪");
    }
    if (!this.#simulator) throw new Error("Channel Simulator 未配置");
    if (typeof text !== "string" || !text.trim()) throw new TypeError("消息不能为空");
    const eventId = this.#eventIdFactory();
    const started = Date.now();
    this.#simulator.sendInbound(
      this.#status.instanceId,
      createInboundMessage({
        eventId,
        instanceId: this.#status.instanceId,
        accountId: this.#accountId,
        senderId: "cloud-app-user",
        chatId: this.#chatId,
        text: text.trim(),
      }),
    );
    const outbound = await this.#simulator.waitForNextOutbound(this.#timeoutMs);
    return {
      text: outbound.payload.text,
      inboundEventId: eventId,
      outboundEventId: outbound.eventId,
      durationMs: Date.now() - started,
      traceId: eventId,
    };
  }

  async sayHello() {
    if (this.#helloResponse) return { ...this.#helloResponse, alreadySent: true };
    const response = await this.sendMessage(
      "这是你和新用户的第一次见面。请基于当前性格设定主动说一声 hello，并做一句简短的自我介绍。",
    );
    this.#helloResponse = { ...response, alreadySent: false };
    return this.#helloResponse;
  }
}
