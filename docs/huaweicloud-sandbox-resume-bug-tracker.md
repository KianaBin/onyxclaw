# Huawei Cloud AgentSphere Sandbox 历史故障追踪器

> 状态：**历史证据**。本文保留已经完成的诊断结论、未决风险和镜像可追溯信息；它不是当前架构、构建或部署指南。当前操作请从 [README](../README.md) 进入相应文档。

## 脱敏与记录规则

- 可保留与构建可追溯直接相关的镜像 `tag@digest`、源文件哈希、测试结果和日期。
- 不记录真实 endpoint、内部构建目录、集群/Namespace/Pod、Template 或 Sandbox 标识、网络拓扑、request ID、用户消息、聊天正文、token、密码或其他凭据。
- 结论必须区分“已验证”“服务端归属确认”“待查”；不得将假设写成根因。
- 当前行为以代码和回归测试为准。历史实现描述不得覆盖 [Cloud APP runtime](../packages/cloud-runtime/README.md) 的当前语义。

## 已验证结论

1. **恢复后的 re-bootstrap 需要重建非持久化运行配置。** 恢复后重新签发一次性 Channel token、写入运行时 `openclaw.json`、恢复持久化 SOUL 并等待 Gateway/Channel 就绪，已在真实环境完成多轮验证。
2. **恢复控制面与数据面是不同故障域。** `Sandbox.connect` 成功不代表 Files、Commands 或 Gateway 数据面已就绪；短暂的 session 未就绪需要有界等待，不能以固定极短等待替代真实数据面验证。
3. **APP 不能用重复 connect 修复服务端恢复故障。** 多轮恢复中出现的外层 500、且错误指向 Agent Gateway 的场景已被反馈为服务端范围；APP 保持单次显式恢复和可诊断的失败状态。
4. **暂停实例的清理仍是独立风险。** 当恢复失败后清理失败，APP 必须保留可追踪的残留资源状态，不能宣称已经清理成功。
5. **聊天交付必须按入站事件关联。** 全局“下一条出站事件”等待者会在并发请求下错配并产生 `timed out waiting for next outbound event`；回复必须通过 `payload.inReplyTo` 精确匹配入站事件。

## 镜像可追溯基线

以下项目只用于解释已完成验证或构建候选；它们不表示当前已经发布或应被部署。

| 日期 | 目的 | 镜像 `tag@digest` | 结论 |
| --- | --- | --- | --- |
| 2026-08-24 | 恢复 re-bootstrap 验证 | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f` | APP re-bootstrap 已验证；Agent Gateway 恢复失败另行归属。 |
| 2026-09-02 | 稳定 APP 基线核验 | `0.3.8-session-routing-debug-nodelay-wait5s-v19@sha256:fe0c5274fff79897fce53634756694edc9799f393e3e3dde416d604749788293` | 后续 APP 补丁以该不可变基线明确派生。 |
| 2026-09-02 | Channel 运行基线核验 | `0.3.8-channel-error-fix@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5` | 完整 Channel 构建以此已核验基线明确派生。 |

## 关键时间线

| 日期 | 类别 | 脱敏证据 | 结论 |
| --- | --- | --- | --- |
| 2026-08-24 | 数据面恢复 | 恢复后文件读取在等待窗口内仍报告 session 未就绪。 | 控制面恢复不等于数据面可用；数据面等待需独立建模。 |
| 2026-08-24 | APP 修复 | 保留 session、单次显式 connect、恢复 re-bootstrap 的定向与完整回归通过；真实验证出现两轮成功恢复。 | APP 生命周期与 re-bootstrap 修复有效。 |
| 2026-08-24 至 2026-08-25 | 服务端边界 | 真实恢复在 APP bootstrap 前返回 Agent Gateway 相关失败，且相关负责人确认其服务端归属。 | 不再把该类 500 作为 APP bootstrap 缺陷继续修改。 |
| 2026-08-25 | 清理风险 | 恢复失败后的暂停实例清理未完成。 | 保留残留资源状态并由服务端/运维流程继续处理。 |
| 2026-09-02 | 聊天并发回归 | 修复前真实 WebSocket 场景稳定复现 outbound 等待超时；按 `inReplyTo` 关联后，定向与全量回归通过。 | 以回复关联键隔离并发等待，缺失回复只让自身超时。 |
| 2026-09-02 | 双镜像候选 | APP 与 Channel 候选均完成容器内语法、目标文件哈希和构建契约校验。 | 候选未推送、未 rollout、未替换 Template；发布须另获明确授权。 |

## 后续验收边界

若继续处理恢复或聊天问题，至少验证：

1. 对实际数据面执行一次 Files、Commands 或 Gateway 就绪检查，而不是只验证 `Sandbox.connect()`。
2. 聊天并发下每个回复的 `inReplyTo` 与入站事件一致；缺失回复不得被其他请求消费。
3. 恢复失败和清理失败都保留可诊断状态，不暴露用户内容或任何凭据。
4. 构建候选先完成测试、镜像内语法和哈希核验；未获发布负责人明确授权不得 push、rollout 或替换 Template。

## 文档治理变更

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-09-02 | 以 [ADR 0003](./adr/0003-current-document-boundaries.md) 确立当前文档/历史证据边界；将本地开发、架构、镜像构建和 Huawei 配置收敛为单一当前来源，并删除已提取的旧方案与静态报告。 | README 导航、13 份 Markdown 的相对链接、旧文档/旧云厂商引用扫描、`git diff --check`、`npm test` 110/110 通过；交互式架构图完成结构和桌面视觉检查。 |
