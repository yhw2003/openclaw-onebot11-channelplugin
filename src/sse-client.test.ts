import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOneBot11SseUrlCandidates, OneBot11SSEClient } from "./sse-client.js";

function makeSseResponse(body: string, contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": contentType,
    },
  });
}

describe("OneBot11SSEClient", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds fallback candidates when sseUrl is root", () => {
    expect(buildOneBot11SseUrlCandidates(" http://127.0.0.1:3000/ ")).toEqual([
      "http://127.0.0.1:3000/",
      "http://127.0.0.1:3000/_events",
      "http://127.0.0.1:3000/events",
      "http://127.0.0.1:3000/event",
      "http://127.0.0.1:3000/sse",
    ]);
  });

  it("keeps explicit SSE path as-is", () => {
    expect(buildOneBot11SseUrlCandidates("http://127.0.0.1:3000/events")).toEqual([
      "http://127.0.0.1:3000/events",
    ]);
  });

  it("falls back to /_events when root endpoint is not event-stream", async () => {
    const onEvent = vi.fn(async () => {});

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/")) {
        return makeSseResponse('{"ok":true}', "application/json");
      }
      if (url.endsWith("/_events")) {
        return makeSseResponse('data: {"post_type":"message"}\r\n\r\n');
      }
      return new Response("Not found", { status: 404 });
    });

    const client = new OneBot11SSEClient("http://127.0.0.1:3000/", {
      autoReconnect: false,
      onEvent,
    });

    await client.connect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://127.0.0.1:3000/_events");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ post_type: "message" });
  });
});
