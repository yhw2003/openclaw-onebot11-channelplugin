import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOneBotRuntime } from "../runtime.js";

type OutboundLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

const PREFIX = "[onebot11/outbound]";
const MAX_FIELD_CHARS = 160;

function getOutboundLogger(): OutboundLogger | null {
  try {
    const core = getOneBotRuntime();
    return core.logging.getChildLogger({ module: "onebot11-outbound" });
  } catch {
    return null;
  }
}

function trimLong(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_FIELD_CHARS - 3)}...`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(trimLong(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return JSON.stringify("[unserializable]");
    }
    return trimLong(serialized);
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) {
    return "";
  }
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(" ");
}

function buildLine(event: string, fields?: Record<string, unknown>): string {
  const fieldText = formatFields(fields);
  return fieldText ? `${PREFIX} event=${event} ${fieldText}` : `${PREFIX} event=${event}`;
}

function maskId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "*";
  }
  if (trimmed.length <= 4) {
    return `*${trimmed}`;
  }
  return `*${trimmed.slice(-4)}`;
}

function maskOpaque(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "*";
  }
  if (trimmed.length <= 6) {
    return `${trimmed[0] ?? "*"}***`;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

export function summarizeTarget(target: string | undefined): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixed = trimmed.match(/^(private|group):(.+)$/i);
  if (prefixed) {
    return `${prefixed[1].toLowerCase()}:${maskId(prefixed[2])}`;
  }
  if (/^\d+$/.test(trimmed)) {
    return `id:${maskId(trimmed)}`;
  }
  return maskOpaque(trimmed);
}

export function summarizeMediaSource(media: string | undefined): string | undefined {
  const trimmed = media?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const base = path.posix.basename(url.pathname) || "/";
      return `${url.protocol}//${url.host}/${base}`;
    } catch {
      return trimLong(trimmed);
    }
  }
  if (trimmed.startsWith("file://")) {
    try {
      const filePath = fileURLToPath(trimmed);
      return `file:${path.basename(filePath)}`;
    } catch {
      return "file:[invalid]";
    }
  }
  return path.basename(trimmed);
}

export function summarizeEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname || "/"}`;
  } catch {
    return trimLong(endpoint);
  }
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return trimLong(error.message || error.name);
  }
  return trimLong(String(error));
}

export function logOutboundDebug(event: string, fields?: Record<string, unknown>): void {
  const line = buildLine(event, fields);
  const logger = getOutboundLogger();
  if (logger?.debug) {
    logger.debug(line);
    return;
  }
  logger?.info?.(line);
}

export function logOutboundError(
  event: string,
  error: unknown,
  fields?: Record<string, unknown>,
): void {
  const line = buildLine(event, {
    ...fields,
    error: summarizeError(error),
  });
  const logger = getOutboundLogger();
  logger?.error?.(line);
}
