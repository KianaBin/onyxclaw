# OnyxClaw 研发架构参考图

> 状态：**当前参考**。本页用于研发定位代码、运行边界和关键不变量；实际行为仍以代码与回归测试为准。它不替代[当前架构规范](./architecture.md)，也不描述镜像构建、CCE rollout 或 Template 发布。

## 阅读顺序

1. [研发架构图](./assets/onyxclaw-development-architecture.html)：定位代码模块在哪个运行边界执行，以及控制面、数据面、持久化和消息交付如何分工。
2. [聊天交付时序图](./assets/onyxclaw-chat-delivery.html)：理解从浏览器消息到带 `inReplyTo` 回复的关联不变量。
3. [Sandbox 生命周期图](./assets/onyxclaw-sandbox-lifecycle.html)：理解 create、确认、配置、连接、暂停，以及恢复后的 `resume-data-pending` 数据面分支。

三张图的可维护 Archify 源文件与 HTML 位于 `docs/assets/`，修改时应更新 JSON 源并重新执行 Archify 的 `validate` 和 `deliver`。

## 图到代码

| 图中责任 | 首先查看 | 说明 |
| --- | --- | --- |
| APP/BFF 生命周期与聊天关联 | `packages/cloud-runtime/src/cloud-controller.js` | 创建、确认、暂停、恢复及状态转换。 |
| Sandbox 控制面/数据面适配 | `packages/cloud-runtime/src/e2b-compatible-adapter.js` | `create/connect/pause/kill` 与 Files/Commands/health 的边界。 |
| 启动、配置与持久化工作区 | `packages/cloud-runtime/src/openclaw-bootstrap.js` | 每 Sandbox 运行时配置、SOUL 和恢复时的准备流程。 |
| APP 入口及 Provider 注入 | `packages/cloud-runtime/src/cloud-app.js` | 云端 APP 组合与运行时依赖。 |
| Channel WebSocket 与回复关联 | `packages/onyxclaw-channel/src/channel.js`、`packages/onyxclaw-channel/src/inbound.js` | 入站派发以及以 `inReplyTo` 投递出站回复。 |

## 使用边界

- 控制面与数据面使用不同凭据和路由语义；控制面恢复成功不代表数据面已就绪。
- `resume-data-pending` 时再次操作只重试数据面配置，不能重复恢复或暂停已恢复的 Sandbox。
- `instanceId + inboundEventId` 是回复关联键；所有回复（包括可操作的失败回复）必须以 `inReplyTo` 指向原入站事件。
- `kill` 是终止操作：成功后才清理本地会话缓存。它没有被画成常规恢复路径，避免将不可逆终止误解为可回退状态。
- 交付与发布内容属于 [onyxclaw-one-click](https://github.com/KianaBin/onyxclaw-one-click)；本仓图不描述该仓库的职责。
