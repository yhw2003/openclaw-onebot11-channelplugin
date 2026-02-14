import { describe, expect, it } from "vitest";
import {
  looksLikeOneBot11TargetId,
  normalizeOneBot11MessagingTarget,
  parseOneBot11InboundEvent,
  parseOneBot11Target,
} from "./normalize.js";

describe("onebot11 normalize", () => {
  it("normalizes messaging targets", () => {
    expect(normalizeOneBot11MessagingTarget(" onebot11:group:123 ")).toBe("group:123");
    expect(normalizeOneBot11MessagingTarget("ob11:456")).toBe("456");
    expect(normalizeOneBot11MessagingTarget("  ")).toBeUndefined();
  });

  it("validates target formats", () => {
    expect(looksLikeOneBot11TargetId("group:123")).toBe(true);
    expect(looksLikeOneBot11TargetId("private:456")).toBe(true);
    expect(looksLikeOneBot11TargetId("789")).toBe(true);
    expect(looksLikeOneBot11TargetId("foo")).toBe(false);
  });

  it("parses explicit and implicit targets", () => {
    expect(parseOneBot11Target("group:10001")).toEqual({
      chatType: "group",
      id: "10001",
      explicit: true,
    });
    expect(parseOneBot11Target("20002")).toEqual({
      chatType: "private",
      id: "20002",
    });
  });

  it("parses inbound private message event", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "private",
      time: 1710000000,
      self_id: 123456,
      user_id: 10086,
      message_id: 42,
      raw_message: "hello",
      sender: {
        nickname: "alice",
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.chatType).toBe("private");
    expect(parsed.chatId).toBe("10086");
    expect(parsed.senderId).toBe("10086");
    expect(parsed.senderName).toBe("alice");
    expect(parsed.text).toBe("hello");
    expect(parsed.wasMentioned).toBe(false);
    expect(parsed.images).toEqual([]);
    expect(parsed.imageUrls).toEqual([]);
    expect(parsed.imagePaths).toEqual([]);
  });

  it("parses inbound group message and detects mention", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "group",
      time: 1710001000,
      self_id: 123456,
      user_id: 10010,
      group_id: 777,
      message_id: 100,
      raw_message: "[CQ:at,qq=123456] hi",
      sender: {
        card: "bob",
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.chatType).toBe("group");
    expect(parsed.chatId).toBe("777");
    expect(parsed.senderId).toBe("10010");
    expect(parsed.wasMentioned).toBe(true);
  });

  it("extracts images from message segments", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "group",
      time: 1710001000,
      self_id: 123456,
      user_id: 10010,
      group_id: 777,
      message_id: 101,
      message: [
        { type: "image", data: { url: "https://example.com/a.png" } },
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { file: "./files/local.jpg" } },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.imageUrls).toEqual(["https://example.com/a.png"]);
    expect(parsed.imagePaths).toEqual(["./files/local.jpg"]);
    expect(parsed.images).toEqual([
      { index: 0, source: "segment", url: "https://example.com/a.png" },
      { index: 2, source: "segment", path: "./files/local.jpg" },
    ]);
  });

  it("extracts images from CQ raw message", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "group",
      time: 1710001000,
      self_id: 123456,
      user_id: 10010,
      group_id: 777,
      message_id: 102,
      raw_message:
        "[CQ:image,file=https://example.com/a.png] [CQ:image,file=./files/local.jpg] hi",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.imageUrls).toEqual(["https://example.com/a.png"]);
    expect(parsed.imagePaths).toEqual(["./files/local.jpg"]);
  });

  it("accepts image-only payload with empty text", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "private",
      time: 1710000001,
      self_id: 123456,
      user_id: 10086,
      message_id: 43,
      message: [{ type: "image", data: { url: "https://example.com/only.png" } }],
      raw_message: "",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.text).toBe("");
    expect(parsed.imageUrls).toEqual(["https://example.com/only.png"]);
  });

  it("detects mention from segments when raw message is absent", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "message",
      message_type: "group",
      time: 1710001000,
      self_id: 123456,
      user_id: 10010,
      group_id: 777,
      message_id: 103,
      raw_message: "",
      message: [
        { type: "at", data: { qq: "123456" } },
        { type: "image", data: { url: "https://example.com/a.png" } },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.wasMentioned).toBe(true);
    expect(parsed.imageUrls).toEqual(["https://example.com/a.png"]);
  });

  it("rejects non-message payloads", () => {
    const parsed = parseOneBot11InboundEvent({
      post_type: "notice",
    });
    expect(parsed).toEqual({ ok: false, reason: "unsupported post_type" });
  });
});
