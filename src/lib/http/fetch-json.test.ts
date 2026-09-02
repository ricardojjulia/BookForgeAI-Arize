import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "@/lib/http/fetch-json";

describe("fetchJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose raw Next.js HTML error pages to UI callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!DOCTYPE html><html><head><style>body{display:none}</style></head><body>Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      })),
    );

    await expect(fetchJson("/api/books/book-1/critic", { method: "POST" }, "Run critic")).rejects.toThrow(
      "Run critic failed with HTTP 500: the server returned an HTML error page instead of JSON. Check server logs for the underlying error.",
    );
  });

  it("preserves JSON error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "LM Studio model is unavailable." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })),
    );

    await expect(fetchJson("/api/lmstudio/test", {}, "LM Studio test")).rejects.toThrow("LM Studio model is unavailable.");
  });
});
