import { describe, expect, it } from "vitest";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";

describe("getLmStudioErrorMessage", () => {
  it("blames the actual cloud provider for a connection failure instead of LM Studio", () => {
    const message = getLmStudioErrorMessage(new Error("fetch failed"), "fallback", { modelSource: "openrouter" });
    expect(message).toContain("OpenRouter");
    expect(message).not.toContain("LM Studio");
  });

  it("still blames LM Studio when no cloud provider is configured", () => {
    const message = getLmStudioErrorMessage(new Error("fetch failed"), "fallback", {});
    expect(message).toContain("LM Studio");
  });

  it("explains unsupported LM Studio runtime/model-format load failures", () => {
    const message = getLmStudioErrorMessage(
      new Error(
        `LM Studio model load failed with HTTP 500. { "error": { "type": "model_load_failed", "message": "Failed to load LLM 'gemma-4-31b-it-assistant': Error: No LM Runtime found for model format 'torchSafetensors'!" } }`,
      ),
      "fallback",
      { model: "gemma-4-31b-it-assistant", task: "planning" },
    );

    expect(message).toContain("file format is not supported");
    expect(message).toContain("Expected model: gemma-4-31b-it-assistant.");
    expect(message).toContain("GGUF");
  });
});
