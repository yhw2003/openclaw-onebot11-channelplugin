import type { OneBot11MessageEvent } from "./types.js";

function normalizeId(value: string): string {
  return value.trim().replace(/^(onebot11|ob11):/i, "");
}

export function normalizeOneBot11MessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeId(trimmed);
}

export function looksLikeOneBot11TargetId(raw: string): boolean {
  const normalized = normalizeOneBot11MessagingTarget(raw);
  if (!normalized) {
    return false;
  }
  return /^(private|group):\d+$/i.test(normalized) || /^\d+$/.test(normalized);
}

export function parseOneBot11Target(raw: string):
  | { chatType: "private" | "group"; id: string }
  | { chatType: "private" | "group"; id: string; explicit: true } {
  const normalized = normalizeOneBot11MessagingTarget(raw);
  if (!normalized) {
    throw new Error("OneBot11 target is required");
  }

  const prefixed = normalized.match(/^(private|group):(\d+)$/i);
  if (prefixed) {
    return {
      chatType: prefixed[1].toLowerCase() as "private" | "group",
      id: prefixed[2],
      explicit: true,
    };
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error('OneBot11 target must be "<id>" or "private:<id>" or "group:<id>"');
  }
  return { chatType: "private", id: normalized };
}

export function renderOneBot11Text(message: OneBot11MessageEvent): string {
  const raw = message.raw_message?.trim();
  if (raw) {
    return raw;
  }
  if (typeof message.message === "string") {
    return message.message.trim();
  }
  if (Array.isArray(message.message)) {
    return message.message
      .map((segment) => {
        if (!segment || typeof segment !== "object") {
          return "";
        }
        const record = segment as { type?: string; data?: Record<string, unknown> };
        if (record.type === "text") {
          const text = record.data?.text;
          return typeof text === "string" ? text : "";
        }
        if (record.type === "at") {
          const qq = record.data?.qq;
          if (typeof qq === "string" || typeof qq === "number") {
            return `@${qq}`;
          }
          return "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

export function parseOneBot11InboundEvent(
  payload: unknown,
):
  | {
      ok: true;
      chatType: "private" | "group";
      chatId: string;
      senderId: string;
      senderName?: string;
      messageId: string;
      timestampMs: number;
      text: string;
      raw: OneBot11MessageEvent;
      wasMentioned: boolean;
    }
  | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "not an object" };
  }

  const event = payload as OneBot11MessageEvent;
  if (event.post_type !== "message") {
    return { ok: false, reason: "unsupported post_type" };
  }
  if (event.sub_type === "group_increase" || event.sub_type === "group_decrease") {
    return { ok: false, reason: "non-message subtype" };
  }

  const chatType = event.message_type === "group" ? "group" : "private";
  const senderIdRaw = event.user_id;
  const senderId = senderIdRaw == null ? "" : String(senderIdRaw).trim();
  if (!senderId) {
    return { ok: false, reason: "missing sender id" };
  }

  const chatIdRaw = chatType === "group" ? event.group_id : event.user_id;
  const chatId = chatIdRaw == null ? "" : String(chatIdRaw).trim();
  if (!chatId) {
    return { ok: false, reason: "missing chat id" };
  }

  const text = renderOneBot11Text(event);
  if (!text) {
    return { ok: false, reason: "empty message" };
  }

  const messageId = event.message_id == null ? "" : String(event.message_id);
  const timestampSec = typeof event.time === "number" ? event.time : Math.floor(Date.now() / 1000);
  const timestampMs = timestampSec * 1000;
  const senderName = event.sender?.card || event.sender?.nickname || undefined;
  const selfId = event.self_id == null ? "" : String(event.self_id);
  const rawMessage = typeof event.raw_message === "string" ? event.raw_message : "";
  const mentionToken = selfId ? `[CQ:at,qq=${selfId}]` : "";
  const wasMentioned = Boolean(mentionToken && rawMessage.includes(mentionToken));

  return {
    ok: true,
    chatType,
    chatId,
    senderId,
    senderName,
    messageId: messageId || `${chatType}:${chatId}:${timestampSec}`,
    timestampMs,
    text,
    raw: event,
    wasMentioned,
  };
}
