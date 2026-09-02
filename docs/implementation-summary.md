# OnyxClaw 当前实现工作总结

本文记录当前项目实现范围、交付物、验证状态和后续边界，作为 Huawei CCE + AgentSphere
维护的入口。

## 1. 当前结论

项目提供文本对话场景的本地验证与 Huawei CCE + AgentSphere 云端闭环：

```text
进入龙虾模式
  → 创建/连接 Sandbox
  → 编辑并确认 SOUL.md
  → 启动 OpenClaw Gateway
  → Channel 注册并建立连接
  → 首次 hello
  → 连续对话
  → kill/reset 清理单个 Sandbox
```

本地模式、Huawei Provider 配置、OpenClaw 镜像、云端 APP、Channel、
Bootstrap Saga、E2B SDK 操作和 UI 可观测面板均已有代码与自动化测试。

## 2. 已实现能力

### 2.1 本地 OpenClaw 验证

- OnyxClaw Channel Plugin 和 WebSocket Platform Simulator；
- bootstrap 注册、session 重连、heartbeat、delivery receipt 和事件去重；
- 两轮消息、Gateway 重启、token 轮换和 `SOUL.md` 恢复；
- 本地 Phase 1 Web UI：龙虾模式、性格设定和对话龙虾；
- 新用户串行引导和基于性格的首次问候；
- 本地 smoke 与 JSON 验证报告。

### 2.2 云 Provider 抽象

- Provider Profile 和 `ProviderRegistry`；
- HTTPS/WSS、VPC 私网例外、绝对路径和 timeout 校验；
- Sandbox、模型和 Channel Secret 的独立环境变量映射；
- 浏览器只获得 Provider ID、展示名称、协议和 capability；
- 统一 Adapter 契约：create、connect、command、file read/write 和 kill；
- 分阶段错误、Secret 脱敏和失败补偿。

### 2.3 云端 APP/BFF

- 新用户先领取 Sandbox，再确认 SOUL 并完成 bootstrap；
- 已有用户按 Sandbox ID connect；
- 一次性 Channel bootstrap token；
- `ALLOCATING → BOOTSTRAPPING → GATEWAY_READY → CHANNEL_READY → READY`；
- Gateway 和 Channel 双就绪闸门；
- 任一步失败时撤销 token 并 kill 半初始化 Sandbox；
- 首次 hello、文本对话、重置新用户和资源回收。

### 2.4 UI 和可观测

- 刷新后可在龙虾模式和对话龙虾之间切换；
- 页签移除数字编号；
- 首次回复后输入框固定可见；
- 不同页签切换时手机比例保持稳定；
- Sandbox Service 调用总数、成功、执行中和失败概要；
- 失败 API 聚合和失败行高亮；
- running/succeeded/failed 均展示操作详情：命令、路径、模板或 Sandbox ID；
- 命令中的 key、token、password 和 secret 自动脱敏。

## 3. 构建与发布

### APP 与 Channel 镜像

- 在 `demo-cn-south1` 基于已核验的不可变 digest 构建最小增量层；
- 构建后在容器内核验 JavaScript 语法和覆盖文件 SHA-256；
- push、CCE rollout 与 AgentSphere Template 创建/替换均为独立的人工步骤；
- 当前聊天修复候选的证据见 `huaweicloud-sandbox-resume-bug-tracker.md`。

## 4. 验证状态

- `npm test`：96 项测试通过；
- 本地 Phase 0/Phase 1 OpenClaw 验证通过；
- Huawei CCE APP 与 AgentSphere Sandbox 的 create、command、file、bootstrap、Channel 和
  对话闭环按 tracker 中的受控验证记录执行；
- CCE rollout 仅在明确授权后执行；
- UI 在 1440×800 验证页签切换尺寸变化为 0，聊天输入框可见。

## 5. 当前边界

以下内容不属于当前已经闭环的基础功能，后续生产化时应单独规划：

- pause/resume 后的内存、进程和 Channel 跨重启恢复验证；
- BFF 业务状态持久化和多副本一致性；
- 公网生产入口、正式 DNS、TLS、WAF 和访问控制；
- 模型与 Channel 的企业级私网出口策略；
- 大文件预签名传输、logs、metrics、events 和 volumes；
- 用户、租户、计费、配额和成本治理；
- 语音输入输出；
- 长期运行、故障注入、容量和灾难恢复测试。

## 6. 文档导航

- [本地 Phase 0](./phase0-local.md)
- [本地 Phase 1](./phase1-local.md)
- [云 Provider 配置](./provider-config.md)
- [Huawei CCE + AgentSphere 对接指南](./cloud-sandbox-provider-onboarding.md)
- [Huawei APP 与 Channel 镜像构建](./huaweicloud-image-build-and-update.md)
- [实际部署自动化：onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click)

## 7. 阶段交接建议

1. 以 CCE Deployment 与已核验的不可变 image digest 作为当前阶段基线；
2. 维护 Huawei AgentSphere Profile 与统一 Adapter，不在 APP 内增加未经验证的厂商分支；
3. 生产化前优先补状态持久化、pause/resume、正式入口和安全审计；
4. 清理后保存脱敏验收报告和 image digest，不保留运行时凭据。
