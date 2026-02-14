import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createReplyPrefixOptions,
  DEFAULT_GROUP_HISTORY_LIMIT,
  logInboundDrop,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
  type HistoryEntry,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedOneBot11Account } from "./types.js";
import { getOneBotRuntime } from "./runtime.js";

const CHANNEL_ID = "onebot11" as const;

type OneBot11HistoryStrategy = "recent" | "ai-related-only";

type OneBot11PendingHistoryEntry = HistoryEntry & {
  imageUrls?: string[];
  imagePaths?: string[];
  aiRelated?: boolean;
};

type OneBot11MediaEntry = {
  path?: string;
  url?: string;
  type?: string;
};

const groupHistories = new Map<string, OneBot11PendingHistoryEntry[]>();

function normalizeAllowEntry(raw: string): string {
  return raw.trim().replace(/^(onebot11|ob11):/i, "").toLowerCase();
}

function normalizeAllowlist(entries: Array<string | number>): string[] {
  return entries
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => normalizeAllowEntry(entry));
}

function dedupeAllowlist(entries: string[]): string[] {
  return Array.from(new Set(entries.map((entry) => normalizeAllowEntry(entry)).filter(Boolean)));
}

function matchAllowlist(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeAllowEntry(senderId);
  return allowFrom.some((entry) => normalizeAllowEntry(entry) === normalizedSender);
}

function toImageLikeType(value: string | undefined): string {
  if (!value) {
    return "image/unknown";
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const ext = trimmed.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
    switch (ext) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "bmp":
        return "image/bmp";
      default:
        return "image/unknown";
    }
  }

  const ext = trimmed.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "image/unknown";
  }
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function collectImageMediaFromEvent(event: {
  imageUrls?: string[];
  imagePaths?: string[];
}): OneBot11MediaEntry[] {
  const urls = dedupeStrings(event.imageUrls ?? []);
  const paths = dedupeStrings(event.imagePaths ?? []);
  return [
    ...urls.map((url) => ({ url, type: toImageLikeType(url) })),
    ...paths.map((path) => ({ path, type: toImageLikeType(path) })),
  ];
}

function collectHistoryMediaEntries(entries: OneBot11PendingHistoryEntry[]): OneBot11MediaEntry[] {
  const media: OneBot11MediaEntry[] = [];
  for (const entry of entries) {
    for (const url of dedupeStrings(entry.imageUrls ?? [])) {
      media.push({ url, type: toImageLikeType(url) });
    }
    for (const path of dedupeStrings(entry.imagePaths ?? [])) {
      media.push({ path, type: toImageLikeType(path) });
    }
  }
  return media;
}

function buildMediaPayload(mediaEntries: OneBot11MediaEntry[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const filtered = mediaEntries.filter((entry) => entry.path || entry.url);
  if (filtered.length === 0) {
    return {};
  }
  const first = filtered[0];
  const mediaPaths = filtered.map((entry) => entry.path ?? entry.url ?? "").filter(Boolean);
  const mediaUrls = filtered.map((entry) => entry.url ?? entry.path ?? "").filter(Boolean);
  const mediaTypes = filtered.map((entry) => entry.type ?? "image/unknown");

  return {
    MediaPath: first.path ?? first.url,
    MediaType: first.type,
    MediaUrl: first.url ?? first.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

function isAiRelatedHistoryEntry(entry: OneBot11PendingHistoryEntry): boolean {
  return entry.aiRelated === true;
}

function selectHistoryEntriesByStrategy(
  entries: OneBot11PendingHistoryEntry[],
  strategy: OneBot11HistoryStrategy,
): OneBot11PendingHistoryEntry[] {
  if (strategy === "ai-related-only") {
    return entries.filter((entry) => isAiRelatedHistoryEntry(entry));
  }
  return entries;
}

function buildHistoryMapForStrategy(params: {
  entries: OneBot11PendingHistoryEntry[];
  historyKey: string;
  strategy: OneBot11HistoryStrategy;
}): Map<string, HistoryEntry[]> {
  const out = new Map<string, HistoryEntry[]>();
  out.set(params.historyKey, selectHistoryEntriesByStrategy(params.entries, params.strategy));
  return out;
}

function formatHistoryEntry(params: {
  core: ReturnType<typeof getOneBotRuntime>;
  envelopeOptions: ReturnType<ReturnType<typeof getOneBotRuntime>["channel"]["reply"]["resolveEnvelopeFormatOptions"]>;
  historyChatId: string;
  entry: HistoryEntry;
}): string {
  return params.core.channel.reply.formatAgentEnvelope({
    channel: "OneBot11",
    from: params.entry.sender,
    timestamp: params.entry.timestamp,
    envelope: params.envelopeOptions,
    body: `${params.entry.body}${params.entry.messageId ? ` [id:${params.entry.messageId} chat:${params.historyChatId}]` : ""}`,
  });
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
    images?: Array<{ index: number; source: "segment" | "cq"; url?: string; path?: string }>;
    imageUrls?: string[];
    imagePaths?: string[];
  };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { cfg, runtime, account, event, statusSink } = params;
  const core = getOneBotRuntime();

  const rawBody = event.text.trim();
  const eventMediaEntries = collectImageMediaFromEvent(event);
  if (!rawBody && eventMediaEntries.length === 0) {
    return;
  }

  statusSink?.({ lastInboundAt: event.timestampMs });

  const isGroup = event.chatType === "group";
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const configAllowFrom = normalizeAllowlist(account.config.allowFrom ?? []);
  const configGroupAllowFrom = normalizeAllowlist(account.config.groupAllowFrom ?? []);
  const configMentionAllowFrom = normalizeAllowlist(account.config.mentionAllowFrom ?? []);
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllow = normalizeAllowlist(storeAllowFrom.map((entry) => String(entry)));
  const effectiveAllowFrom = dedupeAllowlist([...configAllowFrom, ...storeAllow]);
  const effectiveGroupAllow = dedupeAllowlist(configGroupAllowFrom);
  const effectiveMentionAllow = dedupeAllowlist(configMentionAllowFrom);

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
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup,
    requireMention,
    canDetectMention: isGroup,
    wasMentioned: event.wasMentioned,
    hasAnyMention: event.wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });

  const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  const historyStrategy: OneBot11HistoryStrategy = account.config.historyStrategy ?? "recent";
  const historyKey = event.chatId;
  const historySender = isGroup
    ? (event.senderName?.trim() || `user:${event.senderId}`)
    : (event.senderName?.trim() || `dm:${event.senderId}`);
  const historyEntry: OneBot11PendingHistoryEntry | null =
    isGroup && (rawBody || eventMediaEntries.length > 0)
      ? {
          sender: historySender,
          body: rawBody || "[Image]",
          timestamp: event.timestampMs,
          messageId: event.messageId,
          imageUrls: dedupeStrings(event.imageUrls ?? []),
          imagePaths: dedupeStrings(event.imagePaths ?? []),
          aiRelated: mentionGate.effectiveWasMentioned || (allowTextCommands && hasControlCommand),
        }
      : null;

  if (isGroup && requireMention && mentionGate.shouldSkip) {
    runtime.log?.(`onebot11: drop group ${event.chatId} (no mention)`);
    recordPendingHistoryEntryIfEnabled({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: historyEntry,
    });
    return;
  }

  if (
    isGroup &&
    mentionGate.effectiveWasMentioned &&
    effectiveMentionAllow.length > 0 &&
    !matchAllowlist(event.senderId, effectiveMentionAllow)
  ) {
    runtime.log?.(`onebot11: drop group ${event.chatId} (mention sender not allowed)`);
    recordPendingHistoryEntryIfEnabled({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: historyEntry,
    });
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
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
  let body = core.channel.reply.formatAgentEnvelope({
    channel: "OneBot11",
    from: fromLabel,
    timestamp: event.timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody || "[Image]",
  });

  const selectedHistoryEntries =
    isGroup && historyLimit > 0
      ? selectHistoryEntriesByStrategy(groupHistories.get(historyKey) ?? [], historyStrategy)
      : [];
  const selectedHistoryMap = buildHistoryMapForStrategy({
    entries: selectedHistoryEntries,
    historyKey,
    strategy: historyStrategy,
  });
  if (isGroup && historyLimit > 0) {
    body = buildPendingHistoryContextFromMap({
      historyMap: selectedHistoryMap,
      historyKey,
      limit: historyLimit,
      currentMessage: body,
      formatEntry: (entry) =>
        formatHistoryEntry({
          core,
          envelopeOptions,
          historyChatId: historyKey,
          entry,
        }),
    });
  }

  const inboundHistory =
    isGroup && historyLimit > 0
      ? selectedHistoryEntries.map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const mediaPayload = buildMediaPayload([
    ...collectHistoryMediaEntries(selectedHistoryEntries),
    ...eventMediaEntries,
  ]);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    InboundHistory: inboundHistory,
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
    WasMentioned: isGroup ? mentionGate.effectiveWasMentioned : undefined,
    MessageSid: event.messageId,
    Timestamp: event.timestampMs,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `onebot11:${event.chatId}`,
    CommandAuthorized: commandAuthorized,
    ...mediaPayload,
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

  const { queuedFinal } = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
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

  if (!queuedFinal) {
    if (isGroup) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
      });
    }
    return;
  }

  if (isGroup) {
    clearHistoryEntriesIfEnabled({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
    });
  }
}
