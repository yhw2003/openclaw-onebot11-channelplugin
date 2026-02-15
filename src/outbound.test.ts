import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onebot11Outbound } from "./outbound/adapter.js";
import { setOneBotRuntime } from "./runtime.js";

const cfg = {
  channels: {
    onebot11: {
      endpoint: "http://localhost:3000",
      accessToken: "test-token",
      enabled: true,
    },
  },
} as unknown as OpenClawConfig;

type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function createMockRuntime(logger: MockLogger): PluginRuntime {
  return {
    config: {
      loadConfig: () => cfg,
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => logger),
    },
    channel: {
      activity: {
        record: vi.fn(),
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "default"),
        convertMarkdownTables: vi.fn((text: string) => text),
        chunkMarkdownText: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

describe("onebot11 outbound adapter", () => {
  const originalFetch = globalThis.fetch;
  const cleanupDirs: string[] = [];
  let fileUrl = "";
  let logger: MockLogger;

  beforeEach(async () => {
    vi.restoreAllMocks();
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setOneBotRuntime(createMockRuntime(logger));

    // Ensure loadWebMedia() local-root guard passes for our temp file fixture.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onebot11-outbound-test-"));
    const fixturePath = path.join(tempDir, "hello.txt");
    await fs.writeFile(fixturePath, "hello", "utf8");
    fileUrl = fixturePath;

    // ensure any previous temp dir from a prior test is cleaned
    cleanupDirs.push(tempDir);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of cleanupDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads group file then sends caption as message", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/upload_group_file")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", data: {} }),
        } as unknown as Response;
      }
      if (u.includes("/send_group_msg")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
        expect(body.message).toBe("caption");
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { message_id: 123 } }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await onebot11Outbound.sendMedia!({
      cfg,
      to: "group:42",
      text: "caption",
      mediaUrl: fileUrl,
      accountId: "default",
      replyToId: null,
    });

    expect(result.channel).toBe("onebot11");
    expect(result.messageId).toBe("123");

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/upload_group_file"),
        expect.stringContaining("/send_group_msg"),
      ]),
    );
    const debugLog = logger.debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(debugLog).toContain("event=adapter.sendMedia.start");
    expect(debugLog).toContain("event=actions.request.start");
    expect(debugLog).toContain("upload_group_file");
    expect(debugLog).toContain("event=adapter.sendMediaWithFallback.caption_sent");
    expect(debugLog).not.toContain("test-token");
  });

  it("falls back to Attachment text when upload fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/upload_group_file")) {
        throw new Error("upload failed");
      }
      if (u.includes("/send_group_msg")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
        expect(body.message).toContain("Attachment:");
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { message_id: 999 } }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await onebot11Outbound.sendMedia!({
      cfg,
      to: "group:42",
      text: "caption",
      mediaUrl: fileUrl,
      accountId: "default",
      replyToId: null,
    });

    expect(result.messageId).toBe("999");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining("/send_group_msg")]),
    );
    const debugLog = logger.debug.mock.calls.map((call) => String(call[0])).join("\n");
    const errorLog = logger.error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(debugLog).toContain("event=adapter.sendMediaWithFallback.fallback_sent");
    expect(errorLog).toContain("event=adapter.sendMediaWithFallback.upload_failed");
    expect(errorLog).not.toContain("test-token");
  });

  it("uses --target wording for invalid target errors", () => {
    const resolved = onebot11Outbound.resolveTarget?.({ to: "   " });
    expect(resolved).toBeDefined();
    expect(resolved?.ok).toBe(false);
    if (!resolved || resolved.ok) {
      return;
    }
    expect(resolved.error.message).toContain("--target");
  });
});
