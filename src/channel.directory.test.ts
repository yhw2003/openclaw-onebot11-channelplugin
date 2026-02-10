import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { onebot11Plugin } from "./channel.js";

describe("onebot11 config adapter", () => {
  it("formats allowFrom entries", () => {
    const formatted = onebot11Plugin.config.formatAllowFrom?.({
      cfg: {} as OpenClawConfig,
      accountId: undefined,
      allowFrom: ["onebot11:10001", "ob11:20002", "30003"],
    });
    expect(formatted).toEqual(["10001", "20002", "30003"]);
  });

  it("resolves allowFrom from account config", () => {
    const cfg = {
      channels: {
        onebot11: {
          allowFrom: ["1001", "1002"],
        },
      },
    } as unknown as OpenClawConfig;

    const allowFrom = onebot11Plugin.config.resolveAllowFrom?.({
      cfg,
      accountId: undefined,
    });
    expect(allowFrom).toEqual(["1001", "1002"]);
  });
});
