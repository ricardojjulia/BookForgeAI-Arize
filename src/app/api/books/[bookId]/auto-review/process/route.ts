import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { withBookForgeWorkflowSpan } from "@/lib/observability/workflow-span";

const schema = z.object({
  jobId: z.string().uuid(),
  mode: z.enum(["full_review", "make_shorter", "make_longer"]),
  launchToken: z.string().uuid().optional(),
  launchOnly: z.boolean().optional(),
});

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

const STRATEGY_BY_MODE: Record<"full_review" | "make_shorter" | "make_longer", { strategyId: string; strategySettings: Record<string, unknown> }> = {
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

// This is the one route that most needed an explicit ceiling and never had
// one -- it's a single long-lived request that loops through the ENTIRE
// stage sequence (analyze, chapter summaries, all 8 critic lenses, rewrite
// plan, ...) in one HTTP invocation, individually dispatching and polling
// each stage's own worker route. Every downstream stage route was hardened
// with its own maxDuration; this orchestrator wrapping all of them was not.
// Confirmed via a real production failure: Vercel silently killed this
// function mid-loop (platform default, far short of what a real multi-stage
// run needs) with no exception path -- no auto_review_jobs status update, no
// log entry, no further stage dispatched -- leaving the run to be cleaned up
// only minutes later by the unrelated stage-staleness/heartbeat watchdogs,
// which report a generic "stalled" error with no hint of the real cause.
//
// 800s is Vercel Pro's practical ceiling, not a guarantee: a long enough
// review (many chapters, several critic lenses each needing close to their
// own worst-case budget) can still exceed even this in one request. The
// complete fix is making this route checkpoint and re-invoke itself before
// running out of budget, the same chunked/resumable pattern PR #128 proved
// for rewrite-execute/generate-draft -- this route already tracks
// current_stage/stages_completed, so the resumability plumbing exists, it's
// just not self-triggered yet. Out of scope for this pass.
export const maxDuration = 800;

// Leaves ~100s margin under maxDuration for the current stage's own
// in-flight cleanup plus the self-continuation fetch below -- see the
// checkpoint check at the bottom of the stage loop.
const SELF_CONTINUE_AFTER_MS = 700_000;

const MAX_ITERATIONS = 3;
const STAGE_MAX_ATTEMPTS = 3;
// Safety cap against a runaway loop if rewrite-execute ever stops reporting
// a decreasing remainingUnits -- matches the client-side runChunkedJob's
// own MAX_CHUNK_CALLS (src/lib/ai/run-chunked-job.ts), not expected to ever
// be hit in practice (CONCURRENCY=5 paragraphs/chunk).
const MAX_REWRITE_CHUNK_CALLS = 2000;

function isTransientStageError(error: unknown) {
  const message = getError(error);
  // "Timed out waiting for stage job" is the auto-review worker's own poll
  // giving up after 45 minutes -- not proof the underlying work failed. A
  // full-manuscript rewrite can legitimately run for hours; treating this as
  // retryable lets runStageWithRetry go back to watching the SAME dispatched
  // job (see pendingStageJob below) instead of the whole run dying here.
  //
  // "stalled" / "died mid-run" catches detectAndHealStaleAutoReviewJobs' and
  // the revision_jobs heartbeat sweep's own error text (job-state.ts) -- a
  // stage worker getting hard-killed by a platform duration limit before it
  // reaches its own catch block, then reported minutes later by an unrelated
  // watchdog. Found live: this exact failure never matched the original
  // pattern (its message contains neither "timeout" nor "timed out"), so
  // runStageWithRetry's 3-attempt/backoff retry never triggered at all --
  // the very first hung critic-lens call permanently failed the whole
  // review instead of being retried like any other transient failure.
  return /(fetch failed|Failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|HeadersTimeout|UND_ERR_|socket hang up|network error|timeout|timed out|stalled|died mid-run)/i.test(message);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thrown by callStage's rewrite_execute dispatch loop when it's run long
// enough that finishing the remaining chunks risks exceeding this request's
// own maxDuration. Deliberately NOT matched by isTransientStageError, so
// runStageWithRetry never retries it -- it's caught one level up, at the
// stage-loop's own checkpoint handling, and treated as "stop here cleanly
// and self-continue the SAME stage" rather than a stage failure.
class StageCheckpointNeeded extends Error {}

type AutoReviewJobRow = {
  id: string;
  status: string;
  current_stage: string;
  stages_completed: string[];
  iteration: number;
  config: Record<string, unknown> | null;
  log: Array<Record<string, unknown>> | null;
  error: string | null;
  export_id: string | null;
  created_at: string;
  completed_at: string | null;
};

type PendingStageJob = { stage: string; jobId: string } | null;

type MetadataSelection = {
  metadataSnapshotId?: string | null;
  metadataBranchName?: string | null;
  metadataSelectionSource?: "explicit_snapshot" | "branch_active" | "active_snapshot" | null;
  pendingStageJob?: PendingStageJob;
};

type AutoReviewLogEntry = Record<string, unknown> & {
  type?: string;
  launchToken?: string;
};

type AutoReviewJobUpdate = {
  stage?: string;
  completedStageKey?: string;
  iteration?: number;
  completed?: boolean;
  failed?: boolean;
  error?: string;
  exportId?: string | null;
  config?: Record<string, unknown>;
  logEntry?: Record<string, unknown>;
};

// Stages inside the rewrite/critic loop can legitimately run more than once
// per job (once per quality-gate iteration). Recording their completion
// under a plain name in `stages_completed` would make a resumed request
// think iteration 2's "rewrite_execute" is already done because iteration
// 0's was -- skipping work it actually needs to redo. Scoping the persisted
// key to the iteration it ran in fixes that without touching stages that
// only ever run once.
const LOOP_STAGES = new Set<string>([
  "rewrite_execute",
  "auto_accept",
  "drift_check",
  ...CRITIC_LENSES.map((lens) => `critic_post:${lens}`),
  "critics_check",
]);

function stageStatusKey(stage: string, iteration: number) {
  return LOOP_STAGES.has(stage) ? `${stage}@${iteration}` : stage;
}

function getError(e: unknown) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const candidate = e as { message?: unknown; error?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [candidate.message, candidate.error, candidate.details, candidate.hint]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    if (parts.length > 0) {
      const suffix = typeof candidate.code === "string" && candidate.code.trim() ? ` (code: ${candidate.code.trim()})` : "";
      return `${parts.join(" | ")}${suffix}`;
    }
  }
  return "Failed.";
}

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  const requestStartedAt = Date.now();
  let parsedBody: z.infer<typeof schema> | null = null;
  let currentStage = "analyze";
  let currentUserId: string | null = null;
  try {
    const { bookId } = await context.params;
    parsedBody = schema.parse(await request.json());
    const body = parsedBody;
    const cookie = request.headers.get("cookie") || "";
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    currentUserId = user.id;

    const { data: job, error: jobError } = await supabase
      .from("auto_review_jobs")
      .select("id,status,current_stage,stages_completed,iteration,config,log,error,export_id,created_at,completed_at")
      .eq("id", body.jobId)
      .eq("book_id", bookId)
      .eq("user_id", user.id)
      .single();
    if (jobError) throw jobError;
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    if (job.status === "completed") return NextResponse.json({ ok: true, message: "Job already completed." });
    if (job.status === "failed") return NextResponse.json({ ok: true, message: "Job already failed." });

    const baseUrl = new URL(request.url);
    const currentJob = job as AutoReviewJobRow;
    const selection = (currentJob.config || {}) as MetadataSelection;

    if (body.launchOnly) {
      return NextResponse.json({
        ok: true,
        accepted: true,
        launch: {
          jobId: currentJob.id,
          status: currentJob.status,
          currentStage: currentJob.current_stage || "analyze",
          iteration: currentJob.iteration || 0,
          completedStages: (currentJob.stages_completed || []).length,
          launchToken: body.launchToken || null,
        },
      });
    }

    if (body.launchToken) {
      const hasLaunch = (currentJob.log || []).some((entry) => {
        const parsed = entry as AutoReviewLogEntry;
        return parsed.type === "worker_launch" && parsed.launchToken === body.launchToken;
      });
      if (hasLaunch) {
        return NextResponse.json({
          ok: true,
          accepted: true,
          alreadyAccepted: true,
          launch: {
            jobId: currentJob.id,
            status: currentJob.status,
            currentStage: currentJob.current_stage || "analyze",
            iteration: currentJob.iteration || 0,
            completedStages: (currentJob.stages_completed || []).length,
            launchToken: body.launchToken,
          },
        });
      }
    }

    const updateJob = async (updates: AutoReviewJobUpdate) => {
      const { data: latest } = await supabase
        .from("auto_review_jobs")
        .select("id,stages_completed,log,iteration,config")
        .eq("id", body.jobId)
        .eq("book_id", bookId)
        .eq("user_id", user.id)
        .single();
      if (!latest) throw new Error("Auto-review job disappeared.");

      const stagesCompleted = updates.completedStageKey
        ? Array.from(new Set([...(latest.stages_completed || []), updates.completedStageKey]))
        : latest.stages_completed || [];
      const log = updates.logEntry
        ? [...(latest.log || []), { ...updates.logEntry, ts: new Date().toISOString() }]
        : latest.log || [];

      const payload: Record<string, unknown> = { stages_completed: stagesCompleted, log };
      if (updates.stage) payload.current_stage = updates.stage;
      if (updates.iteration !== undefined) payload.iteration = updates.iteration;
      if (updates.exportId !== undefined) payload.export_id = updates.exportId;
      if (updates.config !== undefined) {
        payload.config = { ...((latest.config as Record<string, unknown> | null) || {}), ...updates.config };
      }
      if (updates.completed) {
        payload.status = "completed";
        payload.completed_at = new Date().toISOString();
      } else if (updates.failed) {
        payload.status = "failed";
        payload.error = updates.error || "Unknown error";
        payload.completed_at = new Date().toISOString();
      }

      const { error } = await supabase.from("auto_review_jobs").update(payload).eq("id", body.jobId);
      if (error) throw error;
    };

    // Tracks the underlying revision_jobs row a server-managed stage
    // dispatched, if any, so a retry or a resumed request can check whether
    // it actually finished (or is still legitimately in flight) instead of
    // firing off a costly duplicate -- see callStage below.
    let pendingStageJob: PendingStageJob = selection.pendingStageJob ?? null;
    const setPendingStageJob = async (value: PendingStageJob) => {
      pendingStageJob = value;
      await updateJob({ config: { pendingStageJob: value } });
    };

    if (body.launchToken) {
      await updateJob({
        logEntry: {
          type: "worker_launch",
          launchToken: body.launchToken,
          message: "Auto-review worker launch accepted.",
        },
      });
    }

    const JOB_POLL_INTERVAL_MS = 8000;
    const JOB_POLL_MAX_WAIT_MS = 45 * 60 * 1000;

    const pollJobUntilTerminal = async (targetJobId: string): Promise<void> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < JOB_POLL_MAX_WAIT_MS) {
        await wait(JOB_POLL_INTERVAL_MS);
        const jobsRes = await fetch(new URL(`/api/books/${bookId}/jobs`, baseUrl).toString(), {
          headers: { cookie },
        });
        const jobsData = await jobsRes.json().catch(() => ({}));
        const jobs = (jobsData.content?.jobs || []) as Array<{ id: string; status: string; error_message?: string | null }>;
        const target = jobs.find((j) => j.id === targetJobId);
        if (!target) continue;
        if (target.status === "completed") return;
        if (target.status === "failed" || target.status === "cancelled") {
          throw new Error(target.error_message || `Stage job ${targetJobId} did not complete successfully.`);
        }
      }
      throw new Error(`Timed out waiting for stage job ${targetJobId} to finish after ${Math.round(JOB_POLL_MAX_WAIT_MS / 60000)} minutes.`);
    };

    // rewrite-execute's own chunk-dispatch loop below already knows it's
    // safe to fire the next chunk immediately -- it just awaited the
    // previous one synchronously, so nothing else could be racing it. The
    // one genuinely ambiguous moment is resuming a chunkJobId INHERITED
    // from pendingStageJob (a checkpoint/Resume from a previous
    // invocation): a real prior incident left 13 full_book_rewrite jobs
    // running in true parallel for ~2 hours after a naive resume
    // re-dispatched a job that was still genuinely in flight. Give it a
    // short grace window to settle on its own via the same /jobs polling
    // pollJobUntilTerminal uses, but -- unlike that function -- don't wait
    // 45 minutes or throw on timeout: rewrite-execute processes one bounded
    // chunk per call (well under a minute in practice, bounded by its own
    // maxDuration regardless), so anything still "running" after this
    // window isn't a live duplicate, it's just idle and waiting for the
    // next chunk -- safe to take over.
    const HANDOFF_GRACE_MS = 30_000;
    const waitBrieflyForHandoff = async (targetJobId: string): Promise<"completed" | "failed" | "still_running"> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < HANDOFF_GRACE_MS) {
        await wait(JOB_POLL_INTERVAL_MS);
        const jobsRes = await fetch(new URL(`/api/books/${bookId}/jobs`, baseUrl).toString(), {
          headers: { cookie },
        });
        const jobsData = await jobsRes.json().catch(() => ({}));
        const jobs = (jobsData.content?.jobs || []) as Array<{ id: string; status: string }>;
        const target = jobs.find((j) => j.id === targetJobId);
        if (!target) continue;
        if (target.status === "completed") return "completed";
        if (target.status === "failed" || target.status === "cancelled") return "failed";
      }
      return "still_running";
    };

    const callStage = async (path: string, payload?: unknown) => {
      const bodyPayload = payload as Record<string, unknown> | undefined;
      const isAutoRevisionPreview =
        path.includes("/auto-revision") &&
        !!bodyPayload &&
        bodyPayload.action === "preview";

      // rewrite-execute processes exactly one chapter-bounded chunk
      // (<=CONCURRENCY paragraphs) per request and expects the caller to
      // re-invoke it with the same jobId while remainingUnits > 0 -- see
      // that route's own comment. The generic single-fire-then-poll
      // handling below (supportsServerManagedHandoff) assumes a stage
      // completes within one call, which holds for every OTHER stage in
      // this pipeline but never for this one. Found live: chunk 1 would
      // succeed and save real revision_versions rows, then the job just
      // sat "running" forever -- nothing ever dispatched chunk 2 -- until
      // an unrelated stale-heartbeat sweep killed it minutes later and
      // reported a generic, misleading "died mid-run" error.
      if (path.includes("/rewrite-execute")) {
        let chunkJobId = pendingStageJob?.stage === currentStage ? pendingStageJob.jobId : undefined;

        if (chunkJobId) {
          const { data: existingJob } = await supabase
            .from("revision_jobs")
            .select("id,status")
            .eq("id", chunkJobId)
            .eq("book_id", bookId)
            .maybeSingle();
          if (!existingJob || existingJob.status === "failed" || existingJob.status === "cancelled") {
            chunkJobId = undefined;
          } else if (existingJob.status === "completed") {
            await setPendingStageJob(null);
            return {};
          } else {
            // status === "running", inherited from a previous invocation --
            // ambiguous (see waitBrieflyForHandoff's comment). Give it a
            // short grace window rather than assuming either "safe to
            // dispatch" or "must wait forever" outright.
            const outcome = await waitBrieflyForHandoff(chunkJobId);
            if (outcome === "completed") {
              await setPendingStageJob(null);
              return {};
            }
            if (outcome === "failed") {
              chunkJobId = undefined;
            }
            // "still_running" after the grace window: fall through and
            // take over dispatching -- see waitBrieflyForHandoff comment.
          }
        }

        if (!chunkJobId) {
          const queueRes = await fetch(new URL(path, baseUrl).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              ...bodyPayload,
              serverManaged: true,
              externalDriver: true,
              metadataSnapshotId: selection.metadataSnapshotId || undefined,
              metadataBranchName: selection.metadataBranchName || undefined,
              metadataSelectionSource: selection.metadataSelectionSource || undefined,
            }),
          });
          const queueData = await queueRes.json().catch(() => ({}));
          if (!queueRes.ok || queueData.error) {
            throw new Error(String(queueData.error || `Stage queue failed: ${path}`));
          }
          const queuedContent = queueData.content as { jobId?: string; revisionJobId?: string } | undefined;
          chunkJobId = queuedContent?.jobId || queuedContent?.revisionJobId || (queueData.jobId as string | undefined);
          if (!chunkJobId) throw new Error(`Stage queue handoff missing job id: ${path}`);
          await setPendingStageJob({ stage: currentStage, jobId: chunkJobId });
        }

        for (let chunkCall = 0; chunkCall < MAX_REWRITE_CHUNK_CALLS; chunkCall += 1) {
          if (Date.now() - requestStartedAt > SELF_CONTINUE_AFTER_MS) {
            throw new StageCheckpointNeeded(`rewrite_execute checkpoint after ${chunkCall} chunk call(s) this request`);
          }
          const runRes = await fetch(new URL(path, baseUrl).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              ...bodyPayload,
              jobId: chunkJobId,
              externalDriver: true,
              metadataSnapshotId: selection.metadataSnapshotId || undefined,
              metadataBranchName: selection.metadataBranchName || undefined,
              metadataSelectionSource: selection.metadataSelectionSource || undefined,
            }),
          });
          const runData = await runRes.json().catch(() => ({}));
          if (!runRes.ok || runData.error) {
            throw new Error(String(runData.error || `Stage request failed: ${path}`));
          }
          const content = runData.content as { remainingUnits?: number; status?: string } | undefined;
          if (!content || (content.remainingUnits ?? 0) <= 0 || content.status === "completed" || content.status === "cancelled") {
            await setPendingStageJob(null);
            return runData as Record<string, unknown>;
          }
        }
        throw new Error(`rewrite_execute did not finish within ${MAX_REWRITE_CHUNK_CALLS} chunk calls.`);
      }

      if (payload !== undefined && supportsServerManagedHandoff(path) && !isAutoRevisionPreview) {
        if (pendingStageJob && pendingStageJob.stage === currentStage) {
          const { data: existingJob } = await supabase
            .from("revision_jobs")
            .select("id,status")
            .eq("id", pendingStageJob.jobId)
            .eq("book_id", bookId)
            .maybeSingle();

          if (existingJob?.status === "completed") {
            await setPendingStageJob(null);
            return {};
          }
          if (existingJob && existingJob.status !== "failed" && existingJob.status !== "cancelled") {
            // A prior attempt already dispatched this exact stage and (per
            // the transient-timeout retry above) we're back here because
            // that attempt's poll window ran out, not because the work
            // failed. Full-manuscript rewrites can genuinely take hours --
            // keep watching the SAME job instead of starting a costly
            // duplicate one.
            await pollJobUntilTerminal(pendingStageJob.jobId);
            await setPendingStageJob(null);
            return {};
          }
          // Not found, or it actually failed/cancelled: safe to dispatch fresh.
          await setPendingStageJob(null);
        }

        const queueRes = await fetch(new URL(path, baseUrl).toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie,
          },
          body: JSON.stringify({
            ...bodyPayload,
            serverManaged: true,
            metadataSnapshotId: selection.metadataSnapshotId || undefined,
            metadataBranchName: selection.metadataBranchName || undefined,
            metadataSelectionSource: selection.metadataSelectionSource || undefined,
          }),
        });
        const queueData = await queueRes.json().catch(() => ({}));
        if (!queueRes.ok || queueData.error) {
          throw new Error(String(queueData.error || `Stage queue failed: ${path}`));
        }
        const queuedContent = queueData.content as { jobId?: string; revisionJobId?: string } | undefined;
        const stageJobId = queuedContent?.jobId || queuedContent?.revisionJobId || (queueData.jobId as string | undefined);
        if (!stageJobId) {
          throw new Error(`Stage queue handoff missing job id: ${path}`);
        }
        await setPendingStageJob({ stage: currentStage, jobId: stageJobId });

        // The "run" call processes the entire stage synchronously within its
        // own HTTP response (e.g. a full-book rewrite across hundreds of
        // paragraphs) -- awaiting it directly can run well past Node's
        // default fetch timeout on this self-referential call, surfacing as
        // "fetch failed" and getting misread as an OpenRouter/provider
        // outage when the stage was actually still working. The manual
        // Studio Actions UI already solves this for the exact same
        // queue-then-run dispatch by firing the run request with `void` and
        // polling job status separately (see book-actions.tsx's
        // runQueuedGenerateDraft etc.) instead of awaiting one giant
        // response -- mirror that here. Give it a short window to respond
        // directly first so genuinely fast stages and real validation
        // errors still surface immediately.
        const runPromise = fetch(new URL(path, baseUrl).toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie,
          },
          body: JSON.stringify({
            ...bodyPayload,
            jobId: stageJobId,
            metadataSnapshotId: selection.metadataSnapshotId || undefined,
            metadataBranchName: selection.metadataBranchName || undefined,
            metadataSelectionSource: selection.metadataSelectionSource || undefined,
          }),
        }).then(async (runRes) => {
          const runData = await runRes.json().catch(() => ({}));
          if (!runRes.ok || runData.error) {
            throw new Error(String(runData.error || `Stage request failed: ${path}`));
          }
          return runData as Record<string, unknown>;
        });

        const QUICK_RESPONSE_WINDOW_MS = 15000;
        const quick = await Promise.race([
          runPromise.then((data) => ({ settled: true as const, data })),
          wait(QUICK_RESPONSE_WINDOW_MS).then(() => ({ settled: false as const, data: undefined })),
        ]);

        if (quick.settled) {
          await setPendingStageJob(null);
          return quick.data;
        }

        // Didn't respond quickly -- this is a genuinely long-running stage.
        // Stop waiting on this specific HTTP call (still processing
        // server-side regardless) and poll the job row instead. Swallow the
        // eventual settlement of runPromise either way so it never becomes
        // an unhandled rejection.
        runPromise.catch(() => {});
        await pollJobUntilTerminal(stageJobId);
        await setPendingStageJob(null);
        return {};
      }

      const res = await fetch(new URL(path, baseUrl).toString(), {
        method: payload !== undefined ? "POST" : "GET",
        headers: {
          "Content-Type": payload !== undefined ? "application/json" : undefined,
          cookie,
        } as Record<string, string>,
        body:
          payload !== undefined
            ? JSON.stringify({
                ...(payload as Record<string, unknown>),
                metadataSnapshotId: selection.metadataSnapshotId || undefined,
                metadataBranchName: selection.metadataBranchName || undefined,
                metadataSelectionSource: selection.metadataSelectionSource || undefined,
              })
            : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(String(data.error || `Stage request failed: ${path}`));
      }
      return data as Record<string, unknown>;
    };

    const supportsServerManagedHandoff = (path: string) =>
      path.includes("/analyze") ||
      path.includes("/chapters/summarize") ||
      path.includes("/critic") ||
      path.includes("/rewrite-plan") ||
      path.includes("/rewrite-execute") ||
      path.includes("/auto-revision") ||
      path.includes("/drift-check");

    const stageStatus = new Set(currentJob.stages_completed || []);
    const addStage = async (stage: string, message: string, extra?: Record<string, unknown>) => {
      await updateJob({
        stage,
        completedStageKey: stageStatusKey(stage, currentIteration),
        logEntry: { type: "stage_complete", stage, iteration: currentIteration, message, ...(extra || {}) },
      });
    };

    const mode = body.mode;
    const strategy = STRATEGY_BY_MODE[mode];

    const runStageWithRetry = async <T>(stage: string, execute: () => Promise<T>): Promise<T> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= STAGE_MAX_ATTEMPTS; attempt++) {
        try {
          return await execute();
        } catch (error) {
          lastError = error;
          const canRetry = isTransientStageError(error) && attempt < STAGE_MAX_ATTEMPTS;
          if (!canRetry) throw error;

          const delayMs = attempt * 2000;
          await updateJob({
            logEntry: {
              type: "info",
              iteration: currentIteration,
              message: `${stage} transient failure (${getError(error)}). Retrying ${attempt + 1}/${STAGE_MAX_ATTEMPTS} in ${Math.round(delayMs / 1000)}s.`,
            },
          });
          await wait(delayMs);
        }
      }
      throw lastError;
    };

    const stageOrder: string[] = [
      "analyze",
      "summarize",
      ...CRITIC_LENSES.map((lens) => `critic_baseline:${lens}`),
      "rewrite_plan",
      "rewrite_execute",
      "auto_accept",
      "drift_check",
      ...CRITIC_LENSES.map((lens) => `critic_post:${lens}`),
      "critics_check",
      "export",
      "mark_finished",
    ];

    if (currentJob.status !== "running") {
      await supabase.from("auto_review_jobs").update({ status: "running", current_stage: currentJob.current_stage || "analyze" }).eq("id", body.jobId);
    }

    let currentIteration = currentJob.iteration || 0;
    let exportId: string | null = currentJob.export_id;

    currentStage = currentJob.current_stage || "analyze";

    const workflowResult = await withBookForgeWorkflowSpan(
      {
        workflow: "auto-review",
        operation: "stage-orchestration",
        unitCount: stageOrder.length,
      },
      async (workflowSpan) => {
        workflowSpan.setAttributes({
          "bookforge.auto_review.start_stage": currentStage,
        });

        workflowSpan.addEvent("auto-review.invocation.start", {
          "auto-review.iteration": currentIteration,
          "auto-review.total_stages": stageOrder.length,
          "auto-review.start_stage": currentStage,
        });

        let stageIndex = 0;
        while (stageIndex < stageOrder.length) {
      const stage = stageOrder[stageIndex];
      if (stageStatus.has(stageStatusKey(stage, currentIteration))) {
        stageIndex += 1;
        continue;
      }
      currentStage = stage;

      // Mark the stage as actively in progress the moment it starts, not
      // just once it finishes. Long stages like rewrite_execute can now run
      // for many minutes (see the polling fix above) -- without this, the
      // wizard's UI has no way to tell a stage is running versus stalled,
      // since current_stage otherwise still points at the previous
      // (already-completed) stage for the entire duration.
      //
      // Also re-asserts status: "running" here, not just once at the top of
      // this request -- confirmed live: the opportunistic stale-job sweep
      // (detectAndHealStaleAutoReviewJobs) can race a resumed run within
      // milliseconds of it restarting, reading a snapshot from just before
      // the resume and writing status="failed" on a job that's actually
      // alive and about to keep completing real stages (proven by log
      // entries with later timestamps than the "failure"). There's no
      // cheap way to fully close that race without real locking, so this
      // self-heals it instead: every stage start corrects the status back
      // to "running", so a spurious mid-air "failed" from the sweep gets
      // overwritten within one stage's completion time rather than
      // sticking on the job forever while the backend quietly keeps
      // working underneath a UI that says it died.
      await supabase.from("auto_review_jobs").update({ current_stage: stage, status: "running" }).eq("id", body.jobId);

      try {
      if (stage === "analyze") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/analyze`, {}));
        await addStage(stage, "Manuscript analysis completed.");
      } else if (stage === "summarize") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/chapters/summarize`, {}));
        await addStage(stage, "Chapter summaries completed.");
      } else if (stage.startsWith("critic_baseline:")) {
        const lens = stage.split(":")[1];
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/critic`, { lens, stage: "baseline" }));
        await addStage(stage, `Baseline critic ${lens} completed.`);
      } else if (stage === "rewrite_plan") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/rewrite-plan`, {}));
        await addStage(stage, "Rewrite plan generated.");
      } else if (stage === "rewrite_execute") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/rewrite-execute`, {
          maxUnits: 5000,
          strategyId: strategy.strategyId,
          strategySettings: strategy.strategySettings,
          distributeAcrossChapters: true,
        }));
        await addStage(stage, "Rewrite execution completed.");
      } else if (stage === "auto_accept") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/auto-revision`, {
          action: "run",
          trustProfile: "full_trust",
          maxDecisions: 5000,
        }));
        await addStage(stage, "Auto-accept completed.");
      } else if (stage === "drift_check") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/drift-check`, {}));
        await addStage(stage, "Drift check completed.");
      } else if (stage.startsWith("critic_post:")) {
        const lens = stage.split(":")[1];
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/critic`, { lens, stage: "post_rewrite" }));
        await addStage(stage, `Post-rewrite critic ${lens} completed.`);
      } else if (stage === "critics_check") {
        const result = await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/auto-review/critics-check`));
        const allGreen = Boolean(result.allGreen);
        const greenCount = Number(result.greenCount || 0);
        const total = Number(result.total || 0);
        const avgScore = result.avgScore as number | null | undefined;
        await addStage(stage, allGreen ? "Quality gate passed." : "Quality gate requested another loop.", {
          allGreen,
          greenCount,
          total,
          avgScore,
        });
        if (!allGreen && currentIteration < MAX_ITERATIONS - 1) {
          currentIteration += 1;
          await updateJob({
            iteration: currentIteration,
            logEntry: {
              type: "info",
              iteration: currentIteration,
              message: `Starting rewrite iteration ${currentIteration + 1}`,
            },
          });
          // No need to clear stageStatus here: the next pass's stages are
          // recorded under `${stage}@${currentIteration}` keys (see
          // stageStatusKey), so this iteration's keys simply won't match
          // anything already in stageStatus.
          stageIndex = stageOrder.indexOf("rewrite_execute");
          continue;
        }
      } else if (stage === "export") {
        const result = await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/export`, {
          format: "docx",
          sourceMode: "accepted",
          includeFrontMatter: true,
          includeBackMatter: true,
        }));
        // /export isn't in supportsServerManagedHandoff's list, so callStage
        // returns its raw response body as-is -- {content: {exportId, ...}}
        // -- not a queue-stage's {jobId, ...} shape. Reading result.exportId
        // /result.export directly (neither exists on this response) always
        // fell through to the previous exportId, silently leaving the job's
        // export_id null even when the export genuinely succeeded -- found
        // live: a real completed export existed in the exports table with
        // no auto_review_jobs row ever pointing at it.
        const exportContent = result.content as { exportId?: string } | undefined;
        exportId = exportContent?.exportId || exportId;
        await addStage(stage, "Export completed.", { exportId });
      } else if (stage === "mark_finished") {
        await runStageWithRetry(stage, () => callStage(`/api/books/${bookId}/mark-finished`, { exportId }));
        await addStage(stage, "Book marked finished.");
      }
      } catch (error) {
        if (error instanceof StageCheckpointNeeded) {
          // Same self-chaining pattern as the between-stage checkpoint
          // below, but stageIndex is deliberately NOT advanced -- the next
          // invocation re-enters this SAME stage, finds pendingStageJob
          // already pointing at the in-progress rewrite-execute job, and
          // resumes dispatching its remaining chunks from there instead of
          // losing progress or restarting the stage.
          //
          // A bare un-awaited `void fetch(...)` is NOT safe here: Vercel is
          // free to freeze/tear down this function the instant the response
          // below is sent, before the request even leaves the machine.
          // after() is the platform-supported way to guarantee this
          // actually runs post-response -- found live: this exact gap is
          // why a real full-book rewrite never progressed past its first
          // chunk despite this self-chain already being in place.
          const continuationBody = JSON.stringify({ jobId: body.jobId, mode: body.mode });
          // Was `.catch(() => {})` -- swallowed every outcome (network error
          // or non-OK response alike) with zero trace anywhere. Same gap as
          // generate-draft had (see PR #233): confirmed live 2026-09-04 that
          // this exact same-route self-chain pattern gets killed by Vercel's
          // own infinite-loop protection (HTTP 508) once it decides this
          // function is calling itself too many times. Logging the real
          // outcome to auto_review_jobs.log surfaces it in the Auto-Review
          // Wizard UI (see auto-review-runner.tsx's log rendering) instead of
          // a silent stall.
          after(async () => {
            try {
              const res = await fetch(new URL(`/api/books/${bookId}/auto-review/process`, baseUrl).toString(), {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie },
                body: continuationBody,
              });
              if (!res.ok) {
                await updateJob({ logEntry: { type: "self_chain_failed", message: `Self-chain continuation returned HTTP ${res.status}.` } }).catch(() => {});
              }
            } catch (chainError) {
              const message = chainError instanceof Error ? chainError.message : String(chainError);
              await updateJob({ logEntry: { type: "self_chain_failed", message: `Self-chain continuation failed: ${message}` } }).catch(() => {});
            }
          });
          return NextResponse.json({ ok: true, jobId: body.jobId, checkpointed: true, nextStage: stage });
        }
        throw error;
      }
      stageIndex += 1;

      // Checkpoint at a clean stage boundary rather than letting Vercel
      // silently kill this request mid-loop once it runs past maxDuration --
      // that's the exact failure this replaces: no exception path, no log,
      // no further stage ever dispatched, the job just sits until an
      // unrelated staleness watchdog notices minutes later with a generic
      // error. Self-chains a continuation request (same fire-and-forget
      // pattern the wizard's own initial launch already uses) instead of
      // requiring the user to notice a stall and click Resume by hand.
      if (stageIndex < stageOrder.length && Date.now() - requestStartedAt > SELF_CONTINUE_AFTER_MS) {
        const continuationBody = JSON.stringify({ jobId: body.jobId, mode: body.mode });
        // Same failure-visibility fix as the checkpoint above -- see that
        // comment for why the swallowed `.catch(() => {})` mattered.
        after(async () => {
          try {
            const res = await fetch(new URL(`/api/books/${bookId}/auto-review/process`, baseUrl).toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json", cookie },
              body: continuationBody,
            });
            if (!res.ok) {
              await updateJob({ logEntry: { type: "self_chain_failed", message: `Self-chain continuation returned HTTP ${res.status}.` } }).catch(() => {});
            }
          } catch (chainError) {
            const message = chainError instanceof Error ? chainError.message : String(chainError);
            await updateJob({ logEntry: { type: "self_chain_failed", message: `Self-chain continuation failed: ${message}` } }).catch(() => {});
          }
        });
        return NextResponse.json({ ok: true, jobId: body.jobId, checkpointed: true, nextStage: stageOrder[stageIndex] });
      }
    }

        workflowSpan.setAttributes({
          "bookforge.auto_review.iteration": currentIteration,
          "bookforge.auto_review.completed_stages": stageStatus.size,
          "bookforge.auto_review.end_stage": currentStage,
        });

        workflowSpan.addEvent("auto-review.invocation.complete", {
          "auto-review.iteration": currentIteration,
          "auto-review.completed_stages": stageStatus.size,
        });
      },
    );
    if (workflowResult) return workflowResult;

    await updateJob({
      completed: true,
      exportId,
      logEntry: {
        type: "info",
        iteration: currentIteration,
        message: "Auto-review worker completed.",
      },
    });

    return NextResponse.json({ ok: true, jobId: body.jobId, exportId });
  } catch (error) {
    console.error("Auto-review worker failed", error);
    const modelSource = currentUserId
      ? await getUserLmStudioSettings(currentUserId)
          .then((settings) => settings.standardSettings?.provider)
          .catch(() => undefined)
      : undefined;
    const normalizedError = getLmStudioErrorMessage(error, getError(error), { task: currentStage, modelSource });
    const resumableError = `${normalizedError} Resume from Auto-Review Wizard and completed stages will be skipped.`;
    try {
      const { bookId } = await context.params;
      if (parsedBody?.jobId) {
        const supabase = await createClient();
        await supabase
          .from("auto_review_jobs")
          .update({ status: "failed", current_stage: currentStage, error: resumableError, completed_at: new Date().toISOString() })
          .eq("id", parsedBody.jobId)
          .eq("book_id", bookId);
      }
    } catch {
      // best effort
    }
    return NextResponse.json({ error: resumableError }, { status: 500 });
  }
}
