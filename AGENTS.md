# Agent 工作入口

> 状态：**当前指南**。本文约定 agent 的阅读与验证流程；项目文档导航见 [README.md](./README.md)。

## 开始变更

1. 查看工作区状态，区分已有改动与本次任务；保留已有改动。
2. 阅读 README，并按下表加载与任务相关的文档。实现行为以代码与回归测试为准；发现文档冲突时明确指出差异。
3. 沿目标行为找到实现与测试，再确定修改范围；脚本名称和执行入口直接查阅 `package.json`。

## 按任务读取

| 任务触发条件 | 必读材料 |
| --- | --- |
| 修改组件责任、跨模块调用或聊天交付 | [架构](./docs/architecture.md)；需要时序或生命周期视图时读[研发架构](./docs/development-architecture.md) |
| 修改云端编排、Sandbox 恢复或数据面行为 | [Cloud APP runtime](./packages/cloud-runtime/README.md) |
| 修改 Provider 配置或环境变量 | [Provider 配置](./docs/provider-config.md) |
| 运行本机 OpenClaw、控制台或端到端验收 | [本地开发与验收](./docs/local-development.md)，先确认副作用及清理步骤 |
| 修改镜像输入、选择构建基线或执行远端构建 | [镜像构建与更新](./docs/huaweicloud-image-build-and-update.md)及[远端构建边界](./docs/local-development.md#远端-docker-构建器与调试边界) |
| 新增或修改文档 | [文档治理 ADR](./docs/adr/0003-current-document-boundaries.md)；更新 README 导航并声明文档状态 |
| 修改领域术语或长期架构约束 | [术语表](./CONTEXT.md)与相关 [ADR](./docs/adr/)；术语留在 CONTEXT，决定留在 ADR |

## 操作边界

- 默认在本机进行源码修改与自动回归。调用本机 Gateway、云资源或远端构建器前，先按对应指南确认影响范围与任务授权；需要额外权限时向用户确认。
- 镜像构建与发布是不同操作。push、CCE rollout、Template 创建或替换须有显式授权；实际部署流程由 README 指向的 `onyxclaw-one-click` 仓库维护。
- 配置只使用非敏感样例。真实 endpoint、Template/SFS 标识和凭据不进入源码、文档或报告。
- 历史证据用于追溯，不作为当前操作指令；当前流程从 README 的指南入口读取。

## 完成条件

- 行为变更有对应回归测试；先运行受影响测试，再按变更范围执行完整自动回归。执行前核对脚本及测试路径，命令失效时报告，不将其当作验证通过。
- 本机 OpenClaw 或云端验收与自动回归分别报告；未执行的验收明确列出原因。涉及本机状态修改时，按指南核验清理结果。
- 检查最终 diff，仅包含任务所需变更；影响当前文档契约的变更同步更新其权威来源。
- 交付说明列出修改文件、实际执行的验证及结果、未验证项；构建成功不报告为发布成功。
