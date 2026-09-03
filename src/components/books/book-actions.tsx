"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Paper, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AiJobQueue, AiJobQueueInlineStatus, type AiJobQueueState } from "@/components/ai/ai-job-queue";
import { AiTaskPreflight, type AiTaskPreflightData } from "@/components/ai/ai-task-preflight";
import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { runChunkedJob } from "@/lib/ai/run-chunked-job";
import { criticLenses } from "@/lib/critic/prompts";
import { CRITIC_LENS_COUNT } from "@/lib/critic/progress";
import { fetchJson } from "@/lib/http/fetch-json";
import { mergeMetadataSnapshotBody } from "@/lib/book-metadata/selection";
import { useAutoReviewStatus, type AutoReviewJob } from "@/lib/hooks/use-auto-review-status";
import type { CriticLens } from "@/lib/types";

type AiDashboardTask = "book-bible" | "critic" | "critic-all" | "chapter-summaries" | "generate-draft" | "auto-review";

type PendingTask = {
  path: string;
  body?: unknown;
  preflight: AiTaskPreflightData;
  kind?: "single" | "auto-review";
};

type RemoteJobRow = {
  id: string;
  mode: string;
  status: string;
  progress: {
    taskName: string;
    currentUnit: string;
    totalUnits: number;
    attempted: number;
    successful: number;
    failed: number;
    skipped: number;
    startedAt?: string | null;
    lastHeartbeatAt?: string | null;
  } | null;
  // Computed once, at poll time (inside the effect, not during render) --
  // elapsedSeconds must come from somewhere, and calling Date.now() directly
  // in a function invoked from the render body is an impure-during-render
  // violation this codebase's lint rules reject.
  elapsedSecondsAtPoll?: number;
};

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

type AutoRevisionResponse = {
  content?: {
    applied?: {
      accepted?: number;
      rejected?: number;
      redo?: number;
    };
    decisions?: {
      total?: number;
      accept?: number;
      reject?: number;
      redo?: number;
    };
    nextStep?: string;
  };
};

type AutoReviewCounts = {
  accepted?: number;
  accept?: number;
  rejected?: number;
  reject?: number;
  redo?: number;
};

type AutoReviewStatusResponse = {
  content?: {
    hasBlueprint?: boolean;
    hasChapterSummaries?: boolean;
    hasBaselineCriticBatch?: boolean;
    hasRewritePlan?: boolean;
    hasAutoRevisionDecisions?: boolean;
    hasPostRewriteCriticBatch?: boolean;
    pendingRevisionCount?: number;
    revisionCount?: number;
  };
};

const autoReviewStrategies = [
  "conservative_polish",
  "humanized_literary",
  "clarity_readability",
  "emotional_depth",
  "contemporary_view",
  "creative_enhancement",
] as const;

const autoReviewTrustProfiles = ["careful", "balanced", "full_trust"] as const;

export function BookActions({
  bookId,
  chapterCount,
  sceneCount,
  paragraphCount,
  plannedChapterCount = 0,
  bookBibleUpdatedAt = null,
  summarizedChapterCount = 0,
}: {
  bookId: string;
  chapterCount: number;
  sceneCount: number;
  paragraphCount: number;
  plannedChapterCount?: number;
  bookBibleUpdatedAt?: string | null;
  summarizedChapterCount?: number;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [lens, setLens] = useState<CriticLens>("revision_priorities");
  const [output, setOutput] = useState("");
  const [pendingTask, setPendingTask] = useState<PendingTask | null>(null);
  const [pendingGuardTask, setPendingGuardTask] = useState<AiDashboardTask | null>(null);
  // Only the single-lens critic run reaches the generic run() path (every
  // other task has its own runQueued* function with its own retry case
  // below) -- remembered here so "Retry Failed" can actually re-invoke it
  // instead of just flipping the queue widget back to "running" with no
  // request behind it.
  const [lastGenericRunTask, setLastGenericRunTask] = useState<{
    path: string;
    body: unknown;
    preflight: AiTaskPreflightData | null;
  } | null>(null);
  const { job: latestAutoReviewJob, autoReviewOutputStale } = useAutoReviewStatus(bookId);
  // Starts false on both server and the client's first render -- reading
  // localStorage inside the useState initializer runs on the client's
  // initial render too (not just the server), and if the user had
  // previously toggled this on, that first client render would return true
  // while the server-rendered HTML was built with false, diverging the
  // entire "AI Job Queue" subtree (Alert vs Paper) and the Switch's checked
  // state -- a hydration mismatch. Deferring the real value to a
  // post-mount effect keeps the first client render identical to the SSR
  // output.
  const [alwaysShowDetailedQueue, setAlwaysShowDetailedQueue] = useState(false);
  const detailedQueuePrefHydrated = useRef(false);

  useEffect(() => {
    // Deliberate one-time post-mount sync from localStorage, not a cascading
    // update loop -- see the hydration-mismatch comment above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlwaysShowDetailedQueue(window.localStorage.getItem("bookforge.alwaysShowDetailedQueue") === "1");
    detailedQueuePrefHydrated.current = true;
  }, []);
  const [queue, setQueue] = useState<AiJobQueueState>({
    currentTask: "",
    currentUnit: "",
    totalUnits: 0,
    completedUnits: 0,
    successfulUnits: 0,
    failedUnits: 0,
    skippedUnits: 0,
    status: "idle",
  });

  useEffect(() => {
    if (!detailedQueuePrefHydrated.current) return;
    window.localStorage.setItem("bookforge.alwaysShowDetailedQueue", alwaysShowDetailedQueue ? "1" : "0");
  }, [alwaysShowDetailedQueue]);

  // Read inside the poll interval below without restarting that interval
  // every time `loading` changes -- the interval only needs the CURRENT
  // value at poll time, not a reason to re-subscribe.
  const loadingRef = useRef<string | null>(null);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const activeLocalJobMode = useCallback((): string | null => {
    const current = loadingRef.current;
    if (!current) return null;
    if (current === "preflight:book-bible" || current === `/api/books/${bookId}/analyze`) return "manuscript_blueprint";
    if (current === "preflight:chapter-summaries" || current === `/api/books/${bookId}/chapters/summarize`) return "chapter_summaries";
    if (current === "preflight:critic" || current === `/api/books/${bookId}/critic`) return "bookforge_critic";
    if (current === "preflight:critic-all" || current === `/api/books/${bookId}/critic/all`) return "bookforge_critic_batch";
    if (current === "preflight:generate-draft" || current === `/api/books/${bookId}/generate-draft`) return "creation_draft_generation";
    return null;
  }, [bookId]);

  // The `queue`/`loading` state above only knows about work THIS tab
  // started -- reload the page, open a second tab, or come back after the
  // request that started a job finished loading, and the button reverts to
  // a plain label with no way to tell a real server-side job is still
  // running, inviting a duplicate click. Poll the same real job data the
  // Jobs panel uses so the buttons themselves reflect ground truth, not
  // just this tab's own memory of what it clicked.
  const [remoteActiveJobs, setRemoteActiveJobs] = useState<RemoteJobRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await fetchJson<{ content?: { jobs?: RemoteJobRow[] } }>(
          `/api/books/${bookId}/jobs`,
          { cache: "no-store" },
          "Poll active jobs",
        );
        if (!cancelled) {
          const now = Date.now();
          const active = (result.content?.jobs || [])
            .filter((job) => job.status === "running" || job.status === "queued")
            .map((job) => ({
              ...job,
              elapsedSecondsAtPoll: job.progress?.startedAt
                ? Math.max(0, Math.floor((now - new Date(job.progress.startedAt).getTime()) / 1000))
                : 0,
            }));
          setRemoteActiveJobs(active);

          // The big "AI Job Queue" panel used to be driven entirely by a
          // client-side SIMULATION of progress (elapsed time divided by the
          // pre-run guess) -- it could never reflect the server splitting a
          // call into more sub-calls than planned, and its self-referential
          // "average so far" math grew without bound once a call ran longer
          // than its estimate (found live: "estimated time left" climbing
          // forever instead of counting down). Once a real job row with real
          // progress exists for whatever task this tab is currently running,
          // replace the simulated numbers with the real ones.
          const matchedMode = activeLocalJobMode();
          const matchedJob = matchedMode ? active.find((job) => job.mode === matchedMode) : null;
          if (matchedJob) {
            const progress = matchedJob.progress;
            const totalUnits = Math.max(1, progress?.totalUnits || 1);
            const successfulUnits = progress?.successful || 0;
            const failedUnits = progress?.failed || 0;
            const skippedUnits = progress?.skipped || 0;
            const completedUnits = Math.min(totalUnits, successfulUnits + failedUnits);
            const elapsedSeconds = matchedJob.elapsedSecondsAtPoll || 0;
            const observedCompletions = successfulUnits + failedUnits;
            setQueue((current) => {
              const perUnit =
                observedCompletions >= 1
                  ? Math.max(1, elapsedSeconds / observedCompletions)
                  : current.estimatedSecondsPerCall || 20;
              const remainingUnits = Math.max(0, totalUnits - completedUnits);
              const secondsIntoCurrentUnit = Math.max(0, elapsedSeconds - completedUnits * perUnit);
              return {
                ...current,
                currentTask: progress?.taskName || current.currentTask,
                // Keep the stable mode key regardless of whether the server
                // sent a taskName this tick -- code like onRetryFailed below
                // matches on this, never on the human-readable currentTask
                // label (which the server and client don't always agree on).
                mode: matchedMode || current.mode,
                currentUnit: progress?.currentUnit || current.currentUnit,
                totalUnits,
                completedUnits,
                successfulUnits,
                failedUnits,
                skippedUnits,
                elapsedSeconds,
                estimatedSecondsPerCall: perUnit,
                currentCallElapsedSeconds: secondsIntoCurrentUnit,
                currentCallProgress: Math.min(0.97, secondsIntoCurrentUnit / perUnit),
                nextCallSeconds: remainingUnits > 0 ? Math.max(0, Math.ceil(perUnit - secondsIntoCurrentUnit)) : null,
                estimatedSecondsRemaining: Math.ceil(remainingUnits * perUnit),
                // Real completions exist now -- stop letting the fallback
                // client-side ticker (below) simulate progress over this.
                estimatedProgress: observedCompletions < 1,
                status: "running",
              };
            });
          }
        }
      } catch {
        // Transient poll failures shouldn't clear what we already know.
      }
    }
    void poll();
    const intervalId = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [bookId, activeLocalJobMode]);

  function findRemoteJob(mode: string) {
    return remoteActiveJobs.find((job) => job.mode === mode) || null;
  }

  function remoteJobAsQueueState(job: RemoteJobRow): AiJobQueueState {
    const progress = job.progress;
    const totalUnits = progress?.totalUnits || 1;
    const completedUnits = Math.min(totalUnits, (progress?.successful || 0) + (progress?.failed || 0));
    return {
      currentTask: progress?.taskName || job.mode,
      mode: job.mode,
      currentUnit: progress?.currentUnit || "",
      totalUnits,
      completedUnits,
      successfulUnits: progress?.successful || 0,
      failedUnits: progress?.failed || 0,
      skippedUnits: progress?.skipped || 0,
      elapsedSeconds: job.elapsedSecondsAtPoll || 0,
      estimatedSecondsRemaining: null,
      status: "running",
    };
  }

  async function getModelStatus(): Promise<ModelStatusResponse> {
    return fetchJson<ModelStatusResponse>(
      "/api/lmstudio/status",
      { cache: "no-store" },
      "LM Studio model status check",
    );
  }

  function jobModeForTask(task: AiDashboardTask) {
    switch (task) {
      case "book-bible":
        return "manuscript_blueprint";
      case "chapter-summaries":
        return "chapter_summaries";
      case "critic":
        return "bookforge_critic";
      case "critic-all":
        return "bookforge_critic_batch";
      case "generate-draft":
        return "creation_draft_generation";
      default:
        return null;
    }
  }

  // Real median seconds-per-unit from every user's completed runs of this
  // task, pooled globally so a first-time user benefits from it immediately
  // instead of only the local-throughput formula's guess -- see
  // src/lib/ai/estimation-history.ts for why that formula alone is
  // frequently off by 10-1000x for cloud-routed accounts. Failure here just
  // means falling back to the existing static estimate, never blocking.
  async function getHistoricalSecondsPerCall(task: AiDashboardTask): Promise<number | null> {
    const mode = jobModeForTask(task);
    if (!mode) return null;
    try {
      const result = await fetchJson<{ content?: { estimate?: { secondsPerUnit: number; sampleSize: number } | null } }>(
        `/api/ai/estimation-history?task=${encodeURIComponent(mode)}`,
        { cache: "no-store" },
        "Historical estimate lookup",
      );
      return result.content?.estimate?.secondsPerUnit ?? null;
    } catch {
      return null;
    }
  }

  async function openPreflight(task: AiDashboardTask) {
    setOutput("");
    setLoading(`preflight:${task}`);
    try {
      const [status, historicalSecondsPerCall] = await Promise.all([
        getModelStatus(),
        getHistoricalSecondsPerCall(task),
      ]);
      const modelKey =
        task === "critic" || task === "critic-all" || task === "auto-review"
          ? "reasoningModel"
          : task === "generate-draft"
            ? "primaryRewriteModel"
            : "extractionModel";
      const configured = status.configuredModels.find((item) => item.key === modelKey);
      const runtimeTask =
        task === "auto-review" || task === "critic" || task === "critic-all"
          ? "critic"
          : task === "generate-draft"
            ? "rewrite"
            : "extraction";
      // status.connected/configured.available only reflect LOCAL LM Studio
      // reachability, so every AI Task Preflight modal's "Proceed" button was
      // permanently disabled for accounts configured to use a cloud provider
      // (e.g. OpenRouter) — local LM Studio was never expected to be running
      // for them. Treat the account as ready when its cloud provider is
      // actually the active path for this task's model kind.
      const isCloudReadyForTask = Boolean(
        status.cloudProvider?.model &&
          (runtimeTask === "rewrite" ? status.cloudProvider.usedForRewrite : status.cloudProvider.usedForPlanning),
      );
      // configured.model only reflects the LM Studio task-assignment field, so it's
      // empty for accounts running a cloud provider even when that provider is fully
      // configured and about to be used -- fall back to the active cloud model so the
      // preflight doesn't display "Not configured" and warn about a model that was
      // never going to be used for this call.
      const selectedModel = configured?.model || (isCloudReadyForTask ? status.cloudProvider?.model || "" : "");
      const runtimeLimits = status.runtimeLimits?.[runtimeTask] || status.runtimeLimits?.planning;
      const plan = estimateAiCallPlan({
        task: task === "critic" || task === "critic-all" || task === "auto-review" ? "critic" : "book-bible",
        selectedModel,
        qualityProfile: status.qualityProfile,
        contextWindowTokens: runtimeLimits?.configuredContextTokens || status.contextWindowTokens,
        maxOutputTokens: runtimeLimits?.maxOutputTokens || status.maxOutputTokens,
        chapterCount,
        sceneCount,
        paragraphCount,
        historicalSecondsPerCall,
      });
      const autoReviewRewriteUnits = Math.min(Math.max(paragraphCount, 1), 5000);
      const estimatedUnits =
        task === "auto-review"
          ? 9
          : task === "critic-all"
          ? CRITIC_LENS_COUNT
          : task === "generate-draft"
          ? Math.min(Math.max(plannedChapterCount, 1), 3)
          : task === "chapter-summaries"
          ? Math.max(chapterCount, 1)
          : plan.unitStrategy === "paragraphs"
            ? paragraphCount
            : plan.unitStrategy === "scenes"
              ? sceneCount
              : Math.max(chapterCount, 1);
      const expectedAiCalls =
        task === "auto-review"
          ? 9
          : task === "critic-all"
          ? CRITIC_LENS_COUNT
          : task === "generate-draft"
          ? Math.min(Math.max(plannedChapterCount, 1), 3)
          : task === "chapter-summaries"
            ? Math.max(chapterCount, 1)
            : plan.expectedCalls;
      const warnings = [
        ...status.warnings,
        ...(runtimeLimits?.warnings || []),
        ...plan.warnings,
        ...(selectedModel ? [] : [`${configured?.label || "Required"} model is not configured.`]),
        ...(paragraphCount === 0 && (task === "critic" || task === "critic-all" || task === "auto-review")
          ? [
              'This book has no drafted manuscript prose yet -- Critic and Auto-Review evaluate chapter text, not outline summaries. Run "Write Your Chapters" first.',
            ]
          : []),
        ...(paragraphCount > 0 && task === "book-bible"
          ? [
              `This book has ${chapterCount.toLocaleString()} chapters, ${sceneCount.toLocaleString()} scenes, and ${paragraphCount.toLocaleString()} paragraphs. BookForge will use structured context instead of a whole-book rewrite.`,
            ]
          : []),
        ...(task === "chapter-summaries"
          ? [
              "BookForge will make one focused extraction call per chapter so these summaries are reliable reusable context.",
            ]
          : []),
        ...(task === "critic-all"
          ? [
              `BookForge will run all ${CRITIC_LENS_COUNT} baseline Critic lenses. This is the fastest way to clear rewrite-planning Critic coverage.`,
            ]
          : []),
        ...(task === "auto-review"
          ? [
              "Auto Review will run blueprint, chapter summaries, baseline Critic, rewrite planning, paragraph rewriting, random accept/reject/redo decisions, a redo pass when needed, and post-rewrite Critic.",
              `The paragraph rewrite step can still process up to ${autoReviewRewriteUnits.toLocaleString()} paragraph unit(s) inside the rewrite job.`,
              "The reviewer intentionally randomizes trust profile, rewrite strategy, distribution mode, and accept/reject/redo outcomes so the run can explore unknowns instead of deterministically approving every draft.",
            ]
          : []),
        ...(task === "generate-draft"
          ? [
              "BookForge will generate only a small batch of planned chapter shells in this run. Continue running batches until all planned chapters have prose.",
              "Generated prose becomes the first-draft original text for AI-created books; imported manuscript originals are not affected.",
            ]
          : []),
      ];
      const taskPath =
        task === "book-bible"
          ? `/api/books/${bookId}/analyze`
          : task === "auto-review"
            ? `/api/books/${bookId}/auto-review`
          : task === "chapter-summaries"
            ? `/api/books/${bookId}/chapters/summarize`
            : task === "critic-all"
              ? `/api/books/${bookId}/critic/all`
            : task === "generate-draft"
              ? `/api/books/${bookId}/generate-draft`
              : `/api/books/${bookId}/critic`;

      setPendingTask({
        path: taskPath,
        body: task === "critic" ? { lens } : task === "critic-all" ? { stage: "baseline" } : undefined,
        preflight: {
          taskName:
            task === "book-bible"
              ? "Generate Manuscript Blueprint"
              : task === "auto-review"
                ? "Auto Review Full Book"
              : task === "chapter-summaries"
                ? "Generate Chapter Summaries"
                : task === "critic-all"
                  ? "Run all BookForge Critic lenses"
                : task === "generate-draft"
                  ? "Generate Planned Draft"
                : `BookForge Critic: ${criticLenses[lens].label}`,
          taskDescription:
            task === "book-bible"
              ? "Analyze manuscript structure and extract reusable book context for future revisions."
              : task === "auto-review"
                ? "Run the full guided review workflow automatically, including randomized rewrite choices and random accept/reject/redo decisions for draft paragraph revisions."
              : task === "chapter-summaries"
                ? "Summarize every chapter for future Manuscript Blueprint, Critic, and revision context."
                : task === "critic-all"
                  ? "Evaluate the book through every baseline Critic lens required for rewrite planning."
                : task === "generate-draft"
                  ? "Write prose for planned AI-created chapter shells using the accepted Creation Wizard architecture."
                : "Evaluate the book through the selected critic lens without rewriting manuscript text.",
          requiredModelType:
            task === "critic" || task === "critic-all" || task === "auto-review"
              ? "Reasoning model"
              : task === "generate-draft"
                ? "Primary rewrite model"
                : "Extraction model",
          selectedModel,
          lmStudioConnected: status.connected || isCloudReadyForTask,
          modelAvailable: Boolean(configured?.available) || isCloudReadyForTask,
          blocked: paragraphCount === 0 && (task === "critic" || task === "critic-all" || task === "auto-review"),
          estimatedUnits,
          expectedAiCalls,
          qualityProfile: status.qualityProfile,
          contextSize: status.contextWindowTokens,
          temperature: status.temperature,
          maxOutputTokens: runtimeLimits?.maxOutputTokens || status.maxOutputTokens,
          planningMath:
            task === "auto-review"
              ? [
                  "Auto Review is tracked as 9 workflow steps:",
                  "1. Manuscript Blueprint",
                  "2. Chapter summaries",
                  "3. Baseline Critic lenses",
                  "4. Rewrite Architect plan",
                  "5. Paragraph rewrite job",
                  "6. Random accept/reject/redo review",
                  "7. Redo rewrite job when needed",
                  "8. Random redo review when needed",
                  "9. Post-rewrite Critic lenses",
                  "",
                  `Paragraph work still happens inside the rewrite job: up to ${autoReviewRewriteUnits.toLocaleString()} paragraph unit(s).`,
                ].join("\n")
              : plan.math,
          targetTokensPerCall: plan.targetTokensPerCall,
          usableContextTokens: runtimeLimits?.usableInputTokens || plan.usableContextTokens,
          estimatedSecondsPerCall: plan.estimatedSecondsPerCall,
          estimatedTotalSeconds:
            task === "auto-review"
              ? plan.estimatedSecondsPerCall * 9
              : task === "chapter-summaries" || task === "generate-draft" || task === "critic-all"
                ? plan.estimatedSecondsPerCall * expectedAiCalls
                : plan.estimatedTotalSeconds,
          unitStrategy:
            task === "auto-review"
              ? "full workflow"
              : task === "chapter-summaries" || task === "generate-draft"
                ? "chapters"
                : plan.unitStrategy,
          modelSizeB: plan.modelSizeB,
          quantization: plan.quantization,
          warnings,
        },
        kind: task === "auto-review" ? "auto-review" : "single",
      });
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Preflight failed." }, null, 2));
    } finally {
      setLoading(null);
    }
  }

  function requiresPostAutoReviewConfirmation(task: AiDashboardTask) {
    return task === "book-bible" || task === "chapter-summaries" || task === "critic" || task === "critic-all";
  }

  function requestTask(task: AiDashboardTask) {
    if (latestAutoReviewJob?.status === "completed" && !autoReviewOutputStale && requiresPostAutoReviewConfirmation(task)) {
      setPendingGuardTask(task);
      return;
    }
    void openPreflight(task);
  }

  function modeForApiPath(path: string): string | undefined {
    if (path.endsWith("/generate-draft")) return "creation_draft_generation";
    if (path.endsWith("/chapters/summarize")) return "chapter_summaries";
    if (path.endsWith("/critic/all")) return "bookforge_critic_batch";
    if (path.endsWith("/critic")) return "bookforge_critic";
    if (path.endsWith("/analyze")) return "manuscript_blueprint";
    return undefined;
  }

  async function run(path: string, body: unknown, preflight: AiTaskPreflightData | null) {
    setLastGenericRunTask({ path, body, preflight });
    setLoading(path);
    setOutput("");
    const taskName = preflight?.taskName || "AI task";
    const totalUnits = preflight?.expectedAiCalls || 1;
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 20;
    const startedAt = Date.now();
    setQueue({
      currentTask: taskName,
      mode: modeForApiPath(path),
      currentUnit: unitLabel(totalUnits),
      totalUnits,
      completedUnits: 0,
      successfulUnits: 0,
      failedUnits: 0,
      skippedUnits: 0,
      startedAt,
      estimatedSecondsPerCall,
      elapsedSeconds: 0,
      currentCallElapsedSeconds: 0,
      currentCallProgress: 0,
      nextCallSeconds: totalUnits > 1 ? estimatedSecondsPerCall : null,
      estimatedSecondsRemaining: null,
      estimatedProgress: true,
      status: "running",
    });
    try {
      const result = await fetchJson<{ content?: Record<string, unknown> }>(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }, taskName);
      setOutput(formatResultMessage(path, result));
      router.refresh();
      setQueue((current) => ({
        ...current,
        currentUnit: "Complete",
        completedUnits: totalUnits,
        successfulUnits: totalUnits,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallElapsedSeconds: estimatedSecondsPerCall,
        currentCallProgress: 1,
        nextCallSeconds: 0,
        estimatedSecondsRemaining: 0,
        estimatedProgress: false,
        status: "complete",
      }));
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." }, null, 2));
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
    } finally {
      setLoading(null);
    }
  }

  async function runAutoReview(preflight: AiTaskPreflightData | null) {
    const totalUnits = 9;
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 25;
    const startedAt = Date.now();
    let completedUnits = 0;

    function setAutoQueue(currentUnit: string, status: AiJobQueueState["status"] = "running") {
      setQueue({
        currentTask: "Auto Review Full Book",
        currentUnit,
        totalUnits,
        completedUnits,
        successfulUnits: completedUnits,
        failedUnits: 0,
        skippedUnits: 0,
        startedAt,
        estimatedSecondsPerCall,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallElapsedSeconds: 0,
        currentCallProgress: status === "complete" ? 1 : 0.2,
        nextCallSeconds: status === "running" ? estimatedSecondsPerCall : 0,
        estimatedSecondsRemaining: status === "running" ? Math.max(0, (totalUnits - completedUnits) * estimatedSecondsPerCall) : 0,
        estimatedProgress: false,
        status,
      });
    }

    async function post<T = { content?: Record<string, unknown> }>(path: string, body: unknown, label: string) {
      setAutoQueue(label);
      const payload = (body || {}) as Record<string, unknown>;
      const isAutoRevisionPreview = path.includes("/auto-revision") && payload.action === "preview";

      if (supportsServerManagedHandoff(path) && !isAutoRevisionPreview) {
        const queued = await fetchJson<{ content?: { jobId?: string } }>(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, serverManaged: true }),
          },
          `${label} (queue)`,
        );
        const jobId = queued.content?.jobId;
        if (!jobId) {
          throw new Error(`Queue handoff failed for ${label}.`);
        }

        const resumed = await fetchJson<T>(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, jobId }),
          },
          label,
        );
        completedUnits = Math.min(totalUnits, completedUnits + 1);
        return resumed;
      }

      const result = await fetchJson<T>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody((payload || {}) as Record<string, unknown>)),
        },
        label,
      );
      completedUnits = Math.min(totalUnits, completedUnits + 1);
      return result;
    }

    function supportsServerManagedHandoff(path: string) {
      return (
        path.includes("/analyze") ||
        path.includes("/chapters/summarize") ||
        path.includes("/critic") ||
        path.includes("/rewrite-plan") ||
        path.includes("/rewrite-execute") ||
        path.includes("/auto-revision") ||
        path.includes("/drift-check")
      );
    }

    function skipCompleted(label: string) {
      completedUnits = Math.min(totalUnits, completedUnits + 1);
      setAutoQueue(`${label} already complete`);
    }

    setLoading("auto-review");
    setOutput("");
    setAutoQueue("Starting full workflow");

    try {
      const initialStatus = await fetchJson<AutoReviewStatusResponse>(
        `/api/books/${bookId}/auto-review/status`,
        { cache: "no-store" },
        "Auto Review status check",
      );
      const status = initialStatus.content || {};

      if (status.hasBlueprint) skipCompleted("Manuscript Blueprint");
      else await post(`/api/books/${bookId}/analyze`, {}, "Generating Manuscript Blueprint");

      if (status.hasChapterSummaries) skipCompleted("Chapter summaries");
      else await post(`/api/books/${bookId}/chapters/summarize`, {}, "Generating chapter summaries");

      if (status.hasBaselineCriticBatch) skipCompleted("Baseline Critic lenses");
      else await post(`/api/books/${bookId}/critic/all`, { stage: "baseline" }, "Running baseline Critic lenses");

      if (status.hasRewritePlan) skipCompleted("Rewrite Architect plan");
      else await post(`/api/books/${bookId}/critic-quality`, {}, "Creating Rewrite Architect plan");

      const firstStrategy = randomItem(autoReviewStrategies);
      const firstTrustProfile = randomItem(autoReviewTrustProfiles);
      if ((status.pendingRevisionCount || 0) > 0) {
        skipCompleted("Paragraph rewrite job");
      } else {
        await post(
          `/api/books/${bookId}/rewrite-execute`,
          {
            maxUnits: Math.min(Math.max(paragraphCount, 1), 5000),
            strategyId: firstStrategy,
            distributeAcrossChapters: Math.random() >= 0.35,
            coverageMode: Math.random() >= 0.5 ? "uncovered_chapter_sample" : "normal",
          },
          `Rewriting paragraphs with ${firstStrategy.replaceAll("_", " ")}`,
        );
      }

      const firstReview =
        status.hasAutoRevisionDecisions && (status.pendingRevisionCount || 0) === 0
          ? (skipCompleted("Random accept/reject/redo review"), null)
          : await post<AutoRevisionResponse>(
              `/api/books/${bookId}/auto-revision`,
              {
                action: "run",
                trustProfile: firstTrustProfile,
                maxDecisions: Math.min(Math.max(paragraphCount, 1), 5000),
              },
              `Randomly accepting, rejecting, or redoing drafts with ${firstTrustProfile.replaceAll("_", " ")} trust`,
            );

      const redoCount =
        (firstReview?.content?.applied?.redo || firstReview?.content?.decisions?.redo || 0) +
        (firstReview?.content?.applied?.rejected || firstReview?.content?.decisions?.reject || 0);

      let secondReview: AutoRevisionResponse | null = null;
      if (redoCount > 0) {
        const redoStrategy = randomItem(autoReviewStrategies);
        const redoTrustProfile = randomItem(autoReviewTrustProfiles);
        await post(
          `/api/books/${bookId}/rewrite-execute`,
          {
            maxUnits: Math.min(Math.max(redoCount, 1), 5000),
            rewriteExistingDrafts: true,
            strategyId: redoStrategy,
            distributeAcrossChapters: Math.random() >= 0.35,
            coverageMode: "normal",
          },
          `Redoing ${redoCount} rejected or redo paragraph draft(s)`,
        );
        secondReview = await post<AutoRevisionResponse>(
          `/api/books/${bookId}/auto-revision`,
          {
            action: "run",
            trustProfile: redoTrustProfile,
            maxDecisions: Math.min(Math.max(redoCount, 1), 5000),
          },
          `Randomly reviewing redo drafts with ${redoTrustProfile.replaceAll("_", " ")} trust`,
        );
      } else {
        skipCompleted("Redo rewrite job");
        skipCompleted("Random redo review");
      }

      if (status.hasPostRewriteCriticBatch) skipCompleted("Post-rewrite Critic lenses");
      else await post(`/api/books/${bookId}/critic/all`, { stage: "post_rewrite" }, "Running post-rewrite Critic lenses");

      completedUnits = totalUnits;
      setAutoQueue("Complete", "complete");
      setOutput(formatAutoReviewMessage(firstReview, secondReview));
      router.refresh();
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Auto Review failed." }, null, 2));
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
    } finally {
      setLoading(null);
    }
  }

  async function runQueuedGenerateDraft(preflight: AiTaskPreflightData | null) {
    const path = `/api/books/${bookId}/generate-draft`;
    const totalUnits = Math.max(1, plannedChapterCount);
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 40;
    const startedAt = Date.now();

    setLoading(path);
    setOutput("");
    setQueue({
      currentTask: "Generate Planned Draft",
      mode: "creation_draft_generation",
      currentUnit: `Queued ${totalUnits} planned chapter(s)`,
      totalUnits,
      completedUnits: 0,
      successfulUnits: 0,
      failedUnits: 0,
      skippedUnits: 0,
      startedAt,
      estimatedSecondsPerCall,
      elapsedSeconds: 0,
      currentCallElapsedSeconds: 0,
      currentCallProgress: 0.1,
      nextCallSeconds: estimatedSecondsPerCall,
      estimatedSecondsRemaining: totalUnits * estimatedSecondsPerCall,
      estimatedProgress: true,
      status: "running",
    });

    try {
      // generate-draft processes one chapter per request -- runChunkedJob
      // reuses the same jobId across calls until every planned chapter is
      // drafted, driving real (not estimated) progress per chapter instead
      // of the old single fire-and-forget call capped at 3 chapters/click.
      const finalResult = await runChunkedJob(
        path,
        mergeMetadataSnapshotBody({}),
        "Generate Planned Draft",
        (progress) => {
          const generatedSoFar = (progress.totalGenerated as number) ?? 0;
          const totalFromServer = (progress.totalUnits as number) || totalUnits;
          const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
          setOutput(`Generated ${generatedSoFar} of ${totalFromServer} planned chapter(s)…`);
          setQueue((current) => ({
            ...current,
            currentUnit: `Processing chapter ${generatedSoFar + 1} of ${totalFromServer}`,
            totalUnits: totalFromServer,
            completedUnits: generatedSoFar,
            successfulUnits: generatedSoFar,
            elapsedSeconds,
            currentCallProgress: 1,
            estimatedProgress: false,
            status: "running",
          }));
          router.refresh();
        },
      );

      const totalGenerated = (finalResult.totalGenerated as number) ?? totalUnits;
      setOutput(formatResultMessage(path, { content: finalResult }));
      router.refresh();
      setQueue((current) => ({
        ...current,
        currentUnit: "Complete",
        totalUnits: (finalResult.totalUnits as number) || current.totalUnits,
        completedUnits: totalGenerated,
        successfulUnits: totalGenerated,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallElapsedSeconds: estimatedSecondsPerCall,
        currentCallProgress: 1,
        nextCallSeconds: 0,
        estimatedSecondsRemaining: 0,
        estimatedProgress: false,
        status: "complete",
      }));
    } catch (error) {
      setOutput(
        JSON.stringify(
          {
            error: describeTaskError(error, "Planned draft generation failed."),
          },
          null,
          2,
        ),
      );
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
    } finally {
      setLoading(null);
    }
  }

  async function runQueuedChapterSummaries(preflight: AiTaskPreflightData | null) {
    const path = `/api/books/${bookId}/chapters/summarize`;
    const totalUnits = Math.max(1, preflight?.expectedAiCalls || chapterCount || 1);
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 30;
    const startedAt = Date.now();

    setLoading(path);
    setOutput("");
    setQueue({
      currentTask: "Generate Chapter Summaries",
      mode: "chapter_summaries",
      currentUnit: `Queued ${totalUnits} chapter summary call(s)`,
      totalUnits,
      completedUnits: 0,
      successfulUnits: 0,
      failedUnits: 0,
      skippedUnits: 0,
      startedAt,
      estimatedSecondsPerCall,
      elapsedSeconds: 0,
      currentCallElapsedSeconds: 0,
      currentCallProgress: 0.1,
      nextCallSeconds: estimatedSecondsPerCall,
      estimatedSecondsRemaining: totalUnits * estimatedSecondsPerCall,
      estimatedProgress: true,
      status: "running",
    });

    try {
      const created = await fetchJson<{ content?: { jobId?: string; queued?: boolean; totalUnits?: number } }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ serverManaged: true })),
        },
        "Queue chapter summary generation",
      );

      const jobId = created.content?.jobId;
      if (!jobId) {
        throw new Error("Chapter summary job was not created.");
      }

      setOutput(`Chapter summaries queued for ${totalUnits} chapter(s).`);
      setQueue((current) => ({
        ...current,
        currentUnit: `Processing ${totalUnits} chapter summary call(s)`,
        status: "running",
        estimatedProgress: true,
      }));

      void fetchJson<{ content?: { summarized?: number; aiCallPlan?: Record<string, unknown> } }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ jobId })),
        },
        "Generate chapter summaries worker",
      )
        .then((result) => {
          setOutput(formatResultMessage(path, result));
          router.refresh();
          setQueue((current) => ({
            ...current,
            currentUnit: "Complete",
            completedUnits: current.totalUnits,
            successfulUnits: current.totalUnits,
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallElapsedSeconds: estimatedSecondsPerCall,
            currentCallProgress: 1,
            nextCallSeconds: 0,
            estimatedSecondsRemaining: 0,
            estimatedProgress: false,
            status: "complete",
          }));
        })
        .catch((error) => {
          setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Chapter summary generation failed." }, null, 2));
          setQueue((current) => ({
            ...current,
            failedUnits: Math.max(1, current.failedUnits),
            completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallProgress: 0,
            nextCallSeconds: null,
            estimatedProgress: false,
            status: "cancelled",
          }));
        })
        .finally(() => {
          setLoading(null);
        });
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Chapter summary queue failed." }, null, 2));
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
      setLoading(null);
    }
  }

  async function runQueuedBlueprint(preflight: AiTaskPreflightData | null) {
    const path = `/api/books/${bookId}/analyze`;
    const totalUnits = Math.max(1, preflight?.expectedAiCalls || chapterCount || 1);
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 45;
    const startedAt = Date.now();

    setLoading(path);
    setOutput("");
    setQueue({
      currentTask: "Generate Manuscript Blueprint",
      mode: "manuscript_blueprint",
      currentUnit: `Queued ${totalUnits} blueprint chunk(s)`,
      totalUnits,
      completedUnits: 0,
      successfulUnits: 0,
      failedUnits: 0,
      skippedUnits: 0,
      startedAt,
      estimatedSecondsPerCall,
      elapsedSeconds: 0,
      currentCallElapsedSeconds: 0,
      currentCallProgress: 0.1,
      nextCallSeconds: estimatedSecondsPerCall,
      estimatedSecondsRemaining: totalUnits * estimatedSecondsPerCall,
      estimatedProgress: true,
      status: "running",
    });

    try {
      const created = await fetchJson<{ content?: { jobId?: string; queued?: boolean; totalUnits?: number } }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ serverManaged: true })),
        },
        "Queue manuscript blueprint generation",
      );

      const jobId = created.content?.jobId;
      if (!jobId) {
        throw new Error("Blueprint job was not created.");
      }

      setOutput(`Manuscript Blueprint queued for ${totalUnits} chunk(s).`);
      setQueue((current) => ({
        ...current,
        currentUnit: `Processing ${totalUnits} blueprint chunk(s)`,
        status: "running",
        estimatedProgress: true,
      }));

      void fetchJson<{ content?: Record<string, unknown> }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ jobId })),
        },
        "Generate manuscript blueprint worker",
      )
        .then((result) => {
          setOutput(formatResultMessage(path, result));
          router.refresh();
          setQueue((current) => ({
            ...current,
            currentUnit: "Complete",
            completedUnits: current.totalUnits,
            successfulUnits: current.totalUnits,
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallElapsedSeconds: estimatedSecondsPerCall,
            currentCallProgress: 1,
            nextCallSeconds: 0,
            estimatedSecondsRemaining: 0,
            estimatedProgress: false,
            status: "complete",
          }));
        })
        .catch((error) => {
          setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Manuscript Blueprint generation failed." }, null, 2));
          setQueue((current) => ({
            ...current,
            failedUnits: Math.max(1, current.failedUnits),
            completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallProgress: 0,
            nextCallSeconds: null,
            estimatedProgress: false,
            status: "cancelled",
          }));
        })
        .finally(() => {
          setLoading(null);
        });
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Blueprint queue failed." }, null, 2));
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
      setLoading(null);
    }
  }

  async function runQueuedCriticAll(preflight: AiTaskPreflightData | null, body: unknown) {
    const path = `/api/books/${bookId}/critic/all`;
    const payload = (body && typeof body === "object" ? (body as { stage?: string }) : {}) || {};
    const stage = payload.stage === "post_rewrite" ? "post_rewrite" : "baseline";
    const totalUnits = 7;
    const estimatedSecondsPerCall = preflight?.estimatedSecondsPerCall || 35;
    const startedAt = Date.now();

    setLoading(path);
    setOutput("");
    setQueue({
      currentTask: "Run all BookForge Critic lenses",
      mode: "bookforge_critic_batch",
      currentUnit: `Queued ${totalUnits} Critic lens call(s)`,
      totalUnits,
      completedUnits: 0,
      successfulUnits: 0,
      failedUnits: 0,
      skippedUnits: 0,
      startedAt,
      estimatedSecondsPerCall,
      elapsedSeconds: 0,
      currentCallElapsedSeconds: 0,
      currentCallProgress: 0.1,
      nextCallSeconds: estimatedSecondsPerCall,
      estimatedSecondsRemaining: totalUnits * estimatedSecondsPerCall,
      estimatedProgress: true,
      status: "running",
    });

    try {
      const created = await fetchJson<{ content?: { jobId?: string; queued?: boolean; totalUnits?: number } }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ stage, serverManaged: true })),
        },
        "Queue critic batch generation",
      );

      const jobId = created.content?.jobId;
      if (!jobId) {
        throw new Error("Critic batch job was not created.");
      }

      setOutput(`Critic batch queued (${stage === "post_rewrite" ? "post-rewrite" : "baseline"}).`);
      setQueue((current) => ({
        ...current,
        currentUnit: `Processing ${totalUnits} Critic lens call(s)`,
        status: "running",
        estimatedProgress: true,
      }));

      void fetchJson<{ content?: { completed?: number; results?: unknown[] } }>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ jobId, stage })),
        },
        "Run critic batch worker",
      )
        .then((result) => {
          setOutput(formatResultMessage(path, result));
          router.refresh();
          setQueue((current) => ({
            ...current,
            currentUnit: "Complete",
            completedUnits: current.totalUnits,
            successfulUnits: current.totalUnits,
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallElapsedSeconds: estimatedSecondsPerCall,
            currentCallProgress: 1,
            nextCallSeconds: 0,
            estimatedSecondsRemaining: 0,
            estimatedProgress: false,
            status: "complete",
          }));
        })
        .catch((error) => {
          setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Critic batch failed." }, null, 2));
          setQueue((current) => ({
            ...current,
            failedUnits: Math.max(1, current.failedUnits),
            completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallProgress: 0,
            nextCallSeconds: null,
            estimatedProgress: false,
            status: "cancelled",
          }));
        })
        .finally(() => {
          setLoading(null);
        });
    } catch (error) {
      setOutput(JSON.stringify({ error: error instanceof Error ? error.message : "Critic batch queue failed." }, null, 2));
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.failedUnits),
        completedUnits: Math.min(current.totalUnits, current.completedUnits + 1),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
      setLoading(null);
    }
  }

  useEffect(() => {
    if (queue.status !== "running" || !queue.startedAt || !queue.estimatedSecondsPerCall || !queue.estimatedProgress) {
      return;
    }

    const interval = window.setInterval(() => {
      setQueue((current) => {
        if (
          current.status !== "running" ||
          !current.startedAt ||
          !current.estimatedSecondsPerCall ||
          // Real server progress has taken over (see the polling effect
          // above) -- don't fight it with a simulated guess.
          !current.estimatedProgress
        ) {
          return current;
        }

        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
        const perCall = current.estimatedSecondsPerCall;
        const estimatedCompleted = Math.min(Math.max(0, current.totalUnits - 1), Math.floor(elapsedSeconds / perCall));
        // Linear, not modulo -- a modulo wraps back to a small value once a
        // call overruns its estimate, which used to make the current-call
        // progress bar suddenly jump backwards instead of honestly showing
        // "this is taking longer than expected."
        const secondsIntoCurrentCall = Math.max(0, elapsedSeconds - estimatedCompleted * perCall);
        const currentCallElapsedSeconds = current.totalUnits <= 1 ? elapsedSeconds : secondsIntoCurrentCall;
        const currentCallProgress =
          current.totalUnits <= 1
            ? Math.min(0.97, elapsedSeconds / perCall)
            : Math.min(0.97, secondsIntoCurrentCall / perCall);
        const nextCallSeconds =
          current.totalUnits <= 1 || estimatedCompleted >= current.totalUnits - 1
            ? null
            : Math.max(0, Math.ceil(perCall - secondsIntoCurrentCall));
        // The remaining-time estimate is always shown (no more "calibrating"
        // wait for 2 calls to finish) and it's now grounded in the STABLE
        // original per-call estimate rather than re-averaging elapsed time
        // against itself -- that self-referential math is what caused
        // "estimated time left" to climb forever once a call ran long: once
        // estimatedCompleted froze at its cap, the "average" kept inflating
        // every tick because only its numerator (elapsed) kept growing.
        // Here, once a call overruns, currentCallRemaining just clamps to 0
        // instead of feeding back into the estimate.
        const remainingCallsAfterCurrent = Math.max(0, current.totalUnits - estimatedCompleted - 1);
        const currentCallRemaining = Math.max(0, perCall - secondsIntoCurrentCall);
        const estimatedSecondsRemaining = Math.ceil(remainingCallsAfterCurrent * perCall + currentCallRemaining);

        return {
          ...current,
          completedUnits: Math.max(current.completedUnits, estimatedCompleted),
          currentUnit: unitLabel(current.totalUnits, Math.min(current.totalUnits, estimatedCompleted + 1)),
          elapsedSeconds,
          currentCallElapsedSeconds,
          currentCallProgress,
          nextCallSeconds,
          estimatedSecondsRemaining,
        };
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [queue.estimatedProgress, queue.estimatedSecondsPerCall, queue.startedAt, queue.status]);

  return (
    <Stack>
      {latestAutoReviewJob?.status === "completed" && !autoReviewOutputStale && (
        <Alert color="green" title="Auto-Review already completed for this manuscript">
          <Text size="sm" mb={6}>
            {`Last run: ${describeAutoReviewMode(latestAutoReviewJob.mode)} completed `}
            <span suppressHydrationWarning>
              {formatAutoReviewCompletionTime(latestAutoReviewJob.completed_at, latestAutoReviewJob.created_at)}
            </span>
            {"."}
          </Text>
          <Text size="sm" c="dimmed">
            Review the revised manuscript and exports first. Prepare Context and Critic actions are still available, but they are usually redundant right after a completed Auto-Review.
          </Text>
        </Alert>
      )}

      {latestAutoReviewJob?.status === "completed" && autoReviewOutputStale && (
        <Alert color="yellow" title="Manuscript reset since the last Auto-Review">
          <Text size="sm" mb={6}>
            {`Last run: ${describeAutoReviewMode(latestAutoReviewJob.mode)} completed `}
            <span suppressHydrationWarning>
              {formatAutoReviewCompletionTime(latestAutoReviewJob.completed_at, latestAutoReviewJob.created_at)}
            </span>
            {", but no paragraphs currently have accepted text -- the manuscript has been reset since then."}
          </Text>
          <Text size="sm" c="dimmed">
            {"That run's critic scores and revised text no longer reflect the current manuscript. A fresh Auto-Review is recommended rather than assuming the old results still apply."}
          </Text>
        </Alert>
      )}

      {plannedChapterCount > 0 && (
        <Paper radius="lg" p="xl" bg="#fef3c7" style={{ border: "none" }}>
          <Group align="flex-start" gap={28} wrap="nowrap">
            <div
              style={{
                flex: "none",
                width: 72,
                height: 72,
                borderRadius: 16,
                background: "#f97316",
                color: "#fff",
                font: "800 44px/1 Inter, sans-serif",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                letterSpacing: "-0.03em",
              }}
            >
              1
            </div>
            <Stack gap={14} style={{ flex: 1, minWidth: 0 }}>
              <div>
                <Title order={3} style={{ fontSize: 30, letterSpacing: "-0.02em" }}>Write Your Chapters</Title>
                <Text size="md" style={{ color: "#78350f", maxWidth: "92ch" }}>
                  Turn the planned chapter shells from your architecture into actual manuscript prose. Do this first — the tools below (critic, rewrite, export) all need drafted chapters to work with.
                </Text>
              </div>
              {(() => {
                const localActive = loading === "preflight:generate-draft" || loading === `/api/books/${bookId}/generate-draft`;
                const remoteJob = findRemoteJob("creation_draft_generation");
                const remoteOnly = Boolean(remoteJob) && !localActive;
                return (
                  <>
                    <Button
                      fullWidth
                      size="lg"
                      color="orange"
                      loading={localActive}
                      disabled={remoteOnly}
                      onClick={() => openPreflight("generate-draft")}
                    >
                      {remoteOnly
                        ? "Already running -- see progress below"
                        : `Generate Planned Draft (${Math.min(plannedChapterCount, 3)} of ${plannedChapterCount})`}
                    </Button>
                    <Text size="sm" style={{ color: "#92400e" }}>
                      This opens AI Task Preflight. Click Proceed in that dialog to start chapter generation.
                    </Text>
                    <AiJobQueueInlineStatus
                      job={localActive ? queue : remoteJob ? remoteJobAsQueueState(remoteJob) : queue}
                      visible={localActive || Boolean(remoteJob)}
                    />
                  </>
                );
              })()}
            </Stack>
          </Group>
        </Paper>
      )}

      <SimpleGrid cols={{ base: 1, lg: 3 }}>
        <ActionPanel
          step={2}
          title="Prepare Context"
          description="Build reusable manuscript context before revision."
        >
          {(() => {
            const localActive = loading === "preflight:book-bible" || loading === `/api/books/${bookId}/analyze`;
            const remoteJob = findRemoteJob("manuscript_blueprint");
            const remoteOnly = Boolean(remoteJob) && !localActive;
            return (
              <>
                <Button
                  color="grape"
                  fullWidth
                  loading={localActive}
                  disabled={remoteOnly}
                  onClick={() => requestTask("book-bible")}
                >
                  {remoteOnly ? "Already running -- see progress below" : "Generate Manuscript Blueprint"}
                </Button>
                {bookBibleUpdatedAt && !localActive && !remoteJob && (
                  <Text size="xs" c="teal">
                    ✓ Generated <span suppressHydrationWarning>{new Date(bookBibleUpdatedAt).toLocaleString()}</span>
                  </Text>
                )}
                <AiJobQueueInlineStatus
                  job={localActive ? queue : remoteJob ? remoteJobAsQueueState(remoteJob) : queue}
                  visible={localActive || Boolean(remoteJob)}
                />
              </>
            );
          })()}
          {(() => {
            const localActive = loading === "preflight:chapter-summaries" || loading === `/api/books/${bookId}/chapters/summarize`;
            const remoteJob = findRemoteJob("chapter_summaries");
            const remoteOnly = Boolean(remoteJob) && !localActive;
            return (
              <>
                <Button
                  fullWidth
                  variant="outline"
                  color="grape"
                  loading={localActive}
                  disabled={remoteOnly}
                  onClick={() => requestTask("chapter-summaries")}
                >
                  {remoteOnly ? "Already running -- see progress below" : "Generate Chapter Summaries"}
                </Button>
                <Text size="xs" c="dimmed">
                  This opens AI Task Preflight. Click Proceed in that dialog to start summary generation.
                </Text>
                {summarizedChapterCount > 0 && !localActive && !remoteJob && (
                  <Text size="xs" c={summarizedChapterCount >= chapterCount ? "teal" : "orange"}>
                    {summarizedChapterCount >= chapterCount
                      ? `✓ All ${chapterCount} chapter(s) summarized`
                      : `${summarizedChapterCount} of ${chapterCount} chapter(s) summarized -- run again to cover the rest`}
                  </Text>
                )}
                <AiJobQueueInlineStatus
                  job={localActive ? queue : remoteJob ? remoteJobAsQueueState(remoteJob) : queue}
                  visible={localActive || Boolean(remoteJob)}
                />
              </>
            );
          })()}
        </ActionPanel>

        <ActionPanel
          step={3}
          title="BookForge Critic"
          description="Choose a lens, then run the matching evaluation."
        >
          <Select
            label="Critic lens"
            value={lens}
            onChange={(value) => setLens((value as CriticLens) || "revision_priorities")}
            data={Object.entries(criticLenses).map(([value, item]) => ({ value, label: item.label }))}
          />
          {(() => {
            const localActive = loading === "preflight:critic" || loading === `/api/books/${bookId}/critic`;
            const remoteJob = findRemoteJob("bookforge_critic");
            const remoteOnly = Boolean(remoteJob) && !localActive;
            return (
              <>
                <Button
                  fullWidth
                  variant="outline"
                  color="grape"
                  loading={localActive}
                  disabled={remoteOnly}
                  onClick={() => requestTask("critic")}
                >
                  {remoteOnly ? "Already running -- see progress below" : "Run Selected Critic Lens"}
                </Button>
                <AiJobQueueInlineStatus
                  job={localActive ? queue : remoteJob ? remoteJobAsQueueState(remoteJob) : queue}
                  visible={localActive || Boolean(remoteJob)}
                />
              </>
            );
          })()}
          {(() => {
            const localActive = loading === "preflight:critic-all" || loading === `/api/books/${bookId}/critic/all`;
            const remoteJob = findRemoteJob("bookforge_critic_batch");
            const remoteOnly = Boolean(remoteJob) && !localActive;
            return (
              <>
                <Button
                  fullWidth
                  color="grape"
                  loading={localActive}
                  disabled={remoteOnly}
                  onClick={() => requestTask("critic-all")}
                >
                  {remoteOnly ? "Already running -- see progress below" : "Run All Critic Lenses"}
                </Button>
                <AiJobQueueInlineStatus
                  job={localActive ? queue : remoteJob ? remoteJobAsQueueState(remoteJob) : queue}
                  visible={localActive || Boolean(remoteJob)}
                />
              </>
            );
          })()}
        </ActionPanel>

        <ActionPanel
          step={4}
          stepBadge="AFTER STEPS OPTIONAL"
          title="Rewrite & Export"
          description="Revise drafted chapters and build reviewable/final files."
        >
          <Button component={Link} href={`/books/${bookId}/critic-quality`} color="dark" variant="outline" fullWidth>
            Rewrite Architect
          </Button>
          <Button component={Link} href={`/books/${bookId}/revisions`} color="grape" variant="outline" fullWidth>
            Review Draft Revisions
          </Button>
          <Button component={Link} href={`/books/${bookId}/final-manuscript`} color="grape" fullWidth>
            Final Manuscript Builder
          </Button>
        </ActionPanel>
      </SimpleGrid>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          margin: "26px 0 16px",
          paddingTop: 20,
          borderTop: "1px solid oklch(0.93 0.003 90)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.005 90)" }}>Queue visibility</span>
        <button
          type="button"
          onClick={() => setAlwaysShowDetailedQueue((current) => !current)}
          aria-pressed={alwaysShowDetailedQueue}
          style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, cursor: "pointer" }}
        >
          <span style={{ fontSize: 13, color: "oklch(0.4 0.005 90)" }}>Always show detailed queue</span>
          <span
            style={{
              width: 38,
              height: 22,
              borderRadius: 11,
              background: alwaysShowDetailedQueue ? "oklch(0.5 0.16 275)" : "oklch(0.88 0.003 90)",
              position: "relative",
              transition: "background 0.15s",
              flexShrink: 0,
              display: "inline-block",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: alwaysShowDetailedQueue ? 18 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 2px oklch(0.2 0 0 / 0.3)",
                transition: "left 0.15s",
              }}
            />
          </span>
        </button>
      </div>

      {(alwaysShowDetailedQueue || queue.status !== "idle" || queue.totalUnits > 0 || Boolean(queue.currentTask)) ? (
        <AiJobQueue
          job={queue}
          onPause={() => setQueue((current) => ({ ...current, status: "paused" }))}
          onResume={() => setQueue((current) => ({ ...current, status: "running" }))}
          onCancel={() => setQueue((current) => ({ ...current, status: "cancelled" }))}
          onRetryFailed={() => {
            // Match on the stable mode key, never the human-readable
            // currentTask label -- the server's real progress.taskName and
            // the client's button label don't always agree (e.g. server
            // says "Creation Draft Generation", the button says "Generate
            // Planned Draft"), which silently broke Retry Failed for
            // exactly that task once real server progress started
            // overwriting currentTask here.
            if (queue.mode === "creation_draft_generation") {
              void runQueuedGenerateDraft(null);
              return;
            }
            if (queue.mode === "chapter_summaries") {
              void runQueuedChapterSummaries(null);
              return;
            }
            if (queue.mode === "manuscript_blueprint") {
              void runQueuedBlueprint(null);
              return;
            }
            if (queue.mode === "bookforge_critic_batch") {
              void runQueuedCriticAll(null, { stage: "baseline" });
              return;
            }
            if (queue.mode === "bookforge_critic" && lastGenericRunTask) {
              void run(lastGenericRunTask.path, lastGenericRunTask.body, lastGenericRunTask.preflight);
              return;
            }

            setQueue((current) => ({
              ...current,
              failedUnits: 0,
              skippedUnits: 0,
              status: current.currentTask ? "running" : "idle",
            }));
          }}
        />
      ) : (
        <div style={{ background: "oklch(0.97 0.002 90)", border: "1px solid oklch(0.92 0.003 90)", borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "oklch(0.2 0.005 90)", marginBottom: 6 }}>AI Job Queue</div>
          <div style={{ fontSize: 13, color: "oklch(0.55 0.005 90)" }}>No active local queue task.</div>
        </div>
      )}
      {output && (
        <Alert color={output.startsWith("Error:") || output.includes('"error"') ? "red" : "green"} title="Latest result">
          {output}
        </Alert>
      )}
      <AiTaskPreflight
        opened={Boolean(pendingTask)}
        data={pendingTask?.preflight || null}
        loading={Boolean(pendingTask && loading === pendingTask.path)}
        onCancel={() => setPendingTask(null)}
        onProceed={() => {
          if (!pendingTask) return;
          const task = pendingTask;
          setPendingTask(null);
          if (task.kind === "auto-review") {
            void runAutoReview(task.preflight);
          } else if (task.path.endsWith("/analyze")) {
            void runQueuedBlueprint(task.preflight);
          } else if (task.path.includes("/critic/all")) {
            void runQueuedCriticAll(task.preflight, task.body);
          } else if (task.path.includes("/chapters/summarize")) {
            void runQueuedChapterSummaries(task.preflight);
          } else if (task.path.includes("/generate-draft")) {
            void runQueuedGenerateDraft(task.preflight);
          } else {
            void run(task.path, task.body || {}, task.preflight);
          }
        }}
      />
      <Modal
        opened={Boolean(pendingGuardTask)}
        onClose={() => setPendingGuardTask(null)}
        title="Auto-Review already completed"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            This manuscript already has a completed Auto-Review run. The selected action is still available, but it often duplicates work that was just completed.
          </Text>
          <Text size="sm" c="dimmed">
            Review the revised manuscript, critic outcomes, and exports first. Continue only if you intentionally want a fresh baseline/context pass.
          </Text>
          <Button
            color="grape"
            onClick={() => {
              if (!pendingGuardTask) return;
              const task = pendingGuardTask;
              setPendingGuardTask(null);
              void openPreflight(task);
            }}
          >
            Run anyway
          </Button>
          <Button variant="subtle" color="gray" onClick={() => setPendingGuardTask(null)}>
            Cancel
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}

function ActionPanel({
  step,
  stepBadge,
  title,
  description,
  children,
}: {
  /** The numbered step this panel represents in the guided Studio workflow (2, 3, 4 -- step 1 is the "Write Your Chapters" callout above this grid). */
  step: number;
  /** Extra label shown inside the step badge, e.g. "AFTER STEPS OPTIONAL" for the optional final step. */
  stepBadge?: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid oklch(0.92 0.003 90)",
        borderRadius: 14,
        padding: "24px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        background: "#fff",
      }}
    >
      <Group align="flex-start" gap={14} wrap="nowrap" style={{ minHeight: 64 }}>
        <div
          style={{
            flex: "none",
            minWidth: 48,
            height: 48,
            borderRadius: 12,
            background: "oklch(0.4 0.13 275)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: stepBadge ? "flex-start" : "center",
            gap: 8,
            padding: stepBadge ? "6px 10px 6px 10px" : 0,
            boxSizing: "border-box",
          }}
        >
          <span style={{ font: "800 28px/1 Inter, sans-serif", letterSpacing: "-0.03em" }}>{step}</span>
          {stepBadge && (
            <span style={{ font: "700 9px/1.25 Inter, sans-serif", letterSpacing: "0.05em", opacity: 0.9, whiteSpace: "pre-line" }}>
              {stepBadge.split(" ").join("\n")}
            </span>
          )}
        </div>
        <div style={{ paddingTop: 2 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "oklch(0.2 0.005 90)", letterSpacing: "-0.01em" }}>{title}</div>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "oklch(0.5 0.005 90)", lineHeight: 1.45 }}>{description}</p>
        </div>
      </Group>
      {children}
    </div>
  );
}

function unitLabel(totalUnits: number, current = 1) {
  if (totalUnits <= 1) return "Single model call";
  return `Estimated call ${current} of ${totalUnits}`;
}

function randomItem<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function formatAutoReviewMessage(firstReview: AutoRevisionResponse | null, secondReview: AutoRevisionResponse | null) {
  const first: AutoReviewCounts | undefined = firstReview?.content?.applied || firstReview?.content?.decisions;
  const second: AutoReviewCounts | undefined = secondReview?.content?.applied || secondReview?.content?.decisions;
  const parts = [
    "Auto Review completed. Blueprint, summaries, baseline Critic, rewrite plan, paragraph rewrite, random revision decisions, and post-rewrite Critic were saved.",
  ];

  if (first) {
    parts.push(
      `First review: ${first.accepted ?? first.accept ?? 0} accepted, ${first.rejected ?? first.reject ?? 0} rejected, ${first.redo ?? 0} redo.`,
    );
  }
  if (second) {
    parts.push(
      `Redo review: ${second.accepted ?? second.accept ?? 0} accepted, ${second.rejected ?? second.reject ?? 0} rejected, ${second.redo ?? 0} redo.`,
    );
  }
  const nextStep = secondReview?.content?.nextStep || firstReview?.content?.nextStep;
  if (nextStep) parts.push(nextStep);

  return parts.join(" ");
}

function describeAutoReviewMode(mode: AutoReviewJob["mode"]) {
  if (mode === "make_shorter") return "Make Shorter Auto-Review";
  if (mode === "make_longer") return "Make Longer Auto-Review";
  return "Full Auto-Review";
}

function formatAutoReviewCompletionTime(completedAt: string | null, createdAt: string) {
  const source = completedAt || createdAt;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString();
}

function formatResultMessage(path: string, result: { content?: Record<string, unknown> }) {
  const plan = result.content?.aiCallPlan as
    | { actualCalls?: number; expectedCalls?: number; chunkCount?: number; unitStrategy?: string }
    | undefined;

  if (path.includes("/analyze")) {
    const calls = plan?.actualCalls || plan?.chunkCount || plan?.expectedCalls;
    return calls
      ? `Manuscript Blueprint saved. Processed with ${calls} AI call(s) using ${plan?.unitStrategy || "planned"} chunking.`
      : "Manuscript Blueprint saved.";
  }

  if (path.includes("/critic/all")) {
    const completed = result.content?.completed;
    return `BookForge Critic batch saved${typeof completed === "number" ? `: ${completed}/${CRITIC_LENS_COUNT} lenses completed.` : "."}`;
  }

  if (path.includes("/critic")) {
    return "BookForge Critic report saved.";
  }

  if (path.includes("/chapters/summarize")) {
    const summarized = result.content?.summarized;
    return `Chapter summaries saved.${typeof summarized === "number" ? ` Summarized ${summarized} chapter(s).` : ""}`;
  }

  if (path.includes("/generate-draft")) {
    // totalGenerated is the cumulative count across every chunked call this
    // run made; generated (from the raw final API response) only reflects
    // the last individual call, which is 0 once that call is just a
    // terminating "nothing left to draft" check -- prefer the cumulative
    // figure so a fully successful run doesn't report "Drafted 0 chapter(s)".
    const generated = result.content?.totalGenerated ?? result.content?.generated;
    // The API's actual field is remainingChapters, not remaining -- this
    // lookup always returned undefined, so the "N planned chapter(s)
    // remaining" half of the message never rendered.
    const remaining = result.content?.remainingChapters ?? result.content?.remaining;
    return `Planned draft generated.${typeof generated === "number" ? ` Drafted ${generated} chapter(s).` : ""}${
      typeof remaining === "number" ? ` ${remaining} planned chapter(s) remaining.` : ""
    }`;
  }

  return "Task completed and saved.";
}

function describeTaskError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (message.includes("<!DOCTYPE html")) {
    return `${fallback} The server returned an HTML error page instead of JSON. Check server logs for the underlying 500 error.`;
  }
  return message;
}
