import type { OneBot11ActionResponse } from "../types.js";
import {
  logOutboundDebug,
  logOutboundError,
  summarizeEndpoint,
  summarizeError,
} from "./logging.js";

type SendOneBot11ActionParams = {
  endpoint: string;
  action: string;
  payload: Record<string, unknown>;
  accessToken?: string;
};

export async function sendOneBot11Action<T = unknown>(
  params: SendOneBot11ActionParams,
): Promise<OneBot11ActionResponse<T>> {
  const startedAt = Date.now();
  logOutboundDebug("actions.request.start", {
    action: params.action,
    endpoint: summarizeEndpoint(params.endpoint),
    hasAccessToken: Boolean(params.accessToken?.trim()),
    payloadKeys: Object.keys(params.payload).sort(),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.accessToken?.trim()) {
    headers.Authorization = `Bearer ${params.accessToken.trim()}`;
  }

  let response: Response;
  try {
    response = await fetch(`${params.endpoint}/${params.action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.payload),
    });
  } catch (error) {
    logOutboundError("actions.request.error", error, {
      action: params.action,
      endpoint: summarizeEndpoint(params.endpoint),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }

  const elapsedMs = Date.now() - startedAt;
  logOutboundDebug("actions.request.http", {
    action: params.action,
    endpoint: summarizeEndpoint(params.endpoint),
    statusCode: response.status,
    ok: response.ok,
    elapsedMs,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logOutboundError("actions.request.http_error", `status=${response.status}`, {
      action: params.action,
      endpoint: summarizeEndpoint(params.endpoint),
      statusCode: response.status,
      bodyChars: body.length,
      elapsedMs,
    });
    throw new Error(
      `OneBot11 action ${params.action} failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }

  let parsed: OneBot11ActionResponse<T>;
  try {
    parsed = (await response.json()) as OneBot11ActionResponse<T>;
  } catch (error) {
    logOutboundError("actions.request.parse_error", error, {
      action: params.action,
      endpoint: summarizeEndpoint(params.endpoint),
      statusCode: response.status,
      elapsedMs,
    });
    throw error;
  }

  logOutboundDebug("actions.request.done", {
    action: params.action,
    endpoint: summarizeEndpoint(params.endpoint),
    statusCode: response.status,
    resultStatus: parsed.status,
    retcode: parsed.retcode,
    hasData: parsed.data != null,
    elapsedMs,
  });
  return parsed;
}

export function ensureOneBot11ActionOk(action: string, result: OneBot11ActionResponse): void {
  if (result.status === "ok") {
    logOutboundDebug("actions.result.ok", {
      action,
      resultStatus: result.status,
      retcode: result.retcode,
    });
    return;
  }
  const detail = result.wording || result.message || `retcode=${String(result.retcode ?? "unknown")}`;
  logOutboundError("actions.result.failed", summarizeError(detail), {
    action,
    resultStatus: result.status,
    retcode: result.retcode,
  });
  throw new Error(`OneBot11 action ${action} returned failure: ${detail}`);
}
