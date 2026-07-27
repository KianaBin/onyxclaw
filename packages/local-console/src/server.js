import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSandboxServiceMonitor } from "./observability.js";

const defaultPublicDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("请求内容超过 1 MiB");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

export function createLocalConsoleServer({
  controller,
  host = "127.0.0.1",
  port = 3000,
  publicDirectory = defaultPublicDirectory,
  operationMonitor = createSandboxServiceMonitor(),
  uiConfig = {},
}) {
  let server;
  const publicUiConfig = {
    deploymentMode: uiConfig.deploymentMode === "cloud" ? "cloud" : "local",
    ...(uiConfig.providerId ? { providerId: uiConfig.providerId } : {}),
    ...(uiConfig.providerName ? { providerName: uiConfig.providerName } : {}),
    ...(uiConfig.region ? { region: uiConfig.region } : {}),
    ...(uiConfig.templateId ? { templateId: uiConfig.templateId } : {}),
    ...(Number.isInteger(uiConfig.gatewayPort) ? { gatewayPort: uiConfig.gatewayPort } : {}),
    ...(uiConfig.e2bHost ? { e2bHost: uiConfig.e2bHost } : {}),
    ...(uiConfig.protocol ? { protocol: uiConfig.protocol } : {}),
    ...(uiConfig.capabilities ? { capabilities: uiConfig.capabilities } : {}),
    ...(uiConfig.modelProvider ? { modelProvider: uiConfig.modelProvider } : {}),
    ...(uiConfig.modelName ? { modelName: uiConfig.modelName } : {}),
  };

  async function handleApi(request, response, pathname) {
    if (
      request.method !== "GET" &&
      request.headers["x-onyxclaw-request"] !== "local-ui"
    ) {
      return sendJson(response, 403, { error: "拒绝非本机控制台请求" });
    }
    if (request.method === "GET" && pathname === "/api/status") {
      return sendJson(response, 200, controller.getStatus());
    }
    if (request.method === "GET" && pathname === "/api/ui-config") {
      return sendJson(response, 200, publicUiConfig);
    }
    if (request.method === "GET" && pathname === "/api/observability") {
      return sendJson(response, 200, operationMonitor.snapshot());
    }
    if (request.method === "POST" && pathname === "/api/lobster/start") {
      const body = await readJson(request);
      return sendJson(response, 200, await controller.startLobsterMode(body));
    }
    if (request.method === "POST" && pathname === "/api/lobster/stop") {
      return sendJson(response, 200, await controller.stopLobsterMode());
    }
    if (request.method === "POST" && pathname === "/api/session/reset") {
      const status = await controller.resetNewUser();
      operationMonitor.reset();
      return sendJson(response, 200, status);
    }
    if (request.method === "GET" && pathname === "/api/soul") {
      return sendJson(response, 200, await controller.getSoul());
    }
    if (request.method === "PUT" && pathname === "/api/soul") {
      const body = await readJson(request);
      return sendJson(response, 200, await controller.saveSoul(body.content));
    }
    if (request.method === "POST" && pathname === "/api/soul/restore") {
      return sendJson(response, 200, await controller.restoreSoul());
    }
    if (request.method === "POST" && pathname === "/api/soul/confirm") {
      const body = await readJson(request);
      return sendJson(response, 200, await controller.confirmSoul(body.content));
    }
    if (request.method === "POST" && pathname === "/api/chat/hello") {
      return sendJson(response, 200, await controller.sayHello());
    }
    if (request.method === "POST" && pathname === "/api/chat") {
      const body = await readJson(request);
      return sendJson(response, 200, await controller.sendMessage(body.text));
    }
    return sendJson(response, 404, { error: "API 不存在" });
  }

  async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.resolve(publicDirectory, relative);
    if (!filePath.startsWith(`${path.resolve(publicDirectory)}${path.sep}`)) {
      return sendJson(response, 404, { error: "Not found" });
    }
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
        "content-length": metadata.size,
        "cache-control": "no-cache",
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(filePath).pipe(response);
    } catch {
      sendJson(response, 404, { error: "Not found" });
    }
  }

  async function handle(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      if (pathname.startsWith("/api/")) await handleApi(request, response, pathname);
      else await serveStatic(request, response, pathname);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    get url() {
      if (!server?.listening) throw new Error("server is not started");
      return `http://${host}:${server.address().port}`;
    },
    start() {
      server = http.createServer((request, response) => void handle(request, response));
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    },
    async stop({ cleanup = true } = {}) {
      let cleanupError;
      if (cleanup) {
        try {
          await controller.stopLobsterMode();
        } catch (error) {
          cleanupError = error;
        }
      }
      if (server?.listening) {
        server.closeIdleConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      if (cleanupError) throw cleanupError;
    },
  };
}
