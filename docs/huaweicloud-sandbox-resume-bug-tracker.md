# Huawei Cloud AgentSphere Sandbox 暂停恢复 Bug 排查记录

> Bug ID：`HWC-AS-RESUME-001`
>
> 状态：`Re-bootstrap verified / Agent Gateway issue confirmed / paused kill under investigation`
>
> 严重级别：`P1`
>
> 首次建档：`2026-08-24`
>
> 关联交接：[`huaweicloud-sandbox-lifecycle-handoff.md`](./huaweicloud-sandbox-lifecycle-handoff.md)

## 结论与修复验证

1. **APP session 生命周期问题已修复。** pause 后保留 Node/Python 两层 session；resume 只显式
   调用一次 `Sandbox.connect(id)`，并复用 create 时保存的 Sandbox 对象和 traffic/envd token；
   Files、Commands 和 kill 不再隐式 connect。
2. **恢复 bootstrap 已修复并通过 CCE 验证。** v6 会在 connect 成功后重新签发 Channel token、
   重建并写入非持久化 `openclaw.json`，随后恢复 SOUL、Gateway 和 Channel。同一 Sandbox 的
   前两轮 pause/resume 均完成完整恢复，证明该流程有效且可重复执行。
3. **当前概率性恢复失败不属于 bootstrap。** v6 第三轮失败发生在 bootstrap 执行之前的
   `Sandbox.connect`；相关负责人已确认外层 500、`agent gateway ... failed` 属于 Agent
   Gateway 问题。该问题应由 Agent Gateway 服务侧继续定位，APP 不再针对该 500 修改 bootstrap。
4. **paused Sandbox kill/重置问题尚未解决。** 恢复失败后，paused Sandbox 可能无法 kill，
   从而阻断“重置新用户”。APP 会保留 Sandbox ID，避免资源静默丢失；“跳过 Sandbox 清理”
   只能恢复本地新用户流程，遗留 Sandbox 必须作为 orphaned resource 跟踪并人工清理。
5. **验证基线已完成。** 最终 APP 镜像为
   `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f`；
   定向测试 `17/17`、cloud 测试 `48/48`、完整测试 `114/114`，CCE generation 37 已完成真实
   pause/resume 验证。

## 文档用途与维护规则

本文是 Huawei Cloud AgentSphere Sandbox 暂停恢复问题的持续排查记录。后续与该问题有关的
代码、配置、镜像、部署、实验和服务端反馈，都追加到本文的“变更记录”和“实验记录”，不要
只写在聊天、终端历史或临时笔记中。

记录时遵循以下约束：

- 不写入 API Key、AK/SK、密码、traffic access token、完整 Authorization header；
- 不写入完整 Sandbox ID，使用末 8 位或单次实验别名；
- 保留 UTC 时间、北京时间、操作阶段、HTTP 状态、错误码和 request ID；
- 每次代码或配置改动记录对应 commit、镜像 `tag@digest`、部署时间和验证结果；
- 未经实测的判断标记为“假设”，不能写成已确认根因。

## 问题摘要

1. Sandbox 暂停后恢复存在概率性失败，表现为 `Sandbox.connect` 返回外层 500、Agent
   Gateway 内层失败。
2. Sandbox 恢复运行环境后，非持久化 Gateway 配置和 Channel token 可能丢失，导致 OpenClaw
   Gateway 无法启动或无法重新注册。
3. 恢复失败后 Sandbox 保持 paused，随后可能无法 kill，导致“重置新用户”失败并遗留无法由
   APP 正常清理的 Sandbox。
4. Sandbox 创建阶段曾出现 FunctionGraph 暂时不可用的 502，属于独立的服务可用性问题。

## 环境快照

| 项目 | 当前值 |
| --- | --- |
| 日期 | `2026-08-24` |
| Git 分支 | `hzp-dev`，当前与 `hzp/hzp-dev` 对齐 |
| 基线 commit | `54addc2` |
| CCE 集群 | `testdemo` / `cn-south-1` |
| Namespace | `onyxclaw-demo` |
| Deployment | `onyxclaw-app` |
| CCE 实测 APP 镜像 | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f`（Generation 37） |
| 恢复 re-bootstrap 镜像 | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f`（已 rollout） |
| 单次 connect 修复镜像 | `0.3.8-e2b-single-connect-v5@sha256:3dfd13e939c37f8802550515bcabb1ef4ef75f7f321ae9153b122a3b1404efd2`（已 rollout） |
| 待 rollout 直接调用镜像 | `0.3.8-pause-session-direct-v3@sha256:afbb02382e73a5aba644e4d8654d494a9eadcf958bf267cab37d80de857ac2af` |
| 原始基线镜像 | `0.3.8-white-ui-v2@sha256:138a6f5394e98fcdb0acbaabd49d2e91b7256180c7535b318799982bc39d831c` |
| 第一版修复镜像 | `0.3.8-pause-session-retain@sha256:80faf213c8c60f8ce520b32ad6c120a87c5cd374c8334507a74a7848967f1bc7`（Revision 29，已确认不足） |
| Provider | `huaweicloud-agentsphere` / `e2b-compatible` |
| 控制面 | `https://agentsphere.cn-south-1.myhuaweicloud.com` |
| 数据面 | Agent Gateway Sandbox HTTPS endpoint |
| 数据 session 等待窗口 | `E2B_DATA_SESSION_WAIT_SECONDS=60` |
| bridge 请求超时 | Provider `requestTimeoutMs=60000` |
| 持久化文件 | `/home/node/.openclaw/workspace/SOUL.md` |
| 部署运行态依据 | CCE 集群中实际 Deployment、ReplicaSet、Pod 和镜像 digest |

仓库中的 `deploy/huaweicloud-cce/onyxclaw-app-demo.yaml` 是部署参考和历史快照，不作为当前
运行态的 source of truth。目前遗留问题排查、镜像版本判断和验收均以 CCE 中实际对象为准。
仓库清单与 CCE 不一致时，在本文记录差异，但不能据此覆盖或反推线上状态。

## 已知错误时间线

### 事件 A：创建阶段 FunctionGraph 不可用

- UTC：`2026-08-24T08:38:13.616Z`
- 北京时间：`2026-08-24 16:38:13`
- 阶段：`create`
- API：`Sandbox.create`
- 外层异常：`SandboxException / E2B_BRIDGE_OPERATION_FAILED`
- HTTP：`502`
- 云侧错误码：`APIGW.0201`
- request ID：`d71c8b4c26391250c583ec77add4e235`
- 云侧消息：`Service FUNCTIONGRAPH is currently unavailable`

初步分类：华为云 API Gateway 已收到请求，但 FunctionGraph 后端不可用。这是上游服务可用性
故障，不是暂停恢复的数据面错误。保留它是因为它说明当前 AgentSphere 链路同时存在控制面
稳定性风险。

### 事件 B：恢复后 Files.read 找不到 session

- UTC：`2026-08-24T09:39:55.630Z`
- 北京时间：`2026-08-24 17:39:55`
- 阶段：`file-read`
- API：`Files.read`
- 外层异常：`InvalidArgumentException / E2B_BRIDGE_OPERATION_FAILED`
- 消息：`Session ID not found`
- request ID：当前日志未提供

初步分类：恢复控制面与 Agent Gateway 数据面之间的 session 创建或传播失败。由于 bridge
已经针对该消息重试 45 秒，本次不是普通的亚秒级传播延迟。

### 事件 C：第一版修复未真正 resume，并触发重复 pause 409

- UTC：`2026-08-24T11:18:36.280Z`、`11:18:46.094Z`、`11:19:01.463Z`
- 北京时间：`2026-08-24 19:18:36`、`19:18:46`、`19:19:01`
- 镜像：`0.3.8-pause-session-retain`，CCE Revision 29
- 阶段：`file-read`
- API：`Files.read`
- 外层异常：`InvalidArgumentException / E2B_BRIDGE_OPERATION_FAILED`
- 消息：`Session not found`
- 紧随 stderr：`Response 409`

代码与 SDK 源码联合确认：第一版修复虽然保留了 create 时对象，却把缓存命中的 resume 实现
成直接返回，没有调用该对象的实例 `connect()`。因此远端 Sandbox 未从 paused 切回 running。
与此同时，暂态错误识别只接受精确语义 `Session ID not found`，漏掉了 `Session not found`，
控制器进入失败补偿并再次 pause 已暂停实例，产生 `409`。

### 事件 D：第二版已正确调用 resume，Agent Gateway 创建 session 返回 400

- UTC：`2026-08-24T11:36:23.198Z`
- 北京时间：`2026-08-24 19:36:23`
- 镜像：`0.3.8-pause-session-resume-v2`，CCE Deployment generation 33
- Sandbox：末 8 位 `60036878`
- 阶段：`connect`
- API：实例 `Sandbox.connect()`
- 外层异常：`SandboxException / E2B_BRIDGE_OPERATION_FAILED`
- 外层 HTTP：`500`
- 内层阶段：Agent Gateway create sandbox/session
- 内层状态：`400`
- request ID：当前响应未提供

运行镜像中的 SDK 源码确认，实例 `connect()` 会向标准
`POST /sandboxes/{sandbox_id}/connect` 发送只包含 timeout 的 `ConnectSandbox` 请求，并明确
负责自动恢复 paused Sandbox。`ConnectionConfig.get_api_params()` 只复制控制面 `headers`；
数据面 `sandbox_headers` 返回新字典，因此 bridge 注入的 traffic token 没有污染 claimed
对象的控制面 connect 请求。

本次错误证明第二版已经从“本地漏调 resume”推进到真实 AgentSphere 恢复链路。失败发生在
AgentSphere 调用 Agent Gateway 创建恢复 session 时，APP 未进入 Files.read。该错误与历史
记录的 `500 agent gateway create sandbox failed ... status=400` 一致，当前没有证据支持继续
修改 APP 的 connect 参数。不能对该 500 盲目自动重试，因为服务端操作是否幂等尚未确认，
重复调用可能制造重复或半创建的 Gateway session。

历史中间验证事件已由 v5/v6 的直接证据覆盖，事件编号继续沿用，避免已有排查引用失效。

### 事件 H：点击重置后的次生 bootstrap/reset 竞态

- UTC：`2026-08-24T13:03:54.094Z` 起
- 镜像：`0.3.8-e2b-single-connect-v5`，CCE Deployment generation 36
- Sandbox：末 8 位 `9886e023`
- CCE：单副本、Pod `RESTARTS=0`，排除跨 Pod 内存和容器重启
- 前置条件：本次流程曾进入持久化 SOUL 确认，但用户随后主动点击了重置
- 失败阶段：确认 SOUL 后的 Gateway readiness probe
- 表层错误：`Commands.run` 包装 `CLOUD_RUNTIME_CONNECT_FAILED`
- 内层错误：`Sandbox.connect` 返回 404，`Paused sandbox ... not found`

脱敏 `/api/observability` 显示 readiness probe 每约 1 秒执行一次；每次 `Commands.run` 都先
触发一次 `Sandbox.connect`，说明当时 Node adapter 的 `#sessions` 已无该 Sandbox。当前
`/api/status` 同时出现 `mode=paused` 与 `sandboxId=null`。正常串行状态机不存在这个组合：
`#clearLocalState()` 会同时设置 `mode=idle` 和 `sandboxId=null`；只有清理/重置请求在
`confirmSoul()` 的 bootstrap 仍运行时清空状态，随后旧 bootstrap 失败并把当前状态覆盖成
`paused`，才会形成该组合。

用户已确认当时点击了重置。因此本事件的直接原因是：SOUL bootstrap/readiness probe 运行
期间并发执行了“重置新用户”清理，
该清理 kill Sandbox 并删除 Node session；尚未取消的 probe 随后发现 session 缺失，走
`#getSession() -> connectSandbox()` 兜底。由于云端 Sandbox 已经不是 paused 资源，connect
返回 404，probe 又吞掉错误并持续到 120 秒超时。该 404 是重置后的次生问题，不是本轮恢复
最初的阻塞点；代码侧后续仍应串行化互斥操作，并让 probe 支持取消或对 connect 404 立即失败。

### 事件 I：v5 首次显式 connect 仍返回 Gateway 500/400

- UTC：`2026-08-24T13:14:22.579Z`、`13:14:33.361Z`
- 镜像：`0.3.8-e2b-single-connect-v5`，CCE Deployment generation 36
- Sandbox：末 8 位 `3545976a`
- 阶段：`connect` / `Sandbox.connect`
- 外层状态：HTTP 500
- 内层状态：`agent gateway create sandbox failed ... status=400`
- request ID：响应未提供

这组日志发生在用户点击重置之前，证明事件 H 的 reset 竞态不能解释原始恢复失败。v5 已保证
单次恢复请求只执行一次显式 `Sandbox.connect(id)`，Files、Commands 和 kill 不再隐式
connect；但第一次标准 connect 本身仍可在 AgentSphere/Agent Gateway 返回 500/400。两条
失败相隔约 10.782 秒，当前代码没有控制面自动重试，更符合两次独立的页面恢复尝试。结合
v6 前两次恢复完整成功，说明服务端表现具有间歇性；APP 去重修复有效，但不能修复
Agent Gateway 创建恢复 session 时的内层 400。

### 事件 J：v6 前两次恢复完整成功，第三次起 connect 稳定失败

- UTC：`2026-08-24T13:37:52Z` 至 `13:41:33Z`
- 镜像：`0.3.8-resume-rebootstrap-v6`，CCE Deployment generation 37
- Sandbox：尾部标识 `5311db6`
- APP：单副本、Pod restart `0`

同一个 Sandbox 的三轮时序如下：

| 轮次 | pause 完成 | connect | 恢复配置写入 | Gateway ready | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 约 `13:38:17.321` | `13:38:37.309` 成功，335 ms | `13:38:46.182` | `13:38:52.804` | re-bootstrap 完整成功；写配置到 ready 约 6.622 秒 |
| 2 | 约 `13:39:16.741` | `13:39:26.361` 成功，913 ms | `13:39:31.513` | `13:39:38.450` | re-bootstrap 完整成功；写配置到 ready 约 6.937 秒 |
| 3 | 约 `13:40:32.725` | 从 `13:40:41.212` 起失败 | 未执行 | 未执行 | 五次 connect 均为外层 500/内层 Gateway 400 |

第三轮五次失败发生在 `13:40:41.212`、`13:40:48.162`、`13:40:57.463`、
`13:41:28.295`、`13:41:32.998`。第一次请求距 pause 返回约 `8.487` 秒，最后一次距 pause
返回约 `60.273` 秒，错误始终是 `agent gateway create sandbox failed ... status=400`。

前两轮都成功读取 SOUL、签发新 Channel token、写入新 `openclaw.json`，并在相近时间内通过
readyz，证明 v6 恢复 re-bootstrap 已在 CCE 生效且行为稳定。第三轮在执行上述逻辑之前就被
`Sandbox.connect` 阻断，因此不能归因于 bootstrap 文件不足。当前最强假设是 AgentSphere
在同一 Sandbox 多轮 pause/resume 后残留、泄漏或错误关联了 Gateway session；客户端增加
固定等待无法恢复这种状态。

### 事件 K：恢复失败后 paused Sandbox 无法 kill，阻断“重置新用户”

- 记录日期：`2026-08-25`
- 前置状态：Sandbox 已 pause，随后 resume/connect 失败，APP 保持 `paused`
- 用户操作：点击“重置新用户”
- 调用链：`resetNewUser()` -> `stopLobsterMode()` -> `adapter.killSandbox()` ->
  Python `claimed.kill()`
- 现象：paused Sandbox kill 失败，普通重置请求失败
- 待补证据：kill 的 HTTP 状态、服务端错误正文、request ID、Sandbox 尾部标识与 UTC 时间

当前 Controller 只有在 `killSandbox()` 成功返回后才执行 `#clearLocalState()`；Node/Python 两层
session 也只在 kill 成功后删除。因此 kill 失败时保留 Sandbox ID 和缓存是符合资源安全原则的，
但直接后果是“重置新用户”无法完成。前端在普通重置失败后会显示“跳过 Sandbox 清理”入口；
用户选择后可以继续新用户流程，但返回的 `orphanedSandboxId` 代表旧 Sandbox 仍然存在，必须
进入残留资源清单并另行清理。

本事件与事件 H 需要区分：事件 H 是 bootstrap/readiness probe 与 reset 并发造成的状态覆盖；
事件 K 是已经处于稳定 paused/恢复失败状态时，服务端或 SDK 的 kill 本身失败。两者都影响
“重置新用户”，但触发阶段和修复方向不同。事件 K 当前不能仅凭现象断定是 SDK 限制还是
AgentSphere paused 状态机缺陷，需要取得原始 kill 响应后确认。

### 事件 L：负责人确认恢复 500 属于 Agent Gateway 问题

- 确认日期：`2026-08-25`
- 反馈来源：相关负责人，经用户转述记录
- 确认范围：出现外层 500 且错误指向 `agent gateway ... failed` 的恢复失败，归属于
  Agent Gateway
- 尚未确认：Agent Gateway 内部具体失败机制，以及 paused Sandbox kill 失败是否属于同一问题

该反馈确认了组件归属：事件 I/J 的恢复 500 不再作为 APP re-bootstrap 缺陷继续修改。H8 中
“多轮 pause/resume 后 Gateway session/resource 残留或状态异常”仍只是内部机制假设，需要
Agent Gateway 团队结合服务端日志给出最终根因。事件 K 的 kill 问题继续独立采集原始响应，
不能在没有服务端反馈时直接合并到同一根因。

## 当前代码实现

### 原始基线镜像的暂停流程

```text
UI POST /api/sandbox/pause
  -> CloudConsoleController.pauseLobsterMode()
  -> E2BCompatibleAdapter.pauseSandbox()
  -> Python bridge op=pause
  -> claimed.pause()
  -> 删除 Node adapter 和 Python bridge 中的旧 session 缓存
  -> Controller mode=paused
```

### 原始基线镜像的恢复流程

```text
UI POST /api/sandbox/resume
  -> CloudConsoleController.resumeLobsterMode()
  -> adapter.connectSandbox(sandboxId)
  -> Python bridge op=connect
  -> Sandbox.connect(...control_api_options)
  -> 用 connect 返回的新 traffic_access_token 构建 routed 数据面 session
  -> saga.readPersistentSoul(sandboxId)
  -> adapter.readFile(.../workspace/SOUL.md)
  -> Python bridge op=readFile
  -> session.files.read(...)
  -> 若为 Session ID not found，在 45 秒窗口内退避重试
```

## 已确认的正确 session 生命周期

`2026-08-24` 经研发环境实现约束确认，pause/resume 必须复用 create 时生成的同一套 session
对象和 token，不能把 pause 当成销毁本地 SDK session。

### create

```text
Python Sandbox.create()
  -> 返回 claimed Sandbox 对象
  -> 使用 create 返回的 traffic token、envd token 构造 routed Sandbox 对象
  -> sessions[sandbox_id] = (claimed, routed)

Node sessionFor()
  -> 创建指向同一个 Python bridge 和 sandbox_id 的 wrapper
  -> #sessions.set(sandbox_id, wrapper)
```

create 获得的 claimed/routed 对象、traffic token、envd token 和 Node wrapper 都需要保持到
Sandbox 最终 kill 或 APP/bridge 进程终止。

### pause

```text
Node wrapper.pause()
  -> Python claimed.pause()
  -> 云端 Sandbox 进入 paused
  -> 保留 Python sessions[sandbox_id]
  -> 保留 Node #sessions[sandbox_id]
```

paused 状态下暂时不能执行 Files、Commands 等数据面操作，但 session 对象及其 token 仍然
有效，不能在 pause 成功后执行 `sessions.pop()` 或 `#sessions.delete()`。

### resume/connect

```text
Controller 请求 resume
  -> Node adapter 从 #sessions[sandbox_id] 取得原 wrapper
  -> Python connect_session(sandbox_id) 确认 sessions 中已有原 claimed/routed
  -> 只调用一次 Sandbox.connect(sandbox_id)
  -> 丢弃 connect 返回对象，返回 sessions[sandbox_id] 原 claimed/routed
  -> 不重建 ConnectionConfig
  -> 不替换 traffic token 或 envd token
  -> 复用原 routed 对象执行 Files.read
```

正常 pause/resume 的 `Sandbox.connect(sandbox_id)` 只负责恢复远端状态，其返回对象不替换
create 时保存的本地对象。APP/bridge 进程重启导致 `sessions` 丢失时，`session_for()` 才把
connect 返回对象保存为新的本地 claimed/routed。显式 resume 之外的 Files、Commands 和
kill 只调用 `session_for()`，缓存命中时不能再次隐式 connect。

### kill

Sandbox 最终 kill 成功后，才允许清理 Python `sessions[sandbox_id]` 和 Node
`#sessions[sandbox_id]`。若 kill 失败，必须保留或持久化 Sandbox ID，不能把资源当作已清理。

### 控制面调用顺序与重试边界

Python bridge 不再使用 `run_control_operation()` 包装控制面调用，也不对控制面错误自动重试。
生命周期分支按以下顺序明确排列，每个操作只调用一次对应 SDK 方法：

```text
create  -> Sandbox.create()       -> 保存 claimed/routed
pause   -> Sandbox.pause(id)      -> 保留 claimed/routed
connect -> Sandbox.connect(id)    -> 丢弃返回值，复用 claimed/routed
kill    -> claimed.kill()         -> 成功后删除 claimed/routed
```

`run_data_operation()` 仍只用于 Files/Commands 数据面短暂
`Session (ID) not found` 的等待，不属于控制面重试，本次不删除。

## 代码检查结论

### 修复后的保护

- 控制面使用 E2B API Key，数据面使用 create 返回的 `traffic_access_token`；
- 所有 E2B-compatible Provider 在 pause 后保留 Python/Node 两层 session，resume 只按 ID
  connect 一次并继续复用 create 时保存的原对象及 token；
- `create/pause/connect/kill` 直接调用一次 SDK 方法，不经过控制面重试包装；
- 对 `Session ID not found` 和 `Session not found` 执行同一数据面退避；
- 失败后保留 Sandbox 和 session，避免丢失后续恢复与清理能力；
- 页面允许只重试读取 SFS 中的 `SOUL.md`。

### 当前诊断缺口

1. create/pause/resume 日志没有记录安全的 session 摘要，无法直接证明对象和 token 在真实
   CCE 流程中保持一致；
2. `safe_error()` 只读取异常对象属性，不会从嵌套 JSON 文本中提取 request ID，因此事件 A
   的 request ID 只存在于 message 中；
3. `run_data_operation()` 不记录尝试次数、累计等待时间和最后一次异常的结构化字段；
4. APP 只能看到 Agent Gateway 的外层 `Session ID not found`，没有 FunctionGraph、
   AgentSphere 或 Gateway session 创建事件；
5. 目前没有证据区分“session 最终会在 45 秒后出现”和“session 永远没有成功创建”。

### 已确认并在本地修复的实现偏差

故障镜像中的代码与上述生命周期存在三处直接冲突：

1. Python bridge 的 `pause` 成功后执行 `sessions.pop(sandbox_id, None)`，丢失 create 时的
   claimed/routed 对象和 traffic/envd token；
2. Node adapter 的 `pauseSandbox()` 成功后执行 `this.#sessions.delete(id)`，丢失 create 时
   生成的 `sessionFor()` wrapper；
3. resume 的 bridge `op=connect` 使用 `connect_session(..., refresh=True)`，强制调用
   `Sandbox.connect()` 并重建对象和数据面配置，而不是复用 create 阶段的 session。

因此，事件 B 的首要代码级解释已经从“单纯等待时间不足”调整为：pause 主动清除了仍应
保留的两层 session，resume 又建立了与原 traffic/envd token 生命周期不一致的新对象，最终
导致 Agent Gateway 返回 `Session ID not found`。

第一版修复只完成了“保留并复用原对象”，遗漏“调用原对象实例 `connect()` 真正恢复远端
Sandbox”，现已在本地完成第二版修复。第二版还统一识别 `Session ID not found` 和
`Session not found`，避免错误补偿触发重复 pause 409。第二版镜像已在 CCE 发起真实 resume，
客户端调用符合 SDK 语义，但 AgentSphere 创建 Gateway session 时返回内层 400。

## 根因假设

按当前证据从高到低排序：

| 编号 | 假设 | 当前依据 | 如何证伪/确认 |
| --- | --- | --- | --- |
| H8 | AgentSphere 在同一 Sandbox 多轮 pause/resume 后残留、泄漏或错误关联 Gateway session | v6 同一 Sandbox 前两轮恢复完整成功，第三轮开始五次 connect 均 500/400；最后一次已距 pause 返回约 60.273 秒 | 当前首要根因；用新 Sandbox 固定执行至少 3～5 轮，并由服务端对比每轮 Gateway session/resource ID 与释放状态 |
| H9 | AgentSphere 不允许或无法 kill 已陷入异常恢复状态的 paused Sandbox | 用户实测恢复失败后点击“重置新用户”，paused Sandbox kill 失败；Controller 因此不会清空本地状态 | 采集 `Sandbox.kill` 原始 HTTP 状态、错误正文和 request ID；服务端核对 paused Sandbox 与 Gateway 资源的终止状态机 |
| H1 | AgentSphere 恢复 paused Sandbox 时由 Agent Gateway 返回失败 | v2/v5 和多个新 Sandbox 均返回外层 500/内层 400；v6 证明失败发生在 connect；相关负责人已确认是 Agent Gateway 问题 | 组件归属已确认；仍需按 UTC `13:40:41.212`～`13:41:32.998` 和 Sandbox 尾部标识 `5311db6` 查询内部根因 |
| H7 | SOUL bootstrap 期间并发 reset/kill，删除 session 后 readiness probe 继续运行 | 用户确认点击过重置；v5 单 Pod、无重启；观测到 `paused + sandboxId=null` | 已确认为事件 H 的次生竞态，但不能解释事件 I 的原始 connect 500 |
| H6 | pause 返回早于 Agent Gateway session 清理完成，短间隔 connect 与旧 session 发生竞态 | v6 第三轮最后一次失败已距 pause 返回约 60.273 秒 | 已排除“只需客户端固定等待”的简单竞态解释；服务端仍需检查异步资源是否永久卡住 |
| H5 | AgentSphere resume 恢复或重建了 envd/Files/Commands，但没有恢复 Gateway 进程及其临时配置 | 实际镜像入口等待非持久化 `openclaw.json`；v6 前两次恢复重新签发 token、写配置后分别约 6.6/6.9 秒 ready | 已确认并由 v6 re-bootstrap 修复；不能解释事件 J 第三轮 connect 之前的 500/400 |
| H0 | 原始版本 pause 删除 session；第一版修复保留 session 但没有调用实例 `connect()` | 两个实现偏差均已修复；第二版 CCE 日志证明实例 connect 已实际发出 | 已排除为事件 D 的直接根因 |
| H2 | create 返回的 traffic/envd token 在 pause 后被云端失效 | v6 前两轮 Files/Commands 与 Gateway 均成功，当前不支持该假设 | 已排除为当前直接根因 |
| H3 | 原 session 恢复可用存在传播延迟 | v6 前两轮已越过 session 数据面传播阶段 | 已排除为当前直接根因 |
| H4 | SFS 挂载或文件路径失败 | v6 前两轮均读取并确认 SOUL，证明读取成功 | 已排除为当前直接根因 |

SNAT、DNS 和 TLS 不是本次事件 B 的首要假设：数据面已经返回业务级
`Session ID not found`，说明请求至少到达了 Agent Gateway。

## 排查计划

### P0：服务端关联查询

1. 确认 AgentSphere/FunctionGraph/Agent Gateway 日志属于用户账号还是华为云服务账号；
2. 如果是用户账号，在 FunctionGraph/LTS 和 APIG access log 中按 UTC 时间与 request ID 查询；
3. 如果是服务账号，把事件 A request ID，以及事件 B/D 的时间、Sandbox 末 8 位提交给
   AgentSphere 团队；
4. 要求服务端明确回答 connect 对应的 Gateway session 是否创建成功、失败阶段和内部状态码；
5. 重点查询事件 J 三轮对应的 Gateway session/resource ID，确认前两轮恢复后的旧资源是否释放，
   以及第三轮内层 400 是否由重复资源、状态机或幂等校验触发；
6. 对事件 K 单独查询 `Sandbox.kill`：确认 paused 状态是否允许直接 kill、内部是否先依赖
   Gateway session、失败后资源是否仍计费，以及服务端支持的强制清理方式。

### P0：一次受控复现

只使用一个新 Sandbox，避免继续制造 paused 残留资源：

1. create 并记录 Sandbox 别名、创建时间和 request ID；
2. 验证 `Files.read`、Gateway 和 Channel 在首次创建状态正常；
3. 连续执行至少 3～5 轮 pause/connect，每轮只发一次 connect，并记录 pause 完成到 connect
   的间隔；
4. 每轮恢复成功后记录配置写入、readyz 成功时间和 Channel 注册结果；
5. 如果某轮 connect 返回 500/400，停止业务层自动重试，仅保留少量人工时间点用于确认该
   Sandbox 是否进入稳定失败状态；
6. 每轮校验 `SOUL.md` 大小和 SHA-256，确认持久化内容未变化；
7. 实验结束后记录 kill 结果；若无法删除，加入残留资源清单并停止继续创建。

### P1：先增加安全诊断，再改行为

计划增加以下不含敏感值的结构化信息：

- bridge operation、attempt、durationMs；
- sandboxId 末 8 位；
- traffic token 是否存在、长度、SHA-256 前 12 位；
- control/data endpoint 的 hostname；
- connect 到 Files.read 的时间差；
- 从嵌套错误文本提取的 status code、error code 和 request ID。

在拿到以上证据前，不直接把 45 秒盲目增加到更大值，也不对 `Sandbox.create` 自动重试
`5xx`，避免重复创建资源。

### P0：修复 session 生命周期（本地已完成）

已按确认设计实施以下最小改动：

1. Python `pause` 成功后不再 `sessions.pop(sandbox_id, None)`；
2. Node `pauseSandbox()` 成功后不再 `this.#sessions.delete(id)`；
3. Python `connect_session()` 命中已有 session 时只调用一次 `Sandbox.connect(id)`，丢弃
   返回对象并返回原 `sessions[id]`；
4. Node resume 命中 `#sessions[id]` 时复用原 wrapper，由 wrapper 发起 bridge `connect`；
5. 只在 kill 成功或明确终止生命周期时清理两层 session；
6. 已增加测试，断言 create -> pause -> resume 复用原 Node wrapper；Python bridge 只有显式
   connect 分支调用 `connect_session()`，Files、Commands 和 kill 只使用 `session_for()`；
7. 单独定义 APP 或 bridge 进程重启后的恢复策略。进程重启会天然丢失内存 session，不能与
   正常 pause/resume 复用路径混为一谈，也不能静默创建新 session 冒充恢复成功。

### P1：候选规避方案

如果 AgentSphere 暂时无法修复 pause/connect，可以把 Demo 的“暂停”实现为：

```text
workspace 已落 SFS
  -> kill 仍在运行的 Sandbox
  -> 恢复时创建新 Sandbox
  -> 挂载同一用户 SFS 目录
  -> 重新注入 openclaw.json
  -> 读取并确认 SOUL.md
```

该方案会增加恢复耗时并丢失内存态，但可以绕过 paused Sandbox 的 Gateway session 问题。
启用前必须先证明运行状态 Sandbox 的 kill 稳定，并为共享目录增加用户隔离和实例代次标识，
避免两个 Sandbox 同时写同一路径。

## 验收标准

修复或规避方案至少满足：

1. 连续 3 次执行 create -> bootstrap -> pause -> resume；
2. 每次 resume 后 Files.read 在约定窗口内成功；
3. 读取的 `SOUL.md` 大小和 SHA-256 与 pause 前一致；
4. 用户确认后 Gateway ready、Channel 重连、对话闭环成功；
5. `resume-data-pending` 重试不产生第二次 connect；
6. 失败时不丢失 Sandbox ID，不产生无法追踪的残留实例；
7. resume 失败且 Sandbox 保持 paused 时，“重置新用户”仍能明确展示 kill 结果；kill 失败时
   不得宣称清理成功，并返回可追踪的 orphaned Sandbox ID；
8. paused Sandbox 可以正常 kill；若服务端暂不支持，跳过清理后必须持久化加入人工清理清单；
9. 实验结束后核对云端残留资源与人工清理清单一致，不能遗失 orphaned Sandbox；
10. 日志不包含 API Key、traffic token、模型密钥或用户 SOUL 正文。

## 实验记录

| 时间（UTC） | 实验 | 镜像/commit | 结果 | request ID / 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-24 08:38 | Sandbox.create | `0.3.8-white-ui-v2` / `54addc2` | 失败，FunctionGraph 502 | `d71c8b4c26391250c583ec77add4e235` | 独立的 AgentSphere 控制面可用性问题 |
| 2026-08-24 09:39 | paused Sandbox 恢复后 Files.read | `0.3.8-white-ui-v2` / `54addc2` | 45 秒后仍 `Session ID not found` | APP 脱敏日志 | 恢复后的 Gateway 数据 session 未在等待窗口内可用 |
| 2026-08-24 11:00 | 修复镜像构建与 SWR 推送 | `0.3.8-pause-session-retain` | 构建、容器内语法检查、推送和回拉核验均成功 | SWR digest `sha256:80faf213c8c60f8ce520b32ad6c120a87c5cd374c8334507a74a7848967f1bc7` | 候选镜像可用于 CCE rollout |
| 2026-08-24 11:18 | 第一版修复 pause 后恢复 | `0.3.8-pause-session-retain` / CCE Revision 29 | `Files.read: Session not found`，并重复出现 `Response 409` | APP 脱敏日志 | 缓存命中未调用实例 `connect()`；消息分类遗漏导致重复 pause |
| 2026-08-24 11:30 | 第二版修复镜像构建与 SWR 推送 | `0.3.8-pause-session-resume-v2` | 构建、镜像内语法检查、推送、回拉和文件哈希核验均成功 | SWR digest `sha256:b76eb0d62ef8cb626c22708591280ef4550c2aacdf4c071bd7556e435c37d8fd` | 可用于 CCE rollout |
| 2026-08-24 11:36 | 第二版实例 connect 恢复 | `0.3.8-pause-session-resume-v2` / CCE generation 33 | 外层 500：Agent Gateway create sandbox/session 内层 400 | Sandbox 末 8 位 `60036878`；响应无 request ID | 客户端已正确发起 resume；当前阻塞在 AgentSphere/Gateway 服务端 |
| 2026-08-24 11:55 | 直接控制面调用镜像构建与 SWR 推送 | `0.3.8-pause-session-direct-v3` | 构建、镜像内语法检查、推送、回拉和文件哈希核验均成功 | SWR digest `sha256:afbb02382e73a5aba644e4d8654d494a9eadcf958bf267cab37d80de857ac2af` | 可用于 CCE rollout |
| 2026-08-24 | 单次 connect 修复镜像构建与 SWR 推送 | `0.3.8-e2b-single-connect-v5` | 基于前一不可变镜像仅覆盖 `e2b-bridge.py`；Python 语法、推送、回拉和镜像内文件哈希核验成功 | SWR digest `sha256:3dfd13e939c37f8802550515bcabb1ef4ef75f7f321ae9153b122a3b1404efd2`；文件 SHA-256 `56d7e103598e873bd55e40899b78241d0178832ead4166a72f5e9f4996611c0c` | 候选镜像可用于 CCE rollout；尚未修改运行中 Deployment |
| 2026-08-24 13:03 | v5 SOUL bootstrap 期间主动重置 | `0.3.8-e2b-single-connect-v5` / CCE generation 36 | 用户点击重置后，command 每秒触发缺失缓存 connect 并返回 404；最终观测状态为 `paused + sandboxId=null` | APP 脱敏观测；Sandbox 末 8 位 `9886e023`；单 Pod、0 restart | 确认为 reset/kill 与未取消 probe 的次生竞态，不代表原始 resume 500 已解决 |
| 2026-08-24 13:14 | v5 pause 后显式 resume | `0.3.8-e2b-single-connect-v5` / CCE generation 36 | 第一次 connect 即返回外层 500/Agent Gateway 内层 400；约 10.782 秒后的再次恢复同样失败 | 用户提供的原始脱敏日志；Sandbox 末 8 位 `3545976a` | 单次 connect 去重已生效，但 AgentSphere/Gateway 服务端恢复失败仍可复现 |
| 2026-08-24 | 远端实际 Sandbox 镜像入口核对 | `onyxclaw-openclaw:0.3.8-channel-error-fix@sha256:d29c37290298d374dd6438ae92ee2def3dadf9e1f7599704f341483c302442b5` | 入口先启动 envd，只等待非 SFS 的 `openclaw.json`，存在后才启动 18789 Gateway | 远端 Docker image layer；入口 SHA-256 `17e779bc367f835d4b309bbe7eaf1172ade1e03cd731422a63ac7aa01181c102` | 恢复 bootstrap 仅写 SOUL 不足；需重签 Channel token、重写配置并确保 Gateway 启动 |
| 2026-08-24 | 恢复 re-bootstrap 本地验证 | 待发布候选镜像 | 恢复确认新增 prepare：新 Channel token、新 `openclaw.json`，随后 SOUL、Gateway 和 Channel；失败不 kill Sandbox | 定向 17/17；`npm run test:cloud` 48/48；沙箱外 `npm test` 114/114 | 本地实现通过，待镜像与 CCE 实测 |
| 2026-08-24 | 恢复 re-bootstrap 镜像构建与 SWR 推送 | `0.3.8-resume-rebootstrap-v6` | 基于 v5 固定 digest，仅覆盖 `cloud-controller.js` 与 `openclaw-bootstrap.js`；未上传 docs/test | SWR digest `sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f` | Node 语法、SWR 回拉、RepoDigest 和镜像内双文件哈希核验通过；待 CCE rollout |
| 2026-08-24 13:37 | v6 同一 Sandbox 三轮 pause/resume | `0.3.8-resume-rebootstrap-v6` / CCE generation 37 | 前两轮 connect、SOUL、配置刷新、readyz 全部成功，写配置到 ready 分别约 6.622/6.937 秒；第三轮起五次 connect 均 500/400 | APP `/api/observability` 脱敏快照；Sandbox 尾部标识 `5311db6`；单 Pod、0 restart | v6 re-bootstrap 已验证；间歇现象收敛为同一 Sandbox 多轮后 Agent Gateway 恢复 session 稳定失败 |
| 2026-08-25 | 恢复失败后重置新用户 | `0.3.8-resume-rebootstrap-v6` | paused Sandbox kill 失败，普通“重置新用户”被阻断 | 用户实测；原始 kill 状态码/request ID 待采集 | 新增衍生问题事件 K；跳过清理只能恢复本地流程，旧 Sandbox 必须作为 orphan 跟踪 |
| 2026-08-25 | 服务端问题归属确认 | `0.3.8-resume-rebootstrap-v6` | 相关负责人确认恢复外层 500、`agent gateway ... failed` 是 Agent Gateway 问题 | 用户转述的负责人反馈 | APP re-bootstrap 不再作为该 500 的修复方向；Agent Gateway 内部原因仍待服务侧定位 |
| 2026-09-02 07:21 | APP 聊天 outbound 关联回归 | 本地 `yqb-dev` / 未部署 | 修复前 10/11，真实 WebSocket 场景稳定复现 `timed out waiting for next outbound event`；修复后定向 18/18、全量 119/119 通过 | Controller -> Simulator -> Channel Transport；不记录用户消息或密钥 | 全局 next-outbound waiter 会错配并发请求；按 `payload.inReplyTo` 关联后，缺少回复的请求独立超时，另一请求不再被误消费 |

## 变更记录

后续每一次相关改动都追加一行；如果改动尚未部署，结果写“仅本地验证”。

| 日期 | 类型 | 改动 | 文件/配置 | commit / 镜像 | 验证结果 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-24 | 文档 | 建立 Bug 排查记录，整理代码路径、两条线上错误、根因假设和验收标准 | 本文 | 待提交 | 相关单测 12/12 通过 | 完成 |
| 2026-08-24 | 设计确认 | 明确 CCE 实际对象为部署依据；pause 保留 Python/Node 两层 session，resume 复用 create 对象及 traffic/envd token | 本文 | 待提交 | 对照当前实现确认存在两层删除和强制 refresh 偏差 | 完成 |
| 2026-08-24 | 代码修复 | 所有 E2B-compatible Provider 在 pause 后保留 Python/Node session，resume 复用 create 对象和 token | `e2b-compatible-adapter.js`、`e2b-bridge.py` | `0.3.8-pause-session-retain@sha256:80faf213c8c60f8ce520b32ad6c120a87c5cd374c8334507a74a7848967f1bc7` | `npm run test:cloud` 47/47 通过；CCE 实测暴露 resume 遗漏 | 第一版不足，已被第二版替代 |
| 2026-08-24 | 代码修复 | kill 仅在成功后删除 Node wrapper，失败时保留后续清理能力 | `e2b-compatible-adapter.js` | 同上 | kill 失败回归测试通过 | 已纳入第二版 |
| 2026-08-24 | 验证 | 运行仓库完整测试套件 | 全仓库 | 待提交 / 未部署 | `npm test` 113/113 通过 | 完成 |
| 2026-08-24 | 镜像发布 | 基于 `white-ui-v2@sha256:138a6f5394e98fcdb0acbaabd49d2e91b7256180c7535b318799982bc39d831c` 增量覆盖两个运行代码文件；未上传 docs/test | 远端 `/home/kibin/onyxclaw-app-pause-session-fix-20260824-u1cLQv` | `0.3.8-pause-session-retain@sha256:80faf213c8c60f8ce520b32ad6c120a87c5cd374c8334507a74a7848967f1bc7` | 上传哈希匹配；Node/Python 语法检查通过；SWR 回拉 digest 一致 | 已 rollout，实测确认不足 |
| 2026-08-24 | CCE 实测 | 部署第一版修复镜像后执行 pause/resume | CCE Deployment Revision 29、APP 日志 | `0.3.8-pause-session-retain@sha256:80faf213c8c60f8ce520b32ad6c120a87c5cd374c8334507a74a7848967f1bc7` | `Session not found` 与 `Response 409` 重复出现 | 第一版修复确认不足 |
| 2026-08-24 | 代码修复 | 正常 resume 经原 Node wrapper 调用 bridge，并对原 Python claimed 对象调用实例 `connect()`；兼容两种 session-not-found 消息 | `e2b-compatible-adapter.js`、`python-e2b-client.js`、`e2b-bridge.py`、`cloud-controller.js` | `0.3.8-pause-session-resume-v2@sha256:b76eb0d62ef8cb626c22708591280ef4550c2aacdf4c071bd7556e435c37d8fd` | `npm run test:cloud` 47/47；`npm test` 113/113；CCE 已发出标准 resume 请求 | 已部署，服务端恢复失败 |
| 2026-08-24 | 镜像发布 | 基于原始 `white-ui-v2` 固定 digest 增量覆盖第二版 4 个运行代码文件；未上传 docs/test | 远端 `/home/kibin/onyxclaw-app-pause-resume-v2-20260824-3MpHyJ` | `0.3.8-pause-session-resume-v2@sha256:b76eb0d62ef8cb626c22708591280ef4550c2aacdf4c071bd7556e435c37d8fd` | 上传及镜像内 SHA-256 匹配；Node/Python 语法检查通过；SWR 回拉 digest 一致 | 已 rollout |
| 2026-08-24 | CCE 实测 | 核对 generation 33、Pod 无重启，并用运行镜像 SDK 源码确认实例 connect 请求与 header 隔离 | CCE Deployment、E2B SDK `Sandbox.connect` / `ConnectionConfig` | 同上 | connect 到达 AgentSphere；Gateway create 返回 400；traffic token 未污染控制面 header | APP 侧无新增行为修复，转服务端排查 |
| 2026-08-24 | 代码调整 | 删除 `is_control_auth_error()` 和 `run_control_operation()`；控制面分支按 create、pause、connect、kill 排列并各直接调用一次 SDK；保留数据面等待 | `e2b-bridge.py`、`python-e2b-client.test.js`、README/交接文档 | `0.3.8-pause-session-direct-v3@sha256:afbb02382e73a5aba644e4d8654d494a9eadcf958bf267cab37d80de857ac2af` | 定向测试 21/21；`npm run test:cloud` 47/47；`npm test` 113/113 | 已推送，待 rollout |
| 2026-08-24 | 镜像发布 | 基于原始 `white-ui-v2` 固定 digest 增量覆盖累计修复的 4 个运行代码文件；未上传 docs/test | 远端 `/home/kibin/onyxclaw-app-pause-direct-v3-20260824-7wmUxb` | `0.3.8-pause-session-direct-v3@sha256:afbb02382e73a5aba644e4d8654d494a9eadcf958bf267cab37d80de857ac2af` | 上传及镜像内 SHA-256 匹配；Node/Python 语法检查通过；SWR 回拉 digest 一致 | 已推送，待 rollout |
| 2026-08-24 | 代码修复 | 拆分 `session_for()` 与 `connect_session()`：只有显式 resume 调用一次 connect；Files、Commands 和 kill 缓存命中时不再隐式 connect；resume 丢弃 connect 返回值并返回 create 原对象 | `e2b-bridge.py`、bridge 测试及生命周期文档 | `0.3.8-e2b-single-connect-v5@sha256:3dfd13e939c37f8802550515bcabb1ef4ef75f7f321ae9153b122a3b1404efd2` | 定向测试 21/21；`npm run test:cloud` 47/47；`npm test` 113/113 | 已 rollout；去重有效，服务端 500/400 仍存在 |
| 2026-08-24 | 镜像发布 | 基于前一不可变镜像，仅覆盖单次 connect 修复后的 `e2b-bridge.py`；未上传 docs/test | 远端 `/home/kibin/onyxclaw-app-e2b-single-connect-v5-20260824-EAqer9` | `0.3.8-e2b-single-connect-v5@sha256:3dfd13e939c37f8802550515bcabb1ef4ef75f7f321ae9153b122a3b1404efd2` | 容器内 Python 语法检查通过；SWR 回拉 digest 一致；源文件与镜像内 SHA-256 均为 `56d7e103598e873bd55e40899b78241d0178832ead4166a72f5e9f4996611c0c` | 已推送，待 rollout |
| 2026-08-24 | CCE 实测 | v5 rollout 后复测 pause/resume、持久化 SOUL 确认及 Gateway readiness probe | CCE generation 36、单副本 Pod、APP 脱敏观测 | 同上 | 一次流程曾进入 SOUL；主动 reset 后出现次生 404；随后另一 Sandbox 首次 resume 重新复现 500/400 | APP 重复 connect 已修复；主阻塞仍为 AgentSphere/Gateway 服务端恢复失败 |
| 2026-08-24 | 代码修复 | resume SOUL 确认后重新签发一次性 Channel token，并用原 instanceId/traceId 重建、写入非持久化 `openclaw.json`；配置刷新失败撤销新 token 但不 kill Sandbox | `cloud-controller.js`、`openclaw-bootstrap.js`、对应测试及生命周期文档 | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f` | 定向 17/17；`npm run test:cloud` 48/48；`npm test` 初次因监听权限 103/114，允许本机监听后 114/114 | 已发布，待 rollout |
| 2026-08-24 | 镜像发布 | 基于 v5 不可变 digest，仅覆盖恢复 re-bootstrap 的两个运行 JS 文件；未上传 docs/test | 远端 `/home/kibin/onyxclaw-app-resume-rebootstrap-v6-20260824-Gv6aH8` | `0.3.8-resume-rebootstrap-v6@sha256:d1ca1cf76ae5da9db85b4bd2e887188ebf34e079fc710dc6960bdeb06df0843f` | `cloud-controller.js` SHA-256 `e121db19e1461f959e5c6031d2a6590635e76466a916c7d77c7e23a8f221eb46`；`openclaw-bootstrap.js` SHA-256 `335a6dd7f58b5b7bc7d8decd0f422342bc0fc5858fefa0582a8375097c9636ee`；回拉 digest 一致 | 已推送，待 rollout |
| 2026-08-24 | CCE 实测 | v6 rollout 后在同一 Sandbox 连续执行三轮 pause/resume | CCE generation 37、APP `/api/observability` | 同上 | 前两轮 re-bootstrap 完整成功；第三轮 connect 在约 60 秒内五次稳定返回 Gateway 500/400，未进入配置写入 | APP 修复验收通过；主阻塞收敛到 AgentSphere 多轮恢复的服务端状态/资源生命周期 |
| 2026-08-25 | 文档补充 | 新增 paused Sandbox kill 失败导致“重置新用户”失败的衍生问题，区分事件 H 并发竞态与事件 K 稳态 kill 失败 | 本文 | 待提交 | 已补问题摘要、时间线、H9、服务端查询项、验收标准和实验记录 | 完成 |
| 2026-08-25 | 文档清理 | 删除已被 v5/v6 证据覆盖的中间镜像、事件和实验明细，并将仍有效的根因判断改由 v6 实测支撑 | 本文 | 待提交 | 文档中已无对应旧版本名称、digest、generation 或 Sandbox 标识 | 完成 |
| 2026-08-25 | 服务端反馈 | 记录相关负责人确认恢复 500/Agent Gateway failed 的组件归属，并保留内部机制和 paused kill 两项待查问题 | 本文 | 待提交 | 已更新状态、问题摘要、事件 L、H1 和实验记录 | 完成 |
| 2026-08-25 | 文档重构 | 文档开头新增结论与修复验证；问题摘要只保留问题现象，详细证据继续放在时间线、假设和实验记录 | 本文 | 待提交 | 已明确 APP 已修复项、v6 验证结果、Agent Gateway 归属及 paused kill 遗留问题 | 完成 |
| 2026-09-02 | 代码修复 | 新增 `waitForReplyTo(inboundEventId)`，聊天按 outbound `payload.inReplyTo` 精确匹配；新增开关控制的 `[DEBUG-chat-v1]` 脱敏 event trace 与并发回归 | `cloud-controller.js`、`ws-simulator.js` 及对应测试 | `yqb-dev` / 待提交、待镜像 | 定向 18/18；全量 `npm test` 119/119；v19 运行时代码基线为 `origin/fix` | 仅本地验证；未构建、推送或部署 |
