# OneBot11 插件配置说明

`@openclaw/onebot11` 用于把 OpenClaw 连接到 OneBot 11（常见于 QQ 机器人框架），通过：

- HTTP action 发送消息
- SSE 接收入站消息

## 安装

```bash
openclaw plugins install @openclaw/onebot11
```

本地开发仓库也可以直接安装：

```bash
openclaw plugins install ./extensions/onebot11
```

## 最小可用配置

```json5
{
  "channels": {
    "onebot11": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:3000",
      "accessTokenFile": "/path/to/onebot11.token",

      // 安全策略
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["123456789"],

      // 群聊默认要求 @ 机器人
      "requireMention": true,
    },
  },
}
```

## OneBot11AccountConfig 字段详解

下面按 `OneBot11AccountConfig` 的定义逐项说明每个字段（账号级配置；可用于默认账号或 `accounts.<id>`）。

### 1) `name?: string`

账号显示名称，用于区分多账号和状态展示，不影响协议行为。

### 2) `enabled?: boolean`

账号开关：

- `true` / 不填：账号可运行
- `false`：禁用该账号

最终是否生效 = 渠道总开关 `channels.onebot11.enabled` 与账号 `enabled` 共同决定。

### 3) `endpoint?: string`

OneBot11 HTTP 基础地址（如 `http://127.0.0.1:3000`）。

- 发送消息依赖它（HTTP action）
- 若未设置 `sseUrl`，SSE 入站也会回退使用它

### 4) `accessToken?: string`

直接在配置中写 Bearer Token。适合测试环境，生产更推荐 `accessTokenFile`。

### 5) `accessTokenFile?: string`

从本地文件读取 Token（文件内容即 token 字符串）。

### 6) `sendMode?: "http" | "sse-http"`

发送模式标记。当前推荐使用默认 `"http"`。

### 7) `sseUrl?: string`

SSE 入站连接地址。若不填则回退 `endpoint`。

### 8) `dmPolicy?: "pairing" | "allowlist" | "open" | "disabled"`

私聊权限策略：

- `pairing`（推荐）：未授权用户先走配对
- `allowlist`：仅 `allowFrom` 用户可触发
- `open`：开放模式（仍要求 `allowFrom` 含 `"*"`）
- `disabled`：禁用私聊触发

### 9) `allowFrom?: Array<string | number>`

私聊允许的用户 ID 列表。支持字符串或数字。

- `dmPolicy=allowlist` 时按此列表放行
- `dmPolicy=open` 时必须包含 `"*"`

### 10) `groupPolicy?: "allowlist" | "open" | "disabled"`

群聊权限策略：

- `allowlist`（默认策略）：仅允许指定群触发
- `open`：任何群都可触发
- `disabled`：禁用群聊触发

### 11) `groupAllowFrom?: Array<string | number>`

允许触发的群 ID 列表。主要用于 `groupPolicy=allowlist`。

### 12) `mentionAllowFrom?: Array<string | number>`

“允许 @ 机器人触发回复”的**发送者用户 ID 白名单**。

- 只有群消息且发生提及时才检查该字段
- 配置了该字段后，不在名单内即使提及机器人也不会回复

### 13) `requireMention?: boolean`

群聊是否要求提及机器人：

- `true`（推荐）：只有被 @ 时才回复
- `false`：可不提及直接触发

### 14) `historyLimit?: number`

群聊历史窗口大小（正整数）。控制注入给模型的历史条数上限。

### 15) `historyStrategy?: "recent" | "ai-related-only"`

历史筛选策略：

- `recent`：使用最近历史消息
- `ai-related-only`：仅保留 AI 相关历史（如提及/命令相关）

### 16) `textChunkLimit?: number`

发送文本分片上限（正整数）。默认 2000 字符；超出会自动拆分多条发送。

### 17) `blockStreaming?: boolean`

是否启用分块流式回复行为（对回复输出方式有影响）。

### 18) `blockStreamingCoalesce?: BlockStreamingCoalesceConfig`

分块流式回复的合并策略配置（用于调节分块聚合与输出节奏）。

### 19) `responsePrefix?: string`

给该账号回复内容添加前缀（例如标注环境/身份）。

## 鉴权来源优先级

> 默认账号还支持环境变量：`ONEBOT11_ACCESS_TOKEN`。

**默认账号（default）**：
1. `accessToken`
2. `accessTokenFile`
3. `ONEBOT11_ACCESS_TOKEN`

**非默认账号（accounts.<id>）**：
1. `accounts.<id>.accessToken`
2. `accounts.<id>.accessTokenFile`

非默认账号不会回退到环境变量。
## 多账号配置示例

```json5
{
  channels: {
    onebot11: {
      enabled: true,
      defaultAccount: "prod",
      accounts: {
        prod: {
          name: "生产账号",
          endpoint: "http://127.0.0.1:3000",
          sseUrl: "http://127.0.0.1:3000/events",
          accessTokenFile: "/secrets/onebot11-prod.token",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          groupAllowFrom: ["123456789"],
          requireMention: true,
          mentionAllowFrom: ["10001", "10002"],
          historyLimit: 6,
          historyStrategy: "recent",
        },
        test: {
          name: "测试账号",
          endpoint: "http://127.0.0.1:3100",
          accessToken: "TEST_TOKEN",
          dmPolicy: "allowlist",
          allowFrom: ["20001"],
          groupPolicy: "open",
          requireMention: true,
        },
      },
    },
  },
}
```

## pairing（推荐）

当 `dmPolicy` 为 `pairing` 时，未授权用户私聊会收到配对码，批准后才可触发。

```bash
openclaw pairing list onebot11
openclaw pairing approve onebot11 <CODE>
```

## 常见问题

- **只发得出消息，收不到入站**：检查 `sseUrl`（或 `endpoint` 回退地址）是否真的是 SSE endpoint。
- **群里 @ 了也不回复**：依次检查 `groupPolicy/groupAllowFrom`、`requireMention`、`mentionAllowFrom`。
- **默认账号没配 token 但仍认证失败**：确认是否设置了 `ONEBOT11_ACCESS_TOKEN`，以及 token 是否可被 OneBot 服务端接受。
