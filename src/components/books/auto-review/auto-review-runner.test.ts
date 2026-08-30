import { describe, expect, it } from "vitest";
import { isAutoReviewStageComplete } from "@/components/books/auto-review/auto-review-runner";

describe("isAutoReviewStageComplete", () => {
  it("matches iteration-scoped loop stages for the current cycle", () => {
    const completed = new Set([
      "rewrite_execute@2",
      "auto_accept@2",
      "drift_check@2",
      "critic_post:character_depth@2",
      "critics_check@2",
      "export",
      "mark_finished",
    ]);

    expect(isAutoReviewStageComplete("rewrite_execute", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("auto_accept", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("drift_check", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("critic_post:character_depth", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("critics_check", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("export", completed, 2)).toBe(true);
    expect(isAutoReviewStageComplete("mark_finished", completed, 2)).toBe(true);
  });

  it("does not mark a loop stage complete from another cycle", () => {
    const completed = new Set(["rewrite_execute@1"]);

    expect(isAutoReviewStageComplete("rewrite_execute", completed, 2)).toBe(false);
  });
});
