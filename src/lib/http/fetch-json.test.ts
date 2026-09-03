import { describe, expect, it, vi } from "vitest";
import { fetchJson } from "@/lib/http/fetch-json";

function mockFetchResponse(body: string, init: { status?: number; contentType?: string } = {}) {
  const { status = 500, contentType } = init;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType ?? null : null),
    },
    text: async () => body,
  } as unknown as Response;
}

describe("fetchJson", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockFetchResponse(JSON.stringify({ ok: true }), { status: 200, contentType: "application/json" })),
    );

    const result = await fetchJson<{ ok: boolean }>("/api/whatever");
    expect(result.ok).toBe(true);

    vi.unstubAllGlobals();
  });

  it("surfaces a clean message instead of a raw Next.js HTML error page", async () => {
    const html = "<!DOCTYPE html><html><head><title>500: Internal Server Error</title></head><body>stack trace...</body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockFetchResponse(html, { status: 500, contentType: "text/html; charset=utf-8" })),
    );

    await expect(fetchJson("/api/books/1/critic", {}, "Re-evaluating Story Structure")).rejects.toThrow(
      "Re-evaluating Story Structure failed with HTTP 500: the server returned an HTML error page instead of JSON. Check server logs for the underlying error.",
    );

    vi.unstubAllGlobals();
  });

  it("detects an HTML document body even without a text/html content-type header", async () => {
    const html = "<html><body>Internal Server Error</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(html, { status: 502 })));

    await expect(fetchJson("/api/books/1/critic", {}, "Critic stage")).rejects.toThrow(
      "the server returned an HTML error page instead of JSON",
    );

    vi.unstubAllGlobals();
  });

  it("detects escaped HTML documents copied from framework error responses", async () => {
    const html = "&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;style&gt;body{display:none}&lt;/style&gt;&lt;/head&gt;";
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(html, { status: 500, contentType: "text/plain" })));

    await expect(fetchJson("/api/books/1/critic", {}, "Critic stage")).rejects.toThrow(
      "the server returned an HTML error page instead of JSON",
    );

    vi.unstubAllGlobals();
  });

  it("still surfaces the JSON error field for normal application errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockFetchResponse(JSON.stringify({ error: "Book not found" }), { status: 404, contentType: "application/json" }),
      ),
    );

    await expect(fetchJson("/api/books/1", {}, "Loading book")).rejects.toThrow("Book not found");

    vi.unstubAllGlobals();
  });

  it("truncates non-HTML, non-JSON bodies to 500 chars instead of leaking the full payload", async () => {
    const longText = "x".repeat(1000);
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(longText, { status: 500, contentType: "text/plain" })));

    await expect(fetchJson("/api/whatever", {}, "Request")).rejects.toThrow("x".repeat(500));

    vi.unstubAllGlobals();
  });
});
