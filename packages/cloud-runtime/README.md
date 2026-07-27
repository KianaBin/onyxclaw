# Cloud APP runtime

该包承载云端 APP/BFF 的厂商适配与 OpenClaw 创建编排，不依赖本机 macOS Driver。

当前包含：

- `E2BCompatibleAdapter`：把当前选中的 Provider Registry 配置映射为统一的
  create/connect/commands/files/kill 接口；
- `OpenClawBootstrapSaga`：创建 Sandbox、签发一次性 Channel token、写入
  `openclaw.json` 与 `SOUL.md`，并等待 Gateway 和 Channel 就绪；
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
