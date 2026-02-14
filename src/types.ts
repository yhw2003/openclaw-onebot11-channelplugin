import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk";


export type OneBotSendMode = "http" | "sse-http";

export type OneBot11AccountConfig = {
  name?: string;
  enabled?: boolean;
  endpoint?: string;
  accessToken?: string;
  accessTokenFile?: string;
  sendMode?: OneBotSendMode;
  sseUrl?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  mentionAllowFrom?: Array<string | number>;
  requireMention?: boolean;
  historyLimit?: number;
  historyStrategy?: "recent" | "ai-related-only";
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
};

export type OneBot11Config = OneBot11AccountConfig & {
  accounts?: Record<string, OneBot11AccountConfig>;
  defaultAccount?: string;
};

export type OneBot11TokenSource = "env" | "config" | "configFile" | "none";

export type ResolvedOneBot11Account = {
  accountId: string;
  enabled: boolean;
  name?: string;
  endpoint?: string;
  accessToken?: string;
  accessTokenSource: OneBot11TokenSource;
  config: OneBot11AccountConfig;
};

export type OneBot11ActionResponse<T = unknown> = {
  status?: "ok" | "failed";
  retcode?: number;
  data?: T;
  message?: string;
  wording?: string;
};

export type OneBot11SendResult = {
  messageId: string;
  chatId: string;
};

export type OneBot11MessageEvent = {
  post_type: string;
  message_type?: string;
  sub_type?: string;
  time?: number;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  message?: unknown;
  raw_message?: string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
    role?: string;
  };
};

export type OneBot11MonitorRuntime = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};
