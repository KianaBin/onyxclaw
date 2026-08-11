# OnyxClaw 华为云 CCE 学习与 AgentSphere 适配记录

> 建立日期：2026-08-11
> 当前阶段：阶段 0——架构与参数盘点
> 文档用途：持续记录学习结论、适配决策、实验结果、问题与验收证据。
> 操作指南：[`huaweicloud-agentsphere-cce-deployment.md`](./huaweicloud-agentsphere-cce-deployment.md)

## 1. 目标与范围

本次 POC 的目标是：

1. 在华为云 CCE 中运行 OnyxClaw Cloud APP；
2. Cloud APP 通过 AgentSphere 的 E2B 兼容 API 创建 Sandbox；
3. Sandbox 内运行预装 OnyxClaw Channel Plugin 的 OpenClaw；
4. Channel Plugin 通过 WSS 主动连接 Cloud APP；
5. 完成 `SOUL.md` 写入、Gateway 就绪、Channel 就绪和真实文本对话；
6. 测试结束后可靠回收 Sandbox，并保留脱敏验收证据。

本阶段不包含：

- 多租户、计费和用户体系；
- Cloud APP 多副本和业务状态持久化；
- 语音、媒体和完整聊天产品能力；
- 未经确认的公网入口。

## 2. 目标架构

```text
运维浏览器
  │
  │ HTTP/HTTPS（POC 优先使用 port-forward 或私网入口）
  ▼
华为云 CCE
  └─ OnyxClaw Cloud APP（单副本）
       ├─ HTTP :3000  Web UI / BFF API
       ├─ WS   :18890 Channel Simulator
       │
       ├─ HTTPS ──────────────► AgentSphere E2B API
       │                           │
       │                           └─ create/connect/commands/files/kill
       │                                      │
       │                                      ▼
       │                              OpenClaw Sandbox
       │                                ├─ OpenClaw Gateway :18789
       │                                └─ OnyxClaw Channel Plugin
       │                                           │
       └─ 私网 ELB :443 ◄──────────── WSS ─────────┘
            TLS 终止后转发到 Pod :18890
```

### 2.1 AgentSphere 平台背景

AgentSphere 是面向 Agent 应用的一站式基础设施组合，主要由三项核心产品组成：

| 产品 | 平台职责 | 与 OnyxClaw 当前 POC 的关系 |
| --- | --- | --- |
| Agent Sandbox | 为 Agent 提供隔离运行环境、生命周期、命令和文件能力，并兼容主流 E2B 接口与 SDK | 当前直接对接对象；承载 OpenClaw Sandbox |
| Agent Gateway | 为 Agent 应用提供统一流量入口、路由、治理或服务接入能力 | 当前不是必选主链路；若 AgentSphere 要求通过它暴露 E2B、模型或 Channel，再单独接入 |
| Agent Identity | 为 Agent 提供身份、凭据、授权或访问控制能力 | 当前 POC 先使用 Kubernetes Secret/API Key；生产化阶段再评估集成 |

AgentSphere 面向两类主要场景：

- Agent 强化学习（RL）训练；
- Agent 在线服务。

OnyxClaw 当前属于“Agent 在线服务 + Sandbox 端到端验证”场景，不涉及 RL 训练流程。
本项目需要 Agent Sandbox 兼容的 E2B 能力为：create、connect、commands、files 和 kill。

术语必须严格区分：

- **AgentSphere Agent Gateway**：AgentSphere 平台产品；
- **OpenClaw Gateway**：运行在 Sandbox 内、承载 OpenClaw Agent/Channel 的进程；
- **OnyxClaw Channel WSS 入口**：Cloud APP 内 Simulator 对 Channel Plugin 提供的连接入口。

三者不是同一个组件，也不能互换 Endpoint。

### 2.2 已确认的架构原则

- Cloud APP 是长驻的 BFF 和 Channel 服务，部署在 CCE；
- AgentSphere 用于运行按需创建的 OpenClaw Sandbox；
- 控制面方向为 `CCE Pod → AgentSphere E2B API`；
- Channel 方向为 `AgentSphere Sandbox → CCE 私网 ELB → Cloud APP`；
- Sandbox 不能使用 CCE 的 `ClusterIP` 或 `*.svc.cluster.local` 地址；
- WSS 由私网 ELB 终止 TLS，当前 Node Simulator 后端仍使用普通 WS；
- POC 期间 Cloud APP 保持单副本，避免内存状态和 WebSocket session 跨 Pod 丢失。

## 3. 当前代码认知

### 3.1 核心调用链

```text
cloud-app.js
  → ProviderRegistry
  → E2BCompatibleAdapter
  → Python E2B Client / e2b-bridge.py
  → CloudConsoleController
  → OpenClawBootstrapSaga
  → WsPlatformSimulator
```

| 模块 | 主要职责 | 学习状态 |
| --- | --- | --- |
| `packages/cloud-runtime/src/cloud-app.js` | 装配 Provider、Adapter、Controller、Saga、Simulator 和 HTTP Server | 学习中 |
| `packages/cloud-config/src/provider-registry.js` | 校验 Provider Profile，映射 Secret，生成安全公开摘要 | 学习中 |
| `packages/cloud-runtime/src/e2b-compatible-adapter.js` | 统一 create/connect/commands/files/kill 语义 | 待深入 |
| `packages/cloud-runtime/src/python-e2b-client.js` | 管理 Node 与 Python JSON 行协议 bridge | 待深入 |
| `packages/cloud-runtime/src/e2b-bridge.py` | 调用 Python E2B SDK | 待深入 |
| `packages/cloud-runtime/src/openclaw-bootstrap.js` | 写入配置、等待双就绪、失败补偿 | 学习中 |
| `packages/test-orchestrator/src/ws-simulator.js` | 接受 Channel 注册，收发消息，管理 session | 已建立初步认识 |
| `packages/onyxclaw-channel` | Sandbox 内的 Channel Plugin | 已建立初步认识 |

### 3.2 当前 E2B 契约

Cloud APP 当前需要 AgentSphere 兼容：

```text
Sandbox.create
Sandbox.connect
Sandbox.kill
commands.run
files.write
files.read
```

Cloud APP 使用的 SDK：

```text
e2b==2.24.0
```

当前只需要 Sandbox 创建、连接、启停、命令和文件能力，不引入 Code Interpreter。

### 3.3 当前实现边界

- Controller、Sandbox session、bootstrap token 和 Channel session 主要保存在内存；
- Cloud APP 重启或滚动更新后不能保证恢复已有 Channel；
- 当前应使用 `replicas: 1`；
- `/api/status` 返回 200 不代表 AgentSphere E2B 和 Channel 已经就绪；
- `channel.signingSecretEnv` 当前会被配置层读取，但 Channel 握手实际依赖一次性
  bootstrap token 和 session token，尚未实现额外的 signing-secret 签名校验；
- 当前 Simulator 不直接提供 TLS，WSS 需要由 ELB 终止；
- Sandbox Template 必须在收到 bootstrap 文件后自动启动 Gateway，Bootstrap Saga
  本身不会额外执行启动命令。

## 4. 分阶段计划与闸门

| 阶段 | 目标 | 通过闸门 | 状态 |
| --- | --- | --- | --- |
| 0 | 架构和参数盘点 | 所有关键参数有明确来源，架构无歧义 | 进行中 |
| 1 | 本地 Cloud Runtime 基线 | Cloud 单测通过，调用链可解释 | 未开始 |
| 2 | AgentSphere E2B 契约验证 | create/commands/files/connect/kill 成功 | 未开始 |
| 3 | Sandbox Template 验证 | 写入 bootstrap 文件后 Gateway 自动 Ready | 未开始 |
| 4 | Cloud APP 部署到 CCE | Pod Ready，Provider ID 正确 | 未开始 |
| 5 | CCE 到 AgentSphere 控制面 | Cloud APP 成功创建并清理 Sandbox | 未开始 |
| 6 | Sandbox 到 Cloud APP WSS | DNS、TLS、Upgrade、Plugin 注册成功 | 未开始 |
| 7 | OpenClaw Bootstrap 闭环 | Gateway Ready + Channel Ready | 未开始 |
| 8 | 真实对话和清理 | hello、两轮消息、kill 全部成功 | 未开始 |
| 9 | POC 加固和交接 | 安全、观测、重启边界和资源清单明确 | 未开始 |

### 阶段 0：架构与参数盘点

目标：在创建任何付费资源之前明确平台契约、网络拓扑和责任边界。

待完成：

- [x] 确认 Cloud APP 部署在 CCE，而非 AgentSphere Sandbox；
- [x] 确认华为云 Region 和 CCE 类型；
- [ ] 获得 AgentSphere E2B Endpoint 和兼容版本说明；
- [ ] 获得 API Key，但不记录真实值；
- [ ] 获得或制作 OpenClaw Template；
- [ ] 确认 CCE 与 AgentSphere VPC 关系；
- [ ] 确认模型位置和 Sandbox 到模型的网络；
- [ ] 确认 Channel 私有域名、证书和私有 DNS；
- [ ] 确认 Sandbox 出站访问 WSS 的策略；
- [ ] 确认费用、资源创建权限和清理负责人。

通过标准：第 5 节参数表不再有影响架构的“未知”项。

### 阶段 1：本地 Cloud Runtime 基线

计划操作：

```bash
npm ci
npm run test:cloud
```

通过标准：

- [ ] Cloud 单元测试通过；
- [ ] 可以解释 Provider → Adapter → Python bridge 的调用链；
- [ ] 可以解释 `ALLOCATING → BOOTSTRAPPING → GATEWAY_READY → CHANNEL_READY → READY`；
- [ ] 明确失败时 revoke token 和 kill Sandbox 的补偿行为。

### 阶段 2：AgentSphere E2B 契约验证

建议按以下顺序验证：

```text
create
→ commands.run("id")
→ files.write
→ files.read
→ connect
→ kill
```

通过标准：

- [ ] create 返回稳定的 Sandbox ID；
- [ ] commands 使用预期默认用户；
- [ ] files 能操作绝对路径并逐字节读回；
- [ ] connect 能重新获得操作 session；
- [ ] kill 后实例确实释放；
- [ ] 错误中包含可定位的 statusCode/requestId，且无 Secret 泄露。

### 阶段 3：Sandbox Template 验证

Template 必须完成：

- [ ] 预装兼容版本的 OpenClaw；
- [ ] 预装 `/opt/onyxclaw/channel`；
- [ ] 准备 `/home/node/.openclaw/bootstrap`；
- [ ] 等待 `openclaw.json` 和 `SOUL.md` 两个非空文件；
- [ ] 复制文件并设置正确 owner/mode；
- [ ] 启动 Gateway `:18789`；
- [ ] Sandbox 内访问 `/readyz` 成功；
- [ ] Plugin 能读取 `channels.onyxclaw` 配置。

### 阶段 4：Cloud APP 部署到 CCE

通过标准：

- [ ] 镜像已推送到 SWR，并使用不可变 digest；
- [ ] Deployment 为单副本；
- [ ] ConfigMap 挂载 Provider Profile；
- [ ] Secret 注入 E2B、模型和 Channel 配置；
- [ ] Pod Ready；
- [ ] `/api/ui-config` 返回 `huaweicloud-agentsphere`；

### 阶段 5：CCE 到 AgentSphere 控制面

排查顺序固定为：

```text
DNS → TCP → TLS → HTTP → API 鉴权 → Template 权限 → E2B SDK 语义
```

通过标准：Cloud APP API 返回 `mode=allocated` 和非空 `sandboxId`，随后能够 kill。

### 阶段 6：Sandbox 到 Cloud APP WSS

目标路径：

```text
wss://channel.<private-domain>/connect:443
  → CCE 私网 ELB TLS 终止
  → Cloud APP Pod ws://:18890
```

排查顺序：

```text
Sandbox DNS → TCP/443 → TLS/SNI/CA → HTTP Upgrade → WebSocket 注册 → 心跳
```

通过标准：Cloud APP 观察到对应 `instanceId` 的 `connectionId`。

### 阶段 7：Bootstrap 闭环

通过标准：

- [ ] E2B Files 写入两个 bootstrap 文件；
- [ ] Gateway `/readyz` 成功；
- [ ] Channel 使用一次性 bootstrap token 注册；
- [ ] APP 状态进入 `READY`；
- [ ] 失败用例能够自动 revoke token 并 kill 半初始化 Sandbox。

### 阶段 8：对话和清理

通过标准：

- [ ] 首次 hello 与 `SOUL.md` 一致；
- [ ] 两轮消息走 Channel 往返成功；
- [ ] 能观察 inbound/outbound event ID 和耗时；
- [ ] reset/stop 后 Sandbox 被 kill；
- [ ] WSS session 不再可用；
- [ ] 无残留 Sandbox 和真实凭据日志。

## 5. 参数盘点

只记录非敏感值。API Key、token、kubeconfig 和证书私钥不得写入本文件。

### 5.1 华为云与 CCE

| 参数 | 当前值 | 来源/负责人 | 状态 |
| --- | --- | --- | --- |
| Region | 测试环境（西南-贵阳-全栈 ARM 大 Beta） | 用户提供 | 已知，正式 Region 标识待确认 |
| CCE 集群名称/ID | 待确认 |  | 未知 |
| CCE 类型和版本 | CCE Turbo；Kubernetes 版本待确认 | 用户提供/CCE | 部分确认 |
| Kubernetes namespace | 已有 `onyxclaw-app` Service；namespace 待确认 | 用户提供/CCE | 部分确认 |
| 现有 APP Service | `onyxclaw-app` | 用户提供 | 已存在，端口和 selector 待核验 |
| CCE 节点架构 | 推测为 `arm64`，必须读取 node label 确认 | CCE | 待验证 |
| CCE VPC CIDR | 待确认 |  | 未知 |
| CCE 子网 CIDR | 待确认 |  | 未知 |
| CCE 容器 CIDR | 待确认 |  | 未知 |
| SWR 仓库 | 待确认 |  | 未知 |
| 私网 ELB ID/类型 | 待确认 |  | 未知 |

### 5.2 AgentSphere

| 参数 | 当前值 | 来源/负责人 | 状态 |
| --- | --- | --- | --- |
| E2B API Base URL | `https://sandbox-service-internel.cn-southwest-301.beta.myhuaweicloud.com` | AgentSphere 接入信息 | 已确认 |
| 候选控制服务 | `default` namespace 中的 `sandbox-apiserver` 工作负载，单实例 | CCE 控制台 | 已运行，管理面确认兼容 E2B API |
| 候选控制 Service | `sandbox-apiserver-elb`，通过 ELB 暴露 8080/10443 | CCE 控制台 | 已存在 |
| ELB VIP | `10.83.60.243`（RFC1918 私网地址，不是公网 IP） | CCE 控制台 | 已确认 |
| E2B SDK 兼容版本 | 使用 `from e2b_code_interpreter import Sandbox`；具体版本待确认 | AgentSphere 团队 | 部分确认 |
| API Key 已准备 | 已创建，可由用户管理；真实值不记录 | AgentSphere 管理面 | 已确认 |
| Sandbox URL | AgentSphere 内部入网网关地址；具体值不记录/待配置 | AgentSphere 接入信息 | 已确认其用途，待确认格式 |
| `Sandbox.create` 参数 | `api_key, api_url, sandbox_url, template, timeout, secure, envs, metadata, lifecycle` | AgentSphere SDK 示例 | 已获得概要，精确签名待确认 |
| Template ID | 管理面已有 Sandbox Template，具体 ID 和启动契约待核验 | AgentSphere 管理面/团队 | 部分确认 |
| 默认用户 | `node`（假设） | Template 定义 | 待确认 |
| HOME | `/home/node`（假设） | Template 定义 | 待确认 |
| workspace | `/home/node/.openclaw/workspace`（假设） | Template 定义 | 待确认 |
| Gateway 端口 | `18789`（项目默认） | 项目约定 | 待确认 |
| AgentSphere VPC CIDR | 待确认 | 网络团队 | 未知 |
| pause/resume | 待确认 | AgentSphere 团队 | 未知 |

### 5.3 Channel WSS

| 参数 | 当前值 | 来源/负责人 | 状态 |
| --- | --- | --- | --- |
| Channel 私有域名 | 待确认 | DNS/网络团队 | 未知 |
| WSS URL | `wss://<domain>/connect`（目标） | 项目约定 | 待确认 |
| TLS 证书 ID | 不在本文记录私钥 | 证书团队 | 未知 |
| 私有 DNS Zone | 待确认 | DNS 团队 | 未知 |
| Sandbox 到 443 出站 | 待确认 | AgentSphere/网络团队 | 未知 |
| ELB 到 Pod 18890 | 待确认 | CCE/网络团队 | 未知 |

### 5.4 模型

| 参数 | 当前值 | 来源/负责人 | 状态 |
| --- | --- | --- | --- |
| Provider | 倾向外部模型 API，尚未选定 | 用户提供/模型团队 | 部分确认 |
| Model ID | 待确认 | 模型团队 | 未知 |
| Endpoint | 待确认 | 模型团队 | 未知 |
| Sandbox 网络可达 | 待确认 | 网络/模型团队 | 未知 |
| API Key 已准备 | 否/待确认 | 模型团队 | 未知 |

## 6. 决策记录

| 日期 | 决策 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-08-11 | Cloud APP 部署在 CCE，OpenClaw 部署在 AgentSphere Sandbox | Cloud APP 需要稳定入口和长连接；Sandbox 适合按需运行 OpenClaw | 需要双向私网路径 |
| 2026-08-11 | POC 使用单副本 Cloud APP | 当前业务和 Channel 状态保存在内存 | 暂不支持滚动无损恢复和水平扩容 |
| 2026-08-11 | 目标 Channel 使用 WSS | 保护 bootstrap/session token 和消息内容 | 需要 ELB TLS 终止、证书和私有 DNS |
| 2026-08-11 | 使用基础版 `e2b.Sandbox` | 当前重点是 Sandbox 生命周期，不需要 `run_code` | bridge 保持最小依赖 |
| 2026-08-11 | 当前 POC 直接对接 Agent Sandbox，暂不把 Agent Gateway 和 Agent Identity 作为前置依赖 | 创建 Sandbox、OpenClaw 启动和 Channel 回连是当前最小闭环 | 若平台规范要求统一网关或身份接入，再增加对应阶段 |
| 2026-08-11 | 接入验证先看 E2B Python SDK 和原始 HTTP API，暂不评估 CLI | 现有 Cloud APP 使用 Python SDK；HTTP API 用于核对契约、排障和必要时实现专用 Client | 先获得 SDK 示例与 OpenAPI/curl 示例，再决定是否修改 bridge |

## 7. 实验记录

每次实验复制以下模板，禁止粘贴真实 Secret。

```markdown
### YYYY-MM-DD 实验名称

- 目标：
- 环境：
- Git commit：
- Cloud APP image digest：
- Sandbox template/version：
- 操作命令：
- 预期结果：
- 实际结果：
- statusCode/requestId/traceId：
- 日志位置：
- 结论：通过 / 失败 / 阻塞
- 后续动作：
```

## 8. 问题与风险清单

| 编号 | 问题/风险 | 所属阶段 | 状态 | 下一动作 |
| --- | --- | --- | --- | --- |
| R-001 | AgentSphere E2B SDK 兼容范围尚未确认 | 0/2 | 开放 | 向 AgentSphere 团队索取契约和示例 |
| R-002 | Sandbox Template 启动契约尚未验证 | 0/3 | 开放 | 验证 bootstrap 文件监听和 Gateway 启动 |
| R-003 | CCE 与 AgentSphere 的双向网络尚未确认 | 0/5/6 | 开放 | 收集 CIDR、路由、DNS 和安全组 |
| R-004 | WSS 域名、证书和 CA 信任尚未准备 | 0/6 | 开放 | 确认证书与私有 DNS 方案 |
| R-005 | Cloud APP 重启会丢失内存 session | 9 | 已知边界 | POC 单副本且避免中途重启 |
| R-006 | signing secret 尚未参与实际 Channel 签名 | 9 | 已知边界 | 生产化前补签名校验或明确删除配置 |
| R-007 | 文档镜像 tag 可能滞后 | 4 | 开放 | 部署时记录当前 commit 和 image digest |
| R-008 | CCE 可能是 ARM64，而历史 Cloud APP Release 以 linux/amd64 为主 | 0/4 | 开放 | 核验 node arch、现有 Pod image 和镜像 manifest，必要时构建 arm64/multi-arch 镜像 |
| R-009 | AgentSphere 与 CCE 是否确实同 VPC 尚未核验 | 0/5/6 | 开放 | 在控制台核对双方 VPC ID，而不是仅凭可见性推断 |
| R-010 | 已确认 E2B API URL，但 CCE 到该地址的 DNS、TLS 和鉴权尚未实测 | 2/5 | 开放 | 使用 `e2b==2.24.0` 做最小生命周期验证 |
| R-011 | `sandbox_url` 的配置位置和基础 SDK 映射尚未实测 | 1/2 | 开放 | 先按兼容 E2B 标准路径验证 create/kill，失败时保留 SDK 请求信息再确认参数 |
| R-012 | 基础 E2B SDK 与 AgentSphere 的启停语义需远端确认 | 1/2 | 开放 | 验证 create/connect/kill，不引入 Code Interpreter |

## 9. 安全与操作规则

- 不在 Git、Markdown、ConfigMap 或普通 Deployment YAML 中保存真实 Secret；
- 不在聊天记录中发送 API Key、kubeconfig、token 或证书私钥；
- 使用 Kubernetes Secret 或华为云密钥管理服务注入敏感值；
- UI 和 API 在 POC 阶段仅通过 port-forward 或受控私网访问；
- 不把 `X-OnyxClaw-Request: local-ui` 当作正式鉴权；
- 创建 Sandbox 前明确清理命令和资源负责人；
- 每次失败检查是否残留 Sandbox；
- 镜像使用 digest，不使用浮动 `latest`；
- 日志和验收报告必须脱敏；
- 删除云资源前先只读确认资源 ID 和归属。

## 10. 下一步

阶段 0 当前需要补齐：

1. Cloud APP 是否确定部署在已有 CCE；
2. CCE Region、类型、版本和网络 CIDR；
3. AgentSphere E2B Endpoint、兼容版本和 Template；
4. 模型位置和 Sandbox 到模型的网络；
5. Channel 私有域名、证书和 Sandbox 到 WSS 的网络路径。

补齐上述非敏感参数后，进入阶段 1：建立本地 Cloud Runtime 测试基线。

### 10.1 2026-08-11 阶段 0 首轮输入

- CCE 中已存在名为 `onyxclaw-app` 的 Service；
- CCE 类型为 CCE Turbo；
- Region 展示为“测试环境（西南-贵阳-全栈 ARM 大 Beta）”；
- AgentSphere 管理面已有部分 Sandbox 实例和 Sandbox Template；
- CCE 与 AgentSphere 可能位于同一个 VPC，但尚未比较 VPC ID；
- 模型可能使用外部 API，Provider、Endpoint 和网络策略未确定；
- Channel 私有域名、证书和 WSS 入口尚未确定；
- 当前本机已安装 `kubectl`，但未配置 current-context，暂时不能读取 CCE 资源。
- CCE `default` namespace 中已有单实例 `sandbox-apiserver` 工作负载；
- 工作负载通过名为 `sandbox-apiserver-elb` 的 Service/ELB 暴露 8080 和 10443；
- AgentSphere 管理面确认该服务兼容 E2B API；
- 内部 Service 域名为 `sandbox-apiserver-elb.default.svc.cluster.local`；
- ELB VIP 为 `10.83.60.243`，属于 RFC1918 私网地址，不是公网 IP；
- 仍需确认 8080/10443 分别对应的协议，以及 SDK 所需的 `E2B_API_URL`、`E2B_DOMAIN`
  和兼容版本，随后才能形成最终 Provider Base URL。
- 已获得 AgentSphere 正式 E2B API URL：
  `https://sandbox-service-internel.cn-southwest-301.beta.myhuaweicloud.com`；
- E2B API Key 已由用户创建并可管理，真实值不进入本文；
- AgentSphere 另提供 `sandbox_url`，它是内部入网网关地址；
- 创建使用 E2B Python SDK，概要参数为 `api_key`、`api_url`、`sandbox_url`、`template`、
  `timeout`、`secure`、`envs`、`metadata` 和 `lifecycle`；
- 本项目继续使用 `from e2b import Sandbox`；当前只验证生命周期、命令和文件能力；
- `sandbox_url` 和 `lifecycle` 是否需要显式传入，以远端基础 SDK 实测结果为准。

下一轮优先获取：

1. `onyxclaw-app` 所在 namespace、Pod 镜像和节点架构；
2. AgentSphere 基础 E2B SDK 的 create/connect/kill 实测结果；
3. 已有 Template 的 ID、镜像、默认用户、路径和启动命令；
4. CCE 与 AgentSphere 的实际 VPC ID；
5. 可供 Sandbox 访问的模型 API 与 WSS 域名方案。

## 11. 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-08-11 | 建立文档，记录目标架构、阶段闸门、参数表、已知边界和风险清单 |
| 2026-08-11 | 记录首轮环境信息：CCE Turbo、ARM 测试 Region、现有 APP Service 和 AgentSphere Template；新增 ARM 与 VPC 核验风险 |
| 2026-08-11 | 登记 `sandbox-apiserver` 候选服务，等待核验其 Service DNS、API 契约和 E2B SDK 兼容性 |
| 2026-08-11 | 修正资源描述：`default/sandbox-apiserver` 是单实例工作负载，由 `sandbox-apiserver-elb` 暴露 8080/10443 |
| 2026-08-11 | 管理面确认 sandbox-apiserver 兼容 E2B；登记内部 Service DNS 与私网 ELB VIP，等待确认 SDK URL/domain 参数 |
| 2026-08-11 | 补充 AgentSphere 产品背景，区分 Agent Sandbox、Agent Gateway、Agent Identity 与 OpenClaw Gateway |
| 2026-08-11 | 确定首轮接入方式：优先验证 E2B Python SDK，同时核对原始 HTTP API，CLI 暂缓 |
| 2026-08-11 | 获得 AgentSphere E2B API URL、可管理 API Key 和 `sandbox_url`/`lifecycle` 创建契约概要；登记 bridge 适配差异 |
| 2026-08-11 | 决定继续使用基础版 `e2b.Sandbox`，当前只关注 Sandbox 启停和必要的命令/文件操作 |
| 2026-08-11 | 当前分支移除云厂商专用 IaC、SDK patch 和兼容别名，保留本地运行与 AgentSphere 主链路 |
