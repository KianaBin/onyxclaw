# 阿里云 ACS Agent Sandbox 对接设计

## 1. 目标与范围

本阶段的目标不是建设完整云产品，而是用真实客户路径验证团队提供的 E2B 兼容
Sandbox 服务。因此只实现以下最短闭环：

```text
账号前置授权
  → IaC 创建 VPC / vSwitch / ACS 集群
  → 安装 Agent Sandbox 组件
  → 部署预装 OnyxClaw Channel Plugin 的 OpenClaw 预热池
  → APP/BFF 通过 E2B API 获取 Sandbox
  → 写入 OpenClaw 配置和 SOUL.md
  → Gateway 启动并完成 Channel 握手
  → 首次对话
  → kill Sandbox / IaC destroy 清理整套资源
```

当前不实现用户计费、控制台式资源管理、通用 Kubernetes 运维、持久卷、浏览器内
终端、代码解释器或多租户管理 UI。自定义 OpenClaw 镜像不依赖 `run_code`，仅使用
E2B 的 Sandbox 生命周期、文件和命令/端口访问能力。

## 2. 官方约束与决策

### 2.1 ACS 集群

ACS 是 ACK 的一种集群类型。OpenAPI 创建时必须使用：

- `cluster_type = ManagedKubernetes`；
- `profile = Acs`；
- `cluster_spec = ack.pro.small`；
- 仅支持 VPC；
- 建议至少两个不同可用区的 vSwitch；
- 若需拉取公网镜像或访问公网模型/Channel，必须提供 NAT/SNAT；也可把镜像放在
  同地域 ACR 并走 VPC 内网。

本项目 Terraform 使用 `alicloud_cs_managed_kubernetes` 的 `profile = "Acs"`，显式
创建 VPC 与两个 vSwitch。macOS 首次联调默认只开放 Kubernetes API Server 并启用
SNAT，不默认创建公网 Sandbox ALB；部署执行器迁入 VPC 后应关闭公网 API Server，并按
镜像与模型网络位置决定是否关闭 SNAT。

### 2.2 Agent Sandbox 组件

账号需先开通 Agent Sandbox 服务。已有集群至少需要：

- `acs-virtual-node >= v2.17.0`；
- 与 Kubernetes 小版本匹配的 Kube Scheduler；
- `ack-agent-sandbox-controller >= v0.5.14-release.1`；
- `ack-sandbox-manager >= v0.6.0`。

首次安装 controller 还必须授权服务角色
`AliyunCSManagedAgentSandboxRole`。开通服务和同意服务角色属于账号所有者的显式授权，
不能伪装成普通资源创建；IaC 用 `ONYXCLAW_ACS_ACCOUNT_READY=true` 表示操作者已经完成
并确认这两项动作。

Terraform 管理组件时不固定具体 patch 版本，让 ACS 安装当前可用版本；部署后的
preflight/验收必须读取实际版本并检查是否达到上述下限。后续生产化应把验收过的
版本写入环境锁文件，而不是盲目追随最新版。

`acs-virtual-node` 是 ACS profile 集群提供的基础组件，不通过独立
`alicloud_cs_kubernetes_addon` 资源重复安装；IaC 只显式安装两个 Sandbox 组件，部署后
检查 Virtual Node 和 Kube Scheduler 是否达到 Agent Sandbox 要求的版本。

### 2.3 E2B 协议入口

ACS 提供两种接入方式：

| 模式 | 路由 | 适用场景 | 本项目选择 |
| --- | --- | --- | --- |
| Native Protocol（原生协议） | `api.DOMAIN`，端口访问为 `<PORT>-<SANDBOX_ID>.DOMAIN` | 生产，需要泛域名和泛域名证书 | 后续生产验证 |
| Private Protocol（私有协议） | `DOMAIN/kruise/api`，端口访问为 `DOMAIN/kruise/<ID>/<PORT>` | 快速测试，只需单域名；SDK 需 `kruise-agents` patch | 首个云端 E2E |

第一轮采用 Private Protocol，减少泛域名和证书依赖。APP/BFF 与组件位于同一集群时，
使用 `sandbox-manager.sandbox-system.svc.cluster.local` 内网服务；macOS 调试使用官方文档
给出的 `kubectl port-forward`。栈默认只安装 ALB Ingress Controller 而不创建 ALB。
HTTPS 生产入口需要显式设置 `create_default_alb=true`，并同时完成 DNS、证书、ALB 443
Listener 和 Ingress 监听注解，不能只打开 `ingress.tls`。

阿里云当前明确支持 `Sandbox.create/get_info/list/kill/beta_pause/connect/set_timeout`、
`commands.run` 和 `files.read/write`；不支持预签名上传下载、logs、metrics、network、
lifecycle events 和 volumes。官方 Python SDK 兼容范围为 `e2b < 2.25.0`，参考组合为
`e2b==2.24.0` 与 `e2b-code-interpreter==2.7.0`。

### 2.4 自定义镜像

镜像修改的完整说明见 [OpenClaw 镜像的阿里云 ACS 适配说明](./openclaw-image-alibaba-acs-adaptation.md)。

ACS 要求自定义镜像至少包含 `cp`、`mv`、`mkdir` 和 `/bin/bash`。使用自定义镜像时，
`run_code` 暂不可用。本项目镜像从官方
`ghcr.io/openclaw/openclaw:2026.5.28` 派生，构建时完成以下动作：

1. 复制并安装 `packages/onyxclaw-channel`；
2. 校验 ACS 所需基础命令；
3. 让 ACS 注入的 envd 以 root 运行，以便创建 E2B 命令进程；
4. 等待 BFF 写入一次性 bootstrap 文件；
5. 原子复制 `openclaw.json` 和 `SOUL.md` 后，通过 `setpriv` 将 Gateway 降权为 node 用户。

基础镜像必须使用经过测试的具体版本或 digest，不能在正式环境使用浮动 `latest`。

派生镜像采用 Release 驱动发布：推送 `vX.Y.Z` tag 后，GitHub Actions 在 AMD64 Runner
中把镜像推送到 GitHub Container Registry（GHCR），并通过独立的缓存复用构建导出
Docker-format archive。工作流创建同名 GitHub Release，附加压缩 archive、registry
manifest、镜像 digest 和 SHA-256 校验文件。ACS 配置必须使用 Release 记录的
`image@sha256:...`；Release archive 可由 Docker Engine 24.x 使用 `docker load` 导入，
用于离线审计、恢复或镜像到其他 Registry。

GHCR Package 首次创建默认为私有，不能假设公开 GitHub 仓库会使它自动可匿名拉取。
第一轮云验证要求该 Package 为 Public；若不能公开，则改为镜像到同地域
Alibaba Cloud Container Registry（ACR）或显式配置 `imagePullSecret`。ACS 中安装的
当前 Public GHCR 路径不安装 `managed-aliyun-acr-credential-helper`，避免引入无关的
`AliyunCSManagedAcrRole` 授权。该 addon 只在未来切换到阿里云 ACR 私有镜像时启用，
且不能解决私有 GHCR 鉴权。
当前 `v0.1.2` 已发布成功，匿名访问 GHCR manifest 可用；其 OCI archive、manifest、
镜像引用和校验文件均已归档到同名 GitHub Release。为解决杭州 ACS 跨境拉取 GHCR
耗时过长，本轮把相同 digest 镜像到杭州 ACR，并由 SandboxSet 使用 ACR digest URI。

## 3. 资源拓扑

```text
Alibaba Cloud Account
└── Region
    ├── VPC
    │   ├── vSwitch-A
    │   ├── vSwitch-B
    │   └── NAT/SNAT（联调默认开启）
    └── ACS Cluster (profile=Acs)
        ├── managed-coredns / metrics-server / ALB ingress controller
        ├── acs-virtual-node
        ├── ack-agent-sandbox-controller
        ├── ack-sandbox-manager
        └── SandboxSet/onyxclaw
            └── N 个最终 OpenClaw 镜像的预热 Sandbox
                ├── agent-runtime/envd
                ├── OpenClaw Gateway :18789
                └── OnyxClaw Channel Plugin → APP/BFF Channel endpoint
```

第一轮不启用 CSI runtime。SOUL 和对话环境只需要覆盖单次 Sandbox 生命周期，移除 CSI
可以避免特权容器、hostPath 放行和 NAS/OSS 等与云服务验证无关的资源。需要验证 pause
后的持久性时，再以独立用例增加 CSI/NAS，而不是扩大基础栈。

## 4. IaC 生命周期

实现位于 `iac/alicloud-acs`，入口为：

```bash
npm run iac:alicloud -- plan
npm run iac:alicloud -- deploy
npm run iac:alicloud -- destroy
```

### 4.1 deploy

1. 校验阿里云凭据、Region、E2B domain、admin key、自定义镜像和账号前置授权确认；
2. 渲染 `SandboxSet`，只接受受限字符的镜像名和模板名，避免 YAML 注入；
3. `terraform init`；
4. `terraform apply` 创建网络、ACS 集群并安装组件；
5. 通过生成的 kubeconfig `kubectl apply` 预热池；
6. 云端验收检查组件版本、SandboxSet `AVAILABLE` 数量和 E2B templates API。

### 4.2 destroy

1. 优先删除 `SandboxSet`，等待预热和已释放 Sandbox 回收；
2. `terraform destroy` 删除组件、集群、NAT、vSwitch 和 VPC；
3. 删除本地生成的 kubeconfig 与 manifest。

验证栈强制 `deletion_protection=false`。生产栈应拆分持久基础设施与临时 workload，并
打开删除保护；不能直接复用当前 disposable stack 策略。

Terraform state 含 `sandbox_admin_api_key`。本地 state 已加入 Git ignore；团队环境必须
使用带访问控制、加密和锁的远端 Backend。后续可接入 KMS/Secret Manager，并在组件
安装后创建 Team 级 API Key，避免 APP 使用不可删除的 admin key。

## 5. 创建后首次即可对话

“Sandbox 已创建”不等于“OpenClaw 已可对话”。APP/BFF 必须把创建动作实现为一个有
就绪闸门的 Saga（补偿事务）：

1. 调用 `Sandbox.create(template="onyxclaw")` 领取最终镜像的预热实例；
2. 生成一次性 `instanceId`、Channel bootstrap token 和 OpenClaw 完整配置；
3. 先在 Channel 服务登记 bootstrap token；
4. 使用 E2B `files.write` 写入：
   - `/home/node/.openclaw/bootstrap/openclaw.json`；
   - `/home/node/.openclaw/bootstrap/SOUL.md`；
5. 镜像入口脚本检测到两个非空文件后，以 node 用户启动
   `openclaw gateway --bind lan --port 18789`；
6. BFF 同时等待：
   - Gateway `/readyz` 成功；
   - OnyxClaw Channel 使用 bootstrap token 完成 WebSocket 注册；
7. 两项都成功后，BFF 才把 Sandbox 标记为 `READY` 并允许 UI 进入聊天；
8. 首次进入聊天沿用现有逻辑，发送一次基于 `SOUL.md` 的 say hello；
9. 任一步失败，记录脱敏阶段错误并 `Sandbox.kill()`，不能把半初始化 ID 交给 UI。

建议阶段状态：

```text
ALLOCATING → BOOTSTRAPPING → GATEWAY_READY → CHANNEL_READY → READY
      └──────────── 任一步失败 ────────────→ CLEANING → FAILED
```

OpenClaw 配置至少包含模型 Provider、默认模型、workspace、Gateway 鉴权、
`plugins.load.paths=["/opt/onyxclaw/channel"]`、Plugin enablement，以及：

```json
{
  "channels": {
    "onyxclaw": {
      "enabled": true,
      "platformUrl": "wss://<channel-endpoint>",
      "bootstrapToken": "<one-time-secret>",
      "instanceId": "<sandbox-or-app-instance-id>"
    }
  }
}
```

模型密钥、Channel token 和完整配置不得烘焙进镜像、Terraform 变量、Provider Profile
或日志。它们由 BFF 的 Secret 来源在单次领取后写入；bootstrap token 注册成功即失效。

## 6. Provider 配置映射

阿里云 Profile 的非敏感信息：

- Provider ID：`alicloud-acs`；
- E2B Domain / 协议模式；
- Sandbox template：`onyxclaw`；
- HOME：`/home/node`；
- workspace：`/home/node/.openclaw/workspace`；
- Gateway port：`18789`；
- Plugin install mode：`preinstalled`；
- capability：pause/resume=true、files/commands=true、run_code=false、volumes=false。

Secret 单独注入：Sandbox Team API Key、模型 API Key、Channel signing secret。运行时状态
单独保存：Sandbox ID、bootstrap/session token、connection ID、ready phase 和 trace ID。

## 7. 验收清单

### 基础设施

- ACS Cluster profile 为 `Acs`，两个虚拟节点位于不同可用区；
- `acs-virtual-node`、controller、manager 实际版本达到最低要求；
- `kubectl get sbs onyxclaw` 的 `AVAILABLE` 达到目标副本数；
- `GET /kruise/api/templates` 可看到 `onyxclaw`；
- 未在 state、日志和 Git diff 中暴露真实密钥。

### Sandbox 与 OpenClaw

- create 返回 ID，files write/read 与 commands.run 成功；
- config 和 SOUL 写入后 Gateway `/readyz` 成功；
- Channel 只能用一次性 bootstrap token 注册，重放被拒绝；
- 首条 hello 与 SOUL 性格一致；
- 两轮消息、断线重连、connect 已有 Sandbox 均成功；
- kill 后端口和 Channel session 均不可访问。

### 清理

- `destroy` 可重复执行；
- SandboxSet、Sandbox、可选 ALB、CLB、NAT、vSwitch、VPC 和 ACS 集群无遗留；
- 若因账号侧保护或组件生成资源导致失败，脚本必须退出非零并列出资源 ID，不能报告
  假成功。

## 8. 已知边界与下一步

2026-07-19 已完成第一轮真实云端验证：

- IaC 创建 VPC、两个 vSwitch、ACS 集群，并安装 controller v0.5.21 与 manager v0.6.6；
- `SandboxSet/onyxclaw` 的两个 v0.1.2 预热实例达到 Available；
- v0.1.2 固定 digest 为
  `sha256:740dc2a7591f5cbca7e0bc10a8fc78f310738a3fd1648e3079c26b4c603d7eae`；
- `/run/e2b` 权限、envd root 身份和 Gateway 后续降权边界已验证；
- 使用官方 SDK 版本组合成功完成 `Sandbox.create`、`commands.run`、
  `files.write/read` 和 `kill`；
- 组件输入的 bootstrap admin key 会被 manager 转换，SDK 实际密钥来自
  `sandbox-system/e2b-key-store`，两者不能混用；
- ACS 不提供 cgroup v2 时 envd 会降级到 no-op cgroup manager，但本轮命令和文件 API
  仍正常工作；
- 曾因账户 `InsufficientBalance` 导致实例调度失败；充值后需删除旧失败 Sandbox，
  由 SandboxSet 重新创建，旧失败实例不会自动重试。

云端基础设施、预热池和 E2B 生命周期/命令/文件最小闭环已经完成。Alibaba ACS E2B
Adapter、bootstrap Saga、`SOUL.md` 写入、Gateway/Channel、MiniMax 首次 hello、
对话和 kill 已在真实 ACS 环境验证。2026-07-20 发布的云端 APP `app-v0.2.0` 使用
固定 digest
`sha256:47876460c633152839de567d84add25b58536a7ae09a91d475b6b1ce06d65839`，并完成
Provider 感知 UI 和 Sandbox Service API 可观测面板验证。下一步集中验证已有 Sandbox
的 connect/pause/resume 和 APP/Channel 跨重启状态恢复；Full E2E 完成后执行
`destroy` 验证无遗留。

## 9. 参考资料

- [阿里云：在 ACS 集群中创建 Agent Sandbox](https://help.aliyun.com/zh/cs/user-guide/create-an-agent-sandbox)
- [阿里云：创建 ACS 集群](https://help.aliyun.com/zh/cs/user-guide/create-an-acs-cluster)
- [阿里云：使用 E2B SDK 接入 Agent Sandbox](https://help.aliyun.com/zh/cs/user-guide/connect-to-agent-sandbox-using-the-e2b-sdk)
- [阿里云：Sandbox CRD 字段说明](https://help.aliyun.com/zh/cs/user-guide/sandbox-crd-field-descriptions)
- [Terraform Alibaba Cloud Provider：ACS/ACK Managed Kubernetes](https://registry.terraform.io/providers/aliyun/alicloud/latest/docs/resources/cs_managed_kubernetes)
- [Terraform Alibaba Cloud Provider：Kubernetes Addon](https://registry.terraform.io/providers/aliyun/alicloud/latest/docs/resources/cs_kubernetes_addon)
- [GitHub：Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub：Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker：Exporters overview](https://docs.docker.com/build/exporters/)
- [OpenClaw：官方 Docker 镜像与容器部署](https://docs.openclaw.ai/install/docker)
- [OpenClaw：Plugin 管理](https://docs.openclaw.ai/plugins)
