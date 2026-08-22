# OnyxClaw 模拟 APP 在华为云 CCE 的部署记录

本文记录 OnyxClaw `app-v0.3.8` 模拟 APP 在华为云 `cn-south-1` 的部署方式、当前状态，以及后续接入 Sandbox 前必须补齐的配置。本文不保存 kubeconfig、登录密码、API Key 或签名密钥。

## 部署范围

- 华为云账号 Domain ID：`4a4f617393c949fe8d555697ef47e47d`
- Region：`cn-south-1`
- CCE 集群：`testdemo`
- Kubernetes：`v1.33.12`
- 节点架构：`linux/amd64`
- Namespace：`onyxclaw-demo`
- APP 镜像：`swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-app:0.3.8-sfs-lifecycle`
- 已核验镜像摘要：`sha256:7f1a7d5dd716f8b499da45457a097e05d253af1f03dd921f0689ad8db550ba8b`
- 模拟 APP HTTP Service：`NodePort 30080`
- Channel 集群内 Service：`ClusterIP:18890`
- Channel 私网 ELB：`192.168.2.13:18890`（后端 NodePort `192.168.2.246:31965`）

部署清单位于 [`deploy/huaweicloud-cce/onyxclaw-app-demo.yaml`](../deploy/huaweicloud-cce/onyxclaw-app-demo.yaml)。

## 2026-08-22 部署结果

- `Deployment/onyxclaw-app`：`1/1 Ready`、`1/1 Available`
- APP Pod：`Running`、容器重启次数 `0`
- 实际镜像：`swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-app@sha256:7f1a7d5dd716f8b499da45457a097e05d253af1f03dd921f0689ad8db550ba8b`
- `/api/status`：返回 `mode: idle`，健康检查通过
- `/api/ui-config`：已确认 `deploymentMode: cloud`、`providerId: huaweicloud-agentsphere`、`region: cn-south-1`
- 公网 NodePort：已从集群外验证 `http://113.45.154.231:30080` 可达
- AgentSphere API Endpoint：已配置为 `https://agentsphere.cn-south-1.myhuaweicloud.com`
- Sandbox 数据面 Endpoint：已配置为 `https://agent-gateway-sandbox-muyden3dgi.agentgateway.cn-south-1.huaweicloud-agentnetwork.com`
- E2B API Key：已通过 Kubernetes Secret 注入，本文和部署清单不记录其值
- E2B SDK 验证：早期验收成功；本轮再次验证时 `Sandbox.list` 与 `Sandbox.create`
  均返回 `403 sandbox.auth.0001`。CCE Secret 与提供值的 SHA-256 一致，需在
  AgentSphere 侧恢复或重新签发 API Key 后继续真实生命周期验收。
- Channel 回连：`ws://192.168.2.13:18890/connect` 已从 CCE 节点验证返回 WebSocket `101 Switching Protocols`
- 模型：已配置 DeepSeek provider、`deepseek-v4-flash` 和正式模型 API Key；Key 仅保存在 Kubernetes Secret 中
- DeepSeek 验证：从 CCE 节点调用 `https://api.deepseek.com/models` 返回 HTTP `200`，鉴权成功且模型列表包含 `deepseek-v4-flash`

首次部署没有使用节点 root 登录，也没有把节点密码写入集群资源或仓库。首次创建的运行时 Secret 使用随机生成的无权限占位值。

补充 AgentSphere 和 DeepSeek 信息后，E2B API Key 与模型 Key 均已替换为真实值；Channel signing secret 仍为部署时生成的随机值。

## Channel Plugin 节点构建结果

Channel Plugin 已在 CCE 节点的 `/home/hzp/channel` 构建完成，可作为后续 OpenClaw 派生镜像的构建输入：

- 源码：`index.js`、`setup-entry.js`、`openclaw.plugin.json`、`src/`
- 生产依赖：`node_modules/ws@8.21.3`
- 锁文件：`/home/hzp/channel/package-lock.json`
- npm 包：`/home/hzp/channel/dist/onyxclaw-channel-0.1.0.tgz`
- npm 包 SHA-256：`46e8dc40b12bf3d63a3c1ae25b9927118a32991f85e15ad86ad9cffbbffad92b`
- `package-lock.json` SHA-256：`04740ab841da5d89bcf26ac890139060589f390f8310c8fd860e2d81fbd18848`

节点没有安装全局 Node/npm。构建使用节点已缓存的 `onyxclaw-app:0.3.8` 容器内 Node `22.23.2` 和 npm `10.9.8` 完成，没有修改节点系统运行时。`npm ls --omit=dev --omit=peer` 和全部插件 JS 文件的 `node --check` 已通过，依赖审计结果为 0 个漏洞。

OpenClaw 镜像仍需提供插件的 peer dependency。沿用仓库现有镜像方案时，把 `/home/hzp/channel` 复制到镜像的 `/opt/onyxclaw/channel`，并在镜像内建立：

```text
/opt/onyxclaw/channel/node_modules/openclaw -> /app
```

AgentSphere Endpoint 从节点解析到华为云 API Gateway 地址，HTTPS TLS 校验成功。本地使用官方 E2B Python SDK 调用 `Sandbox.list` 已成功，确认 API 路径、网络和鉴权均正常。

## OpenClaw 派生镜像构建结果

OpenClaw 派生镜像已在 CCE 节点使用 `/home/hzp/openclaw-image` 作为构建上下文完成构建并推送到 SWR。构建使用节点本地基础镜像 `openclaw:2026.5.28`，其镜像 ID 为 `sha256:20623962bd21c91584760ebe348e2d70393fd2280075a92e9d74be6e377681ec`，构建过程没有重新拉取 GHCR。

镜像引用：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw:0.3.8-sfs-lifecycle
```

正式注册 AgentSphere Template 时建议使用不可变引用：

```text
swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw@sha256:d2790899ef5275a1cda49c4f45338c199a438b86912b12ff6c7d6a25283dac7f
```

构建结果：

- 本地派生镜像 ID：`sha256:39142940d185`
- SWR manifest digest：`sha256:d2790899ef5275a1cda49c4f45338c199a438b86912b12ff6c7d6a25283dac7f`
- 平台：`linux/amd64`
- 镜像大小：`1057055539` bytes
- 构建目录：`/home/hzp/openclaw-image`
- Channel Plugin 来源：`/home/hzp/channel`
- envd 来源：`/home/hzp/envd`
- envd 健康脚本来源：`/home/hzp/envd-healthcheck.sh`
- 参考入口：`/home/hzp/backup/entrypoint.sh`

派生入口会先执行：

```text
/opt/onyxclaw/bin/envd -isnotfc -port 49983 -verbose -no-cgroups
```

随后通过 `/opt/onyxclaw/bin/envd-healthcheck.sh` 检查 `http://127.0.0.1:49983/health` 是否返回 HTTP `204`。envd 就绪后，入口只等待最终路径 `/home/node/.openclaw/openclaw.json`；文件出现后立即以 `node` 用户启动监听 `18789` 的 OpenClaw Gateway，不再等待或复制 bootstrap 目录中的 `SOUL.md`。

新派生镜像对应的 AgentSphere Template 已由用户在控制台重新创建，Template ID 为
`4b437fde-0069-4738-a11b-c264c49b57a3`。当前 AgentSphere 不支持通过 API 更新或创建
模板；此后每次修改 OpenClaw 派生镜像，都必须由用户基于新镜像重新创建模板，并把新
Template ID 回填到 Provider Profile 后才能发放验证。

临时容器验收已确认：envd 进程存活、健康接口返回 `204`、Docker HEALTHCHECK 为 `healthy`、Channel Plugin 的 OpenClaw peer 链接有效，并且 bootstrap 目录存在。验收容器已删除，SWR 推送完成后节点已执行 `docker logout` 清除登录状态。

## 当前配置和待补项目

Cloud APP 在进程启动时会校验 Provider Profile，并要求基础 OpenClaw JSON 和 Provider 对应的环境变量非空。因此，尚未提供的配置不能在 YAML 中使用空字符串。AgentSphere Endpoint、E2B API Key、Channel 回连 URL 和 DeepSeek provider 已配置：

| 配置 | 当前值 | 行为 |
| --- | --- | --- |
| Sandbox API | `https://agentsphere.cn-south-1.myhuaweicloud.com` | bridge 显式传入 `api_url`，不会再由 SDK 拼接 `api.` 前缀 |
| Sandbox 数据面 | `https://agent-gateway-sandbox-muyden3dgi.agentgateway.cn-south-1.huaweicloud-agentnetwork.com` | 通过 `api.sandboxUrl` 映射为 SDK 的 `E2B_SANDBOX_URL`；DNS/TLS 可达 |
| Channel 回连 URL | `ws://192.168.2.13:18890/connect` | ELB VIP 使用 Service port；API Key 恢复后需从 Sandbox 再验 WebSocket 回连 |
| Sandbox Template | `4b437fde-0069-4738-a11b-c264c49b57a3` | 对应 `0.3.8-sfs-lifecycle` 派生镜像，尚需执行实际创建验收 |
| Model Provider / ID | `deepseek` / `deepseek-v4-flash` | Provider 已配置 |
| E2B API Key | Kubernetes Secret 中的真实值 | 已配置，不写入 Git |
| 模型 API Key | Kubernetes Secret 中的真实值 | 已配置，不写入 Git 或备份文件 |
| Channel secret | 部署时生成的随机值 | APP 与 Sandbox 插件必须使用同一值 |
| OpenClaw 基础配置 | DeepSeek 配置已注入 | 模型 API Key 使用运行时占位符 |

Template ID 已配置。实际创建验收前仍需确认 Template 的默认用户、路径、入口和 AgentSphere 网络绑定与当前 Provider 配置一致。

### SFS Turbo 与暂停恢复配置

创建 Sandbox 时，APP 把下面的 Provider 固定 metadata 与 `instanceId/traceId` 合并后传给
E2B `Sandbox.create`：

```json
{
  "agentsandbox.storage.sfs": "{\"sfsTurboMounts\":[{\"sfsTurboId\":\"d38073b5-7002-4279-ab54-32faff2a0132\",\"sharePath\":\"/hzp/workspace\",\"readOnly\":false,\"mountDir\":\"/home/node/.openclaw/workspace\"}]}"
}
```

`sharePath` 使用当前提供的 SFS 内目录 `/hzp/workspace`。若 AgentSphere 创建接口要求控制台
显示的完整共享路径而不是子目录路径，需要把这一项替换成完整值；当前 API Key 的 403
发生在鉴权阶段，因此尚未进入 metadata/SFS 参数校验。

生命周期顺序如下：

1. create：携带 SFS metadata 和 `on_timeout=pause` 创建 Sandbox；
2. prepare：立即把完整 `openclaw.json` 写到 `/home/node/.openclaw/openclaw.json`，触发 Gateway 启动；
3. bootstrap：用户确认 SOUL 后只写 `/home/node/.openclaw/workspace/SOUL.md`，等待 Gateway 和 Channel；
4. pause：页面调用 E2B `Sandbox.pause`；
5. resume：页面调用 `Sandbox.connect` 获取新会话，再次执行 SOUL 写入和 Gateway/Channel 就绪等待。

SFS 仅挂载 workspace，因此会持久化 `SOUL.md` 和 workspace 中其他 Markdown 文件；包含模型
和 Channel token 的 `openclaw.json` 仍留在 Sandbox 本地文件系统，不写入 SFS。

### E2B Endpoint 修复说明

旧 bridge 只把 `agentsphere.cn-south-1.myhuaweicloud.com` 写入 `E2B_DOMAIN`，调用
`Sandbox.create` 时没有传 `api_url`。官方 E2B Python SDK 在缺少 `E2B_API_URL` 时会按
`https://api.<E2B_DOMAIN>` 生成控制面地址，因而错误访问了不存在的
`api.agentsphere.cn-south-1.myhuaweicloud.com`，最终表现为 DNS
`[Errno -2] Name or service not known`。

修复后的 APP 同时处理两类地址：控制面始终显式使用 `api.baseUrl` 作为 `api_url`；
数据面把 `api.sandboxUrl` 注入为 `E2B_SANDBOX_URL`。两者不可互换。CCE 节点验证结果为：
控制面域名可解析，错误的 `api.` 域名不可解析，Sandbox 数据面域名可解析且 HTTPS
请求能到达 Agent Gateway（未携带会话信息时返回预期的 HTTP 400）。

Agent Gateway 还要求每次 Sandbox 数据面请求携带创建/连接响应中的
`traffic_access_token`。修复后的 bridge 会将该值作为
`E2B-Traffic-Access-Token` 请求头注入 envd 的 Files、Commands 和健康检查请求；E2B
API Key 只用于控制面，不用于 Sandbox Gateway 鉴权。

### 2026-08-22 历史真实端到端验收

通过公网 demo app 的 `/api/*` 接口完整执行了新用户流程：

1. `Sandbox.create` 使用 Template `b42d35f0-3b55-4857-8a28-be2543808932`
   成功，控制面耗时约 `2.2s`；
2. `openclaw.json` 和 `SOUL.md` 经 Agent Gateway 写入成功，证明
   `E2B-Traffic-Access-Token` 数据面鉴权生效；
3. Sandbox 内 OpenClaw Gateway `readyz` 最终返回成功；
4. Channel Plugin 成功回连 `ws://192.168.2.13:18890/connect`，APP 状态变为
   `mode=connected` 并生成非空 `connectionId`；
5. 经 Channel 发送“计算 17×23，并附加验证口令 DS-E2E-OK”，配置的
   `deepseek/deepseek-v4-flash` 返回 `391` 和 `DS-E2E-OK`，对话耗时约 `5.8s`；
6. 验收后 `Sandbox.kill` 成功，APP 回到 `mode=idle`，没有遗留运行中的测试
   Sandbox。

当前 Channel ELB 没有配置 TLS，因此本次验证协议是私网 `ws://`，不是 `wss://`。
若正式要求 WSS，需要为 ELB/网关配置可被 Sandbox 信任的域名证书，将
`channel.publicUrl` 改为 `wss://<domain>/connect` 后再做一次握手验证。

Template 配置后的非敏感快照保存在 [`deploy/huaweicloud-cce/backups/onyxclaw-app-config-2026-08-22-template-b42d35f0.yaml`](../deploy/huaweicloud-cce/backups/onyxclaw-app-config-2026-08-22-template-b42d35f0.yaml)。此前快照继续保留。快照只记录 Secret 引用和键名，不包含 E2B、DeepSeek 或 Channel 的 Secret 值。

### Channel 端口说明

CCE Service `onyxclaw-app-27700` 的 ELB VIP 是 `192.168.2.13`，Service port 是 `18890`，NodePort 是 `31965`。因此可用入口是：

- ELB：`192.168.2.13:18890`
- 节点 NodePort：`192.168.2.246:31965`

`192.168.2.13:31965` 把 ELB VIP 和 NodePort 混在一起，节点实测会超时，不能作为 Channel
URL。`31965` 只能与节点地址 `192.168.2.246` 组合使用；当前 Profile 因此保留已经完成
WebSocket `101` 验证的 `ws://192.168.2.13:18890/connect`。

### E2B SDK 验证脚本

脚本位于 [`deploy/huaweicloud-cce/verify_e2b_list.py`](../deploy/huaweicloud-cce/verify_e2b_list.py)，只执行只读的 `Sandbox.list`，不会创建或删除 Sandbox。建议通过隐藏提示输入 API Key：

```bash
python3 -m venv .venv
.venv/bin/pip install 'e2b==2.24.0'
.venv/bin/python deploy/huaweicloud-cce/verify_e2b_list.py \
  --api-url agentsphere.cn-south-1.myhuaweicloud.com \
  --prompt-api-key
```

早期实测输出为 `ok: true`、`network: reachable`、`authentication: accepted`、
`firstPageCount: 0`。本轮同一脚本返回 `403 sandbox.auth.0001`，以最新结果为准。
API Key 未写入脚本或部署文档。

DeepSeek 的 OpenClaw 基础配置示例位于 [`deploy/huaweicloud-cce/openclaw-base-config.deepseek.example.json`](../deploy/huaweicloud-cce/openclaw-base-config.deepseek.example.json)，其中 `__ONYXCLAW_MODEL_API_KEY__` 由 APP 在 Sandbox 启动时替换。

## VPC 对等连接核验记录

节点元数据与操作系统网络信息已确认：

| 项目 | 当前值 |
| --- | --- |
| demo-app 所在 VPC ID | `a55a1e13-a49b-4d31-9a30-4b62bbbd5997` |
| CCE 节点私网地址/子网 | `192.168.2.246/22` |
| demo-app VPC 网段 | `192.168.0.0/16` |
| CCE Pod 网段 | `172.16.0.0/16` |
| 节点安全组 | `testdemo-cce-node-s0ote` |
| Sandbox VPC ID / 网段 | `d14a6231-1b29-4c31-8894-f4b68082932e` / `10.0.0.0/8` |
| Sandbox 子网 | `subnet-5350`（`10.0.0.0/22`） |
| 对等连接 | `peering-ccf3`（`c99a62e5-4a61-4902-a41c-9d7a35fd29ea`），状态“已接受” |

2026-08-22 已在华为云控制台确认对等连接和两端默认路由表：

1. demo-app 路由表 `rtb-vpc-2a28`（`fb5c472c-b0d2-481a-84df-ba76a5e2b0d1`）包含 `10.0.0.0/8 -> peering-ccf3`。
2. Sandbox 路由表 `rtb-vpc-sandbox`（`6909a2e6-cf5c-42f3-b5a5-6cdb4f9cbb48`）包含 `192.168.0.0/16 -> peering-ccf3`。
3. 两个 VPC CIDR 不重叠，Sandbox 子网已关联 `rtb-vpc-sandbox`。
4. 当前区域没有网络 ACL。CCE 节点安全组允许全部 IPv4 出站，并允许 TCP NodePort `30000-32767` 入站，因此包含 Channel NodePort `31965`。

控制面路由配置已经完整。当前还没有可用于探测的 Sandbox 实例；创建 Sandbox 后仍需从 CCE Pod 探测其私网 IP/服务端口，并从 Sandbox 到 `192.168.2.13:18890` 验证 WebSocket `101`，作为最终数据面证据。CCE NodePort 当前对 `0.0.0.0/0` 开放整个 `30000-32767`，联调可用但范围偏大，正式环境应收敛到 Sandbox CIDR。

## 访问与验证

若节点安全组已允许 TCP `30080`，可访问：

```text
http://113.45.154.231:30080
```

应用健康检查：

```bash
curl -fsS http://113.45.154.231:30080/api/status
curl -fsS http://113.45.154.231:30080/api/ui-config
```

`/api/ui-config` 应显示：

```json
{
  "deploymentMode": "cloud",
  "providerId": "huaweicloud-agentsphere",
  "region": "cn-south-1"
}
```

如果公网访问超时，在节点安全组入方向放通来源受限的 TCP `30080`，不要对 `0.0.0.0/0` 长期开启。也可改用 CCE 私网 ELB 或 `kubectl port-forward`。

## Sandbox 联调前必须配置

1. 验证 AgentSphere Template `4b437fde-0069-4738-a11b-c264c49b57a3` 与当前派生镜像匹配，并确认 `defaultUser=node`、home/workspace 路径、OpenClaw 启动命令、envd 健康状态和 Gateway 端口 `18789`；派生镜像更新后需人工重新创建模板并替换此 ID。
2. 确认 Sandbox VPC 可以路由到 Channel 私网 ELB `192.168.2.13:18890`；正式环境建议配置私有域名和 TLS。
3. 当前 APP 配置仍要求一个非空 Channel signing secret，但 v0.3.8 实际握手使用每个实例动态生成的 `bootstrapToken`；现有随机 Secret 可以保留，不需要手工写入 Template。若后续版本启用长期签名校验，再统一轮换 APP 与插件侧 Secret。
4. 验证 Sandbox 到 `https://api.deepseek.com` 的 DNS、路由、安全组和 TLS 连通性；正式 DeepSeek API Key 已配置。
5. `ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON` 的正式内容，包括模型配置、`__ONYXCLAW_MODEL_API_KEY__` 占位符、Gateway token 和实际 workspace。
6. CCE VPC 与 Sandbox VPC 的路由/对等连接或 VPCE、私有 DNS Zone、安全组、NetworkPolicy 和出站 allowlist。
7. 如 SWR 后续改成私有鉴权且节点不再有镜像缓存，需要创建 `imagePullSecret` 并添加到 Pod spec；建议仍使用镜像 digest 固定版本。

替换完成后滚动重启 Deployment，并分别验证 `/api/ui-config`、APP Pod 到 Sandbox API 的 DNS/TCP/TLS、Sandbox 到 Channel 的 WebSocket，以及 Sandbox 到模型 Endpoint 的访问。

更完整的正式联调说明见 [`docs/huaweicloud-agentsphere-cce-deployment.md`](./huaweicloud-agentsphere-cce-deployment.md)。
