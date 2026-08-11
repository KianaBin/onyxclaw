# Cloud APP runtime

该包承载云端 APP/BFF、E2B Sandbox 生命周期管理和 OpenClaw 启动编排，不依赖
本机 macOS Driver，也不绑定特定云厂商。

核心模块：

- `E2BCompatibleAdapter`：提供 create/connect/commands/files/kill 统一接口；
- `python-e2b-client.js`：维护 Node.js 到 Python bridge 的 JSON Lines 通道；
- `e2b-bridge.py`：使用基础版 `e2b.Sandbox` 调用兼容 API；
- `OpenClawBootstrapSaga`：写入配置并等待 Gateway 和 Channel 就绪；
- `cloud-app.js`：装配 Provider、Adapter、Controller、Simulator 和 HTTP 服务。

运行云端单元测试：

```bash
npm run test:cloud
```

AgentSphere 配置样例位于 `config/providers.agentsphere.example.json`。API Key 只从
Profile 指定的环境变量读取，不能写入 JSON、浏览器状态或日志。
