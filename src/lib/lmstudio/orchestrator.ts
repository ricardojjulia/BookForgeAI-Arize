import OpenAI from "openai";
import {
  createLmStudioClient,
  listNativeLmStudioModels,
  prepareLmStudioModelForTask,
  testLmStudioConnection,
  unloadNativeLmStudioModel,
  type LmStudioTaskKind,
  type ModelCallTelemetryContext,
  type NativeLmStudioModel,
  type PreparedLmStudioModel,
} from "@/lib/lmstudio/client";
import type { LmStudioModelSelection } from "@/lib/lmstudio/model-selection";
import { createProviderClient, PROVIDER_META } from "@/lib/ai/providers";
import {
  getHealthFor,
  getModelsTaskHealth,
  scoreHealthAdjustment,
  type ModelCallTelemetry,
  type ModelTaskHealth,
} from "@/lib/ai/model-performance";
import { assertModelAllowedForUser } from "@/lib/subscription/enforcement";
import type { LmStudioSettings } from "@/lib/types";

type ModelCandidate = {
  label: string;
  model?: string;
};

export type LmStudioTaskProfile = {
  task: LmStudioTaskKind;
  candidates: ModelCandidate[];
  expectedCalls?: number;
  latencyPreference?: "fast" | "balanced" | "quality";
  allowModelLoad?: boolean;
  allowUnload?: boolean;
  /**
   * Required: scoring is adjusted by empirical per-model history, the call is
   * recorded to model_call_events, and (for cloud calls) it's what
   * selectAndPrepareActiveModel uses to run the subscription-tier
   * allowlist check before any provider is invoked. Every real call site
   * already has a userId/supabase available -- if a future route doesn't,
   * that's a gap worth a compile error, not a silent skip.
   */
  telemetry: ModelCallTelemetry;
};

export type PreparedLmStudioTaskModel = {
  model: string;
  preparedModel: PreparedLmStudioModel;
  modelSelection: LmStudioModelSelection & {
    selectedScore: number;
    selectionReason: string;
    unloadedInstances: string[];
  };
  availableModels: string[];
  nativeModelsAvailable: boolean;
  /**
   * Deliberately NOT part of `preparedModel` — several routes persist that object
   * wholesale into a jsonb column, and this carries a live Supabase client that
   * would break JSON serialization there. Pass this separately into
   * createManagedChatCompletion's telemetryContext argument instead.
   */
  telemetryContext?: ModelCallTelemetryContext;
};

type ScoredModel = {
  model: string;
  score: number;
  reason: string;
  loaded: boolean;
  loadedContextTokens: number | null;
  configuredLabel: string | null;
  /** Canonical loaded-instance/native-key identity, used for empirical health lookups so aliases (e.g. "model@6bit" vs "model") of the same loaded model share history. */
  healthKey: string;
};

export async function selectAndPrepareLmStudioModel(
  settings: LmStudioSettings,
  profile: LmStudioTaskProfile,
): Promise<PreparedLmStudioTaskModel> {
  const [nativeResult, openAiModels] = await Promise.all([
    getNativeModels(settings),
    getOpenAiModels(settings),
  ]);
  const availableModels = mergeAvailableModels(nativeResult.models, openAiModels);
  const configuredModels = profile.candidates.map((candidate) =>
    candidate.model ? `${candidate.label}: ${candidate.model}` : `${candidate.label}: not configured`,
  );
  const health = profile.telemetry
    ? await getModelsTaskHealth(profile.telemetry.supabase, {
        userId: profile.telemetry.userId,
        models: availableModels,
        task: profile.task,
      })
    : new Map<string, ModelTaskHealth>();
  const candidates = scoreCandidates({
    nativeModels: nativeResult.models,
    availableModels,
    configuredCandidates: profile.candidates,
    settings,
    profile,
    health,
  });
  const fallbackModel = profile.candidates.find((candidate) => candidate.model)?.model || availableModels[0] || "local-model";
  const selected = candidates[0] || {
    model: fallbackModel,
    score: 0,
    reason: "Default fallback because no suitable LM Studio model was detected.",
    loaded: false,
    loadedContextTokens: null,
    configuredLabel: null,
    healthKey: fallbackModel,
  };
  const preparedModel = await prepareLmStudioModelForTask({
    settings,
    model: selected.model,
    task: profile.task,
    allowModelLoad: profile.allowModelLoad ?? true,
    modelHealth: getHealthFor(health, selected.healthKey),
  });
  const telemetryContext: ModelCallTelemetryContext | undefined = profile.telemetry
    ? {
        ...profile.telemetry,
        task: profile.task,
        model: preparedModel.model || selected.model,
        provider: "lmstudio",
        execution: "local",
        requestedModel: selected.model,
      }
    : undefined;
  const unloadedInstances =
    profile.allowUnload && (profile.expectedCalls || 0) >= 3
      ? await unloadUnusedLoadedModels(settings, nativeResult.models, preparedModel.model)
      : [];

  return {
    model: preparedModel.model || selected.model,
    preparedModel,
    availableModels,
    nativeModelsAvailable: nativeResult.available,
    telemetryContext,
    modelSelection: {
      model: preparedModel.model || selected.model,
      source: selected.configuredLabel || selected.reason,
      configuredModels,
      availableModels,
      usedLoadedFallback: !profile.candidates.some((candidate) => candidate.model === selected.model),
      selectedScore: selected.score,
      selectionReason: selected.reason,
      unloadedInstances,
    },
  };
}

async function getNativeModels(settings: LmStudioSettings) {
  try {
    return { available: true, models: await listNativeLmStudioModels(settings) };
  } catch {
    return { available: false, models: [] as NativeLmStudioModel[] };
  }
}

async function getOpenAiModels(settings: LmStudioSettings) {
  try {
    return (await testLmStudioConnection({ baseUrl: settings.baseUrl })).models;
  } catch {
    return [];
  }
}

/**
 * The canonical identity for a native model entry: prefer the actual loaded
 * instance id (what LM Studio is really running), falling back to its catalog
 * key. This is the one string used for scoring, health tracking, and display —
 * `display_name`/`selected_variant`/OpenAI-compat quant-suffixed aliases (e.g.
 * "qwen/qwen3.6-35b-a3b@6bit") are all names for the same physical model and
 * must not appear as separate entries.
 */
function canonicalModelId(model: NativeLmStudioModel): string {
  return model.loaded_instances?.[0]?.id || model.key;
}

/**
 * Builds the deduplicated list of model identities to score/display: one
 * canonical entry per native model, plus any OpenAI-compat-listed name that
 * doesn't already alias a known native model (e.g. a model LM Studio's native
 * API doesn't report, only its OpenAI-compatible endpoint does).
 */
function mergeAvailableModels(nativeModels: NativeLmStudioModel[], openAiModels: string[]) {
  const knownAliases = new Set(
    nativeModels.flatMap((model) =>
      [model.key, model.display_name, model.selected_variant, ...(model.loaded_instances || []).map((instance) => instance.id)].filter(
        isString,
      ),
    ),
  );
  const canonicalNativeIds = nativeModels.map(canonicalModelId).filter(isString);
  const unaliasedOpenAiModels = openAiModels.filter((name) => !knownAliases.has(name));

  return Array.from(new Set([...canonicalNativeIds, ...unaliasedOpenAiModels])).filter(Boolean);
}

function scoreCandidates(input: {
  nativeModels: NativeLmStudioModel[];
  availableModels: string[];
  configuredCandidates: ModelCandidate[];
  settings: LmStudioSettings;
  profile: LmStudioTaskProfile;
  health: Map<string, ModelTaskHealth>;
}) {
  const configuredByModel = new Map(
    input.configuredCandidates.filter((candidate) => candidate.model).map((candidate) => [candidate.model as string, candidate.label]),
  );
  return input.availableModels
    .map((model) => scoreModel(model, configuredByModel.get(model) || null, input))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
}

function scoreModel(
  model: string,
  configuredLabel: string | null,
  input: {
    nativeModels: NativeLmStudioModel[];
    settings: LmStudioSettings;
    profile: LmStudioTaskProfile;
    health: Map<string, ModelTaskHealth>;
  },
): ScoredModel {
  const name = model.toLowerCase();
  const native = findNativeModel(input.nativeModels, model);
  const loadedInstance = native?.loaded_instances?.find((instance) => instance.id === model) || native?.loaded_instances?.[0] || null;
  const healthKey = native ? canonicalModelId(native) : model;
  const loadedContextTokens = loadedInstance?.config?.context_length || null;
  const maxContextTokens = native?.max_context_length || loadedContextTokens || input.settings.contextWindowTokens;
  const requiredContextTokens = Math.min(input.settings.contextWindowTokens, maxContextTokens);
  const expectedCalls = input.profile.expectedCalls || 1;
  const reasons: string[] = [];
  let score = 0;

  if (isEmbeddingOrReranker(name)) return { model, score: 0, reason: "Embedding/reranker model is not valid for chat tasks.", loaded: false, loadedContextTokens: null, configuredLabel, healthKey };
  add(20, "generation model");
  if (configuredLabel) add(12, `${configuredLabel} setting`);
  if (loadedContextTokens && loadedContextTokens >= requiredContextTokens) add(expectedCalls <= 2 ? 34 : 24, "already loaded with enough context");
  else if (loadedContextTokens) add(8, "already loaded but context may need reload");
  if (maxContextTokens >= input.settings.contextWindowTokens) add(18, "supports configured context");
  else if (maxContextTokens >= 16384) add(8, "supports medium context");
  else add(-20, "small context");

  if (/instruct|chat|assistant|it\b/.test(name)) add(14, "instruction tuned");
  if (/qwen/.test(name)) add(12, "Qwen family fit");
  if (/mistral|llama|gemma/.test(name)) add(8, "general prose family fit");

  if (input.profile.task === "rewrite") {
    if (/reason|r1|deepseek|coder|code/.test(name)) add(-22, "less ideal for prose rewrite");
    addSizeScore(name, input.settings.qualityProfile === "fast" ? [8, 24, 18] : [24, 45, 22]);
  } else if (input.profile.task === "critic" || input.profile.task === "planning") {
    if (/reason|r1|deepseek|thinking/.test(name)) add(16, "reasoning fit");
    addSizeScore(name, input.profile.latencyPreference === "fast" ? [7, 20, 12] : [24, 45, 18]);
  } else {
    if (/reason|r1|deepseek/.test(name)) add(-10, "heavier than needed for extraction");
    addSizeScore(name, [7, 24, 18]);
  }

  if (expectedCalls >= 10 && getModelSizeB(name) >= 60) add(-20, "large model is expensive for many calls");
  if (input.profile.latencyPreference === "fast" && getModelSizeB(name) >= 30) add(-10, "slower than fast preference");
  if (input.profile.latencyPreference === "quality" && getModelSizeB(name) >= 30) add(8, "quality preference");

  const healthAdjustment = scoreHealthAdjustment(getHealthFor(input.health, healthKey));
  if (healthAdjustment.reason) add(healthAdjustment.points, healthAdjustment.reason);

  return {
    model,
    score: Math.max(0, score),
    reason: reasons.slice(0, 4).join("; ") || "Best available fit.",
    loaded: Boolean(loadedContextTokens),
    loadedContextTokens,
    configuredLabel,
    healthKey,
  };

  function add(points: number, reason: string) {
    score += points;
    if (points > 0) reasons.push(reason);
  }

  function addSizeScore(value: string, [min, max, points]: [number, number, number]) {
    const size = getModelSizeB(value);
    if (size >= min && size <= max) add(points, `${size}B size fit`);
    else if (size > 0 && size < min) add(6, `${size}B fast fallback`);
    else if (size > max) add(10, `${size}B high-capacity fallback`);
  }
}

async function unloadUnusedLoadedModels(settings: LmStudioSettings, nativeModels: NativeLmStudioModel[], selectedModel: string) {
  const loadedInstances = nativeModels.flatMap((model) => model.loaded_instances || []);
  const unused = loadedInstances.filter((instance) => instance.id !== selectedModel);
  const unloaded: string[] = [];

  for (const instance of unused) {
    try {
      await unloadNativeLmStudioModel(settings, instance.id);
      unloaded.push(instance.id);
    } catch {
      // Non-critical optimization. A failed unload should not fail the user task.
    }
  }

  return unloaded;
}

function findNativeModel(models: NativeLmStudioModel[], model: string) {
  return models.find((item) =>
    [item.key, item.display_name, item.selected_variant, ...(item.loaded_instances || []).map((instance) => instance.id)]
      .filter(isString)
      .some((value) => value === model),
  );
}

function getModelSizeB(name: string) {
  const billion = name.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (billion) return Number(billion[1]);
  const compact = name.match(/(?:^|[-_/ ])(\d{1,3})(?:b)(?:[-_/ ]|$)/);
  return compact ? Number(compact[1]) : 0;
}

function isEmbeddingOrReranker(name: string) {
  return /embed|embedding|rerank|reranker|cross[-_ ]?encoder|\bbge[-_ ]?m3\b|nomic/.test(name);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ---------------------------------------------------------------------------
// Unified active-provider entry point
// ---------------------------------------------------------------------------

export type ActiveModelPlan = PreparedLmStudioTaskModel & { client: OpenAI };

/**
 * Resolves the right AI client and prepared model based on the user's active
 * provider setting. Routes should call this instead of separately calling
 * `createLmStudioClient` + `selectAndPrepareLmStudioModel`.
 *
 * - Cloud provider (OpenAI / Anthropic / Google): skips LM Studio model
 *   orchestration entirely and returns a cloud client with a lightweight
 *   PreparedLmStudioModel shim so `createManagedChatCompletion` still works.
 * - LM Studio: delegates to `selectAndPrepareLmStudioModel` as before.
 */
/**
 * Returns true when the cloud provider should handle this task.
 *
 * auto  – cloud for reasoning-heavy tasks (critic, planning); local for
 *         extraction and rewrite where volume and cost matter more
 * cloud – always cloud
 * local – always LM Studio
 */
export function shouldUseCloud(settings: LmStudioSettings, task: LmStudioTaskKind): boolean {
  if (!settings.standardSettings) return false;
  if (settings.executionMode === "cloud") return true;
  if (settings.executionMode === "local") return false;
  // auto: cloud for reasoning tasks, local for extraction / rewrite
  return task === "critic" || task === "planning";
}

export async function selectAndPrepareActiveModel(
  settings: LmStudioSettings,
  profile: LmStudioTaskProfile,
): Promise<ActiveModelPlan> {
  if (shouldUseCloud(settings, profile.task) && settings.standardSettings) {
    const std = settings.standardSettings;
    const meta = PROVIDER_META.find((p) => p.id === std.provider);
    const taskModel = std.taskModels?.[profile.task];
    const model = taskModel || std.model || meta?.defaultModels[0] || "gpt-4o";

    // Fail-closed subscription-tier gate. Must run before any provider is
    // invoked -- recordModelCallEvent's telemetry is fire-and-forget AFTER
    // the call and can't serve this purpose. No-op on self-hosted deployments.
    await assertModelAllowedForUser(profile.telemetry.supabase, {
      userId: profile.telemetry.userId,
      model,
      task: profile.task,
    });

    const maxOutputTokens = std.maxOutputTokens || 4096;
    const cloudPrepared: PreparedLmStudioModel = {
      model,
      runtimeLimits: {
        configuredContextTokens: 128000,
        maxOutputTokens,
        reservedTokens: 0,
        usableInputTokens: 120000,
        promptCharBudget: 400000,
        warnings: [],
      },
      loadedContextTokens: null,
      warnings: [],
      nativeModelManagementAvailable: false,
      isCloud: true,
      isManagedOpenRouterKey: std.isBookForgeManagedKey === true,
    };
    const cloudModelSelection: ActiveModelPlan["modelSelection"] = {
      model,
      source: std.provider,
      configuredModels: [model],
      availableModels: [],
      usedLoadedFallback: false,
      selectedScore: 100,
      selectionReason: taskModel
        ? `Using ${meta?.label || std.provider} cloud provider (${profile.task} model)`
        : `Using ${meta?.label || std.provider} cloud provider`,
      unloadedInstances: [],
    };
    const telemetryContext: ModelCallTelemetryContext | undefined = profile.telemetry
      ? {
          ...profile.telemetry,
          task: profile.task,
          model,
          provider: std.provider,
          execution: "cloud",
          requestedModel: taskModel || std.model || model,
        }
      : undefined;
    return {
      client: createProviderClient(std),
      model,
      preparedModel: cloudPrepared,
      modelSelection: cloudModelSelection,
      availableModels: [],
      nativeModelsAvailable: false,
      telemetryContext,
    };
  }

  const client = createLmStudioClient(settings);
  const modelPlan = await selectAndPrepareLmStudioModel(settings, profile);
  return { client, ...modelPlan };
}
