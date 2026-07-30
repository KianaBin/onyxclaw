# 阿里云 ACS OpenClaw bootstrap_config 说明

本文说明 OpenClaw 在阿里云 ACS Sandbox 中启动时，配置从哪里取得、如何生成，以及
`bootstrap_config` 与最终 `openclaw.json` 的关系。

配套样例：

- [基础配置输入样例](../deploy/alicloud-app/examples/openclaw-base-config.example.json)；
- [bootstrap_config 成品样例](../deploy/alicloud-app/examples/bootstrap-config.example.json)。

样例中的域名、模型、API Key、Gateway token、instance ID 和 bootstrap token 全部是
不可用于生产的示例值。

## 1. 关键结论

`bootstrap_config` 不是由 OpenClaw 镜像或 ACS 自动下载的配置，也不是 Kubernetes
Secret 直接挂载到 Sandbox 的文件。它由 OnyxClaw APP/BFF 在运行时生成，并通过 E2B
Files API 写入已领取的 Sandbox。

```text
openclaw-base-config.json
  → Kubernetes Secret/APP 环境变量
  → APP 替换模型密钥并补充 Channel 动态字段
  → E2B Files.write
  → /home/node/.openclaw/bootstrap/openclaw.json
  → 镜像 entrypoint 复制
  → /home/node/.openclaw/openclaw.json
  → OpenClaw Gateway 启动
```

入口脚本里的 shell 变量：

```bash
bootstrap_config="${ONYXCLAW_BOOTSTRAP_DIR}/openclaw.json"
```

只是指向 bootstrap 文件的路径，默认值为
`/home/node/.openclaw/bootstrap/openclaw.json`，并不保存 JSON 内容。

## 2. 两类配置文件

### 2.1 基础配置输入

部署者先复制
[`openclaw-base-config.example.json`](../deploy/alicloud-app/examples/openclaw-base-config.example.json)
并完成以下修改：

1. 把示例模型 Provider、`baseUrl`、模型 ID 和名称替换为实际值；
2. 保留模型密钥占位符 `__ONYXCLAW_MODEL_API_KEY__`；
3. 为 `gateway.auth.token` 生成独立的强随机值；
4. 不要把修改后的真实文件提交到 Git。

基础配置至少需要包含一个 `__ONYXCLAW_MODEL_API_KEY__`。APP 如果找不到该占位符，会
拒绝生成配置，防止误把无模型凭据的 Sandbox 标记为就绪。

然后将文件作为 Secret 的 `openclaw-base-config-json` 项创建：

```bash
kubectl --kubeconfig iac/alicloud-acs/generated/kubeconfig \
  create secret generic onyxclaw-app-secrets \
  --from-literal=e2b-api-key='<MANAGER_RUNTIME_KEY>' \
  --from-literal=model-api-key='<MODEL_API_KEY>' \
  --from-literal=channel-signing-secret='<RANDOM_SECRET>' \
  --from-file=openclaw-base-config-json='./openclaw-base-config.json'
```

`onyxclaw-app` Deployment 将该 Secret 项注入
`ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON`。APP 启动时执行 `JSON.parse()`；变量缺失或 JSON
无效都会导致 APP 启动失败，不存在镜像内默认配置兜底。

### 2.2 运行时 bootstrap_config

[`bootstrap-config.example.json`](../deploy/alicloud-app/examples/bootstrap-config.example.json)
展示 APP/BFF 合并完成后的结构，仅用于理解和排查，不应作为真实密钥文件直接部署。
在仓库宿主机上直接执行 OpenClaw 配置校验时，它会提示
`/opt/onyxclaw/channel` 不存在；该目录由派生镜像构建，因此运行时样例应在最终镜像内
校验。基础配置输入样例可以直接在仓库环境通过 OpenClaw 2026.5.28 schema 校验。

与基础配置相比，运行时配置发生以下变化：

| 字段 | 生成方式 |
| --- | --- |
| `models.providers.*.apiKey` | 用 Secret 中的模型 API Key 替换占位符 |
| `plugins.load.paths` | 确保包含 `/opt/onyxclaw/channel` |
| `plugins.entries.onyxclaw.enabled` | 强制设置为 `true` |
| `channels.onyxclaw.enabled` | 强制设置为 `true` |
| `channels.onyxclaw.platformUrl` | 来自 ACS Provider 的集群内 Channel 地址 |
| `channels.onyxclaw.instanceId` | APP 为当前 OpenClaw 实例生成的 ID |
| `channels.onyxclaw.bootstrapToken` | 当前实例的一次性 Channel 注册 token |

基础配置对象不会被原地修改。APP 为每个 Sandbox 生成独立的运行时对象，序列化后写入
bootstrap 目录。

## 3. 生成和写入时机

新用户创建流程分成两个阶段：

1. “创建云端 Sandbox”只从 ACS `SandboxSet/onyxclaw` 领取一个预热实例；
2. 用户确认 `SOUL.md` 后，Controller 才调用 `bootstrapSandbox()`。

Bootstrap Saga 随后执行：

1. 为当前 `instanceId` 登记一次性 Channel bootstrap token；
2. 调用 `buildOpenClawConfig()` 合成完整配置；
3. 使用 E2B `Files.write` 以 `node` 用户写入：
   - `/home/node/.openclaw/bootstrap/openclaw.json`；
   - `/home/node/.openclaw/bootstrap/SOUL.md`；
4. 等待 Gateway `/readyz`；
5. 等待 OnyxClaw Channel WebSocket 注册；
6. 两项都成功后才把 Sandbox 标记为 `READY`。

如果生成、写入或就绪检查失败，Saga 会撤销 bootstrap token 并 kill Sandbox，避免半
初始化实例继续占用 ACS 资源。

## 4. 镜像入口如何消费配置

派生镜像入口会先创建 bootstrap、workspace 和配置目录，然后轮询两个 bootstrap 文件：

```bash
while [[ ! -s "${bootstrap_config}" || ! -s "${bootstrap_soul}" ]]; do
  sleep 1
done
```

两个文件都非空后，入口执行：

```bash
cp "${bootstrap_config}" "${OPENCLAW_CONFIG_PATH}"
cp "${bootstrap_soul}" "${OPENCLAW_WORKSPACE_DIR}/SOUL.md"
chmod 0600 "${OPENCLAW_CONFIG_PATH}" "${OPENCLAW_WORKSPACE_DIR}/SOUL.md"
chown node:node "${OPENCLAW_CONFIG_PATH}" "${OPENCLAW_WORKSPACE_DIR}/SOUL.md"
```

最终路径为：

```text
/home/node/.openclaw/openclaw.json
```

随后入口降权为 `node`，运行：

```bash
node /app/openclaw.mjs gateway --bind lan --port 18789
```

## 5. 配置名称对照

| 名称 | 所在位置 | 是否包含动态密钥 | 消费者 |
| --- | --- | --- | --- |
| `openclaw-base-config.json` | 部署者受控环境 | Gateway token；模型 Key 仍为占位符 | APP 部署流程 |
| `ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON` | APP 容器环境变量 | 同上 | `cloud-app.js` |
| `bootstrap/openclaw.json` | Sandbox 临时文件系统 | 是 | 镜像 entrypoint |
| `bootstrap_config` | entrypoint shell 变量 | 否，只是路径 | entrypoint |
| `.openclaw/openclaw.json` | Sandbox 临时文件系统 | 是 | OpenClaw Gateway |

## 6. 安全注意事项

- 不要在基础镜像、Git、Terraform 变量或普通日志中保存真实配置和密钥；
- 不要直接使用样例中的任何 token 或 API Key 文本；
- 模型 API Key 会在单次 bootstrap 时进入 Sandbox 配置文件，文件权限为 `0600`；
- `bootstrapToken` 是每个 OpenClaw 实例独立的一次性注册凭据；
- Gateway token 应独立生成，不能与模型、E2B 或 Channel 密钥复用；
- APP/BFF 不会把完整配置或 Secret 返回给浏览器；
- Sandbox 结束后应执行 `kill`，依靠其临时文件系统一并回收配置。

## 7. 对应实现

- `deploy/alicloud-app/app.yaml.tmpl`
- `packages/cloud-runtime/src/cloud-app.js`
- `packages/cloud-runtime/src/cloud-app-support.js`
- `packages/cloud-runtime/src/cloud-controller.js`
- `packages/cloud-runtime/src/openclaw-bootstrap.js`
- `packages/cloud-runtime/src/alibaba-acs-adapter.js`
- `iac/alicloud-acs/image/entrypoint.sh`
