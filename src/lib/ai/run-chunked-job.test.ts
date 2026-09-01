import { afterEach, describe, expect, it, vi } from "vitest";
import { runChunkedJob } from "@/lib/ai/run-chunked-job";

describe("runChunkedJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks chunk requests as externally driven so route self-chaining stays disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: { jobId: "job-1" } }))
      .mockResolvedValueOnce(jsonResponse({ content: { status: "completed", remainingUnits: 0 } }));

    vi.stubGlobal("fetch", fetchMock);

    await runChunkedJob("/api/rewrite", { maxUnits: 5 }, "Rewrite");

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      maxUnits: 5,
      serverManaged: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      maxUnits: 5,
      jobId: "job-1",
      externalDriver: true,
    });
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
