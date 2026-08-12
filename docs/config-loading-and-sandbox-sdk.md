# OnyxClaw 配置读取与 Sandbox SDK 调用链

本文解释 OnyxClaw Cloud APP 如何读取 Provider 配置与环境变量，以及这些配置如何沿着
Node.js、Python Bridge 和 E2B Python SDK 转换为 Sandbox 操作。

本文聚焦当前代码的运行机制，不讨论具体云厂商的适配方案，也不说明 OpenClaw 的启动与
Channel 回连流程。

> 代码基线：`feat/huaweicloud-agentsphere-adaptation@561c0ed`。后续代码变化可能导致
> 文件名或字段发生调整。

## 1. 总体调用链

Cloud APP 没有在 Node.js 中直接调用 E2B HTTP API，而是通过一个长期运行的 Python
子进程使用 E2B Python SDK：

```text
Provider JSON ───────┐
                     ├─> ProviderRegistry
进程环境变量/Secret ─┘        │
                              ▼
                    E2BCompatibleAdapter
                              │
                              ▼
                    python-e2b-client.js
                    JSON Lines over stdio
                              │
                              ▼
                       e2b-bridge.py
                              │
                              ▼
                       E2B Python SDK
                              │
                              ▼
                    Sandbox 管理面与 envd
```

各层职责如下：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 应用装配 | `packages/cloud-runtime/src/cloud-app.js` | 选择配置文件、创建 Registry、Adapter 和 Python Client |
| 配置管理 | `packages/cloud-config/src/provider-registry.js` | 读取 JSON、校验字段、选择 Provider、读取 Secret |
| 统一接口 | `packages/cloud-runtime/src/e2b-compatible-adapter.js` | 提供 create/connect/command/files/kill 接口，映射配置并处理观测与错误 |
| Node Bridge Client | `packages/cloud-runtime/src/python-e2b-client.js` | 启动 Python 子进程，通过 stdin/stdout 传递 JSON Lines |
| Python Bridge | `packages/cloud-runtime/src/e2b-bridge.py` | 把 JSON 操作映射为 E2B Python SDK 方法 |

## 2. 三类数据

理解配置时，首先要区分三类数据。

### 2.1 Provider Profile

Provider Profile 是一个 JSON 文件，保存可提交、可评审的非敏感配置，例如：

- Provider ID 和展示名称；
- E2B API Base URL；
- API 兼容版本；
- API Key 所在的环境变量名称；
- Sandbox Template ID、超时和默认用户；
- OpenClaw、模型和 Channel 的非敏感描述；
- Provider 能力声明。

通用示例位于：

```text
config/providers.example.json
```

示例结构：

```json
{
  "schemaVersion": 1,
  "defaultProvider": "vendor-a",
  "providers": {
    "vendor-a": {
      "displayName": "Vendor A E2B Compatible",
      "protocol": "e2b-compatible",
      "api": {
        "baseUrl": "https://sandbox-api.vendor-a.example",
        "apiKeyEnv": "VENDOR_A_E2B_API_KEY",
        "compatibilityVersion": "e2b-v2",
        "requestTimeoutMs": 30000
      },
      "sandbox": {
        "templateId": "openclaw-template-id",
        "timeoutMs": 600000,
        "onTimeout": "pause",
        "secure": true,
        "defaultUser": "user",
        "homeDir": "/home/user",
        "workspaceDir": "/home/user/.openclaw/workspace"
      }
    }
  }
}
```

其中 `api.apiKeyEnv` 保存的是环境变量名称，不是 API Key 本身。

### 2.2 进程环境变量与 Secret

真实凭据通过进程环境传入，不应写入 Provider JSON：

```text
VENDOR_A_E2B_API_KEY=<真实 API Key>
VENDOR_A_MODEL_API_KEY=<真实模型 Key>
VENDOR_A_CHANNEL_SIGNING_SECRET=<真实 Channel Secret>
```

本地运行时可以由 shell 或 Node 的 `--env-file` 参数注入。当前项目本身没有加载
`dotenv`，所以仅创建 `.env` 文件不会自动生效。

例如：

```bash
node --env-file=.env packages/cloud-runtime/src/cloud-app.js
```

在 Kubernetes 中，通常使用 `Secret` 和 `secretKeyRef` 注入：

```yaml
env:
  - name: VENDOR_A_E2B_API_KEY
    valueFrom:
      secretKeyRef:
        name: onyxclaw-app-secrets
        key: e2b-api-key
```

### 2.3 运行时状态

以下数据由每次运行动态产生，不属于静态 Provider 配置：

- Sandbox ID；
- SDK 返回的 envd 或 traffic access token；
- Node/Python Bridge 请求 ID；
- Sandbox Session；
- 命令执行结果和临时文件状态。

当前实现主要将这些状态保存在 Node.js 和 Python 进程内存中，不会写回 Provider JSON。

## 3. Cloud APP 如何选择配置

入口文件 `cloud-app.js` 首先计算 Provider 配置路径：

```js
const providerConfigPath = process.env.ONYXCLAW_PROVIDER_CONFIG ??
  path.join(repositoryRoot, "config/providers.agentsphere.example.json");
```

选择规则是：

1. 若设置 `ONYXCLAW_PROVIDER_CONFIG`，读取该路径；
2. 否则读取代码中的默认示例文件。

因此，部署环境通常应显式设置：

```text
ONYXCLAW_PROVIDER_CONFIG=/app/runtime-config/providers.json
```

接着，应用加载 Registry：

```js
const registry = await loadProviderRegistry({ configPath: providerConfigPath });
```

配置文件可以包含多个 Provider。实际选中的 Provider 按以下优先级确定：

```text
ONYXCLAW_PROVIDER 环境变量
        ↓ 未设置时
Provider JSON 的 defaultProvider
```

对应代码逻辑为：

```js
const selectedProvider = env.ONYXCLAW_PROVIDER || config.defaultProvider;
```

`ONYXCLAW_PROVIDER` 只能选择 JSON 中已经存在的 Provider，不能从浏览器动态传入任意
API URL 或密钥变量名。

## 4. ProviderRegistry 做了什么

`loadProviderRegistry()` 的工作可分为四步。

### 4.1 读取和解析 JSON

```js
config = JSON.parse(await readFile(configPath, "utf8"));
```

文件不存在或 JSON 格式错误时，Cloud APP 会在调用云 API 前直接失败。

### 4.2 校验配置

Registry 会校验：

- `schemaVersion` 是否为 `1`；
- Provider ID 是否只包含小写字母、数字和连字符；
- `protocol` 是否为 `e2b-compatible`；
- API URL 和 Channel URL 是否符合安全规则；
- Template ID、默认用户、OpenClaw binary 等必填字符串；
- HOME 和 workspace 是否为绝对路径；
- timeout 和 Gateway port 是否为正整数；
- cleanup、timeout、安装方式和 capability 是否为允许值；
- 选中的 Provider 是否真实存在。

校验的目的，是在创建 Sandbox 前尽早暴露配置错误。

### 4.3 获取非敏感 Provider 配置

```js
const providerId = registry.defaultProviderId;
const provider = registry.getProvider(providerId);
```

`provider` 对象包含 API URL、Template ID、超时、默认用户等配置。

### 4.4 根据映射读取 Secret

```js
const secrets = registry.getSecrets(providerId);
```

`getSecrets()` 读取 Profile 中声明的环境变量名，例如：

```json
{
  "apiKeyEnv": "VENDOR_A_E2B_API_KEY"
}
```

再从进程环境读取实际值：

```js
process.env.VENDOR_A_E2B_API_KEY
```

返回的内部对象类似：

```js
{
  apiKey: "<真实值>",
  modelApiKey: "<真实值>",
  channelSigningSecret: "<真实值>"
}
```

如果任何被引用的环境变量为空，Registry 会一次列出所有缺失项并终止启动。

## 5. 配置如何进入 Sandbox Client

Cloud APP 使用 Registry 创建统一 Adapter：

```js
const adapter = createE2BCompatibleAdapter({
  registry,
  providerId,
  clientFactory: createPythonE2BClientFactory(),
  operationMonitor,
});
```

Adapter 构造时将 Provider 配置和 Secret 映射为 Python Client 参数：

```js
this.#client = clientFactory({
  apiKey: secrets.apiKey,
  baseUrl: provider.api.baseUrl,
  requestTimeoutMs: provider.api.requestTimeoutMs,
});
```

这一层之后，上层业务只使用统一方法，不直接读取 Provider JSON：

```text
createSandbox
connectSandbox
runCommand
writeFile
readFile
killSandbox
```

## 6. Node.js 如何启动 Python Bridge

`createPythonE2BClientFactory()` 默认使用：

```text
python3 packages/cloud-runtime/src/e2b-bridge.py
```

可通过以下环境变量替换 Python 解释器：

```text
ONYXCLAW_E2B_PYTHON=/opt/venv/bin/python
```

创建子进程时，Node.js 将配置转换为 Python 进程环境：

```js
env: {
  ...process.env,
  E2B_API_KEY: apiKey,
  E2B_BASE_URL: baseUrl,
}
```

因此有两组不同层级的环境变量：

| 环境变量 | 读取方 | 作用 |
| --- | --- | --- |
| `ONYXCLAW_PROVIDER_CONFIG` | Cloud APP | 指定 Provider JSON 路径 |
| `ONYXCLAW_PROVIDER` | ProviderRegistry | 选择 Provider |
| Profile 的 `apiKeyEnv` 指向的变量 | ProviderRegistry | 提供真实 API Key |
| `ONYXCLAW_E2B_PYTHON` | Python Client Factory | 指定 Python 可执行文件 |
| `E2B_API_KEY` | Python Bridge | 接收 Node 映射后的 API Key |
| `E2B_BASE_URL` | Python Bridge | 接收 Node 映射后的 API Base URL |

`E2B_API_KEY` 和 `E2B_BASE_URL` 通常不需要由部署者再次手工配置；它们由 Node 层根据
Provider Profile 自动传给 Python 子进程。

## 7. Node 与 Python 的通信协议

Node 和 Python 使用标准输入、标准输出上的 JSON Lines。每行都是一条完整 JSON 消息。

Node 发出的请求包含：

```json
{
  "id": "唯一请求 ID",
  "op": "create",
  "params": {
    "template": "template-id",
    "timeoutSeconds": 600,
    "secure": true
  }
}
```

Python 成功时返回：

```json
{
  "id": "唯一请求 ID",
  "result": {
    "sandboxId": "sandbox-id"
  }
}
```

失败时返回：

```json
{
  "id": "唯一请求 ID",
  "error": {
    "code": "E2B_BRIDGE_OPERATION_FAILED",
    "message": "脱敏后的错误信息",
    "type": "异常类型",
    "statusCode": 500,
    "requestId": "服务端请求 ID"
  }
}
```

Node 使用 `id` 将异步响应匹配到原始 Promise，并用 `requestTimeoutMs` 控制每个 Bridge
请求的超时。

## 8. Python Bridge 如何初始化 E2B SDK

Python Bridge 首先解析 `E2B_BASE_URL`：

```python
base_url = urlparse(os.environ["E2B_BASE_URL"])
os.environ["E2B_DOMAIN"] = base_url.netloc
```

然后导入基础 E2B SDK：

```python
from e2b import Sandbox
```

API Key 从 Node 注入的环境变量读取：

```python
api_key = os.environ["E2B_API_KEY"]
```

Bridge 是一个长期运行进程，通过 `sessions` 字典缓存 SDK Session：

```python
sessions = {}
```

这样，对同一个 Sandbox 的后续命令和文件操作可以复用已有连接。

## 9. Sandbox 操作的逐层映射

### 9.1 创建 Sandbox

业务层调用：

```js
await adapter.createSandbox({ metadata, envs });
```

Adapter 从 Provider 读取 Template 和 timeout：

```js
await client.create({
  template: provider.sandbox.templateId,
  timeoutSeconds: Math.ceil(provider.sandbox.timeoutMs / 1000),
  secure: provider.sandbox.secure,
  metadata,
  envs,
});
```

Python 最终执行：

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

创建成功后，Python 缓存 SDK Session，Node Adapter 缓存对应的 Client Session，并向业务
层只返回：

```js
{
  sandboxId: "...",
  status: "running"
}
```

SDK 返回的内部访问凭据不会暴露给浏览器。

### 9.2 连接已有 Sandbox

业务层调用：

```js
await adapter.connectSandbox(sandboxId);
```

Python 执行：

```python
claimed = Sandbox.connect(sandbox_id, api_key=api_key)
```

若 Adapter 收到一个尚未在本进程缓存的 Sandbox ID，执行命令或文件操作前也会自动调用
`connectSandbox()`。

### 9.3 执行命令

业务层调用：

```js
const result = await adapter.runCommand(
  sandboxId,
  "python3 -c 'print(6 * 7)'",
);
```

Adapter 自动加入 Provider 配置的默认用户：

```js
session.runCommand(command, {
  user: provider.sandbox.defaultUser,
});
```

Python 执行：

```python
result = session.commands.run(command, user=user)
```

返回值被统一为：

```js
{
  exitCode: 0,
  stdout: "42\n",
  stderr: ""
}
```

### 9.4 写文件

业务层调用：

```js
await adapter.writeFile(sandboxId, "/tmp/example.txt", "hello");
```

Python 执行：

```python
session.files.write(path, content, user=user)
```

字符串使用 UTF-8 传输；Node Buffer 会先编码为 Base64，Python Bridge 再解码为二进制。
Adapter 要求文件路径必须是绝对路径。

### 9.5 读文件

业务层调用：

```js
const content = await adapter.readFile(sandboxId, "/tmp/example.txt");
```

Python 执行：

```python
content = session.files.read(path, user=user)
```

文件内容会通过 JSON Lines 返回 Node。观测日志只记录文件路径和状态，不记录文件正文。

### 9.6 销毁 Sandbox

业务层调用：

```js
await adapter.killSandbox(sandboxId);
```

Python 执行：

```python
claimed.kill()
sessions.pop(sandbox_id, None)
```

Node Adapter 同时删除本地 Session 缓存。业务层得到：

```js
{
  sandboxId: "...",
  status: "killed"
}
```

## 10. 一次完整操作的时序

下面以“创建 Sandbox 并执行命令”为例：

```text
Cloud APP
  │
  │ 1. 读取 ONYXCLAW_PROVIDER_CONFIG
  ▼
ProviderRegistry
  │ 2. 解析并校验 Provider JSON
  │ 3. 根据 apiKeyEnv 读取真实 API Key
  ▼
E2BCompatibleAdapter
  │ 4. 读取 templateId、timeoutMs、secure、defaultUser
  ▼
PythonE2BClient
  │ 5. 启动 e2b-bridge.py
  │ 6. 注入 E2B_API_KEY 和 E2B_BASE_URL
  │ 7. 发送 {op: "create", params: ...}
  ▼
e2b-bridge.py
  │ 8. Sandbox.create(...)
  ▼
E2B 服务
  │ 9. 返回 Sandbox Session 和 sandbox_id
  ▼
Node Adapter
  │ 10. 缓存 Session，只向业务层返回 sandboxId
  │
  │ 11. runCommand(sandboxId, command)
  ▼
Python Bridge
  │ 12. session.commands.run(command, user=defaultUser)
  ▼
Sandbox envd
  │ 13. 返回 exitCode/stdout/stderr
  ▼
Cloud APP
```

## 11. 错误处理和 Secret 脱敏

Adapter 和 Python Client 都会尝试从错误信息中移除：

- E2B API Key；
- access token 和 auth token；
- password；
- 名称中包含 `secret` 的常见参数。

Adapter 会把底层错误包装为 `CloudRuntimeError`，并保留以下可诊断字段：

```text
stage
providerId
code
statusCode
requestId
```

其中 `stage` 可取：

```text
create
connect
command
file-write
file-read
kill
```

Python Bridge 的 stderr 会进入 Cloud APP 日志，但会先进行 API Key 脱敏。命令观测也会
过滤常见的 token、password 和 secret 参数。

需要注意：自动脱敏只能降低误泄露风险，不能替代“不在命令、文件内容和普通日志中放置
Secret”的设计原则。

## 12. 生命周期与进程边界

当前实现具有以下运行特征：

- 每个 Cloud APP 进程创建一个长期运行的 Python Bridge；
- Node 和 Python 各自维护一份 Sandbox Session 缓存；
- Cloud APP 重启后内存 Session 会丢失，但可用 Sandbox ID 再次执行 `connect`；
- `adapter.close()` 只终止 Python Bridge，不等同于销毁所有远端 Sandbox；
- 远端 Sandbox 应通过业务流程显式执行 `killSandbox()`；
- `requestTimeoutMs` 是单次 Bridge 请求超时；
- `sandbox.timeoutMs` 会换算为秒后传给 `Sandbox.create()`，表示 Sandbox 生命周期超时。

因此，“关闭 Cloud APP 进程”和“清理远端 Sandbox”是两个不同动作。

## 13. 最小使用示意

下面只展示 Adapter 层的概念用法。实际 Cloud APP 由 Controller 调用 Adapter：

```js
const created = await adapter.createSandbox({
  metadata: { purpose: "smoke-test" },
});

try {
  const command = await adapter.runCommand(
    created.sandboxId,
    "python3 -c 'print(6 * 7)'",
  );
  console.log(command.stdout);

  await adapter.writeFile(
    created.sandboxId,
    "/tmp/onyxclaw-smoke.txt",
    "hello sandbox",
  );

  const content = await adapter.readFile(
    created.sandboxId,
    "/tmp/onyxclaw-smoke.txt",
  );
  console.log(content);
} finally {
  await adapter.killSandbox(created.sandboxId);
  adapter.close();
}
```

这条最小链路验证的是：

```text
配置读取
→ Secret 解析
→ SDK 鉴权
→ Template 创建
→ Sandbox 命令执行
→ Sandbox 文件读写
→ Sandbox 销毁
```

## 14. 关键结论

1. Provider JSON 保存连接方式和运行参数，但不保存真实 Secret。
2. Profile 中的 `apiKeyEnv` 是环境变量名称，Registry 再用它读取真实 API Key。
3. `.env` 只是示例载体，当前 Cloud APP 不会自动读取它。
4. Node.js 不直接调用 E2B SDK，而是通过 JSON Lines 驱动 Python Bridge。
5. Adapter 将 Provider 配置转换为 `Sandbox.create/connect`、命令、文件和销毁操作。
6. Sandbox ID 和 SDK Session 属于运行时状态，不会写回配置文件。
7. 终止 Python Bridge 不会自动保证远端 Sandbox 被销毁，业务流程必须显式清理。

## 15. 源码导航

- `packages/cloud-runtime/src/cloud-app.js`
- `packages/cloud-config/src/provider-registry.js`
- `packages/cloud-runtime/src/e2b-compatible-adapter.js`
- `packages/cloud-runtime/src/python-e2b-client.js`
- `packages/cloud-runtime/src/e2b-bridge.py`
- `config/providers.example.json`
- `.env.example`
