import { loadWebMedia, resolveChannelMediaMaxBytes, type OpenClawConfig } from "openclaw/plugin-sdk";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveOneBot11Account } from "../accounts.js";
import { parseOneBot11Target } from "../normalize.js";
import { getOneBotRuntime } from "../runtime.js";
import type { OneBot11SendResult } from "../types.js";
import { ensureOneBot11ActionOk, sendOneBot11Action } from "./actions.js";
import {
  logOutboundDebug,
  logOutboundError,
  summarizeMediaSource,
  summarizeTarget,
} from "./logging.js";

type SendFileOneBot11Options = {
  cfg?: OpenClawConfig;
  accountId?: string;
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

function extensionForContentType(contentType?: string): string {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function resolveFileName(params: { fileName?: string; contentType?: string }): string {
  const base = params.fileName?.trim() ? path.basename(params.fileName.trim()) : "attachment";
  if (path.extname(base)) {
    return base;
  }
  const ext = extensionForContentType(params.contentType);
  return ext ? `${base}${ext}` : base;
}

function resolveMaxBytes(cfg: OpenClawConfig, accountId: string): number {
  return (
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId,
    }) ??
    8 * 1024 * 1024
  );
}

async function writeTempMediaFile(params: { buffer: Buffer; fileName: string }): Promise<{
  dir: string;
  filePath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onebot11-upload-"));
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.buffer, { mode: 0o600 });
  return { dir, filePath };
}

async function cleanupTempDir(dir: string | undefined): Promise<void> {
  if (!dir) {
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function uploadGroupFile(params: {
  endpoint: string;
  accessToken?: string;
  groupId: string;
  filePath: string;
  fileName: string;
}): Promise<void> {
  const action = "upload_group_file";
  logOutboundDebug("file.upload.group.start", {
    groupId: summarizeTarget(`group:${params.groupId}`),
    fileName: params.fileName,
    filePath: path.basename(params.filePath),
  });
  const result = await sendOneBot11Action({
    endpoint: params.endpoint,
    action,
    accessToken: params.accessToken,
    payload: {
      group_id: Number.parseInt(params.groupId, 10),
      file: params.filePath,
      name: params.fileName,
    },
  });
  ensureOneBot11ActionOk(action, result);
  logOutboundDebug("file.upload.group.done", {
    groupId: summarizeTarget(`group:${params.groupId}`),
    fileName: params.fileName,
  });
}

async function uploadPrivateFile(params: {
  endpoint: string;
  accessToken?: string;
  userId: string;
  filePath: string;
  fileName: string;
}): Promise<void> {
  const action = "upload_private_file";
  logOutboundDebug("file.upload.private.start", {
    userId: summarizeTarget(`private:${params.userId}`),
    fileName: params.fileName,
    filePath: path.basename(params.filePath),
  });
  const result = await sendOneBot11Action({
    endpoint: params.endpoint,
    action,
    accessToken: params.accessToken,
    payload: {
      user_id: Number.parseInt(params.userId, 10),
      file: params.filePath,
      name: params.fileName,
    },
  });
  ensureOneBot11ActionOk(action, result);
  logOutboundDebug("file.upload.private.done", {
    userId: summarizeTarget(`private:${params.userId}`),
    fileName: params.fileName,
  });
}

export async function sendFileOneBot11(
  target: string,
  mediaUrl: string,
  options: SendFileOneBot11Options = {},
): Promise<OneBot11SendResult> {
  const startedAt = Date.now();
  const core = getOneBotRuntime();
  const cfg = options.cfg ?? (core.config.loadConfig() as OpenClawConfig);
  const account = resolveOneBot11Account({ cfg, accountId: options.accountId });
  const endpoint = resolveEndpoint(account);
  logOutboundDebug("file.send.start", {
    target: summarizeTarget(target),
    media: summarizeMediaSource(mediaUrl),
    accountId: account.accountId,
  });

  try {
    const parsedTarget = parseOneBot11Target(target);
    const maxBytes = resolveMaxBytes(cfg, account.accountId);
    const media = await loadWebMedia(mediaUrl, { maxBytes, optimizeImages: false });
    const fileName = resolveFileName({ fileName: media.fileName, contentType: media.contentType });
    logOutboundDebug("file.send.media_loaded", {
      target: summarizeTarget(target),
      chatType: parsedTarget.chatType,
      mediaBytes: media.buffer.length,
      contentType: media.contentType ?? undefined,
      fileName,
    });

    let tempDir: string | undefined;
    try {
      const temp = await writeTempMediaFile({ buffer: media.buffer, fileName });
      tempDir = temp.dir;
      logOutboundDebug("file.send.temp_written", {
        target: summarizeTarget(target),
        fileName,
        tempPath: path.basename(temp.filePath),
      });

      if (parsedTarget.chatType === "group") {
        await uploadGroupFile({
          endpoint,
          accessToken: account.accessToken,
          groupId: parsedTarget.id,
          filePath: temp.filePath,
          fileName,
        });
      } else {
        await uploadPrivateFile({
          endpoint,
          accessToken: account.accessToken,
          userId: parsedTarget.id,
          filePath: temp.filePath,
          fileName,
        });
      }
    } finally {
      await cleanupTempDir(tempDir);
    }

    core.channel.activity.record({
      channel: "onebot11",
      accountId: account.accountId,
      direction: "outbound",
    });

    const messageId = `file:${parsedTarget.chatType}:${parsedTarget.id}:${Date.now()}`;
    logOutboundDebug("file.send.done", {
      target: summarizeTarget(target),
      chatType: parsedTarget.chatType,
      messageId,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      messageId,
      chatId: `${parsedTarget.chatType}:${parsedTarget.id}`,
    };
  } catch (error) {
    logOutboundError("file.send.failed", error, {
      target: summarizeTarget(target),
      media: summarizeMediaSource(mediaUrl),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}
