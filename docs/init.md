# OnyxClaw 初始需求

## 项目目标

开发一个用于连接和操作不同环境中 OpenClaw 实例的前端 APP。该 APP 是用户与 OpenClaw 交互的统一入口。

项目团队本身负责开发 E2B API 兼容的 Sandbox 服务。本项目不只是最终用户产品，也是用于模拟客户真实使用方式的端到端参考应用和测试夹具。客户会在 Sandbox 内的 OpenClaw 中安装自定义 Channel Plugin，因此本项目也需要构建一个对应的测试 Channel，用于验证 Plugin 安装、启动、收发消息、长连接、暂停恢复和版本兼容等行为。

## APP 核心页签

APP 包含三个页签：

1. **龙虾模式**
   - 页面主要提供一个按钮。
   - 用户点击按钮后进入“龙虾模式”。

2. **龙虾性格**
   - 用户选择对应龙虾的性格。
   - 选择结果最终记录到 OpenClaw workspace 下的 `SOUL.md` 文件中。

3. **与龙虾对话**
   - 用户可以与龙虾进行文字交互。
   - 用户也可以与龙虾进行语音交互。

## 客户端形态待决策

当前尚未决定将 APP 做成：

- 手机原生 APP；或
- Web 界面。

需要结合部署、网络接入、语音能力、开发和维护成本进行评估。

## OpenClaw 部署形态

OpenClaw 可能存在以下两种部署形态：

### 1. macOS 本地实例

- OpenClaw 部署在 macOS 上。
- 主要用于开发环境的端到端测试。

### 2. 云厂商 Sandbox 实例

- OpenClaw 部署在云计算厂商提供的 Sandbox 服务中。
- 云厂商提供 E2B 兼容 API，可通过该 API 快速部署 OpenClaw 实例。
- 交互 APP 的服务端可以考虑以容器方式部署到该云厂商的容器服务中。
- APP 服务端通过 VPC 网络连接 Sandbox 内的 OpenClaw，以减少公网暴露。
- 如果 Sandbox 中的 OpenClaw 暴露了公网地址，也应支持通过公网连接。

## 用户场景

三个页签的业务流程需要区分全新用户和已有用户。

### 全新用户

1. 用户第一次进入龙虾模式时，调用云厂商 Sandbox 服务的 E2B 兼容 API，创建并部署一个 OpenClaw Sandbox 实例，获得 `Sandbox ID`。
2. 通过 E2B 文件 API，或通过 OpenClaw Channel 的代码能力，操作 OpenClaw workspace 下的 `SOUL.md` 文件。
3. 通过 OpenClaw Channel 连接新创建的 OpenClaw 实例并开始会话。

### 已有用户

1. 通过用户已有的 `Sandbox ID` 关联对应 Sandbox 实例。
2. 调用 Connect to Sandbox API 激活或重新连接部署了 OpenClaw 的 Sandbox。
3. 跳过首次性格配置步骤。
4. 通过 OpenClaw Channel 连接 OpenClaw 实例并开始会话。

## 当前阶段

当前阶段只进行完整方案设计，包括：

- 前端 APP 的全部能力；
- APP 与后端 OpenClaw 实例之间的交互逻辑；
- 新用户与已有用户的完整流程；
- 客户端形态和系统架构选型；
- 安全、网络、状态管理和异常恢复方案。

后续方案和验证结果持续记录在 `docs/huaweicloud-cce-learning-log.md`。
