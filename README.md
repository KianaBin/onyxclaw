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
- Huawei Cloud CCE APP deployment and AgentSphere Sandbox integration, with
  immutable image baselines and manual release validation.

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

Cloud release candidates are built manually on `demo-cn-south1` from verified
immutable bases. A successful build does not push an image, roll out CCE, or
replace an AgentSphere Template. See the [APP and Channel image build and update plan](./docs/huaweicloud-image-build-and-update.md).
Actual deployment operations are maintained in [onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click).

## Design

- [Initial requirements](./docs/init.md)
- [Huawei image build and update plan](./docs/huaweicloud-image-build-and-update.md)
- [Deployment automation: onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click)
