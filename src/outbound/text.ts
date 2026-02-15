import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveOneBot11Account } from "../accounts.js";
import { parseOneBot11Target } from "../normalize.js";
import { getOneBotRuntime } from "../runtime.js";
import type { OneBot11SendResult } from "../types.js";
import { ensureOneBot11ActionOk, sendOneBot11Action } from "./actions.js";

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

export async function sendMessageOneBot11(
  target: string,
  text: string,
  opts: SendOneBot11Opts = {},
): Promise<OneBot11SendResult> {
  const core = getOneBotRuntime();
  const cfg = opts.cfg ?? (core.config.loadConfig() as OpenClawConfig);
  const account = resolveOneBot11Account({ cfg, accountId: opts.accountId });
  const endpoint = resolveEndpoint(account);
  const parsedTarget = parseOneBot11Target(target);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for OneBot11 sends");
  }

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
    if (parsedTarget.chatType === "group") {
      payload.group_id = Number.parseInt(parsedTarget.id, 10);
    } else {
      payload.user_id = Number.parseInt(parsedTarget.id, 10);
    }
    if (opts.replyToId?.trim()) {
      payload.message = `[CQ:reply,id=${opts.replyToId.trim()}]${chunk}`;
    }

    const action = parsedTarget.chatType === "group" ? "send_group_msg" : "send_private_msg";
    const result = await sendOneBot11Action<{ message_id?: number | string }>({
      endpoint,
      action,
      payload,
      accessToken: account.accessToken,
    });
    ensureOneBot11ActionOk(action, result);
    lastMessageId = result.data?.message_id == null ? lastMessageId : String(result.data.message_id);
  }

  if (!lastMessageId) {
    lastMessageId = `${parsedTarget.chatType}:${parsedTarget.id}:${Date.now()}`;
  }

  core.channel.activity.record({
    channel: "onebot11",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: lastMessageId,
    chatId: `${parsedTarget.chatType}:${parsedTarget.id}`,
  };
}
