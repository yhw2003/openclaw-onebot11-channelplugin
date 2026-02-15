import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { OneBot11ConfigSchema } from "./config-schema.js";
import {
  listOneBot11AccountIds,
  resolveDefaultOneBot11AccountId,
  resolveOneBot11Account,
} from "./accounts.js";
import { looksLikeOneBot11TargetId, normalizeOneBot11MessagingTarget } from "./normalize.js";
import { monitorOneBot11Provider } from "./monitor.js";
import { onebot11Outbound } from "./outbound/adapter.js";
import type { ResolvedOneBot11Account } from "./types.js";

const meta = {
  id: "onebot11",
  label: "OneBot 11",
  selectionLabel: "OneBot 11 (HTTP + SSE)",
  detailLabel: "OneBot11 Bot",
  docsPath: "/channels/onebot11",
  docsLabel: "onebot11",
  blurb: "QQ-style messaging bridge via OneBot 11 actions and SSE events.",
  aliases: ["ob11", "onebot"],
  order: 80,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^(onebot11|ob11):/i, "").toLowerCase();
}

type OneBot11SetupInput = {
  name?: string;
  useEnv?: boolean;
  token?: string;
  tokenFile?: string;
  httpUrl?: string;
  webhookUrl?: string;
};

function resolveEndpointInput(input: OneBot11SetupInput): string | undefined {
  return input.httpUrl?.trim() || input.webhookUrl?.trim();
}

function endpointLooksValid(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const onebot11Plugin: ChannelPlugin<ResolvedOneBot11Account> = {
  id: "onebot11",
  meta: {
    ...meta,
    aliases: [...meta.aliases],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- OneBot11 targeting: use `target` for message tool sends. Do not pass `to` or `channelId`.",
      "- OneBot11 target formats: `<id>`, `private:<id>`, `group:<id>`.",
    ],
  },
  reload: { configPrefixes: ["channels.onebot11"] },
  configSchema: buildChannelConfigSchema(OneBot11ConfigSchema),
  config: {
    listAccountIds: (cfg) => listOneBot11AccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOneBot11Account({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultOneBot11AccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "onebot11",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "onebot11",
        accountId,
        clearBaseFields: ["accessToken", "accessTokenFile", "endpoint", "sseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.endpoint?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.endpoint?.trim()),
      baseUrl: account.endpoint,
      tokenSource: account.accessTokenSource,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      mode: account.config.sendMode ?? "http",
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveOneBot11Account({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.onebot11?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.onebot11.accounts.${resolvedAccountId}.`
        : "channels.onebot11.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("onebot11"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- OneBot11 groups: groupPolicy="open" allows any group member to trigger (mention-gated by default). Set channels.onebot11.groupPolicy="allowlist" + channels.onebot11.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveOneBot11Account({ cfg, accountId });
      return account.config.requireMention ?? true;
    },
  },
  messaging: {
    normalizeTarget: normalizeOneBot11MessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeOneBot11TargetId,
      hint: "<id|private:id|group:id>",
    },
  },
  outbound: onebot11Outbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      reconnectAttempts: snapshot.reconnectAttempts ?? 0,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastDisconnect: snapshot.lastDisconnect ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      mode: snapshot.mode ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.endpoint?.trim()),
      baseUrl: account.endpoint,
      tokenSource: account.accessTokenSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      reconnectAttempts: runtime?.reconnectAttempts ?? 0,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: "sse",
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: (account.config.allowFrom ?? []).map((entry) => String(entry)),
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "onebot11",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const setup = input as OneBot11SetupInput;
      if (setup.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "ONEBOT11_ACCESS_TOKEN can only be used for the default account.";
      }
      const endpoint = resolveEndpointInput(setup);
      if (!endpoint) {
        return "OneBot11 requires --http-url (or --webhook-url).";
      }
      if (!endpointLooksValid(endpoint)) {
        return "OneBot11 endpoint must be a valid http/https URL.";
      }
      if (!setup.useEnv && !setup.token && !setup.tokenFile) {
        return "OneBot11 requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const setup = input as OneBot11SetupInput;
      const endpoint = resolveEndpointInput(setup);
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "onebot11",
        accountId,
        name: setup.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "onebot11",
            })
          : namedConfig;

      const shared = {
        enabled: true,
        ...(endpoint ? { endpoint, sseUrl: endpoint } : {}),
        sendMode: "http" as const,
        ...(setup.useEnv
          ? {}
          : setup.tokenFile
            ? { accessTokenFile: setup.tokenFile }
            : setup.token
              ? { accessToken: setup.token }
              : {}),
      };

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            onebot11: {
              ...next.channels?.onebot11,
              ...shared,
            },
          },
        } as OpenClawConfig;
      }

      return {
        ...next,
        channels: {
          ...next.channels,
          onebot11: {
            ...next.channels?.onebot11,
            enabled: true,
            accounts: {
              ...next.channels?.onebot11?.accounts,
              [accountId]: {
                ...next.channels?.onebot11?.accounts?.[accountId],
                ...shared,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  pairing: {
    idLabel: "onebot11UserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[onebot11] User ${id} approved for pairing`);
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.endpoint,
        tokenSource: account.accessTokenSource,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      return monitorOneBot11Provider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
