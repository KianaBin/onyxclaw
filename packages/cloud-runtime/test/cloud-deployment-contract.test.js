import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (name) => readFile(path.join(root, name), "utf8");

test("cloud APP image includes Node and the pinned base E2B Python SDK", async () => {
  const dockerfile = await read("deploy/cloud-app/Dockerfile");
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /deploy\/cloud-app\/requirements\.txt/);
  assert.match(dockerfile, /python3 -m venv \/opt\/venv/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /packages\/cloud-runtime\/src\/cloud-app\.js/);
});

test("CCE manifest keeps secrets external and exposes UI plus Channel ports", async () => {
  const manifest = await read("deploy/cloud-app/app.yaml.tmpl");
  assert.match(manifest, /kind: Deployment/);
  assert.match(manifest, /image: \{\{IMAGE\}\}/);
  assert.match(manifest, /secretKeyRef:/);
  assert.match(manifest, /name: HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY/);
  assert.match(manifest, /name: HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY/);
  assert.match(manifest, /name: ONYXCLAW_PROVIDER_CONFIG/);
  assert.match(manifest, /containerPort: 3000/);
  assert.match(manifest, /containerPort: 18890/);
  assert.match(manifest, /name: onyxclaw-app/);
  assert.doesNotMatch(manifest, /runtime-secret|model-secret/);
});

test("bootstrap config examples separate deployment input from runtime output", async () => {
  const base = JSON.parse(await read(
    "deploy/cloud-app/examples/openclaw-base-config.example.json",
  ));
  const bootstrap = JSON.parse(await read(
    "deploy/cloud-app/examples/bootstrap-config.example.json",
  ));

  assert.equal(
    base.models.providers["cloud-model"].apiKey,
    "__ONYXCLAW_MODEL_API_KEY__",
  );
  assert.deepEqual(base.plugins.load.paths, []);
  assert.deepEqual(base.channels, {});
  assert.equal(
    bootstrap.models.providers["cloud-model"].apiKey,
    "example-model-api-key-injected-at-runtime",
  );
  assert.ok(bootstrap.plugins.load.paths.includes("/opt/onyxclaw/channel"));
  assert.equal(bootstrap.plugins.entries.onyxclaw.enabled, true);
  assert.equal(bootstrap.channels.onyxclaw.enabled, true);
  assert.match(bootstrap.channels.onyxclaw.platformUrl, /^wss:\/\//);
  assert.match(bootstrap.channels.onyxclaw.instanceId, /^example-/);
  assert.match(bootstrap.channels.onyxclaw.bootstrapToken, /^example-/);
});

test("APP release tags publish a dedicated immutable container", async () => {
  const workflow = await read(".github/workflows/release-cloud-app.yml");
  assert.match(workflow, /app-v\*/);
  assert.match(workflow, /deploy\/cloud-app\/Dockerfile/);
  assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(workflow, /onyxclaw-app/);
  // The registry push and the Docker-format archive are emitted by
  // separate buildx invocations; provenance/SBOM live on the push step.
  assert.match(workflow, /push:\s*true/);
  assert.match(workflow, /type=docker[^\n]*dest=/);
  assert.match(workflow, /steps\.push\.outputs\.digest/);
  assert.match(workflow, /packages:\s*write/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
});

test("cloud APP shares Sandbox Service telemetry between the E2B adapter and UI", async () => {
  const source = await read("packages/cloud-runtime/src/cloud-app.js");
  assert.match(source, /createSandboxServiceMonitor/);
  assert.match(source, /createE2BCompatibleAdapter\(\{[\s\S]*operationMonitor/);
  assert.match(source, /createLocalConsoleServer\(\{[\s\S]*operationMonitor/);
  assert.match(source, /deploymentMode:\s*"cloud"/);
  assert.match(source, /providerId,/);
});
