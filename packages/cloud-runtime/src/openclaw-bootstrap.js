import { createHash, randomUUID } from "node:crypto";

const DEFAULT_CONFIG_PATH = "/home/node/.openclaw/openclaw.json";
const DEFAULT_WORKSPACE_DIR = "/home/node/.openclaw/workspace";

export class BootstrapError extends Error {
  constructor(phase) {
    super(`OpenClaw bootstrap failed during ${phase}`);
    this.name = "BootstrapError";
    this.phase = phase;
    this.code = "OPENCLAW_BOOTSTRAP_FAILED";
  }
}

export class OpenClawBootstrapSaga {
  #adapter;
  #channel;
  #gateway;
  #gatewayPort;
  #configPath;
  #workspaceDir;
  #instanceIdFactory;
  #tokenFactory;
  #traceIdFactory;
  #onTransition;

  constructor({
    adapter,
    channel,
    gateway,
    gatewayPort,
    configPath = DEFAULT_CONFIG_PATH,
    workspaceDir = DEFAULT_WORKSPACE_DIR,
    instanceIdFactory = randomUUID,
    tokenFactory = randomUUID,
    traceIdFactory = randomUUID,
    onTransition = () => {},
  }) {
    this.#adapter = adapter;
    this.#channel = channel;
    this.#gateway = gateway;
    this.#gatewayPort = gatewayPort;
    this.#configPath = configPath;
    this.#workspaceDir = workspaceDir.replace(/\/$/, "");
    this.#instanceIdFactory = instanceIdFactory;
    this.#tokenFactory = tokenFactory;
    this.#traceIdFactory = traceIdFactory;
    this.#onTransition = onTransition;
  }

  #transition(phase, context = {}) {
    this.#onTransition({ phase, at: new Date().toISOString(), ...context });
  }

  #validateSoul(soul) {
    if (typeof soul !== "string" || !soul.trim()) {
      throw new TypeError("SOUL.md content is required");
    }
  }

  #validateBuildConfig(buildConfig) {
    if (typeof buildConfig !== "function") throw new TypeError("buildConfig is required");
  }

  async provision({ soul, buildConfig }) {
    this.#validateSoul(soul);
    this.#validateBuildConfig(buildConfig);

    const instanceId = this.#instanceIdFactory();
    const traceId = this.#traceIdFactory();
    this.#transition("ALLOCATING", { instanceId, traceId });

    try {
      const created = await this.#adapter.createSandbox({
        metadata: { traceId, instanceId },
      });
      await this.prepareSandbox({
        sandboxId: created.sandboxId,
        instanceId,
        traceId,
        buildConfig,
      });
      return this.bootstrapSandbox({
        sandboxId: created.sandboxId,
        instanceId,
        traceId,
        soul,
      });
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      this.#transition("FAILED", { instanceId, traceId, failedAtPhase: "ALLOCATING" });
      throw new BootstrapError("ALLOCATING");
    }
  }

  async prepareSandbox({
    sandboxId,
    instanceId,
    traceId,
    buildConfig,
    cleanupOnFailure = true,
  }) {
    this.#validateBuildConfig(buildConfig);
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new TypeError("sandboxId is required");
    }
    if (typeof instanceId !== "string" || !instanceId) {
      throw new TypeError("instanceId is required");
    }
    const bootstrapToken = this.#tokenFactory();
    let tokenIssued = false;
    const resolvedTraceId = traceId || this.#traceIdFactory();
    const phase = "PREPARING";
    this.#transition(phase, { sandboxId, instanceId, traceId: resolvedTraceId });

    try {
      await this.#channel.issueBootstrapToken(instanceId, bootstrapToken);
      tokenIssued = true;
      const config = await buildConfig({
        sandboxId,
        instanceId,
        bootstrapToken,
        traceId: resolvedTraceId,
      });
      const serializedConfig =
        typeof config === "string" ? config : JSON.stringify(config);
      if (!serializedConfig) throw new TypeError("OpenClaw config is required");

      await this.#adapter.writeFile(
        sandboxId,
        this.#configPath,
        serializedConfig,
      );
      this.#transition("PREPARED", {
        sandboxId,
        instanceId,
        traceId: resolvedTraceId,
      });
      return { sandboxId, instanceId, traceId: resolvedTraceId, status: "prepared" };
    } catch {
      if (tokenIssued) {
        try {
          await this.#channel.revokeBootstrapToken(instanceId);
        } catch {}
      }
      if (cleanupOnFailure) {
        try {
          await this.#adapter.killSandbox(sandboxId);
        } catch {}
      }
      this.#transition("FAILED", {
        sandboxId,
        instanceId,
        traceId: resolvedTraceId,
        failedAtPhase: phase,
      });
      throw new BootstrapError(phase);
    }
  }

  async readPersistentSoul(sandboxId) {
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new TypeError("sandboxId is required");
    }
    const content = await this.#adapter.readFile(
      sandboxId,
      `${this.#workspaceDir}/SOUL.md`,
    );
    if (typeof content !== "string") {
      throw new TypeError("SOUL.md content must be a string");
    }
    return {
      content,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async bootstrapSandbox({
    sandboxId,
    instanceId,
    traceId,
    soul,
    cleanupOnFailure = true,
  }) {
    this.#validateSoul(soul);
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new TypeError("sandboxId is required");
    }
    if (typeof instanceId !== "string" || !instanceId) {
      throw new TypeError("instanceId is required");
    }
    const resolvedTraceId = traceId || this.#traceIdFactory();
    let phase = "BOOTSTRAPPING";
    this.#transition(phase, { sandboxId, instanceId, traceId: resolvedTraceId });

    try {
      await this.#adapter.writeFile(
        sandboxId,
        `${this.#workspaceDir}/SOUL.md`,
        soul,
      );

      const gateway = await this.#gateway.waitUntilReady(sandboxId, {
        port: this.#gatewayPort,
      });
      phase = "GATEWAY_READY";
      this.#transition(phase, { sandboxId, instanceId, traceId: resolvedTraceId, gateway });

      const connection = await this.#channel.waitForConnection(instanceId);
      phase = "CHANNEL_READY";
      this.#transition(phase, {
        sandboxId,
        instanceId,
        traceId: resolvedTraceId,
        connectionId: connection.connectionId,
      });

      phase = "READY";
      this.#transition(phase, { sandboxId, instanceId, traceId: resolvedTraceId });
      return {
        sandboxId,
        instanceId,
        connectionId: connection.connectionId,
        traceId: resolvedTraceId,
        status: "ready",
      };
    } catch {
      const failedAtPhase = phase;
      if (cleanupOnFailure) {
        try {
          await this.#channel.revokeBootstrapToken(instanceId);
        } catch {}
        if (sandboxId) {
          try {
            await this.#adapter.killSandbox(sandboxId);
          } catch {}
        }
      }
      this.#transition("FAILED", {
        sandboxId,
        instanceId,
        traceId: resolvedTraceId,
        failedAtPhase,
      });
      throw new BootstrapError(failedAtPhase);
    }
  }
}
