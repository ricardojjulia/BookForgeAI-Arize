import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/books/[bookId]/critic/all/route";

const {
  mockCreateClient,
  mockRunCriticLens,
  mockPreloadCriticRunContext,
  mockPreloadCriticModelExecution,
  mockGetUserLmStudioSettings,
  mockSelectAndPrepareActiveModel,
} = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockRunCriticLens: vi.fn(),
  mockPreloadCriticRunContext: vi.fn(),
  mockPreloadCriticModelExecution: vi.fn(),
  mockGetUserLmStudioSettings: vi.fn(),
  mockSelectAndPrepareActiveModel: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/critic/run", () => ({
  runCriticLens: mockRunCriticLens,
  preloadCriticRunContext: mockPreloadCriticRunContext,
  preloadCriticModelExecution: mockPreloadCriticModelExecution,
}));

vi.mock("@/lib/lmstudio/settings", () => ({
  getUserLmStudioSettings: mockGetUserLmStudioSettings,
}));

vi.mock("@/lib/lmstudio/orchestrator", () => ({
  selectAndPrepareActiveModel: mockSelectAndPrepareActiveModel,
}));

vi.mock("@/lib/lmstudio/model-selection", () => ({
  getReasoningModelCandidates: vi.fn(() => []),
}));

vi.mock("@/lib/lmstudio/client", () => ({
  createManagedChatCompletion: vi.fn(),
}));

vi.mock("@/lib/ai/job-state", () => ({
  buildJobProgress: vi.fn((value) => value),
  createRevisionJobHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
  getRevisionJobStatus: vi.fn(async () => "running"),
  updateRevisionJobProgress: vi.fn(async (_supabase, _jobId, settings) => settings),
  waitWhileRevisionJobPaused: vi.fn(async () => "running"),
}));

vi.mock("@/lib/critic/prompts", () => ({
  criticLenses: {
    story_structure: { label: "Story structure" },
    prose_quality: { label: "Prose quality" },
    continuity: { label: "Continuity" },
  },
}));

describe("POST /api/books/[bookId]/critic/all", () => {
  it("continues processing remaining lenses when one lens fails", async () => {
    const snapshotSingle = vi.fn(async () => ({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        book_id: "book-1",
        branch_name: "main",
        parent_snapshot_id: null,
        status: "active",
        title: "Baseline",
        summary: null,
        metadata_json: {},
        source_type: "initial_plan",
        source_ref_id: null,
        created_by: "user-1",
        created_at: "2026-07-27T00:00:00.000Z",
        updated_at: "2026-07-27T00:00:00.000Z",
        archived_at: null,
      },
      error: null,
    }));
    const snapshotEqId = vi.fn(() => ({ maybeSingle: snapshotSingle }));
    const snapshotEqBook = vi.fn(() => ({ eq: snapshotEqId }));
    const snapshotSelect = vi.fn(() => ({ eq: snapshotEqBook }));

    const revisionJobSingle = vi.fn(async () => ({ data: { id: "job-1" }, error: null }));
    const revisionJobSelect = vi.fn(() => ({ single: revisionJobSingle }));
    const revisionJobInsert = vi.fn(() => ({ select: revisionJobSelect }));
    const revisionJobUpdate = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));

    const coherenceInsert = vi.fn(async () => ({ error: null }));

    const from = vi.fn((table: string) => {
      if (table === "book_metadata_snapshots") {
        return {
          select: snapshotSelect,
        };
      }
      if (table === "revision_jobs") {
        return {
          insert: revisionJobInsert,
          update: revisionJobUpdate,
        };
      }
      if (table === "coherence_reports") {
        return {
          insert: coherenceInsert,
        };
      }
      if (table === "paragraphs") {
        return { select: vi.fn(() => ({ eq: vi.fn(async () => ({ count: 1, error: null })) })) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
      from,
    });

    mockPreloadCriticRunContext.mockResolvedValue({
      title: "Book",
      bookBible: null,
      chapterRows: [],
      acceptedRevisionContext: [],
      sceneCount: 0,
      paragraphCount: 0,
    });
    mockPreloadCriticModelExecution.mockResolvedValue({
      settings: {},
      modelPlan: { preparedModel: { isCloud: false } },
    });

    mockRunCriticLens.mockImplementation(async ({ lens }: { lens: string }) => {
      if (lens === "prose_quality") {
        throw new Error("model timeout");
      }
      return { score: lens === "story_structure" ? 80 : 72 };
    });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/critic/all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadataSnapshotId: "11111111-1111-4111-8111-111111111111",
          metadataBranchName: "main",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.content?.completed).toBe(2);
    expect(payload.content?.failed).toBe(1);
    expect(payload.content?.failedUnits?.length).toBe(1);
    expect(payload.content?.failedUnits?.[0]?.id).toBe("prose_quality");
    expect(mockRunCriticLens).toHaveBeenCalledTimes(3);
    expect(coherenceInsert).toHaveBeenCalledTimes(1);
  });

  it("queues a critic batch job with metadata snapshot provenance", async () => {
    const snapshotSingle = vi.fn(async () => ({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        book_id: "book-1",
        branch_name: "main",
        parent_snapshot_id: null,
        status: "active",
        title: "Baseline",
        summary: null,
        metadata_json: {},
        source_type: "initial_plan",
        source_ref_id: null,
        created_by: "user-1",
        created_at: "2026-07-27T00:00:00.000Z",
        updated_at: "2026-07-27T00:00:00.000Z",
        archived_at: null,
      },
      error: null,
    }));
    const snapshotEqId = vi.fn(() => ({ maybeSingle: snapshotSingle }));
    const snapshotEqBook = vi.fn(() => ({ eq: snapshotEqId }));
    const snapshotSelect = vi.fn(() => ({ eq: snapshotEqBook }));

    const revisionJobSingle = vi.fn(async () => ({ data: { id: "job-1" }, error: null }));
    const revisionJobSelect = vi.fn(() => ({ single: revisionJobSingle }));
    const revisionJobInsert = vi.fn(() => ({ select: revisionJobSelect }));
    const revisionJobUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) }));

    const coherenceInsert = vi.fn(async () => ({ error: null }));

    const from = vi.fn((table: string) => {
      if (table === "book_metadata_snapshots") {
        return {
          select: snapshotSelect,
        };
      }
      if (table === "revision_jobs") {
        return {
          insert: revisionJobInsert,
          update: revisionJobUpdate,
        };
      }
      if (table === "coherence_reports") {
        return {
          insert: coherenceInsert,
        };
      }
      if (table === "books") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: { title: "Book", genre: "Fiction", target_audience: "Adults" }, error: null })) })) })),
        };
      }
      if (table === "book_bibles") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })) };
      }
      if (table === "chapters") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(async () => ({ data: [], error: null })) })) })) };
      }
      if (table === "scenes") {
        return { select: vi.fn(() => ({ eq: vi.fn(async () => ({ count: 0, error: null })) })) };
      }
      if (table === "paragraphs") {
        return { select: vi.fn(() => ({ eq: vi.fn(async () => ({ count: 1, error: null })) })) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
      from,
    });

    mockGetUserLmStudioSettings.mockResolvedValue({
      temperature: 0.4,
      topP: 1,
      maxOutputTokens: 2200,
      contextWindowTokens: 64000,
    });
    mockSelectAndPrepareActiveModel.mockResolvedValue({
      client: {},
      preparedModel: { runtimeLimits: { configuredContextTokens: 64000, maxOutputTokens: 2200, promptCharBudget: 1000 }, warnings: [] },
      model: "model-1",
      modelSelection: { source: "manual", selectionReason: "test", selectedScore: 1 },
      availableModels: [],
    });
    mockRunCriticLens.mockResolvedValue({ score: 91 });

    const response = await POST(
      new Request("http://localhost/api/books/book-1/critic/all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverManaged: true,
          metadataSnapshotId: "11111111-1111-4111-8111-111111111111",
          metadataBranchName: "main",
        }),
      }),
      { params: Promise.resolve({ bookId: "book-1" }) },
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.content?.queued).toBe(true);
    expect(payload.content?.jobId).toBe("job-1");
  });
});
