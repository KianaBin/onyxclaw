export function runtimePresentation(config = {}) {
  const cloud = config.deploymentMode === "cloud";
  if (!cloud) {
    return {
      environmentLabel: "LOCAL MACOS",
      modeCopy: "连接这台 Mac 上的 OpenClaw，创建一只拥有专属性格的智能龙虾。",
    };
  }
  const providerLabel = config.providerName?.toUpperCase().replace(" AGENT SANDBOX", "") ||
    config.providerId?.toUpperCase() || "CLOUD SANDBOX";
  return {
    environmentLabel: `${providerLabel} · CLOUD`,
    modeCopy: "系统同时只存在一个客户。点击右上「重置新用户」即开始新会话（云端会自动释放 Sandbox）。",
  };
}

// Non-sensitive cloud provider summary rendered next to the mode copy. Values
// come from the Provider Registry and the
// /api/ui-config payload; they MUST NOT include any keys, tokens, or secrets.
export function cloudProviderPresentation(config = {}) {
  if (config.deploymentMode !== "cloud") return null;
  const region = config.region || null;
  const templateId = config.templateId || null;
  const gatewayPort = Number.isInteger(config.gatewayPort) ? config.gatewayPort : null;
  const e2bHost = config.e2bHost || null;
  const protocol = config.protocol || null;
  const capabilities = config.capabilities && typeof config.capabilities === "object"
    ? config.capabilities
    : null;
  if (
    !region && !templateId && gatewayPort === null &&
    !e2bHost && !protocol && !capabilities
  ) {
    return null;
  }
  return {
    region,
    templateId,
    gatewayPort,
    e2bHost,
    protocol,
    capabilities,
  };
}

export const acsClusterPresentation = cloudProviderPresentation;
