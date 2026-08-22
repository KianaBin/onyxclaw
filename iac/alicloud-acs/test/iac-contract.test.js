import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCommands,
  renderSandboxSet,
  validateEnvironment,
} from "../scripts/stack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFile(path.join(root, name), "utf8");
const repositoryRoot = path.resolve(root, "../..");
const readRepositoryFile = (name) =>
  readFile(path.join(repositoryRoot, name), "utf8");

test("Terraform creates an ACS profile cluster and manages sandbox addons", async () => {
  const main = await read("main.tf");

  assert.match(main, /resource\s+"alicloud_vpc"/);
  assert.match(main, /resource\s+"alicloud_vswitch"/);
  assert.match(main, /resource\s+"alicloud_cs_managed_kubernetes"/);
  assert.match(main, /profile\s*=\s*"Acs"/);
  assert.match(main, /cluster_spec\s*=\s*"ack\.pro\.small"/);
  assert.match(main, /new_nat_gateway\s*=\s*var\.enable_snat/);
  assert.match(main, /name\s*=\s*"ack-agent-sandbox-controller"/);
  assert.match(main, /name\s*=\s*"ack-sandbox-manager"/);
  assert.doesNotMatch(main, /managed-aliyun-acr-credential-helper/);
  assert.doesNotMatch(
    main,
    /resource\s+"alicloud_cs_kubernetes_addon"\s+"virtual_node"/,
  );
  assert.match(main, /deletion_protection\s*=\s*var\.deletion_protection/);
});

test("SandboxSet uses the final OpenClaw image and only the runtime needed by Phase cloud", () => {
  const manifest = renderSandboxSet({
    image: "registry.example/onyxclaw:2026.5.28",
    replicas: 2,
    templateName: "onyxclaw",
  });

  assert.match(manifest, /kind: SandboxSet/);
  assert.match(manifest, /name: agent-runtime/);
  assert.doesNotMatch(manifest, /name: csi/);
  assert.match(manifest, /alibabacloud\.com\/compute-class: agent-sandbox/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /image: registry\.example\/onyxclaw:2026\.5\.28/);
  assert.match(manifest, /replicas: 2/);
});

test("deploy and destroy are inverse operations", () => {
  const deploy = buildCommands("deploy", { terraform: "tofu" });
  const destroy = buildCommands("destroy", { terraform: "tofu" });

  assert.deepEqual(deploy.map(({ command }) => command), ["tofu", "tofu", "kubectl"]);
  assert.deepEqual(deploy[1].args.slice(0, 2), ["apply", "-auto-approve"]);
  assert.equal(deploy[2].args.at(-2), "-f");
  assert.match(deploy[2].args.at(-1), /sandboxset\.yaml$/);

  assert.equal(destroy[0].command, "kubectl");
  assert.deepEqual(destroy[0].args.slice(-4), [
    "sandboxset",
    "onyxclaw",
    "--ignore-not-found=true",
    "--wait=true",
  ]);
  assert.deepEqual(destroy[1].args.slice(0, 2), ["destroy", "-auto-approve"]);
});

test("deploy fails fast without credentials, image and explicit account authorization", () => {
  assert.throws(
    () => validateEnvironment({}, "deploy"),
    /ALIBABA_CLOUD_ACCESS_KEY_ID.*ONYXCLAW_OPENCLAW_IMAGE.*ONYXCLAW_ACS_ACCOUNT_READY/s,
  );

  assert.doesNotThrow(() =>
    validateEnvironment({
      ALIBABA_CLOUD_ACCESS_KEY_ID: "test-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-secret",
      ALIBABA_CLOUD_REGION: "cn-hangzhou",
      TF_VAR_e2b_domain: "sandbox.example.com",
      TF_VAR_sandbox_admin_api_key: "test-key",
      ONYXCLAW_OPENCLAW_IMAGE: "registry.example/onyxclaw:test",
      ONYXCLAW_ACS_ACCOUNT_READY: "true",
    }, "deploy"),
  );
});

test("destroy only requires cloud credentials so lost bootstrap values cannot block cleanup", () => {
  assert.doesNotThrow(() =>
    validateEnvironment({
      ALIBABA_CLOUD_ACCESS_KEY_ID: "test-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-secret",
      ALIBABA_CLOUD_REGION: "cn-hangzhou",
    }, "destroy"),
  );
});

test("derived OpenClaw image contains ACS tools and waits for runtime bootstrap", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    read("image/Dockerfile"),
    read("image/entrypoint.sh"),
  ]);

  assert.match(dockerfile, /ghcr\.io\/openclaw\/openclaw:2026\.5\.28/);
  assert.match(dockerfile, /packages\/onyxclaw-channel/);
  assert.match(dockerfile, /\/bin\/bash/);
  assert.match(dockerfile, /--omit=peer/);
  assert.match(dockerfile, /node_modules\/openclaw/);
  assert.match(dockerfile, /install -d[^\n]*-o node -g node \/run\/e2b/);
  assert.match(dockerfile, /USER root\s*\nENV HOME=/);
  assert.match(entrypoint, /OPENCLAW_CONFIG_PATH/);
  assert.doesNotMatch(entrypoint, /while \[ ! -s .*SOUL\.md/);
  assert.doesNotMatch(entrypoint, /bootstrap\/openclaw\.json/);
  assert.match(entrypoint, /install -d[^\n]*-o node -g node/);
  assert.match(entrypoint, /chown node:node/);
  assert.match(entrypoint, /setpriv --reuid=node --regid=node --init-groups/);
  assert.match(entrypoint, /gateway.*--bind.*lan/s);
});

test("release tags publish one immutable GHCR image and a Docker 24.x tar.gz", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-openclaw-image.yml",
  );

  assert.match(workflow, /tags:\s*\n\s*- ["']v\*['"]/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/);
  assert.match(workflow, /image="ghcr\.io\/\$\{owner\}\/onyxclaw-openclaw"/);
  assert.match(workflow, /iac\/alicloud-acs\/image\/Dockerfile/);
  // Registry push step: bare `push: true` is used because the Docker-format
  // archive build is split into a separate step (buildx's `docker` exporter
  // cannot serialise manifest lists alongside a registry target).
  assert.match(workflow, /push:\s*true/);
  // Separate Docker-format archive build step.
  assert.match(workflow, /type=docker[^\n]*dest=/);
  assert.match(workflow, /sha256sum/);
  // Provenance + SBOM live on the push step; the archive step pulls digest
  // from the push step.
  assert.match(workflow, /steps\.push\.outputs\.digest/);
  assert.match(workflow, /gh release (create|upload)/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
});

test("cloud smoke test pins the supported SDK and never exposes the runtime key", async () => {
  const [requirements, smoke] = await Promise.all([
    read("smoke-requirements.txt"),
    read("scripts/e2b-smoke.py"),
  ]);

  assert.match(requirements, /^e2b==2\.24\.0$/m);
  assert.match(requirements, /^e2b-code-interpreter==2\.7\.0$/m);
  assert.match(requirements, /ef43b4b644ff47d86670ddfebbe73de41e4e4c8f/);
  assert.match(smoke, /secret\/e2b-key-store/);
  assert.match(smoke, /patch_e2b\(https=False\)/);
  assert.match(smoke, /user=args\.runtime_user/);
  assert.match(smoke, /finally:\s*\n\s+if claimed is not None:\s*\n\s+claimed\.kill\(\)/);
  assert.doesNotMatch(smoke, /print\([^\n]*(api_key|runtime_key|\bkey\b)/i);
});
