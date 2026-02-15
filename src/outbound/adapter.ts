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
  to: string;
  text: string;
  mediaUrl: string;
  accountId?: string | null;
  replyToId?: string | null;
}): Promise<OutboundResult> {
  try {
    await sendFileOneBot11(params.to, params.mediaUrl, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });

    // For onebot11, file upload is a separate action; send caption separately to preserve message body.
    if (params.text?.trim()) {
      const captionResult = await sendMessageOneBot11(params.to, params.text, {
        cfg: params.cfg,
        accountId: params.accountId ?? undefined,
        replyToId: params.replyToId ?? undefined,
      });
      return { channel: "onebot11", ...captionResult };
    }

    return {
      channel: "onebot11",
      messageId: `file:${Date.now()}`,
      chatId: params.to,
    };
  } catch {
    const fallback = attachmentFallbackText(params.text ?? "", params.mediaUrl);
    const result = await sendMessageOneBot11(params.to, fallback, {
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      replyToId: params.replyToId ?? undefined,
    });
    return { channel: "onebot11", ...result };
  }
}

async function sendPayloadOneBot11(params: {
  cfg: SendPayloadCtx["cfg"];
  to: string;
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
    const result = await sendMessageOneBot11(params.to, text, {
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
      to: params.to,
      text: caption,
      mediaUrl: url,
      accountId: params.accountId,
      replyToId: params.replyToId,
    });
  }

  if (last) {
    return last;
  }

  const result = await sendMessageOneBot11(params.to, text, {
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
    const normalized = normalizeOneBot11MessagingTarget(to ?? "");
    if (!normalized) {
      return {
        ok: false,
        error: new Error("Delivering to OneBot11 requires --to <id|private:id|group:id>"),
      };
    }
    return { ok: true, to: normalized };
  },
  sendText: async ({ to, text, accountId, replyToId, cfg }) => {
    const result = await sendMessageOneBot11(to, text, {
      accountId: accountId ?? undefined,
      cfg,
      replyToId: replyToId ?? undefined,
    });
    return { channel: "onebot11", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
    if (!mediaUrl) {
      const result = await sendMessageOneBot11(to, text, {
        accountId: accountId ?? undefined,
        cfg,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "onebot11", ...result };
    }

    return await sendMediaWithFallback({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      replyToId,
    });
  },
  sendPayload: async ({ cfg, to, payload, accountId, replyToId }) => {
    return await sendPayloadOneBot11({
      cfg,
      to,
      payload,
      accountId,
      replyToId,
    });
  },
};
