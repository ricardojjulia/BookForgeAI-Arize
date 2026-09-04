"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Alert, Badge, Box, Button, Checkbox, Group, Modal, NumberInput, Paper, Progress, SimpleGrid, Stack, Text, Textarea, Title } from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AiJobQueue, AiJobQueueInlineStatus, type AiJobQueueState } from "@/components/ai/ai-job-queue";
import { InsufficientCreditsAlert } from "@/components/ai/insufficient-credits-alert";
import { fetchJson } from "@/lib/http/fetch-json";
import { isInsufficientCreditsMessage } from "@/lib/subscription/enforcement";
import type { RewriteCampaignRow, RewriteCampaignStats } from "@/lib/rewrite/campaigns";
import type { RewriteReadiness, RewriteReadinessStatus } from "@/lib/rewrite/readiness";
import { rewriteStrategies, type RewriteStrategyId, type RewriteStrategySettings } from "@/lib/rewrite/strategies";
import type { RewriteWorkflowMode, RewriteWorkflowRow } from "@/lib/rewrite/workflows";

type CampaignJob = {
  id: string;
  status: string | null;
  settings: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export function RewriteExecutionPanel({
  bookId,
  hasPlan,
  paragraphCount,
  pendingDraftParagraphCount,
  acceptedParagraphCount,
  untouchedParagraphCount,
  rewriteCoverage,
  activeCampaign,
  campaignStats,
  campaignJobs,
  latestDriftReport,
  workflow,
  readiness,
  latestJob,
}: {
  bookId: string;
  hasPlan: boolean;
  paragraphCount: number;
  pendingDraftParagraphCount: number;
  acceptedParagraphCount: number;
  untouchedParagraphCount: number;
  rewriteCoverage: Array<{
    chapterId: string;
    chapterNumber: number;
    title: string | null;
    totalParagraphs: number;
    rewrittenParagraphs: number;
    realTotalParagraphs: number;
    realRewrittenParagraphs: number;
    pendingParagraphs: number;
  }>;
  activeCampaign: RewriteCampaignRow | null;
  campaignStats: RewriteCampaignStats;
  campaignJobs: CampaignJob[];
  latestDriftReport: { id?: string; content: Record<string, unknown> | null; created_at: string } | null;
  workflow: RewriteWorkflowRow;
  readiness: RewriteReadiness;
  latestJob?: { id: string; status: string | null; created_at: string; completed_at: string | null; settings: Record<string, unknown> | null } | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [maxUnits, setMaxUnits] = useState<number | "">(25);
  const [rewriteExistingDrafts, setRewriteExistingDrafts] = useState(false);
  const [rewriteAccepted, setRewriteAccepted] = useState(false);
  const [distributeAcrossChapters, setDistributeAcrossChapters] = useState(true);
  // Seeded from whatever strategy is actually in force -- an active
  // campaign's own strategy first (that's genuinely what's running), then
  // the last one this workflow approved, only falling back to the
  // hardcoded default when neither exists. Previously this always
  // hardcoded "humanized_literary" regardless of what was approved or
  // already running, silently reverting the user's real choice on every
  // remount (page navigation, tab refresh, or this panel's own periodic
  // router.refresh()) -- exactly the "the rewrite tries something you
  // didn't intend" risk this was flagged for.
  const initialStrategyId = activeCampaign?.strategy_id
    ? normalizeCampaignStrategyId(activeCampaign.strategy_id)
    : (() => {
        const approved = workflow.metadata?.approvedStrategyId;
        return typeof approved === "string" && approved in rewriteStrategies ? (approved as RewriteStrategyId) : "humanized_literary";
      })();
  const [strategyId, setStrategyId] = useState<RewriteStrategyId>(initialStrategyId);
  const [strategySettings, setStrategySettings] = useState<RewriteStrategySettings>(
    activeCampaign?.strategy_settings
      ? normalizeCampaignStrategySettings(activeCampaign.strategy_settings)
      : rewriteStrategies[initialStrategyId].settings,
  );
  const [authorInstructions, setAuthorInstructions] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [campaignLoading, setCampaignLoading] = useState<string | null>(null);
  const [chapterLoading, setChapterLoading] = useState<string | null>(null);
  const [workflowMode, setWorkflowMode] = useState<RewriteWorkflowMode>(workflow.mode);
  const [workflowState, setWorkflowState] = useState<RewriteWorkflowRow>(workflow);
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
  const eligibleParagraphCount =
    untouchedParagraphCount + (rewriteExistingDrafts ? pendingDraftParagraphCount : 0) + (rewriteAccepted ? acceptedParagraphCount : 0);
  const suggestedBatchSize = getSuggestedBatchSize(eligibleParagraphCount || paragraphCount, latestJob?.settings);

  async function saveWorkflow(update: {
    mode?: RewriteWorkflowMode;
    currentStep?: number;
    strategyApproved?: boolean;
    sampleRevisionJobId?: string | null;
    campaignId?: string | null;
    lastDriftReportId?: string | null;
    postCriticCompleted?: boolean;
    exportReady?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    const result = await fetchJson<{ content?: { workflow?: RewriteWorkflowRow } }>(
      `/api/books/${bookId}/rewrite-workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      },
      "Save rewrite workflow",
    );
    if (result.content?.workflow) {
      setWorkflowState(result.content.workflow);
      setWorkflowMode(result.content.workflow.mode);
    }
    return result.content?.workflow || null;
  }

  async function chooseWorkflowMode(mode: RewriteWorkflowMode) {
    setWorkflowMode(mode);
    try {
      await saveWorkflow({ mode, currentStep: mode === "wizard" ? getWizardStep() : workflowState.current_step });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save rewrite workflow.");
    }
  }

  function getWizardStep() {
    if (!hasPlan) return 1;
    if (!latestJob && !workflowState.sample_revision_job_id) return 2;
    if (acceptedParagraphCount === 0) return 3;
    if (!workflowState.strategy_approved && !workflowState.campaign_id && !activeCampaign) return 4;
    if (untouchedParagraphCount > 0) return 5;
    if (!latestDriftReport && !workflowState.last_drift_report_id && !workflowState.post_critic_completed) return 6;
    return 7;
  }

  async function executeRewrite() {
    await executeRewriteWith({});
  }

  async function executeRewriteWith(overrides: {
    maxUnits?: number;
    distributeAcrossChapters?: boolean;
    coverageMode?: "normal" | "uncovered_chapter_sample";
    campaignId?: string;
    chapterId?: string;
    strategyId?: RewriteStrategyId;
    strategySettings?: RewriteStrategySettings;
    authorInstructions?: string;
    rewriteExistingDrafts?: boolean;
    rewriteAccepted?: boolean;
  }) {
    if (!hasPlan) return;
    const targetChapter = overrides.chapterId ? rewriteCoverage.find((c) => c.chapterId === overrides.chapterId) : undefined;
    // No confirm() prompt here, for any caller -- every button that reaches
    // this function (Execute Rewrite, Run Sample Batch, Run Next Batch,
    // "Rewrite this chapter") already makes the scope and intent
    // unambiguous from its own label plus the surrounding step/section
    // text, and window.confirm is unreliable regardless: browsers silently
    // auto-dismiss repeated confirm()/alert() calls on a page after a few
    // of them fire, with no visible dialog and no error -- it just looks
    // like the button does nothing. This action is also non-destructive
    // (draft revisions only; original manuscript text is never
    // overwritten), so there's nothing here that needs an extra gate.
    const chapterRemaining = targetChapter ? Math.max(0, targetChapter.totalParagraphs - targetChapter.rewrittenParagraphs) : undefined;
    const requestedMaxUnits = overrides.maxUnits ?? chapterRemaining ?? Number(maxUnits || eligibleParagraphCount);
    const totalUnits = chapterRemaining ?? Math.min(requestedMaxUnits, eligibleParagraphCount || requestedMaxUnits || 1);
    const estimatedSecondsPerCall = 24;
    const startedAt = Date.now();
    setLoading(true);
    if (overrides.chapterId) setChapterLoading(overrides.chapterId);
    setMessage("");
    setError("");
    setQueue({
      currentTask: "Execute full-book rewrite draft",
      currentUnit: queueLabel(totalUnits),
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

    const payload = {
      maxUnits: overrides.maxUnits ?? (targetChapter ? undefined : maxUnits || undefined),
      campaignId: overrides.campaignId,
      chapterId: overrides.chapterId,
      rewriteExistingDrafts: overrides.rewriteExistingDrafts ?? rewriteExistingDrafts,
      rewriteAccepted: overrides.rewriteAccepted ?? rewriteAccepted,
      distributeAcrossChapters: overrides.distributeAcrossChapters ?? distributeAcrossChapters,
      coverageMode: overrides.coverageMode || "normal",
      strategyId: overrides.strategyId || strategyId,
      strategySettings: overrides.strategySettings || strategySettings,
      authorInstructions: overrides.authorInstructions ?? authorInstructions,
    };

    try {
      const created = await fetchJson<{
        content?: {
          revisionJobId?: string;
          queued?: boolean;
          totalUnits?: number;
        };
      }>(
        `/api/books/${bookId}/rewrite-execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, serverManaged: true }),
        },
        "Queue rewrite execution",
      );
      const revisionJobId = created.content?.revisionJobId || null;
      if (!revisionJobId) {
        throw new Error("Rewrite job was not created.");
      }

      setMessage("Rewrite draft queued. Processing paragraph units in the background.");

      void fetchJson<{
        content?: {
          rewritten?: number;
          skipped?: number;
          skippedExistingDrafts?: number;
          skippedAccepted?: number;
          revisionJobId?: string;
        };
      }>(
        `/api/books/${bookId}/rewrite-execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, jobId: revisionJobId }),
        },
        "Rewrite execution worker",
      )
        .then(async (result) => {
          const rewritten = result.content?.rewritten || 0;
          const skipped = result.content?.skipped || 0;
          const completedJobId = result.content?.revisionJobId || revisionJobId;
          const skippedDetails = [
            result.content?.skippedExistingDrafts ? `${result.content.skippedExistingDrafts} existing draft(s)` : "",
            result.content?.skippedAccepted ? `${result.content.skippedAccepted} accepted paragraph(s)` : "",
          ]
            .filter(Boolean)
            .join(", ");
          setMessage(
            `Rewrite draft saved. Created ${rewritten} revision version(s), skipped ${skipped} unit(s)${
              skippedDetails ? ` (${skippedDetails})` : ""
            }.`,
          );
          setQueue((current) => ({
            ...current,
            currentUnit: "Complete",
            completedUnits: totalUnits,
            successfulUnits: rewritten,
            skippedUnits: skipped,
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallElapsedSeconds: estimatedSecondsPerCall,
            currentCallProgress: 1,
            nextCallSeconds: 0,
            estimatedSecondsRemaining: 0,
            estimatedProgress: false,
            status: "complete",
          }));
          if (completedJobId) {
            await saveWorkflow({
              currentStep: workflowMode === "wizard" ? Math.max(3, workflowState.current_step) : workflowState.current_step,
              sampleRevisionJobId: workflowState.sample_revision_job_id || completedJobId,
              metadata: {
                ...(workflowState.metadata || {}),
                lastRevisionJobId: completedJobId,
                lastRewriteCompletedAt: new Date().toISOString(),
              },
            });
          }
          router.refresh();
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Rewrite execution failed.");
          setQueue((current) => ({
            ...current,
            failedUnits: Math.max(1, current.totalUnits - current.completedUnits),
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            currentCallProgress: 0,
            nextCallSeconds: null,
            estimatedProgress: false,
            status: "cancelled",
          }));
        })
        .finally(() => {
          setLoading(false);
          setChapterLoading(null);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rewrite execution failed.");
      setQueue((current) => ({
        ...current,
        failedUnits: Math.max(1, current.totalUnits - current.completedUnits),
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        currentCallProgress: 0,
        nextCallSeconds: null,
        estimatedProgress: false,
        status: "cancelled",
      }));
      setLoading(false);
      setChapterLoading(null);
    }
  }

  async function createCampaign(goal: "sample_all_chapters" | "full_coverage") {
    setCampaignLoading(`create:${goal}`);
    setMessage("");
    setError("");
    try {
      const result = await fetchJson<{ content?: { campaign?: RewriteCampaignRow } }>(
        `/api/books/${bookId}/rewrite-campaigns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: goal === "sample_all_chapters" ? "Chapter sampling rewrite campaign" : "Full draft coverage campaign",
            goal,
            strategyId,
            strategySettings,
            authorInstructions,
            batchSize: Number(maxUnits || suggestedBatchSize),
            distributeAcrossChapters,
            rewriteExistingDrafts,
            rewriteAccepted,
            stats: campaignStats,
          }),
        },
        "Create rewrite campaign",
      );
      const campaignId = result.content?.campaign?.id || null;
      if (campaignId) {
        await saveWorkflow({
          currentStep: 5,
          strategyApproved: true,
          campaignId,
          metadata: {
            ...(workflowState.metadata || {}),
            approvedAt: new Date().toISOString(),
            approvedStrategyId: strategyId,
          },
        });
      }
      setMessage("Rewrite campaign created. You can now resume it across batches.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create rewrite campaign.");
    } finally {
      setCampaignLoading(null);
    }
  }

  async function updateCampaign(action: "pause" | "resume" | "cancel" | "complete") {
    if (!activeCampaign) return;
    setCampaignLoading(action);
    setMessage("");
    setError("");
    try {
      await fetchJson(
        `/api/rewrite-campaigns/${activeCampaign.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
        "Update rewrite campaign",
      );
      setMessage("Rewrite campaign updated.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update rewrite campaign.");
    } finally {
      setCampaignLoading(null);
    }
  }

  async function runCampaignDriftCheck(jobId: string | null) {
    if (!jobId) {
      setError("Run at least one campaign batch before checking drift.");
      return;
    }
    setCampaignLoading("drift");
    setMessage("");
    setError("");
    try {
      const queued = await fetchJson<{ content?: { jobId?: string } }>(
        `/api/books/${bookId}/drift-check`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revisionJobId: jobId, serverManaged: true }),
        },
        "Queue campaign drift check",
      );
      const durableJobId = queued.content?.jobId;
      if (!durableJobId) throw new Error("Campaign drift-check queue handoff failed.");

      const result = await fetchJson<{ content?: { overallDriftRisk?: string; sampleCount?: number; reportId?: string | null } }>(
        `/api/books/${bookId}/drift-check`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revisionJobId: jobId, jobId: durableJobId }),
        },
        "Run campaign drift check worker",
      );
      setMessage(
        `Campaign drift check saved. Risk: ${result.content?.overallDriftRisk || "unknown"} · samples checked: ${
          result.content?.sampleCount || 0
        }.`,
      );
      await saveWorkflow({
        currentStep: 7,
        lastDriftReportId: result.content?.reportId || null,
        metadata: {
          ...(workflowState.metadata || {}),
          lastDriftCheckedAt: new Date().toISOString(),
          lastDriftRisk: result.content?.overallDriftRisk || "unknown",
        },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to run campaign drift check.");
    } finally {
      setCampaignLoading(null);
    }
  }

  // Accepting/rejecting drafts happens on a separate page (/revisions), so
  // returning here via the browser back button previously showed the
  // coverage cards, captions, and readiness state exactly as they were
  // before that review -- stale until a manual full reload. Refreshing on
  // visibility-regain (not just on mount, which browser back/forward
  // navigation can restore from cache without re-running) catches that
  // return trip, an alt-tab back, or any other way this tab comes back into
  // view, without polling while the user is genuinely elsewhere.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [router]);

  useEffect(() => {
    if (queue.status !== "running" || !queue.startedAt || !queue.estimatedSecondsPerCall) return;
    const interval = window.setInterval(() => {
      setQueue((current) => {
        if (current.status !== "running" || !current.startedAt || !current.estimatedSecondsPerCall) return current;
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
        const estimatedCompleted = Math.min(
          Math.max(0, current.totalUnits - 1),
          Math.floor(elapsedSeconds / current.estimatedSecondsPerCall),
        );
        const secondsIntoCurrentCall = elapsedSeconds % current.estimatedSecondsPerCall;
        const remainingCalls = Math.max(0, current.totalUnits - estimatedCompleted);
        const averageSecondsPerCall =
          estimatedCompleted >= 2 ? Math.max(1, elapsedSeconds / estimatedCompleted) : current.estimatedSecondsPerCall;
        return {
          ...current,
          completedUnits: Math.max(current.completedUnits, estimatedCompleted),
          currentUnit: queueLabel(current.totalUnits, Math.min(current.totalUnits, estimatedCompleted + 1)),
          elapsedSeconds,
          currentCallElapsedSeconds: current.totalUnits <= 1 ? elapsedSeconds : secondsIntoCurrentCall,
          currentCallProgress:
            current.totalUnits <= 1
              ? Math.min(0.94, elapsedSeconds / current.estimatedSecondsPerCall)
              : Math.min(0.98, secondsIntoCurrentCall / current.estimatedSecondsPerCall),
          nextCallSeconds:
            current.totalUnits <= 1 || estimatedCompleted >= current.totalUnits - 1
              ? null
              : Math.max(0, Math.ceil(current.estimatedSecondsPerCall - secondsIntoCurrentCall)),
          estimatedSecondsRemaining:
            estimatedCompleted >= 2 ? Math.ceil(remainingCalls * averageSecondsPerCall) : null,
        };
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [queue.estimatedSecondsPerCall, queue.startedAt, queue.status]);

  return (
    <Paper withBorder radius="md" p="xl" bg="white" mb="xl">
      <Stack>
        {/* Order matches how an author actually decides: am I ready, what
            approach should I take, then how do I want to proceed (guided
            or manual)? Manual's raw controls and the advanced campaign/
            completion tooling come after that decision, not before it. */}
        <RewriteReadinessGate readiness={readiness} />
        <RewriteStrategySelector
          strategyId={strategyId}
          settings={strategySettings}
          authorInstructions={authorInstructions}
          onStrategyChange={(nextStrategyId) => {
            setStrategyId(nextStrategyId);
            setStrategySettings(rewriteStrategies[nextStrategyId].settings);
          }}
          onSettingsChange={setStrategySettings}
          onAuthorInstructionsChange={setAuthorInstructions}
        />
        <GuidedRewriteRun
          bookId={bookId}
          mode={workflowMode}
          workflow={workflowState}
          readiness={readiness}
          hasPlan={hasPlan}
          queue={queue}
          touchedChapters={rewriteCoverage.filter((chapter) => chapter.rewrittenParagraphs > 0).length}
          totalChapters={rewriteCoverage.filter((chapter) => chapter.totalParagraphs > 0).length}
          untouchedParagraphCount={untouchedParagraphCount}
          pendingDraftParagraphCount={pendingDraftParagraphCount}
          acceptedParagraphCount={acceptedParagraphCount}
          latestJobId={latestJob?.id || null}
          latestDriftReport={latestDriftReport}
          loading={loading}
          campaignLoading={campaignLoading}
          onChooseWizard={() => chooseWorkflowMode("wizard")}
          onChooseManual={() => chooseWorkflowMode("manual")}
          onRunSample={() => executeRewriteWith({ maxUnits: Math.min(25, Math.max(10, suggestedBatchSize)), distributeAcrossChapters: true })}
          onCreateStrategyCampaign={() => createCampaign("full_coverage")}
          onRunNextBatch={() => executeRewriteWith({ maxUnits: suggestedBatchSize, distributeAcrossChapters: true })}
          onRunDriftCheck={() => runCampaignDriftCheck(latestJob?.id || null)}
          onRecordOverride={(override) =>
            saveWorkflow({
              metadata: {
                overrideLog: [
                  ...arrayValue(workflowState.metadata?.overrideLog),
                  {
                    ...override,
                    createdAt: new Date().toISOString(),
                  },
                ],
              },
            })
          }
        />

        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>Manual Controls</Title>
            <Text c="dimmed">
              The rewrite executor will process the book in coherent units and save every result as revision history.
            </Text>
          </div>
          <Button color="grape" disabled={!hasPlan || loading || eligibleParagraphCount === 0} loading={loading} onClick={executeRewrite}>
            {eligibleParagraphCount > 0
              ? // This button only processes one maxUnits-sized batch per click
                // (default 25) -- with no counter, a user could easily believe a
                // single click rewrites the whole book. Mirror "Generate Planned
                // Draft (3 of 6)"'s self-documenting label so partial coverage
                // is visible up front, not just discoverable after the fact.
                <span suppressHydrationWarning>
                  {`Execute Rewrite (${Math.min(Number(maxUnits || eligibleParagraphCount), eligibleParagraphCount).toLocaleString()} of ${eligibleParagraphCount.toLocaleString()})`}
                </span>
              : "Execute Rewrite"}
          </Button>
          <Button component={Link} href={`/books/${bookId}/revisions`} color="teal" variant="light">
            Review Draft Revisions
          </Button>
        </Group>
        <AiJobQueueInlineStatus job={queue} visible={loading} />

        <Alert color={hasPlan ? "blue" : "yellow"}>
          {hasPlan
            ? "Execution creates draft revision versions. By default, BookForge skips paragraphs that already have pending or accepted rewrite work."
            : "Generate a rewrite plan before execution can be enabled."}
        </Alert>
        {latestJob && (
          <Alert color="grape">
            Latest rewrite job: {latestJob.status || "unknown"} · created{" "}
            <span suppressHydrationWarning>{new Date(latestJob.created_at).toLocaleString()}</span>
            {typeof latestJob.settings?.rewritten === "number" ? ` · ${latestJob.settings.rewritten} rewritten` : ""}
          </Alert>
        )}
        <RewriteCoverageSummary
          coverage={rewriteCoverage}
          disabled={!hasPlan || loading}
          loadingChapterId={chapterLoading}
          onRewriteChapter={(chapterId) => executeRewriteWith({ chapterId })}
        />
        {message && <Alert color="green">{message}</Alert>}
        {error && (isInsufficientCreditsMessage(error) ? <InsufficientCreditsAlert message={error} /> : <Alert color="red">{error}</Alert>)}

        <NumberInput
          label="Draft rewrite batch size"
          description="How many eligible manuscript paragraphs BookForge should rewrite in this run. Eligible means untouched unless you enable the override options below."
          value={maxUnits}
          min={1}
          max={Math.max(1, eligibleParagraphCount || paragraphCount)}
          onChange={(value) => setMaxUnits(value === "" ? "" : Number(value || 25))}
        />
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          <Paper withBorder radius="md" p="md" bg="gray.0">
            <Text fw={800}><span suppressHydrationWarning>{untouchedParagraphCount.toLocaleString()}</span></Text>
            <Text size="sm" c="dimmed">
              untouched paragraphs ready for the next batch
            </Text>
          </Paper>
          <Paper withBorder radius="md" p="md" bg="gray.0">
            <Text fw={800}><span suppressHydrationWarning>{pendingDraftParagraphCount.toLocaleString()}</span></Text>
            <Text size="sm" c="dimmed">
              paragraphs with pending drafts
            </Text>
          </Paper>
          <Paper withBorder radius="md" p="md" bg="gray.0">
            <Text fw={800}><span suppressHydrationWarning>{acceptedParagraphCount.toLocaleString()}</span></Text>
            <Text size="sm" c="dimmed">
              paragraphs already accepted
            </Text>
          </Paper>
        </SimpleGrid>
        <Group>
          <Checkbox
            checked={rewriteExistingDrafts}
            onChange={(event) => setRewriteExistingDrafts(event.currentTarget.checked)}
            label="Also rewrite paragraphs with pending drafts"
          />
          <Checkbox
            checked={rewriteAccepted}
            onChange={(event) => setRewriteAccepted(event.currentTarget.checked)}
            label="Also rewrite accepted paragraphs"
          />
          <Checkbox
            checked={distributeAcrossChapters}
            onChange={(event) => setDistributeAcrossChapters(event.currentTarget.checked)}
            label="Spread this batch across chapters"
          />
        </Group>
        <Alert color={distributeAcrossChapters ? "blue" : "gray"} variant="light">
          {distributeAcrossChapters
            ? "Spread mode samples eligible paragraphs across chapters in round-robin order. This gives earlier whole-book coverage for suggestions and review."
            : "Linear mode continues from the earliest eligible paragraph. Large chapters can consume several batches before later chapters appear."}
        </Alert>
        {eligibleParagraphCount === 0 && (
          <Alert color="green">
            No untouched rewrite units remain with the current settings. Review pending drafts, export accepted revisions,
            or enable an override if you intentionally want another pass.
          </Alert>
        )}
        <Group justify="space-between" align="center">
          <Text size="sm" c="dimmed">
            Suggested batch size: <strong>{suggestedBatchSize}</strong> paragraph(s). This keeps local rewrites reviewable while the model proves consistency.
          </Text>
          <Button size="xs" variant="subtle" color="teal" onClick={() => setMaxUnits(suggestedBatchSize)}>
            Use Suggested
          </Button>
          <Button
            component={Link}
            href={`/books/${bookId}/revisions?job=${latestJob?.id || "latest"}`}
            size="xs"
            variant="subtle"
            color="grape"
            disabled={!latestJob}
          >
            Review Latest Run
          </Button>
        </Group>
        {queue.status !== "idle" && (
          <AiJobQueue
            job={queue}
            onPause={() => setQueue((current) => ({ ...current, status: "paused" }))}
            onResume={() => setQueue((current) => ({ ...current, status: "running" }))}
            onCancel={() => setQueue((current) => ({ ...current, status: "cancelled" }))}
            onRetryFailed={executeRewrite}
          />
        )}

        <PersistentRewriteCampaignPanel
          bookId={bookId}
          campaign={activeCampaign}
          stats={campaignStats}
          suggestedBatchSize={suggestedBatchSize}
          loading={loading}
          campaignLoading={campaignLoading}
          hasPlan={hasPlan}
          jobs={campaignJobs}
          latestDriftReport={latestDriftReport}
          onCreateSamplingCampaign={() => createCampaign("sample_all_chapters")}
          onCreateFullCoverageCampaign={() => createCampaign("full_coverage")}
          onPause={() => updateCampaign("pause")}
          onResume={() => updateCampaign("resume")}
          onCancel={() => updateCampaign("cancel")}
          onComplete={() => updateCampaign("complete")}
          onRunDriftCheck={(jobId) => runCampaignDriftCheck(jobId)}
          onRunNextBatch={(campaign) =>
            executeRewriteWith({
              campaignId: campaign.id,
              maxUnits: campaign.batch_size || suggestedBatchSize,
              distributeAcrossChapters: campaign.distribute_across_chapters,
              coverageMode: campaign.goal === "sample_all_chapters" ? "uncovered_chapter_sample" : "normal",
              strategyId: normalizeCampaignStrategyId(campaign.strategy_id),
              strategySettings: normalizeCampaignStrategySettings(campaign.strategy_settings),
              authorInstructions: campaign.author_instructions || "",
              rewriteExistingDrafts: campaign.rewrite_existing_drafts,
              rewriteAccepted: campaign.rewrite_accepted,
            })
          }
        />
        <RewriteCompletionControls
          coverage={rewriteCoverage}
          eligibleParagraphCount={eligibleParagraphCount}
          pendingDraftParagraphCount={pendingDraftParagraphCount}
          acceptedParagraphCount={acceptedParagraphCount}
          untouchedParagraphCount={untouchedParagraphCount}
          suggestedBatchSize={suggestedBatchSize}
          loading={loading}
          hasPlan={hasPlan}
          onRunSafeBatch={() => executeRewriteWith({ maxUnits: suggestedBatchSize, distributeAcrossChapters: true })}
          onRunChapterSamples={() =>
            executeRewriteWith({
              maxUnits: Math.max(1, rewriteCoverage.filter((chapter) => chapter.totalParagraphs > 0 && chapter.rewrittenParagraphs === 0).length),
              distributeAcrossChapters: true,
              coverageMode: "uncovered_chapter_sample",
            })
          }
          onRunFullChapterSamples={() =>
            executeRewriteWith({
              maxUnits: Math.max(1, rewriteCoverage.filter((chapter) => chapter.totalParagraphs > 0 && chapter.rewrittenParagraphs === 0).length),
              distributeAcrossChapters: true,
              coverageMode: "uncovered_chapter_sample",
            })
          }
          onRunFullCoverage={() =>
            executeRewriteWith({
              maxUnits: eligibleParagraphCount,
              distributeAcrossChapters: true,
            })
          }
          onPrepareFullCoverage={() => {
            setDistributeAcrossChapters(true);
            setMaxUnits(suggestedBatchSize);
          }}
        />

        <div>
          <Text fw={800} mb="xs">
            Rewrite output format
          </Text>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>Primary output: revision versions saved per chapter/scene/paragraph.</li>
            <li>The original manuscript is never overwritten.</li>
            <li>The author accepts, rejects, or reruns each revision batch.</li>
            <li>After acceptance, the Final Manuscript Builder exports DOCX, Markdown, EPUB, and PDF.</li>
            <li>EPUB is an export target, not the raw rewrite output.</li>
          </ul>
        </div>
      </Stack>
    </Paper>
  );
}

function RewriteCompletionControls({
  coverage,
  eligibleParagraphCount,
  pendingDraftParagraphCount,
  acceptedParagraphCount,
  untouchedParagraphCount,
  suggestedBatchSize,
  loading,
  hasPlan,
  onRunSafeBatch,
  onRunChapterSamples,
  onRunFullChapterSamples,
  onRunFullCoverage,
  onPrepareFullCoverage,
}: {
  coverage: Array<{
    chapterId: string;
    chapterNumber: number;
    title: string | null;
    totalParagraphs: number;
    rewrittenParagraphs: number;
  }>;
  eligibleParagraphCount: number;
  pendingDraftParagraphCount: number;
  acceptedParagraphCount: number;
  untouchedParagraphCount: number;
  suggestedBatchSize: number;
  loading: boolean;
  hasPlan: boolean;
  onRunSafeBatch: () => void;
  onRunChapterSamples: () => void;
  onRunFullChapterSamples: () => void;
  onRunFullCoverage: () => void;
  onPrepareFullCoverage: () => void;
}) {
  const chaptersNeedingSample = coverage.filter((chapter) => chapter.totalParagraphs > 0 && chapter.rewrittenParagraphs === 0);
  const fullyCoveredChapters = coverage.filter(
    (chapter) => chapter.totalParagraphs > 0 && chapter.rewrittenParagraphs >= chapter.totalParagraphs,
  ).length;
  const sampledChapters = coverage.filter((chapter) => chapter.rewrittenParagraphs > 0).length;
  const totalChaptersWithText = coverage.filter((chapter) => chapter.totalParagraphs > 0).length;
  const remainingParagraphs = coverage.reduce(
    (sum, chapter) => sum + Math.max(0, chapter.totalParagraphs - chapter.rewrittenParagraphs),
    0,
  );
  const estimatedBatches = suggestedBatchSize ? Math.ceil(Math.max(0, eligibleParagraphCount) / suggestedBatchSize) : 0;
  const campaignPercent = eligibleParagraphCount + pendingDraftParagraphCount + acceptedParagraphCount
    ? Math.round(((pendingDraftParagraphCount + acceptedParagraphCount) / (eligibleParagraphCount + pendingDraftParagraphCount + acceptedParagraphCount)) * 100)
    : 0;
  const guidance = getCampaignGuidance({
    hasPlan,
    eligibleParagraphCount,
    chaptersNeedingSample: chaptersNeedingSample.length,
    pendingDraftParagraphCount,
    acceptedParagraphCount,
  });

  return (
    <Paper withBorder radius="md" p="md" bg="#fffdf8">
      <Stack>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={900}>Rewrite Campaign</Text>
          <Text size="sm" c="dimmed">
            <span suppressHydrationWarning>{remainingParagraphs.toLocaleString()}</span> paragraphs still have no rewrite draft. Estimated safe batches: {estimatedBatches}.
          </Text>
          <Text size="sm" c="dimmed">
            {sampledChapters}/{totalChaptersWithText} chapters sampled. {fullyCoveredChapters}/{totalChaptersWithText} chapters fully covered.
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Safe full coverage means repeating spread batches. Each run creates a persistent AI job and saved revision versions.
          </Text>
        </div>
        <Group>
          <Button color="teal" variant="light" loading={loading} disabled={!hasPlan || eligibleParagraphCount === 0} onClick={onRunSafeBatch}>
            Continue next safe batch
          </Button>
          <Button color="grape" variant="light" loading={loading} disabled={!hasPlan || chaptersNeedingSample.length === 0} onClick={onRunChapterSamples}>
            Sample untouched chapters
          </Button>
          <Button color="dark" variant="subtle" disabled={!hasPlan || eligibleParagraphCount === 0} onClick={onPrepareFullCoverage}>
            Set full-coverage pace
          </Button>
        </Group>
      </Group>
      <Progress value={campaignPercent} color="grape" radius="xl" />
      <SimpleGrid cols={{ base: 1, md: 4 }}>
        <CampaignMetric label="Untouched" value={untouchedParagraphCount} />
        <CampaignMetric label="Needs review" value={pendingDraftParagraphCount} />
        <CampaignMetric label="Accepted" value={acceptedParagraphCount} />
        <CampaignMetric label="Batches left" value={estimatedBatches} />
      </SimpleGrid>
      <Alert color={guidance.color} variant="light">
        <Text fw={800}>{guidance.title}</Text>
        <Text size="sm">{guidance.description}</Text>
      </Alert>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Button color="grape" variant="outline" loading={loading} disabled={!hasPlan || chaptersNeedingSample.length === 0} onClick={onRunFullChapterSamples}>
          Run until every chapter has a sample
        </Button>
        <Button color="dark" loading={loading} disabled={!hasPlan || eligibleParagraphCount === 0} onClick={onRunFullCoverage}>
          Run full coverage in safe spread order
        </Button>
      </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function PersistentRewriteCampaignPanel({
  bookId,
  campaign,
  stats,
  suggestedBatchSize,
  loading,
  campaignLoading,
  hasPlan,
  jobs,
  latestDriftReport,
  onCreateSamplingCampaign,
  onCreateFullCoverageCampaign,
  onPause,
  onResume,
  onCancel,
  onComplete,
  onRunDriftCheck,
  onRunNextBatch,
}: {
  bookId: string;
  campaign: RewriteCampaignRow | null;
  stats: RewriteCampaignStats;
  suggestedBatchSize: number;
  loading: boolean;
  campaignLoading: string | null;
  hasPlan: boolean;
  jobs: CampaignJob[];
  latestDriftReport: { id?: string; content: Record<string, unknown> | null; created_at: string } | null;
  onCreateSamplingCampaign: () => void;
  onCreateFullCoverageCampaign: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onComplete: () => void;
  onRunDriftCheck: (jobId: string | null) => void;
  onRunNextBatch: (campaign: RewriteCampaignRow) => void;
}) {
  const draftedParagraphs = stats.pendingDraftParagraphs + stats.acceptedParagraphs;
  const draftPercent = stats.totalParagraphs ? Math.round((draftedParagraphs / stats.totalParagraphs) * 100) : 0;
  const estimatedBatches = suggestedBatchSize ? Math.ceil(stats.untouchedParagraphs / suggestedBatchSize) : 0;
  const health = getCampaignHealth({ campaign, stats, jobs, latestDriftReport, suggestedBatchSize });
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  if (!campaign) {
    return (
      <Paper withBorder radius="md" p="lg" bg="#f8fbff">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={900}>Persistent Rewrite Campaign</Text>
            <Text size="sm" c="dimmed">
              Create a named campaign when you want BookForge to remember the rewrite goal, batch pace, and coverage progress across sessions.
            </Text>
          </div>
          <Group>
            <Button
              color="grape"
              variant="light"
              disabled={!hasPlan}
              loading={campaignLoading === "create:sample_all_chapters"}
              onClick={onCreateSamplingCampaign}
            >
              Create sampling campaign
            </Button>
            <Button
              color="dark"
              disabled={!hasPlan}
              loading={campaignLoading === "create:full_coverage"}
              onClick={onCreateFullCoverageCampaign}
            >
              Create full coverage campaign
            </Button>
          </Group>
        </Group>
      </Paper>
    );
  }

  const isPaused = campaign.status === "paused";
  const isTerminal = ["completed", "cancelled"].includes(campaign.status);
  const goalLabel = campaign.goal === "sample_all_chapters" ? "Sample every chapter" : campaign.goal === "full_coverage" ? "Full draft coverage" : "Custom";
  const lastJob = jobs[0] || null;

  return (
    <Paper withBorder radius="md" p="lg" bg="#f8fbff">
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={900}>{campaign.name}</Text>
            <Text size="sm" c="dimmed">
              {goalLabel} · {campaign.batches_run} batch{campaign.batches_run === 1 ? "" : "es"} run · batch size {campaign.batch_size}
            </Text>
            <Text size="xs" c="dimmed">
              Last updated <span suppressHydrationWarning>{new Date(campaign.updated_at).toLocaleString()}</span>
            </Text>
          </div>
          <Badge color={campaignStatusColor(campaign.status)} variant="light">
            {campaign.status}
          </Badge>
        </Group>

        <Progress value={draftPercent} color="grape" radius="xl" />
        <SimpleGrid cols={{ base: 1, md: 4 }}>
          <CampaignMetric label="Draft coverage" value={draftedParagraphs} />
          <CampaignMetric label="Untouched" value={stats.untouchedParagraphs} />
          <CampaignMetric label="Chapters sampled" value={stats.sampledChapters} />
          <CampaignMetric label="Batches left" value={estimatedBatches} />
        </SimpleGrid>

        <CampaignHealthPanel health={health} latestDriftReport={latestDriftReport} />

        <Alert color={isPaused ? "yellow" : isTerminal ? "gray" : "blue"} variant="light">
          {campaign.status === "paused"
            ? "Campaign is paused. Resume it before running the next batch."
            : campaign.status === "completed"
              ? "Campaign is complete. Review drafts, run Critic again, and export accepted revisions."
              : "Run the next campaign batch when you are ready. Each batch is still a bounded LM Studio job with persistent progress."}
        </Alert>

        <Group>
          <Button
            color="grape"
            disabled={!hasPlan || loading || isPaused || isTerminal || stats.untouchedParagraphs === 0 || health.shouldPause}
            loading={loading}
            onClick={() => onRunNextBatch(campaign)}
          >
            Run guarded next batch
          </Button>
          <Button
            color="grape"
            variant="light"
            disabled={!lastJob}
            loading={campaignLoading === "drift"}
            onClick={() => onRunDriftCheck(lastJob?.id || null)}
          >
            Run drift check
          </Button>
          <Button color="yellow" variant="light" disabled={campaign.status !== "active"} loading={campaignLoading === "pause"} onClick={onPause}>
            Pause campaign
          </Button>
          <Button color="green" variant="light" disabled={!isPaused} loading={campaignLoading === "resume"} onClick={onResume}>
            Resume campaign
          </Button>
          <Button
            color="red"
            variant="outline"
            disabled={isTerminal}
            loading={campaignLoading === "cancel"}
            onClick={() => setConfirmCancelOpen(true)}
          >
            Cancel campaign
          </Button>
          <Button color="dark" variant="subtle" disabled={isTerminal} loading={campaignLoading === "complete"} onClick={onComplete}>
            Mark complete
          </Button>
          <Modal opened={confirmCancelOpen} onClose={() => setConfirmCancelOpen(false)} title="Cancel this campaign?" centered>
            <Stack>
              <Text size="sm">
                This stops the campaign for good, including any batch currently running -- you&apos;d need to create a
                new campaign to keep going. Progress already drafted and accepted stays saved.
              </Text>
              <Group justify="flex-end">
                <Button variant="subtle" color="dark" onClick={() => setConfirmCancelOpen(false)}>
                  Keep it running
                </Button>
                <Button
                  color="red"
                  loading={campaignLoading === "cancel"}
                  onClick={() => {
                    setConfirmCancelOpen(false);
                    onCancel();
                  }}
                >
                  Cancel campaign
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Group>
        <CampaignBatchHistory bookId={bookId} jobs={jobs} />
      </Stack>
    </Paper>
  );
}

function CampaignHealthPanel({
  health,
  latestDriftReport,
}: {
  health: CampaignHealth;
  latestDriftReport: { id?: string; content: Record<string, unknown> | null; created_at: string } | null;
}) {
  return (
    <Paper withBorder radius="md" p="md" bg="white">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Text fw={900}>Campaign Health</Text>
          <Text size="sm" c="dimmed">
            {health.recommendation}
          </Text>
          {latestDriftReport && (
            <Text size="xs" c="dimmed">
              Latest drift check:{" "}
              <span suppressHydrationWarning>{new Date(latestDriftReport.created_at).toLocaleString()}</span>
            </Text>
          )}
        </div>
        <Badge color={health.color} variant="light">
          {health.label}
        </Badge>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 4 }}>
        <HealthMetric label="Last batch" value={health.lastBatch} />
        <HealthMetric label="Error rate" value={`${health.errorRate}%`} />
        <HealthMetric label="Drift risk" value={health.driftRisk} />
        <HealthMetric label="Review load" value={`${health.pendingReviewLoad} pending`} />
      </SimpleGrid>
      {health.warnings.length > 0 && (
        <Alert color={health.color} variant="light" mt="sm">
          {health.warnings.join(" ")}
        </Alert>
      )}
    </Paper>
  );
}

function HealthMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="sm" p="sm" bg="gray.0">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={900}>{value}</Text>
    </Paper>
  );
}

function CampaignBatchHistory({ bookId, jobs }: { bookId: string; jobs: CampaignJob[] }) {
  if (!jobs.length) {
    return (
      <Alert color="gray" variant="light">
        No campaign batches have run yet.
      </Alert>
    );
  }

  return (
    <Paper withBorder radius="md" p="md" bg="white">
      <Text fw={900} mb="sm">
        Campaign Batch History
      </Text>
      <Stack gap="xs">
        {jobs.slice(0, 8).map((job, index) => {
          const progress = objectValue(job.settings?.progress);
          const rewritten = numberValue(job.settings?.rewritten) || numberValue(progress.successful);
          const skipped = numberValue(job.settings?.skipped) || numberValue(progress.skipped);
          const failed = numberValue(progress.failed);
          return (
            <Group key={job.id} justify="space-between">
              <div>
                <Text size="sm" fw={700}>
                  Batch {jobs.length - index} · <span suppressHydrationWarning>{new Date(job.created_at).toLocaleString()}</span>
                </Text>
                <Text size="xs" c="dimmed">
                  {rewritten} rewritten · {skipped} skipped · {failed} failed
                </Text>
              </div>
              <Group gap="xs">
                <Badge color={campaignStatusColor(job.status || "")} variant="light">
                  {job.status || "unknown"}
                </Badge>
                <Button component={Link} href={`/books/${bookId}/revisions?job=${job.id}`} size="xs" variant="subtle" color="grape">
                  Review
                </Button>
              </Group>
            </Group>
          );
        })}
      </Stack>
    </Paper>
  );
}

type CampaignHealth = {
  label: string;
  color: string;
  recommendation: string;
  warnings: string[];
  shouldPause: boolean;
  lastBatch: string;
  errorRate: number;
  driftRisk: string;
  pendingReviewLoad: number;
};

function getCampaignHealth({
  campaign,
  stats,
  jobs,
  latestDriftReport,
  suggestedBatchSize,
}: {
  campaign: RewriteCampaignRow | null;
  stats: RewriteCampaignStats;
  jobs: CampaignJob[];
  latestDriftReport: { id?: string; content: Record<string, unknown> | null; created_at: string } | null;
  suggestedBatchSize: number;
}): CampaignHealth {
  const lastJob = jobs[0] || null;
  const progress = objectValue(lastJob?.settings?.progress);
  const failed = numberValue(progress.failed);
  const successful = numberValue(progress.successful) || numberValue(lastJob?.settings?.rewritten);
  const skipped = numberValue(progress.skipped) || numberValue(lastJob?.settings?.skipped);
  const attempted = Math.max(numberValue(progress.attempted), successful + failed + skipped);
  const errorRate = attempted ? Math.round((failed / attempted) * 100) : 0;
  const driftRisk = stringValue(latestDriftReport?.content?.overallDriftRisk) || "not checked";
  const pendingReviewLoad = stats.pendingDraftParagraphs;
  const warnings: string[] = [];

  if (!campaign) {
    return {
      label: "not started",
      color: "gray",
      recommendation: "Create a persistent campaign before using guarded continuation.",
      warnings,
      shouldPause: false,
      lastBatch: "none",
      errorRate,
      driftRisk,
      pendingReviewLoad,
    };
  }

  if (["high", "critical"].includes(driftRisk.toLowerCase())) {
    warnings.push("High drift risk detected. Review the drift report before continuing.");
  }
  if (pendingReviewLoad >= Math.max(50, suggestedBatchSize * 2)) {
    warnings.push("The review queue is getting large. Review and accept/reject drafts before generating much more.");
  }
  if (errorRate >= 20) {
    warnings.push("The last batch had a high error rate. Check LM Studio/model status before continuing.");
  }
  if (lastJob?.status === "failed" || lastJob?.status === "cancelled") {
    warnings.push("The last campaign batch did not complete cleanly.");
  }
  if (driftRisk === "not checked" && jobs.length > 0) {
    warnings.push("Run a drift check after this campaign batch before scaling up.");
  }

  const shouldPause =
    campaign.status === "paused" ||
    ["high", "critical"].includes(driftRisk.toLowerCase()) ||
    pendingReviewLoad >= Math.max(100, suggestedBatchSize * 4) ||
    errorRate >= 35;

  if (shouldPause) {
    return {
      label: "pause recommended",
      color: "yellow",
      recommendation: "Review quality signals before continuing this campaign.",
      warnings,
      shouldPause,
      lastBatch: lastJob ? `${successful} rewritten` : "none",
      errorRate,
      driftRisk,
      pendingReviewLoad,
    };
  }

  if (stats.untouchedParagraphs <= 0) {
    return {
      label: "coverage complete",
      color: "green",
      recommendation: "Draft coverage is complete. Move to review, Critic rerun, and final manuscript assembly.",
      warnings,
      shouldPause: false,
      lastBatch: lastJob ? `${successful} rewritten` : "none",
      errorRate,
      driftRisk,
      pendingReviewLoad,
    };
  }

  return {
    label: "healthy",
    color: "blue",
    recommendation: "The campaign can continue in safe spread batches.",
    warnings,
    shouldPause: false,
    lastBatch: lastJob ? `${successful} rewritten` : "none",
    errorRate,
    driftRisk,
    pendingReviewLoad,
  };
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function CampaignMetric({ label, value }: { label: string; value: number | string }) {
  const displayValue = typeof value === "number" ? value.toLocaleString() : value;
  return (
    <Paper withBorder radius="sm" p="sm" bg="white">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={900} suppressHydrationWarning>{displayValue}</Text>
    </Paper>
  );
}

function RewriteReadinessGate({ readiness }: { readiness: RewriteReadiness }) {
  // Show what's actually driving the overall status, not a fixed first-4
  // slice of an 11-item list -- otherwise the badge can read "Blocked"
  // while every card visible on screen says "Ready", and the real
  // blockers show up nowhere except unlinked text further down.
  const attentionItems = readiness.items.filter((item) => item.status !== "ready").slice(0, 6);

  return (
    <Paper withBorder radius="md" p="lg" bg="#fffdf8">
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Rewrite Readiness Gate</Title>
            <Text size="sm" c="dimmed">
              {readiness.headline}
            </Text>
          </div>
          <Badge color={readinessColor(readiness.overallStatus)} size="lg" variant="light">
            {readinessLabel(readiness.overallStatus)}
          </Badge>
        </Group>

        {attentionItems.length === 0 ? (
          <Alert color="green" variant="light">
            Every readiness check has passed.
            {readiness.skippedCount > 0 &&
              ` (${readiness.skippedCount} short paragraph(s) -- dialogue lines/fragments under 8 words, or locked/excluded -- are intentionally not included in rewrite passes and don't count toward this.)`}
          </Alert>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {attentionItems.map((item) => (
              <Paper key={item.key} withBorder radius="sm" p="sm" bg="white">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Box style={{ minWidth: 0 }}>
                    <Group gap="xs">
                      <Text fw={900} size="sm">
                        {item.label}
                      </Text>
                      <Badge color={readinessColor(item.status)} variant="light" size="xs">
                        {readinessLabel(item.status)}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>
                      {item.detail}
                    </Text>
                  </Box>
                  {item.actionLabel && item.href && (
                    <Button
                      component={Link}
                      href={item.href}
                      size="compact-xs"
                      variant="light"
                      color="grape"
                      style={{ flexShrink: 0 }}
                    >
                      {item.actionLabel}
                    </Button>
                  )}
                </Group>
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Paper>
  );
}

function readinessColor(status: RewriteReadinessStatus) {
  if (status === "ready") return "green";
  if (status === "recommended") return "yellow";
  if (status === "blocked") return "red";
  return "gray";
}

function readinessLabel(status: RewriteReadinessStatus) {
  if (status === "ready") return "Ready";
  if (status === "recommended") return "Recommended";
  if (status === "blocked") return "Blocked";
  return "Optional";
}

function hasStepBlockers(readiness: RewriteReadiness, step: number) {
  return (readiness.stepBlockers[step] || []).length > 0;
}

function campaignStatusColor(status: string) {
  if (status === "completed") return "green";
  if (status === "running") return "grape";
  if (status === "paused") return "yellow";
  if (status === "failed") return "orange";
  if (status === "cancelled") return "red";
  return "blue";
}

function normalizeCampaignStrategyId(value: string): RewriteStrategyId {
  return value in rewriteStrategies ? (value as RewriteStrategyId) : "humanized_literary";
}

function normalizeCampaignStrategySettings(value: Record<string, unknown> | null): RewriteStrategySettings {
  const fallback = rewriteStrategies.humanized_literary.settings;
  if (!value) return fallback;
  return {
    voicePreservation: numberOrFallback(value.voicePreservation, fallback.voicePreservation),
    expansionLimitPercent: numberOrFallback(value.expansionLimitPercent, fallback.expansionLimitPercent),
    sentenceRhythm: numberOrFallback(value.sentenceRhythm, fallback.sentenceRhythm),
    literaryIntensity: numberOrFallback(value.literaryIntensity, fallback.literaryIntensity),
    readabilityTarget: typeof value.readabilityTarget === "string" ? value.readabilityTarget : fallback.readabilityTarget,
    theologicalEmphasis: numberOrFallback(value.theologicalEmphasis, fallback.theologicalEmphasis),
    continuityStrictness: numberOrFallback(value.continuityStrictness, fallback.continuityStrictness),
    targetReductionPercent: numberOrFallback(value.targetReductionPercent, fallback.targetReductionPercent),
  };
}

function numberOrFallback(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getCampaignGuidance({
  hasPlan,
  eligibleParagraphCount,
  chaptersNeedingSample,
  pendingDraftParagraphCount,
  acceptedParagraphCount,
}: {
  hasPlan: boolean;
  eligibleParagraphCount: number;
  chaptersNeedingSample: number;
  pendingDraftParagraphCount: number;
  acceptedParagraphCount: number;
}) {
  if (!hasPlan) {
    return {
      color: "yellow",
      title: "Generate the Rewrite Architect plan first",
      description: "The plan gives every rewrite call the same objective, guardrails, and coherence contract.",
    };
  }
  if (chaptersNeedingSample > 0) {
    return {
      color: "grape",
      title: "Next best move: sample every untouched chapter",
      description:
        "This prevents the rewrite from over-learning early chapters before later chapters have been tested for voice, pacing, and coherence.",
    };
  }
  if (pendingDraftParagraphCount > acceptedParagraphCount && pendingDraftParagraphCount > 25) {
    return {
      color: "yellow",
      title: "Next best move: review before generating much more",
      description:
        "You already have a meaningful review queue. Accepting or rejecting drafts helps the next pass preserve the direction you actually want.",
    };
  }
  if (eligibleParagraphCount > 0) {
    return {
      color: "blue",
      title: "Next best move: continue safe spread batches",
      description:
        "All chapters have coverage. Continue in spread order so later chapters keep receiving attention while the book stays coherent.",
    };
  }
  return {
    color: "green",
    title: "Rewrite draft coverage is complete",
    description: "Review remaining drafts, run Critic again, then build the final manuscript from accepted revisions.",
  };
}

function StepNode({
  number,
  done,
  active,
  blocked,
}: {
  number: number;
  done: boolean;
  active: boolean;
  blocked: boolean;
}) {
  const background = done ? "var(--mantine-color-green-6)" : active ? "var(--mantine-color-grape-6)" : "white";
  const border = done
    ? "var(--mantine-color-green-6)"
    : active
      ? "var(--mantine-color-grape-6)"
      : blocked
        ? "var(--mantine-color-red-5)"
        : "var(--mantine-color-gray-4)";
  const textColor = done || active ? "white" : "var(--mantine-color-gray-7)";

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      {active && (
        <motion.div
          aria-hidden
          style={{ position: "absolute", inset: -5, borderRadius: 999, border: "1px solid var(--mantine-color-grape-4)" }}
          animate={{ scale: [1, 1.18, 1], opacity: [0.6, 0.1, 0.6] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <Box
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background,
          border: `2px solid ${border}`,
          color: textColor,
          fontWeight: 800,
          fontSize: 12,
        }}
      >
        {done ? "✓" : number}
      </Box>
    </Box>
  );
}

function GuidedRewriteRun({
  bookId,
  mode,
  workflow,
  readiness,
  hasPlan,
  queue,
  touchedChapters,
  totalChapters,
  untouchedParagraphCount,
  pendingDraftParagraphCount,
  acceptedParagraphCount,
  latestJobId,
  latestDriftReport,
  loading,
  campaignLoading,
  onChooseWizard,
  onChooseManual,
  onRunSample,
  onCreateStrategyCampaign,
  onRunNextBatch,
  onRunDriftCheck,
  onRecordOverride,
}: {
  bookId: string;
  mode: RewriteWorkflowMode;
  workflow: RewriteWorkflowRow;
  readiness: RewriteReadiness;
  hasPlan: boolean;
  queue: AiJobQueueState;
  touchedChapters: number;
  totalChapters: number;
  untouchedParagraphCount: number;
  pendingDraftParagraphCount: number;
  acceptedParagraphCount: number;
  latestJobId: string | null;
  latestDriftReport: { id?: string; content: Record<string, unknown> | null; created_at: string } | null;
  loading: boolean;
  campaignLoading: string | null;
  onChooseWizard: () => void;
  onChooseManual: () => void;
  onRunSample: () => void;
  onCreateStrategyCampaign: () => void;
  onRunNextBatch: () => void;
  onRunDriftCheck: () => void;
  onRecordOverride: (override: { step: number; label: string; reason: string; blockers: string[] }) => Promise<unknown>;
}) {
  const [overrideReasons, setOverrideReasons] = useState<Record<number, string>>({});
  const [activeOverrides, setActiveOverrides] = useState<Record<number, boolean>>({});
  const [overrideSaving, setOverrideSaving] = useState<number | null>(null);
  const [overrideError, setOverrideError] = useState("");
  const fullDraftCoverage = untouchedParagraphCount === 0 && totalChapters > 0;
  const hasReviewedWork = acceptedParagraphCount > 0;
  const step2Blocked = hasStepBlockers(readiness, 2) && !activeOverrides[2];
  const step4Blocked = hasStepBlockers(readiness, 4) && !activeOverrides[4];
  const step5Blocked = hasStepBlockers(readiness, 5) && !activeOverrides[5];
  const step6Blocked = hasStepBlockers(readiness, 6) && !activeOverrides[6];
  const step7Blocked = hasStepBlockers(readiness, 7) && !activeOverrides[7];
  async function activateOverride(step: number, label: string) {
    const reason = (overrideReasons[step] || "").trim();
    if (reason.length < 8) {
      setOverrideError("Override reason must be at least 8 characters.");
      return;
    }
    setOverrideSaving(step);
    setOverrideError("");
    try {
      await onRecordOverride({
        step,
        label,
        reason,
        blockers: readiness.stepBlockers[step] || [],
      });
      setActiveOverrides((current) => ({ ...current, [step]: true }));
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : "Unable to save override.");
    } finally {
      setOverrideSaving(null);
    }
  }

  const steps = [
    {
      label: "Prepare",
      done: hasPlan,
      detail: "Blueprint, summaries, Critic, and Rewrite Architect plan.",
      readiness: readiness.stepStatus[1],
      action: hasPlan ? null : (
        <Button component="a" href="#planning-gate" size="xs" variant="light" color="yellow">
          Go to Planning Gate
        </Button>
      ),
    },
    {
      label: "Run sample batch",
      done: touchedChapters > 0,
      detail: "Rewrites a small sample (10-25 paragraphs) scattered across your whole book, so you can preview the strategy before committing to a full pass.",
      readiness: readiness.stepStatus[2],
      action: (
        <Button size="xs" color="grape" loading={loading} disabled={step2Blocked || !hasPlan || loading} onClick={onRunSample}>
          Run Sample Batch
        </Button>
      ),
    },
    {
      label: "Review sample",
      done: hasReviewedWork,
      detail: "Accept, reject, or reset if the direction is wrong.",
      readiness: readiness.stepStatus[3],
      action: latestJobId ? (
        <Button component={Link} href={`/books/${bookId}/revisions?job=${latestJobId}`} size="xs" variant="light" color="teal">
          Review Drafts
        </Button>
      ) : null,
    },
    {
      label: "Approve strategy",
      done: workflow.strategy_approved || Boolean(workflow.campaign_id),
      detail: "Keep the same preset/settings once the voice feels right.",
      readiness: readiness.stepStatus[4],
      action: (
        <Button size="xs" variant="light" color="dark" disabled={step4Blocked || !hasPlan} loading={campaignLoading === "create:full_coverage"} onClick={onCreateStrategyCampaign}>
          Save as Campaign
        </Button>
      ),
    },
    {
      label: "Run full spread batches",
      done: fullDraftCoverage,
      detail: "Continue spread batches until every chapter has coverage.",
      readiness: readiness.stepStatus[5],
      action: (
        <Button size="xs" color="dark" loading={loading} disabled={step5Blocked || !hasPlan || loading || untouchedParagraphCount === 0} onClick={onRunNextBatch}>
          Run Next Batch
        </Button>
      ),
    },
    {
      label: "Run Critic again",
      done: Boolean(latestDriftReport) || workflow.post_critic_completed || Boolean(workflow.last_drift_report_id),
      detail: "Use post-rewrite Critic, drift check, and humanized guidance.",
      readiness: readiness.stepStatus[6],
      action: (
        <Group gap="xs">
          <Button size="xs" variant="light" color="grape" disabled={step6Blocked || !latestJobId} loading={campaignLoading === "drift"} onClick={onRunDriftCheck}>
            Drift Check
          </Button>
          <Button component={Link} href={`/books/${bookId}`} size="xs" variant="subtle" color="grape">
            Open Critic
          </Button>
        </Group>
      ),
    },
    {
      label: "Export",
      done: workflow.export_ready,
      detail: "Build DOCX, Markdown, EPUB, or PDF from accepted revisions.",
      readiness: readiness.stepStatus[7],
      action: (
        <Button component={Link} href={`/books/${bookId}/final-manuscript`} size="xs" variant="light" color="green" disabled={step7Blocked}>
          Final Builder
        </Button>
      ),
    },
  ];

  const detectedActiveIndex = Math.max(0, steps.findIndex((step) => !step.done));
  const activeIndex = mode === "wizard" ? Math.max(0, Math.min(6, workflow.current_step - 1, detectedActiveIndex)) : detectedActiveIndex;

  return (
    <Paper id="guided-rewrite-run" withBorder radius="md" p="lg" bg="#fbfaf8">
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Guided Rewrite Run</Title>
            <Text size="sm" c="dimmed">
              A rookie-safe workflow that turns the rewrite into small checkpoints. Veteran users can stay with the manual controls below.
            </Text>
          </div>
          <Badge color={mode === "wizard" ? "grape" : mode === "manual" ? "dark" : "gray"} variant="light">
            {mode === "wizard" ? "Wizard mode" : mode === "manual" ? "Manual mode" : "Choose a path"}
          </Badge>
        </Group>

        {mode === "chooser" && (
          <Alert color="grape" variant="light">
            <Group justify="space-between" align="center">
              <div>
                <Text fw={900}>How do you want to run the rewrite?</Text>
                <Text size="sm">
                  Use the wizard if you want BookForge to guide you from preparation to export. Choose manual if you already know the controls.
                </Text>
              </div>
              <Group>
                <Button color="grape" onClick={onChooseWizard}>
                  Use Guided Wizard
                </Button>
                <Button color="dark" variant="light" onClick={onChooseManual}>
                  Use Manual Controls
                </Button>
              </Group>
            </Group>
          </Alert>
        )}

        {mode === "manual" && (
          <Alert color="gray" variant="light">
            Manual controls are active below. You can still use the workflow map as a reference, but BookForge will not steer each step.
          </Alert>
        )}

        {mode === "wizard" && (
          <Alert color={hasPlan ? "blue" : "yellow"} variant="light">
            <Text fw={900}>
              Current checkpoint: Step {activeIndex + 1}, {steps[activeIndex]?.label || "Complete"}
            </Text>
            <Text size="sm">
              {steps[activeIndex]?.detail || "Review drafts, run the final checks, and export the accepted manuscript."}
            </Text>
            {workflow.updated_at && (
              <Text size="xs" c="dimmed" mt={4}>
                Saved workflow updated <span suppressHydrationWarning>{new Date(workflow.updated_at).toLocaleString()}</span>.
              </Text>
            )}
          </Alert>
        )}
        {overrideError && <Alert color="red">{overrideError}</Alert>}

        {queue.status !== "idle" && (
          <Alert color={queue.status !== "running" && queue.status !== "paused" && queue.successfulUnits === 0 && queue.failedUnits > 0 ? "red" : "grape"} variant="light">
            <Group justify="space-between" mb={4}>
              <Text fw={800} size="sm">
                {queue.status === "running"
                  ? "Working: "
                  : queue.status === "paused"
                    ? "Paused: "
                    : queue.successfulUnits === 0 && queue.failedUnits > 0
                      ? "Failed: "
                      : queue.failedUnits > 0
                        ? `Finished with ${queue.failedUnits} failure(s): `
                        : queue.status === "cancelled"
                          ? "Cancelled: "
                          : "Done: "}
                {queue.currentTask || "Rewrite batch"}
              </Text>
              <Text size="xs" c="dimmed">
                {queue.completedUnits}/{queue.totalUnits}
              </Text>
            </Group>
            <Progress
              value={queue.totalUnits ? (queue.completedUnits / queue.totalUnits) * 100 : 0}
              animated={queue.status === "running"}
              color="grape"
            />
          </Alert>
        )}

        <Stack gap={0}>
          {steps.map((step, index) => {
            const active = mode === "wizard" && index === activeIndex;
            const stepNumber = index + 1;
            const blockers = readiness.stepBlockers[stepNumber] || [];
            const overrideActive = Boolean(activeOverrides[stepNumber]);
            const isLast = index === steps.length - 1;
            return (
              <Group key={step.label} align="stretch" gap="sm" wrap="nowrap">
                <Stack gap={0} align="center" style={{ width: 28, flexShrink: 0 }}>
                  <StepNode
                    number={stepNumber}
                    done={step.done}
                    active={active}
                    blocked={!step.done && step.readiness === "blocked"}
                  />
                  {!isLast && (
                    <Box
                      style={{
                        width: 2,
                        flex: 1,
                        minHeight: 16,
                        margin: "2px 0",
                        background: step.done ? "var(--mantine-color-green-4)" : "var(--mantine-color-gray-3)",
                      }}
                    />
                  )}
                </Stack>
                <Paper
                  withBorder
                  radius="md"
                  p="md"
                  mb="sm"
                  bg={step.done ? "#eefbf4" : active ? "#f3ecff" : "white"}
                  style={{ borderColor: active ? "#9c36b5" : undefined, flex: 1 }}
                >
                  <Stack gap="xs">
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={800}>
                          Step {index + 1}
                        </Text>
                        <Text fw={900}>{step.label}</Text>
                      </div>
                      <Badge color={step.done ? "green" : readinessColor(step.readiness)} variant="light">
                        {step.done ? "Done" : readinessLabel(step.readiness)}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {step.detail}
                    </Text>
                    {step.action}
                    {mode === "wizard" && overrideActive && (
                      <Badge color="orange" variant="light" w="fit-content">
                        Override active
                      </Badge>
                    )}
                    {mode === "wizard" && !step.done && blockers.length > 0 && (
                      <Alert color={overrideActive ? "orange" : "red"} variant="light" p="xs">
                        <Text size="xs" fw={800}>
                          {overrideActive ? "Override recorded for:" : "Blocked because:"}
                        </Text>
                        {blockers.slice(0, 2).map((reason) => (
                          <Text key={reason} size="xs">
                            {reason}
                          </Text>
                        ))}
                        {!overrideActive && stepNumber > 1 && (
                          <Stack gap={6} mt="xs">
                            <Checkbox
                              size="xs"
                              label="Advanced override"
                              checked={overrideReasons[stepNumber] !== undefined}
                              onChange={(event) =>
                                setOverrideReasons((current) => {
                                  const next = { ...current };
                                  if (event.currentTarget.checked) next[stepNumber] = "";
                                  else delete next[stepNumber];
                                  return next;
                                })
                              }
                            />
                            {overrideReasons[stepNumber] !== undefined && (
                              <>
                                <Textarea
                                  size="xs"
                                  minRows={2}
                                  placeholder="Why are you intentionally bypassing this gate?"
                                  value={overrideReasons[stepNumber]}
                                  onChange={(event) =>
                                    setOverrideReasons((current) => ({
                                      ...current,
                                      [stepNumber]: event.currentTarget.value,
                                    }))
                                  }
                                />
                                <Button
                                  size="xs"
                                  color="orange"
                                  variant="light"
                                  loading={overrideSaving === stepNumber}
                                  onClick={() => activateOverride(stepNumber, step.label)}
                                >
                                  Activate Override
                                </Button>
                              </>
                            )}
                          </Stack>
                        )}
                      </Alert>
                    )}
                  </Stack>
                </Paper>
              </Group>
            );
          })}
        </Stack>

        <SimpleGrid cols={{ base: 1, md: 4 }}>
          <CampaignMetric label="Chapters sampled" value={`${touchedChapters}/${totalChapters || 0}`} />
          <CampaignMetric label="Untouched" value={untouchedParagraphCount} />
          <CampaignMetric label="Needs review" value={pendingDraftParagraphCount} />
          <CampaignMetric label="Accepted" value={acceptedParagraphCount} />
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function RewriteStrategySelector({
  strategyId,
  settings,
  authorInstructions,
  onStrategyChange,
  onSettingsChange,
  onAuthorInstructionsChange,
}: {
  strategyId: RewriteStrategyId;
  settings: RewriteStrategySettings;
  authorInstructions: string;
  onStrategyChange: (strategyId: RewriteStrategyId) => void;
  onSettingsChange: (settings: RewriteStrategySettings) => void;
  onAuthorInstructionsChange: (value: string) => void;
}) {
  const strategy = rewriteStrategies[strategyId];
  return (
    <Paper id="rewrite-strategy" withBorder radius="md" p="lg" bg="#fffdf8" style={{ scrollMarginTop: 24 }}>
      <Stack>
        <div>
          <Title order={3}>Rewrite Strategy</Title>
          <Text size="sm" c="dimmed">
            Choose the editorial direction before BookForge creates draft revisions.
          </Text>
        </div>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {Object.values(rewriteStrategies).map((item) => (
            <Paper
              key={item.id}
              withBorder
              radius="md"
              p="md"
              bg={strategyId === item.id ? "#f5efff" : "white"}
              style={{ borderColor: strategyId === item.id ? "#9c36b5" : undefined, cursor: "pointer" }}
              onClick={() => onStrategyChange(item.id)}
            >
              <Text fw={900}>{item.label}</Text>
              <Text size="sm" c="dimmed">
                {item.summary}
              </Text>
              <Text size="xs" mt="xs">
                {item.bestFor}
              </Text>
            </Paper>
          ))}
        </SimpleGrid>
        <Alert color="grape" variant="light">
          <Text fw={800}>{strategy.label}</Text>
          <Text size="sm">{strategy.instructions.join(" ")}</Text>
        </Alert>
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          <StrategyNumber
            label="Voice preservation"
            value={settings.voicePreservation}
            onChange={(value) => onSettingsChange({ ...settings, voicePreservation: value })}
          />
          <StrategyNumber
            label="Expansion limit %"
            value={settings.expansionLimitPercent}
            max={40}
            onChange={(value) => onSettingsChange({ ...settings, expansionLimitPercent: value })}
          />
          <StrategyNumber
            label="Sentence rhythm"
            value={settings.sentenceRhythm}
            onChange={(value) => onSettingsChange({ ...settings, sentenceRhythm: value })}
          />
          <StrategyNumber
            label="Literary intensity"
            value={settings.literaryIntensity}
            onChange={(value) => onSettingsChange({ ...settings, literaryIntensity: value })}
          />
          <StrategyNumber
            label="Theological emphasis"
            value={settings.theologicalEmphasis}
            onChange={(value) => onSettingsChange({ ...settings, theologicalEmphasis: value })}
          />
          <StrategyNumber
            label="Continuity strictness"
            value={settings.continuityStrictness}
            onChange={(value) => onSettingsChange({ ...settings, continuityStrictness: value })}
          />
          <StrategyNumber
            label="Target reduction %"
            value={settings.targetReductionPercent}
            max={60}
            onChange={(value) => onSettingsChange({ ...settings, targetReductionPercent: value })}
          />
        </SimpleGrid>
        <Textarea
          label="Run-specific instructions"
          description="Optional. These apply to this rewrite run only."
          value={authorInstructions}
          minRows={3}
          autosize
          onChange={(event) => onAuthorInstructionsChange(event.currentTarget.value)}
        />
      </Stack>
    </Paper>
  );
}

function StrategyNumber({
  label,
  value,
  max = 100,
  onChange,
}: {
  label: string;
  value: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <NumberInput
      label={label}
      value={value}
      min={0}
      max={max}
      onChange={(next) => onChange(Number(next || 0))}
    />
  );
}

function RewriteCoverageSummary({
  coverage,
  disabled,
  loadingChapterId,
  onRewriteChapter,
}: {
  coverage: Array<{
    chapterId: string;
    chapterNumber: number;
    title: string | null;
    totalParagraphs: number;
    rewrittenParagraphs: number;
    realTotalParagraphs: number;
    realRewrittenParagraphs: number;
    pendingParagraphs: number;
  }>;
  disabled?: boolean;
  loadingChapterId?: string | null;
  onRewriteChapter?: (chapterId: string) => void;
}) {
  // Displayed numbers use the REAL paragraph counts (every paragraph in the
  // book, only ones actually accepted) -- not the eligible-only counts,
  // which undercount the denominator (excluding locked/too-short/title-echo
  // paragraphs entirely) and overcount the numerator (any drafted paragraph,
  // including ones auto-accept later rejected). The eligible-only fields
  // are still used below purely to decide whether "Rewrite this chapter" is
  // shown, since that button does nothing once no eligible paragraph is left.
  const touchedChapters = coverage.filter((chapter) => chapter.realRewrittenParagraphs > 0).length;
  const totalChapters = coverage.length;
  const totalParagraphs = coverage.reduce((sum, chapter) => sum + chapter.realTotalParagraphs, 0);
  const rewrittenParagraphs = coverage.reduce((sum, chapter) => sum + chapter.realRewrittenParagraphs, 0);
  const percent = totalParagraphs ? Math.round((rewrittenParagraphs / totalParagraphs) * 100) : 0;

  return (
    <Paper withBorder radius="md" p="md" bg="#fbfaf8">
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Text fw={900}>Rewrite coverage</Text>
          <Text size="sm" c="dimmed">
            {rewrittenParagraphs}/{totalParagraphs} paragraphs have rewrite drafts across {touchedChapters}/{totalChapters} chapters.
          </Text>
        </div>
        <Text fw={900}>{percent}%</Text>
      </Group>
      <Progress value={percent} color="grape" radius="xl" mb="md" />
      <SimpleGrid cols={{ base: 1, md: 4 }}>
        {coverage.map((chapter) => {
          const chapterPercent = chapter.realTotalParagraphs
            ? Math.round((chapter.realRewrittenParagraphs / chapter.realTotalParagraphs) * 100)
            : 0;
          // Ordered by what the user should act on first: a pending review
          // is actionable right now, regardless of how much of the chapter
          // is otherwise done. "Fully rewritten" explains why the button
          // below disappears (see onRewriteChapter's condition, same eligible-
          // count comparison). "Not started"/"In progress" are purely
          // informational -- there's nothing to fix, just status.
          const caption =
            chapter.pendingParagraphs > 0
              ? { text: `${chapter.pendingParagraphs} awaiting your review`, color: "orange" }
              : chapter.rewrittenParagraphs >= chapter.totalParagraphs
                ? { text: "Fully rewritten", color: "teal" }
                : chapter.realRewrittenParagraphs === 0
                  ? { text: "Not started", color: "dimmed" }
                  : { text: "In progress", color: "dimmed" };
          return (
            <Paper key={chapter.chapterId} withBorder radius="sm" p="sm" bg="white">
              <Text size="xs" fw={800} lineClamp={1}>
                {chapter.chapterNumber}. {chapter.title || "Untitled"}
              </Text>
              <Progress value={chapterPercent} color={chapterPercent ? "teal" : "gray"} radius="xl" size="sm" my={6} />
              <Text size="xs" c="dimmed">
                {chapter.realRewrittenParagraphs}/{chapter.realTotalParagraphs} paragraphs
              </Text>
              <Text size="xs" c={caption.color} fw={caption.color === "orange" ? 700 : 400} mb={6}>
                {caption.text}
              </Text>
              {onRewriteChapter && chapter.rewrittenParagraphs < chapter.totalParagraphs && (
                <Button
                  size="compact-xs"
                  variant="light"
                  color="grape"
                  fullWidth
                  disabled={disabled}
                  loading={loadingChapterId === chapter.chapterId}
                  onClick={() => onRewriteChapter(chapter.chapterId)}
                >
                  {loadingChapterId === chapter.chapterId ? "Rewriting…" : "Rewrite this chapter"}
                </Button>
              )}
            </Paper>
          );
        })}
      </SimpleGrid>
    </Paper>
  );
}

function queueLabel(totalUnits: number, current = 1) {
  if (totalUnits <= 1) return "Rewrite unit 1 of 1";
  return `Rewrite unit ${current} of ${totalUnits}`;
}

function getSuggestedBatchSize(paragraphCount: number, settings: Record<string, unknown> | null | undefined) {
  const selection = settings?.rewriteModelSelection;
  const best =
    selection && typeof selection === "object" && "best" in selection
      ? (selection as { best?: { score?: unknown } }).best
      : null;
  const score = typeof best?.score === "number" ? best.score : 70;

  let base = score >= 88 ? 40 : score >= 80 ? 30 : score >= 65 ? 20 : 12;
  if (paragraphCount > 800) base = Math.min(base, 25);
  if (paragraphCount < 80) base = Math.min(base, 15);

  return Math.max(1, Math.min(paragraphCount || base, base));
}
