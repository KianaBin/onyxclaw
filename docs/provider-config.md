# 云 Provider 配置管理

Huawei CCE + AgentSphere 的非敏感配置字段和环境变量名称使用本文及
[Huawei AgentSphere 示例](../config/providers.huaweicloud-agentsphere.example.json)。镜像构建与更新见
[Huawei 镜像构建方案](./huaweicloud-image-build-and-update.md)；实际部署操作由
[onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click) 维护。

## 目标

OnyxClaw 使用一个 E2B 兼容实现对接多个后端厂商。厂商差异优先通过 Provider
Profile 和 capability flags 表达；只有请求或生命周期语义无法兼容时，才增加专用
Adapter。

浏览器只提交 `providerId`，不能提交任意 API URL、密钥环境变量名或命令，避免
SSRF 和配置注入。

## 对接前需要云厂商提供的信息

| 分类 | 必需信息 | 配置位置 |
| --- | --- | --- |
| Provider 身份 | 稳定 ID、展示名称 | Profile |
| 兼容契约 | E2B API/SDK 兼容版本、已知差异 | `api.compatibilityVersion`、`api.sdkPatch` 和对接记录 |
| API 地址 | 控制面 Base URL | `api.baseUrl` |
| API 认证 | API Key 的环境变量名、认证 Header 是否兼容 | `api.apiKeyEnv`；真实值进 Secret Manager |
| Template | Template ID、默认 OS/用户、Node/OpenClaw 是否预装 | `sandbox`、`openclaw` |
| 生命周期 | 默认 timeout、超时 pause/kill、connect 是否恢复 Paused | `sandbox.timeoutMs/onTimeout` |
| 持久化 | pause 是否保留文件系统、内存和进程 | `capabilities.memoryPersistence` |
| 文件系统 | HOME、OpenClaw workspace 的绝对路径 | `sandbox.homeDir/workspaceDir` |
| Commands | 前后台命令、exit code、stdout/stderr、signal 支持情况 | 兼容测试，不配置任意命令模板 |
| OpenClaw | binary、版本、Gateway 端口、安装方式 | `openclaw` |
| Plugin | 预装或运行时上传包 | `openclaw.pluginInstallMode` |
| 模型 | Provider、测试模型、API Base URL（如需）、密钥引用 | `model` |
| Channel 网络 | Sandbox 可访问的公开 WSS URL、VPC/公网、DNS/TLS/代理 | `channel`、`capabilities` |
| 安全模式 | secure sandbox、envd/traffic token 行为 | `sandbox.secure` 和兼容测试 |
| 清理策略 | 成功/失败后 pause、kill 或保留 | `cleanupPolicy` |
| 限额 | 最大运行时长、并发数、暂停保留期 | 对接记录和测试参数 |

## 三类数据必须分开

### 1. 可提交的 Provider Profile

存放非敏感、可评审的配置：API URL、Template ID、路径、timeout、能力声明和密钥
环境变量名。参考 [Huawei AgentSphere 示例](../config/providers.huaweicloud-agentsphere.example.json)。

实际部署可以挂载 `config/providers.local.json`，该文件默认被 Git 忽略。

### 2. Secret

以下值不进入 Profile、浏览器、日志或报告：

- 云厂商 API Key；
- 模型 API Key；
- Channel signing secret；
- 其他厂商私有凭据。

Profile 只保存类似 `HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY` 的环境变量名，真实值由环境变量或云
Secret Manager 注入。参考 [.env.example](../.env.example)。

### 3. 运行时状态

以下值由每次测试产生，不应写回 Provider 配置：

- Sandbox ID；
- envd/traffic access token；
- Channel bootstrap/session token；
- Channel connection ID；
- run ID、trace ID、步骤状态和临时文件 Hash。

它们保存在单次 Orchestrator run 内存和脱敏报告中；token 只保存在内存。

## 配置选择和优先级

```text
代码内固定安全默认值
  < Provider Profile
  < 受信任部署环境选择的 ONYXCLAW_PROVIDER
  < 单次 run 的非敏感 allowlist 参数
```

浏览器不能覆盖 `api.baseUrl`、`apiKeyEnv`、workspace 路径或 OpenClaw binary。

启动参数：

```text
ONYXCLAW_PROVIDER_CONFIG=config/providers.huaweicloud-agentsphere.example.json
ONYXCLAW_PROVIDER=huaweicloud-agentsphere
```

## 校验规则

`ProviderRegistry` 在调用云 API 前执行 fail-fast 校验：

- 外部 API 必须使用 HTTPS；
- 可选的 `api.sandboxUrl` 是 Sandbox envd 数据面地址，也必须使用 HTTPS；
- 外部 Channel 必须使用 WSS；
- HTTP/WS 只允许 loopback mock；
- workspace 和 HOME 必须是绝对路径；
- timeout、Gateway port 必须是正整数；
- `api.sdkPatch` 只能是标准协议的 `none`；
- provider ID 只能包含小写字母、数字和连字符；
- 所有被引用的 Secret 环境变量一次性检查并完整报告；
- 对浏览器只暴露 ID、展示名称、协议和 capability flags。

## 新增一个兼容 Provider

1. 从 Huawei AgentSphere 示例复制 Profile；
2. 使用当前发布账号的 Template、私网 endpoint 和独立的 Secret 环境变量名；
3. 保持 `api.sdkPatch: "none"`，填写 CCE 与 AgentSphere 的网络和能力声明；
4. 运行 Registry 单元测试和配置校验；
5. 在新 Sandbox 上运行 `create → command → file → bootstrap → chat → kill`；
6. 发布负责人明确授权后，按 `onyxclaw-one-click` 的部署流程验证 Channel、模型网络和可选 pause/resume。
