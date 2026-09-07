# OnyxClaw CCE + AgentSphere 交接（2026-09-04）

## 范围与当前结论

本次工作覆盖两个仓库：

- 部署包：`/Users/kianabin/Work-local/Code/onyxclaw-one-click`
- APP/Channel 源码与发布记录：`/Users/kianabin/Work-local/Code/onyxclaw-yqb-dev`

CCE + AgentSphere 的新环境曾完成完整验收；用户随后要求清理付费基础设施。Terraform 管理的高成本资源已经删除，当前 state 只保留 VPC 与子网，供用户在控制台清理 AgentSphere 依赖后手动删除。

## 已确认事实

### 已验收的发布组合

| 项目 | 已确认值 | 说明 |
| --- | --- | --- |
| APP 镜像 | `swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-app:0.3.9-chat-delivery-correlation-v21@sha256:9f3bd8bd484c6276add07cf4aa16d1fce8d19ab2c463a10721bf3d9f624a5516` | CCE Pod `imageID` 已核对。 |
| Template 镜像 | `swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-openclaw:0.3.9-channel-error-fix-v21@sha256:8e314ad47a49eb57cab244fcbf52e456c4e8ae6d32e8bf732c6549bb083803e8` | 仅在 AgentSphere 控制台创建 Template 时人工选择。 |
| Template ID | `b27b02b9-a2b3-440a-be11-3b2cc0ae00b1` | 已更新到 APP Provider 配置。 |
| 验收状态 | 用户确认通过 | APP 部署、Sandbox 创建、`SOUL.md`、Gateway/Channel、模型对话、pause/resume 与 reset/kill 均按验收流程完成。 |

### APP 配置注入模型

`deploy.mjs` 不直接进入容器修改文件；它读取本地输入后生成 Kubernetes `ConfigMap`、`Secret`、`Deployment`，由 Deployment 注入环境变量/配置。

- `config/config.env`：Kubeconfig 路径、AgentSphere Sandbox URL、Template ID、SFS ID、`APP_IMAGE`。
- `config/secrets.env`：AgentSphere E2B API Key 与模型 API Key；禁止输出、提交或读取已存在 Secret 的 `.data`。
- `config/openclaw-base-config.json`：OpenClaw 基础 JSON；由部署器写入 Kubernetes Secret 并以 `ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON` 注入。
- 固定项仍在 `deploy.mjs`：Region、Provider ID、服务端口、模型 ID、生命周期、资源限制等。

Template 镜像**不是**运行时部署输入：APP 只消费 `AGENTSPHERE_TEMPLATE_ID`。不要恢复 `AGENTSPHERE_TEMPLATE_IMAGE` 常量、配置项或 Deployment annotation；它曾只用于日志/说明，无法创建或更新 Template，容易漂移。

### one-click 代码与文档已推送

仓库 `onyxclaw-one-click` 的 `main` 已推送，且本次交接时工作区干净：

| Commit | 内容 |
| --- | --- |
| `be8e19e` | 修复 Terraform create-mode 对空 existing VPC/Subnet ID 的校验。 |
| `10d8112` | APP 镜像配置化：从 `config/config.env` 读取，SFS 准备复用同一镜像，更新测试与操作手册。 |

关键文件：

- `/Users/kianabin/Work-local/Code/onyxclaw-one-click/scripts/deploy.mjs`
  - `APP_IMAGE` 通过 `required(raw, "APP_IMAGE")` 读取；必须匹配 `image@sha256:<64-hex-digest>`。
  - 继续从 `AGENTSPHERE_TEMPLATE_ID` 写 Provider 配置。
- `/Users/kianabin/Work-local/Code/onyxclaw-one-click/scripts/prepare-sfs.mjs`
  - 通过 `prepare-sfs.sh` 自动传入同一份 `config/config.env`，读取相同的不可变 APP 镜像。
- `/Users/kianabin/Work-local/Code/onyxclaw-one-click/config/config.env.example`
  - 包含当前 APP 镜像默认值。
- `/Users/kianabin/Work-local/Code/onyxclaw-one-click/docs/CLOUD_PREREQUISITES.md`
  - AgentSphere 控制台中应人工复制 `0.3.9-channel-error-fix-v21` Template 镜像 tag，并记录对应 digest 作审计。

未来升级 APP 的用户操作应只有：编辑本地、被忽略的 `config/config.env` 中的 `APP_IMAGE`，然后执行 dry-run 和 `./scripts/deploy.sh`。不需要修改部署脚本或 SFS 脚本。

## 已验证命令与结果

在 `/Users/kianabin/Work-local/Code/onyxclaw-one-click`：

```bash
node --test tests/*.test.mjs
```

结果：`21/21` 通过。

```bash
node scripts/deploy.mjs --config config/config.env --secrets config/secrets.env --dry-run
```

结果：通过；确认读取 APP v21 不可变 digest 和当前 Template ID。正式 rollout 也曾成功，`/api/ui-config` 返回 `deploymentMode=cloud`、Provider `huaweicloud-agentsphere`、新 Template ID，并启用 pause/resume 与 memory persistence。

Terraform 清理前的 APP 只读检查：

```bash
curl http://110.41.84.185:30080/api/status
```

结果：`mode=idle`、无 Sandbox、无连接、无错误。该浏览器入口随后因 CCE 删除而失效。

## 清理执行记录

### 已完成

1. Kubernetes `onyxclaw/onyxclaw-channel-lb` LoadBalancer Service 已删除，以触发 CCE 回收其私网 ELB。
2. 已执行经用户审阅的 Terraform destroy plan；以下 Terraform 资源的删除已成功：
   - CCE 集群与工作节点；
   - API Server EIP、SNAT EIP；
   - NAT Gateway 与 SNAT Rule；
   - 500 GiB SFS Turbo 与其专用安全组；
   - 其余已完成的关联资源。
3. 用户随后要求暂停 Terraform；进程已通过 Ctrl-C 优雅终止，未执行强制终止或 state 修复。

### 当前 Terraform state

在 `/Users/kianabin/Work-local/Code/onyxclaw-one-click/iac/cce` 执行：

```bash
terraform state list
```

结果只剩：

```text
huaweicloud_vpc.this[0]
huaweicloud_vpc_subnet.this[0]
```

对应资源：

- VPC：`e7155717-5703-4940-b6ba-b34e9be97c02`
- 子网：`ff1043e6-5bfd-4838-9fb2-89f4ed64d02b`

### 假设，尚未证实

AgentSphere 私网网关和/或 Template 可能仍关联该 VPC/子网，并阻塞子网或 VPC 删除。这是合理推断，但 Terraform 在用户要求停止前没有返回明确的“资源仍被使用”错误；不要把它写成已证实根因。

Terraform 的 destroy plan / state 可能包含 Kubernetes 证书、私钥或敏感控制面材料。后续 agent 必须只汇总资源动作，绝不能回显原始 plan 或 state 内容。

## 未决问题与下一步建议

### 用户手动清理（当前意图）

1. 在 AgentSphere 控制台确认没有 Sandbox 后，删除 Template。
2. 删除或解绑启用私网访问的 AgentSphere 智能体网关，等待其网络接口/私网连接完全释放。
3. 在 VPC 控制台检查该子网是否还存在网卡、私网连接、ELB 或其他占用项；同时确认 Channel 私网 ELB 已被 CCE 回收，避免残留计费。
4. 删除子网，再删除 VPC。

### 若用户要求 agent 继续 Terraform 清理

不要复用已中断的 `/private/tmp/onyxclaw-destroy-20260903.tfplan`。先在控制台完成上述解除依赖，再生成一个新的计划：

```bash
cd /Users/kianabin/Work-local/Code/onyxclaw-one-click/iac/cce
terraform init -input=false
terraform state list
terraform plan -destroy -out=<new-unique-plan-path>
```

展示摘要并取得新的明确授权后，才可：

```bash
terraform apply <new-unique-plan-path>
```

不要手动执行 `terraform state rm` 来掩盖真实云资源；也不要删除未知 Sandbox、namespace、ELB、SFS、CCE 节点或 VPC。所有销毁都必须按明确资源 ID 和用户授权进行。

## 行为约束

- `scripts/deploy.mjs` / `scripts/deploy.sh` 是 Kubernetes 写入的唯一入口。
- AgentSphere 网关和 Template 是人工控制台边界；没有明确授权与可验证对象时，不模拟页面或调用猜测的 API。
- 本地 `config/config.env`、`config/secrets.env`、kubeconfig、Terraform state 与 plan 均敏感且不可提交、不可输出。
- 仓库根 `AGENTS.md` 禁止批量删除文件或目录；删除文件只能逐个指定明确路径。
