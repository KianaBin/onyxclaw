# OnyxClaw 分屏可观测 UI 重构方案

> 日期：2026-07-19  
> 状态：首版已实现，本机 UI 待评审，云端镜像待发布  
> 目标：让手机端客户流程与云端 Sandbox 服务行为同时可见

## 1. 设计目标

当前页面适合操作本机 OpenClaw，但不能直观看到一次客户操作在 APP、BFF、E2B API、
Sandbox、OpenClaw Channel 和模型之间如何流转。新版页面定位为内部端到端验证工作台，
而不是消费级聊天产品：左侧模拟客户手机 APP，右侧解释云服务正在发生什么。

核心原则：

1. 手机操作仍严格遵循“龙虾模式 → 性格确认 → 对话”的串行门禁。
2. 右侧只展示验证云服务有价值的信息，不增加头像市场、主题、社交或运营功能。
3. 架构动画必须由真实请求状态驱动，不能播放与当前操作无关的装饰动画。
4. API 耗时只在 APP 后端调用 Sandbox Service SDK 的边界记录，不统计 UI、OpenClaw、
   Channel 或模型交互耗时。
5. API Key、bootstrap token、完整 Soul 和聊天正文不进入观测数据。

## 2. 页面信息架构

桌面浏览器采用左右分屏，右侧再上下分区：

```text
┌─────────────────────────────┬──────────────────────────────────────────┐
│ Customer APP                │ Architecture / live request flow         │
│ ┌─────────────────────────┐ │ Browser → BFF → E2B → Sandbox            │
│ │ 手机状态栏              │ │                    ↘ OpenClaw → MiniMax │
│ │ 01 龙虾模式             │ ├──────────────────────────────────────────┤
│ │ 02 性格确认             │ │ API activity                             │
│ │ 03 对话                 │ │ running/success/error + duration         │
│ │                         │ │ resource objects: Sandbox/Gateway/Channel│
│ └─────────────────────────┘ │                                          │
└─────────────────────────────┴──────────────────────────────────────────┘
```

### 2.1 左侧：手机客户 APP

- 以约 390 × 780 的手机外框承载现有三步流程；
- 顶部显示当前环境、连接状态和串行步骤；
- 龙虾模式页只保留进入/清理操作及少量客户可理解状态；
- Soul 编辑器适配手机高度，确认后隐藏第二步；
- 对话页使用紧凑消息气泡和底部输入框；
- 浏览器刷新仍默认显示第一步，不重置 BFF 中已有状态。

### 2.2 右上：动画架构拓扑

固定展示六类对象：Web APP、Node BFF、E2B Manager、Sandbox、OpenClaw/Channel、
MiniMax。连接线按当前请求高亮：

| 用户动作 | 高亮路径 |
| --- | --- |
| 进入龙虾模式 | APP → BFF → E2B Manager → Sandbox |
| 确认性格 | APP → BFF → E2B Files → Sandbox → OpenClaw/Channel |
| 首次问候/发送消息 | APP → BFF → Channel → OpenClaw → MiniMax → 原路返回 |
| 清理 | APP → BFF → E2B kill → Sandbox |

运行中的调用使用流动虚线和呼吸光点；成功转为绿色，失败转为珊瑚红。动画遵守
`prefers-reduced-motion`，用户要求减少动态效果时只做颜色切换。

### 2.3 右下：API 与资源状态

上半行展示 Backend Objects：

- BFF：ready/busy/error；
- Sandbox：none/allocated/running/terminated；
- Gateway：waiting/healthy/error；
- Channel：disconnected/connected/error；
- Model：standby/calling/responded/error。

下方按时间倒序展示 APP 后端实际发往 Sandbox Service 的调用：E2B SDK API、服务端点、
状态、耗时和产生或操作的后端对象。第一版覆盖：

- `Sandbox.create/connect/kill`：对象为 Sandbox，展示 Sandbox ID 和 running/terminated；
- `Files.write/read`：对象为 File，展示沙箱内路径和 written/read/failed；
- `Commands.run`：对象为 Process/Command，展示 Sandbox ID 和 exit code。

`running` 调用的耗时随轮询增长，结束后冻结。计时点位于 AgentSphere Adapter 调用
E2B SDK 的边界，因此包含 APP 到 Sandbox Service 的请求等待时间，但不包含之后的
OpenClaw、Channel 或 MiniMax 推理时间。SDK 未公开 HTTP 状态码时不伪造状态码，只展示
succeeded/failed 及可获得的对象状态。

## 3. 服务端观测数据

新增只读接口：

```http
GET /api/observability
```

响应示意：

```json
{
  "generatedAt": "2026-07-19T09:00:00.000Z",
  "calls": [
    {
      "id": "...",
      "api": "Sandbox.create",
      "target": "AgentSphere Sandbox Service",
      "state": "succeeded",
      "durationMs": 286,
      "object": {
        "type": "Sandbox",
        "id": "default--onyxclaw-abcd",
        "state": "running"
      },
      "startedAt": "..."
    }
  ],
  "objects": [
    { "type": "Sandbox", "id": "default--onyxclaw-abcd", "state": "running" }
  ]
}
```

约束：仅保留最近 40 次 Sandbox Service 调用；不记录 UI/BFF/OpenClaw/模型调用，不记录
命令正文、文件内容、请求体、响应正文、Header 或 Secret。数据仅在当前 BFF 内存中保存，
不引入数据库。

## 4. 响应式与可访问性

- `>= 1100px`：严格左右分屏，右侧上下分区；
- `760px–1099px`：手机居中，观测工作台位于其下；
- `< 760px`：去掉装饰性手机外框，优先保证操作；架构和 API 面板继续向下排列；
- 所有状态同时使用文字和颜色，不只依赖颜色；
- SVG 提供可读标题，动态区域使用 `aria-live="polite"`；
- 键盘交互、Enter 发送和原有表单门禁保持不变。

## 5. 开发顺序与验收

1. 用单元测试定义 Sandbox Service 调用记录、脱敏、容量上限和对象状态映射；
2. 在现有 BFF 增加 `/api/observability`，覆盖运行中、成功和失败调用；
3. 重构 HTML/CSS 为手机 + 双层工作台；
4. 前端轮询观测接口，驱动架构连线、对象状态和调用列表；
5. 跑全量测试，并分别验证本机模式和 Huawei CCE + AgentSphere 云端模式。

完成标准：原三步流程无回归；Sandbox Service 长耗时调用进行中可见；完成后显示 Adapter
边界的真实耗时和后端对象；OpenClaw/模型耗时不进入列表；失败状态可见；任何观测响应中
均不出现命令、文件内容、请求正文和凭据。
