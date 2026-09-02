import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("cloud APP image includes Node and the pinned ACS Python SDK", async () => {
  const dockerfile = await read("deploy/alicloud-app/Dockerfile");
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /smoke-requirements\.txt/);
  assert.match(dockerfile, /python3 -m venv \/opt\/venv/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /packages\/cloud-runtime\/src\/cloud-app\.js/);
});

test("ACS manifest keeps secrets external and exposes UI plus Channel ports", async () => {
  const manifest = await read("deploy/alicloud-app/app.yaml.tmpl");
  assert.match(manifest, /kind: Deployment/);
  assert.match(manifest, /image: \{\{IMAGE\}\}/);
  assert.match(manifest, /secretKeyRef:/);
  assert.match(manifest, /imagePullSecrets:\s*\n\s*- name: onyxclaw-acr-pull/);
  assert.match(manifest, /name: ALICLOUD_ACS_E2B_API_KEY/);
  assert.match(manifest, /name: E2B_ROUTE_DOMAIN/);
  assert.match(
    manifest,
    /value: sandbox-gateway\.sandbox-system\.svc\.cluster\.local:7788/,
  );
  assert.match(manifest, /name: ALICLOUD_ACS_MODEL_API_KEY/);
  assert.match(manifest, /containerPort: 3000/);
  assert.match(manifest, /containerPort: 18890/);
  assert.match(manifest, /name: onyxclaw-app/);
  assert.doesNotMatch(manifest, /runtime-secret|model-secret/);
});

test("ACS bootstrap config examples separate deployment input from runtime output", async () => {
  const base = JSON.parse(await read(
    "deploy/alicloud-app/examples/openclaw-base-config.example.json",
  ));
  const bootstrap = JSON.parse(await read(
    "deploy/alicloud-app/examples/bootstrap-config.example.json",
  ));

  assert.equal(
    base.models.providers["acs-model"].apiKey,
    "__ONYXCLAW_MODEL_API_KEY__",
  );
  assert.deepEqual(base.plugins.load.paths, []);
  assert.deepEqual(base.channels, {});
  assert.equal(
    bootstrap.models.providers["acs-model"].apiKey,
    "example-model-api-key-injected-at-runtime",
  );
  assert.ok(bootstrap.plugins.load.paths.includes("/opt/onyxclaw/channel"));
  assert.equal(bootstrap.plugins.entries.onyxclaw.enabled, true);
  assert.equal(bootstrap.channels.onyxclaw.enabled, true);
  assert.match(bootstrap.channels.onyxclaw.platformUrl, /^ws:\/\//);
  assert.match(bootstrap.channels.onyxclaw.instanceId, /^example-/);
  assert.match(bootstrap.channels.onyxclaw.bootstrapToken, /^example-/);
});

test("APP release tags publish a dedicated immutable container", async () => {
  const workflow = await read(".github/workflows/release-cloud-app.yml");
  assert.match(workflow, /app-v\*/);
  assert.match(workflow, /deploy\/alicloud-app\/Dockerfile/);
  assert.match(workflow, /onyxclaw-app/);
  // The registry push and the Docker-format archive are emitted by
  // separate buildx invocations; provenance/SBOM live on the push step.
  assert.match(workflow, /push:\s*true/);
  assert.match(workflow, /type=docker[^\n]*dest=/);
  assert.match(workflow, /steps\.push\.outputs\.digest/);
  assert.match(workflow, /packages:\s*write/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
});

test("cloud APP shares Sandbox Service telemetry between the ACS adapter and UI", async () => {
  const source = await read("packages/cloud-runtime/src/cloud-app.js");
  assert.match(source, /createSandboxServiceMonitor/);
  assert.match(source, /createE2BCompatibleAdapter\(\{[\s\S]*operationMonitor/);
  assert.match(source, /createLocalConsoleServer\(\{[\s\S]*operationMonitor/);
  assert.match(source, /deploymentMode:\s*"cloud"/);
  assert.match(source, /providerId,/);
});

test("CCE chat-delivery patch images use verified immutable bases and copy only runtime files", async () => {
  const appPatch = await read("deploy/huaweicloud-cce/Dockerfile.chat-delivery-v21");
  const channelPatch = await read("deploy/huaweicloud-cce/Dockerfile.channel-chat-delivery-v21");

  assert.match(appPatch, /onyxclaw-app@sha256:fe0c5274fff79897fce53634756694edc9799f393e3e3dde416d604749788293/);
  assert.match(appPatch, /COPY packages\/cloud-runtime\/src\/cloud-controller\.js/);
  assert.match(appPatch, /COPY packages\/test-orchestrator\/src\/ws-simulator\.js/);
  assert.match(appPatch, /COPY packages\/local-console\/public\/app\.js/);
  assert.match(channelPatch, /onyxclaw-openclaw@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5/);
  assert.match(channelPatch, /COPY packages\/onyxclaw-channel\/src\/inbound\.js/);
});
