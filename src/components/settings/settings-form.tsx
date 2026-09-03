"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Button,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  buildModelRecommendations,
  type ModelRecommendation,
  type QualityProfile,
} from "@/lib/ai/model-recommendations";
import { CLOUD_PROVIDER_META, PROVIDER_META } from "@/lib/ai/providers";
import { OPENROUTER_TASK_MODEL_DEFAULTS, resolveManagedSaasTaskModelDefaults } from "@/lib/ai/model-catalog";
import type { LlmProvider, LmStudioTaskKind } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { isManagedSaasDeployment } from "@/lib/deployment/mode";
import {
  fetchAllowedModelsForCurrentUser,
  fetchCurrentModelPricing,
  fetchCurrentUserTierFundingModel,
  fetchVendorsForCurrentUserTier,
} from "@/lib/subscription/client-tier-models";

type ExecutionMode = "auto" | "local" | "cloud";

const TASK_INFO: { task: LmStudioTaskKind; field: keyof Settings; label: string; hint: string }[] = [
  { task: "critic", field: "llm_critic_model", label: "Critic lenses", hint: "8 lenses, up to 5 passes per book — high volume, keep it cheap" },
  { task: "rewrite", field: "llm_rewrite_model", label: "Full-book rewrite passes", hint: "Reads and rewrites every paragraph — the main cost driver" },
  { task: "planning", field: "llm_planning_model", label: "Architecture & planning", hint: "Book bible, rewrite plans — lower volume, benefits from stronger reasoning" },
  { task: "extraction", field: "llm_extraction_model", label: "Extraction & summaries", hint: "Chapter summaries and structured extraction — high volume, keep it cheap" },
];

export type Settings = {
  // LM Studio
  lmstudio_base_url: string;
  primary_rewrite_model: string;
  reasoning_model: string;
  extraction_model: string;
  embedding_model: string;
  reranker_model: string;
  quality_profile: QualityProfile;
  context_window_tokens: number;
  max_output_tokens: number;
  temperature: number;
  top_p: number;
  repeat_penalty: number;
  // Standard provider
  llm_provider: LlmProvider;
  llm_api_key: string;
  llm_model: string;
  llm_base_url: string;
  llm_temperature: number;
  llm_max_output_tokens: number;
  // Per-task cloud model overrides — falls back to llm_model when blank
  llm_critic_model: string;
  llm_rewrite_model: string;
  llm_planning_model: string;
  llm_extraction_model: string;
  // Execution routing
  execution_mode: ExecutionMode;
  // Vendor restriction for a BookForge-managed OpenRouter tier -- "" means
  // no restriction (balance across every vendor the tier allows). Ignored
  // for self_funded users.
  openrouter_vendor_lock: string;
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

function isQualityProfile(value: string): value is QualityProfile {
  return value === "fast" || value === "balanced" || value === "premium";
}

function normalizeQualityProfile(value: string | undefined): QualityProfile {
  return value && isQualityProfile(value) ? value : "balanced";
}

function profileLabel(profile: QualityProfile) {
  if (profile === "fast") return "Fast Mode";
  if (profile === "premium") return "Premium Mode";
  return "Balanced Mode";
}

export function SettingsForm({
  userId,
  initial,
  hasApiKey,
  onSaved,
}: {
  userId: string;
  initial?: Partial<Settings>;
  hasApiKey?: boolean;
  onSaved?: () => void;
}) {
  const [settings, setSettings] = useState<Settings>({
    lmstudio_base_url: initial?.lmstudio_base_url || "http://localhost:1234/v1",
    primary_rewrite_model: initial?.primary_rewrite_model || "",
    reasoning_model: initial?.reasoning_model || "",
    extraction_model: initial?.extraction_model || "",
    embedding_model: initial?.embedding_model || "",
    reranker_model: initial?.reranker_model || "",
    quality_profile: normalizeQualityProfile(initial?.quality_profile),
    context_window_tokens: Number(initial?.context_window_tokens ?? 32768),
    max_output_tokens: Number(initial?.max_output_tokens ?? 4096),
    temperature: Number(initial?.temperature ?? 0.7),
    top_p: Number(initial?.top_p ?? 0.9),
    repeat_penalty: Number(initial?.repeat_penalty ?? 1.05),
    llm_provider: (initial?.llm_provider as LlmProvider) || (isManagedSaasDeployment() ? "openrouter" : "lmstudio"),
    llm_api_key: initial?.llm_api_key || "",
    llm_model: initial?.llm_model || "",
    llm_base_url: initial?.llm_base_url || "",
    llm_temperature: Number(initial?.llm_temperature ?? 0.7),
    llm_max_output_tokens: Number(initial?.llm_max_output_tokens ?? 4096),
    llm_critic_model: initial?.llm_critic_model || "",
    llm_rewrite_model: initial?.llm_rewrite_model || "",
    llm_planning_model: initial?.llm_planning_model || "",
    llm_extraction_model: initial?.llm_extraction_model || "",
    execution_mode: (initial?.execution_mode as ExecutionMode) || (isManagedSaasDeployment() ? "cloud" : "auto"),
    openrouter_vendor_lock: initial?.openrouter_vendor_lock || "",
  });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<ModelRecommendation[]>([]);
  // The API key is never sent back from the server (it's vault-encrypted,
  // write-only from the client's perspective — see settings/page.tsx), so
  // this field always starts blank even when a key is already saved. Only
  // include it in the save payload if the user actually types in it or
  // explicitly clears it — otherwise every unrelated settings save would
  // send an empty string and wipe out the saved key.
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [perFeature, setPerFeature] = useState(
    Boolean(initial?.llm_critic_model || initial?.llm_rewrite_model || initial?.llm_planning_model || initial?.llm_extraction_model),
  );
  // Whether this user's tier is BookForge-managed (no key of their own --
  // see src/lib/openrouter/management.ts) -- controls whether the cloud
  // panel shows the normal provider/key/model fields or just a vendor-lock
  // choice. null while loading.
  const [fundingModel, setFundingModel] = useState<"self_funded" | "bookforge_managed" | null>(
    () => (isManagedSaasDeployment() ? null : "self_funded"),
  );
  const [vendors, setVendors] = useState<string[]>([]);
  useEffect(() => {
    if (!isManagedSaasDeployment()) return;
    void fetchCurrentUserTierFundingModel().then((fm) => {
      setFundingModel(fm);
      if (fm === "bookforge_managed") void fetchVendorsForCurrentUserTier().then(setVendors);
    });
  }, []);
  const [fetchingModels, setFetchingModels] = useState(false);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function applyRecommended(profile: QualityProfile = settings.quality_profile) {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/lmstudio/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: settings.lmstudio_base_url }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to inspect LM Studio models.");

      const detectedModels = Array.isArray(result.models) ? result.models : [];
      const optimized = buildModelRecommendations(detectedModels, profile);
      const matched = optimized.filter((item) => item.selectedModel);

      setRecommendations(optimized);
      setSettings((current) => ({
        ...current,
        primary_rewrite_model:
          optimized.find((item) => item.task === "primary_rewrite_model")?.selectedModel ||
          current.primary_rewrite_model,
        reasoning_model:
          optimized.find((item) => item.task === "reasoning_model")?.selectedModel || current.reasoning_model,
        extraction_model:
          optimized.find((item) => item.task === "extraction_model")?.selectedModel || current.extraction_model,
        embedding_model:
          optimized.find((item) => item.task === "embedding_model")?.selectedModel || current.embedding_model,
        reranker_model: optimized.find((item) => item.task === "reranker_model")?.selectedModel || "",
        quality_profile: profile,
      }));
      setStatus(
        matched.length
          ? `${profileLabel(profile)} recommendations applied from ${detectedModels.length} available LM Studio model(s).`
          : "No suitable LM Studio models were detected. Load models in LM Studio, then try again.",
      );
    } catch (err) {
      setError(getErrorMessage(err, `Unable to build ${profileLabel(profile)} recommendations.`));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const supabase = createClient();
      const payload: Record<string, unknown> = {
        user_id: userId,
        ...settings,
        updated_at: new Date().toISOString(),
      };
      delete payload.llm_api_key;
      // Only touch the vaulted API key if the user actually edited or
      // cleared this field this session — see apiKeyTouched above.
      if (apiKeyTouched) {
        payload.llm_api_key = settings.llm_api_key.trim();
      }
      const { error: saveError } = await supabase.from("user_settings").upsert(payload, { onConflict: "user_id" });
      if (saveError) throw saveError;
      if (apiKeyTouched) setApiKeyTouched(false);
      setStatus("Settings saved.");
      onSaved?.();
    } catch (err) {
      setError(getErrorMessage(err, "Unable to save settings."));
    } finally {
      setLoading(false);
    }
  }

  async function testConnection() {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/lmstudio/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: settings.lmstudio_base_url }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Connection failed.");
      setStatus(`Connected. Models visible: ${result.models?.slice(0, 5).join(", ") || "none listed"}`);
    } catch (err) {
      setError(getErrorMessage(err, "Connection failed."));
    } finally {
      setLoading(false);
    }
  }

  async function testProviderConnection() {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: settings.llm_provider,
          apiKey: settings.llm_api_key,
          model: settings.llm_model,
          baseUrl: settings.llm_base_url || undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Connection failed.");
      setStatus(result.message || "Connection successful.");
    } catch (err) {
      setError(getErrorMessage(err, "Connection failed."));
    } finally {
      setLoading(false);
    }
  }

  const selectedProviderMeta = PROVIDER_META.find((p) => p.id === settings.llm_provider);
  const providerModelOptions =
    selectedProviderMeta && selectedProviderMeta.defaultModels.length > 0
      ? selectedProviderMeta.defaultModels.map((m) => ({ value: m, label: m }))
      : undefined;
  const managedSaas = isManagedSaasDeployment();

  return (
    <Paper withBorder radius="md" p="xl" bg="white">
      <Stack>
        <Title order={2}>AI Settings</Title>
        {status && <Alert color="green">{status}</Alert>}
        {error && <Alert color="red">{error}</Alert>}

        {!managedSaas && (
          <Paper withBorder radius="sm" p="md" bg="#f8f7ff">
            <Stack gap="xs">
              <Select
                label="Execution mode"
                description={
                  settings.execution_mode === "auto"
                    ? "Critic and Planning tasks use your cloud provider for stronger reasoning. Summaries, Blueprint, and Rewrite use LM Studio to keep costs low."
                    : settings.execution_mode === "cloud"
                      ? "All AI tasks are sent to your configured cloud provider. LM Studio is not used for execution."
                      : "All AI tasks run through LM Studio. The cloud provider is ignored for execution."
                }
                data={[
                  { value: "auto", label: "Auto — optimize by task type (recommended)" },
                  { value: "local", label: "LM Studio only" },
                  { value: "cloud", label: "Cloud provider only" },
                ]}
                value={settings.execution_mode}
                onChange={(value) => update("execution_mode", (value as ExecutionMode) || "auto")}
              />
              {settings.execution_mode !== "local" && settings.llm_provider === "lmstudio" && (
                <Alert color="yellow" variant="light" p="xs">
                  <Text size="xs">No cloud provider configured. Set one on the Cloud Provider tab before using cloud or auto mode.</Text>
                </Alert>
              )}
            </Stack>
          </Paper>
        )}

        <Tabs defaultValue={managedSaas ? "cloud" : "lmstudio"}>
          <Tabs.List>
            {!managedSaas && <Tabs.Tab value="lmstudio">LM Studio (local)</Tabs.Tab>}
            <Tabs.Tab value="cloud">Cloud Provider</Tabs.Tab>
          </Tabs.List>

          {/* ------------------------------------------------------------------ */}
          {/* LM Studio tab -- self-hosted only, see managedSaas guard above     */}
          {/* ------------------------------------------------------------------ */}
          {!managedSaas && <Tabs.Panel value="lmstudio" pt="md">
            <Stack>
              <Text c="dimmed" size="sm">
                Choose a profile, then optimize against the models currently loaded in LM Studio. Model names stay
                configurable because LM Studio exposes whatever local GGUF models you install.
              </Text>
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <TextInput
                  label="LM Studio base URL"
                  value={settings.lmstudio_base_url}
                  onChange={(event) => update("lmstudio_base_url", event.currentTarget.value)}
                />
                <Select
                  label="Quality profile"
                  data={[
                    { value: "fast", label: "Fast Mode" },
                    { value: "balanced", label: "Balanced Mode" },
                    { value: "premium", label: "Premium Mode" },
                  ]}
                  value={settings.quality_profile}
                  onChange={(value) => {
                    const nextProfile = normalizeQualityProfile(value || undefined);
                    update("quality_profile", nextProfile);
                    void applyRecommended(nextProfile);
                  }}
                />
                <TextInput
                  label="Primary rewrite model"
                  value={settings.primary_rewrite_model}
                  onChange={(event) => update("primary_rewrite_model", event.currentTarget.value)}
                />
                <TextInput
                  label="Reasoning model"
                  value={settings.reasoning_model}
                  onChange={(event) => update("reasoning_model", event.currentTarget.value)}
                />
                <TextInput
                  label="Extraction model"
                  value={settings.extraction_model}
                  onChange={(event) => update("extraction_model", event.currentTarget.value)}
                />
                <TextInput
                  label="Embedding model"
                  value={settings.embedding_model}
                  onChange={(event) => update("embedding_model", event.currentTarget.value)}
                />
                <TextInput
                  label="Reranker model"
                  value={settings.reranker_model}
                  onChange={(event) => update("reranker_model", event.currentTarget.value)}
                />
                <NumberInput
                  label="Context window tokens"
                  value={settings.context_window_tokens}
                  onChange={(value) => update("context_window_tokens", Number(value || 32768))}
                />
                <NumberInput
                  label="Max output tokens"
                  value={settings.max_output_tokens}
                  onChange={(value) => update("max_output_tokens", Number(value || 4096))}
                />
                <NumberInput
                  label="Temperature"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(value) => update("temperature", Number(value ?? 0.7))}
                />
                <NumberInput
                  label="Top P"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.top_p}
                  onChange={(value) => update("top_p", Number(value ?? 0.9))}
                />
                <NumberInput
                  label="Repeat penalty"
                  min={0}
                  max={2}
                  step={0.01}
                  value={settings.repeat_penalty}
                  onChange={(value) => update("repeat_penalty", Number(value ?? 1.05))}
                />
              </SimpleGrid>
              {recommendations.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid oklch(0.92 0.003 90)", borderRadius: 14, padding: "20px 24px" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "oklch(0.2 0.005 90)", marginBottom: 14 }}>
                    Detected {profileLabel(settings.quality_profile)} Match
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(100px,140px) minmax(140px,190px) minmax(180px,2fr) minmax(160px,1.3fr)",
                      gap: 12,
                      paddingBottom: 8,
                      borderBottom: "1px solid oklch(0.9 0.003 90)",
                    }}
                  >
                    {["Task", "Selected model", "Why", "Alternatives"].map((heading) => (
                      <span
                        key={heading}
                        style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "oklch(0.55 0.005 90)" }}
                      >
                        {heading}
                      </span>
                    ))}
                  </div>
                  {recommendations.map((item) => (
                    <div
                      key={item.task}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(100px,140px) minmax(140px,190px) minmax(180px,2fr) minmax(160px,1.3fr)",
                        gap: 12,
                        padding: "12px 0",
                        borderBottom: "1px solid oklch(0.93 0.003 90)",
                        alignItems: "start",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.2 0.005 90)" }}>{item.label}</span>
                      <div>
                        {item.selectedModel ? (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: 11,
                              fontWeight: 600,
                              fontFamily: "ui-monospace, monospace",
                              padding: "4px 9px",
                              borderRadius: 6,
                              background: "oklch(0.94 0.05 165)",
                              color: "oklch(0.4 0.1 165)",
                            }}
                          >
                            {item.selectedModel}
                          </span>
                        ) : (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: 11,
                              fontWeight: 600,
                              padding: "4px 9px",
                              borderRadius: 6,
                              background: "oklch(0.95 0.06 45)",
                              color: "oklch(0.5 0.12 45)",
                            }}
                          >
                            No match
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 12, color: "oklch(0.35 0.005 90)", lineHeight: 1.45 }}>{item.reason}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {item.alternatives.length ? (
                          item.alternatives.map((alt) => (
                            <span
                              key={alt}
                              style={{
                                fontSize: 10.5,
                                fontFamily: "ui-monospace, monospace",
                                padding: "3px 8px",
                                borderRadius: 5,
                                background: "oklch(0.95 0.003 90)",
                                color: "oklch(0.4 0.005 90)",
                              }}
                            >
                              {alt}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: 11, color: "oklch(0.6 0.005 90)" }}>None</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Group justify="space-between">
                <Button
                  variant="light"
                  color="grape"
                  loading={loading}
                  onClick={() => void applyRecommended(settings.quality_profile)}
                >
                  Optimize {profileLabel(settings.quality_profile)} Recommendations
                </Button>
                <Button variant="outline" color="dark" loading={loading} onClick={testConnection}>
                  Test Connection
                </Button>
              </Group>
            </Stack>
          </Tabs.Panel>}

          {/* ------------------------------------------------------------------ */}
          {/* Cloud provider tab                                                  */}
          {/* ------------------------------------------------------------------ */}
          <Tabs.Panel value="cloud" pt="md">
            <Stack>
              {fundingModel === "bookforge_managed" ? (
                <>
                  <Text c="dimmed" size="sm">
                    Your plan includes BookForge-managed AI — no key or model to configure. BookForge picks the
                    most cost-effective model for each task, unless you lock yourself to one vendor below.
                  </Text>
                  <Select
                    label="Model vendor"
                    data={[{ value: "", label: "Balance across all vendors (recommended)" }, ...vendors.map((v) => ({ value: v, label: v }))]}
                    value={settings.openrouter_vendor_lock}
                    onChange={async (value) => {
                      const vendorLock = value || "";
                      update("openrouter_vendor_lock", vendorLock);
                      setFetchingModels(true);
                      try {
                        const [allowedModels, pricing] = await Promise.all([
                          fetchAllowedModelsForCurrentUser(),
                          fetchCurrentModelPricing(),
                        ]);
                        const defaults = resolveManagedSaasTaskModelDefaults(allowedModels, pricing, vendorLock || null);
                        setSettings((current) => ({
                          ...current,
                          llm_model: defaults.rewrite,
                          llm_critic_model: defaults.critic,
                          llm_rewrite_model: defaults.rewrite,
                          llm_planning_model: defaults.planning,
                          llm_extraction_model: defaults.extraction,
                        }));
                        setError(null);
                      } catch (err) {
                        setError(getErrorMessage(err, "Could not update models for that vendor."));
                      } finally {
                        setFetchingModels(false);
                      }
                    }}
                    disabled={fetchingModels}
                  />
                </>
              ) : (
                <>
              <Text c="dimmed" size="sm">
                {managedSaas
                  ? "Choose your AI provider. All AI tasks are sent to your configured cloud provider."
                  : "Use a hosted LLM provider instead of (or alongside) LM Studio. The selected provider will be used for all AI tasks when the active provider is set to anything other than LM Studio."}
              </Text>
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <Select
                  label="Active provider"
                  data={CLOUD_PROVIDER_META.map((p) => ({ value: p.id, label: p.label }))}
                  value={settings.llm_provider}
                  onChange={(value) => {
                    const provider = (value as LlmProvider) || CLOUD_PROVIDER_META[0].id;
                    update("llm_provider", provider);
                    // Always reset model to first default when switching providers
                    const meta = CLOUD_PROVIDER_META.find((p) => p.id === provider);
                    if (meta?.defaultModels[0]) {
                      update("llm_model", meta.defaultModels[0]);
                    }
                  }}
                />
                {providerModelOptions ? (
                  <Autocomplete
                    label="Model"
                    description="Choose a preset or type a custom model ID"
                    data={providerModelOptions}
                    value={settings.llm_model || providerModelOptions[0]?.value}
                    onChange={(value) => update("llm_model", value)}
                  />
                ) : (
                  <TextInput
                    label="Model"
                    placeholder="e.g. local-model"
                    value={settings.llm_model}
                    onChange={(event) => update("llm_model", event.currentTarget.value)}
                  />
                )}
                {selectedProviderMeta?.requiresApiKey && (
                  <PasswordInput
                    label="API key"
                    placeholder={hasApiKey && !apiKeyTouched ? "Saved — enter a new key to replace it" : "sk-..."}
                    description={
                      hasApiKey
                        ? apiKeyTouched
                          ? settings.llm_api_key.trim()
                            ? "This will replace the saved key."
                            : "This will clear the saved key."
                          : "A key is already saved (encrypted). Leave blank to keep it."
                        : "Stored encrypted, never in plaintext."
                    }
                    value={settings.llm_api_key}
                    onChange={(event) => {
                      setApiKeyTouched(true);
                      update("llm_api_key", event.currentTarget.value);
                    }}
                    rightSection={
                      hasApiKey ? (
                        <Button
                          variant="subtle"
                          color="red"
                          size="compact-xs"
                          onClick={() => {
                            setApiKeyTouched(true);
                            update("llm_api_key", "");
                          }}
                        >
                          Clear
                        </Button>
                      ) : undefined
                    }
                  />
                )}
                <TextInput
                  label="Custom base URL"
                  description="Leave blank to use the provider default"
                  placeholder={selectedProviderMeta?.defaultBaseUrl || ""}
                  value={settings.llm_base_url}
                  onChange={(event) => update("llm_base_url", event.currentTarget.value)}
                />
                <NumberInput
                  label="Temperature"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.llm_temperature}
                  onChange={(value) => update("llm_temperature", Number(value ?? 0.7))}
                />
                <NumberInput
                  label="Max output tokens"
                  value={settings.llm_max_output_tokens}
                  onChange={(value) => update("llm_max_output_tokens", Number(value || 4096))}
                />
              </SimpleGrid>

              <Switch
                label="Optimize per feature"
                description="Use a cheap fast model for high-volume calls (critics, extraction) and a stronger one for full-book rewrites, instead of one model for everything. Falls back to the model above for anything left blank."
                checked={perFeature}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setPerFeature(checked);
                  if (checked && !managedSaas && !settings.llm_critic_model && !settings.llm_rewrite_model && settings.llm_provider === "openrouter") {
                    // Self-hosted: no tier gating, no network round-trip -- safe to fill instantly.
                    setSettings((current) => ({
                      ...current,
                      llm_critic_model: OPENROUTER_TASK_MODEL_DEFAULTS.critic,
                      llm_rewrite_model: OPENROUTER_TASK_MODEL_DEFAULTS.rewrite,
                      llm_planning_model: OPENROUTER_TASK_MODEL_DEFAULTS.planning,
                      llm_extraction_model: OPENROUTER_TASK_MODEL_DEFAULTS.extraction,
                    }));
                  }
                }}
              />
              {perFeature && (
                <Paper withBorder radius="sm" p="md" bg="#fbfaf8">
                  <Stack gap="sm">
                    {managedSaas && settings.llm_provider === "openrouter" && (
                      <Group justify="space-between" wrap="nowrap">
                        <Text size="sm" c="dimmed">
                          Fills in the fields below with the best model your plan allows for each task.
                        </Text>
                        <Button
                          variant="light"
                          color="grape"
                          size="xs"
                          loading={fetchingModels}
                          onClick={async () => {
                            setFetchingModels(true);
                            try {
                              const [allowedModels, pricing] = await Promise.all([
                                fetchAllowedModelsForCurrentUser(),
                                fetchCurrentModelPricing(),
                              ]);
                              const defaults = resolveManagedSaasTaskModelDefaults(allowedModels, pricing);
                              setSettings((current) => ({
                                ...current,
                                llm_critic_model: defaults.critic,
                                llm_rewrite_model: defaults.rewrite,
                                llm_planning_model: defaults.planning,
                                llm_extraction_model: defaults.extraction,
                              }));
                            } finally {
                              setFetchingModels(false);
                            }
                          }}
                        >
                          Get my models
                        </Button>
                      </Group>
                    )}
                    <SimpleGrid cols={{ base: 1, md: 2 }}>
                      {TASK_INFO.map(({ field, label, hint }) =>
                        providerModelOptions ? (
                          <Autocomplete
                            key={field}
                            label={label}
                            description={hint}
                            data={providerModelOptions}
                            value={(settings[field] as string) || settings.llm_model || providerModelOptions[0]?.value}
                            onChange={(value) => update(field, value as Settings[typeof field])}
                          />
                        ) : (
                          <TextInput
                            key={field}
                            label={label}
                            description={hint}
                            placeholder={settings.llm_model || "Falls back to Model above"}
                            value={settings[field] as string}
                            onChange={(event) => update(field, event.currentTarget.value as Settings[typeof field])}
                          />
                        ),
                      )}
                    </SimpleGrid>
                  </Stack>
                </Paper>
              )}

              <Group>
                <Button variant="outline" color="dark" loading={loading} onClick={testProviderConnection}>
                  Test Connection
                </Button>
              </Group>
                </>
              )}
            </Stack>
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end">
          <Button color="grape" loading={loading} onClick={save}>
            Save Settings
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}