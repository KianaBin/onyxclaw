# OnyxClaw

OnyxClaw 是 OpenClaw Channel 的本地验证工具和云端 Sandbox 运行原型。本分支保留
本地开发能力，并面向华为云 CCE + AgentSphere 的 E2B 兼容接口继续演进。

## 当前范围

- OpenClaw Channel Plugin；
- WebSocket Channel Simulator；
- 本地 macOS Phase 0/Phase 1 验证；
- 浏览器 Console、`SOUL.md` 编辑和文本对话；
- 通用 E2B Sandbox 生命周期、命令和文件操作；
- Cloud APP 与 AgentSphere Provider 配置；
- Sandbox 主动连接 Cloud APP 的 WSS Channel 链路。

项目不负责创建 CCE、VPC、ELB 或 AgentSphere 平台资源。Sandbox 镜像和 Template
由目标环境预先准备。

## 本地开发

要求：

- Node.js 22.19 或更新版本；
- OpenClaw 2026.5.28 或兼容版本；
- 已配置的本地 OpenClaw 模型 Provider。

```bash
npm ci
npm test
npm run dev
```

本地模式只操作开发机上已有的 OpenClaw，不创建云端 Sandbox。详细说明见
[`docs/phase0-local.md`](./docs/phase0-local.md) 和
[`docs/phase1-local.md`](./docs/phase1-local.md)。

## AgentSphere Cloud APP

主要调用链：

```text
cloud-app.js
  -> ProviderRegistry
  -> E2BCompatibleAdapter
  -> python-e2b-client.js
  -> e2b-bridge.py
  -> AgentSphere E2B API
```

准备配置：

```bash
cp config/providers.agentsphere.example.json config/providers.agentsphere.local.json
cp .env.example .env
```

修改本地 Profile 中的 Template、Channel 和模型信息，并通过环境变量注入 Secret。
不要提交 `.env`、本地 Profile 或真实凭据。

Cloud APP 镜像：

```bash
docker build -f deploy/cloud-app/Dockerfile -t onyxclaw-app:local .
```

部署和验证过程见：

- [`docs/huaweicloud-agentsphere-cce-deployment.md`](./docs/huaweicloud-agentsphere-cce-deployment.md)
- [`docs/huaweicloud-cce-learning-log.md`](./docs/huaweicloud-cce-learning-log.md)
- [`docs/provider-config.md`](./docs/provider-config.md)
- [`packages/cloud-runtime/README.md`](./packages/cloud-runtime/README.md)
