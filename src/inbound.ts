import {
  createReplyPrefixOptions,
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedOneBot11Account } from "./types.js";
import { getOneBotRuntime } from "./runtime.js";

const CHANNEL_ID = "onebot11" as const;

function normalizeAllowEntry(raw: string): string {
  return raw.trim().replace(/^(onebot11|ob11):/i, "").toLowerCase();
}

function normalizeAllowlist(entries: Array<string | number>): string[] {
  return entries
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => normalizeAllowEntry(entry));
}

function matchAllowlist(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeAllowEntry(senderId);
  return allowFrom.some((entry) => normalizeAllowEntry(entry) === normalizedSender);
}

function dedupeAllowlist(entries: string[]): string[] {
  return Array.from(new Set(entries));
}

async function deliverOneBot11Reply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  chatType: "private" | "group";
  chatId: string;
  accountId: string;
  cfg: OpenClawConfig;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const { payload, chatType, chatId, accountId, cfg, statusSink } = params;
  const text = payload.text?.trim() ?? "";
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (!text && mediaList.length === 0) {
    return;
  }

  const mediaBlock = mediaList.filter(Boolean).map((url) => `Attachment: ${url}`).join("\n");
  const merged = text ? (mediaBlock ? `${text}\n\n${mediaBlock}` : text) : mediaBlock;
  const to = `${chatType}:${chatId}`;

  const { sendMessageOneBot11 } = await import("./send.js");
  await sendMessageOneBot11(to, merged, {
    accountId,
    cfg,
    replyToId: payload.replyToId,
  });
  statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleOneBot11Inbound(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedOneBot11Account;
  event: {
    chatType: "private" | "group";
    chatId: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    timestampMs: number;
    text: string;
    wasMentioned: boolean;
  };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { cfg, runtime, account, event, statusSink } = params;
  const core = getOneBotRuntime();

  const rawBody = event.text.trim();
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: event.timestampMs });

  const isGroup = event.chatType === "group";
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const configAllowFrom = normalizeAllowlist(account.config.allowFrom ?? []);
  const configGroupAllowFrom = normalizeAllowlist(account.config.groupAllowFrom ?? []);
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllow = normalizeAllowlist(storeAllowFrom.map((entry) => String(entry)));
  const effectiveAllowFrom = dedupeAllowlist([...configAllowFrom, ...storeAllow]);
  const effectiveGroupAllow = dedupeAllowlist(configGroupAllowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, cfg);
  const senderAllowedForCommands = isGroup
    ? groupPolicy === "open" || matchAllowlist(event.chatId, effectiveGroupAllow)
    : matchAllowlist(event.senderId, effectiveAllowFrom);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (isGroup ? effectiveGroupAllow : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      runtime.log?.(`onebot11: drop DM sender ${event.senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = matchAllowlist(event.senderId, effectiveAllowFrom);
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: event.senderId,
            meta: { name: event.senderName },
          });
          if (created) {
            try {
              const { sendMessageOneBot11 } = await import("./send.js");
              await sendMessageOneBot11(
                `private:${event.senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your OneBot11 user id: ${event.senderId}`,
                  code,
                }),
                {
                  accountId: account.accountId,
                  cfg,
                },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (error) {
              runtime.error?.(
                `onebot11 pairing reply failed for ${event.senderId}: ${String(error)}`,
              );
            }
          }
        }
        runtime.log?.(`onebot11: drop DM sender ${event.senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  } else {
    if (groupPolicy === "disabled") {
      runtime.log?.(`onebot11: drop group ${event.chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy !== "open" && !matchAllowlist(event.chatId, effectiveGroupAllow)) {
      runtime.log?.(`onebot11: drop unauthorized group ${event.chatId}`);
      return;
    }
  }

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: event.senderId,
    });
    return;
  }

  const requireMention = account.config.requireMention ?? true;
  if (
    isGroup &&
    requireMention &&
    !event.wasMentioned &&
    !(allowTextCommands && hasControlCommand)
  ) {
    runtime.log?.(`onebot11: drop group ${event.chatId} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? event.chatId : event.senderId,
    },
  });

  const fromLabel = isGroup
    ? `group:${event.chatId}`
    : event.senderName || `user:${event.senderId}`;
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "OneBot11",
    from: fromLabel,
    timestamp: event.timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `onebot11:group:${event.chatId}` : `onebot11:${event.senderId}`,
    To: `onebot11:${event.chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: event.senderName,
    SenderId: event.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? event.wasMentioned : undefined,
    MessageSid: event.messageId,
    Timestamp: event.timestampMs,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `onebot11:${event.chatId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      runtime.error?.(`onebot11: failed updating session meta: ${String(error)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverOneBot11Reply({
          payload: payload as {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
            replyToId?: string;
          },
          chatType: event.chatType,
          chatId: event.chatId,
          accountId: account.accountId,
          cfg,
          statusSink,
        });
      },
      onError: (error, info) => {
        runtime.error?.(`onebot11 ${info.kind} reply failed: ${String(error)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
