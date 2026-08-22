# OpenClaw 镜像的阿里云 ACS 适配说明

本文说明 OnyxClaw 为运行在阿里云容器计算服务 ACS Agent Sandbox 中，对官方
OpenClaw 镜像增加了哪些内容、各项改动解决什么问题，以及镜像外部还需要哪些部署
配置配合。

运行时配置的来源和完整样例见
[阿里云 ACS OpenClaw bootstrap_config 说明](./alibaba-acs-bootstrap-config.md)。

## 1. 结论

本项目没有 fork 或修改 OpenClaw 核心源码，而是基于固定版本的官方镜像构建派生镜像：

```dockerfile
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28
FROM ${OPENCLAW_IMAGE}
```

派生镜像的核心组成如下：

```text
官方 OpenClaw 镜像
  + 预装 OnyxClaw Channel Plugin
  + 面向 ACS/E2B 预热池的延迟启动入口
  + 固定的配置、workspace 和 bootstrap 路径
  + root 初始化、node 运行的权限边界
  + 监听 LAN:18789 的 OpenClaw Gateway
```

平台差异主要被限制在镜像入口、Channel Plugin、Provider 配置和 SandboxSet 部署模板
中，OpenClaw 的模型调用、Agent 和 Gateway 核心实现保持上游版本。

## 2. 镜像内的修改

### 2.1 固定上游基础镜像

镜像从 `ghcr.io/openclaw/openclaw:2026.5.28` 派生，不使用浮动的 `latest`。构建参数
`OPENCLAW_IMAGE` 允许后续在验证新版本或使用内部镜像仓库时替换基础镜像。

实现位置：`iac/alicloud-acs/image/Dockerfile`。

### 2.2 校验 ACS 自定义镜像所需工具

构建阶段检查 `/bin/bash`、`setpriv`、`cp`、`mv` 和 `mkdir` 是否存在，并创建以下目录：

- `/run/e2b`：供 ACS Agent Sandbox/envd 使用；
- `/opt/onyxclaw/channel`：存放 OnyxClaw Channel Plugin；
- `/opt/onyxclaw/bin`：存放镜像入口脚本。

这些目录由 root 创建，其中 Channel 和入口文件在复制时归属 `node:node`。

### 2.3 预装 OnyxClaw Channel Plugin

镜像把 `packages/onyxclaw-channel` 复制到 `/opt/onyxclaw/channel`，并只安装生产依赖：

```dockerfile
npm install --omit=dev --omit=peer --ignore-scripts
```

OpenClaw 是该插件的 peer dependency。镜像不重复下载另一份 OpenClaw，而是把官方镜像
中的 `/app` 链接为插件的 `node_modules/openclaw`：

```dockerfile
ln -s /app /opt/onyxclaw/channel/node_modules/openclaw
```

Channel Plugin 负责让 Sandbox 中的 OpenClaw Gateway 使用一次性 bootstrap token，
通过 WebSocket 注册到 OnyxClaw APP/BFF。运行时生成的 `openclaw.json` 会启用该插件并
设置 `/opt/onyxclaw/channel` 为插件加载路径。

### 2.4 增加预热 Sandbox 的延迟启动入口

ACS `SandboxSet` 会先创建可复用的预热实例。此时实例尚未分配给具体用户，也没有用户
的性格、模型和 Channel 配置，因此不能立即启动未配置的 OpenClaw Gateway。

派生镜像用自定义 `entrypoint.sh` 替换默认入口。入口启动后只等待最终配置文件：

- `/home/node/.openclaw/openclaw.json`。

APP/BFF 领取 Sandbox 后，通过 E2B Files API 直接写入配置。入口检测到文件后才会：

1. 修正配置文件权限和所有者；
2. 启动 OpenClaw Gateway。

`SOUL.md` 由后续 bootstrap 直接写入 workspace，不阻塞 Gateway 启动。

这使“领取预热 Sandbox”和“为当前用户启动 OpenClaw”成为两个清晰阶段，避免不同用户
共享错误配置或未配置 Gateway 提前暴露端口。

### 2.5 固定 ACS 内的目录约定

镜像显式设置以下环境变量：

| 变量 | 路径 | 用途 |
| --- | --- | --- |
| `HOME` / `OPENCLAW_HOME` | `/home/node` | node 用户主目录 |
| `OPENCLAW_STATE_DIR` | `/home/node/.openclaw` | OpenClaw 状态目录 |
| `OPENCLAW_CONFIG_PATH` | `/home/node/.openclaw/openclaw.json` | 最终配置文件 |
| `OPENCLAW_WORKSPACE_DIR` | `/home/node/.openclaw/workspace` | Agent workspace |
| `ONYXCLAW_BOOTSTRAP_DIR` | `/home/node/.openclaw/bootstrap` | E2B 动态初始化目录 |

这些路径同时写入 Alibaba ACS Provider 配置，确保 APP/BFF、E2B Files API、镜像入口和
OpenClaw 对同一组文件位置达成一致。

### 2.6 root 初始化后降权运行

镜像入口以 root 启动，以便 ACS 注入的 envd、E2B 命令执行和初始化目录创建正常工作。
配置就绪后，入口将 `openclaw.json` 设置为：

- 所有者 `node:node`；
- 权限 `0600`。

随后通过 `setpriv` 降权，以 `node` 用户执行 Gateway：

```bash
exec setpriv --reuid=node --regid=node --init-groups \
  node /app/openclaw.mjs gateway --bind lan --port 18789
```

因此 root 仅承担容器初始化职责，OpenClaw 主进程不会长期以 root 身份运行。

### 2.7 调整 Gateway 监听方式

Gateway 固定监听 `18789`，并使用 `--bind lan`。这允许 ACS Sandbox 网络中的 E2B 端口
探测和 APP/BFF 访问 Gateway，而不是只绑定容器的 loopback 地址。Provider 配置中的
`gatewayPort` 同样固定为 `18789`。

镜像仍由 `tini -s` 作为 PID 1 启动，以正确转发终止信号和回收子进程，配合 Sandbox
的释放与超时清理。

## 3. 镜像外的 ACS 运行配置

以下内容不属于镜像层，但与派生镜像能否在 ACS 正常工作直接相关。

### 3.1 SandboxSet 计算规格

`iac/alicloud-acs/templates/sandboxset.yaml.tmpl` 为容器设置：

- `alibabacloud.com/acs: "true"`；
- `alibabacloud.com/compute-class: agent-sandbox`；
- `alibabacloud.com/compute-qos: default`；
- 不自动挂载 Kubernetes ServiceAccount Token；
- CPU 请求 1 核、上限 2 核；
- 内存请求 2 GiB、上限 4 GiB；
- 临时存储请求 10 GiB；
- 终止宽限期 30 秒。

### 3.2 Provider 约定

Alibaba ACS Provider 使用 E2B 兼容协议和集群内 Sandbox Manager 地址，默认用户为
`node`，workspace 为 `/home/node/.openclaw/workspace`，Gateway 端口为 `18789`，并把
OpenClaw 与 Channel Plugin 标记为镜像内预装。

### 3.3 Bootstrap 就绪闸门

APP/BFF 的初始化顺序为：

```text
领取 Sandbox
  → 登记一次性 Channel token
  → 直接写入最终 openclaw.json
  → 用户确认后写入 workspace/SOUL.md
  → 等待 Gateway :18789 就绪
  → 等待 Channel WebSocket 注册
  → 标记 Sandbox READY
```

任何阶段失败都会撤销 token 并 kill 半初始化 Sandbox，避免不可用实例继续占用 ACS
资源。

## 4. 构建与交付

`.github/workflows/release-openclaw-image.yml` 在 SemVer tag 推送后构建镜像，并交付：

- GHCR 中的版本镜像；
- `image@sha256:...` 不可变引用；
- registry manifest；
- SBOM 和 provenance；
- `linux/amd64`、可由 Docker Engine 24.x 使用 `docker load` 导入的 Docker-format
  `tar.gz`；
- SHA-256 校验文件。

压缩包可用于把同一镜像搬运到杭州同地域 ACR，减少 ACS 跨境拉取 GHCR 带来的延迟。
正式部署应使用 digest 固定的镜像 URI，而不是浮动 tag。

## 5. 未修改的部分

为便于后续升级和多云复用，当前实现明确没有：

- 修改或 fork OpenClaw 核心源码；
- 替换 OpenClaw 的 Agent、模型或 Gateway 核心实现；
- 把用户的 `SOUL.md`、模型密钥或 Channel 密钥烘焙进镜像；
- 在镜像中固化阿里云 AccessKey；
- 依赖阿里云专属 SDK 才能启动 OpenClaw。

阿里云差异由 E2B-compatible Provider、SandboxSet 和运行时 bootstrap 负责。镜像本身仍
保留迁移到其他支持容器与 E2B 类接口的 Sandbox Provider 的可能性。

## 6. 相关实现

- `iac/alicloud-acs/image/Dockerfile`
- `iac/alicloud-acs/image/entrypoint.sh`
- `iac/alicloud-acs/templates/sandboxset.yaml.tmpl`
- `packages/onyxclaw-channel/`
- `packages/cloud-runtime/src/openclaw-bootstrap.js`
- `config/providers.alicloud.example.json`
- `.github/workflows/release-openclaw-image.yml`
