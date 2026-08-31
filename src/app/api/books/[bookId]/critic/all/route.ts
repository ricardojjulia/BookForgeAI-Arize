import { NextResponse } from "next/server";
import { z } from "zod";
import { buildJobProgress, createRevisionJobHeartbeat, getRevisionJobStatus, updateRevisionJobProgress, waitWhileRevisionJobPaused } from "@/lib/ai/job-state";
import { resolveMetadataSnapshotContext } from "@/lib/book-metadata/timeline";
import { criticLenses } from "@/lib/critic/prompts";
import { preloadCriticModelExecution, preloadCriticRunContext, runCriticLens } from "@/lib/critic/run";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { bookHasDraftedParagraphs, UNDRAFTED_MANUSCRIPT_ERROR } from "@/lib/manuscript/draft-guard";
import { withBookForgeWorkflowSpan } from "@/lib/observability/workflow-span";
import { createClient } from "@/lib/supabase/server";
import type { CriticLens } from "@/lib/types";

const schema = z.object({
  stage: z.enum(["baseline", "post_rewrite"]).default("baseline"),
  jobId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
  metadataSnapshotId: z.string().uuid().optional(),
  metadataBranchName: z.string().min(1).max(80).optional(),
});

const LOCAL_CRITIC_CONCURRENCY = 2;

function getErrorMessage(error: unknown) {
  const lmStudioMessage = getLmStudioErrorMessage(error, "");
  if (lmStudioMessage) return lmStudioMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "BookForge Critic batch failed.";
}

// Runs up to 8 lenses sequentially in one invocation -- same undersized-
// timeout risk as src/app/api/books/[bookId]/critic/route.ts (see that
// file's comment), just multiplied. Near Vercel Pro's 800s ceiling; a real
// worst-case run (every lens needing the full ~140s a slow cloud model can
// take) can still exceed even this -- not fully solved by a bigger number,
// same residual risk noted on the architecture route.
export const maxDuration = 780;

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await context.params;
    const body = schema.parse(await readJsonBody(request));
    const stage = body.stage;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    if (!(await bookHasDraftedParagraphs(supabase, bookId))) {
      return NextResponse.json({ error: UNDRAFTED_MANUSCRIPT_ERROR }, { status: 400 });
    }

    const metadataContext = await resolveMetadataSnapshotContext(supabase, bookId, {
      metadataSnapshotId: body.metadataSnapshotId || null,
      metadataBranchName: body.metadataBranchName || null,
    });
    const metadataSnapshotId = metadataContext.snapshot.id;
    const metadataBranchName = metadataContext.branchName;
    const metadataSelectionSource = metadataContext.sourceType;

    const lenses = Object.keys(criticLenses) as CriticLens[];
    const startedAt = new Date().toISOString();
    let jobId = body.jobId || "";
    let jobStatus = "running";
    let batchStage = stage;
    let jobSettings: unknown = { stage: batchStage, unit: "critic_lens" };

    if (jobId) {
      const { data: existingJob, error: existingJobError } = await supabase
        .from("revision_jobs")
        .select("id,status,settings")
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id)
        .single();
      if (existingJobError) throw existingJobError;
      if (!existingJob) return NextResponse.json({ error: "Critic batch job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Critic batch job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Critic batch job already failed." });
      jobStatus = String(existingJob.status || "running");
      jobSettings = existingJob.settings || jobSettings;
      if (jobSettings && typeof jobSettings === "object" && "stage" in jobSettings) {
        const persistedStage = String((jobSettings as { stage?: unknown }).stage || "");
        if (persistedStage === "baseline" || persistedStage === "post_rewrite") {
          batchStage = persistedStage;
        }
      }
    } else {
      const status = body.serverManaged ? "queued" : "running";
      const { data: job, error: jobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: "bookforge_critic_batch",
          status,
          settings: {
            stage: batchStage,
            unit: "critic_lens",
            metadataSelectionSource,
            metadataSnapshotId,
            metadataBranchName,
            progress: buildJobProgress({
              taskName: "Run all BookForge Critic lenses",
              currentUnit: `Critic lens 1 of ${lenses.length}`,
              totalUnits: lenses.length,
              attempted: 0,
              successful: 0,
              failed: 0,
              skipped: 0,
              startedAt,
              estimatedSecondsPerUnit: 35,
            }),
          },
          prompt_snapshot: "BookForge Critic batch: all prebuilt lenses.",
          created_by: user.id,
          metadata_snapshot_id: metadataSnapshotId,
          started_at: status === "running" ? startedAt : null,
        })
        .select("id")
        .single();
      if (jobError) throw jobError;
      jobId = job.id;
      jobStatus = status;

      if (body.serverManaged) {
        return NextResponse.json({ content: { jobId, queued: true, totalUnits: lenses.length, metadataSnapshotId, metadataBranchName, metadataSelectionSource } });
      }
    }

    if (jobStatus !== "running") {
      await supabase
        .from("revision_jobs")
        .update({ status: "running", started_at: startedAt })
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id);
    }

    const results: Array<{ lens: CriticLens; score: unknown }> = [];
    const failedUnits: Array<{ id: CriticLens; type: "critic_lens"; label: string; error: string }> = [];
    let attempted = 0;
    let failed = 0;
    const preloadedContext = await preloadCriticRunContext({
      supabase,
      bookId,
      stage: batchStage,
    });
    const modelExecution = await preloadCriticModelExecution(supabase, user.id);
    const criticConcurrency = modelExecution.modelPlan.preparedModel.isCloud
      ? lenses.length
      : LOCAL_CRITIC_CONCURRENCY;

    const pauseStatus = await waitWhileRevisionJobPaused(supabase, jobId);
    const preDispatchStatus = pauseStatus === "cancelled" ? "cancelled" : await getRevisionJobStatus(supabase, jobId);

    // All 8 lenses are independent, read-only evaluations of the same static
    // context. Cloud providers can genuinely parallelize them, but a local LM
    // Studio server usually shares one loaded model/GPU; cap local concurrency
    // so late lenses do not spend most of their timeout waiting in provider
    // queue. Shared state is still only touched in the sequential loop below.
    jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
      currentUnit: `Running all ${lenses.length} critic lenses`,
      totalUnits: lenses.length,
      attempted: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
    });
    const heartbeat = createRevisionJobHeartbeat(supabase, jobId, jobSettings, {
      currentUnit: `Running all ${lenses.length} critic lenses`,
      totalUnits: lenses.length,
      attempted: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
    });
    const settled =
      preDispatchStatus === "cancelled"
        ? []
        : await withBookForgeWorkflowSpan(
            {
              workflow: "critic",
              operation: "all-lenses",
              stage: batchStage,
              unitCount: lenses.length,
            },
            async (workflowSpan) => {
              workflowSpan.addEvent("critic.batch.start", {
                "critic.lens_count": lenses.length,
              });

              const results = await mapWithConcurrency(
                lenses,
                criticConcurrency,
                (lens) =>
                  runCriticLens({
                    supabase,
                    bookId,
                    userId: user.id,
                    lens,
                    stage: batchStage,
                    preloadedContext,
                    modelExecution,
                  }),
              );

              const successful = results.filter(
                (result) => result.status === "fulfilled",
              ).length;

              workflowSpan.setAttributes({
                "bookforge.workflow.successful_units": successful,
                "bookforge.workflow.failed_units":
                  results.length - successful,
              });

              workflowSpan.addEvent("critic.batch.complete", {
                "critic.successful_lenses": successful,
                "critic.failed_lenses": results.length - successful,
              });

              return results;
            },
          );
    heartbeat.stop();

    for (const [index, lens] of lenses.entries()) {
      const currentStatus = await getRevisionJobStatus(supabase, jobId);
      if (currentStatus === "cancelled") break;

      attempted += 1;
      const result = settled[index];
      if (result.status === "fulfilled") {
        results.push({ lens, score: result.value.score });
      } else {
        failed += 1;
        const message = getErrorMessage(result.reason);
        failedUnits.push({ id: lens, type: "critic_lens", label: criticLenses[lens].label, error: message });
      }
      jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
        currentUnit: attempted >= lenses.length ? "Finalizing critic batch" : `Critic lens ${attempted + 1} of ${lenses.length}`,
        totalUnits: lenses.length,
        attempted,
        successful: results.length,
        failed,
        skipped: 0,
        failedUnits,
      });
    }

    if (results.length === 0 && failed > 0) {
      throw new Error(`All critic lenses failed (${failed}/${lenses.length}).`);
    }

    await supabase.from("coherence_reports").insert({
      book_id: bookId,
      metadata_snapshot_id: metadataSnapshotId,
      report_type: batchStage === "post_rewrite" ? "critic_post_batch" : "critic_batch",
      content: {
        stage: batchStage,
        metadataSnapshotId,
        metadataBranchName,
        completedAt: new Date().toISOString(),
        results,
        failed,
        failedUnits,
      },
    });

    const completedAt = new Date().toISOString();
    const finalStatus = await getRevisionJobStatus(supabase, jobId);
    const completedStatus = finalStatus === "cancelled" ? "cancelled" : "completed";
    const { error: finalJobError } = await supabase
      .from("revision_jobs")
      .update({
        status: completedStatus,
        completed_at: completedAt,
        settings: {
          stage: batchStage,
          unit: "critic_lens",
          metadataSelectionSource,
          metadataSnapshotId,
          metadataBranchName,
          progress: buildJobProgress({
            taskName: "Run all BookForge Critic lenses",
            currentUnit: completedStatus === "cancelled" ? "Cancelled" : "Complete",
            totalUnits: lenses.length,
            attempted,
            successful: results.length,
            failed,
            skipped: completedStatus === "cancelled" ? Math.max(0, lenses.length - attempted) : 0,
            failedUnits,
            startedAt,
            completedAt,
            estimatedSecondsPerUnit: 35,
            message:
              completedStatus === "cancelled"
                ? "Critic batch cancelled. Completed reports were saved."
                : failed > 0
                  ? `${failed} critic lens(es) failed. Completed reports were saved.`
                  : "All BookForge Critic reports saved.",
          }),
        },
      })
      .eq("id", jobId);
    if (finalJobError) throw finalJobError;

    return NextResponse.json({
      content: {
        stage: batchStage,
        completed: results.length,
        failed,
        failedUnits,
        results,
        metadataSnapshotId,
        metadataBranchName,
        metadataSelectionSource,
      },
    });
  } catch (error) {
    console.error("BookForge Critic batch failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await fn(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
