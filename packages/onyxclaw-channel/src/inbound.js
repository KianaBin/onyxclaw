export async function dispatchInboundEvent({
  event,
  accountId,
  cfg,
  channelRuntime,
  deliver,
  log,
}) {
  if (!channelRuntime) {
    throw new Error("OpenClaw channel runtime is unavailable");
  }

  const { senderId, chatId, text } = event.payload;
  const timestamp = Date.parse(event.timestamp);
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: "onyxclaw",
    accountId,
    peer: { kind: "direct", id: chatId },
  });
  const body = channelRuntime.reply.formatAgentEnvelope({
    channel: "OnyxClaw",
    from: senderId,
    timestamp,
    envelope: channelRuntime.reply.resolveEnvelopeFormatOptions(cfg),
    body: text,
  });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: "onyxclaw",
    accountId: route.accountId,
    messageId: event.eventId,
    timestamp,
    from: `onyxclaw:user:${senderId}`,
    sender: { id: senderId, name: senderId },
    conversation: { kind: "direct", id: chatId, label: chatId },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: { to: `onyxclaw:${chatId}` },
    message: {
      body,
      rawBody: text,
      bodyForAgent: text,
      commandBody: text,
    },
    extra: { ChatType: "direct", CommandAuthorized: true },
  });
  const storePath = channelRuntime.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  try {
    await channelRuntime.inbound.run({
      channel: "onyxclaw",
      accountId: route.accountId,
      raw: event,
      adapter: {
        ingest: () => ({
          id: event.eventId,
          timestamp,
          rawText: text,
          textForAgent: text,
          textForCommands: text,
          raw: event,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "onyxclaw",
          accountId: route.accountId,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({ to: `onyxclaw:${chatId}` }),
            deliver: async (payload) => {
              if (!payload.text) return { visibleReplySent: false };
              await deliver({
                text: payload.text,
                chatId,
                inReplyTo: event.eventId,
              });
              return { visibleReplySent: true };
            },
            onError: (error, info) => {
              log?.error?.(`OnyxClaw ${info.kind} reply failed: ${String(error)}`);
            },
          },
          replyPipeline: {},
          record: {
            onRecordError: (error) => {
              log?.error?.(`OnyxClaw session record failed: ${String(error)}`);
            },
          },
        }),
      },
    });
  } catch (error) {
    log?.error?.(`OnyxClaw inbound generation failed: ${String(error)}`);
    await deliver({
      text: "OpenClaw 生成回复失败，请检查 Sandbox 到模型服务的网络和模型配置。",
      chatId,
      inReplyTo: event.eventId,
    });
  }
}
