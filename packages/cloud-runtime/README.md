# Cloud APP runtime

该包承载云端 APP/BFF 的厂商适配与 OpenClaw 创建编排，不依赖本机 macOS Driver。

当前包含：

- `E2BCompatibleAdapter`：把当前选中的 Provider Registry 配置映射为统一的
  create/connect/pause/commands/files/kill 接口，并在 create 时合并 Provider 固定
  metadata 与实例 trace metadata；
- `OpenClawBootstrapSaga`：创建后立即签发一次性 Channel token 并把
  `openclaw.json` 写到最终路径；首次确认时只写 `SOUL.md`，恢复时先读取持久化
  `SOUL.md`，随即重新签发 Channel token、重写非持久化 `openclaw.json` 以启动
  OpenClaw，再把内容展示给用户确认；确认后只写回 SOUL 并等待 Gateway 和 Channel 就绪；
- 分阶段错误、Secret 脱敏和失败补偿清理；
- `config/providers.alicloud.example.json`：ACS VPC 内 Private Protocol 配置示例。

运行云端单元测试：

```bash
npm run test:cloud
```

`E2BCompatibleAdapter` 通过 `clientFactory` 接收底层 E2B Client，使业务编排不绑定 SDK
或具体云厂商。失败调用会向 stderr 输出脱敏后的 JSON 日志，包括 Provider、API、
阶段、异常类型、状态码和云端 request ID；同一份安全错误摘要也会显示在观测面板中。
下一实现切片是提供基于阿里云支持版本
`e2b==2.24.0 + e2b-code-interpreter==2.7.0 + kruise-agents patch` 的运行时 Client Bridge，
随后将 Saga 接到云端 BFF API。真实 API Key 只从 Provider Registry 的环境变量映射进入，
不能写入 JSON 配置、浏览器状态或日志。

APP 为每个 Sandbox 生成独立的配置对象，直接写入
`${homeDir}/.openclaw/openclaw.json`。workspace 路径来自 Provider Profile，可以通过
Sandbox metadata 挂载到持久存储。所有 E2B-compatible Provider 在 pause 后都保留 create
生成的 Python claimed/routed、traffic/envd token 和 Node wrapper。恢复时只调用一次
`Sandbox.connect(sandbox_id)`，丢弃其返回对象并继续返回、使用 create 时保存的原
claimed/routed；后续 Files、Commands 和 kill 只查缓存，不再隐式 connect。进程重启导致
缓存丢失时，首次 `session_for()` 才用 connect 返回值重新接管并建立新的本地缓存。

控制面与数据面鉴权严格分离：`create/connect/pause/kill` 只使用 E2B API Key；数据面
`traffic_access_token` 只注入该 Sandbox 的 envd Files、Commands 和健康检查请求。
正常 pause/resume 不替换 E2B traffic/envd token；恢复 Gateway 时会签发新的、一次性的
Channel bootstrap token。`create/pause/connect/kill` 均只调用一次对应 SDK 方法，
bridge 不包装控制面重试；若恢复失败，页面保持 `paused`，允许用户决定是否再次恢复。

恢复后 Agent Gateway 尚未识别 session 时，envd 可能短暂返回
`Session ID not found` 或 `Session not found`；bridge 会在 45 秒窗口内对这两种错误退避
重试。若仍失败，Controller
保持已经恢复的 Sandbox 运行并进入 `resume-data-pending`，页面再次点击只重试读取
持久化 `SOUL.md`，不会重复恢复或重新 pause。AgentSphere 有时把控制面 403 只放在
异常文本中；bridge 会原样脱敏上报该错误，不在本地自动重试。其他恢复 bootstrap 失败
不会执行首次创建场景的 kill 补偿，Controller 会尽量重新暂停 Sandbox。
