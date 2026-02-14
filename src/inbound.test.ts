import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleOneBot11Inbound } from "./inbound.js";
import { setOneBotRuntime } from "./runtime.js";
import type { ResolvedOneBot11Account } from "./types.js";

const mockReadAllowFromStore = vi.fn(async () => []);
const mockShouldHandleTextCommands = vi.fn(() => false);
const mockHasControlCommand = vi.fn(() => false);
const mockResolveAgentRoute = vi.fn(() => ({
  agentId: "agent-main",
  accountId: "default",
  sessionKey: "session:onebot11:test",
}));
const mockResolveStorePath = vi.fn(() => "/tmp/openclaw-onebot11-session.json");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({}));
const mockFormatAgentEnvelope = vi.fn((payload: { body: string }) => payload.body);
const mockFinalizeInboundContext = vi.fn((ctx) => ctx);
const mockRecordInboundSession = vi.fn(async () => undefined);
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({ queuedFinal: true }));
const mockFetchRemoteMedia = vi.fn(async ({ url }: { url: string }) => ({
  buffer: Buffer.from(`image:${url}`),
  contentType: "image/png",
  fileName: "image.png",
}));
const mockSaveMediaBuffer = vi.fn(async (_buffer: Buffer, contentType?: string) => ({
  path: "/tmp/openclaw/onebot11-inbound/image.png",
  contentType: contentType ?? "image/png",
}));

function createMockRuntime(): PluginRuntime {
  return {
    channel: {
      pairing: {
        readAllowFromStore: mockReadAllowFromStore,
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      commands: {
        shouldHandleTextCommands: mockShouldHandleTextCommands,
      },
      text: {
        hasControlCommand: mockHasControlCommand,
      },
      routing: {
        resolveAgentRoute: mockResolveAgentRoute,
      },
      session: {
        resolveStorePath: mockResolveStorePath,
        readSessionUpdatedAt: mockReadSessionUpdatedAt,
        recordInboundSession: mockRecordInboundSession,
      },
      media: {
        fetchRemoteMedia: mockFetchRemoteMedia,
        saveMediaBuffer: mockSaveMediaBuffer,
      },
      reply: {
        resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions,
        formatAgentEnvelope: mockFormatAgentEnvelope,
        finalizeInboundContext: mockFinalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher,
      },
    },
  } as unknown as PluginRuntime;
}

function createAccount(
  overrides: Partial<ResolvedOneBot11Account["config"]> = {},
): ResolvedOneBot11Account {
  return {
    accountId: "default",
    enabled: true,
    name: "default",
    endpoint: "http://localhost:3000",
    accessTokenSource: "none",
    config: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groupAllowFrom: ["*"],
      requireMention: true,
      historyLimit: 5,
      ...overrides,
    },
  };
}

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: () => {
      throw new Error("exit");
    },
  };
}

type InboundEvent = Parameters<typeof handleOneBot11Inbound>[0]["event"];

function createEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    chatType: "group",
    chatId: "group-default",
    senderId: "10001",
    senderName: undefined,
    messageId: "msg-default",
    timestampMs: 1_710_000_000_000,
    text: "hello",
    wasMentioned: false,
    imageUrls: [],
    imagePaths: [],
    ...overrides,
  };
}

describe("onebot11 inbound behavior", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "image.png",
    });
    mockSaveMediaBuffer.mockResolvedValue({
      path: "/tmp/openclaw/onebot11-inbound/image.png",
      contentType: "image/png",
    });
    setOneBotRuntime(createMockRuntime());
  });

  it("drops DM when dmPolicy=allowlist and sender is not in allowFrom", async () => {
    mockReadAllowFromStore.mockResolvedValueOnce(["50002"]);

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({
        dmPolicy: "allowlist",
        allowFrom: ["50001"],
      }),
      event: createEvent({
        chatType: "private",
        chatId: "50002",
        senderId: "50002",
        messageId: "msg-dm-allowlist-denied",
        text: "hi from not-allowlisted sender",
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(mockRecordInboundSession).not.toHaveBeenCalled();
  });

  it("allows DM when dmPolicy=pairing and sender is approved in pairing store", async () => {
    mockReadAllowFromStore.mockResolvedValueOnce(["60002"]);

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({
        dmPolicy: "pairing",
        allowFrom: [],
      }),
      event: createEvent({
        chatType: "private",
        chatId: "60002",
        senderId: "60002",
        messageId: "msg-dm-pairing-approved",
        text: "hi from approved sender",
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(mockRecordInboundSession).toHaveBeenCalledTimes(1);
  });

  it("drops group message when mention is required but absent", async () => {
    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ requireMention: true }),
      event: createEvent({
        chatId: "group-no-mention",
        messageId: "msg-no-mention",
        text: "not mentioning bot",
        wasMentioned: false,
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(mockRecordInboundSession).not.toHaveBeenCalled();
  });

  it("drops group mention when sender is outside mention allowlist", async () => {
    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ mentionAllowFrom: ["50001"] }),
      event: createEvent({
        chatId: "group-mention-denied",
        senderId: "50002",
        messageId: "msg-mention-denied",
        text: "@bot hi",
        wasMentioned: true,
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(mockRecordInboundSession).not.toHaveBeenCalled();
  });

  it("prefetches remote image and injects local MediaPath while keeping MediaUrl", async () => {
    mockSaveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/openclaw/onebot11-inbound/prefetched.png",
      contentType: "image/png",
    });

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ requireMention: true }),
      event: createEvent({
        chatId: "group-prefetch-success",
        senderId: "90001",
        messageId: "msg-prefetch-success",
        text: "image message",
        wasMentioned: true,
        imageUrls: ["https://example.com/prefetch.png"],
      }),
    });

    expect(mockFetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mockSaveMediaBuffer).toHaveBeenCalledTimes(1);

    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };
    expect(dispatchPayload.ctx.MediaPath).toBe("/tmp/openclaw/onebot11-inbound/prefetched.png");
    expect(dispatchPayload.ctx.MediaUrl).toBe("https://example.com/prefetch.png");
    expect(dispatchPayload.ctx.MediaPaths).toEqual(["/tmp/openclaw/onebot11-inbound/prefetched.png"]);
    expect(dispatchPayload.ctx.MediaUrls).toEqual(["https://example.com/prefetch.png"]);
  });

  it("fails open and keeps original media when prefetch fails", async () => {
    mockFetchRemoteMedia.mockRejectedValueOnce(new Error("download failed"));

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ requireMention: true }),
      event: createEvent({
        chatId: "group-prefetch-fallback",
        senderId: "90002",
        messageId: "msg-prefetch-fallback",
        text: "image message",
        wasMentioned: true,
        imageUrls: ["https://example.com/fallback.png"],
      }),
    });

    expect(mockFetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mockSaveMediaBuffer).not.toHaveBeenCalled();
    expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };
    expect(dispatchPayload.ctx.MediaPath).toBe("https://example.com/fallback.png");
    expect(dispatchPayload.ctx.MediaUrl).toBe("https://example.com/fallback.png");
    expect(dispatchPayload.ctx.MediaPaths).toEqual(["https://example.com/fallback.png"]);
    expect(dispatchPayload.ctx.MediaUrls).toEqual(["https://example.com/fallback.png"]);
  });

  it("keeps non-http image path without prefetch", async () => {
    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ requireMention: true }),
      event: createEvent({
        chatId: "group-local-image-path",
        senderId: "90003",
        messageId: "msg-local-image-path",
        text: "local image",
        wasMentioned: true,
        imagePaths: ["./images/local.png"],
      }),
    });

    expect(mockFetchRemoteMedia).not.toHaveBeenCalled();
    expect(mockSaveMediaBuffer).not.toHaveBeenCalled();

    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };
    expect(dispatchPayload.ctx.MediaPath).toBe("./images/local.png");
    expect(dispatchPayload.ctx.MediaUrl).toBe("./images/local.png");
  });

  it("keeps behavior unchanged when message has no image", async () => {
    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account: createAccount({ requireMention: true }),
      event: createEvent({
        chatId: "group-no-image",
        senderId: "90004",
        messageId: "msg-no-image",
        text: "text only",
        wasMentioned: true,
      }),
    });

    expect(mockFetchRemoteMedia).not.toHaveBeenCalled();
    expect(mockSaveMediaBuffer).not.toHaveBeenCalled();
    expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };
    expect(dispatchPayload.ctx.MediaPath).toBeUndefined();
    expect(dispatchPayload.ctx.MediaUrl).toBeUndefined();
    expect(dispatchPayload.ctx.Body).toBe("text only");
  });

  it("includes recent history and merges current+history media for allowed mention", async () => {
    const account = createAccount({
      mentionAllowFrom: ["30001"],
      historyStrategy: "recent",
      historyLimit: 5,
    });

    mockSaveMediaBuffer
      .mockResolvedValueOnce({
        path: "/tmp/openclaw/onebot11-inbound/history-old.png",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        path: "/tmp/openclaw/onebot11-inbound/current-new.jpg",
        contentType: "image/jpeg",
      });

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account,
      event: createEvent({
        chatId: "group-recent-history",
        senderId: "30002",
        messageId: "msg-history",
        timestampMs: 1_710_000_001_000,
        text: "older message",
        wasMentioned: false,
        imageUrls: ["https://example.com/old.png"],
        imagePaths: [],
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account,
      event: createEvent({
        chatId: "group-recent-history",
        senderId: "30001",
        messageId: "msg-current",
        timestampMs: 1_710_000_002_000,
        text: "current message",
        wasMentioned: true,
        imageUrls: ["https://example.com/new.jpg"],
        imagePaths: [],
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };

    expect(dispatchPayload.ctx.InboundHistory).toEqual([
      {
        sender: "user:30002",
        body: "older message",
        timestamp: 1_710_000_001_000,
      },
    ]);
    expect(mockFetchRemoteMedia).toHaveBeenCalledTimes(2);
    expect(dispatchPayload.ctx.MediaPaths).toEqual([
      "/tmp/openclaw/onebot11-inbound/history-old.png",
      "/tmp/openclaw/onebot11-inbound/current-new.jpg",
    ]);
    expect(dispatchPayload.ctx.MediaUrls).toEqual([
      "https://example.com/old.png",
      "https://example.com/new.jpg",
    ]);
  });

  it("filters non-ai history entries when historyStrategy is ai-related-only", async () => {
    const account = createAccount({
      mentionAllowFrom: ["70001"],
      historyStrategy: "ai-related-only",
      historyLimit: 5,
    });

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account,
      event: createEvent({
        chatId: "group-ai-related-only",
        senderId: "70002",
        messageId: "msg-history-filtered",
        timestampMs: 1_710_000_003_000,
        text: "non-ai history",
        wasMentioned: false,
      }),
    });

    await handleOneBot11Inbound({
      cfg,
      runtime: createRuntimeEnv(),
      account,
      event: createEvent({
        chatId: "group-ai-related-only",
        senderId: "70001",
        messageId: "msg-current-ai",
        timestampMs: 1_710_000_004_000,
        text: "current ping",
        wasMentioned: true,
      }),
    });

    expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const dispatchPayload = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };

    expect(dispatchPayload.ctx.InboundHistory).toEqual([]);
    expect(dispatchPayload.ctx.Body).toBe("current ping");
  });
});
