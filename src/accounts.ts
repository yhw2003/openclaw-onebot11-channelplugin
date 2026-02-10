import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type {
  OneBot11AccountConfig,
  OneBot11Config,
  ResolvedOneBot11Account,
} from "./types.js";
import { resolveOneBot11Token } from "./token.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.onebot11 as OneBot11Config | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listOneBot11AccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultOneBot11AccountId(cfg: OpenClawConfig): string {
  const onebot = cfg.channels?.onebot11 as OneBot11Config | undefined;
  if (onebot?.defaultAccount?.trim()) {
    return onebot.defaultAccount.trim();
  }
  const ids = listOneBot11AccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): OneBot11AccountConfig | undefined {
  const accounts = (cfg.channels?.onebot11 as OneBot11Config | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as OneBot11AccountConfig | undefined;
}

function mergeOneBot11AccountConfig(cfg: OpenClawConfig, accountId: string): OneBot11AccountConfig {
  const raw = (cfg.channels?.onebot11 ?? {}) as OneBot11Config;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return {
    ...base,
    ...account,
  };
}

export function resolveOneBot11Account(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOneBot11Account {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.onebot11 as OneBot11Config | undefined)?.enabled !== false;
  const merged = mergeOneBot11AccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const token = resolveOneBot11Token(
    params.cfg.channels?.onebot11 as OneBot11Config | undefined,
    accountId,
  );

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    endpoint: merged.endpoint?.trim() || undefined,
    accessToken: token.token || undefined,
    accessTokenSource: token.source,
    config: merged,
  };
}

export function listEnabledOneBot11Accounts(cfg: OpenClawConfig): ResolvedOneBot11Account[] {
  return listOneBot11AccountIds(cfg)
    .map((accountId) => resolveOneBot11Account({ cfg, accountId }))
    .filter((account) => account.enabled);
}
