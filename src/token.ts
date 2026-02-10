import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OneBot11Config, OneBot11TokenSource } from "./types.js";

export type OneBot11TokenResolution = {
  token: string;
  source: OneBot11TokenSource;
};

export function resolveOneBot11Token(
  config: OneBot11Config | undefined,
  accountId?: string | null,
): OneBot11TokenResolution {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig =
    resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? (baseConfig?.accounts?.[resolvedAccountId] as OneBot11Config | undefined)
      : undefined;

  if (accountConfig) {
    const token = accountConfig.accessToken?.trim();
    if (token) {
      return { token, source: "config" };
    }
    const tokenFile = accountConfig.accessTokenFile?.trim();
    if (tokenFile) {
      try {
        const fileToken = readFileSync(tokenFile, "utf8").trim();
        if (fileToken) {
          return { token: fileToken, source: "configFile" };
        }
      } catch {
        // ignore read failures
      }
    }
  }

  if (isDefaultAccount) {
    const token = baseConfig?.accessToken?.trim();
    if (token) {
      return { token, source: "config" };
    }
    const tokenFile = baseConfig?.accessTokenFile?.trim();
    if (tokenFile) {
      try {
        const fileToken = readFileSync(tokenFile, "utf8").trim();
        if (fileToken) {
          return { token: fileToken, source: "configFile" };
        }
      } catch {
        // ignore read failures
      }
    }
    const envToken = process.env.ONEBOT11_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}
