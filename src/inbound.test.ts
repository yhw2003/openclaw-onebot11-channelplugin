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
    setOneBotRuntime(createMockRuntime());
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

  it("includes recent history and merges current+history media for allowed mention", async () => {
    const account = createAccount({
      mentionAllowFrom: ["30001"],
      historyStrategy: "recent",
      historyLimit: 5,
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
        imageUrls: [],
        imagePaths: ["./images/new.jpg"],
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
    expect(dispatchPayload.ctx.MediaUrls).toEqual(
      expect.arrayContaining(["https://example.com/old.png", "./images/new.jpg"]),
    );
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
