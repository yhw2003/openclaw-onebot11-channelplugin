import type { ReplyPayload, ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { normalizeOneBot11MessagingTarget } from "../normalize.js";
import { sendFileOneBot11 } from "./file.js";
import {
  logOutboundDebug,
  logOutboundError,
  summarizeMediaSource,
  summarizeTarget,
} from "./logging.js";
import { sendMessageOneBot11 } from "./text.js";

type SendMediaCtx = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type SendPayloadCtx = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type OutboundResult = Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>>;

function attachmentFallbackText(text: string, mediaUrl: string): string {
  return text?.trim() ? `${text}\n\nAttachment: ${mediaUrl}` : `Attachment: ${mediaUrl}`;
}

async function sendMediaWithFallback(params: {
  cfg: SendMediaCtx["cfg"];
  target: string;
  text: string;
  mediaUrl: string;
  accountId?: string | null;
  replyToId?: string | null;
}): Promise<OutboundResult> {
  const startedAt = Date.now();
  logOutboundDebug("adapter.sendMediaWithFallback.start", {
    target: summarizeTarget(params.target),
    media: summarizeMediaSource(params.mediaUrl),
    textChars: params.text.length,
    hasReplyTo: Boolean(params.replyToId?.trim()),
    accountId: params.accountId ?? undefined,
  });
  try {
    await sendFileOneBot11(params.target, params.mediaUrl, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
    logOutboundDebug("adapter.sendMediaWithFallback.upload_ok", {
      target: summarizeTarget(params.target),
      media: summarizeMediaSource(params.mediaUrl),
      elapsedMs: Date.now() - startedAt,
    });

    // For onebot11, file upload is a separate action; send caption separately to preserve message body.
    if (params.text?.trim()) {
      const captionResult = await sendMessageOneBot11(params.target, params.text, {
        cfg: params.cfg,
        accountId: params.accountId ?? undefined,
        replyToId: params.replyToId ?? undefined,
      });
      logOutboundDebug("adapter.sendMediaWithFallback.caption_sent", {
        target: summarizeTarget(params.target),
        media: summarizeMediaSource(params.mediaUrl),
        messageId: captionResult.messageId,
        elapsedMs: Date.now() - startedAt,
      });
      return { channel: "onebot11", ...captionResult };
    }

    const messageId = `file:${Date.now()}`;
    logOutboundDebug("adapter.sendMediaWithFallback.done", {
      target: summarizeTarget(params.target),
      media: summarizeMediaSource(params.mediaUrl),
      messageId,
      elapsedMs: Date.now() - startedAt,
    });
    return {
      channel: "onebot11",
      messageId,
      chatId: params.target,
    };
  } catch (error) {
    logOutboundError("adapter.sendMediaWithFallback.upload_failed", error, {
      target: summarizeTarget(params.target),
      media: summarizeMediaSource(params.mediaUrl),
      elapsedMs: Date.now() - startedAt,
    });
    const fallback = attachmentFallbackText(params.text ?? "", params.mediaUrl);
    const fallbackStartedAt = Date.now();
    const result = await sendMessageOneBot11(params.target, fallback, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      replyToId: params.replyToId ?? undefined,
    });
    logOutboundDebug("adapter.sendMediaWithFallback.fallback_sent", {
      target: summarizeTarget(params.target),
      media: summarizeMediaSource(params.mediaUrl),
      messageId: result.messageId,
      fallbackTextChars: fallback.length,
      fallbackElapsedMs: Date.now() - fallbackStartedAt,
    });
    return { channel: "onebot11", ...result };
  }
}

async function sendPayloadOneBot11(params: {
  cfg: SendPayloadCtx["cfg"];
  target: string;
  payload: ReplyPayload;
  accountId?: string | null;
  replyToId?: string | null;
}): Promise<OutboundResult> {
  const startedAt = Date.now();
  const text = params.payload.text ?? "";
  const mediaUrls = params.payload.mediaUrls?.length
    ? params.payload.mediaUrls
    : params.payload.mediaUrl
      ? [params.payload.mediaUrl]
      : [];
  logOutboundDebug("adapter.sendPayload.start", {
    target: summarizeTarget(params.target),
    accountId: params.accountId ?? undefined,
    textChars: text.length,
    mediaCount: mediaUrls.length,
    hasReplyTo: Boolean(params.replyToId?.trim()),
  });

  if (mediaUrls.length === 0) {
    const result = await sendMessageOneBot11(params.target, text, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      replyToId: params.replyToId ?? undefined,
    });
    logOutboundDebug("adapter.sendPayload.done_text_only", {
      target: summarizeTarget(params.target),
      messageId: result.messageId,
      elapsedMs: Date.now() - startedAt,
    });
    return { channel: "onebot11", ...result };
  }

  let last: OutboundResult | null = null;
  for (let index = 0; index < mediaUrls.length; index += 1) {
    const url = mediaUrls[index];
    if (!url) {
      continue;
    }
    logOutboundDebug("adapter.sendPayload.media_item", {
      target: summarizeTarget(params.target),
      index: index + 1,
      total: mediaUrls.length,
      media: summarizeMediaSource(url),
    });
    const caption = index === 0 ? text : "";
    last = await sendMediaWithFallback({
      cfg: params.cfg,
      target: params.target,
      text: caption,
      mediaUrl: url,
      accountId: params.accountId,
      replyToId: params.replyToId,
    });
  }

  if (last) {
    logOutboundDebug("adapter.sendPayload.done_media", {
      target: summarizeTarget(params.target),
      mediaCount: mediaUrls.length,
      messageId: last.messageId,
      elapsedMs: Date.now() - startedAt,
    });
    return last;
  }

  const result = await sendMessageOneBot11(params.target, text, {
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
  });
  logOutboundDebug("adapter.sendPayload.done_fallback_text", {
    target: summarizeTarget(params.target),
    messageId: result.messageId,
    elapsedMs: Date.now() - startedAt,
  });
  return { channel: "onebot11", ...result };
}

export const onebot11Outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "markdown",
  textChunkLimit: 2000,
  resolveTarget: ({ to }) => {
    const target = normalizeOneBot11MessagingTarget(to ?? "");
    if (!target) {
      return {
        ok: false,
        error: new Error("Delivering to OneBot11 requires --target <id|private:id|group:id>"),
      };
    }
    return { ok: true, to: target };
  },
  sendText: async ({ to, text, accountId, replyToId, cfg }) => {
    const startedAt = Date.now();
    const target = to;
    logOutboundDebug("adapter.sendText.start", {
      target: summarizeTarget(target),
      accountId: accountId ?? undefined,
      textChars: text.length,
      hasReplyTo: Boolean(replyToId?.trim()),
    });
    try {
      const result = await sendMessageOneBot11(target, text, {
        accountId: accountId ?? undefined,
        cfg,
        replyToId: replyToId ?? undefined,
      });
      logOutboundDebug("adapter.sendText.done", {
        target: summarizeTarget(target),
        messageId: result.messageId,
        elapsedMs: Date.now() - startedAt,
      });
      return { channel: "onebot11", ...result };
    } catch (error) {
      logOutboundError("adapter.sendText.failed", error, {
        target: summarizeTarget(target),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
    const startedAt = Date.now();
    const target = to;
    logOutboundDebug("adapter.sendMedia.start", {
      target: summarizeTarget(target),
      accountId: accountId ?? undefined,
      media: summarizeMediaSource(mediaUrl ?? undefined),
      textChars: text.length,
      hasReplyTo: Boolean(replyToId?.trim()),
    });
    if (!mediaUrl) {
      try {
        const result = await sendMessageOneBot11(target, text, {
          accountId: accountId ?? undefined,
          cfg,
          replyToId: replyToId ?? undefined,
        });
        logOutboundDebug("adapter.sendMedia.done_without_media", {
          target: summarizeTarget(target),
          messageId: result.messageId,
          elapsedMs: Date.now() - startedAt,
        });
        return { channel: "onebot11", ...result };
      } catch (error) {
        logOutboundError("adapter.sendMedia.failed_without_media", error, {
          target: summarizeTarget(target),
          elapsedMs: Date.now() - startedAt,
        });
        throw error;
      }
    }

    try {
      const result = await sendMediaWithFallback({
        cfg,
        target,
        text,
        mediaUrl,
        accountId,
        replyToId,
      });
      logOutboundDebug("adapter.sendMedia.done", {
        target: summarizeTarget(target),
        media: summarizeMediaSource(mediaUrl),
        messageId: result.messageId,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      logOutboundError("adapter.sendMedia.failed", error, {
        target: summarizeTarget(target),
        media: summarizeMediaSource(mediaUrl),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  sendPayload: async ({ cfg, to, payload, accountId, replyToId }) => {
    const startedAt = Date.now();
    const target = to;
    logOutboundDebug("adapter.sendPayload.entry", {
      target: summarizeTarget(target),
      accountId: accountId ?? undefined,
      hasText: Boolean(payload.text?.trim()),
      hasMedia: Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0,
      mediaCount: payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0),
      hasReplyTo: Boolean(replyToId?.trim()),
    });
    try {
      const result = await sendPayloadOneBot11({
        cfg,
        target,
        payload,
        accountId,
        replyToId,
      });
      logOutboundDebug("adapter.sendPayload.done", {
        target: summarizeTarget(target),
        messageId: result.messageId,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      logOutboundError("adapter.sendPayload.failed", error, {
        target: summarizeTarget(target),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
};
