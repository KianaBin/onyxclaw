# Sandbox 中 OpenClaw 配置的设置时机

本文说明 OnyxClaw Cloud APP 创建 Sandbox 时会设置哪些参数，以及 Sandbox 创建成功后
会追加哪些 OpenClaw、模型 Provider 和 Channel 配置。

本文聚焦配置的生命周期，不讨论特定云厂商的适配方式。

> 代码基线：`feat/huaweicloud-agentsphere-adaptation@561c0ed`。当前实现仍依赖
> Sandbox Template 内的 bootstrap 机制，相关边界见“Template 与 Cloud APP 的职责”。

## 1. 三个配置阶段

整个过程应分成三个阶段理解：

```text
阶段 A：创建 Sandbox Template
  决定 Sandbox 中有什么、如何启动、具有什么网络能力
                         │
                         ▼
阶段 B：调用 Sandbox.create()
  使用 Template 创建一次具体的 Sandbox 实例
                         │
                         ▼
阶段 C：Sandbox 创建后
  生成并写入本次 OpenClaw 实例的模型、Channel 和 SOUL 配置
```

三者的边界是：

- Template 描述可复用的运行环境；
- `Sandbox.create()` 描述本次实例的创建参数；
- 运行时配置描述本次 OpenClaw 实例连接哪个模型和 Channel。

## 2. 阶段 A：Template 中预先设置

Template 在 Sandbox 平台中预先创建。Cloud APP 只引用其 `templateId`，不会在创建
Sandbox 时修改 Template 本身。

Template 通常包含：

| 配置 | 作用 | 当前 Cloud APP 是否修改 |
| --- | --- | --- |
| 基础镜像 | 决定 Sandbox 中的软件和文件 | 否 |
| CPU、内存等资源配额 | 决定 Sandbox 资源规格 | 否 |
| 启动命令 | 决定容器创建后的初始进程 | 否 |
| Template 环境变量 | 为基于该 Template 创建的实例提供默认环境 | 否 |
| 出站网络配置 | 决定 Sandbox 如何访问模型和 Cloud APP | 否 |
| 入站 Gateway | 决定外部如何访问 Sandbox 内的服务 | 否 |
| 默认用户和 HOME | 决定命令用户与文件路径 | 否 |
| OpenClaw 程序 | 提供 OpenClaw runtime | 否 |
| OnyxClaw Channel Plugin | 提供 `/opt/onyxclaw/channel` | 否 |
| Bootstrap 启动机制 | 安装动态配置并启动 OpenClaw | 否 |

当前代码默认使用这些路径和端口：

```text
默认用户：node
HOME：/home/node
OpenClaw workspace：/home/node/.openclaw/workspace
OnyxClaw Plugin：/opt/onyxclaw/channel
OpenClaw Gateway：127.0.0.1:18789
```

这些值在 Provider Profile 中描述，但 Profile 不能改变 Template 镜像中真实存在的用户、
目录和程序。两边必须保持一致。

## 3. 阶段 B：创建 Sandbox 时传入

创建 Sandbox 的入口是：

```js
adapter.createSandbox({ metadata, envs });
```

Adapter 从 Provider Profile 读取 Template 和生命周期参数：

```js
const session = await client.create({
  template: provider.sandbox.templateId,
  timeoutSeconds: Math.ceil(provider.sandbox.timeoutMs / 1000),
  secure: provider.sandbox.secure,
  metadata,
  envs,
});
```

Python Bridge 最终调用：

```python
claimed = Sandbox.create(
    template=params["template"],
    timeout=params.get("timeoutSeconds", 300),
    metadata=params.get("metadata"),
    envs=params.get("envs"),
    secure=params.get("secure", True),
    api_key=api_key,
)
```

### 3.1 参数来源

| SDK 参数 | 来源 | 含义 |
| --- | --- | --- |
| `template` | `provider.sandbox.templateId` | 使用哪个预先创建的 Template |
| `timeout` | `provider.sandbox.timeoutMs` | Sandbox 生命周期超时，毫秒换算为秒 |
| `secure` | `provider.sandbox.secure` | SDK 创建 Sandbox 时的安全连接设置 |
| `metadata` | Cloud APP 动态生成 | 标记本次实例和调用链 |
| `envs` | `createSandbox()` 调用参数 | 向本次 Sandbox 注入环境变量 |
| `api_key` | Provider 声明的 Secret 环境变量 | 调用 Sandbox API 时鉴权 |

### 3.2 当前实际传入的 metadata

创建新 Sandbox 时，Controller 动态生成：

```js
const instanceId = randomUUID();
const traceId = randomUUID();
```

然后调用：

```js
adapter.createSandbox({
  metadata: {
    instanceId,
    traceId,
  },
});
```

两个字段的用途是：

- `instanceId`：标识本次 OpenClaw/Channel 实例；
- `traceId`：串联本次创建与 bootstrap 过程。

### 3.3 当前没有通过 envs 注入 OpenClaw 配置

Adapter 支持 `envs`，但当前 Cloud Controller 创建 Sandbox 时只传递 `metadata`，没有
传入 `envs`。

因此，下列内容当前都不是通过 `Sandbox.create(envs=...)` 注入的：

- OpenClaw 模型 Provider；
- 模型 API Base URL；
- 模型 ID；
- 模型 API Key；
- Channel URL；
- Channel bootstrap token；
- `SOUL.md`。

这些内容均在 Sandbox 创建成功后写入文件。

### 3.4 API URL 和 API Key 不属于 Sandbox 内部配置

Provider Profile 中的：

```text
api.baseUrl
api.apiKeyEnv
```

用于 Cloud APP 初始化 E2B Client 和调用 Sandbox API。

它们不是本次 Sandbox 的业务环境变量，也不会因为调用 `Sandbox.create()` 就自动写入
Sandbox 文件系统。

## 4. 阶段 C：Sandbox 创建后的 bootstrap

Sandbox 创建成功后，Cloud APP 先保存：

```text
sandboxId
instanceId
traceId
```

此时状态为 `allocated`。用户确认 `SOUL.md` 后，Controller 才调用：

```js
saga.bootstrapSandbox({
  sandboxId,
  instanceId,
  traceId,
  soul,
  buildConfig,
});
```

Bootstrap 阶段执行：

```text
生成 bootstrapToken
        ↓
在 Cloud APP 的 Channel 服务中登记该 Token
        ↓
构建完整 OpenClaw 配置
        ↓
写入 openclaw.json
        ↓
写入 SOUL.md
        ↓
等待 OpenClaw Gateway ready
        ↓
等待 OnyxClaw Channel 回连
```

## 5. 模型 Provider 的设置方式

### 5.1 基础模型配置

模型结构来自 Cloud APP 环境变量：

```text
ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON
```

它的内容是一整段 OpenClaw JSON，而不是文件路径。示例见：

```text
deploy/cloud-app/examples/openclaw-base-config.example.json
```

示例模型配置：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cloud-model/example-chat"
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cloud-model": {
        "baseUrl": "https://model-api.example.com/v1",
        "apiKey": "__ONYXCLAW_MODEL_API_KEY__",
        "api": "openai-completions",
        "models": [
          {
            "id": "example-chat",
            "name": "Example Chat Model"
          }
        ]
      }
    }
  }
}
```

主要字段：

| 字段 | 含义 | 设置时间 |
| --- | --- | --- |
| `models.providers.cloud-model` | OpenClaw 内部 Provider 名称 | Cloud APP 启动前 |
| `baseUrl` | 模型 API 地址 | Cloud APP 启动前 |
| `api` | 模型 API 协议 | Cloud APP 启动前 |
| `models[].id` | 模型 ID | Cloud APP 启动前 |
| `agents.defaults.model.primary` | 默认 `provider/model` | Cloud APP 启动前 |
| `apiKey` 占位符 | 标记运行时注入位置 | Cloud APP 启动前 |
| 真实模型 API Key | 替换占位符 | Sandbox 创建后 |

`agents.defaults.model.primary` 必须引用已声明的 Provider 和 Model ID：

```text
models.providers 的键 / models[].id
```

例如：

```text
cloud-model/example-chat
```

### 5.2 模型 Key 的运行时注入

Provider Profile 只保存模型 Key 的环境变量名称：

```json
{
  "model": {
    "provider": "openai-compatible",
    "model": "replace-with-cloud-test-model",
    "apiKeyEnv": "HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY"
  }
}
```

`ProviderRegistry` 读取该环境变量的真实值，得到：

```js
secrets.modelApiKey
```

`buildOpenClawConfig()` 递归查找基础配置中的：

```text
__ONYXCLAW_MODEL_API_KEY__
```

并替换为真实模型 API Key。如果基础配置中没有该占位符，构建会失败。

### 5.3 Provider Profile 的 model 字段不会自动生成模型配置

当前实现不会根据：

```json
{
  "model": {
    "provider": "...",
    "model": "..."
  }
}
```

自动生成 `models.providers` 或修改 `agents.defaults.model.primary`。

因此当前真正控制 OpenClaw 模型行为的是：

```text
ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON
```

Provider Profile 的 `model.apiKeyEnv` 负责定位 Secret；`model.provider` 和
`model.model` 当前主要用于运行信息展示。

## 6. Channel 的设置方式

Channel 配置由静态配置和动态状态共同生成。

### 6.1 静态 Channel URL

Provider Profile 中声明：

```json
{
  "channel": {
    "publicUrl": "ws://onyxclaw-app.default.svc.cluster.local:18890",
    "connectTimeoutMs": 120000,
    "signingSecretEnv": "HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET"
  }
}
```

`channel.publicUrl` 会作为 `platformUrl` 写进 OpenClaw 配置。连接方向是：

```text
Sandbox 中的 OnyxClaw Channel
             ↓ WebSocket
Cloud APP 的 Channel 服务
```

因此，该 URL 必须能从 Sandbox 所在网络访问。

### 6.2 动态 instanceId

`instanceId` 在创建 Sandbox 前由 Cloud APP 生成，并同时用于：

- Sandbox metadata；
- OpenClaw Channel 配置；
- Cloud APP 中的连接归属校验。

### 6.3 动态 bootstrapToken

`bootstrapToken` 在 Sandbox 创建后的 bootstrap 阶段生成。

Cloud APP 先登记 Token：

```js
await channel.issueBootstrapToken(instanceId, bootstrapToken);
```

然后把同一个 Token 写入 OpenClaw Channel 配置。它用于 Channel 第一次连接 Cloud APP 时
注册身份，成功注册后再由 Channel 会话机制维护后续连接。

### 6.4 自动启用 OnyxClaw Plugin

`buildOpenClawConfig()` 自动追加：

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

并生成：

```json
{
  "channels": {
    "onyxclaw": {
      "enabled": true,
      "platformUrl": "<provider.channel.publicUrl>",
      "instanceId": "<运行时生成>",
      "bootstrapToken": "<运行时生成>"
    }
  }
}
```

Plugin 文件本身必须提前存在于 Template 镜像中的：

```text
/opt/onyxclaw/channel
```

Cloud APP 当前只启用 Plugin，不会在 bootstrap 阶段上传或安装 Plugin。

### 6.5 signing secret 的当前状态

Provider Profile 可以通过 `channel.signingSecretEnv` 声明 Channel signing secret，Registry
也会读取该 Secret。

但当前 `buildOpenClawConfig()` 没有使用 `channelSigningSecret`，Channel 首次注册实际使用
的是一次性 `bootstrapToken`。因此 signing secret 目前尚未进入实际 Channel 握手流程。

## 7. 最终生成的 OpenClaw 配置

模型 Key 替换并追加 Channel 后，配置大致如下：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cloud-model/example-chat"
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cloud-model": {
        "baseUrl": "https://model-api.example.com/v1",
        "apiKey": "<运行时注入的模型 API Key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "example-chat",
            "name": "Example Chat Model"
          }
        ]
      }
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "<Gateway Token>"
    }
  },
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
  },
  "channels": {
    "onyxclaw": {
      "enabled": true,
      "platformUrl": "<Sandbox 可访问的 Cloud APP Channel URL>",
      "instanceId": "<运行时生成>",
      "bootstrapToken": "<运行时生成>"
    }
  }
}
```

完整示例见：

```text
deploy/cloud-app/examples/bootstrap-config.example.json
```

## 8. 最终写入 Sandbox 的文件

Cloud APP 使用 E2B Files API 写入：

```text
/home/node/.openclaw/bootstrap/openclaw.json
/home/node/.openclaw/bootstrap/SOUL.md
```

其中：

- `openclaw.json` 包含基础模型配置、真实模型 Key、Plugin 配置和动态 Channel 配置；
- `SOUL.md` 包含用户在 Cloud APP 页面确认的人格内容。

调用链是：

```text
OpenClawBootstrapSaga
       ↓
adapter.writeFile()
       ↓
Python Bridge
       ↓
session.files.write()
       ↓
Sandbox 文件系统
```

## 9. Template 与 Cloud APP 的职责

当前 Cloud APP 写入的是 bootstrap 暂存目录，而不是 OpenClaw 默认配置和 workspace 的
最终位置：

```text
Cloud APP 写入：
/home/node/.openclaw/bootstrap/openclaw.json
/home/node/.openclaw/bootstrap/SOUL.md

OpenClaw 最终通常需要：
/home/node/.openclaw/openclaw.json
/home/node/.openclaw/workspace/SOUL.md
```

当前 Cloud APP 写完文件后不会执行 OpenClaw 启动命令，只会轮询：

```text
http://127.0.0.1:18789/readyz
```

因此当前设计隐含要求 Template 内存在 bootstrap 机制：

```text
等待两个 bootstrap 文件
        ↓
将 openclaw.json 安装到实际配置路径
        ↓
将 SOUL.md 安装到 workspace
        ↓
启动 OpenClaw Gateway
        ↓
OnyxClaw Channel 读取配置并连接 Cloud APP
```

职责边界如下：

| Template 负责 | Cloud APP 负责 |
| --- | --- |
| 提供镜像、资源与网络 | 选择 Template 并创建 Sandbox |
| 预装 OpenClaw | 生成本次 OpenClaw 配置 |
| 预装 OnyxClaw Plugin | 注入模型 API Key |
| 提供真实用户和目录 | 生成 instanceId 和 bootstrapToken |
| 安装 bootstrap 文件 | 写入 openclaw.json 和 SOUL.md |
| 启动 OpenClaw Gateway | 等待 Gateway ready |
| 保持 OpenClaw 进程运行 | 等待 Channel 回连 |

## 10. 配置归属汇总

| 配置项 | Template | `Sandbox.create()` | Sandbox 创建后 |
| --- | :---: | :---: | :---: |
| 基础镜像 | 是 | 通过 templateId 间接选择 | 否 |
| CPU/内存 | 是 | 当前不覆盖 | 否 |
| 启动命令 | 是 | 当前不覆盖 | 否 |
| 网络与权限 | 是 | 当前不覆盖 | 否 |
| OpenClaw 程序 | 是 | 否 | 否 |
| OnyxClaw Plugin 文件 | 是 | 否 | 只启用 |
| Template ID | 平台生成 | 是 | 否 |
| Sandbox timeout | 提供方可有默认值 | 是 | 否 |
| secure | 否 | 是 | 否 |
| instanceId | 否 | 写入 metadata | 写入 Channel 配置 |
| traceId | 否 | 写入 metadata | 用于 bootstrap 追踪 |
| Sandbox envs | 可有默认值 | 当前未传 | 否 |
| 模型 Provider/Base URL/Model ID | 否 | 否 | 从基础配置生成 |
| 模型 API Key | 否 | 否 | 替换占位符 |
| Channel platformUrl | 否 | 否 | 从 Provider Profile 追加 |
| Channel bootstrapToken | 否 | 否 | 动态生成并追加 |
| SOUL.md | 否 | 否 | 用户确认后写入 |
| OpenClaw Gateway ready 检查 | 否 | 否 | Cloud APP 轮询 |

## 11. 最终时序

```text
预先创建 Template
  ├── 镜像与资源
  ├── 网络与权限
  ├── OpenClaw
  └── OnyxClaw Plugin
          │
          ▼
Cloud APP 启动
  ├── 读取 Provider Profile
  ├── 读取 ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON
  └── 读取 E2B/模型/Channel Secret
          │
          ▼
Sandbox.create()
  ├── templateId
  ├── timeout
  ├── secure
  └── metadata(instanceId, traceId)
          │
          ▼
Sandbox 创建成功
          │
          ▼
用户确认 SOUL.md
          │
          ▼
运行时构建 OpenClaw 配置
  ├── 保留基础模型 Provider
  ├── 注入模型 API Key
  ├── 启用 OnyxClaw Plugin
  ├── 追加 platformUrl
  ├── 追加 instanceId
  └── 追加 bootstrapToken
          │
          ▼
E2B Files.write()
  ├── bootstrap/openclaw.json
  └── bootstrap/SOUL.md
          │
          ▼
Template bootstrap 机制安装配置并启动 OpenClaw
          │
          ▼
Cloud APP 等待 Gateway ready 和 Channel 回连
```

## 12. 源码导航

- `packages/cloud-runtime/src/cloud-app.js`
- `packages/cloud-runtime/src/cloud-app-support.js`
- `packages/cloud-runtime/src/cloud-controller.js`
- `packages/cloud-runtime/src/openclaw-bootstrap.js`
- `packages/cloud-runtime/src/e2b-compatible-adapter.js`
- `packages/cloud-runtime/src/e2b-bridge.py`
- `packages/onyxclaw-channel/src/channel.js`
- `packages/onyxclaw-channel/openclaw.plugin.json`
- `deploy/cloud-app/examples/openclaw-base-config.example.json`
- `deploy/cloud-app/examples/bootstrap-config.example.json`
