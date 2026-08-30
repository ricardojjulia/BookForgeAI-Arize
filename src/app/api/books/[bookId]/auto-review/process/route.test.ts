import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/books/[bookId]/auto-review/process/route";

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => void) => callback()),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

describe("POST /api/books/[bookId]/auto-review/process", () => {
  it("accepts queued revisionJobId for rewrite-execute handoff", async () => {
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
      // Loop-stage completions are recorded per-iteration (see
      // stageStatusKey in the route) so a resumed request can't mistake a
      // prior iteration's work for the current one.
      "auto_accept@0",
      "drift_check@0",
      "critic_post:story_structure@0",
      "critic_post:prose_quality@0",
      "critic_post:continuity@0",
      "critic_post:character_depth@0",
      "critic_post:market_fit@0",
      "critic_post:contemporary_view@0",
      "critic_post:revision_priorities@0",
      "critic_post:dialogue_density@0",
      "critics_check@0",
      "export",
      "mark_finished",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: null,
      log: [],
      error: null,
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/rewrite-execute") && payload.serverManaged) {
        return new Response(
          JSON.stringify({ content: { revisionJobId: "33333333-3333-4333-8333-333333333333", queued: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/rewrite-execute") && payload.jobId) {
        expect(payload.jobId).toBe("33333333-3333-4333-8333-333333333333");
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("keeps dispatching rewrite-execute chunks until remainingUnits reaches zero", async () => {
    // The actual bug this covers: rewrite-execute processes one bounded
    // chunk (<=CONCURRENCY paragraphs) per call and expects the caller to
    // re-invoke it with the same jobId while remainingUnits > 0. Before the
    // fix, callStage fired exactly one "run" call and then just polled the
    // job row for status:"completed" -- which rewrite-execute never sets
    // while remainingUnits > 0 -- so a real multi-chunk rewrite never
    // progressed past its first chunk. This asserts every chunk actually
    // gets dispatched with the same job id, in sequence, until done.
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
      // Everything after rewrite_execute is already marked complete so the
      // loop stops right after it -- this test is only about the chunk
      // dispatch behavior, not the rest of the pipeline.
      "auto_accept@0",
      "drift_check@0",
      "critic_post:story_structure@0",
      "critic_post:prose_quality@0",
      "critic_post:continuity@0",
      "critic_post:character_depth@0",
      "critic_post:market_fit@0",
      "critic_post:contemporary_view@0",
      "critic_post:revision_priorities@0",
      "critic_post:dialogue_density@0",
      "critics_check@0",
      "export",
      "mark_finished",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: null,
      log: [],
      error: null,
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let chunkCallCount = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/rewrite-execute") && payload.serverManaged) {
        return new Response(
          JSON.stringify({ content: { revisionJobId: "chunked-rewrite-1", queued: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/rewrite-execute") && payload.jobId) {
        expect(payload.jobId).toBe("chunked-rewrite-1");
        chunkCallCount += 1;
        // Three chunks total: remainingUnits > 0 for the first two, 0 on
        // the third (matching rewrite-execute's own real response shape).
        const remainingUnits = chunkCallCount >= 3 ? 0 : 3 - chunkCallCount;
        return new Response(
          JSON.stringify({ content: { revisionJobId: "chunked-rewrite-1", remainingUnits, status: "running" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(chunkCallCount).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 queue call + 3 chunk calls
    fetchSpy.mockRestore();
  });

  it("actually re-runs rewrite/critic stages on a failed quality gate instead of exporting immediately", async () => {
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: null,
      log: [],
      error: null,
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let criticsCheckCalls = 0;
    let queuedJobCounter = 0;
    const criticPostCallsByLens: Record<string, number> = {};
    let markFinishedPayload: Record<string, unknown> | null = null;

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/mark-finished")) {
        markFinishedPayload = payload;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/auto-review/critics-check")) {
        criticsCheckCalls += 1;
        const allGreen = criticsCheckCalls >= 2;
        return new Response(
          JSON.stringify({ allGreen, greenCount: allGreen ? 8 : 7, total: 8, avgScore: allGreen ? 82 : 77 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/critic") && payload.lens) {
        if (payload.serverManaged) {
          queuedJobCounter += 1;
          return new Response(JSON.stringify({ content: { jobId: `critic-job-${queuedJobCounter}` } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        criticPostCallsByLens[payload.lens] = (criticPostCallsByLens[payload.lens] || 0) + 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/export")) {
        // Matches the real export route's actual response shape ({content:
        // {exportId, ...}}) -- the previous top-level {exportId} mock here
        // let a real bug ship silently: production code read result.exportId
        // directly, which is undefined against the real route's response,
        // so exportId was always null end to end even on a fully successful
        // run. These tests never asserted on the value, only that the call
        // succeeded, so nothing caught it. See mark-finished payload
        // assertion below for the actual regression check.
        return new Response(JSON.stringify({ content: { exportId: "export-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // rewrite-execute, auto-revision, drift-check: generic queue-then-run handoff.
      if (payload.serverManaged) {
        queuedJobCounter += 1;
        return new Response(JSON.stringify({ content: { jobId: `job-${queuedJobCounter}` } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (payload.jobId) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url} ${JSON.stringify(payload)}`);
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.ok).toBe(true);

    // Regression check for the real bug found live: mark-finished must
    // receive the actual exportId the export stage produced, not null --
    // production code was reading the wrong field off the export response
    // and silently threading `exportId: null` through, which made
    // mark-finished revert the book to "draft" even after a fully
    // successful review (see export mock comment above).
    expect((markFinishedPayload as { exportId?: string } | null)?.exportId).toBe("export-1");
    expect((payload as { exportId?: string }).exportId).toBe("export-1");

    // The quality gate failed once, so every post-rewrite stage must run
    // twice (once per iteration) -- this is what the stage-order bug broke:
    // it silently exported after a single pass no matter what the gate said.
    expect(criticsCheckCalls).toBe(2);
    expect(criticPostCallsByLens.story_structure).toBe(2);
    expect(criticPostCallsByLens.dialogue_density).toBe(2);

    fetchSpy.mockRestore();
  });

  it("re-runs loop stages on resume instead of skipping them as already-done from a prior iteration", async () => {
    // Simulates a job that finished iteration 0's rewrite/critic loop (those
    // stage names got persisted, unscoped, the way the pre-fix code always
    // wrote them), failed the gate, advanced to iteration 1, then crashed
    // before doing any iteration-1 work -- and is now being resumed via a
    // fresh POST. Without per-iteration keys, stageStatus would still
    // contain plain "rewrite_execute" etc. from iteration 0 and the resumed
    // run would wrongly treat iteration 1's work as already done.
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
      "rewrite_execute",
      "auto_accept",
      "drift_check",
      "critic_post:story_structure",
      "critic_post:prose_quality",
      "critic_post:continuity",
      "critic_post:character_depth",
      "critic_post:market_fit",
      "critic_post:contemporary_view",
      "critic_post:revision_priorities",
      "critic_post:dialogue_density",
      "critics_check",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 1,
      config: null,
      log: [],
      error: null,
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let criticsCheckCalls = 0;
    let queuedJobCounter = 0;
    let rewriteExecuteRunCalls = 0;
    const criticPostCallsByLens: Record<string, number> = {};

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/auto-review/critics-check")) {
        criticsCheckCalls += 1;
        return new Response(
          JSON.stringify({ allGreen: true, greenCount: 8, total: 8, avgScore: 91 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/critic") && payload.lens) {
        if (payload.serverManaged) {
          queuedJobCounter += 1;
          return new Response(JSON.stringify({ content: { jobId: `critic-job-${queuedJobCounter}` } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        criticPostCallsByLens[payload.lens] = (criticPostCallsByLens[payload.lens] || 0) + 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/export")) {
        // Matches the real export route's actual response shape ({content:
        // {exportId, ...}}) -- the previous top-level {exportId} mock here
        // let a real bug ship silently: production code read result.exportId
        // directly, which is undefined against the real route's response,
        // so exportId was always null end to end even on a fully successful
        // run. These tests never asserted on the value, only that the call
        // succeeded, so nothing caught it. See mark-finished payload
        // assertion below for the actual regression check.
        return new Response(JSON.stringify({ content: { exportId: "export-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/mark-finished")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/rewrite-execute") && !payload.serverManaged && payload.jobId) {
        rewriteExecuteRunCalls += 1;
      }

      // rewrite-execute, auto-revision, drift-check: generic queue-then-run handoff.
      if (payload.serverManaged) {
        queuedJobCounter += 1;
        return new Response(JSON.stringify({ content: { jobId: `job-${queuedJobCounter}` } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (payload.jobId) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url} ${JSON.stringify(payload)}`);
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.ok).toBe(true);

    // Iteration 1's rewrite/critic stages must actually run on resume, not
    // be skipped as if iteration 0's completions already covered them.
    expect(rewriteExecuteRunCalls).toBe(1);
    expect(criticsCheckCalls).toBe(1);
    expect(criticPostCallsByLens.story_structure).toBe(1);
    expect(criticPostCallsByLens.dialogue_density).toBe(1);

    fetchSpy.mockRestore();
  });

  it("reuses an already-finished stage job on resume instead of redispatching it", async () => {
    // Simulates the scenario that motivated this: a prior request's poll
    // gave up on rewrite_execute after 45 minutes and the whole auto-review
    // job got marked failed, but the underlying full-book rewrite kept
    // running server-side and DID finish successfully afterward. On resume,
    // the pipeline must notice that via the persisted pendingStageJob
    // pointer and treat the stage as done -- not silently pay to redo the
    // entire rewrite pass.
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: { pendingStageJob: { stage: "rewrite_execute", jobId: "stuck-rewrite-1" } },
      log: [],
      error: "Timed out waiting for stage job stuck-rewrite-1 to finish after 45 minutes.",
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      if (table === "revision_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { id: "stuck-rewrite-1", status: "completed" }, error: null })),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let rewriteExecuteFetchCalls = 0;
    let criticsCheckCalls = 0;
    let queuedJobCounter = 0;

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/rewrite-execute")) {
        rewriteExecuteFetchCalls += 1;
        throw new Error("rewrite-execute should not be re-dispatched when the pending job already completed");
      }

      if (url.includes("/auto-review/critics-check")) {
        criticsCheckCalls += 1;
        return new Response(
          JSON.stringify({ allGreen: true, greenCount: 8, total: 8, avgScore: 88 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/critic") && payload.lens) {
        if (payload.serverManaged) {
          queuedJobCounter += 1;
          return new Response(JSON.stringify({ content: { jobId: `critic-job-${queuedJobCounter}` } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/export")) {
        // Matches the real export route's actual response shape ({content:
        // {exportId, ...}}) -- the previous top-level {exportId} mock here
        // let a real bug ship silently: production code read result.exportId
        // directly, which is undefined against the real route's response,
        // so exportId was always null end to end even on a fully successful
        // run. These tests never asserted on the value, only that the call
        // succeeded, so nothing caught it. See mark-finished payload
        // assertion below for the actual regression check.
        return new Response(JSON.stringify({ content: { exportId: "export-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/mark-finished")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // auto-revision, drift-check: generic queue-then-run handoff.
      if (payload.serverManaged) {
        queuedJobCounter += 1;
        return new Response(JSON.stringify({ content: { jobId: `job-${queuedJobCounter}` } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (payload.jobId) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url} ${JSON.stringify(payload)}`);
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.ok).toBe(true);
    expect(rewriteExecuteFetchCalls).toBe(0);
    expect(criticsCheckCalls).toBe(1);

    fetchSpy.mockRestore();
  });

  it("keeps watching an in-flight stage job on resume instead of dispatching a duplicate", async () => {
    // Same starting point as the previous test, but this time the
    // underlying rewrite job is still genuinely running (not finished yet)
    // when we resume. The fix must resume polling that SAME job id, not
    // fire off a second full-book rewrite in parallel with the first.
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: { pendingStageJob: { stage: "rewrite_execute", jobId: "stuck-rewrite-2" } },
      log: [],
      error: "Timed out waiting for stage job stuck-rewrite-2 to finish after 45 minutes.",
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      if (table === "revision_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { id: "stuck-rewrite-2", status: "running" }, error: null })),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let rewriteExecuteFetchCalls = 0;
    let jobsPollCalls = 0;

    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/rewrite-execute")) {
        rewriteExecuteFetchCalls += 1;
        throw new Error("rewrite-execute should not be re-dispatched while the pending job is still running");
      }

      if (url.endsWith("/jobs")) {
        jobsPollCalls += 1;
        return new Response(
          JSON.stringify({ content: { jobs: [{ id: "stuck-rewrite-2", status: "completed" }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/auto-review/critics-check")) {
        return new Response(
          JSON.stringify({ allGreen: true, greenCount: 8, total: 8, avgScore: 88 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/critic") && payload.lens) {
        if (payload.serverManaged) {
          return new Response(JSON.stringify({ content: { jobId: "critic-job" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/export")) {
        // Matches the real export route's actual response shape ({content:
        // {exportId, ...}}) -- the previous top-level {exportId} mock here
        // let a real bug ship silently: production code read result.exportId
        // directly, which is undefined against the real route's response,
        // so exportId was always null end to end even on a fully successful
        // run. These tests never asserted on the value, only that the call
        // succeeded, so nothing caught it. See mark-finished payload
        // assertion below for the actual regression check.
        return new Response(JSON.stringify({ content: { exportId: "export-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/mark-finished")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (payload.serverManaged) {
        return new Response(JSON.stringify({ content: { jobId: "job-x" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (payload.jobId) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url} ${JSON.stringify(payload)}`);
    });

    vi.useFakeTimers();
    try {
      const responsePromise = POST(
        new Request("http://localhost/api/books/book-1/auto-review/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jobId: "11111111-1111-4111-8111-111111111111",
            mode: "full_review",
          }),
        }),
        { params: Promise.resolve({ bookId: "book-1" }) },
      );

      // Let the reuse-check's poll loop (8s interval) tick past its first
      // check, where our mocked /jobs response already reports "completed".
      await vi.advanceTimersByTimeAsync(9000);

      const response = await responsePromise;
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.ok).toBe(true);
      expect(rewriteExecuteFetchCalls).toBe(0);
      expect(jobsPollCalls).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      fetchSpy.mockRestore();
    }
  });

  it("returns checkpoint responses without marking the whole auto-review job completed", async () => {
    const completedStages = [
      "analyze",
      "summarize",
      "critic_baseline:story_structure",
      "critic_baseline:prose_quality",
      "critic_baseline:continuity",
      "critic_baseline:character_depth",
      "critic_baseline:market_fit",
      "critic_baseline:contemporary_view",
      "critic_baseline:revision_priorities",
      "critic_baseline:dialogue_density",
      "rewrite_plan",
    ];

    const initialJob = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      current_stage: "rewrite_execute",
      stages_completed: completedStages,
      iteration: 0,
      config: null,
      log: [],
      error: null,
      export_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    const updatePayloads: Record<string, unknown>[] = [];
    const updateMock = vi.fn((payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return { eq: vi.fn(async () => ({ error: null })) };
    });

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({ data: initialJob, error: null })),
                })),
                single: vi.fn(async () => ({ data: initialJob, error: null })),
              })),
            })),
          })),
          update: updateMock,
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    let now = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/rewrite-execute") && payload.serverManaged) {
        now = 701_000;
        return new Response(JSON.stringify({ content: { jobId: "rewrite-job-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/auto-review/process")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch call: ${url} ${JSON.stringify(payload)}`);
    });

    try {
      const response = await POST(
        new Request("http://localhost/api/books/book-1/auto-review/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jobId: "11111111-1111-4111-8111-111111111111",
            mode: "full_review",
          }),
        }),
        { params: Promise.resolve({ bookId: "book-1" }) },
      );

      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.checkpointed).toBe(true);
      expect(payload.nextStage).toBe("rewrite_execute");
      expect(updatePayloads).not.toContainEqual(expect.objectContaining({ status: "completed" }));
      expect(updatePayloads).not.toContainEqual(expect.objectContaining({ completed_at: expect.any(String) }));
    } finally {
      dateNowSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("returns launch acknowledgement when launchOnly is true", async () => {
    const jobBuilder = {
      select: vi.fn(() => jobBuilder),
      eq: vi.fn(() => jobBuilder),
      single: vi.fn(async () => ({
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          status: "queued",
          current_stage: "analyze",
          stages_completed: ["analyze"],
          iteration: 0,
          config: null,
          log: [],
          error: null,
          export_id: null,
          created_at: new Date().toISOString(),
          completed_at: null,
        },
        error: null,
      })),
    };

    const from = vi.fn((table: string) => {
      if (table === "auto_review_jobs") return jobBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from,
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/auto-review/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: "11111111-1111-4111-8111-111111111111",
          mode: "full_review",
          launchToken: "22222222-2222-4222-8222-222222222222",
          launchOnly: true,
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.accepted).toBe(true);
    expect(payload.launch?.jobId).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.launch?.launchToken).toBe("22222222-2222-4222-8222-222222222222");
  });
});
