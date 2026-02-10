import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { onebot11Plugin } from "./src/channel.js";
import { setOneBotRuntime } from "./src/runtime.js";

const plugin = {
  id: "onebot11",
  name: "OneBot 11",
  description: "OneBot 11 channel plugin (HTTP + SSE)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setOneBotRuntime(api.runtime);
    api.registerChannel({ plugin: onebot11Plugin });
  },
};

export default plugin;
