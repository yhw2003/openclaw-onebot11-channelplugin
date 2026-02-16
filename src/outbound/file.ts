import fs from "node:fs/promises";
import path from "node:path";
import {
  loadWebMedia,
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { OneBot11SendResult } from "../types.js";
import { resolveOneBot11Account } from "../accounts.js";
import { parseOneBot11Target } from "../normalize.js";
import { getOneBotRuntime } from "../runtime.js";
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

type SharedMediaDirectories = {
  hostDir: string;
  containerDir: string;
};

export class OneBot11FileSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneBot11FileSyncConfigError";
  }
}

function asTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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
    }) ?? 8 * 1024 * 1024
  );
}

function resolveSharedMediaDirectories(
  account: ReturnType<typeof resolveOneBot11Account>,
): SharedMediaDirectories {
  const hostDir = asTrimmedString(account.config.sharedMediaHostDir);
  const rawContainerDir = asTrimmedString(account.config.sharedMediaContainerDir);
  const containerDir = rawContainerDir?.replace(/\\/g, "/");
  if (!hostDir || !containerDir) {
    throw new OneBot11FileSyncConfigError(
      `OneBot11 file sending requires both channels.onebot11.sharedMediaHostDir and channels.onebot11.sharedMediaContainerDir (account "${account.accountId}").`,
    );
  }
  return {
    hostDir,
    containerDir,
  };
}

function buildStagedFileName(fileName: string): string {
  const ext = path.extname(fileName);
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
}

async function stageMediaFile(params: {
  buffer: Buffer;
  fileName: string;
  hostDir: string;
  containerDir: string;
}): Promise<{
  hostPath: string;
  containerPath: string;
}> {
  await fs.mkdir(params.hostDir, { recursive: true });
  const stagedFileName = buildStagedFileName(params.fileName);
  const hostPath = path.join(params.hostDir, stagedFileName);
  const containerPath = path.posix.join(params.containerDir, stagedFileName);
  await fs.writeFile(hostPath, params.buffer, { mode: 0o600 });
  return {
    hostPath,
    containerPath,
  };
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
    const sharedDirs = resolveSharedMediaDirectories(account);
    const media = await loadWebMedia(mediaUrl, { maxBytes, optimizeImages: false });
    const fileName = resolveFileName({ fileName: media.fileName, contentType: media.contentType });
    logOutboundDebug("file.send.media_loaded", {
      target: summarizeTarget(target),
      chatType: parsedTarget.chatType,
      mediaBytes: media.buffer.length,
      contentType: media.contentType ?? undefined,
      fileName,
    });

    const staged = await stageMediaFile({
      buffer: media.buffer,
      fileName,
      hostDir: sharedDirs.hostDir,
      containerDir: sharedDirs.containerDir,
    });
    logOutboundDebug("file.send.staged", {
      target: summarizeTarget(target),
      fileName,
      stagedHostFile: path.basename(staged.hostPath),
      stagedContainerPath: staged.containerPath,
    });

    if (parsedTarget.chatType === "group") {
      await uploadGroupFile({
        endpoint,
        accessToken: account.accessToken,
        groupId: parsedTarget.id,
        filePath: staged.containerPath,
        fileName,
      });
    } else {
      await uploadPrivateFile({
        endpoint,
        accessToken: account.accessToken,
        userId: parsedTarget.id,
        filePath: staged.containerPath,
        fileName,
      });
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
