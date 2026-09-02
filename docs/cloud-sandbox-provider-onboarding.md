# Huawei CCE + AgentSphere Sandbox 对接操作指南

本文面向维护 Huawei CCE 上的 OnyxClaw APP 与 AgentSphere Sandbox 的研发、云架构和
交付团队。目标是把环境差异收敛在 Provider Profile、SDK Client 和小型 Adapter 内，
使上层 APP、OpenClaw 启动编排、Channel 和可观测逻辑保持稳定。

## 1. 对接目标与分层

一次完整对接不只是“能创建容器”。Provider 必须同时解决控制面、数据面、运行时镜像、
网络、密钥、状态恢复、观测和资源清理。

```text
APP / BFF / OpenClaw Bootstrap Saga
                 │
        Unified Sandbox Adapter
                 │
     Provider SDK Client / Protocol Patch
                 │
   Cloud Sandbox Manager ── Runtime/envd
                 │                  │
        lifecycle API       commands / files / ports
```

各层职责如下：

| 层 | 职责 | 不应承担的职责 |
| --- | --- | --- |
| APP/BFF | 用户流程、业务状态、Channel 会话 | 拼装厂商 URL、持有管理员密钥 |
| Bootstrap Saga | 创建、写配置、就绪探测、失败补偿 | 解析厂商私有响应 |
| Unified Adapter | 统一生命周期、命令、文件和错误语义 | 写入业务配置或处理聊天 |
| Provider Client | SDK 调用、协议兼容、路由和认证 | 暴露 Secret 到日志/UI |
| Provider Profile | 非敏感配置、能力声明 | 保存密钥、命令模板或运行时状态 |
| IaC | 网络、集群、组件、预热池和反向清理 | 保存最终用户会话状态 |

## 2. 需要考虑的接口

### 2.1 P0：业务闭环必需接口

以下能力是“创建 OpenClaw Sandbox 并完成首次对话”的最小集合。

| 能力 | 统一语义 | 关键输入 | 必须返回/保证 |
| --- | --- | --- | --- |
| `Sandbox.create` | 从模板领取或创建实例 | template、timeout、metadata、env、secure | 稳定 Sandbox ID；实例可继续执行文件和命令操作 |
| `Sandbox.connect` | 正常 resume 或进程重启后重新接管实例 | Sandbox ID | 正常 resume 只调用一次并继续使用原缓存；缓存丢失时才保存 connect 返回对象 |
| `Sandbox.kill` | 终止并回收实例 | Sandbox ID | 可重复调用；实例端口和运行时凭据最终失效 |
| `Commands.run` | 在 Sandbox 内执行命令 | command、user、timeout | exit code、stdout、stderr；明确超时和非零退出的错误语义 |
| `Files.write` | 写入运行时文件 | absolute path、content、user | 完整写入；明确覆盖、权限和父目录行为 |
| `Files.read` | 读取运行时文件 | absolute path、user | 原始内容或明确的编码；不存在和无权限错误可区分 |
| Port/URL routing | BFF 或用户访问 Sandbox 端口 | Sandbox ID、port、协议 | 稳定的 HTTP/WS 路由规则、TLS 和访问令牌语义 |
| Auth | 调用控制面和数据面 | Team/API Key | 密钥范围、轮换、吊销和最小权限边界 |

P0 接口还必须统一以下非功能语义：

- 每个调用的客户端超时、服务端超时和 Sandbox 生命周期 timeout；
- create/connect/kill 的幂等性与重试边界；
- Sandbox 状态枚举及最终一致性窗口；
- 控制面成功但数据面尚未就绪时的判断方式；
- API 限流、配额不足和账号欠费的可识别错误码；
- stdout、stderr、文件内容和响应体大小上限；
- 默认运行用户、HOME、workspace 和文件权限；
- Secret、命令和文件内容的日志策略。

### 2.2 P1：生产恢复与运维推荐接口

| 能力 | 用途 | 对接时重点确认 |
| --- | --- | --- |
| `Sandbox.get_info` | 查询单实例状态 | 状态延迟、终止后保留时间、端点信息 |
| `Sandbox.list` | 对账和孤儿资源清理 | 分页、metadata 过滤、创建时间过滤 |
| `Sandbox.set_timeout` | 延长会话 | 最大时长、是否从当前时间重新计时 |
| `Sandbox.pause` / `Sandbox.connect(id)` resume | 降低空闲成本、恢复老用户 | pause 保留原 SDK 对象和 token；resume 后数据操作不得再次隐式 connect |
| 进程管理 | 后台进程和日志 | PID/session、signal、重连后是否可追踪 |
| 健康检查 | 区分控制面、envd、业务进程是否就绪 | 厂商健康接口与业务 `/readyz` 不应混为一谈 |
| 生命周期事件 | 异步状态同步 | 投递顺序、重复事件、签名和补偿轮询 |

若厂商没有事件接口，BFF 必须使用带截止时间和退避的轮询，不能无限等待。

### 2.3 P2：增强能力

这些能力不是当前 OpenClaw 最小闭环的前提，但会影响大文件、审计和企业场景：

- 预签名上传/下载；
- 流式命令输出、日志和终端；
- CPU、内存、网络和费用指标；
- 出入站网络策略、固定出口和域名 allowlist；
- Volume、快照、克隆和跨实例挂载；
- 模板构建 API、镜像扫描、SBOM 和 provenance；
- GPU、架构、地域和资源规格选择；
- 审计事件、租户配额和成本标签。

未支持的能力必须通过 capability flags 明确声明，不能靠运行时试错。

当前 Profile schema v1 只内置 `pauseResume`、`memoryPersistence`、`publicEgress` 和
`vpc` 四项。commands、files、ports、run_code、volumes 等细分能力应先进入 Provider
差异矩阵和验收报告；扩展正式 schema 并更新 Registry 校验后，才能写入 Profile，不能
直接添加未被代码识别的字段制造“已支持”的假象。

## 3. 项目统一 Adapter 契约

当前项目实际使用的最小 TypeScript 形式契约如下：

```ts
interface SandboxProviderAdapter {
  createSandbox({ metadata, envs }): Promise<{
    sandboxId: string,
    status: "running"
  }>;
  connectSandbox(sandboxId): Promise<{
    sandboxId: string,
    status: "running"
  }>;
  runCommand(sandboxId, command): Promise<{
    exitCode: number,
    stdout: string,
    stderr: string
  }>;
  writeFile(sandboxId, absolutePath, stringOrBuffer): Promise<void>;
  readFile(sandboxId, absolutePath): Promise<string>;
  killSandbox(sandboxId): Promise<void>;
  close(): void;
}
```

新增厂商时优先让其 SDK Client 适配这个契约。只有以下情况才增加厂商专用 Adapter：

- create 和 connect 的生命周期语义无法通过参数映射统一；
- 命令或文件 API 的返回结构与 E2B 明显不同；
- 厂商需要协议 patch、额外 token 交换或特殊路由；
- pause/resume 等能力需要维护额外状态机。

Adapter 必须把底层异常包装成稳定的阶段错误，例如 create、connect、command、
file-read、file-write、kill，同时保留机器可读错误码。对用户展示的消息必须脱敏。

## 4. Provider Profile

Profile 只包含可提交、可评审的非敏感信息。Huawei 示例位于
[`config/providers.huaweicloud-agentsphere.example.json`](../config/providers.huaweicloud-agentsphere.example.json)。

需要收集的字段：

| 配置块 | 关键字段 | 说明 |
| --- | --- | --- |
| identity | ID、displayName、protocol | ID 一旦上线应保持稳定 |
| api | baseUrl、apiKeyEnv、compatibilityVersion、timeout | 外部入口必须 HTTPS；VPC 私网可显式允许 HTTP |
| sandbox | templateId、timeout、onTimeout、secure、user、路径 | HOME/workspace 必须为绝对路径 |
| openclaw | binary、gatewayPort、安装模式、Plugin 模式 | 建议预装并固定版本 |
| channel | URL、连接超时、签名密钥环境变量 | 外部使用 WSS，VPC 私网可显式使用 WS |
| model | provider、model、apiKeyEnv | 模型密钥独立于 Sandbox 密钥 |
| cleanup | pause、kill 或 keep-running | 测试环境默认 kill |
| capabilities | pauseResume、memoryPersistence、egress、VPC | 必须由验收测试证明 |

配置选择顺序为：代码安全默认值、Provider Profile、受信任部署环境选择、单次 run 的
非敏感 allowlist 参数。浏览器不得覆盖 Base URL、密钥环境变量名、运行用户或文件路径。

### 4.1 三类数据隔离

1. **Profile**：URL、模板、路径、timeout、能力声明和 Secret 环境变量名；
2. **Secret**：Sandbox API Key、模型 Key、Channel signing secret；
3. **运行时状态**：Sandbox ID、envd/traffic token、bootstrap/session token、trace ID。

Secret 由 Secret Manager 或部署环境注入。运行时 token 只保存在受控内存或加密状态库，
不能写回 Profile、镜像、Terraform 变量、浏览器 localStorage 或普通日志。

## 5. 标准接入步骤

### 步骤 1：厂商资料收集和差异表

在写代码前要求厂商提供：

- API/SDK 文档、兼容版本和变更策略；
- 控制面与数据面域名、VPC/公网路由、DNS 和证书要求；
- API Key 的创建、作用域、轮换和吊销方式；
- Sandbox 状态机、timeout、pause/resume 和清理语义；
- 默认镜像要求、CPU 架构、运行用户、必须存在的系统命令；
- commands、files、ports 的限制和错误码；
- 并发、运行时长、镜像大小、日志和流量限额；
- 地域、可用区、计费和欠费后的资源行为；
- 当前不支持的接口及替代方案。

输出一张“E2B 标准语义 / 厂商语义 / Adapter 处理 / 验收用例”差异表。

### 步骤 2：创建并校验 Profile

1. 复制通用示例并分配稳定 provider ID；
2. 填入非敏感配置和独立的 Secret 环境变量名；
3. 为每个能力填写布尔声明；
4. 通过 `ProviderRegistry` fail-fast 校验；
5. 检查 `toPublicSummary()` 只包含 ID、名称、协议和能力。

本项目校验包括 HTTPS/WSS、VPC 私网例外、绝对路径、正整数 timeout、允许的清理策略
以及一次性报告所有缺失 Secret。

### 步骤 3：实现 SDK Client 和 Adapter

1. 固定经过厂商验证的 SDK 版本；
2. 把认证和 Base URL 只传给 Client 构造器；
3. 实现 create、connect、command、file read/write 和 kill；
4. 为所有请求设置有限 timeout；
5. 规范化响应和错误，不向上层泄露厂商私有对象；
6. 在 `finally` 或 Saga 补偿中保证 kill；
7. 为运行中、成功和失败调用记录 API、目标、对象、耗时和脱敏操作详情。

操作详情可以记录命令、路径、模板和 Sandbox ID，但文件内容、模型配置、环境变量值和
token 不得进入观测数据。命令中的 key、token、password、secret 参数必须脱敏。

### 步骤 4：准备运行时镜像和模板

镜像应：

- 固定基础镜像版本或 digest；
- 包含厂商 runtime/envd 所需的基础命令和 shell；
- 预装 OpenClaw 和 Channel Plugin；
- 不包含任何环境密钥或用户配置；
- 使用 bootstrap 文件或受控入口等待运行时配置；
- 明确 envd 所需权限，并让业务进程降权运行；
- 提供 `/readyz` 或等价的业务就绪探针；
- 发布 registry digest、离线 archive、manifest、SBOM、provenance 和校验和。

部署必须引用 `image@sha256:...`。多架构镜像应使用顶层 image index digest，不要误用
SBOM/provenance attestation 子 manifest 的 digest。

### 步骤 5：打通网络

至少验证以下路径：

```text
BFF → Sandbox Manager control plane
BFF → Sandbox runtime/envd
BFF → OpenClaw Gateway /readyz
Sandbox → model endpoint
Sandbox → Channel WebSocket endpoint
Registry → Sandbox image pull
```

优先同地域 Registry 和 VPC 私网。必须记录 DNS、TLS、代理、NAT/SNAT、安全组、
NetworkPolicy、WebSocket idle timeout 和最大连接时长。端口转发只用于联调，不是生产路由。

### 步骤 6：实现 Bootstrap Saga

“create 成功”不代表 OpenClaw 可用。推荐状态机：

```text
ALLOCATING → BOOTSTRAPPING → GATEWAY_READY → CHANNEL_READY → READY
      └──────────── failure ────────────→ CLEANING → FAILED
```

标准流程：

1. create 获取 Sandbox ID；
2. 生成 instance ID、trace ID 和一次性 Channel bootstrap token；
3. 向 Channel 服务登记 token；
4. 写入 OpenClaw 配置和 `SOUL.md`；
5. 轮询 Gateway `/readyz`；
6. 等待 Channel WebSocket 完成注册；
7. 两个闸门均通过后才把状态标记为 READY；
8. 任一步失败都撤销 token 并 kill Sandbox。

### 步骤 7：可观测与审计

每个 Sandbox Service 调用至少记录：

- provider ID、API 名称、目标服务；
- startedAt、duration、running/succeeded/failed；
- Sandbox/File/Process 等后端对象及状态；
- 脱敏后的模板、路径、命令或 Sandbox ID；
- trace ID 和稳定错误阶段/错误码。

不要记录文件内容、完整配置、stderr 原文、进程环境和访问 token。生产环境还需把
API 延迟、失败率、创建成功率、就绪耗时、孤儿 Sandbox 数和清理失败数接入告警。

### 步骤 8：分层验收

| 阶段 | 用例 | 通过标准 |
| --- | --- | --- |
| 配置 | Profile 校验、缺失 Secret、非法 URL | 调云 API 前 fail-fast |
| 控制面 | create、get/list（如支持）、kill | ID 稳定，重复清理安全 |
| 数据面 | command、file write/read | 指定 user 成功，返回语义一致 |
| 恢复 | connect、pause/resume（如支持） | 原 Sandbox 和预期持久状态保留 |
| 网络 | Gateway、模型、Channel、Registry | DNS/TLS/WS 长连接均通过 |
| Bootstrap | 写配置、ready、Channel 注册 | READY 前不可聊天，失败自动回收 |
| E2E | hello、两轮消息、断线重连 | 内容正确，无重复事件 |
| 安全 | Secret 扫描、日志和 UI 检查 | 密钥、token、文件内容无泄漏 |
| 清理 | kill、预热池删除、IaC destroy | 无 Sandbox、负载均衡、NAT、VPC 等遗留 |

## 6. Huawei CCE + AgentSphere 参考实现

### 6.1 参考架构

本项目使用 CCE 承载 APP，AgentSphere 通过 E2B-compatible API 提供 Sandbox。每个
发布账号自行维护 Template、Secret、私网 endpoint、路由和安全组；仓库不保存这些环境的
真实标识或凭据。

### 6.2 关键能力与验收

| 能力 | 项目要求 |
| --- | --- |
| create/connect/kill | 以 Provider Profile 声明的 Template 进行真实验证 |
| commands.run、files.read/write | 使用 Template 的 `node` 用户验证 |
| pause/resume | 仅在 Profile 声明支持时进行恢复验收 |
| Channel 与 Gateway | 必须从 AgentSphere Sandbox 的网络视角验证 |
| 镜像与 Template | 使用不可变 digest，Template 由发布账号手工创建 |

### 6.3 AgentSphere Profile 要点

```json
{
  "id": "huaweicloud-agentsphere",
  "apiBaseUrl": "https://agentsphere.example.internal",
  "compatibilityVersion": "agentsphere-e2b-poc",
  "templateId": "replace-with-agentsphere-template-id",
  "defaultUser": "node",
  "homeDir": "/home/node",
  "workspaceDir": "/home/node/.openclaw/workspace",
  "gatewayPort": 18789,
  "cleanupPolicy": "kill"
}
```

真实配置使用仓库中的完整 Profile，以上片段仅用于说明关键映射。

### 6.4 标准 E2B-compatible 连接

Profile 必须使用 `sdkPatch: "none"`。控制面 `api.baseUrl` 和可选数据面
`api.sandboxUrl` 由 Profile 提供；本地调试地址不能写回 CCE 的运行时 Profile。

### 6.5 镜像注意事项

- OpenClaw Gateway 以 Template 约定的用户运行；
- bootstrap 配置通过运行时文件写入，不烘焙到镜像；
- 镜像只在 `demo-cn-south1` 基于已核验 digest 构建；
- push、CCE rollout 和 Template 替换必须分别得到明确授权。

### 6.6 密钥边界

AgentSphere API Key、模型 API Key 和 Channel signing secret 仅通过 CCE Secret 注入。它们
不得进入 Profile、镜像层、浏览器响应、日志或测试报告。

### 6.7 冒烟测试

基础 smoke 顺序：

```text
准备受控测试 Profile
  → Sandbox.create(template="<template-id>")
  → commands.run("id ...", user="node")
  → files.write("/tmp/...", ...)
  → files.read("/tmp/...", user="node")
  → finally Sandbox.kill()
```

镜像构建边界见
[`docs/huaweicloud-image-build-and-update.md`](./huaweicloud-image-build-and-update.md)；CCE、
AgentSphere 和 Template 的实际部署操作由
[onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click) 维护。

### 6.8 常见问题

| 现象 | 常见原因 | 检查与处理 |
| --- | --- | --- |
| SDK 401/403 | Secret 注入、账号权限或 Template 权限错误 | 检查 Secret 引用和 AgentSphere 授权 |
| 数据面不通 | Endpoint、私有 DNS、路由或安全组错误 | 从 CCE Pod 与测试 Sandbox 两侧分别验证 |
| Sandbox 长时间 Pending | 配额、Template 或服务端状态异常 | 查询 AgentSphere 状态并保留脱敏 request ID |
| 镜像拉取慢或超时 | Registry 鉴权或错误 digest | 在 `demo-cn-south1` 核验 digest 后再创建 Template |
| 容器没有 command | 部署了 attestation 子 manifest | 使用 image index/平台镜像 digest |
| command 权限错误 | envd 用户、运行用户或文件权限不匹配 | 分别确认 envd 权限和 `user="node"` |
| Gateway 未 ready | 配置未写完、模型/Channel 网络不通 | 查看 Bootstrap 阶段和脱敏命令详情 |
| cgroup 警告 | Template 运行时限制 | 确认 AgentSphere Template 行为，再验证命令/文件能力 |

## 7. 交付物清单

每个新 Provider 合入前应具备：

- Provider 差异与能力矩阵；
- 可提交的 Profile 示例和 Secret 名称清单；
- SDK 版本锁和 Adapter；
- 自定义镜像 Dockerfile、不可变 digest 和离线 archive；
- APP v19、干净 OpenClaw 基础镜像和完整 Channel 的 Dockerfile；
- contract tests、真实 smoke 和 Full E2E 报告；
- 错误码、观测字段、告警与脱敏说明；
- 构建验证、错误码、观测字段与脱敏说明；
- 已知限制、厂商联系人和升级兼容策略。

## 8. 代码导航

| 内容 | 路径 |
| --- | --- |
| Provider 校验和 Secret 映射 | `packages/cloud-config/src/provider-registry.js` |
| E2B-compatible Adapter | `packages/cloud-runtime/src/e2b-compatible-adapter.js` |
| Node/Python SDK Bridge | `packages/cloud-runtime/src/python-e2b-client.js`、`e2b-bridge.py` |
| Bootstrap Saga | `packages/cloud-runtime/src/openclaw-bootstrap.js` |
| Sandbox Service 观测 | `packages/local-console/src/observability.js` |
| Huawei Profile | `config/providers.huaweicloud-agentsphere.example.json` |
| Huawei 镜像构建与更新 | `docs/huaweicloud-image-build-and-update.md` |
| 实际部署操作 | `https://github.com/KianaBin/onyxclaw-one-click` |
| 聊天发布与验证证据 | `docs/huaweicloud-sandbox-resume-bug-tracker.md` |

对接新的 E2B 兼容厂商时，先从 Profile 和 SDK contract tests 开始；只有证明确有协议或
生命周期差异后，再引入专用 Adapter，避免厂商分支扩散到 APP 和业务编排层。
