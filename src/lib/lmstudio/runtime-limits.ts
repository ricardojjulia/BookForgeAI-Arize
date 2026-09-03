import type { LmStudioSettings } from "@/lib/types";

export type LmStudioRuntimeLimits = {
  configuredContextTokens: number;
  maxOutputTokens: number;
  reservedTokens: number;
  usableInputTokens: number;
  promptCharBudget: number;
  warnings: string[];
};

export function getLmStudioRuntimeLimits(
  settings: Pick<LmStudioSettings, "contextWindowTokens" | "maxOutputTokens">,
  task: "planning" | "rewrite" | "critic" | "extraction" = "planning",
): LmStudioRuntimeLimits {
  const configuredContextTokens = clampNumber(settings.contextWindowTokens || 0, 4096, 262144);
  const taskOutputCeiling = task === "rewrite" ? 1800 : task === "critic" ? 3000 : task === "extraction" ? 2200 : 3200;
  const maxOutputTokens = Math.min(
    clampNumber(settings.maxOutputTokens || 0, 512, 12000),
    taskOutputCeiling,
    Math.max(512, Math.floor(configuredContextTokens * 0.25)),
  );
  const reservedTokens = Math.max(1200, maxOutputTokens + 900);
  const usableInputTokens = Math.max(700, Math.floor((configuredContextTokens - reservedTokens) * 0.72));
  const promptCharBudget = Math.max(2800, Math.floor(usableInputTokens * 3.2));
  const warnings = [
    ...(settings.maxOutputTokens > maxOutputTokens
      ? [
          `Max output was clamped from ${settings.maxOutputTokens.toLocaleString()} to ${maxOutputTokens.toLocaleString()} tokens for this task so there's enough room left for the prompt.`,
        ]
      : []),
    ...(configuredContextTokens < 8192
      ? ["Configured context is small. BookForge will use compact prompts and smaller rewrite units."]
      : []),
    ...(configuredContextTokens < 16384 && task !== "rewrite"
      ? ["For book-level planning and Critic work, a 16k+ context window is strongly recommended."]
      : []),
  ];

  return {
    configuredContextTokens,
    maxOutputTokens,
    reservedTokens,
    usableInputTokens,
    promptCharBudget,
    warnings,
  };
}

export function isLmStudioContextError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /context length|tokens to keep|n_ctx|prompt.*too.*long|context.*overflow/i.test(message);
}

export function getLmStudioContextErrorMessage(error: unknown, limits: LmStudioRuntimeLimits) {
  const original = error instanceof Error ? error.message : String(error || "");
  return [
    "LM Studio rejected the prompt because the loaded model context is smaller than this task needs.",
    `BookForge used a compact prompt budget of about ${limits.usableInputTokens.toLocaleString()} input tokens and ${limits.maxOutputTokens.toLocaleString()} output tokens.`,
    "In LM Studio, reload the selected model with a larger context length, or lower Settings -> Context window tokens and Max output tokens so BookForge plans smaller prompts.",
    `Original LM Studio error: ${original}`,
  ].join(" ");
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
