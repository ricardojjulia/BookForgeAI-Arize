import type { AiTaskPreflightData } from "@/components/ai/ai-task-preflight";
import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { CRITIC_LENS_COUNT } from "@/lib/critic/progress";
import { fetchJson } from "@/lib/http/fetch-json";

type ModelStatusResponse = {
  connected: boolean;
  qualityProfile: string;
  contextWindowTokens: number;
  temperature: number;
  maxOutputTokens: number;
  runtimeLimits?: Record<
    string,
    {
      configuredContextTokens: number;
      maxOutputTokens: number;
      reservedTokens: number;
      usableInputTokens: number;
      promptCharBudget: number;
      warnings: string[];
    }
  >;
  configuredModels: Array<{ key: string; label: string; model: string; available: boolean }>;
  warnings: string[];
  cloudProvider?: {
    provider: string;
    model: string | null;
    executionMode: string;
    usedForPlanning: boolean;
    usedForRewrite: boolean;
  } | null;
};

/**
 * Preflight data for "run all baseline Critic lenses," the critic-all
 * subset of BookActions' openPreflight. Deliberately its own small,
 * self-contained function rather than a refactor of that 200+ line,
 * multi-task function -- callers outside BookActions (Guidance's
 * stale-Critic-data auto-refresh) need this exact estimate without
 * pulling in the book-bible/auto-review/generate-draft branches or
 * BookActions' own component state. A little estimate duplication here is
 * a much smaller risk than reworking an already-correct, heavily-used flow.
 */
export async function buildCriticAllPreflight(input: {
  bookId: string;
  chapterCount: number;
  sceneCount: number;
  paragraphCount: number;
}): Promise<AiTaskPreflightData> {
  const [status, historicalSecondsPerCall] = await Promise.all([
    fetchJson<ModelStatusResponse>("/api/lmstudio/status", { cache: "no-store" }, "LM Studio model status check"),
    fetchJson<{ content?: { estimate?: { secondsPerUnit: number; sampleSize: number } | null } }>(
      `/api/ai/estimation-history?task=${encodeURIComponent("bookforge_critic_batch")}`,
      { cache: "no-store" },
      "Historical estimate lookup",
    )
      .then((result) => result.content?.estimate?.secondsPerUnit ?? null)
      .catch(() => null),
  ]);

  const configured = status.configuredModels.find((item) => item.key === "reasoningModel");
  const selectedModel = configured?.model || "";
  const isCloudReadyForTask = Boolean(status.cloudProvider?.model && status.cloudProvider.usedForPlanning);
  const runtimeLimits = status.runtimeLimits?.critic || status.runtimeLimits?.planning;
  const plan = estimateAiCallPlan({
    task: "critic",
    selectedModel,
    qualityProfile: status.qualityProfile,
    contextWindowTokens: runtimeLimits?.configuredContextTokens || status.contextWindowTokens,
    maxOutputTokens: runtimeLimits?.maxOutputTokens || status.maxOutputTokens,
    chapterCount: input.chapterCount,
    sceneCount: input.sceneCount,
    paragraphCount: input.paragraphCount,
    historicalSecondsPerCall,
  });

  const warnings = [
    ...status.warnings,
    ...(runtimeLimits?.warnings || []),
    ...plan.warnings,
    ...(selectedModel ? [] : [`${configured?.label || "Reasoning"} model is not configured.`]),
    ...(input.paragraphCount === 0
      ? ['This book has no drafted manuscript prose yet -- Critic evaluates chapter text, not outline summaries. Run "Write Your Chapters" first.']
      : []),
    `BookForge will run all ${CRITIC_LENS_COUNT} baseline Critic lenses. This is the fastest way to refresh Critic coverage before generating updated guidance.`,
  ];

  return {
    taskName: "Refresh BookForge Critic",
    taskDescription:
      "Your manuscript has changed since Critic last ran. Re-evaluate through every baseline Critic lens so Guidance's next analysis reflects the current text.",
    requiredModelType: "Reasoning model",
    selectedModel,
    lmStudioConnected: status.connected || isCloudReadyForTask,
    modelAvailable: Boolean(configured?.available) || isCloudReadyForTask,
    blocked: input.paragraphCount === 0,
    estimatedUnits: CRITIC_LENS_COUNT,
    expectedAiCalls: CRITIC_LENS_COUNT,
    qualityProfile: status.qualityProfile,
    contextSize: status.contextWindowTokens,
    temperature: status.temperature,
    maxOutputTokens: runtimeLimits?.maxOutputTokens || status.maxOutputTokens,
    planningMath: plan.math,
    targetTokensPerCall: plan.targetTokensPerCall,
    usableContextTokens: runtimeLimits?.usableInputTokens || plan.usableContextTokens,
    estimatedSecondsPerCall: plan.estimatedSecondsPerCall,
    estimatedTotalSeconds: plan.estimatedSecondsPerCall * CRITIC_LENS_COUNT,
    unitStrategy: plan.unitStrategy,
    modelSizeB: plan.modelSizeB,
    quantization: plan.quantization,
    warnings,
  };
}
