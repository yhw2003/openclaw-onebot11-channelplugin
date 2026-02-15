import type { ReplyPayload, ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { normalizeOneBot11MessagingTarget } from "../normalize.js";
import { sendFileOneBot11 } from "./file.js";
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
  try {
    await sendFileOneBot11(params.target, params.mediaUrl, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });

    // For onebot11, file upload is a separate action; send caption separately to preserve message body.
    if (params.text?.trim()) {
      const captionResult = await sendMessageOneBot11(params.target, params.text, {
        cfg: params.cfg,
        accountId: params.accountId ?? undefined,
        replyToId: params.replyToId ?? undefined,
      });
      return { channel: "onebot11", ...captionResult };
    }

    return {
      channel: "onebot11",
      messageId: `file:${Date.now()}`,
      chatId: params.target,
    };
  } catch {
    const fallback = attachmentFallbackText(params.text ?? "", params.mediaUrl);
    const result = await sendMessageOneBot11(params.target, fallback, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      replyToId: params.replyToId ?? undefined,
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
  const text = params.payload.text ?? "";
  const mediaUrls = params.payload.mediaUrls?.length
    ? params.payload.mediaUrls
    : params.payload.mediaUrl
      ? [params.payload.mediaUrl]
      : [];

  if (mediaUrls.length === 0) {
    const result = await sendMessageOneBot11(params.target, text, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      replyToId: params.replyToId ?? undefined,
    });
    return { channel: "onebot11", ...result };
  }

  let last: OutboundResult | null = null;
  for (let index = 0; index < mediaUrls.length; index += 1) {
    const url = mediaUrls[index];
    if (!url) {
      continue;
    }
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
    return last;
  }

  const result = await sendMessageOneBot11(params.target, text, {
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
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
    const target = to;
    const result = await sendMessageOneBot11(target, text, {
      accountId: accountId ?? undefined,
      cfg,
      replyToId: replyToId ?? undefined,
    });
    return { channel: "onebot11", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
    const target = to;
    if (!mediaUrl) {
      const result = await sendMessageOneBot11(target, text, {
        accountId: accountId ?? undefined,
        cfg,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "onebot11", ...result };
    }

    return await sendMediaWithFallback({
      cfg,
      target,
      text,
      mediaUrl,
      accountId,
      replyToId,
    });
  },
  sendPayload: async ({ cfg, to, payload, accountId, replyToId }) => {
    const target = to;
    return await sendPayloadOneBot11({
      cfg,
      target,
      payload,
      accountId,
      replyToId,
    });
  },
};
