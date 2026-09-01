import { NextResponse } from "next/server";
import { z } from "zod";
import { buildJobProgress, createRevisionJobHeartbeat, getRevisionJobStatus, updateRevisionJobProgress, waitWhileRevisionJobPaused } from "@/lib/ai/job-state";
import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getExtractionModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel } from "@/lib/lmstudio/orchestrator";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { buildChapterSummaryPrompt } from "@/lib/prompts/builders";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  chapterIds: z.array(z.string().uuid()).optional(),
  retryJobId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
});

type RetryJobSettings = {
  progress?: {
    failedUnits?: Array<{ id?: string; type?: string }>;
  };
};

function getErrorMessage(
  error: unknown,
  context: { model?: string; task?: string; modelSource?: string; configuredModels?: string[] } = {},
) {
  const lmStudioMessage = getLmStudioErrorMessage(error, "", context);
  if (lmStudioMessage) return lmStudioMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Chapter summary generation failed.";
}

// A direct (non-serverManaged) call runs one createManagedChatCompletion
// call per chapter, sequentially, all inside this one request -- unlike the
// single-call routes fixed alongside this one, the per-chapter timeout
// override isn't enough by itself; the route's own overall budget has to
// cover every chapter in the book, not just one call. Near Vercel Pro's
// 800s ceiling; a book with enough chapters can still exceed even this --
// same residual risk already noted on critic/all and creation/architecture.
export const maxDuration = 780;

const DEFAULT_CHAPTER_SUMMARY_TIMEOUT_MS = 240_000;

// Same hardcoded-timeout-too-short bug already found and fixed on
// rewrite-plan and analyze (see those routes) -- this one was missed in
// the same sweep. Env-configurable per the same reasoning.
function getChapterSummaryTimeoutMs() {
  const raw = process.env.BOOKFORGE_CHAPTER_SUMMARY_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHAPTER_SUMMARY_TIMEOUT_MS;
}

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await context.params;
    const body = schema.parse(await readJsonBody(request));
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const retryChapterIds = body.retryJobId ? await getRetryChapterIds(supabase, body.retryJobId) : null;
    let chaptersQuery = supabase
      .from("chapters")
      .select("id,title,chapter_number,original_text")
      .eq("book_id", bookId)
      .order("chapter_number");

    if (retryChapterIds?.size) {
      chaptersQuery = chaptersQuery.in("id", Array.from(retryChapterIds));
    } else if (body.chapterIds?.length) {
      chaptersQuery = chaptersQuery.in("id", body.chapterIds);
    }

    const [{ data: chapters, error: chaptersError }, { count: scenes }, { count: paragraphs }] =
      await Promise.all([
        chaptersQuery,
        supabase.from("scenes").select("id", { count: "exact", head: true }).eq("book_id", bookId),
        supabase.from("paragraphs").select("id", { count: "exact", head: true }).eq("book_id", bookId),
      ]);
    if (chaptersError) throw chaptersError;

    const chapterRows = chapters || [];
    if (!chapterRows.length) {
      return NextResponse.json({
        content: {
          summarized: 0,
          aiCallPlan: { expectedCalls: 0, actualCalls: 0, unitStrategy: "chapters" },
        },
      });
    }

    const settings = await getUserLmStudioSettings(user.id);
    const modelPlan = await selectAndPrepareActiveModel(settings, {
      task: "extraction",
      candidates: getExtractionModelCandidates(settings),
      expectedCalls: chapterRows.length,
      latencyPreference: settings.qualityProfile === "premium" ? "quality" : "balanced",
      allowUnload: chapterRows.length >= 3,
      telemetry: { supabase, userId: user.id },
    });
    const { client, model, preparedModel, modelSelection, telemetryContext } = modelPlan;
    const plan = estimateAiCallPlan({
      task: "book-bible",
      selectedModel: model,
      qualityProfile: settings.qualityProfile,
      contextWindowTokens: preparedModel.runtimeLimits.configuredContextTokens,
      maxOutputTokens: preparedModel.runtimeLimits.maxOutputTokens,
      chapterCount: chapterRows.length,
      sceneCount: scenes || 0,
      paragraphCount: paragraphs || 0,
    });

    const startedAt = new Date().toISOString();
    let jobId = body.jobId || "";
    let jobStatus = "running";
    let jobSettings: unknown = {
      model,
      preparedModel,
      modelSource: modelSelection.source,
      configuredModelFallbackOrder: modelSelection.configuredModels,
      availableModels: modelSelection.availableModels,
      usedLoadedFallback: modelSelection.usedLoadedFallback,
      unit: "chapter",
      chapterIds: body.chapterIds || null,
      retryJobId: body.retryJobId || null,
    };

    if (jobId) {
      const { data: existingJob, error: existingJobError } = await supabase
        .from("revision_jobs")
        .select("id,status,settings")
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id)
        .single();
      if (existingJobError) throw existingJobError;
      if (!existingJob) return NextResponse.json({ error: "Summary job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Summary job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Summary job already failed." });
      jobStatus = String(existingJob.status || "running");
      jobSettings = existingJob.settings || jobSettings;
    } else {
      const status = body.serverManaged ? "queued" : "running";
      const { data: job, error: jobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: "chapter_summaries",
          status,
          settings: {
            model,
            preparedModel,
            modelSource: modelSelection.source,
            configuredModelFallbackOrder: modelSelection.configuredModels,
            availableModels: modelSelection.availableModels,
            usedLoadedFallback: modelSelection.usedLoadedFallback,
            unit: "chapter",
            chapterIds: body.chapterIds || null,
            retryJobId: body.retryJobId || null,
            progress: buildJobProgress({
              taskName: "Generate chapter summaries",
              currentUnit: chapterRows.length ? `Chapter 1 of ${chapterRows.length}` : "No chapters",
              totalUnits: chapterRows.length,
              attempted: 0,
              successful: 0,
              failed: 0,
              skipped: 0,
              startedAt,
              estimatedSecondsPerUnit: plan.estimatedSecondsPerCall,
            }),
          },
          prompt_snapshot: "Chapter summary extractor: one focused LM Studio call per chapter.",
          created_by: user.id,
          started_at: status === "running" ? startedAt : null,
        })
        .select("id")
        .single();
      if (jobError) throw jobError;
      jobId = job.id;
      jobStatus = status;

      if (body.serverManaged) {
        return NextResponse.json({ content: { jobId, queued: true, totalUnits: chapterRows.length } });
      }
    }

    const results = [];
    let attempted = 0;
    let failed = 0;

    if (jobStatus !== "running") {
      await supabase
        .from("revision_jobs")
        .update({ status: "running", started_at: startedAt })
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id);
    }

    for (const [index, chapter] of chapterRows.entries()) {
      const pauseStatus = await waitWhileRevisionJobPaused(supabase, jobId);
      if (pauseStatus === "cancelled") break;
      const currentStatus = await getRevisionJobStatus(supabase, jobId);
      if (currentStatus === "cancelled") break;

      attempted += 1;
      const chapterLabel = formatChapterProgressLabel(chapter.chapter_number, chapter.title);
      jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
        currentUnit: `${chapterLabel} (${index + 1}/${chapterRows.length})`,
        totalUnits: chapterRows.length,
        attempted,
        successful: results.length,
        failed,
        skipped: 0,
      });
      const heartbeat = createRevisionJobHeartbeat(supabase, jobId, jobSettings, {
        currentUnit: `${chapterLabel} (${index + 1}/${chapterRows.length})`,
        totalUnits: chapterRows.length,
        attempted,
        successful: results.length,
        failed,
        skipped: 0,
      });
      const title = chapter.title || `Chapter ${chapter.chapter_number}`;
      try {
        const prompt = buildChapterSummaryPrompt({ title, text: chapter.original_text || "" });

        const completion = await createManagedChatCompletion(
          client,
          preparedModel,
          {
            temperature: Math.min(settings.temperature, 0.45),
            top_p: settings.topP,
            max_tokens: 1800,
            messages: [{ role: "user", content: prompt }],
          },
          undefined,
          telemetryContext,
          { timeoutMs: getChapterSummaryTimeoutMs() },
        );

        const raw = completion.choices[0]?.message.content || "{}";
        const parsed = parseChapterSummaryModelResponse(raw);
        const summary = extractSummary(parsed);

        const { error: updateError } = await supabase
          .from("chapters")
          .update({
            summary,
            status: "summarized",
            updated_at: new Date().toISOString(),
          })
          .eq("id", chapter.id);
        if (updateError) throw updateError;

        results.push({
          chapterId: chapter.id,
          chapterNumber: chapter.chapter_number,
          title,
          summary,
          analysis: parsed,
        });
        jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
          currentUnit: index + 1 >= chapterRows.length ? "Finalizing summaries" : `Chapter ${index + 2} of ${chapterRows.length}`,
          totalUnits: chapterRows.length,
          attempted,
          successful: results.length,
          failed,
          skipped: 0,
          failedUnits: [],
        });
      } catch (chapterError) {
        failed += 1;
        const message = getErrorMessage(chapterError, {
          model,
          task: "Generate Chapter Summaries",
          modelSource: modelSelection.source,
          configuredModels: modelSelection.configuredModels,
        });
        jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
          currentUnit: `Failed at chapter ${chapter.chapter_number}`,
          totalUnits: chapterRows.length,
          attempted,
          successful: results.length,
          failed,
          skipped: 0,
          message,
          failedUnits: [
            {
              id: chapter.id,
              type: "chapter",
              label: chapterLabel,
              error: message,
            },
          ],
        });
        throw chapterError;
      } finally {
        heartbeat.stop();
      }
    }

    const completedAt = new Date().toISOString();
    const finalStatus = await getRevisionJobStatus(supabase, jobId);
    const completedStatus = finalStatus === "cancelled" ? "cancelled" : "completed";
    const { error: finalJobError } = await supabase
      .from("revision_jobs")
      .update({
        status: completedStatus,
        completed_at: completedAt,
        settings: {
          model,
          modelSource: modelSelection.source,
          configuredModelFallbackOrder: modelSelection.configuredModels,
          availableModels: modelSelection.availableModels,
          usedLoadedFallback: modelSelection.usedLoadedFallback,
          unit: "chapter",
          chapterIds: body.chapterIds || null,
          retryJobId: body.retryJobId || null,
          progress: buildJobProgress({
            taskName: "Generate chapter summaries",
            currentUnit: completedStatus === "cancelled" ? "Cancelled" : "Complete",
            totalUnits: chapterRows.length,
            attempted,
            successful: results.length,
            failed,
            skipped: completedStatus === "cancelled" ? Math.max(0, chapterRows.length - attempted) : 0,
            failedUnits: [],
            startedAt,
            completedAt,
            estimatedSecondsPerUnit: plan.estimatedSecondsPerCall,
            message:
              completedStatus === "cancelled"
                ? "Summary job cancelled. Completed chapter summaries were saved."
                : "Chapter summaries saved and ready for rewrite context.",
          }),
        },
      })
      .eq("id", jobId);
    if (finalJobError) throw finalJobError;

    return NextResponse.json({
      content: {
        summarized: results.length,
        chapters: results.map(({ chapterNumber, title, summary }) => ({ chapterNumber, title, summary })),
        aiCallPlan: {
          ...plan,
          expectedCalls: chapterRows.length,
          actualCalls: results.length,
          unitStrategy: "chapters",
        },
      },
    });
  } catch (error) {
    console.error("Chapter summary generation failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

async function getRetryChapterIds(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  jobId: string,
) {
  const { data, error } = await supabase.from("revision_jobs").select("settings").eq("id", jobId).single();
  if (error) throw error;
  const settings = data.settings as RetryJobSettings | null;
  const ids = (settings?.progress?.failedUnits || [])
    .filter((unit) => unit.type === "chapter" && unit.id)
    .map((unit) => String(unit.id));
  return ids.length ? new Set(ids) : new Set<string>();
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function parseChapterSummaryModelResponse(content: string) {
  return parseModelJsonOrFallback(content, (raw, parseError) => ({
    chapterSummary: raw,
    charactersPresent: [],
    locations: [],
    importantEvents: [],
    emotionalBeats: [],
    motifs: [],
    timelineNotes: [],
    continuityNotes: [],
    parseWarning: parseError,
  }));
}

function extractSummary(parsed: unknown) {
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const summary = object.chapterSummary || object.summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
  }

  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  return "Summary generated, but the model returned an empty summary field.";
}

function formatChapterProgressLabel(chapterNumber: number, title?: string | null) {
  const fallback = `Chapter ${chapterNumber}`;
  const trimmed = title?.trim();
  if (!trimmed) return fallback;
  return new RegExp(`^chapter\\s+${chapterNumber}(\\b|\\s*[:.-])`, "i").test(trimmed)
    ? trimmed
    : `${fallback}: ${trimmed}`;
}
