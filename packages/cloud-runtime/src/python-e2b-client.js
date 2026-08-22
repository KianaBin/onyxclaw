import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const defaultBridgePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "e2b-bridge.py",
);

function redact(value, secrets) {
  let safe = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe.replace(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}

function defaultLogger(record) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...record,
  })}\n`);
}

class PythonBridge {
  #child;
  #pending = new Map();
  #requestTimeoutMs;

  constructor({ pythonPath, bridgePath, spawnImpl, env, requestTimeoutMs, logger }) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#child = spawnImpl(pythonPath, [bridgePath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#receive(line));
    const stderrLines = createInterface({ input: this.#child.stderr });
    stderrLines.on("line", (line) => logger({
      level: "error",
      event: "e2b.bridge.stderr",
      message: redact(line, [env.E2B_API_KEY]),
    }));
    this.#child.once("error", (error) => {
      logger({
        level: "error",
        event: "e2b.bridge.spawn_failed",
        error: { name: error.name, message: redact(error.message, [env.E2B_API_KEY]) },
      });
      this.#failAll(error);
    });
    this.#child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        logger({
          level: "error",
          event: "e2b.bridge.exited",
          code,
          signal,
        });
      }
      this.#failAll(new Error(`E2B bridge exited (${code ?? signal})`));
    });
  }

  #receive(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      const error = new Error(response.error.message || "E2B bridge operation failed");
      error.code = response.error.code;
      error.name = response.error.type || "E2BBridgeError";
      if (response.error.statusCode !== undefined) {
        error.statusCode = response.error.statusCode;
      }
      if (response.error.requestId !== undefined) {
        error.requestId = response.error.requestId;
      }
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(op, params = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`E2B bridge timed out during ${op}`));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, op, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.#child.kill("SIGTERM");
  }
}

function sessionFor(bridge, sandboxId) {
  return {
    sandboxId,
    runCommand(command, options = {}) {
      return bridge.request("command", { sandboxId, command, ...options });
    },
    writeFile(filePath, content, options = {}) {
      return bridge.request("writeFile", {
        sandboxId,
        path: filePath,
        content: Buffer.isBuffer(content) ? content.toString("base64") : content,
        encoding: Buffer.isBuffer(content) ? "base64" : "utf8",
        ...options,
      });
    },
    async readFile(filePath, options = {}) {
      const result = await bridge.request("readFile", {
        sandboxId,
        path: filePath,
        ...options,
      });
      return result.content;
    },
    kill() {
      return bridge.request("kill", { sandboxId });
    },
    pause() {
      return bridge.request("pause", { sandboxId });
    },
  };
}

export function createPythonE2BClientFactory({
  pythonPath = process.env.ONYXCLAW_E2B_PYTHON ?? "python3",
  bridgePath = defaultBridgePath,
  spawnImpl = spawn,
  logger = defaultLogger,
} = {}) {
  return ({ apiKey, baseUrl, sandboxUrl, requestTimeoutMs, sdkPatch = "none" }) => {
    const bridge = new PythonBridge({
      pythonPath,
      bridgePath,
      spawnImpl,
      requestTimeoutMs,
      logger,
      env: {
        ...process.env,
        E2B_API_KEY: apiKey,
        E2B_BASE_URL: baseUrl,
        E2B_DATA_SESSION_WAIT_SECONDS:
          process.env.E2B_DATA_SESSION_WAIT_SECONDS ?? "45",
        ...(sandboxUrl ? { E2B_SANDBOX_URL: sandboxUrl } : {}),
        E2B_SDK_PATCH: sdkPatch,
      },
    });
    return {
      async create(options) {
        const result = await bridge.request("create", options);
        return sessionFor(bridge, result.sandboxId);
      },
      async connect(sandboxId) {
        const result = await bridge.request("connect", { sandboxId });
        return sessionFor(bridge, result.sandboxId);
      },
      close() {
        bridge.close();
      },
    };
  };
}
