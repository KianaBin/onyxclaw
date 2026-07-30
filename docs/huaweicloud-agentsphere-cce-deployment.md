# 在华为云 CCE 部署 OnyxClaw Cloud APP 并对接 AgentSphere

本文用于 POC 场景：将 OnyxClaw Cloud APP（例如 `app-v0.3.7`）部署到华为云
CCE，并通过 VPC 私网访问 AgentSphere 的 E2B 兼容 API。

AgentSphere 当前处于 POC 联调阶段，本文中的 Endpoint、模板、模型和密钥名称均使用
占位符。请向服务提供方确认实际值后替换，且不要将任何真实密钥提交到 Git。

## 1. 部署目标与前提

部署后的通信路径如下：

```text
Browser -> OnyxClaw Cloud APP (CCE Pod) -> AgentSphere E2B API (VPC Endpoint)
                                            |
                                            +-> AgentSphere Sandbox -> OnyxClaw Channel WSS
```

开始前请确认：

1. AgentSphere 提供 E2B 兼容 API 的私网 FQDN、端口、协议和 API Key；
2. CCE Pod 所在 VPC、子网和安全组可访问该私网 Endpoint；
3. CCE CoreDNS 可以解析该 FQDN。若使用 PrivateLink/VPCE，需要关联正确的私有
   DNS Zone；
4. AgentSphere 创建的 Sandbox 能访问 OnyxClaw Channel 的 WSS 地址；它通常不能
   解析 CCE 集群内部的 `*.svc.cluster.local` 域名；
5. AgentSphere Template 已预装与 Profile 一致的 OpenClaw 和 Channel Plugin，或已
   验证所选的安装模式。

## 2. 创建 Provider Profile ConfigMap

Cloud APP 未设置 `ONYXCLAW_PROVIDER_CONFIG` 时，会回退到镜像内的 ACS Profile。
该 Profile 指向 ACS 的 `sandbox-system.svc.cluster.local`，在 CCE 中无法解析。因此
必须挂载新的 Profile，并显式选择 `huaweicloud-agentsphere` Provider。

保存以下文件为 `providers.agentsphere.json`。此文件只能包含非敏感配置，不能包含
任何 API Key。

```json
{
  "schemaVersion": 1,
  "defaultProvider": "huaweicloud-agentsphere",
  "providers": {
    "huaweicloud-agentsphere": {
      "displayName": "Huawei Cloud AgentSphere Sandbox",
      "protocol": "e2b-compatible",
      "api": {
        "baseUrl": "https://<agentsphere-vpc-endpoint>",
        "privateNetworkOnly": true,
        "apiKeyEnv": "HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY",
        "compatibilityVersion": "agentsphere-e2b-poc",
        "sdkPatch": "none",
        "requestTimeoutMs": 30000
      },
      "sandbox": {
        "templateId": "<agentsphere-onyxclaw-template-id>",
        "timeoutMs": 600000,
        "onTimeout": "kill",
        "secure": true,
        "defaultUser": "node",
        "homeDir": "/home/node",
        "workspaceDir": "/home/node/.openclaw/workspace"
      },
      "openclaw": {
        "binary": "node /app/openclaw.mjs",
        "gatewayPort": 18789,
        "installMode": "preinstalled",
        "pluginInstallMode": "preinstalled"
      },
      "channel": {
        "publicUrl": "wss://<onyxclaw-channel-vpc-or-public-fqdn>/connect",
        "connectTimeoutMs": 120000,
        "signingSecretEnv": "HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET"
      },
      "model": {
        "provider": "openai-compatible",
        "model": "<model-id>",
        "apiKeyEnv": "HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY"
      },
      "cleanupPolicy": "kill",
      "capabilities": {
        "pauseResume": false,
        "memoryPersistence": false,
        "publicEgress": false,
        "vpc": true
      }
    }
  }
}
```

说明：

- 若 AgentSphere 私网 Endpoint 支持 HTTPS，保留 `https://`。`privateNetworkOnly`
  仍可保留，用于声明网络边界；
- 仅当服务方明确只提供私网 HTTP 时，才改为 `http://`。此时必须同时设置
  `api.privateNetworkOnly: true` 和 `capabilities.vpc: true`；
- 标准 E2B 兼容服务必须使用 `sdkPatch: "none"`。不要使用
  `kruise-agents-private-protocol`，它仅适用于阿里云 ACS；
- `defaultUser`、OpenClaw binary、路径和插件安装模式必须与 AgentSphere Template
  的实际内容一致；
- `channel.publicUrl` 必须从 AgentSphere Sandbox 可达。不要直接填写 CCE
  `ClusterIP` Service 的 `*.svc.cluster.local` 地址。

创建 ConfigMap：

```bash
kubectl -n <namespace> create configmap onyxclaw-provider-config \
  --from-file=providers.agentsphere.json=./providers.agentsphere.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

## 3. 创建 Secret

密钥通过 Kubernetes Secret 注入。Profile 中的 `apiKeyEnv`、`model.apiKeyEnv` 和
`channel.signingSecretEnv` 必须与下列环境变量名完全对应。

准备包含 `__ONYXCLAW_MODEL_API_KEY__` 占位符的 `openclaw-base-config.json`，然后：

```bash
kubectl -n <namespace> create secret generic onyxclaw-app-secrets \
  --from-literal=agentsphere-e2b-api-key='<AGENTSPHERE_E2B_API_KEY>' \
  --from-literal=model-api-key='<MODEL_API_KEY>' \
  --from-literal=channel-signing-secret='<RANDOM_CHANNEL_SIGNING_SECRET>' \
  --from-file=openclaw-base-config-json=./openclaw-base-config.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

不要把上述 Secret 写入 ConfigMap、Deployment YAML、终端历史记录或 Git 仓库。
生产环境应优先使用 CCE 支持的 Secret 管理或密钥同步机制。

## 4. 修改 Cloud APP Deployment

在 Cloud APP 的 `app` 容器中加入以下环境变量和 volume mount。示例假设镜像已发布到
可被 CCE 拉取的镜像仓库。

```yaml
spec:
  template:
    spec:
      containers:
        - name: app
          image: <registry>/onyxclaw-app:app-v0.3.7
          env:
            - name: ONYXCLAW_PROVIDER_CONFIG
              value: /app/config/providers.agentsphere.json
            - name: ONYXCLAW_PROVIDER
              value: huaweicloud-agentsphere
            - name: HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY
              valueFrom:
                secretKeyRef:
                  name: onyxclaw-app-secrets
                  key: agentsphere-e2b-api-key
            - name: HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY
              valueFrom:
                secretKeyRef:
                  name: onyxclaw-app-secrets
                  key: model-api-key
            - name: HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET
              valueFrom:
                secretKeyRef:
                  name: onyxclaw-app-secrets
                  key: channel-signing-secret
            - name: ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON
              valueFrom:
                secretKeyRef:
                  name: onyxclaw-app-secrets
                  key: openclaw-base-config-json
          volumeMounts:
            - name: provider-config
              mountPath: /app/config/providers.agentsphere.json
              subPath: providers.agentsphere.json
              readOnly: true
      volumes:
        - name: provider-config
          configMap:
            name: onyxclaw-provider-config
```

不要从 ACS Deployment 模板复制下列配置到 AgentSphere 部署：

```yaml
- name: E2B_ROUTE_DOMAIN
  value: sandbox-gateway.sandbox-system.svc.cluster.local:7788
```

这是 ACS 私有路由的专用变量。除非 AgentSphere 服务方明确提供等价的 Sandbox 路由域名，
否则不要设置它。

应用变更并等待滚动完成：

```bash
kubectl -n <namespace> apply -f onyxclaw-app.yaml
kubectl -n <namespace> rollout status deployment/onyxclaw-app
```

## 5. 验证配置与网络

先确认 APP 实际选择的 Provider，而不是只检查 Deployment YAML：

```bash
kubectl -n <namespace> port-forward service/onyxclaw-app 3000:3000
curl -fsS http://127.0.0.1:3000/api/ui-config
```

返回值必须包含：

```json
{
  "providerId": "huaweicloud-agentsphere",
  "providerName": "Huawei Cloud AgentSphere Sandbox"
}
```

若仍返回 `alicloud-acs`，说明 ConfigMap 挂载路径、`ONYXCLAW_PROVIDER_CONFIG` 或
`ONYXCLAW_PROVIDER` 尚未生效。

再从 APP Pod 内验证 DNS。以下检查不输出密钥：

```bash
kubectl -n <namespace> exec deploy/onyxclaw-app -- \
  getent hosts <agentsphere-vpc-endpoint-hostname>

kubectl -n <namespace> exec deploy/onyxclaw-app -- \
  /opt/venv/bin/python -c \
  'import socket; print(socket.getaddrinfo("<agentsphere-vpc-endpoint-hostname>", 443))'
```

若以上命令返回名称解析错误，请依次检查：

1. AgentSphere PrivateLink/VPCE 是否已创建并绑定到 CCE 所在 VPC；
2. 私有 DNS Zone 是否关联该 VPC，CCE CoreDNS 能否转发或解析该域名；
3. Pod 子网路由表、安全组、网络 ACL 和 Kubernetes NetworkPolicy 是否允许访问目标端口；
4. `api.baseUrl` 是否包含了错误的域名、端口或协议。

当 DNS 和 TCP 路径正常后，重新执行创建 Sandbox。若此时仍失败，保留 APP 日志中的
`statusCode`、`requestId` 和脱敏后的 `E2B_BRIDGE_OPERATION_FAILED` 信息，交由
AgentSphere 团队核对 API Key、E2B 版本兼容性和 Template 权限。

## 6. 常见问题

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `providerId` 为 `alicloud-acs` | 使用了镜像默认 Profile | 挂载 Profile 并设置两个 `ONYXCLAW_PROVIDER*` 环境变量 |
| `[Errno -2] Name or service not known` | Endpoint DNS 不可解析，或仍使用 ACS `.svc` 地址 | 检查私有 DNS、VPCE 和 `api.baseUrl` |
| 启动即报 `missing provider secrets` | Profile 引用的环境变量未注入 | 核对 Profile 的 `*Env` 字段和 Secret `env` 映射 |
| Profile 校验拒绝 HTTP | 私网声明不完整 | 设置 `api.privateNetworkOnly: true` 和 `capabilities.vpc: true`，或改用 HTTPS |
| Sandbox 创建成功但 Gateway 不在线 | Channel URL 对 Sandbox 不可达 | 使用 Sandbox 可访问的 WSS/VPC 入口，并检查 DNS、TLS 和路由 |
| Files/Commands 连不上 | 残留 `E2B_ROUTE_DOMAIN` | 删除 ACS 专用变量，除非服务方要求专用路由 |

更多 Provider 字段说明见 [Provider 配置管理](./provider-config.md)，E2B 兼容接入的
通用验收流程见 [云厂商 Sandbox Provider 对接操作指南](./cloud-sandbox-provider-onboarding.md)。
