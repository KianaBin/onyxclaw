# 在华为云 CCE 部署 OnyxClaw Cloud APP 并对接 AgentSphere

本文用于 POC 场景：将 OnyxClaw Cloud APP（例如 `app-v0.3.7`）部署到华为云
CCE，并通过 VPC 私网访问 AgentSphere 的 E2B 兼容 API。

AgentSphere 当前处于 POC 联调阶段，本文中的 Endpoint、模板、模型和密钥名称均使用
占位符。请向服务提供方确认实际值后替换，且不要将任何真实密钥提交到 Git。

## 部署前需要准备的参数

建议先把下表中的参数填入受控的部署记录或本地环境文件，再执行后续命令。带“敏感”
标记的值只能通过 Secret、Secret Manager 或临时环境变量注入，不能写入
`providers.agentsphere.json`、Deployment YAML 或 Git。

| 参数 | 用途 | 如何获取或生成 | 敏感性 |
| --- | --- | --- | --- |
| 华为云 Region、CCE 集群 ID/名称 | 确定集群和资源所在地域 | 在华为云控制台进入“云容器引擎 CCE > 集群管理”查看；Region 必须与 VPC/私网 Endpoint 的地域一致 | 普通 |
| CCE kubeconfig 或 kubectl context | 执行 `kubectl` 创建 ConfigMap、Secret 和更新 Deployment | CCE 集群详情页的“连接信息/ kubectl”下载临时 kubeconfig，或使用已有 context；下载后限制文件权限（如 `chmod 600`） | 高敏感 |
| Kubernetes namespace | 放置 APP、ConfigMap 和 Secret | 由部署规划确定；不存在时先执行 `kubectl create namespace <namespace>`，本文命令中的 `<namespace>` 均替换为该值 | 普通 |
| VPC ID、子网 ID、安全组 ID | 确保 CCE Pod 能访问 AgentSphere 私网入口 | 在“虚拟私有云 VPC > 我的 VPC/子网”和“虚拟私有云 VPC > 访问控制 > 安全组”查看；也可在 CCE 集群详情的网络配置中核对 | 普通 |
| AgentSphere 私网 Endpoint FQDN、端口、协议 | 填入 `api.baseUrl`，供 APP 调用 E2B 兼容 API | 向 AgentSphere 服务提供方申请或在其控制台的接入点/PrivateLink（VPCE）详情中复制；同时确认私有 DNS Zone 已关联 CCE 所在 VPC | 普通 |
| AgentSphere E2B API Key | 认证 Sandbox API 请求 | 在 AgentSphere 控制台的 API Keys/访问凭证页面创建，并确认作用域、地域和有效期 | 敏感 |
| AgentSphere Template ID | 指定预装 OpenClaw 和 Channel Plugin 的 Sandbox 模板 | 在 AgentSphere 控制台的 Templates/模板列表复制；向服务方确认模板版本、架构、默认用户、Gateway 端口和工作目录 | 普通 |
| 模型 Provider、Model ID、模型 API Key | 让 Sandbox 内的 OpenClaw 调用模型 | Provider/Model ID 由模型服务方提供；API Key 在对应模型平台的凭证页面创建。Model ID 写入 Profile，Key 只写入 Secret | Model Key 敏感 |
| OnyxClaw Channel 可达 URL（WSS） | 让 AgentSphere Sandbox 回连 Channel | 从 CCE 私网 ELB/DNS 配置获取可从 Sandbox 网络访问的 `wss://.../connect` 地址；不要使用 CCE `ClusterIP` 或 `*.svc.cluster.local` | URL 普通 |
| Channel signing secret | 校验 Sandbox 与 Channel 的握手签名 | 与 Channel 部署约定同一随机值；首次部署可本地生成 `openssl rand -hex 32`，然后仅写入 Kubernetes Secret | 敏感 |
| Cloud APP 镜像引用（建议 digest） | 填入 Deployment 的 `image` | 从发布记录或镜像仓库复制已验证的 `registry/path:tag@sha256:...`；私有仓库还要准备 `imagePullSecret` | 引用普通；仓库凭证敏感 |
| `openclaw-base-config.json` | 提供 OpenClaw 基础配置 | 依据目标模型和 Channel 准备，并保留字符串占位符 `__ONYXCLAW_MODEL_API_KEY__`；文件通过 Secret 挂载，不提交真实 Key | 可能含敏感配置 |

部署前至少用以下信息做一次网络核对：CCE Pod 所在 VPC/子网、安全组，AgentSphere
Endpoint 的 FQDN 和端口，私有 DNS Zone/VPCE 绑定关系，以及 Sandbox 到 Channel URL
的出站路由、DNS 和 TLS 可达性。Endpoint、Template、Model 和 Channel 的具体值无法
从本仓库推导，必须以 AgentSphere 服务方和网络管理员提供的值为准。

## 建立 CCE 到 AgentSphere 的 Channel WSS 访问路径

CCE 和 AgentSphere 是两个通过 VPC 对等连接互访的服务时，AgentSphere Sandbox 不能使用
CCE 的 `ClusterIP` 或 `*.svc.cluster.local` 地址。应在 CCE 集群外侧为 Cloud APP 的
Channel 端口建立一个仅绑定 CCE VPC 的私网 ELB，由 ELB 在 443 端口终止 TLS，再转发到
APP 的 `18890` 端口：

```text
AgentSphere Sandbox
  │  wss://channel.<private-domain>/connect:443
  ▼
CCE 私网 ELB（TLS 终止）
  │  HTTP/WebSocket 转发:18890
  ▼
onyxclaw-app Service
  │  targetPort: 18890
  ▼
Cloud APP 的 Channel WebSocket Server
```

### 1. 确认 APP Service 暴露 Channel 端口

Cloud APP 容器必须监听 `0.0.0.0:18890`，并由 Service 暴露同名端口。若现有 Service
没有 `channel` 端口，补充以下配置（`<namespace>` 替换为实际命名空间）：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: onyxclaw-app
  namespace: <namespace>
spec:
  type: ClusterIP
  selector:
    app: onyxclaw-app
  ports:
    - name: http
      port: 3000
      targetPort: 3000
    - name: channel
      port: 18890
      targetPort: 18890
```

### 2. 使用 CCE 私网 ELB 终止 TLS

建议为 Channel 单独创建一个 `LoadBalancer` Service，让 CCE 把 Service 绑定到私网
ELB。下面的配置表达端口和后端关系；`kubernetes.io/elb.*` annotation 的具体名称会
随 CCE 版本和 ELB 类型变化，应按当前 CCE 控制台或集群文档填写，重点是选择私网 ELB，
不要绑定公网 EIP：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: onyxclaw-channel-elb
  namespace: <namespace>
  annotations:
    kubernetes.io/elb.class: performance
    kubernetes.io/elb.subnet-id: <private-elb-subnet-id>
    # 如需固定私网地址，按 CCE 版本补充 kubernetes.io/elb.ip 或已有 ELB ID。
spec:
  type: LoadBalancer
  selector:
    app: onyxclaw-app
  ports:
    - name: https-channel
      port: 443
      targetPort: 18890
```

创建 Service 后，在 CCE 控制台“弹性负载均衡 ELB”中确认该私网 ELB 的 443 监听器：

1. 监听协议选择 HTTPS，绑定 `channel.<private-domain>` 对应的证书；
2. 后端服务器组指向 CCE 集群节点或 Service 自动生成的后端，后端端口为 `18890`；
3. 开启 WebSocket/长连接转发，并将空闲连接超时设置为不小于 Channel 的心跳和重连窗口；
4. ELB 只使用私网地址，安全组允许 AgentSphere VPC CIDR 访问 TCP 443。

如果 CCE 版本不支持通过 `LoadBalancer` Service 自动复用指定 ELB，也可以先在 ELB
控制台创建私网 ELB、HTTPS 443 监听器和后端组，再按 CCE 支持的 ELB ID annotation 将
该 ELB 绑定到 Service。不要改用 Ingress；本路径只需要 ELB 到 Service 的转发和 TLS
终止。

### 3. 配置 VPC 对等、私有 DNS 和安全策略

1. 在 CCE VPC 与 AgentSphere VPC 的对等连接两端分别配置对方 VPC CIDR 的路由，不能只
   创建 peering 而不配置路由表；
2. 为 `channel.<private-domain>` 创建私有 DNS 记录，解析到 CCE 私网 ELB 的地址，并将
   该私有 Zone 关联到 AgentSphere 所在 VPC；CCE CoreDNS 也必须能解析该 Zone；
3. CCE ELB/节点安全组允许来自 AgentSphere VPC CIDR 的 TCP 443，NetworkPolicy 允许
   AgentSphere 入口到 APP Service 的 `18890`；
4. 如果 AgentSphere 侧配置了出站 allowlist，将 `channel.<private-domain>:443` 加入；
5. 不要给该 Channel 入口绑定 EIP，也不要把域名解析到公网地址，除非 POC 明确要求走
   公网链路。

从 CCE Pod 侧只能验证 DNS、TCP 和 TLS 的一半路径；最终还应让 AgentSphere 团队从
Sandbox 内执行等价的 DNS/TLS/WebSocket 探测。CCE 侧可先执行：

```bash
kubectl -n <namespace> run wss-debug --rm -it --restart=Never \\
  --image=curlimages/curl -- \\
  curl -vk --http1.1 https://channel.<private-domain>/connect
```

返回 `400`、`401` 或应用层握手错误通常说明 TLS、DNS 和路由已经到达 APP；如果是
超时或名称解析失败，应先检查对等路由、私有 DNS、ELB 安全组和 NetworkPolicy。

### 4. 在 Provider Profile 中填写私网 WSS URL

完成以上入口后，将 Profile 中的 `channel.publicUrl` 填成 AgentSphere Sandbox 可解析的
私有域名，而不是 CCE Service DNS：

```json
{
  "channel": {
    "publicUrl": "wss://channel.<private-domain>/connect",
    "connectTimeoutMs": 120000,
    "signingSecretEnv": "HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET"
  }
}
```

这里的 `publicUrl` 虽然字段名带有 `public`，实际可以是 VPC 私网 WSS 地址；
`privateNetworkOnly: true` 和 `capabilities.vpc: true` 用于明确这一网络边界。Sandbox
创建后，APP 会把该 URL 写入运行时 `channels.onyxclaw.platformUrl`，Channel Plugin
随后从 AgentSphere VPC 发起 WSS 连接。

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
