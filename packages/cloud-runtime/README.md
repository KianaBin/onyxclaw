# Cloud APP runtime

该包承载云端 APP/BFF 的厂商适配与 OpenClaw 创建编排，不依赖本机 macOS Driver。

当前包含：

- `E2BCompatibleAdapter`：把当前选中的 Provider Registry 配置映射为统一的
  create/connect/pause/commands/files/kill 接口，并在 create 时合并 Provider 固定
  metadata 与实例 trace metadata；
- `OpenClawBootstrapSaga`：创建后立即签发一次性 Channel token 并把
  `openclaw.json` 写到最终路径；用户确认或恢复时只写 `SOUL.md`，随后等待 Gateway
  和 Channel 就绪；
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
Sandbox metadata 挂载到持久存储。暂停会调用 E2B `Sandbox.pause` 并丢弃旧 SDK
session；恢复调用 `Sandbox.connect` 获取新控制面和数据面凭据，再执行只包含
`SOUL.md` 写入、Gateway ready 和 Channel 回连等待的 bootstrap 阶段。

控制面与数据面鉴权严格分离：`create/connect/pause/kill` 只使用 E2B API Key；
`connect` 成功后返回的新 `traffic_access_token` 只注入该 Sandbox 的 envd
Files、Commands 和健康检查请求。控制面 `connect` 遇到临时 `401/403` 会有限重试；
若最终失败，页面保持 `paused`，允许用户再次点击恢复。
