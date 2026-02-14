import type { OneBot11MessageEvent } from "./types.js";

type OneBot11MessageSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

export type OneBot11InboundImage = {
  index: number;
  source: "segment" | "cq";
  url?: string;
  path?: string;
};

function normalizeId(value: string): string {
  return value.trim().replace(/^(onebot11|ob11):/i, "");
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function resolveImageLocation(data: Record<string, unknown>): { url?: string; path?: string } {
  const url = asTrimmedString(data.url);
  if (url) {
    return { url };
  }

  const file = asTrimmedString(data.file);
  if (!file) {
    return {};
  }
  if (/^https?:\/\//i.test(file)) {
    return { url: file };
  }
  return { path: file };
}

function parseCqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key || !value) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function dedupeImages(images: OneBot11InboundImage[]): OneBot11InboundImage[] {
  const seen = new Set<string>();
  const deduped: OneBot11InboundImage[] = [];
  for (const image of images) {
    const key = `${image.url ?? ""}\u0000${image.path ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(image);
  }
  return deduped;
}

function extractImagesFromSegments(message: OneBot11MessageEvent): OneBot11InboundImage[] {
  if (!Array.isArray(message.message)) {
    return [];
  }

  const images: OneBot11InboundImage[] = [];
  for (let index = 0; index < message.message.length; index += 1) {
    const segment = message.message[index];
    if (!segment || typeof segment !== "object") {
      continue;
    }
    const record = segment as OneBot11MessageSegment;
    if (record.type !== "image") {
      continue;
    }
    const location = resolveImageLocation(record.data ?? {});
    if (!location.url && !location.path) {
      continue;
    }
    images.push({
      index,
      source: "segment",
      ...location,
    });
  }
  return images;
}

function extractImagesFromRawMessage(message: OneBot11MessageEvent): OneBot11InboundImage[] {
  const rawMessage = typeof message.raw_message === "string" ? message.raw_message : "";
  if (!rawMessage) {
    return [];
  }

  const images: OneBot11InboundImage[] = [];
  const matcher = /\[CQ:([^,\]]+)(?:,([^\]]*))?\]/g;
  let match: RegExpExecArray | null = null;
  let index = 0;
  while ((match = matcher.exec(rawMessage)) !== null) {
    const type = match[1]?.trim().toLowerCase();
    if (type !== "image") {
      index += 1;
      continue;
    }
    const params = parseCqParams(match[2] ?? "");
    const location = resolveImageLocation(params);
    if (location.url || location.path) {
      images.push({
        index,
        source: "cq",
        ...location,
      });
    }
    index += 1;
  }

  return images;
}

function extractInboundImages(message: OneBot11MessageEvent): OneBot11InboundImage[] {
  return dedupeImages([...extractImagesFromSegments(message), ...extractImagesFromRawMessage(message)]);
}

function detectMentionFromSegments(message: OneBot11MessageEvent, selfId: string): boolean {
  if (!selfId || !Array.isArray(message.message)) {
    return false;
  }
  return message.message.some((segment) => {
    if (!segment || typeof segment !== "object") {
      return false;
    }
    const record = segment as OneBot11MessageSegment;
    if (record.type !== "at") {
      return false;
    }
    const qq = asTrimmedString(record.data?.qq);
    return qq === selfId;
  });
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
        const record = segment as OneBot11MessageSegment;
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
      images: OneBot11InboundImage[];
      imageUrls: string[];
      imagePaths: string[];
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
  const images = extractInboundImages(event);
  if (!text && images.length === 0) {
    return { ok: false, reason: "empty message" };
  }

  const messageId = event.message_id == null ? "" : String(event.message_id);
  const timestampSec = typeof event.time === "number" ? event.time : Math.floor(Date.now() / 1000);
  const timestampMs = timestampSec * 1000;
  const senderName = event.sender?.card || event.sender?.nickname || undefined;
  const selfId = event.self_id == null ? "" : String(event.self_id);
  const rawMessage = typeof event.raw_message === "string" ? event.raw_message : "";
  const mentionToken = selfId ? `[CQ:at,qq=${selfId}]` : "";
  const wasMentioned =
    Boolean(mentionToken && rawMessage.includes(mentionToken)) ||
    detectMentionFromSegments(event, selfId);

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
    images,
    imageUrls: images
      .map((image) => image.url)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
    imagePaths: images
      .map((image) => image.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  };
}
