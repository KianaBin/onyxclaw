# OnyxClaw

OnyxClaw is a local OpenClaw Channel harness and Phase 1 browser console. Its
current macOS mode uses an already installed OpenClaw and does not create a
Sandbox.

Current implementation:

- minimal OpenClaw Channel Plugin;
- WebSocket Channel Platform Simulator;
- versioned inbound/outbound protocol;
- bootstrap registration, session reconnect, heartbeat, delivery receipt, and event deduplication;
- OpenClaw inbound dispatch and outbound reply delivery;
- local macOS E2E runner covering two message rounds, Gateway restart, token
  rotation, temporary `SOUL.md` verification, cleanup, and JSON reports.
- loopback-only Phase 1 UI for local Channel lifecycle, `SOUL.md` editing, and
  text chat, enforced as a serial connect → personality confirmation → chat
  onboarding flow with a one-time personality-based greeting.
- Alibaba Cloud ACS disposable IaC for VPC, cluster, Agent Sandbox components,
  an OpenClaw warm pool, derived image bootstrap, and reverse cleanup.
- tag-driven GitHub Release pipeline that builds the derived `linux/amd64`
  image once, publishes it to GHCR, and attaches an OCI archive, digest,
  manifest, and checksums to the matching Release.

## Requirements

- Node.js 22.19 or newer;
- OpenClaw 2026.5.28 or a compatible version;
- a configured local OpenClaw model provider.

## Development

```bash
npm install
npm test
```

The WebSocket test binds to loopback and may require local network permission in a sandboxed development environment.

## Local Phase 0

See [docs/phase0-local.md](./docs/phase0-local.md).

```bash
npm run phase0:local
```

Reports are written to `artifacts/phase0-local-<run-id>.json`.
The runner temporarily restarts the local Gateway and restores the original
`SOUL.md` before disabling the test Channel.

## Local Phase 1 UI

```bash
npm run dev
```

Open `http://127.0.0.1:3000`. This UI operates only on the OpenClaw installed
on the current Mac. See [docs/phase1-local.md](./docs/phase1-local.md).

With the UI server running, execute the complete local acceptance flow with:

```bash
npm run phase1:smoke
```

Current acceptance status: 96 automated tests plus real macOS Phase 0/Phase 1
and Alibaba Cloud ACS Sandbox/OpenClaw/Channel runs passing. See the
[implementation summary](./docs/implementation-summary.md) for the completed
scope and remaining production boundaries.

## Alibaba Cloud ACS IaC

See [docs/alibaba-acs-design.md](./docs/alibaba-acs-design.md) for the complete
flow, [the OpenClaw image adaptation guide](./docs/openclaw-image-alibaba-acs-adaptation.md)
for derived-image changes, and [iac/alicloud-acs/README.md](./iac/alicloud-acs/README.md)
for commands.

The derived image is released by pushing a SemVer tag such as `v0.1.0`. The
`Release OpenClaw image` workflow publishes
`ghcr.io/mahaoalex/onyxclaw-openclaw:<tag>` and records its immutable digest in
the corresponding GitHub Release. Configure ACS with the `image@sha256:...`
value from that Release, not with a floating tag.

Current phase baselines are the OpenClaw Sandbox image
[v0.1.3](https://github.com/MahaoAlex/onyxclaw/releases/tag/v0.1.3) and the cloud
APP image [app-v0.3.6](https://github.com/MahaoAlex/onyxclaw/releases/tag/app-v0.3.6).
The APP Release also contains a Docker-loadable `linux/amd64` tar.gz archive,
manifest, immutable image reference, and checksums.

## Design

- [Initial requirements](./docs/init.md)
- [Cloud validation proposal](./docs/proposal.md)
- [Cloud provider configuration](./docs/provider-config.md)
- [Cloud Sandbox Provider onboarding guide](./docs/cloud-sandbox-provider-onboarding.md)
- [Huawei Cloud CCE and AgentSphere deployment](./docs/huaweicloud-agentsphere-cce-deployment.md)
- [Alibaba Cloud ACS Agent Sandbox design](./docs/alibaba-acs-design.md)
- [OpenClaw image adaptation for Alibaba Cloud ACS](./docs/openclaw-image-alibaba-acs-adaptation.md)
- [Alibaba Cloud ACS OpenClaw bootstrap config](./docs/alibaba-acs-bootstrap-config.md)
- [Current implementation summary](./docs/implementation-summary.md)
