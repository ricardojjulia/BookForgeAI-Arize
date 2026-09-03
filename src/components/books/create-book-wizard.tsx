"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GenerationProgressAlert } from "@/components/ai/generation-progress-alert";
import { fetchJson } from "@/lib/http/fetch-json";
import { DIALOG_DENSITY_LABELS, DIALOG_DENSITY_LEVELS, type DialogDensity } from "@/lib/dialogue-density";
import { estimateWordsForPages } from "@/lib/manuscript/page-estimate";

type CloudProviderInfo = {
  provider: string;
  model: string | null;
  executionMode: string;
  usedForPlanning: boolean;
  usedForRewrite: boolean;
};

type ModelStatusResponse = {
  connected: boolean;
  baseUrl: string;
  qualityProfile: string;
  contextWindowTokens: number;
  availableModels: string[];
  configuredModels: Array<{ key: string; label: string; model: string; available: boolean }>;
  cloudProvider: CloudProviderInfo | null;
  executionMode: string;
  warnings: string[];
};

type CreationMode = "single_safe" | "dual_role_sequential";
type CreationStage = "intake" | "concept" | "architecture" | "ready";

type ConceptPass = {
  mainTheme?: string;
  readerPromise?: string;
  premise?: string;
  emotionalEngine?: string;
  genreFit?: string;
  targetAudienceFit?: string;
  creationThesis?: string;
  suggestedStructure?: Array<{ partTitle?: string; purpose?: string; chapterCount?: number }>;
  coreQuestions?: unknown[];
  majorRisks?: unknown[];
  differentiators?: unknown[];
  recommendedNextQuestionsForAuthor?: unknown[];
  modelStrategyRecommendation?: { mode?: string; reason?: string };
};

type ChapterArchitecture = {
  architectureSummary?: string;
  parts?: Array<{
    partNumber?: number;
    title?: string;
    purpose?: string;
    chapters?: Array<{
      chapterNumber?: number;
      title?: string;
      purpose?: string;
      targetWords?: number;
      targetPages?: number;
      emotionalMovement?: string;
      keyBeats?: unknown[];
      charactersOrConcepts?: unknown[];
      continuityNotes?: unknown[];
      riskNotes?: unknown[];
    }>;
  }>;
  globalContinuityRules?: unknown[];
  voiceRules?: unknown[];
  motifsToDevelop?: unknown[];
  generationWarnings?: unknown[];
};

const TONE_OPTIONS = [
  "Tender",
  "Pastoral",
  "Hopeful",
  "Literary",
  "Reflective",
  "Conversational",
  "Encouraging",
  "Prophetic",
  "Bold",
  "Academic",
  "Narrative",
  "Devotional",
];

// Presets only -- the field accepts any typed value, so a book can be
// requested in a language not listed here (see AGENTS.md guidance in
// concept/architecture/draft prompt builders, which already parameterize on
// whatever string is provided rather than assuming English).
const LANGUAGE_OPTIONS = [
  "English",
  "Spanish",
  "Bilingual English/Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Polish",
  "Romanian",
  "Tagalog",
  "Korean",
  "Japanese",
  "Mandarin Chinese",
];

type ExistingCreationProject = {
  id: string;
  workingTitle: string;
  idea: string;
  genre: string | null;
  audience: string | null;
  language: string | null;
  targetPages: number;
  tone: string;
  boundaries: string;
  mode: CreationMode;
  dialogDensity: string;
  updatedAt: string;
  concept: ConceptPass | null;
  architecture: ChapterArchitecture | null;
};

export function CreateBookWizard({ existingProject }: { existingProject?: ExistingCreationProject | null }) {
  const router = useRouter();
  const [resumeChoice, setResumeChoice] = useState<"pending" | "resolved">(existingProject ? "pending" : "resolved");
  const [workingTitle, setWorkingTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [genre, setGenre] = useState<string | null>("Literary nonfiction");
  const [audience, setAudience] = useState<string | null>("General adult");
  const [language, setLanguage] = useState<string | null>("English");
  const [targetPages, setTargetPages] = useState<number | "">(120);
  const [tone, setTone] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [mode, setMode] = useState<CreationMode>("single_safe");
  const [dialogDensity, setDialogDensity] = useState<DialogDensity>("normal");
  const [status, setStatus] = useState<ModelStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [conceptLoading, setConceptLoading] = useState(false);
  const [conceptSaving, setConceptSaving] = useState(false);
  const [architectureLoading, setArchitectureLoading] = useState(false);
  const [acceptingArchitecture, setAcceptingArchitecture] = useState(false);
  const [creationProjectId, setCreationProjectId] = useState<string | null>(null);
  const [concept, setConcept] = useState<ConceptPass | null>(null);
  const [conceptDirty, setConceptDirty] = useState(false);
  const [conceptSavedAt, setConceptSavedAt] = useState<string | null>(null);
  const [architecture, setArchitecture] = useState<ChapterArchitecture | null>(null);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [statusColor, setStatusColor] = useState<"blue" | "teal" | "yellow" | "red">("blue");

  function resumeExistingProject() {
    if (!existingProject) return;
    setCreationProjectId(existingProject.id);
    setWorkingTitle(existingProject.workingTitle);
    setIdea(existingProject.idea);
    if (existingProject.genre) setGenre(existingProject.genre);
    if (existingProject.audience) setAudience(existingProject.audience);
    if (existingProject.language) setLanguage(existingProject.language);
    setTargetPages(existingProject.targetPages);
    setTone(existingProject.tone);
    setBoundaries(existingProject.boundaries);
    setMode(existingProject.mode);
    if (existingProject.dialogDensity) setDialogDensity(existingProject.dialogDensity as DialogDensity);
    if (existingProject.concept) {
      setConcept(existingProject.concept);
      setConceptSavedAt(existingProject.updatedAt);
    }
    if (existingProject.architecture) setArchitecture(existingProject.architecture);
    setResumeChoice("resolved");
  }

  // A single blocking LLM call (concept: ~10-30s, architecture: can run
  // 60-90s+ for a full book) with only a static "this can take a bit"
  // message is easy to mistake for a hang. Each trigger button below renders
  // its own GenerationProgressAlert right next to itself (not a shared alert
  // scrolled away elsewhere), since the page has three separate action
  // groups (generate concept / accept concept / accept architecture) spread
  // across different Paper sections.
  const activeStep: "concept" | "architecture" | "accepting" | null = conceptLoading
    ? "concept"
    : architectureLoading
      ? "architecture"
      : acceptingArchitecture
        ? "accepting"
        : null;

  const runModelPreflight = useCallback(async () => {
    setLoading(true);
    setError("");
    setStatusColor("blue");
    setStatusMessage("Checking AI engine connectivity...");
    try {
      const result = await fetchJson<ModelStatusResponse>(
        "/api/lmstudio/status",
        { cache: "no-store" },
        "Creation model preflight",
      );
      setStatus(result);
      setStatusColor("teal");
      setStatusMessage("AI engine status updated.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to check LM Studio.";
      setError(message);
      setStatusColor("red");
      setStatusMessage(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void runModelPreflight();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [runModelPreflight]);

  async function acceptConceptAndGenerateArchitecture() {
    if (!creationProjectId || !concept) return;
    setArchitectureLoading(true);
    setError("");
    setStatusColor("blue");
    setStatusMessage("Generating chapter architecture... This can take 60-90 seconds for a full book.");
    try {
      const result = await fetchJson<{ content?: { architecture?: ChapterArchitecture } }>(
        "/api/creation/architecture",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creationProjectId,
            concept,
          }),
        },
        "Generate chapter architecture",
      );
      const nextArchitecture = result.content?.architecture || null;
      if (!nextArchitecture) {
        throw new Error("Architecture service returned no structure. Please retry.");
      }
      setArchitecture(nextArchitecture);
      setStatusColor("teal");
      setStatusMessage("Architecture generated. Review it before accepting.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to generate chapter architecture.";
      setError(message);
      setStatusColor("red");
      setStatusMessage(message);
    } finally {
      setArchitectureLoading(false);
    }
  }

  async function acceptArchitecture() {
    if (!creationProjectId || !architecture) return;
    setAcceptingArchitecture(true);
    setError("");
    setStatusColor("blue");
    setStatusMessage("Accepting architecture and opening your new book workspace...");
    try {
      const chapterCount = (architecture.parts || []).reduce((sum, part) => {
        return sum + (part.chapters?.length || 0);
      }, 0);
      if (chapterCount === 0) {
        throw new Error("This architecture has no chapters yet. Click Regenerate Architecture before accepting.");
      }

      const result = await fetchJson<{ content?: { bookId?: string; chapterCount?: number; reusedExistingBook?: boolean } }>(
        "/api/creation/accept-architecture",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creationProjectId,
            architecture,
          }),
        },
        "Accept architecture",
      );
      const bookId = result.content?.bookId;
      if (!bookId) {
        throw new Error("Architecture was accepted, but no book id was returned. Refresh and try again.");
      }

      const destination = `/books/${bookId}`;
      router.push(destination);
      window.setTimeout(() => {
        if (window.location.pathname !== destination) {
          // Deliberate fallback, not the primary navigation path -- router.push()
          // above is the normal route, this only fires if client-side navigation
          // silently didn't happen within 500ms.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(destination);
        }
      }, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to accept architecture.";
      setError(message);
      setStatusColor("red");
      setStatusMessage(message);
    } finally {
      setAcceptingArchitecture(false);
    }
  }

  async function generateConceptPass() {
    setConceptLoading(true);
    setError("");
    setStatusColor("blue");
    setStatusMessage("Generating concept pass... This can take 10-30 seconds.");
    try {
      const result = await fetchJson<{
        content?: {
          creationProject?: { id: string };
          conceptVersion?: { id: string; created_at: string };
          concept?: ConceptPass;
        };
      }>(
        "/api/creation/concept",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creationProjectId: creationProjectId || undefined,
            workingTitle,
            idea,
            genre: genre || "Unspecified",
            targetAudience: audience || "Unspecified",
            language: language || "English",
            targetPages: Number(targetPages || 120),
            tone,
            boundaries,
            creationMode: mode,
            dialogDensity,
          }),
        },
        "Generate concept pass",
      );
      const nextProjectId = result.content?.creationProject?.id || creationProjectId;
      const nextConcept = result.content?.concept || null;
      if (!nextProjectId || !nextConcept) {
        throw new Error("Concept service returned an incomplete response. Please retry.");
      }
      setCreationProjectId(nextProjectId);
      setConcept(nextConcept);
      setConceptDirty(false);
      setConceptSavedAt(result.content?.conceptVersion?.created_at || new Date().toISOString());
      setStatusColor("teal");
      setStatusMessage("Concept pass generated. Review and edit it below.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to generate concept pass.";
      setError(message);
      setStatusColor("red");
      setStatusMessage(message);
    } finally {
      setConceptLoading(false);
    }
  }

  async function saveConceptOnly() {
    if (!creationProjectId || !concept) return;
    setConceptSaving(true);
    setError("");
    setStatusColor("blue");
    setStatusMessage("Saving concept draft...");
    try {
      const result = await fetchJson<{ content?: { acceptedConcept?: { id: string; created_at: string } } }>(
        "/api/creation/concept/save",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creationProjectId,
            concept,
          }),
        },
        "Save concept",
      );
      setConceptDirty(false);
      setConceptSavedAt(result.content?.acceptedConcept?.created_at || new Date().toISOString());
      setStatusColor("teal");
      setStatusMessage("Concept saved.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save concept.";
      setError(message);
      setStatusColor("red");
      setStatusMessage(message);
    } finally {
      setConceptSaving(false);
    }
  }

  const recommendedMode = getRecommendedCreationMode(status);
  const pageCount = Number(targetPages || 0);
  const wordTarget = estimateWordsForPages(pageCount);
  const expectedChapters = Math.max(6, Math.min(24, Math.round(pageCount / 8)));
  const missingConceptInputs: string[] = [];
  if (!workingTitle.trim()) missingConceptInputs.push("working title");
  if (!idea.trim()) missingConceptInputs.push("core idea");
  const conceptButtonDisabled = missingConceptInputs.length > 0;
  const currentStage: CreationStage = architecture
    ? "ready"
    : concept
      ? "architecture"
      : conceptLoading
        ? "concept"
        : "intake";
  const stageProgress = getCreationStageProgress(currentStage);

  if (resumeChoice === "pending" && existingProject) {
    const hasArchitecture = Boolean(existingProject.architecture);
    const hasConcept = Boolean(existingProject.concept);
    return (
      <Paper withBorder radius="md" p="xl" bg="#fffdf8">
        <Stack>
          <Title order={3}>Resume in-progress book?</Title>
          <Text c="dimmed" size="sm">
            You have an unfinished project, <strong>{existingProject.workingTitle || "Untitled"}</strong>, last updated{" "}
            <span suppressHydrationWarning>{new Date(existingProject.updatedAt).toLocaleString()}</span>.
            {hasArchitecture
              ? " It already has a generated chapter architecture ready to review and accept -- no need to regenerate anything."
              : hasConcept
                ? " It already has a generated concept pass ready to review."
                : " It has your intake details saved, but no concept has been generated yet."}
          </Text>
          <Group>
            <Button color="teal" onClick={resumeExistingProject}>
              Resume &quot;{existingProject.workingTitle || "Untitled"}&quot;
            </Button>
            <Button variant="light" color="gray" onClick={() => setResumeChoice("resolved")}>
              Start a new book instead
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Stack>
      <Paper withBorder radius="md" p="xl" bg="#f8fafc">
        <Stack gap="sm">
          <Group justify="space-between" align="center">
            <Title order={3}>Creation Progress</Title>
            <Badge color={stageProgress >= 100 ? "teal" : "blue"} variant="light">
              {getCreationStageLabel(currentStage)}
            </Badge>
          </Group>
          <Progress value={stageProgress} color={stageProgress >= 100 ? "teal" : "blue"} />
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="xs">
            {CREATION_STAGES.map((stage) => {
              const complete = getCreationStageProgress(stage.id) < stageProgress;
              const active = stage.id === currentStage;
              return (
                <Paper
                  key={stage.id}
                  withBorder
                  radius="sm"
                  p="xs"
                  bg={active ? "#eef6ff" : "white"}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="xs" fw={700} c={active ? "blue" : "dimmed"}>
                      {stage.label}
                    </Text>
                    <Badge color={complete ? "teal" : "gray"} variant="light" size="xs">
                      {complete ? "done" : "pending"}
                    </Badge>
                  </Group>
                </Paper>
              );
            })}
          </SimpleGrid>
          <Text size="sm" c="dimmed">
            BookForge now reports progress in-screen while generation runs, so you are never left guessing.
          </Text>
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="xl" bg="white">
        <Stack>
          <Group justify="space-between" align="flex-start">
            <div>
              <Title>Create a Book From an Idea</Title>
              <Text c="dimmed">
                Build an approved plan first, then generate the draft in chapters and paragraph units. Target length is capped at 150 pages.
              </Text>
            </div>
            <Badge
              color={status?.cloudProvider?.usedForPlanning ? "blue" : "grape"}
              variant="light"
            >
              {status?.cloudProvider?.usedForPlanning
                ? `${providerLabel(status.cloudProvider.provider)} · ${status.cloudProvider.model || "default model"}`
                : "Local LM Studio"}
            </Badge>
          </Group>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <TextInput
              label="Working title"
              placeholder={language === "Spanish" ? "El título va aquí" : "Insert title here"}
              value={workingTitle}
              onChange={(event) => setWorkingTitle(event.currentTarget.value)}
            />
            <NumberInput
              label="Target pages"
              description="Hard cap: 150 pages"
              value={targetPages}
              min={20}
              max={150}
              onChange={(value) => setTargetPages(value === "" ? "" : Number(value || 120))}
            />
            <Select
              label="Genre"
              value={genre}
              onChange={setGenre}
              data={["Literary nonfiction", "Memoir", "Self-help", "Devotional", "Novel", "Thriller", "Fantasy", "Romance", "Young adult"]}
            />
            <Select
              label="Target audience"
              value={audience}
              onChange={setAudience}
              data={["General adult", "Young adult", "Parents", "Pastors", "Church small groups", "Grief/loss readers", "Christian readers"]}
            />
            <Autocomplete
              label="Language"
              placeholder="Type or pick a language"
              value={language ?? ""}
              onChange={setLanguage}
              data={LANGUAGE_OPTIONS}
            />
            <Select
              label="Tone"
              placeholder="Select a tone"
              value={tone}
              onChange={(value) => setTone(value || "")}
              data={TONE_OPTIONS}
              clearable
              searchable
            />
          </SimpleGrid>

          <div>
            <Text size="sm" fw={500} mb={4}>
              Dialogue density
            </Text>
            <SegmentedControl
              value={dialogDensity}
              onChange={(value) => setDialogDensity(value as DialogDensity)}
              data={DIALOG_DENSITY_LEVELS.map((level) => ({ label: DIALOG_DENSITY_LABELS[level], value: level }))}
              fullWidth
            />
          </div>

          <Textarea
            label="Core idea or prompt"
            minRows={5}
            placeholder="Describe the book you want to create, the emotional promise, and what the reader should carry away."
            value={idea}
            onChange={(event) => setIdea(event.currentTarget.value)}
          />
          <Textarea
            label="Contemporary View or forbidden changes"
            minRows={3}
            placeholder="Optional boundaries: avoid prosperity-gospel tone, preserve grief tenderness, avoid academic language..."
            value={boundaries}
            onChange={(event) => setBoundaries(event.currentTarget.value)}
          />

          {!!statusMessage && (
            <Alert color={statusColor} variant="light">
              <Text size="sm">{statusMessage}</Text>
            </Alert>
          )}
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="xl" bg="#fbfaf8">
        <Stack>
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={2}>Creation AI Strategy</Title>
              <Text c="dimmed">
                {status?.cloudProvider?.usedForPlanning
                  ? `Concept and architecture passes will use ${providerLabel(status.cloudProvider.provider)}. Draft generation uses your execution mode setting.`
                  : "Default is one loaded model for memory safety. Dual-role mode is sequential, so BookForge does not assume two large models can stay loaded together."}
              </Text>
            </div>
            <Button type="button" color="teal" variant="light" loading={loading} onClick={runModelPreflight}>
              {status?.cloudProvider?.usedForPlanning ? "Refresh Status" : "Check LM Studio Fit"}
            </Button>
          </Group>

          {!(status?.cloudProvider?.usedForPlanning) && (
            <SegmentedControl
              value={mode}
              onChange={(value) => setMode(value as CreationMode)}
              data={[
                { label: "Single-model safe", value: "single_safe" },
                { label: "Dual-role sequential", value: "dual_role_sequential" },
              ]}
            />
          )}

          {error && <Alert color="red">{error}</Alert>}
          {status && (
            <SimpleGrid cols={{ base: 1, md: 4 }}>
              {status.cloudProvider?.usedForPlanning ? (
                <>
                  <Metric label="Provider" value={providerLabel(status.cloudProvider.provider)} ready />
                  <Metric label="Model" value={status.cloudProvider.model || "default"} ready />
                  <Metric label="Mode" value={status.cloudProvider.executionMode} ready />
                  <Metric label="LM Studio" value={status.connected ? "Also connected" : "Not required"} ready={status.connected} />
                </>
              ) : (
                <>
                  <Metric label="LM Studio" value={status.connected ? "Connected" : "Disconnected"} ready={status.connected} />
                  <Metric label="Available models" value={status.availableModels.length} ready={status.availableModels.length > 0} />
                  <Metric label="Recommended mode" value={recommendedMode === "dual_role_sequential" ? "Dual-role" : "Single"} ready />
                  <Metric label="Context window" value={status.contextWindowTokens.toLocaleString()} ready />
                </>
              )}
            </SimpleGrid>
          )}

          {status?.cloudProvider && !status.cloudProvider.usedForPlanning && (
            <Alert color="blue" variant="light">
              <Text size="sm">
                <strong>{providerLabel(status.cloudProvider.provider)}</strong> is configured but execution mode is set to <strong>Local</strong> — creation will use LM Studio.{" "}
                <Text component={Link} href="/settings" size="sm" c="blue" td="underline">
                  Change execution mode in Settings
                </Text>{" "}
                to Auto or Cloud to use {providerLabel(status.cloudProvider.provider)} for planning.
              </Text>
            </Alert>
          )}

          {!status?.cloudProvider?.usedForPlanning && status?.warnings?.length ? (
            <Alert color="yellow" variant="light">
              {status.warnings.slice(0, 3).map((warning) => (
                <Text key={warning} size="sm">
                  {warning}
                </Text>
              ))}
            </Alert>
          ) : null}
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="xl" bg="white">
        <Stack>
          <Title order={2}>Generation Plan Preview</Title>
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            <Metric label="Estimated words" value={wordTarget.toLocaleString()} ready={pageCount > 0} />
            <Metric label="Expected chapters" value={expectedChapters} ready />
            <Metric label="Generation style" value="Unit-by-unit" ready />
          </SimpleGrid>
          <Alert color="blue" variant="light">
            Next implementation step: generate a Concept Pass from this intake, let the author edit/approve it, then build chapter architecture before creating manuscript text.
          </Alert>
          {conceptButtonDisabled ? (
            <Text size="sm" c="dimmed">
              Generate Concept Pass is disabled until you fill: {missingConceptInputs.join(" and ")}.
            </Text>
          ) : null}
          <Group>
            <Button type="button" color="grape" disabled={conceptButtonDisabled} loading={conceptLoading} onClick={generateConceptPass}>
              Generate Concept Pass
            </Button>
            <Button component="a" href="/dashboard" variant="light" color="dark">
              Back to Dashboard
            </Button>
          </Group>
          <GenerationProgressAlert
            active={activeStep === "concept"}
            message="Generating concept pass..."
            detail="typically takes 10-30 seconds"
            estimatedSeconds={20}
            color="grape"
          />
        </Stack>
      </Paper>

      {concept && (
        <Paper withBorder radius="md" p="xl" bg="#fffdf8">
          <Stack>
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={2}>Concept Pass</Title>
                <Text c="dimmed">
                  Review and edit this before BookForge builds chapter architecture. Nothing has been drafted yet.
                </Text>
                {conceptSavedAt && (
                  <Text size="xs" c="dimmed" mt={4}>
                    Saved at {new Date(conceptSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                )}
              </div>
              <Badge color={conceptDirty ? "yellow" : "teal"} variant="light">
                {conceptDirty ? "Unsaved changes" : "Saved"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <ConceptField label="Main theme" value={concept.mainTheme} onChange={(value) => setConceptField("mainTheme", value)} />
              <ConceptField label="Reader promise" value={concept.readerPromise} onChange={(value) => setConceptField("readerPromise", value)} />
              <ConceptField label="Premise" value={concept.premise} onChange={(value) => setConceptField("premise", value)} />
              <ConceptField label="Emotional engine" value={concept.emotionalEngine} onChange={(value) => setConceptField("emotionalEngine", value)} />
              <ConceptField label="Genre fit" value={concept.genreFit} onChange={(value) => setConceptField("genreFit", value)} />
              <ConceptField label="Audience fit" value={concept.targetAudienceFit} onChange={(value) => setConceptField("targetAudienceFit", value)} />
            </SimpleGrid>
            <ConceptField label="Creation thesis" value={concept.creationThesis} onChange={(value) => setConceptField("creationThesis", value)} minRows={3} />
            <ConceptList title="Suggested structure" items={(concept.suggestedStructure || []).map((item) => `${item.partTitle || "Part"}: ${item.purpose || ""} (${item.chapterCount || 0} chapters)`)} />
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <ConceptList title="Core questions" items={concept.coreQuestions || []} />
              <ConceptList title="Major risks" items={concept.majorRisks || []} />
              <ConceptList title="Differentiators" items={concept.differentiators || []} />
              <ConceptList title="Questions for author" items={concept.recommendedNextQuestionsForAuthor || []} />
            </SimpleGrid>
            <Alert color="blue" variant="light">
              Save keeps this concept version without running AI. Accept concept then runs architecture generation, which can take longer.
            </Alert>
            <Group>
              <Button type="button" color="gray" variant="light" loading={conceptSaving} onClick={saveConceptOnly}>
                Save Concept
              </Button>
              <Button type="button" color="teal" loading={architectureLoading} onClick={acceptConceptAndGenerateArchitecture}>
                Accept Concept & Generate Architecture
              </Button>
              <Button type="button" color="grape" variant="light" loading={conceptLoading} onClick={generateConceptPass}>
                Regenerate Concept
              </Button>
            </Group>
            <GenerationProgressAlert
              active={activeStep === "architecture"}
              message="Generating chapter architecture..."
              detail="a full book's architecture typically takes 60-90 seconds"
              estimatedSeconds={75}
              color="teal"
            />
          </Stack>
        </Paper>
      )}

      {architecture && (
        <Paper withBorder radius="md" p="xl" bg="white">
          <Stack>
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={2}>Chapter Architecture</Title>
                <Text c="dimmed">
                  Edit this structure before drafting. BookForge will generate future manuscript text from approved chapter units, not one giant prompt.
                </Text>
              </div>
              <Badge color="grape" variant="light">
                Planning
              </Badge>
            </Group>
            <ConceptField
              label="Architecture summary"
              value={architecture.architectureSummary}
              minRows={3}
              onChange={(value) => setArchitecture((current) => ({ ...(current || {}), architectureSummary: value }))}
            />
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <ConceptList title="Global continuity rules" items={architecture.globalContinuityRules || []} />
              <ConceptList title="Voice rules" items={architecture.voiceRules || []} />
              <ConceptList title="Motifs to develop" items={architecture.motifsToDevelop || []} />
              <ConceptList title="Generation warnings" items={architecture.generationWarnings || []} />
            </SimpleGrid>
            <Stack>
              {(architecture.parts || []).map((part, partIndex) => (
                <Paper key={`part:${partIndex}`} withBorder radius="md" p="md" bg="#fbfaf8">
                  <Stack>
                    <Group justify="space-between">
                      <Title order={3}>
                        Part {part.partNumber || partIndex + 1}: {part.title || "Untitled"}
                      </Title>
                      <Badge color="teal" variant="light">
                        {part.chapters?.length || 0} chapters
                      </Badge>
                    </Group>
                    <Text c="dimmed">{part.purpose}</Text>
                    <SimpleGrid cols={{ base: 1, md: 2 }}>
                      {(part.chapters || []).map((chapter, chapterIndex) => (
                        <Paper key={`chapter:${partIndex}:${chapterIndex}`} withBorder radius="sm" p="md" bg="white">
                          <Stack gap="xs">
                            <Group justify="space-between">
                              <Text fw={900}>
                                {chapter.chapterNumber || chapterIndex + 1}. {chapter.title || "Untitled chapter"}
                              </Text>
                              <Badge color="gray" variant="light">
                                {chapter.targetWords || 0} words
                              </Badge>
                            </Group>
                            <Text size="sm">{chapter.purpose}</Text>
                            <Text size="sm" c="dimmed">
                              {chapter.emotionalMovement}
                            </Text>
                            <ConceptList title="Key beats" items={chapter.keyBeats || []} />
                          </Stack>
                        </Paper>
                      ))}
                    </SimpleGrid>
                  </Stack>
                </Paper>
              ))}
            </Stack>
            <Alert color="blue" variant="light">
              Next implementation step: accept this architecture, then create draft-generation jobs chapter by chapter.
            </Alert>
            {error && <Alert color="red">{error}</Alert>}
            <Group>
              <Button type="button" color="teal" loading={acceptingArchitecture} onClick={acceptArchitecture}>
                Accept Architecture
              </Button>
              <Button type="button" color="grape" variant="light" loading={architectureLoading} onClick={acceptConceptAndGenerateArchitecture}>
                Regenerate Architecture
              </Button>
            </Group>
            <GenerationProgressAlert
              active={activeStep === "accepting"}
              message="Accepting architecture and creating your book..."
              detail="typically takes a few seconds"
              estimatedSeconds={8}
              color="teal"
            />
          </Stack>
        </Paper>
      )}
    </Stack>
  );

  function setConceptField(key: keyof ConceptPass, value: string) {
    setConceptDirty(true);
    setConcept((current) => ({
      ...(current || {}),
      [key]: value,
    }));
  }
}

const CREATION_STAGES: Array<{ id: CreationStage; label: string }> = [
  { id: "intake", label: "Intake" },
  { id: "concept", label: "Concept" },
  { id: "architecture", label: "Architecture" },
  { id: "ready", label: "Ready to Draft" },
];

function getCreationStageProgress(stage: CreationStage): number {
  switch (stage) {
    case "intake":
      return 25;
    case "concept":
      return 50;
    case "architecture":
      return 75;
    case "ready":
      return 100;
    default:
      return 25;
  }
}

function getCreationStageLabel(stage: CreationStage): string {
  switch (stage) {
    case "intake":
      return "Intake ready";
    case "concept":
      return "Generating concept";
    case "architecture":
      return "Concept complete";
    case "ready":
      return "Architecture ready";
    default:
      return "In progress";
  }
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google Gemini",
    lmstudio: "LM Studio",
  };
  return labels[provider] || provider;
}

function getRecommendedCreationMode(status: ModelStatusResponse | null): CreationMode {
  if (!status?.connected) return "single_safe";
  const availableSmallish = status.availableModels.filter((model) => {
    const normalized = model.toLowerCase();
    return /(^|[^0-9])(7b|8b|9b|14b)([^0-9]|$)/.test(normalized);
  });
  return availableSmallish.length >= 2 ? "dual_role_sequential" : "single_safe";
}

function Metric({ label, value, ready }: { label: string; value: string | number; ready: boolean }) {
  return (
    <Paper withBorder radius="sm" p="md" bg="white">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <Badge color={ready ? "green" : "yellow"} variant="light">
          {ready ? "ready" : "check"}
        </Badge>
      </Group>
      <Text fw={900}>{value}</Text>
    </Paper>
  );
}

function ConceptField({
  label,
  value,
  onChange,
  minRows = 2,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  minRows?: number;
}) {
  return (
    <Textarea
      label={label}
      value={value || ""}
      minRows={minRows}
      autosize
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

function ConceptList({ title, items }: { title: string; items: unknown[] }) {
  return (
    <Paper withBorder radius="sm" p="md" bg="white">
      <Text fw={900} mb="xs">
        {title}
      </Text>
      {items.length ? (
        <Stack gap={4}>
          {items.map((item, index) => (
            <Text key={`${title}:${index}`} size="sm">
              {index + 1}. {renderConceptListItem(item)}
            </Text>
          ))}
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          None returned yet.
        </Text>
      )}
    </Paper>
  );
}

function renderConceptListItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (Array.isArray(item)) return item.map(renderConceptListItem).join("; ");
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const preferred = [
      "question",
      "subtopic",
      "title",
      "name",
      "risk",
      "description",
      "recommendation",
      "purpose",
      "beat",
      "note",
    ]
      .map((key) => renderPrimitive(record[key]))
      .filter(Boolean);
    if (preferred.length) return preferred.join(": ");
    return Object.entries(record)
      .map(([key, value]) => `${humanizeKey(key)}: ${renderConceptListItem(value)}`)
      .join("; ");
  }
  return "";
}

function renderPrimitive(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function humanizeKey(key: string) {
  return key.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
