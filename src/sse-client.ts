import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type OneBot11SseLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function normalizeSseBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

export function buildOneBot11SseUrlCandidates(url: string): string[] {
  const normalized = normalizeSseBaseUrl(url);
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  try {
    const parsed = new URL(normalized);
    if ((parsed.pathname || "/") === "/") {
      const base = normalized.replace(/\/$/, "");
      candidates.add(`${base}/_events`);
      candidates.add(`${base}/events`);
      candidates.add(`${base}/event`);
      candidates.add(`${base}/sse`);
    }
  } catch {
    // keep the original url only when URL parsing fails
  }

  return Array.from(candidates.values());
}

function toChunkText(chunk: unknown, decoder: TextDecoder): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return decoder.decode(chunk, { stream: true });
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return String(chunk);
}

function normalizeSseChunkDelimiters(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

type OneBot11SseOptions = {
  accessToken?: string;
  onEvent: (payload: unknown) => Promise<void> | void;
  onReconnect?: (client: OneBot11SSEClient) => Promise<void> | void;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  logger?: OneBot11SseLogger;
};

export class OneBot11SSEClient {
  url: string;
  readonly candidateUrls: string[];
  activeUrl: string;
  accessToken?: string;
  onEvent: OneBot11SseOptions["onEvent"];
  onReconnect: OneBot11SseOptions["onReconnect"];
  autoReconnect: boolean;
  reconnectAttempts = 0;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  aborted = false;
  streamAbortController: AbortController | null = null;
  logger: OneBot11SseLogger;

  constructor(url: string, options: OneBot11SseOptions) {
    this.url = url;
    this.candidateUrls = buildOneBot11SseUrlCandidates(url);
    this.activeUrl = this.candidateUrls[0] ?? url;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.onEvent = options.onEvent;
    this.onReconnect = options.onReconnect;
    this.autoReconnect = options.autoReconnect !== false;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.logger = options.logger ?? {};
  }

  private buildHeaders() {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private resolveAttemptUrls(): string[] {
    const deduped = new Set<string>();
    if (this.activeUrl) {
      deduped.add(this.activeUrl);
    }
    for (const candidate of this.candidateUrls) {
      deduped.add(candidate);
    }
    return Array.from(deduped.values());
  }

  private async openSseStream(attemptUrl: string): Promise<ReadableStream<Uint8Array> | Readable> {
    const controller = new AbortController();
    this.streamAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(attemptUrl, {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} (${attemptUrl})`);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("text/event-stream")) {
        throw new Error(
          `SSE endpoint is not event-stream: ${contentType || "unknown"} (${attemptUrl})`,
        );
      }

      if (!response.body) {
        throw new Error(`SSE connection missing response body (${attemptUrl})`);
      }

      return response.body;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async connectAttempt(): Promise<void> {
    const errors: string[] = [];
    for (const attemptUrl of this.resolveAttemptUrls()) {
      if (this.aborted) {
        return;
      }
      try {
        const body = await this.openSseStream(attemptUrl);
        this.activeUrl = attemptUrl;
        this.reconnectAttempts = 0;
        await this.processStream(body);
        return;
      } catch (error) {
        errors.push(asErrorMessage(error));
        if (this.aborted) {
          throw error;
        }
      } finally {
        if (this.streamAbortController?.signal.aborted) {
          this.streamAbortController = null;
        }
      }
    }

    const detail = errors.join(" | ");
    throw new Error(detail || "OneBot11 SSE connection failed");
  }

  async connect() {
    while (!this.aborted) {
      try {
        await this.connectAttempt();
      } catch (error) {
        if (this.aborted || !this.autoReconnect) {
          throw error;
        }
        this.logger.error?.(`[onebot11] SSE stream error: ${asErrorMessage(error)}`);
      }

      if (this.aborted || !this.autoReconnect) {
        break;
      }
      await this.attemptReconnect();
    }
  }

  private async processStream(body: ReadableStream<Uint8Array> | Readable | null) {
    if (!body) {
      return;
    }
    const stream = body instanceof ReadableStream ? Readable.fromWeb(body as NodeReadableStream) : body;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for await (const chunk of stream) {
        if (this.aborted) {
          break;
        }
        buffer += normalizeSseChunkDelimiters(toChunkText(chunk, decoder));
        let eventEnd = -1;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const eventBlock = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          await this.processEventBlock(eventBlock);
        }
      }
      buffer += normalizeSseChunkDelimiters(decoder.decode());
      if (buffer.trim()) {
        await this.processEventBlock(buffer);
      }
    } finally {
      this.streamAbortController = null;
      if (!this.aborted && this.autoReconnect) {
        this.logger.log?.("[onebot11] SSE stream ended, reconnecting...");
      }
    }
  }

  private async processEventBlock(block: string) {
    const lines = block.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n").trim();
    if (!data) {
      return;
    }
    try {
      const payload = JSON.parse(data) as unknown;
      await this.onEvent(payload);
    } catch (error) {
      this.logger.error?.(`[onebot11] SSE event parse failed: ${String(error)}`);
    }
  }

  private async attemptReconnect() {
    if (this.aborted || !this.autoReconnect) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error?.(
        `[onebot11] max SSE reconnect attempts (${this.maxReconnectAttempts}) reached`,
      );
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.onReconnect) {
      await this.onReconnect(this);
    }
  }

  async close() {
    this.aborted = true;
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }
}
