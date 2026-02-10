import type { PluginRuntime } from "openclaw/plugin-sdk";

/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
let runtime: PluginRuntime | undefined;

export function setOneBotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getOneBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("OneBot11 runtime not initialized");
  }
  return runtime;
}
