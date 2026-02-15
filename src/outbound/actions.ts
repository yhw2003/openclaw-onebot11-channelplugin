import type { OneBot11ActionResponse } from "../types.js";

type SendOneBot11ActionParams = {
  endpoint: string;
  action: string;
  payload: Record<string, unknown>;
  accessToken?: string;
};

export async function sendOneBot11Action<T = unknown>(
  params: SendOneBot11ActionParams,
): Promise<OneBot11ActionResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.accessToken?.trim()) {
    headers.Authorization = `Bearer ${params.accessToken.trim()}`;
  }

  const response = await fetch(`${params.endpoint}/${params.action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OneBot11 action ${params.action} failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }

  return (await response.json()) as OneBot11ActionResponse<T>;
}

export function ensureOneBot11ActionOk(action: string, result: OneBot11ActionResponse): void {
  if (result.status === "ok") {
    return;
  }
  const detail = result.wording || result.message || `retcode=${String(result.retcode ?? "unknown")}`;
  throw new Error(`OneBot11 action ${action} returned failure: ${detail}`);
}
