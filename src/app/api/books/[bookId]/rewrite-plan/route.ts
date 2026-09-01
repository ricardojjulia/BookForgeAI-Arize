import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildJobProgress,
  createRevisionJobHeartbeat,
  getRevisionJobStatus,
  updateRevisionJobProgress,
  waitWhileRevisionJobPaused,
} from "@/lib/ai/job-state";
import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { buildCloudRewriteModelSelection, selectBestRewriteModel } from "@/lib/ai/rewrite-model-suitability";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getReasoningModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel, shouldUseCloud } from "@/lib/lmstudio/orchestrator";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { resolveMetadataSnapshotContext } from "@/lib/book-metadata/timeline";
import { applyRewritePlanDefaults } from "@/lib/rewrite/plan-defaults";
import { buildRewritePlanPrompt } from "@/lib/rewrite/plan-prompt";
import { createClient } from "@/lib/supabase/server";

const CRITIC_LENS_VALUES = [
  "story_structure",
  "prose_quality",
  "continuity",
  "character_depth",
  "market_fit",
  "contemporary_view",
  "revision_priorities",
  "dialogue_density",
] as const;

const schema = z.object({
  jobId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
  metadataSnapshotId: z.string().uuid().optional(),
  metadataBranchName: z.string().min(1).max(80).optional(),
  focusLenses: z.array(z.enum(CRITIC_LENS_VALUES)).min(1).max(CRITIC_LENS_VALUES.length).optional(),
});

function getErrorMessage(error: unknown) {
  const lmStudioMessage = getLmStudioErrorMessage(error, "");
  if (lmStudioMessage) return lmStudioMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Rewrite plan generation failed.";
}

const REWRITE_PLAN_COMPLETION_TIMEOUT_MS =
  parsePositiveInteger(process.env.BOOKFORGE_REWRITE_PLAN_TIMEOUT_MS) ??
  300_000;

// A direct (non-serverManaged) call runs its model call synchronously
// in-request, with no explicit max_tokens (falls through to the account's
// general cloud output-budget setting, which can be sizable) -- no
// maxDuration meant this ran under Vercel's platform default rather than
// the 45s client-side SDK timeout, which a real cloud-model call can exceed
// on a slower model/tier. See src/lib/critic/run.ts for the incident this
// pattern traces back to.
// Must exceed BOOKFORGE_REWRITE_PLAN_TIMEOUT_MS (see below) or Vercel kills
// the function before the model-call timeout it's meant to allow ever fires.
export const maxDuration = 400;

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await context.params;
    const body = schema.parse(await readJsonBody(request));
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const metadataContext = await resolveMetadataSnapshotContext(supabase, bookId, {
      metadataSnapshotId: body.metadataSnapshotId || null,
      metadataBranchName: body.metadataBranchName || null,
    });
    const metadataSnapshotId = metadataContext.snapshot.id;
    const metadataBranchName = metadataContext.branchName;
    const metadataSelectionSource = metadataContext.sourceType;

    const startedAt = new Date().toISOString();
    const totalUnits = 1;
    let jobId = body.jobId || "";
    let jobStatus = "running";
    let jobSettings: unknown = {
      unit: "rewrite_plan",
      progress: buildJobProgress({
        taskName: "Generate Rewrite Architect plan",
        currentUnit: "Preparing rewrite plan context",
        totalUnits,
        attempted: 1,
        successful: 0,
        failed: 0,
        skipped: 0,
        startedAt,
        estimatedSecondsPerUnit: 35,
      }),
    };

    if (jobId) {
      const { data: existingJob, error: existingJobError } = await supabase
        .from("revision_jobs")
        .select("id,status,settings")
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id)
        .maybeSingle();
      if (existingJobError) throw existingJobError;
      if (!existingJob) return NextResponse.json({ error: "Rewrite plan job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Rewrite plan job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Rewrite plan job already failed." });
      jobStatus = String(existingJob.status || "running");
      jobSettings = existingJob.settings || jobSettings;
    } else {
      const status = body.serverManaged ? "queued" : "running";
      const { data: createdJob, error: createdJobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: "rewrite_plan",
          status,
          settings: {
            unit: "rewrite_plan",
            metadataSelectionSource,
            focusLenses: body.focusLenses || null,
            progress: buildJobProgress({
              taskName: "Generate Rewrite Architect plan",
              currentUnit: status === "queued" ? "Queued" : "Preparing rewrite plan context",
              totalUnits,
              attempted: 1,
              successful: 0,
              failed: 0,
              skipped: 0,
              startedAt: status === "running" ? startedAt : null,
              estimatedSecondsPerUnit: 35,
            }),
          },
          prompt_snapshot: "Rewrite Architect planning pass.",
          created_by: user.id,
          metadata_snapshot_id: metadataSnapshotId,
          started_at: status === "running" ? startedAt : null,
        })
        .select("id")
        .single();
      if (createdJobError) throw createdJobError;
      jobId = createdJob.id;
      jobStatus = status;

      if (body.serverManaged) {
        return NextResponse.json({ content: { jobId, queued: true, totalUnits, metadataSnapshotId, metadataBranchName, metadataSelectionSource } });
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

    const pauseStatus = await waitWhileRevisionJobPaused(supabase, jobId);
    if (pauseStatus === "cancelled") {
      const completedAt = new Date().toISOString();
      await supabase
        .from("revision_jobs")
        .update({
          status: "cancelled",
          completed_at: completedAt,
          settings: {
            unit: "rewrite_plan",
            progress: buildJobProgress({
              taskName: "Generate Rewrite Architect plan",
              currentUnit: "Cancelled",
              totalUnits,
              attempted: 0,
              successful: 0,
              failed: 0,
              skipped: 1,
              startedAt,
              completedAt,
              estimatedSecondsPerUnit: 35,
              message: "Rewrite plan generation cancelled before execution started.",
            }),
          },
        })
        .eq("id", jobId);
      return NextResponse.json({ ok: true, message: "Rewrite plan job cancelled." });
    }

    jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
      currentUnit: "Running Rewrite Architect planner",
      totalUnits,
      attempted: 1,
      successful: 0,
      failed: 0,
      skipped: 0,
    });

    const heartbeat = createRevisionJobHeartbeat(supabase, jobId, jobSettings, {
      currentUnit: "Running Rewrite Architect planner",
      totalUnits,
      attempted: 1,
      successful: 0,
      failed: 0,
      skipped: 0,
    });

    try {
      const [
        { data: book, error: bookError },
        { data: bible },
        { data: chapters, error: chaptersError },
        { data: reports, error: reportsError },
        { count: scenes },
        { count: paragraphs },
      ] = await Promise.all([
        supabase.from("books").select("title,genre,target_audience,dialog_density").eq("id", bookId).single(),
        supabase.from("book_bibles").select("content").eq("book_id", bookId).maybeSingle(),
        supabase
          .from("chapters")
          .select("chapter_number,title,summary")
          .eq("book_id", bookId)
          .order("chapter_number"),
        supabase
          .from("coherence_reports")
          .select("report_type,created_at,content")
          .eq("book_id", bookId)
          // Include post-rewrite reports too, not just baseline ones -- a
          // Critic run after a rewrite is the freshest signal available for
          // planning the *next* rewrite, and skipping it here made every
          // rewrite plan permanently seeded from whatever baseline existed
          // before the book was ever touched.
          .or("report_type.like.critic:%,report_type.like.critic_post:%")
          .order("created_at", { ascending: false })
          .limit(60),
        supabase.from("scenes").select("id", { count: "exact", head: true }).eq("book_id", bookId),
        supabase.from("paragraphs").select("id", { count: "exact", head: true }).eq("book_id", bookId),
      ]);

      if (bookError) throw bookError;
      if (chaptersError) throw chaptersError;
      if (reportsError) throw reportsError;

      const settings = await getUserLmStudioSettings(user.id);
      const modelPlan = await selectAndPrepareActiveModel(settings, {
        task: "planning",
        candidates: getReasoningModelCandidates(settings),
        expectedCalls: 1,
        latencyPreference: "quality",
        telemetry: { supabase, userId: user.id },
      });
      const { client, model, preparedModel, modelSelection, availableModels, telemetryContext } = modelPlan;
      // The upcoming rewrite pass may route to cloud even when this planning
      // call didn't (execution mode "auto" sends planning to cloud but
      // rewrite to local, or vice versa) — check the rewrite task
      // specifically, not whichever task this call happened to use.
      const rewriteModelSelection =
        shouldUseCloud(settings, "rewrite") && settings.standardSettings
          ? buildCloudRewriteModelSelection(settings.standardSettings)
          : selectBestRewriteModel(availableModels, {
              qualityProfile: settings.qualityProfile,
              contextWindowTokens: settings.contextWindowTokens,
            });
      const plan = estimateAiCallPlan({
        task: "critic",
        selectedModel: model,
        qualityProfile: settings.qualityProfile,
        contextWindowTokens: preparedModel.runtimeLimits.configuredContextTokens,
        maxOutputTokens: preparedModel.runtimeLimits.maxOutputTokens,
        chapterCount: chapters?.length || 0,
        sceneCount: scenes || 0,
        paragraphCount: paragraphs || 0,
      });

      const prompt = buildRewritePlanPrompt({
        title: book.title,
        genre: book.genre,
        targetAudience: book.target_audience,
        dialogDensity: book.dialog_density,
        manuscriptBlueprint: bible?.content,
        rewriteModelSelection,
        chapters: chapters || [],
        criticReports: reports || [],
        focusLenses: body.focusLenses,
        promptCharBudget: preparedModel.runtimeLimits.promptCharBudget,
      });

      const completion = await createManagedChatCompletion(
        client,
        preparedModel,
        {
          temperature: Math.min(settings.temperature, 0.35),
          top_p: settings.topP,
          messages: [{ role: "user", content: prompt }],
        },
        undefined,
        telemetryContext,
        { timeoutMs: REWRITE_PLAN_COMPLETION_TIMEOUT_MS },
      );

      const parsed = parseModelJsonOrFallback(completion.choices[0]?.message.content || "{}", (raw, parseError) => ({
        rewriteObjective: raw,
        globalGuardrails: [],
        coherenceContract: {},
        executionStrategy: {},
        phases: [],
        chapterRewriteDirectives: [],
        postRewriteCriticPasses: [],
        acceptanceCriteria: [],
        parseWarning: parseError,
      }));
      const content = applyRewritePlanDefaults(
        {
          ...(typeof parsed === "object" && parsed ? parsed : { rewriteObjective: String(parsed) }),
          aiCallPlan: {
            ...plan,
            expectedCalls: 1,
            actualCalls: 1,
            unitStrategy: "summaries",
          },
          sourceCriticReports: reports?.length || 0,
          focusLenses: body.focusLenses || null,
          rewriteModelSelection,
          plannerModelSelection: modelSelection,
          lmStudioRuntimeLimits: preparedModel.runtimeLimits,
          lmStudioWarnings: preparedModel.warnings,
          generatedAt: new Date().toISOString(),
        },
        { chapters: chapters || [] },
      );

      const { error: insertError } = await supabase.from("coherence_reports").insert({
        book_id: bookId,
        report_type: "rewrite_plan",
        metadata_snapshot_id: metadataSnapshotId,
        content,
      });
      if (insertError) throw insertError;

      const completedAt = new Date().toISOString();
      const finalStatus = await getRevisionJobStatus(supabase, jobId);
      const completedStatus = finalStatus === "cancelled" ? "cancelled" : "completed";
      const { error: finalJobError } = await supabase
        .from("revision_jobs")
        .update({
          status: completedStatus,
          completed_at: completedAt,
          settings: {
            unit: "rewrite_plan",
            progress: buildJobProgress({
              taskName: "Generate Rewrite Architect plan",
              currentUnit: completedStatus === "cancelled" ? "Cancelled" : "Complete",
              totalUnits,
              attempted: 1,
              successful: completedStatus === "cancelled" ? 0 : 1,
              failed: 0,
              skipped: completedStatus === "cancelled" ? 1 : 0,
              startedAt,
              completedAt,
              estimatedSecondsPerUnit: 35,
              message:
                completedStatus === "cancelled"
                  ? "Rewrite plan generation was cancelled during execution."
                  : "Rewrite Architect plan generated and saved.",
            }),
          },
        })
        .eq("id", jobId);
      if (finalJobError) throw finalJobError;

      return NextResponse.json({ content: { ...content, metadataSnapshotId, metadataBranchName, metadataSelectionSource }, revisionJobId: jobId });
    } catch (runError) {
      const completedAt = new Date().toISOString();
      const message = getErrorMessage(runError);
      await supabase
        .from("revision_jobs")
        .update({
          status: "failed",
          completed_at: completedAt,
          error_message: message,
          settings: {
            unit: "rewrite_plan",
            progress: buildJobProgress({
              taskName: "Generate Rewrite Architect plan",
              currentUnit: "Failed",
              totalUnits,
              attempted: 1,
              successful: 0,
              failed: 1,
              skipped: 0,
              startedAt,
              completedAt,
              estimatedSecondsPerUnit: 35,
              message,
            }),
          },
        })
        .eq("id", jobId);
      throw runError;
    } finally {
      heartbeat.stop();
    }
  } catch (error) {
    console.error("Rewrite plan generation failed", error);
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

function parsePositiveInteger(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
