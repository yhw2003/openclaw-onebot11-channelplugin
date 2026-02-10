import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBot11ActionResponse, OneBot11SendResult } from "./types.js";
import { resolveOneBot11Account } from "./accounts.js";
import { parseOneBot11Target } from "./normalize.js";
import { getOneBotRuntime } from "./runtime.js";

type SendOneBot11Opts = {
  accountId?: string;
  cfg?: OpenClawConfig;
  replyToId?: string;
};

function resolveEndpoint(account: ReturnType<typeof resolveOneBot11Account>): string {
  const endpoint = account.endpoint?.trim();
  if (!endpoint) {
    throw new Error(
      `OneBot11 endpoint missing for account "${account.accountId}" (set channels.onebot11.endpoint).`,
    );
  }
  return endpoint.replace(/\/$/, "");
}

function resolveChunkLimit(account: ReturnType<typeof resolveOneBot11Account>) {
  const configured = account.config.textChunkLimit;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 2000;
}

async function sendAction<T = unknown>(params: {
  endpoint: string;
  action: string;
  payload: Record<string, unknown>;
  accessToken?: string;
}): Promise<OneBot11ActionResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.accessToken?.trim()) {
    headers.Authorization = `Bearer ${params.accessToken.trim()}`;
  }

  const response = await fetch(`${params.endpoint}/${params.action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OneBot11 action ${params.action} failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }

  return (await response.json()) as OneBot11ActionResponse<T>;
}

function ensureActionOk(action: string, result: OneBot11ActionResponse): void {
  if (result.status === "ok") {
    return;
  }
  const detail = result.wording || result.message || `retcode=${String(result.retcode ?? "unknown")}`;
  throw new Error(`OneBot11 action ${action} returned failure: ${detail}`);
}

export async function sendMessageOneBot11(
  to: string,
  text: string,
  opts: SendOneBot11Opts = {},
): Promise<OneBot11SendResult> {
  const cfg = opts.cfg ?? (getOneBotRuntime().config.loadConfig() as OpenClawConfig);
  const account = resolveOneBot11Account({ cfg, accountId: opts.accountId });
  const endpoint = resolveEndpoint(account);
  const target = parseOneBot11Target(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for OneBot11 sends");
  }

  const core = getOneBotRuntime();
  const chunkLimit = resolveChunkLimit(account);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "onebot11",
    accountId: account.accountId,
  });
  const normalized = core.channel.text.convertMarkdownTables(text, tableMode);
  const chunks = core.channel.text.chunkMarkdownText(normalized, chunkLimit);
  let lastMessageId = "";

  for (const chunk of chunks) {
    const payload: Record<string, unknown> = {
      message: chunk,
      auto_escape: false,
    };
    if (target.chatType === "group") {
      payload.group_id = Number.parseInt(target.id, 10);
    } else {
      payload.user_id = Number.parseInt(target.id, 10);
    }
    if (opts.replyToId?.trim()) {
      payload.message = `[CQ:reply,id=${opts.replyToId.trim()}]${chunk}`;
    }

    const action = target.chatType === "group" ? "send_group_msg" : "send_private_msg";
    const result = await sendAction<{ message_id?: number | string }>({
      endpoint,
      action,
      payload,
      accessToken: account.accessToken,
    });
    ensureActionOk(action, result);
    lastMessageId =
      result.data?.message_id == null ? lastMessageId : String(result.data.message_id);
  }

  if (!lastMessageId) {
    lastMessageId = `${target.chatType}:${target.id}:${Date.now()}`;
  }

  core.channel.activity.record({
    channel: "onebot11",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: lastMessageId,
    chatId: `${target.chatType}:${target.id}`,
  };
}
