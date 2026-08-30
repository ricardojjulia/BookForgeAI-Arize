"use client";

/**
 * AutoReviewRunner
 *
 * Client-side orchestrator for the Auto-Review Wizard. Runs all 25 stages
 * sequentially — analyze → baseline critics → rewrite → post critics → export —
 * and loops the rewrite+critic cycle until all 8 critics score ≥ 70 (max 3 loops).
 *
 * Telemetry: every stage completion is persisted to auto_review_jobs.log as a
 * structured TelemetryEntry (see type below). The analytics page reads these to
 * derive per-stage durations and score progression across iterations.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconCheck,
  IconX,
  IconPlayerPlay,
  IconTrophy,
} from "@tabler/icons-react";
import { useAutoReviewStatus } from "@/lib/hooks/use-auto-review-status";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { runChunkedJob } from "@/lib/ai/run-chunked-job";

type Mode = "full_review" | "make_shorter" | "make_longer";
type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

type Stage = { id: string; label: string; group: string };
type StageState = Stage & { status: StageStatus; detail?: string };

/**
 * Structured telemetry entry persisted to auto_review_jobs.log.
 * The analytics dashboard parses these to compute timing, score progression,
 * and model info without re-running any queries against the live tables.
 *
 * Fields:
 *   type           – entry kind; drives how analytics interprets the record
 *   stage          – stage ID (e.g. 'analyze', 'critic_baseline:story_structure')
 *   iteration      – 0-based rewrite loop index
 *   message        – human-readable text displayed in the runner terminal
 *   durationMs     – wall-clock time for the stage (stage_complete only)
 *   scores         – { [lens]: score } post-rewrite critic scores (critics_check only)
 *   baselineScores – { [lens]: score } baseline scores (first critics_check only)
 *   metadata       – arbitrary extra context (model name, batch counts, etc.)
 */
type TelemetryEntry = {
  type: "stage_complete" | "stage_error" | "info";
  stage?: string;
  iteration: number;
  message: string;
  durationMs?: number;
  scores?: Record<string, number | null>;
  baselineScores?: Record<string, number | null>;
  metadata?: Record<string, unknown>;
};

const CRITIC_LENSES = [
  "story_structure",
  "prose_quality",
  "continuity",
  "character_depth",
  "market_fit",
  "contemporary_view",
  "revision_priorities",
  "dialogue_density",
] as const;

const CRITIC_LABELS: Record<string, string> = {
  story_structure: "Story Structure",
  prose_quality: "Prose Quality",
  continuity: "Continuity",
  character_depth: "Character Depth",
  market_fit: "Market Fit",
  contemporary_view: "Contemporary View",
  revision_priorities: "Revision Priorities",
  dialogue_density: "Dialogue Density",
};

const LOOP_STAGE_IDS = new Set<string>([
  "rewrite_execute",
  "auto_accept",
  "drift_check",
  ...CRITIC_LENSES.map((lens) => `critic_post:${lens}`),
  "critics_check",
]);

export function isAutoReviewStageComplete(stageId: string, completed: Set<string>, iteration: number) {
  return completed.has(stageId) || (LOOP_STAGE_IDS.has(stageId) && completed.has(`${stageId}@${iteration}`));
}

function buildStages(): Stage[] {
  return [
    { id: "analyze", label: "Analyze & Blueprint", group: "Prep" },
    { id: "summarize", label: "Summarize Chapters", group: "Prep" },
    ...CRITIC_LENSES.map((lens) => ({
      id: `critic_baseline:${lens}`,
      label: `Critic · ${CRITIC_LABELS[lens]}`,
      group: "Baseline Critics",
    })),
    { id: "rewrite_plan", label: "Generate Rewrite Plan", group: "Rewrite" },
    { id: "rewrite_execute", label: "Execute Rewrite", group: "Rewrite" },
    { id: "auto_accept", label: "Auto-Accept Drafts", group: "Rewrite" },
    { id: "drift_check", label: "Drift Check", group: "Quality" },
    ...CRITIC_LENSES.map((lens) => ({
      id: `critic_post:${lens}`,
      label: `Post-Critic · ${CRITIC_LABELS[lens]}`,
      group: "Post-Rewrite Critics",
    })),
    { id: "critics_check", label: "Critic Threshold Check", group: "Quality" },
    { id: "export", label: "Export Manuscript", group: "Publish" },
    { id: "mark_finished", label: "Mark as Finished", group: "Publish" },
  ];
}

/** Rewrite strategy config keyed by wizard mode. */
const STRATEGY_BY_MODE: Record<Mode, { strategyId: string; strategySettings: Record<string, unknown> }> = {
  full_review: {
    strategyId: "humanized_literary",
    strategySettings: { voicePreservation: 85, literaryIntensity: 70 },
  },
  make_shorter: {
    strategyId: "downsize_abridge",
    strategySettings: { targetReductionPercent: 50 },
  },
  make_longer: {
    strategyId: "creative_enhancement",
    strategySettings: { expansionLimitPercent: 40, literaryIntensity: 75 },
  },
};

/** Maximum rewrite+critic cycles before forcing export regardless of scores. */
const MAX_ITERATIONS = 3;

/** Formats milliseconds as a human-readable duration string (e.g. "2m 14s"). */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Props = {
  bookId: string;
  bookTitle: string;
  jobId: string;
  mode: Mode;
  onDone: () => void;
  /** Stage IDs already completed in a prior run — pre-marked done and skipped. */
  completedStages?: string[];
  serverManaged?: boolean;
};

export function AutoReviewRunner({ bookId, bookTitle, jobId, mode, onDone, completedStages, serverManaged = false }: Props) {
  const stages = buildStages();
  const preCompleted = new Set(completedStages || []);
  const [stageStates, setStageStates] = useState<StageState[]>(
    stages.map((s) => ({ ...s, status: preCompleted.has(s.id) ? "done" : "pending" })),
  );
  const [iteration, setIteration] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const runningRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Ref-tracked iteration so telemetry closures always see the current value
  // even when React state hasn't re-rendered yet.
  const iterationRef = useRef(0);
  // Tracks the deepest stage that actually threw — used in the error banner so
  // "Failed at stage: critics_check" can't mask a real failure inside a loop.
  const actualFailedStageRef = useRef<string | null>(null);

  // Shares the same SWR cache entry (and staleness derivation) as
  // book-actions.tsx's "last run" banner instead of polling this endpoint
  // independently — two separate pollers previously meant a staleness fix
  // applied to one could silently miss the other.
  const { job } = useAutoReviewStatus(serverManaged ? bookId : "", {
    refreshInterval: (data) => (data?.job?.status === "running" ? 2000 : 0),
  });

  // In serverManaged mode, stageStates/log/iteration/done/failed/errorMsg
  // are entirely a function of `job` (the local-run setters below are all
  // gated on `!serverManaged`) — derive them here instead of mirroring
  // `job` into local state via an effect.
  const jobDerived = useMemo(() => {
    if (!serverManaged || !job) return null;

    const completed = new Set(job.stages_completed || []);
    const jobIteration = job.iteration || 0;
    return {
      stageStates: stageStates.map((stage) => {
        if (isAutoReviewStageComplete(stage.id, completed, jobIteration)) return { ...stage, status: "done" as StageStatus };
        if (job.current_stage === stage.id && job.status === "running") return { ...stage, status: "running" as StageStatus };
        if (job.status === "failed" && job.current_stage === stage.id) {
          return { ...stage, status: "failed" as StageStatus, detail: job.error || "Failed" };
        }
        return { ...stage, status: "pending" as StageStatus, detail: undefined };
      }),
      log: (job.log || []).map((entry, index) => `[${index + 1}] ${entry.message || entry.stage || entry.type || "log"}`),
      iteration: jobIteration,
      done: job.status === "completed",
      failed: job.status === "failed",
      errorMsg: job.error || null,
    };
  }, [serverManaged, job, stageStates]);

  const effectiveStageStates = jobDerived?.stageStates ?? stageStates;
  const effectiveLog = jobDerived?.log ?? log;
  const effectiveIteration = jobDerived?.iteration ?? iteration;
  const effectiveDone = jobDerived?.done ?? done;
  const effectiveFailed = jobDerived?.failed ?? failed;
  const effectiveErrorMsg = jobDerived?.errorMsg ?? errorMsg;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [effectiveLog]);

  function setStatus(stageId: string, status: StageStatus, detail?: string) {
    setStageStates((prev) =>
      prev.map((s) => (s.id === stageId ? { ...s, status, detail } : s)),
    );
  }

  /** Appends a line to the terminal-style log panel. */
  function addLog(msg: string) {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  async function callApi(path: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const isAutoRevisionPreview =
      path.includes("/auto-revision") &&
      !!body &&
      typeof body === "object" &&
      "action" in (body as Record<string, unknown>) &&
      (body as Record<string, unknown>).action === "preview";

    if (body !== undefined && supportsServerManagedHandoff(path) && !isAutoRevisionPreview) {
      const queued = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body as Record<string, unknown>), serverManaged: true }),
      });
      const queuedData: Record<string, unknown> = await queued.json().catch(() => ({}));
      if (!queued.ok || queuedData.error) return { ok: false, data: queuedData };
      const queuedContent = queuedData.content as { jobId?: string } | undefined;
      const jobId = queuedContent?.jobId;
      if (!jobId) return { ok: false, data: { error: "Queue handoff failed." } };

      const resumed = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body as Record<string, unknown>), jobId }),
      });
      const resumedData: Record<string, unknown> = await resumed.json().catch(() => ({}));
      if (!resumed.ok || resumedData.error) return { ok: false, data: resumedData };
      return { ok: true, data: resumedData };
    }

    const res = await fetch(path, {
      method: body !== undefined ? "POST" : "GET",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok || data.error) return { ok: false, data };
    return { ok: true, data };
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

  function normalizeStageError(stageId: string, error: unknown) {
    const fallback = `${stageId} failed`;
    return getLmStudioErrorMessage(error, fallback, { task: stageId });
  }

  /**
   * Persists a structured telemetry entry to auto_review_jobs.log via PATCH.
   * Always includes iteration and wall-clock duration so the analytics page can
   * build per-stage timing breakdowns without any additional queries.
   */
  async function advanceJob(stage: string, extra?: Partial<TelemetryEntry>) {
    const entry: TelemetryEntry = {
      type: "stage_complete",
      stage,
      iteration: iterationRef.current,
      message: extra?.message ?? `${stage} completed`,
      ...extra,
    };
    await fetch(`/api/books/${bookId}/auto-review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, stage, logEntry: entry }),
    });
  }

  /**
   * Runs a single stage end-to-end:
   *  1. Sets UI status to "running"
   *  2. Calls the relevant API route
   *  3. On success: persists a stage_complete telemetry entry with durationMs
   *  4. On failure: persists a stage_error entry and returns false
   *
   * The startMs timestamp is recorded before any async work so durationMs
   * reflects true wall-clock time including network round-trips.
   */
  async function runStage(stageId: string): Promise<boolean> {
    setStatus(stageId, "running");
    addLog(`Starting: ${stageId}`);
    const startMs = Date.now(); // wall-clock start for telemetry

    try {
      let result: { ok: boolean; data: Record<string, unknown> };

      if (stageId === "analyze") {
        result = await callApi(`/api/books/${bookId}/analyze`, {});
        if (!result.ok) throw new Error(String(result.data.error || "Analyze failed"));

      } else if (stageId === "summarize") {
        result = await callApi(`/api/books/${bookId}/chapters/summarize`, {});
        if (!result.ok) throw new Error(String(result.data.error || "Summarize failed"));

      } else if (stageId.startsWith("critic_baseline:")) {
        const lens = stageId.split(":")[1];
        let lastCriticError = `Critic ${lens} failed`;
        result = { ok: false, data: {} };
        for (let attempt = 1; attempt <= 2; attempt++) {
          result = await callApi(`/api/books/${bookId}/critic`, { lens, stage: "baseline" });
          if (result.ok) break;
          lastCriticError = String(result.data.error || lastCriticError);
          if (attempt < 2) {
            addLog(`Critic ${lens} attempt ${attempt} failed — retrying in 10s…`);
            await new Promise((r) => setTimeout(r, 10000));
          }
        }
        if (!result.ok) throw new Error(lastCriticError);

      } else if (stageId === "rewrite_plan") {
        result = await callApi(`/api/books/${bookId}/rewrite-plan`, {});
        if (!result.ok) throw new Error(String(result.data.error || "Rewrite plan failed"));

      } else if (stageId === "rewrite_execute") {
        // Check paragraph count before attempting rewrite — skip gracefully if no manuscript.
        const countResult = await callApi(`/api/books/${bookId}/paragraph-count`);
        const paragraphCount = (countResult.data?.count as number) ?? -1;
        if (paragraphCount === 0) {
          addLog("No manuscript paragraphs found — import your manuscript to enable rewriting.");
          setStatus(stageId, "skipped", "no manuscript");
          await advanceJob(stageId, { durationMs: Date.now() - startMs, message: "Skipped — no manuscript imported yet" });
          return true;
        }

        const strategy = STRATEGY_BY_MODE[mode];
        let batchNumber = 0;
        let totalUnitsProcessed = 0;

        // rewrite-execute processes one bounded chunk (<=5 paragraphs) per
        // request -- runChunkedJob reuses the same jobId across calls,
        // stopping once the route reports no eligible paragraphs remain.
        await runChunkedJob(
          `/api/books/${bookId}/rewrite-execute`,
          { ...strategy, distributeAcrossChapters: true },
          "Rewrite execute",
          (progress) => {
            batchNumber += 1;
            // Route returns cumulative `rewritten`/`attempted` across the whole job, not just this chunk.
            totalUnitsProcessed = (progress.rewritten as number) ?? (progress.attempted as number) ?? totalUnitsProcessed;
            addLog(`Rewrite chunk ${batchNumber}: ${totalUnitsProcessed} paragraph(s) processed so far`);
            setStatus(stageId, "running", `Chunk ${batchNumber} · ${totalUnitsProcessed} total`);
          },
        );
        result = { ok: true, data: {} };

        // Record total paragraphs rewritten for analytics
        setStatus(stageId, "done", `${totalUnitsProcessed} paragraphs rewritten`);
        await advanceJob(stageId, {
          durationMs: Date.now() - startMs,
          message: `Rewrite complete — ${totalUnitsProcessed} paragraphs in ${batchNumber} chunk(s)`,
          metadata: { batchCount: batchNumber, totalUnitsProcessed },
        });
        addLog(`✓ Done: ${stageId} · ${totalUnitsProcessed} paragraphs (${fmtDuration(Date.now() - startMs)})`);
        return true;

      } else if (stageId === "auto_accept") {
        // Skip if there are no pending drafts (rewrite_execute was skipped or produced nothing).
        const previewResult = await callApi(`/api/books/${bookId}/auto-revision`, { action: "preview" });
        const pendingDrafts = (previewResult.data?.content as Record<string, unknown> | undefined)?.pendingDrafts as number ?? 0;
        if (pendingDrafts === 0) {
          addLog("No pending drafts to accept — skipping auto-accept.");
          setStatus(stageId, "skipped", "no drafts");
          await advanceJob(stageId, { durationMs: Date.now() - startMs, message: "Skipped — no pending drafts" });
          return true;
        }
        result = await callApi(`/api/books/${bookId}/auto-revision`, {
          action: "run",
          trustProfile: "full_trust",
          maxDecisions: 5000,
        });
        if (!result.ok) throw new Error(String(result.data.error || "Auto-accept failed"));
        const content = result.data.content as Record<string, unknown> | undefined;
        const applied = content?.applied as Record<string, number> | undefined;
        if (applied) {
          addLog(`Auto-accepted: ${applied.accepted} · rejected: ${applied.rejected} · redo: ${applied.redo}`);
          setStatus(stageId, "done", `${applied.accepted} accepted`);
          await advanceJob(stageId, {
            durationMs: Date.now() - startMs,
            message: `Auto-accepted ${applied.accepted} drafts`,
            metadata: { accepted: applied.accepted, rejected: applied.rejected, redo: applied.redo },
          });
          addLog(`✓ Done: ${stageId} (${fmtDuration(Date.now() - startMs)})`);
          return true;
        }

      } else if (stageId === "drift_check") {
        result = await callApi(`/api/books/${bookId}/drift-check`, {});
        if (!result.ok) throw new Error(String(result.data.error || "Drift check failed"));
        if (result.data.skipped) {
          addLog(`Drift check skipped — ${result.data.reason || "no new samples"}`);
          setStatus(stageId, "skipped", "no new samples");
          await advanceJob(stageId, { durationMs: Date.now() - startMs, message: String(result.data.reason || "Drift check skipped") });
          return true;
        }

      } else if (stageId.startsWith("critic_post:")) {
        const lens = stageId.split(":")[1];
        let lastPostCriticError = `Post-critic ${lens} failed`;
        result = { ok: false, data: {} };
        for (let attempt = 1; attempt <= 2; attempt++) {
          result = await callApi(`/api/books/${bookId}/critic`, { lens, stage: "post_rewrite" });
          if (result.ok) break;
          lastPostCriticError = String(result.data.error || lastPostCriticError);
          if (attempt < 2) {
            addLog(`Post-critic ${lens} attempt ${attempt} failed — retrying in 10s…`);
            await new Promise((r) => setTimeout(r, 10000));
          }
        }
        if (!result.ok) throw new Error(lastPostCriticError);

      } else if (stageId === "critics_check") {
        // Retry up to 3 times — this is a lightweight GET and transient network
        // hiccups (or a brief LM Studio restart) shouldn't abort the whole run.
        let lastError = "Critics check failed";
        result = { ok: false, data: {} };
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await callApi(`/api/books/${bookId}/auto-review/critics-check`);
          if (result.ok) break;
          lastError = String(result.data.error || lastError);
          if (attempt < 3) {
            addLog(`Critics check attempt ${attempt} failed (${lastError}) — retrying in 5s…`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        if (!result.ok) throw new Error(lastError);

        const { allGreen, greenCount, total, avgScore, scores, baselineScores } = result.data as {
          allGreen: boolean;
          greenCount: number;
          total: number;
          avgScore: number | null;
          scores: Record<string, number | null>;
          baselineScores: Record<string, number | null>;
        };
        addLog(
          `Threshold check: ${greenCount}/${total} critics >= 70 · avg ${avgScore ?? "N/A"} — ${allGreen ? "ALL GREEN" : "another cycle required"}`,
        );

        if (!allGreen && iterationRef.current < MAX_ITERATIONS - 1) {
          const nextIteration = iterationRef.current + 1;
          // Keep ref and state in sync so the next advanceJob sees the right iteration
          iterationRef.current = nextIteration;
          setIteration(nextIteration);
          addLog(`Starting rewrite iteration ${nextIteration + 1}...`);

          setStatus(stageId, "skipped", `Loop → iteration ${nextIteration + 1}`);
          await advanceJob(stageId, {
            type: "info",
            durationMs: Date.now() - startMs,
            message: `${greenCount}/${total} critics >= 70. Starting another rewrite cycle (iteration ${nextIteration + 1}).`,
            scores,
            baselineScores,
            metadata: { allGreen, greenCount, total, avgScore },
          });

          const loopStages = [
            "rewrite_execute", "auto_accept", "drift_check",
            ...CRITIC_LENSES.map((l) => `critic_post:${l}`),
            "critics_check",
          ];
          setStageStates((prev) =>
            prev.map((s) => loopStages.includes(s.id) ? { ...s, status: "pending", detail: undefined } : s),
          );
          for (const loopStageId of loopStages) {
            const ok = await runStage(loopStageId);
            if (!ok) return false; // actualFailedStageRef already set by the inner runStage
          }
          return true;
        }

        // Final quality gate result — log scores for analytics score-progression chart
        const detail = allGreen
          ? `${greenCount}/${total} green · avg ${avgScore}`
          : `Threshold not fully met after ${MAX_ITERATIONS} cycles`;
        setStatus(stageId, "done", detail);
        if (!allGreen) addLog(`Threshold not fully met after ${MAX_ITERATIONS} cycles. Proceeding to export by policy.`);

        await advanceJob(stageId, {
          durationMs: Date.now() - startMs,
          message: `Quality gate final: ${greenCount}/${total} green, avg score ${avgScore}`,
          scores,
          baselineScores,
          metadata: { allGreen, greenCount, total, avgScore },
        });
        addLog(`✓ Done: ${stageId} (${fmtDuration(Date.now() - startMs)})`);
        return true;

      } else if (stageId === "export") {
        result = await callApi(`/api/books/${bookId}/export`, {
          format: "docx",
          sourceMode: "accepted",
          includeFrontMatter: true,
          includeBackMatter: true,
        });
        if (!result.ok) throw new Error(String(result.data.error || "Export failed"));
        const exportData = result.data as Record<string, unknown>;
        const eid = (exportData.exportId as string) || ((exportData.export as { id?: string } | null)?.id) || null;
        if (eid) setExportId(eid);

      } else if (stageId === "mark_finished") {
        result = await callApi(`/api/books/${bookId}/mark-finished`, {
          exportId: exportId || null,
        });
        if (!result.ok) throw new Error(String(result.data.error || "Mark finished failed"));

      } else {
        addLog(`Unknown stage: ${stageId} — skipping`);
        setStatus(stageId, "skipped");
        return true;
      }

      const durationMs = Date.now() - startMs;
      setStatus(stageId, "done");
      await advanceJob(stageId, {
        durationMs,
        message: `${stageId} completed in ${fmtDuration(durationMs)}`,
      });
      addLog(`✓ Done: ${stageId} (${fmtDuration(durationMs)})`);
      return true;

    } catch (e) {
      const msg = normalizeStageError(stageId, e);
      setStatus(stageId, "failed", msg);
      addLog(`✗ Failed: ${stageId} — ${msg}`);
      // Record the deepest actual failing stage so the error banner shows the
      // real culprit even when the failure bubbles up through critics_check.
      if (!actualFailedStageRef.current) actualFailedStageRef.current = stageId;

      // Persist the error so the analytics page can surface failure reasons
      await fetch(`/api/books/${bookId}/auto-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId, stage: stageId,
          logEntry: {
            type: "stage_error",
            stage: stageId,
            iteration: iterationRef.current,
            message: `${stageId} failed: ${msg}`,
            durationMs: Date.now() - startMs,
          } satisfies TelemetryEntry,
        }),
      });
      return false;
    }
  }

  useEffect(() => {
    if (serverManaged) return;
    if (runningRef.current) return;
    runningRef.current = true;

    (async () => {
      // Capture the active model at run start for telemetry.
      // Non-blocking — if LM Studio isn't reachable we just record "unknown".
      const modelRes = await callApi(`/api/lmstudio/status`).catch(() => null);
      const model =
        (modelRes?.data?.configuredRewriteModel as { model?: string } | null)?.model ||
        (modelRes?.data?.availableModels as string[] | null)?.[0] ||
        null;
      if (model) {
        addLog(`Model: ${model}`);
        await fetch(`/api/books/${bookId}/auto-review`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId,
            logEntry: {
              type: "info",
              iteration: 0,
              message: `Active model: ${model}`,
              metadata: { model },
            } satisfies TelemetryEntry,
          }),
        });
      }

      for (const stage of stages) {
        if (preCompleted.has(stage.id)) {
          addLog(`↩ Resuming — skipping already-completed: ${stage.id}`);
          continue;
        }
        const ok = await runStage(stage.id);
        if (!ok) {
          const failedAt = actualFailedStageRef.current || stage.id;
          setFailed(true);
          setErrorMsg(`Failed at stage: ${failedAt}`);
          await fetch(`/api/books/${bookId}/auto-review`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId, failed: true, error: `Failed at stage: ${failedAt}` }),
          });
          return;
        }
      }

      setDone(true);
      await fetch(`/api/books/${bookId}/auto-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, completed: true }),
      });
      addLog("🎉 All done! Your book is published.");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doneCount = effectiveStageStates.filter((s) => s.status === "done" || s.status === "skipped").length;
  const progress = Math.round((doneCount / stages.length) * 100);
  const currentStage = effectiveStageStates.find((s) => s.status === "running");
  const groups = Array.from(new Set(stages.map((s) => s.group)));
  const likelyTransientFailure = /fetch failed|Failed to fetch|timeout|could not reach lm studio|ECONNREFUSED|ECONNRESET/i.test(effectiveErrorMsg || "");

  return (
    <Stack gap="md">
      <div>
        <Title order={4}>{bookTitle}</Title>
        <Text size="sm" c="dimmed">
          {effectiveDone ? "Published!" : effectiveFailed ? "Failed" : `Running — ${currentStage?.label || "…"}`}
        </Text>
      </div>

      <Progress
        value={progress}
        color={effectiveDone ? "green" : effectiveFailed ? "red" : "grape"}
        size="md"
        radius="xl"
        animated={!effectiveDone && !effectiveFailed}
      />

      {effectiveDone && (
        <Alert color="green" icon={<IconTrophy size={18} />} title="Book Published!">
          All critics passed. Your book has been exported and marked as finished.
        </Alert>
      )}
      {effectiveFailed && (
        <Alert color="red" icon={<IconX size={18} />} title="Workflow failed">
          <Text size="sm" mb="xs">
            {effectiveErrorMsg}. {likelyTransientFailure
              ? "This is often transient (a brief network timeout or AI provider hiccup). Resume to continue from the next unfinished stage."
              : "Fix the issue, then resume. Completed stages will be skipped."}
          </Text>
          <Button size="xs" color="orange" onClick={onDone}>
            Back to wizard to resume
          </Button>
        </Alert>
      )}

      <ScrollArea h={340}>
        <Stack gap="xs">
          {groups.map((group) => (
            <div key={group}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4}>{group}</Text>
              <Stack gap={4}>
                {effectiveStageStates
                  .filter((s) => s.group === group)
                  .map((s) => (
                    <Paper key={s.id} withBorder={false} py={4} px="sm" radius="sm"
                      style={{
                        background:
                          s.status === "running" ? "var(--mantine-color-grape-0)" :
                          s.status === "done" ? "var(--mantine-color-green-0)" :
                          s.status === "failed" ? "var(--mantine-color-red-0)" : "transparent",
                      }}
                    >
                      <Group gap="xs" wrap="nowrap">
                        <StageIcon status={s.status} />
                        <Text size="sm" fw={s.status === "running" ? 600 : 400} style={{ flex: 1 }}>
                          {s.label}
                        </Text>
                        {s.detail && (
                          <Text size="xs" c="dimmed" style={{ maxWidth: 180 }} lineClamp={1}>
                            {s.detail}
                          </Text>
                        )}
                        <Badge
                          size="xs"
                          color={
                            s.status === "done" ? "green" :
                            s.status === "running" ? "grape" :
                            s.status === "failed" ? "red" :
                            s.status === "skipped" ? "yellow" : "gray"
                          }
                          variant="light"
                        >
                          {s.status}
                        </Badge>
                      </Group>
                    </Paper>
                  ))}
              </Stack>
            </div>
          ))}
        </Stack>
      </ScrollArea>

      {/* Terminal-style log — shows human-readable messages including duration hints */}
      <Paper withBorder radius="sm" p="sm" bg="#0f0f0f" ff="monospace">
        <ScrollArea h={120}>
          <div ref={logRef}>
            {effectiveLog.map((line, i) => (
              <Text key={i} size="xs" c="green.4">{line}</Text>
            ))}
            {!effectiveDone && !effectiveFailed && <Text size="xs" c="dimmed">…</Text>}
          </div>
        </ScrollArea>
      </Paper>

      {effectiveIteration > 0 && (
        <Group>
          <Badge color="grape" variant="light">
            Rewrite cycle {effectiveIteration + 1} of {MAX_ITERATIONS}
          </Badge>
        </Group>
      )}

      <Group justify="flex-end">
        {(effectiveDone || effectiveFailed) && (
          <Button
            color={effectiveDone ? "green" : "gray"}
            onClick={onDone}
            leftSection={effectiveDone ? <IconCheck size={16} /> : undefined}
          >
            {effectiveDone ? "Close & Go to Book" : "Close"}
          </Button>
        )}
        {!effectiveDone && !effectiveFailed && (
          <Group gap="xs">
            <Loader size="xs" color="grape" />
            <Text size="sm" c="dimmed">Running autonomously — no action needed</Text>
          </Group>
        )}
      </Group>
    </Stack>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <ThemeIcon size="xs" color="green" variant="light" radius="xl"><IconCheck size={10} /></ThemeIcon>;
  if (status === "failed") return <ThemeIcon size="xs" color="red" variant="light" radius="xl"><IconX size={10} /></ThemeIcon>;
  if (status === "running") return <Loader size="xs" color="grape" type="dots" />;
  if (status === "skipped") return <ThemeIcon size="xs" color="yellow" variant="light" radius="xl"><IconPlayerPlay size={10} /></ThemeIcon>;
  return <ThemeIcon size="xs" color="gray" variant="light" radius="xl"><Box w={6} h={6} style={{ borderRadius: "50%", background: "currentColor" }} /></ThemeIcon>;
}
