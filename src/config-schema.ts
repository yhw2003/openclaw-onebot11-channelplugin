import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const allowEntry = z.union([z.string(), z.number()]);

const OneBot11AccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    endpoint: z.string().optional(),
    accessToken: z.string().optional(),
    accessTokenFile: z.string().optional(),
    sharedMediaHostDir: z.string().optional(),
    sharedMediaContainerDir: z.string().optional(),
    sendMode: z.enum(["http", "sse-http"]).optional(),
    sseUrl: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(allowEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(allowEntry).optional(),
    mentionAllowFrom: z.array(allowEntry).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().positive().optional(),
    historyStrategy: z.enum(["recent", "ai-related-only"]).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

const OneBot11AccountSchema = OneBot11AccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.onebot11.dmPolicy="open" requires channels.onebot11.allowFrom to include "*"',
  });
});

export const OneBot11ConfigSchema = OneBot11AccountSchemaBase.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), OneBot11AccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.onebot11.dmPolicy="open" requires channels.onebot11.allowFrom to include "*"',
  });
});
