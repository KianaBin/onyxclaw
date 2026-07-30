# Phase 0 本机 OpenClaw 测试

## 当前状态

2026-07-19 已在本机 macOS、OpenClaw 2026.5.28 上跑通自动化流程：

```text
启动 Simulator
  → 自动链接/配置 Channel Plugin
  → 重启 Gateway 并完成第一轮消息
  → 注入断线并使用 session token 自动重连
  → 备份、改写并校验 SOUL.md
  → 轮换 bootstrap token 并再次重启 Gateway
  → 校验 SOUL.md 持久性和 Gateway 健康状态
  → 完成第二轮消息
  → 恢复原 SOUL.md、禁用测试 Channel、停止 Simulator
```

最新实测的两轮回复：

```text
ONYXCLAW_PHASE0_FIRST_OK
ONYXCLAW_PHASE0_SECOND_OK
```

16 项自动测试和真实本机流程均通过。最新报告位于：

```text
artifacts/phase0-local-40f470c3-8858-445b-b7cb-f6efd6140421.json
```

`artifacts/` 已加入 `.gitignore`，报告包含每一步耗时、trace ID、结果和回复，不记录注册 token。

## 运行方式

前提：本机已安装并配置 OpenClaw，且模型 Provider 可以正常响应。

```bash
npm install
npm test
npm run phase0:local
```

`phase0:local` 是一键流程，不再需要手动安装 Plugin、修改 Channel 配置或重启 Gateway。它会暂时重启本机 Gateway，可能短暂中断其他 Channel；无论测试成功或失败，runner 都会尝试恢复原 `SOUL.md`、禁用 `onyxclaw` 测试 Channel，并再次重启 Gateway。

独立核验清理状态：

```bash
openclaw config get channels.onyxclaw.enabled
openclaw gateway status
```

预期分别包含 `false` 和 `Connectivity probe: ok`。

## 自动测试覆盖

- Channel envelope、inbound event 和协议版本校验；
- 一次性 bootstrap token 与 session token 的归属校验；
- outbound event 幂等；
- Plugin account 配置、OpenClaw inbound route/context/reply delivery；
- WebSocket 注册、heartbeat、inbound/outbound；
- 断线后的指数退避重连和 session 续接；
- Plugin 自动链接、Channel 配置、Gateway restart/probe；
- `SOUL.md` 原文件备份、原子写入、hash 校验与逐字节恢复；
- 两轮消息、Gateway 重启、token 轮换和清理顺序的本地编排。

实现过程遵循 TDD：先为重连、macOS 驱动和完整编排添加失败测试，再实现至测试通过，最后运行真实 OpenClaw E2E。

## 可配置项

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CHANNEL_HOST` | `127.0.0.1` | Simulator 监听地址 |
| `CHANNEL_PORT` | `18890` | Simulator 监听端口 |
| `CHANNEL_INSTANCE_ID` | `local-mac` | 测试实例 ID |
| `CHANNEL_ACCOUNT_ID` | `default` | Channel account ID |
| `OPENCLAW_WORKSPACE` | `~/.openclaw/workspace` | OpenClaw workspace 路径 |
| `PHASE0_FIRST_PROMPT` | 第一轮固定成功提示词 | 第一轮测试消息 |
| `PHASE0_SECOND_PROMPT` | 第二轮固定成功提示词 | 第二轮测试消息 |
| `PHASE0_TIMEOUT_MS` | `120000` | 单步建连和回复超时 |

每次运行会在进程内生成两个随机 token，分别验证初始注册和 Gateway 重启后的 token 轮换，不接受固定默认密钥。

## 当前边界

本机替身流程已验证 Channel、文件和 Gateway 生命周期，但还不是 proposal 中完整的云端 Phase 0。尚未实现：

- E2B 兼容 API 的 create/connect/files/commands/pause/resume/kill；
- 在真实 Sandbox pause/resume 前后的断连观测、持久性和第二轮消息；
- 参考 E2B 与待测 Sandbox 服务的差异测试；
- WSS/TLS 云端部署和 Docker 镜像；
- webhook transport。

下一步应复用当前 Plugin、Simulator、协议和报告结构，实现 E2B Sandbox Driver，将本机的“人为断线 + Gateway restart”替换为云端的“pause + connect/resume”。
