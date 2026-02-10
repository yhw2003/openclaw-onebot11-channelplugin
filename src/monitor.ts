import { format } from "node:util";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveOneBot11Account } from "./accounts.js";
import { handleOneBot11Inbound } from "./inbound.js";
import { parseOneBot11InboundEvent } from "./normalize.js";
import { getOneBotRuntime } from "./runtime.js";
import { OneBot11SSEClient } from "./sse-client.js";
import type { OneBot11MonitorRuntime } from "./types.js";

export type MonitorOneBot11Options = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    connected?: boolean;
    lastConnectedAt?: number;
    reconnectAttempts?: number;
    lastDisconnect?: { at: number; error?: string };
    lastError?: string | null;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    mode?: string;
  }) => void;
};

const fallbackRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: () => {
    throw new Error("Runtime exit not available");
  },
};

function formatRuntimeMessage(...args: Parameters<RuntimeEnv["log"]>) {
  return format(...args);
}

function resolveSseUrl(account: ReturnType<typeof resolveOneBot11Account>): string {
  const raw = account.config.sseUrl?.trim() || account.endpoint?.trim();
  if (!raw) {
    throw new Error(
      `OneBot11 sseUrl missing for account "${account.accountId}" (set channels.onebot11.sseUrl or endpoint).`,
    );
  }
  return raw;
}

export async function monitorOneBot11Provider(opts: MonitorOneBot11Options = {}): Promise<{
  stop: () => Promise<void>;
}> {
  const core = getOneBotRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as OpenClawConfig);
  const logger = core.logging.getChildLogger({ module: "onebot11-auto-reply" });

  const runtime: OneBot11MonitorRuntime = opts.runtime
    ? {
        log: (...args) => opts.runtime?.log?.(formatRuntimeMessage(...args)),
        error: (...args) => opts.runtime?.error?.(formatRuntimeMessage(...args)),
      }
    : {
        log: (message: string) => logger.info(message),
        error: (message: string) => logger.error(message),
      };

  const account = resolveOneBot11Account({
    cfg,
    accountId: opts.accountId,
  });
  if (!account.enabled) {
    return {
      stop: async () => {
        // noop
      },
    };
  }

  const sseUrl = resolveSseUrl(account);
  const inboundRuntime = opts.runtime ?? fallbackRuntime;
  let reconnectAttempts = 0;
  const client = new OneBot11SSEClient(sseUrl, {
    accessToken: account.accessToken,
    logger: runtime,
    onReconnect: () => {
      reconnectAttempts += 1;
      opts.statusSink?.({
        connected: false,
        reconnectAttempts,
      });
    },
    onEvent: async (payload) => {
      const parsed = parseOneBot11InboundEvent(payload);
      if (!parsed.ok) {
        return;
      }

      core.channel.activity.record({
        channel: "onebot11",
        accountId: account.accountId,
        direction: "inbound",
        at: parsed.timestampMs,
      });

      await handleOneBot11Inbound({
        cfg,
        runtime: inboundRuntime,
        account,
        event: {
          chatType: parsed.chatType,
          chatId: parsed.chatId,
          senderId: parsed.senderId,
          senderName: parsed.senderName,
          messageId: parsed.messageId,
          timestampMs: parsed.timestampMs,
          text: parsed.text,
          wasMentioned: parsed.wasMentioned,
        },
        statusSink: opts.statusSink,
      });
    },
  });

  const stop = async () => {
    await client.close();
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener(
      "abort",
      () => {
        void stop();
      },
      { once: true },
    );
  }

  opts.statusSink?.({
    connected: true,
    mode: "sse",
    reconnectAttempts,
  });

  try {
    await client.connect();
  } catch (error) {
    if (opts.abortSignal?.aborted) {
      return { stop };
    }
    const message = error instanceof Error ? error.message : String(error);
    opts.statusSink?.({
      connected: false,
      lastDisconnect: {
        at: Date.now(),
        error: message,
      },
      lastError: message,
      mode: "sse",
    });
    throw error;
  } finally {
    opts.statusSink?.({
      connected: false,
    });
  }

  return { stop };
}
