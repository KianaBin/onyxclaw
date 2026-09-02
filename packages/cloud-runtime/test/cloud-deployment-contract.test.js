import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("cloud APP uses the Huawei AgentSphere default profile and shared telemetry", async () => {
  const source = await read("packages/cloud-runtime/src/cloud-app.js");
  assert.match(source, /providers\.huaweicloud-agentsphere\.example\.json/);
  assert.match(source, /createSandboxServiceMonitor/);
  assert.match(source, /createE2BCompatibleAdapter\(\{[\s\S]*operationMonitor/);
  assert.match(source, /createLocalConsoleServer\(\{[\s\S]*operationMonitor/);
  assert.match(source, /deploymentMode:\s*"cloud"/);
  assert.match(source, /providerId,/);
});

test("v19 APP baseline, Channel image, and chat-delivery patches have explicit build contracts", async () => {
  const appV19 = await read("deploy/huaweicloud-cce/app-v19/Dockerfile");
  const appV19Controller = await read("deploy/huaweicloud-cce/app-v19/cloud-controller.js");
  const appPatch = await read("deploy/huaweicloud-cce/Dockerfile.chat-delivery-v21");
  const channelPatch = await read("deploy/huaweicloud-cce/Dockerfile.channel-chat-delivery-v21");
  const channelImage = await read("deploy/huaweicloud-agentsphere-openclaw/Dockerfile.channel");
  const channelDefaultConfig = await read(
    "deploy/huaweicloud-agentsphere-openclaw/openclaw.with-channel.default.json",
  );

  assert.match(appV19, /onyxclaw-app@sha256:d5cdc18a427751f357c0c4aed8e75823ccfdc4eabe7b55a39125217c3d274f18/);
  assert.match(appV19, /E2B_DATA_SESSION_WAIT_SECONDS=5/);
  assert.match(appV19, /COPY --chown=node:node cloud-controller\.js/);
  assert.equal(
    createHash("sha256").update(appV19Controller).digest("hex"),
    "92cf94049aae1a8268c2138eb81859e01bfd98d0f93604f4c4b17094c659736d",
  );
  assert.match(appPatch, /onyxclaw-app@sha256:fe0c5274fff79897fce53634756694edc9799f393e3e3dde416d604749788293/);
  assert.match(appPatch, /COPY packages\/cloud-runtime\/src\/cloud-controller\.js/);
  assert.match(appPatch, /COPY packages\/test-orchestrator\/src\/ws-simulator\.js/);
  assert.match(appPatch, /COPY packages\/local-console\/public\/app\.js/);
  assert.match(channelPatch, /onyxclaw-openclaw@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5/);
  assert.match(channelPatch, /COPY packages\/onyxclaw-channel\/src\/inbound\.js/);
  assert.match(channelImage, /FROM \$\{OPENCLAW_AGENTSPHERE_IMAGE\}/);
  assert.match(channelImage, /COPY --chown=node:node packages\/onyxclaw-channel \/opt\/onyxclaw\/channel/);
  assert.match(channelImage, /npm ci --omit=dev --ignore-scripts --legacy-peer-deps/);
  assert.match(channelImage, /require\("\/app\/package\.json"\)/);
  assert.match(channelImage, /ln -s \/app node_modules\/openclaw/);
  assert.match(channelDefaultConfig, /"\/opt\/onyxclaw\/channel"/);
  assert.match(channelDefaultConfig, /"onyxclaw"/);
});
