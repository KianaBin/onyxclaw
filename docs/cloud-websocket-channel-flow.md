# Cloud APP 与 OpenClaw 的 WebSocket Channel 链路

本文说明 OnyxClaw Cloud 模式下 WebSocket 如何创建、连接和传递消息，并分别从
Cloud APP 与 Sandbox 内 OpenClaw 的角度解释注册、鉴权、心跳、重连和聊天过程。

本文只讨论 OnyxClaw Channel，不讨论 E2B SDK 如何创建 Sandbox，也不讨论模型 Provider
的具体配置。

> 代码基线：`feat/huaweicloud-agentsphere-adaptation@d309fc7`。

## 1. 网络方向和三个端口

Cloud 模式下，是 Sandbox 内的 OpenClaw 主动连接 Cloud APP，而不是 Cloud APP 主动进入
Sandbox 建立 Channel。

```text
Browser
  │ HTTP
  ▼
Cloud APP HTTP Server :3000
  │
  │ 通过内存中的连接表发送/等待 Channel 消息
  ▼
Cloud APP WebSocket Server :18890
  ▲
  │ WS/WSS，由 Sandbox 主动建立长连接
  │
OpenClaw OnyxClaw Channel Plugin
  │
  ▼
OpenClaw Agent → Model Provider
```

三个端口的作用不同：

| 端口 | 所在位置 | 服务 | 用途 |
| --- | --- | --- | --- |
| `3000` | Cloud APP Pod | HTTP Server | 页面、REST API、浏览器聊天入口 |
| `18890` | Cloud APP Pod | WebSocket Server | 与 Sandbox 内 OnyxClaw Plugin 通信 |
| `18789` | AgentSphere Sandbox | OpenClaw Gateway | OpenClaw 自身服务，Cloud APP 只做 ready 检查 |

OpenClaw Gateway 的 `18789` 不承载 Cloud APP 与 Channel Plugin 之间的用户消息。用户消息
实际经过 Cloud APP 的 `18890` WebSocket 服务。

## 2. Cloud APP 角度

### 2.1 创建 WebSocket Server

Cloud APP 启动时创建 `WsPlatformSimulator`：

```js
const simulator = new WsPlatformSimulator({
  host: process.env.CHANNEL_HOST ?? "0.0.0.0",
  port: Number(process.env.CHANNEL_PORT ?? "18890"),
});
```

随后依次启动 WebSocket 和 HTTP 服务：

```js
await simulator.start();
await app.start();
```

`WsPlatformSimulator.start()` 使用 `ws` 包创建独立 Server：

```js
this.#server = new WebSocketServer({
  port: this.#port,
  host: this.#host,
});

this.#server.on(
  "connection",
  socket => this.#handleConnection(socket),
);
```

WebSocket Server 和 `3000` 端口的 HTTP Server 是两个独立监听器，没有共享同一个 HTTP
Upgrade Server。

### 2.2 CCE 中暴露 Channel 端口

Cloud APP Deployment 声明：

```yaml
ports:
  - name: http
    containerPort: 3000
  - name: channel
    containerPort: 18890
```

Service 同时暴露：

```yaml
ports:
  - name: http
    port: 3000
    targetPort: http
  - name: channel
    port: 18890
    targetPort: channel
```

在实际 CCE 网络中，通常由私网 ELB 将 Sandbox 可访问的监听器转发到 `18890`：

```text
Browser / 运维网络
  → Private ELB:3000
  → Service:3000
  → Cloud APP HTTP

AgentSphere Sandbox
  → Private ELB:80 或 443
  → Service:18890
  → Cloud APP WebSocket
```

如果对外使用 `wss://`，TLS 通常在 ELB 或其他入口终止，再将连接转发到 Pod 的明文
WebSocket `18890`。

### 2.3 Channel URL 如何进入 OpenClaw

Provider Profile 声明：

```json
{
  "channel": {
    "publicUrl": "wss://replace-with-channel-domain/connect"
  }
}
```

这里的 `publicUrl` 表示 Sandbox 可访问的 Channel 地址，不是 Cloud APP 的监听地址。
Cloud APP 在构建 OpenClaw 配置时将它写成：

```json
{
  "channels": {
    "onyxclaw": {
      "platformUrl": "wss://replace-with-channel-domain/connect"
    }
  }
}
```

当前 `WebSocketServer` 没有配置固定 `path`，服务端也没有根据 URL 路径进行路由校验。
因此 `/connect` 会出现在 Upgrade 请求中，但当前 Server 接受到达该端口的任意 WebSocket
Upgrade 路径。

### 2.4 签发一次性 Bootstrap Token

Cloud APP 创建 Sandbox 时生成 `instanceId`。开始 OpenClaw bootstrap 时又生成一次性
`bootstrapToken`：

```js
const bootstrapToken = tokenFactory();

await channel.issueBootstrapToken(
  instanceId,
  bootstrapToken,
);
```

Cloud APP 将其保存在内存：

```js
bootstrapTokens.set(instanceId, {
  value: bootstrapToken,
  used: false,
});
```

同一组 `instanceId` 和 `bootstrapToken` 被写入 Sandbox 的 OpenClaw 配置。这样 Cloud APP
与 OpenClaw 在第一次连接时可以核对实例身份。

### 2.5 接受首次注册

OpenClaw 建立 WebSocket 后，第一条业务消息是：

```json
{
  "protocolVersion": "1",
  "eventId": "<uuid>",
  "eventType": "channel.register",
  "timestamp": "<ISO-8601>",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {
    "bootstrapToken": "<one-time-token>",
    "pluginVersion": "0.1.0"
  }
}
```

Cloud APP 调用：

```js
core.register({
  instanceId,
  accountId,
  bootstrapToken,
  pluginVersion,
});
```

Server 校验：

- 是否为该 `instanceId` 签发过 bootstrap token；
- Token 是否完全一致；
- Token 是否已经使用；
- `accountId` 和 `pluginVersion` 是否存在。

校验成功后：

1. 将 bootstrap token 标记为已使用；
2. 生成 `sessionToken`；
3. 生成 `connectionId`；
4. 将当前 socket 按 `instanceId` 存入连接表。

```js
connections.set(instanceId, {
  socket,
  sessionToken,
  connectionId,
  accountId,
});
```

Cloud APP 回复：

```json
{
  "protocolVersion": "1",
  "eventType": "channel.registered",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {
    "connectionId": "<connection-id>",
    "sessionToken": "channel_<uuid>"
  }
}
```

### 2.6 等待 Channel 就绪

Bootstrap Saga 写入 OpenClaw 配置后按顺序等待：

```text
OpenClaw Gateway ready
        ↓
对应 instanceId 的 Channel 注册完成
```

代码调用：

```js
const connection =
  await channel.waitForConnection(instanceId);
```

注册成功后，等待者得到 `connectionId`，bootstrap 状态依次进入：

```text
GATEWAY_READY
→ CHANNEL_READY
→ READY
```

Cloud APP 进入 `READY` 后才允许浏览器发送聊天消息。

## 3. OpenClaw 角度

### 3.1 加载 OnyxClaw Plugin

Cloud APP 生成的 OpenClaw 配置启用 Plugin：

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/opt/onyxclaw/channel"
      ]
    },
    "entries": {
      "onyxclaw": {
        "enabled": true
      }
    }
  }
}
```

OpenClaw 启动时从 `/opt/onyxclaw/channel` 加载 OnyxClaw Plugin。Plugin 读取：

```js
cfg.channels.onyxclaw
```

配置至少需要：

```text
platformUrl
instanceId
bootstrapToken
```

三项都存在时，Plugin 才认为 Channel 已配置。

### 3.2 创建 WebSocket Client

OpenClaw 启动 Channel Account 时创建 Transport：

```js
const transport = new OnyxclawTransport({
  platformUrl: account.platformUrl,
  instanceId: account.instanceId,
  accountId: account.accountId,
  bootstrapToken: account.bootstrapToken,
  pluginVersion: "0.1.0",
});
```

然后调用：

```js
await transport.start();
```

Transport 主动创建 WebSocket Client：

```js
const socket = new WebSocket(
  this.#options.platformUrl,
);
```

因此这条连接只要求 AgentSphere Sandbox 能够出站访问 Cloud APP Channel URL。Cloud APP
不需要通过 AgentSphere 入站 Gateway 主动访问 Sandbox 来建立 Channel。

### 3.3 首次注册

底层 WebSocket 触发 `open` 后，Transport 状态从：

```text
connecting → registering
```

并立即发送 `channel.register`。首次连接使用配置中的一次性 `bootstrapToken`。

收到 `channel.registered` 后，Transport 保存：

```js
this.connectionId = event.payload.connectionId;
this.#sessionToken = event.payload.sessionToken;
this.status = "connected";
```

`transport.start()` 的 Promise 也在注册成功后才 resolve，而不是在底层 TCP/WebSocket
握手完成时 resolve。

### 3.4 心跳

注册成功后，Transport 默认每 5 秒发送：

```json
{
  "eventType": "heartbeat",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {
    "connectionId": "<connection-id>"
  }
}
```

当前 Cloud APP 会解析 `heartbeat` 事件，但没有：

- 回复 heartbeat ack；
- 更新最后心跳时间；
- 根据心跳超时主动关闭连接。

因此当前心跳还不是完整的服务端存活检测机制。

### 3.5 自动重连

Socket 关闭后，只要不是 Plugin 主动停止，Transport 就会自动重连。默认退避时间为：

```text
250 ms
→ 500 ms
→ 1000 ms
→ 2000 ms
→ 4000 ms
→ 最大 5000 ms
```

首次连接成功后 Transport 已保存 `sessionToken`，所以重连不再使用已经消费的一次性
bootstrap token，而是发送：

```json
{
  "eventType": "channel.register",
  "payload": {
    "sessionToken": "channel_<uuid>",
    "pluginVersion": "0.1.0"
  }
}
```

Cloud APP 校验：

- Session Token 是否存在；
- Session 是否属于相同 `instanceId`；
- `accountId` 是否一致；
- Plugin 版本是否一致。

校验成功后复用原 `sessionToken`，但生成新的 `connectionId`。

## 4. 浏览器到 OpenClaw 的消息过程

### 4.1 浏览器使用 HTTP，而不是直接使用 Channel WebSocket

浏览器调用 Cloud APP：

```text
POST /api/chat
```

请求体：

```json
{
  "text": "你好"
}
```

HTTP Server 调用：

```js
controller.sendMessage(body.text);
```

浏览器不会直接获得 `bootstrapToken`、`sessionToken` 或 Channel WebSocket。

### 4.2 Cloud APP 发送 message.inbound

Controller 创建统一 Channel Envelope：

```json
{
  "protocolVersion": "1",
  "eventType": "message.inbound",
  "eventId": "<uuid>",
  "timestamp": "<ISO-8601>",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {
    "senderId": "cloud-app-user",
    "chatId": "cloud_<uuid>",
    "text": "你好"
  }
}
```

Cloud APP 根据 `instanceId` 从连接表中找到 socket：

```js
const connection = connections.get(instanceId);
connection.socket.send(JSON.stringify(event));
```

随后 Controller 等待 OpenClaw 返回下一条 outbound 消息。

### 4.3 OpenClaw 将 inbound 事件交给 Agent

Transport 收到 `message.inbound` 后调用 Plugin 的 `onInbound`，继而进入：

```js
dispatchInboundEvent(...)
```

该函数负责：

1. 根据 Channel、Account 和 `chatId` 解析 Agent Route；
2. 构建 OpenClaw inbound context；
3. 定位 Agent Session；
4. 将用户文本送入 OpenClaw Agent；
5. 触发模型调用；
6. 将 Agent 生成的可见回复交给 delivery callback。

消息上下文中的关键字段包括：

```text
channel = onyxclaw
accountId = default
conversation.kind = direct
conversation.id = chatId
messageId = inbound eventId
bodyForAgent = 用户文本
```

### 4.4 OpenClaw 发送 message.outbound

Agent 返回文本后，Plugin 调用：

```js
connection.sendOutbound({
  eventId: randomUUID(),
  chatId,
  text,
  inReplyTo: inboundEventId,
});
```

Transport 通过同一条 WebSocket 发送：

```json
{
  "protocolVersion": "1",
  "eventType": "message.outbound",
  "eventId": "<outbound-event-id>",
  "timestamp": "<ISO-8601>",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {
    "chatId": "cloud_<uuid>",
    "text": "你好，我是……",
    "inReplyTo": "<inbound-event-id>"
  }
}
```

### 4.5 Cloud APP 接收回复并返回浏览器

Cloud APP 收到 `message.outbound` 后：

1. 根据当前 socket 对应的 `sessionToken` 校验 Session；
2. 校验 `instanceId` 和 `accountId`；
3. 根据 `eventId` 去重；
4. 保存 outbound event；
5. 回复 `message.ack`；
6. 唤醒 Controller 中等待回复的 Promise。

ACK 格式：

```json
{
  "eventType": "message.ack",
  "payload": {
    "eventId": "<outbound-event-id>",
    "duplicate": false
  }
}
```

Controller 将收到的 outbound event 转换为 HTTP Response：

```json
{
  "text": "你好，我是……",
  "inboundEventId": "<inbound-event-id>",
  "outboundEventId": "<outbound-event-id>",
  "durationMs": 1234,
  "traceId": "<inbound-event-id>"
}
```

浏览器最终通过原来的 HTTP 请求获得回复。

## 5. 完整通信时序

```text
Browser          Cloud APP HTTP       Cloud APP WS       OpenClaw Plugin       OpenClaw Agent
   │                    │                   │                    │                    │
   │                    │ start :3000       │ start :18890       │                    │
   │                    │                   │                    │                    │
   │                    │ create Sandbox    │                    │                    │
   │                    │ issue token       │                    │                    │
   │                    │ write config      │                    │                    │
   │                    │                   │◀── WebSocket ──────│                    │
   │                    │                   │                    │                    │
   │                    │                   │◀─ channel.register │                    │
   │                    │                   │── registered ─────▶│                    │
   │                    │                   │                    │                    │
   │ POST /api/chat     │                   │                    │                    │
   │───────────────────▶│                   │                    │                    │
   │                    │ message.inbound   │                    │                    │
   │                    │──────────────────▶│───────────────────▶│                    │
   │                    │                   │                    │ dispatch inbound   │
   │                    │                   │                    │───────────────────▶│
   │                    │                   │                    │                    │ model
   │                    │                   │                    │◀───────────────────│
   │                    │                   │◀─ message.outbound │                    │
   │                    │                   │── message.ack ─────▶│                    │
   │                    │◀── resolve waiter │                    │                    │
   │◀── HTTP response ──│                   │                    │                    │
```

## 6. Channel 协议

所有消息使用统一 Envelope：

```json
{
  "protocolVersion": "1",
  "eventId": "<uuid>",
  "eventType": "message.inbound",
  "timestamp": "<ISO-8601>",
  "instanceId": "<instance-id>",
  "accountId": "default",
  "payload": {}
}
```

公共字段：

| 字段 | 作用 |
| --- | --- |
| `protocolVersion` | 协议版本，当前固定为 `1` |
| `eventId` | 单条事件的唯一 ID |
| `eventType` | 事件类型 |
| `timestamp` | 事件创建时间 |
| `instanceId` | 对应 Cloud APP 分配的 OpenClaw 实例 |
| `accountId` | OpenClaw Channel Account，当前默认为 `default` |
| `payload` | 事件类型相关的数据 |

支持的事件类型：

```text
channel.register
channel.registered
heartbeat
message.inbound
message.outbound
message.ack
error
```

如果消息结构、协议版本或事件类型不合法，Cloud APP 会以 WebSocket Close Code `1008`
关闭该连接。

## 7. Token 和连接状态

### 7.1 Bootstrap Token

```text
产生方：Cloud APP
保存位置：Cloud APP 内存 + Sandbox OpenClaw 配置
用途：首次 Channel 注册
特点：一次性使用
```

### 7.2 Session Token

```text
产生方：Cloud APP
保存位置：Cloud APP 内存 + OpenClaw Transport 内存
用途：断线重连
特点：绑定 instanceId、accountId 和 pluginVersion
```

### 7.3 Connection ID

```text
产生方：Cloud APP
保存位置：双方内存
用途：标识当前这一次物理 WebSocket 连接
特点：每次重连重新生成
```

三者关系：

```text
bootstrapToken
  └── 首次注册后消费
        └── sessionToken
              ├── 第一次 connectionId
              ├── 重连后的 connectionId
              └── 再次重连后的 connectionId
```

## 8. 停止和清理

OpenClaw Plugin 停止时：

```js
transport.stop();
```

它会：

- 停止心跳；
- 清除重连定时器；
- 使用 Close Code `1000` 关闭 socket；
- 将状态设为 `closed`。

Cloud APP 停止时：

```js
await simulator.stop();
```

它会关闭当前连接表中的所有 socket，再关闭 WebSocket Server。

Socket 关闭后，Cloud APP 从 `connections` 中删除对应 `instanceId`。但 Session Token 和
已消费的 Bootstrap Token 当前仍是进程内存状态，直到进程退出或相关状态被显式清理。

## 9. 当前实现边界

### 9.1 Server 仍使用 Simulator 实现

云端直接复用了 `WsPlatformSimulator` 和 `ChannelPlatformSimulator`。它们最初用于本地
测试，因此当前服务具备基本注册和消息能力，但不是完整的生产 Channel Gateway。

### 9.2 状态全部在单进程内存中

以下状态没有外部持久化：

- bootstrap token；
- session token；
- instanceId 到 socket 的映射；
- outbound 去重集合；
- 尚未消费的 outbound 消息；
- 等待连接和等待回复的 Promise。

因此当前适合单副本 Demo。Cloud APP 重启会丢失状态；多副本还需要共享 Session 状态或
基于 `instanceId` 的稳定路由。

### 9.3 Signing Secret 尚未参与握手

Provider Profile 声明的 `channel.signingSecretEnv` 会被 Registry 读取，但当前注册协议没有
使用该 Secret 做签名。首次鉴权使用一次性 `bootstrapToken`，重连使用 `sessionToken`。

### 9.4 Channel 连接等待时间没有使用 Profile 配置

Provider Profile 包含：

```json
{
  "channel": {
    "connectTimeoutMs": 120000
  }
}
```

但新 Sandbox 的 Bootstrap Saga 当前调用：

```js
channel.waitForConnection(instanceId)
```

没有传入 `connectTimeoutMs`，因此实际落到 `WsPlatformSimulator` 默认的 2 秒。这对真实云
环境可能过短。连接已有 Sandbox 的 Controller 路径使用的是自身默认 120 秒，但同样没有
直接读取 Provider 的 `channel.connectTimeoutMs`。

### 9.5 心跳是单向的

OpenClaw 每 5 秒发送 heartbeat，但 Cloud APP 不回复、不记录最后心跳时间，也不根据超时
清理僵尸连接。

### 9.6 ACK 没有驱动重发

Cloud APP 会为 `message.outbound` 返回 `message.ack`，但 OpenClaw Transport 当前没有
专门处理 ACK，也没有未确认消息缓存和基于 ACK 的重发机制。

### 9.7 HTTP 等待的是下一条 outbound

Controller 使用：

```js
waitForNextOutbound()
```

等待下一条回复，而不是严格根据 `inReplyTo` 匹配当前 inbound event。如果允许同一进程中
存在多个并发聊天请求，回复可能串配。当前串行 Demo 流程下该问题不明显。

### 9.8 WebSocket Upgrade 没有路径级鉴权

Server 接受连接时没有校验 Upgrade 路径，也没有在 HTTP Upgrade 阶段验证 Header。身份
校验发生在 WebSocket 建立后的第一条 `channel.register` 消息。

## 10. 关键结论

1. Cloud APP 是 WebSocket Server，OpenClaw Plugin 是主动连接的 WebSocket Client。
2. 浏览器使用 HTTP API，不直接连接 Channel WebSocket。
3. `instanceId + bootstrapToken` 用于首次注册，`sessionToken` 用于断线重连。
4. 同一条长连接承载 `message.inbound`、`message.outbound`、heartbeat 和 ACK。
5. OpenClaw Plugin 将 inbound 消息转换为 OpenClaw Agent Turn，再把模型回复发回 Cloud APP。
6. `18789` 是 OpenClaw Gateway 健康检查端口，`18890` 才是 Channel 通信端口。
7. 当前实现面向单副本 Demo；持久化、多副本路由、完整心跳和消息可靠性仍需后续完善。

## 11. 源码导航

- `packages/cloud-runtime/src/cloud-app.js`
- `packages/cloud-runtime/src/cloud-controller.js`
- `packages/cloud-runtime/src/openclaw-bootstrap.js`
- `packages/test-orchestrator/src/ws-simulator.js`
- `packages/test-orchestrator/src/simulator-core.js`
- `packages/test-orchestrator/src/protocol.js`
- `packages/onyxclaw-channel/src/channel.js`
- `packages/onyxclaw-channel/src/transport-websocket.js`
- `packages/onyxclaw-channel/src/inbound.js`
- `packages/onyxclaw-channel/src/protocol.js`
- `packages/onyxclaw-channel/openclaw.plugin.json`
- `deploy/cloud-app/app.yaml.tmpl`
- `config/providers.agentsphere.example.json`
