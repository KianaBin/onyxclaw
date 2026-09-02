# OnyxClaw 聊天交付

本文界定从 APP 聊天请求，到 OnyxClaw Channel 投递 OpenClaw 回复之间的链路。它定义了保证“请求与回复正确对应”所需的发布单元和身份标识。

## 术语

**聊天交付（Chat Delivery）**：
将一个 APP 入站事件与其对应的 Channel 出站回复关联起来的端到端交换。
_避免使用_：聊天超时、模型回复

**APP 发布镜像（APP Release Image）**：
包含 HTTP Controller、WebSocket Simulator 和浏览器 UI 的 OnyxClaw APP 镜像。
_避免使用_：Channel 镜像、Sandbox 镜像

**Channel 模板镜像（Channel Template Image）**：
由 AgentSphere Template 选用、运行 OnyxClaw Channel 和 OpenClaw Runtime 的 Sandbox 镜像。
_避免使用_：APP 镜像、在线热修复

**发布账号（Release Account）**：
拥有 Template、镜像仓库权限，以及用于发布验证的 Sandbox 资源的云账号。
_避免使用_：共享环境、生产账号

**回复关联键（Reply Correlation Key）**：
由实例 ID 与入站事件 ID 组成的复合标识；出站回复通过 `inReplyTo` 引用该入站事件 ID。
_避免使用_：下一条出站消息、FIFO 回复
