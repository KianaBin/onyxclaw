# Cloud APP image

该目录只负责构建云端 Cloud APP 镜像，不创建 CCE、VPC、ELB 或 AgentSphere
资源。镜像同时包含 Node.js 运行时和基础版 E2B Python SDK。

本地构建：

```bash
docker build -f deploy/cloud-app/Dockerfile -t onyxclaw-app:local .
```

部署前需要准备：

- 基于 `config/providers.agentsphere.example.json` 创建的 Provider Profile；
- `HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY`；
- 模型 API Key 和 OpenClaw 基础配置；
- AgentSphere Sandbox 可访问的 WSS Channel 地址；
- 已部署并确认 ID 的 AgentSphere Sandbox Template。

`app.yaml.tmpl` 是单副本 CCE 起步模板。替换双花括号变量后再部署，Secret
必须预先创建，不能把真实值写入模板或 Git。

详细步骤见 `docs/huaweicloud-agentsphere-cce-deployment.md`。
