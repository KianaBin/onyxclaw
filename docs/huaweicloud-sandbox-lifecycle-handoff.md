# Huawei Cloud Sandbox lifecycle 变更交接

本文用于评审本地个人分支 `hzp-dev` 在推送远端前的内容。基线为 `main` 的
`34a087d`，当前功能提交范围为 `c97b589..da33ebd`。

## 敏感信息审计

已对当前 Git 树、功能范围 `c97b589..da33ebd` 的 9 个提交快照、补丁历史和提交说明执行
模式扫描，覆盖：

- E2B、DeepSeek 等 API Key 常见格式；
- 华为云 AK/SK 和长凭据上下文；
- 明文密码和 Docker CLI 明文凭据参数；
- Kubeconfig、`client-key-data`、`client-certificate-data`；
- PEM/OpenSSH 私钥；
- Bearer/Basic Authorization 内容。

扫描未发现已提交的 API Key、AK/SK、明文密码、Kubeconfig、客户端证书或私钥。部署 YAML
和备份快照只包含 Kubernetes `secretKeyRef` 名称/键名；DeepSeek 配置使用
`__ONYXCLAW_MODEL_API_KEY__` 占位符；GitHub Actions 使用 `${{ secrets.GITHUB_TOKEN }}`，
均不包含 Secret 值。64 位十六进制内容经上下文复核为镜像 digest、文件校验和或 Terraform
provider hash。

仓库仍包含以下不能直接用于鉴权、但可能暴露环境拓扑的标识：华为云 Domain ID、节点公网
IP、VPC/ELB 私网地址、SFS Turbo ID 与共享子路径、AgentSphere Template ID、SWR 仓库地址
和镜像 digest。若远端仓库对外公开，推送前应决定是否对这些环境元数据进一步脱敏。

## 当前修改

### AgentSphere E2B 兼容修复

- 控制面固定使用 `https://agentsphere.cn-south-1.myhuaweicloud.com`，避免 SDK 自动添加
  `api.` 前缀导致 DNS 失败。
- 数据面单独使用 Agent Gateway Sandbox URL。
- `create/connect/pause/kill` 只使用 E2B API Key；`Files/Commands` 使用 create/connect
  返回的 `traffic_access_token`。
- 控制面鉴权类 `401/403`、`sandbox.auth.0001` 最多重试 4 次；错误日志统一脱敏并保留
  status code、request ID 和调用阶段。
- Channel 捕获模型生成异常并返回明确 outbound 错误，避免 APP 只得到
  `timed out waiting for next outbound event`。

### SFS Turbo 持久化

创建 Sandbox 时通过 metadata key `agentsandbox.storage.sfs` 注入 SFS Turbo 挂载结构，
把共享目录挂载到 `/home/node/.openclaw/workspace`。workspace 下的 `SOUL.md` 等 Markdown
文件可跨 pause/resume 保留；包含模型和 Channel token 的 `openclaw.json` 不写入共享目录。

新 Sandbox 创建后立即写入 `/home/node/.openclaw/openclaw.json`，触发派生镜像中的 Gateway
启动；首次 bootstrap 只负责写入 `SOUL.md` 并等待 Gateway 与 Channel 就绪。

### Pause/resume 与页面流程

- 页面提供 `Sandbox.pause` 和恢复入口。
- 正常恢复先用 E2B API Key 执行 `Sandbox.connect`，再读取 SFS 中的持久化 `SOUL.md`，
  展示内容、大小和 SHA-256；用户确认后才写回并执行 bootstrap。
- Agent Gateway 返回 `Session ID not found` 时，bridge 在 45 秒窗口内退避重试。最终仍
  失败时不再 pause，也不再次 connect；Sandbox 保持运行，APP 进入
  `resume-data-pending`，页面提供仅重试 `Files.read` 的“重试恢复”按钮。
- 恢复 bootstrap 的其他失败不会执行首次创建场景的 kill 补偿，会尽量重新暂停 Sandbox。
- 重置新用户默认调用 `Sandbox.kill`；删除失败后页面允许跳过 Sandbox 清理，只重置 APP
  本地用户状态，并回显遗留 Sandbox ID 供后续人工清理。

### 派生镜像与 CCE demo APP

- OpenClaw 派生入口启动 envd、执行健康检查，并在最终路径出现 `openclaw.json` 后启动
  Gateway。
- Channel Plugin、envd 和健康检查脚本已纳入派生镜像构建流程。
- CCE demo APP 配置 DeepSeek `deepseek-v4-flash`、AgentSphere 控制面/数据面、Channel
  私网回连地址、SFS metadata 和 Template ID；所有实际密钥通过 Kubernetes Secret 注入。
- 当前 CCE APP 镜像固定到 `0.3.8-resume-control-retry` 的不可变 digest。

## 剩余遗留事项

### 1. 暂停后恢复失败

历史实测中 `Sandbox.pause` 成功，但 `Sandbox.connect` 返回
`500 agent gateway create sandbox failed ... status=400`，失败发生在 AgentSphere 创建新
Gateway session 的控制面阶段。另一次实测中 pause 本身连续返回
`sandbox.auth.0001 / IAM SYS.0401 invalid authorization header`。APP 已确认使用 E2B API Key，
未把 `traffic_access_token` 用于控制面；剩余问题需要 AgentSphere 服务端结合 request ID
和 Gateway 事件排查。

### 2. 暂停状态 Sandbox 删除失败

对 3 个明确的残留 paused Sandbox 使用 class-level `Sandbox.kill(id, api_key/api_url/domain)`
绕过 connect，并分别重试 8 次，仍交替返回：

- `500 agent gateway delete sandbox failed ... statusCode=500`；
- `403 sandbox.auth.0001`，内层 IAM `SYS.0401`。

残留 Sandbox 的完整 ID 不写入 Git。需要 AgentSphere 管理面或服务端清理，并确认删除
paused Sandbox 是否错误依赖已失效的 Gateway session。

### 3. LTS 日志无法查询

当前没有取得可用于上述失败定位的 LTS 日志结果。需要确认 Sandbox/Agent Gateway 日志是否
已接入目标日志组与日志流、当前账号是否具备 LTS 查询权限、日志时间范围与 Region 是否为
`cn-south-1`，并使用失败调用的时间和 request ID 做服务端关联查询。在日志可查询前，恢复
和删除失败只能依据 E2B API 返回的外层 403/500 判断，无法确认 Agent Gateway 内部原因。

## 推送前检查

1. 决定是否保留文档中的 Domain ID、公网 IP、私网拓扑、SFS/Template ID 等环境元数据。
2. 确认 `git status` 干净、完整测试通过。
3. 确认本地分支名为 `hzp-dev`，且未配置或执行远端 push。
4. 用户评审无误后，再显式推送远端仓库。
