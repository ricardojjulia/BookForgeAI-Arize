import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildJobProgress, createRevisionJobHeartbeat, getRevisionJobStatus, updateRevisionJobProgress, waitWhileRevisionJobPaused } from "@/lib/ai/job-state";
import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { buildBookBiblePrompt } from "@/lib/prompts/builders";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getExtractionModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel } from "@/lib/lmstudio/orchestrator";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { createClient } from "@/lib/supabase/server";
import { persistWorldDiscovery } from "@/lib/world/discovery-server";

const schema = z.object({
  retryJobId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
  discoverWorldBible: z.boolean().optional(),
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
  return "Analysis failed.";
}

const ANALYZE_CHUNK_COMPLETION_TIMEOUT_MS =
  parsePositiveInteger(process.env.BOOKFORGE_ANALYZE_CHUNK_TIMEOUT_MS) ??
  300_000;

// A direct (non-serverManaged) call runs one createManagedChatCompletion
// call per manuscript chunk, sequentially, all inside this one request --
// chunk count is unbounded (the whole manuscript), so this needs the
// biggest budget of this batch of fixes. Near Vercel Pro's 800s ceiling; a
// long enough manuscript can still exceed even this -- same residual risk
// already noted on critic/all, creation/architecture, and chapters/summarize.
export const maxDuration = 780;

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  let discoveryContext: {
    bookId: string;
    supabase: Awaited<ReturnType<typeof createClient>>;
  } | null = null;
  try {
    const { bookId } = await context.params;
    const body = schema.parse(await readJsonBody(request));
    const supabase = await createClient();
    if (body.discoverWorldBible) discoveryContext = { bookId, supabase };
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const [{ data: chapters, error }, { count: scenes }, { count: paragraphs }] = await Promise.all([
      supabase.from("chapters").select("id,chapter_number,title,original_text").eq("book_id", bookId).order("chapter_number"),
      supabase.from("scenes").select("id", { count: "exact", head: true }).eq("book_id", bookId),
      supabase.from("paragraphs").select("id", { count: "exact", head: true }).eq("book_id", bookId),
    ]);
    if (error) throw error;
    if (body.discoverWorldBible) {
      if (!(chapters || []).some((chapter) => chapter.original_text.trim())) {
        return NextResponse.json({ error: "Add manuscript text before discovering the World Bible." }, { status: 400 });
      }
      if (!body.jobId) {
        const { error: statusError } = await supabase
          .from("books")
          .update({ world_bible_status: "processing", world_bible_processed: false })
          .eq("id", bookId);
        if (statusError) throw statusError;
      }
    }

    const settings = await getUserLmStudioSettings(user.id);
    const modelPlan = await selectAndPrepareActiveModel(settings, {
      task: "extraction",
      candidates: getExtractionModelCandidates(settings),
      expectedCalls: Math.max(1, chapters?.length || 1),
      latencyPreference: settings.qualityProfile === "premium" ? "quality" : "balanced",
      allowUnload: true,
      telemetry: { supabase, userId: user.id },
    });
    const { client, model, preparedModel, modelSelection, telemetryContext } = modelPlan;
    const plan = estimateAiCallPlan({
      task: "book-bible",
      selectedModel: model,
      qualityProfile: settings.qualityProfile,
      contextWindowTokens: preparedModel.runtimeLimits.configuredContextTokens,
      maxOutputTokens: preparedModel.runtimeLimits.maxOutputTokens,
      chapterCount: chapters?.length || 0,
      sceneCount: scenes || 0,
      paragraphCount: paragraphs || 0,
    });
    const runtimePromptTokenBudget = Math.max(900, Math.floor(preparedModel.runtimeLimits.promptCharBudget / 4));
    const chunkingTokenBudget = Math.max(700, Math.min(plan.targetTokensPerCall, runtimePromptTokenBudget));
    const allChunks = chunkChaptersForModel(chapters || [], chunkingTokenBudget).map((chunk, index) => ({
      ...chunk,
      chunkNumber: index + 1,
    }));
    const retryChunkNumbers = body.retryJobId ? await getRetryAnalysisChunkNumbers(supabase, body.retryJobId) : null;
    const chunks = retryChunkNumbers?.size
      ? allChunks.filter((_, index) => retryChunkNumbers.has(index + 1))
      : allChunks;
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
      unit: "analysis_chunk",
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
      if (!existingJob) return NextResponse.json({ error: "Blueprint job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Blueprint job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Blueprint job already failed." });
      jobStatus = String(existingJob.status || "running");
      jobSettings = existingJob.settings || jobSettings;
    } else {
      const status = body.serverManaged ? "queued" : "running";
      const { data: job, error: jobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: body.discoverWorldBible ? "world_bible_discovery" : "manuscript_blueprint",
          status,
          settings: {
            model,
            preparedModel,
            modelSource: modelSelection.source,
            configuredModelFallbackOrder: modelSelection.configuredModels,
            availableModels: modelSelection.availableModels,
            usedLoadedFallback: modelSelection.usedLoadedFallback,
            unit: "analysis_chunk",
            retryJobId: body.retryJobId || null,
            retryChunkNumbers: retryChunkNumbers ? Array.from(retryChunkNumbers) : null,
            discoverWorldBible: Boolean(body.discoverWorldBible),
            progress: buildJobProgress({
              taskName: body.discoverWorldBible ? "Discover World Bible with AI" : "Generate Manuscript Blueprint",
              currentUnit: chunks.length ? `Analysis chunk 1 of ${chunks.length}` : "No chunks",
              totalUnits: chunks.length,
              attempted: 0,
              successful: 0,
              failed: 0,
              skipped: 0,
              startedAt,
              estimatedSecondsPerUnit: plan.estimatedSecondsPerCall,
            }),
          },
          prompt_snapshot: body.discoverWorldBible
            ? "World Bible discovery: chunked manuscript extraction followed by normalized entity persistence."
            : "Manuscript Blueprint analysis: chunked manuscript extraction with no invented full-book facts.",
          created_by: user.id,
          started_at: status === "running" ? startedAt : null,
        })
        .select("id")
        .single();
      if (jobError) throw jobError;
      jobId = job.id;
      jobStatus = status;

      if (body.serverManaged) {
        return NextResponse.json({ content: { jobId, queued: true, totalUnits: chunks.length } });
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
    const partials = [];
    let attempted = 0;
    let failed = 0;

    for (const [index, chunk] of chunks.entries()) {
      const pauseStatus = await waitWhileRevisionJobPaused(supabase, jobId);
      if (pauseStatus === "cancelled") break;
      const currentStatus = await getRevisionJobStatus(supabase, jobId);
      if (currentStatus === "cancelled") break;

      attempted += 1;
      jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
        currentUnit: `Analysis chunk ${index + 1} of ${chunks.length} · chapters ${chunk.chapterRange}`,
        totalUnits: chunks.length,
        attempted,
        successful: partials.length,
        failed,
        skipped: 0,
      });
      const heartbeat = createRevisionJobHeartbeat(supabase, jobId, jobSettings, {
        currentUnit: `Analysis chunk ${index + 1} of ${chunks.length} · chapters ${chunk.chapterRange}`,
        totalUnits: chunks.length,
        attempted,
        successful: partials.length,
        failed,
        skipped: 0,
      });

      try {
        const prompt = buildBookBiblePrompt(
          [
            `This is manuscript analysis chunk ${chunk.chunkNumber} of ${allChunks.length}.`,
            "Extract only what is visible in this chunk. Do not invent full-book facts.",
            chunk.text,
          ].join("\n\n"),
          {
            maxSampleChars: Math.max(2200, Math.floor(preparedModel.runtimeLimits.promptCharBudget * 0.72)),
          },
        );

        const completion = await createManagedChatCompletion(
          client,
          preparedModel,
          {
            temperature: settings.temperature,
            top_p: settings.topP,
            messages: [{ role: "user", content: prompt }],
          },
          undefined,
          telemetryContext,
          { timeoutMs: ANALYZE_CHUNK_COMPLETION_TIMEOUT_MS },
        );

        const content = completion.choices[0]?.message.content || "{}";
        partials.push({
          chunkNumber: chunk.chunkNumber,
          chapterRange: chunk.chapterRange,
          content: parseBookBibleModelResponse(content),
        });
        jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
          currentUnit: index + 1 >= chunks.length ? "Merging blueprint" : `Analysis chunk ${index + 2} of ${chunks.length}`,
          totalUnits: chunks.length,
          attempted,
          successful: partials.length,
          failed,
          skipped: 0,
          failedUnits: [],
        });
      } catch (chunkError) {
        failed += 1;
        const message = getErrorMessage(chunkError, {
          model,
          task: "Generate Manuscript Blueprint",
          modelSource: modelSelection.source,
          configuredModels: modelSelection.configuredModels,
        });
        jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
          currentUnit: `Failed at analysis chunk ${chunk.chunkNumber}`,
          totalUnits: chunks.length,
          attempted,
          successful: partials.length,
          failed,
          skipped: 0,
          message,
          failedUnits: [
            {
              id: String(chunk.chunkNumber),
              type: "analysis_chunk",
              label: `Analysis chunk ${chunk.chunkNumber} · chapters ${chunk.chapterRange}`,
              error: message,
            },
          ],
        });
        const completedAt = new Date().toISOString();
        const failedJobSettings =
          jobSettings && typeof jobSettings === "object"
            ? (jobSettings as Record<string, unknown>)
            : {};
        const failedJobProgress =
          failedJobSettings.progress && typeof failedJobSettings.progress === "object"
            ? (failedJobSettings.progress as Record<string, unknown>)
            : {};
        const { error: failedJobError } = await supabase
          .from("revision_jobs")
          .update({
            status: "failed",
            completed_at: completedAt,
            error_message: message,
            settings: {
              ...failedJobSettings,
              progress: buildJobProgress({
                ...failedJobProgress,
                currentUnit: `Failed at analysis chunk ${chunk.chunkNumber}`,
                totalUnits: chunks.length,
                attempted,
                successful: partials.length,
                failed,
                skipped: 0,
                message,
                completedAt,
              }),
            },
          })
          .eq("id", jobId);
        if (failedJobError) throw failedJobError;
        throw chunkError;
      } finally {
        heartbeat.stop();
      }
    }

    const contentWithPlan = {
      ...mergeBookBiblePartials(await getMergedPartialsForBlueprintRetry(supabase, bookId, partials, Boolean(retryChunkNumbers?.size))),
      aiCallPlan: {
        ...plan,
        expectedCalls: allChunks.length,
        actualCalls: chunks.length,
        chunkCount: allChunks.length,
        retryChunkCount: retryChunkNumbers?.size || 0,
        chunkChapterRanges: allChunks.map((chunk) => chunk.chapterRange),
        promptCharBudget: preparedModel.runtimeLimits.promptCharBudget,
        chunkingTokenBudget,
      },
      partialAnalyses: await getMergedPartialRecordsForBlueprintRetry(supabase, bookId, partials, Boolean(retryChunkNumbers?.size)),
    };

    const { error: bibleError } = await supabase
      .from("book_bibles")
      .upsert(
        {
          book_id: bookId,
          content: contentWithPlan,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "book_id" },
      );
    if (bibleError) throw bibleError;

    const completedAt = new Date().toISOString();
    const finalStatus = await getRevisionJobStatus(supabase, jobId);
    const completedStatus = finalStatus === "cancelled" ? "cancelled" : "completed";
    let worldDiscoveryResult: Awaited<ReturnType<typeof persistWorldDiscovery>> | null = null;
    if (body.discoverWorldBible && completedStatus === "completed") {
      worldDiscoveryResult = await persistWorldDiscovery({
        supabase,
        bookId,
        jobId,
        blueprint: contentWithPlan,
        chapters: (chapters || []).map((chapter) => ({
          id: chapter.id,
          chapter_number: chapter.chapter_number,
        })),
      });
      const sourceHash = createHash("sha256")
        .update(JSON.stringify((chapters || []).map((chapter) => [chapter.id, chapter.original_text])))
        .digest("hex");
      const { error: bookStatusError } = await supabase
        .from("books")
        .update({
          world_bible_status: "completed",
          world_bible_processed: true,
          world_bible_processed_at: completedAt,
          world_bible_source_hash: sourceHash,
          updated_at: completedAt,
        })
        .eq("id", bookId);
      if (bookStatusError) throw bookStatusError;
    } else if (body.discoverWorldBible) {
      await supabase
        .from("books")
        .update({ world_bible_status: "failed", world_bible_processed: false })
        .eq("id", bookId);
    }
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
          unit: "analysis_chunk",
          retryJobId: body.retryJobId || null,
          discoverWorldBible: Boolean(body.discoverWorldBible),
          worldDiscoveryResult,
          progress: buildJobProgress({
            taskName: body.discoverWorldBible ? "Discover World Bible with AI" : "Generate Manuscript Blueprint",
            currentUnit: completedStatus === "cancelled" ? "Cancelled" : "Complete",
            totalUnits: chunks.length,
            attempted,
            successful: partials.length,
            failed,
            skipped: completedStatus === "cancelled" ? Math.max(0, chunks.length - attempted) : 0,
            failedUnits: [],
            startedAt,
            completedAt,
            estimatedSecondsPerUnit: plan.estimatedSecondsPerCall,
            message:
              completedStatus === "cancelled"
                ? "Blueprint job cancelled. Completed chunks were merged into the saved Blueprint."
                : body.discoverWorldBible
                  ? "World Bible discoveries saved."
                  : "Manuscript Blueprint saved.",
          }),
        },
      })
      .eq("id", jobId);
    if (finalJobError) throw finalJobError;

    return NextResponse.json({ content: { ...contentWithPlan, worldDiscoveryResult } });
  } catch (error) {
    if (discoveryContext) {
      await discoveryContext.supabase
        .from("books")
        .update({ world_bible_status: "failed", world_bible_processed: false })
        .eq("id", discoveryContext.bookId);
    }
    console.error("Manuscript Blueprint analysis failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
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

async function getRetryAnalysisChunkNumbers(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  jobId: string,
) {
  const { data, error } = await supabase.from("revision_jobs").select("settings").eq("id", jobId).single();
  if (error) throw error;
  const settings = data.settings as RetryJobSettings | null;
  const ids = (settings?.progress?.failedUnits || [])
    .filter((unit) => unit.type === "analysis_chunk" && unit.id)
    .map((unit) => Number(unit.id))
    .filter((value) => Number.isFinite(value) && value > 0);
  return ids.length ? new Set(ids) : new Set<number>();
}

async function getExistingPartialAnalyses(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  bookId: string,
) {
  const { data } = await supabase.from("book_bibles").select("content").eq("book_id", bookId).maybeSingle();
  const content = data?.content;
  if (!content || typeof content !== "object" || !("partialAnalyses" in content)) return [];
  const partials = (content as { partialAnalyses?: unknown }).partialAnalyses;
  return Array.isArray(partials) ? partials : [];
}

async function getMergedPartialRecordsForBlueprintRetry(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  bookId: string,
  partials: Array<{ chunkNumber: number; chapterRange: string; content: unknown }>,
  retrying: boolean,
) {
  if (!retrying) return partials;
  const existing = await getExistingPartialAnalyses(supabase, bookId);
  const replacements = new Map(partials.map((partial) => [partial.chunkNumber, partial]));
  const merged = existing.map((partial) => {
    if (!partial || typeof partial !== "object" || !("chunkNumber" in partial)) return partial;
    const chunkNumber = Number((partial as { chunkNumber?: unknown }).chunkNumber);
    return replacements.get(chunkNumber) || partial;
  });
  for (const partial of partials) {
    if (!merged.some((item) => item && typeof item === "object" && Number((item as { chunkNumber?: unknown }).chunkNumber) === partial.chunkNumber)) {
      merged.push(partial);
    }
  }
  return merged;
}

async function getMergedPartialsForBlueprintRetry(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  bookId: string,
  partials: Array<{ chunkNumber: number; chapterRange: string; content: unknown }>,
  retrying: boolean,
) {
  const records = await getMergedPartialRecordsForBlueprintRetry(supabase, bookId, partials, retrying);
  return records
    .map((record) =>
      record && typeof record === "object" && "content" in record
        ? (record as { content: unknown }).content
        : null,
    )
    .filter(Boolean);
}

function parseBookBibleModelResponse(content: string) {
  return parseModelJsonOrFallback(content, (raw, parseError) => ({
    summary: raw,
    genre: "",
    targetAudience: "",
    pointOfView: "",
    tense: "",
    tone: "",
    authorialVoice: "",
    majorThemes: [],
    recurringMotifs: [],
    characters: [],
    relationships: [],
    timeline: [],
    locations: [],
    unresolvedPlotThreads: [],
    styleRules: [],
    forbiddenChanges: [],
    parseWarning: parseError,
    rawModelResponse: raw,
  }));
}

function chunkChaptersForModel(
  chapters: Array<{ title: string | null; original_text: string }>,
  targetTokensPerCall: number,
) {
  const chunks: Array<{ text: string; chapterRange: string }> = [];
  let current: Array<{ index: number; title: string; text: string }> = [];
  let currentTokens = 0;

  chapters.forEach((chapter, index) => {
    const title = chapter.title || `Chapter ${index + 1}`;
    const text = `${title}\n\n${chapter.original_text}`;
    const tokens = estimateTokens(text);

    if (current.length && currentTokens + tokens > targetTokensPerCall) {
      chunks.push(formatChapterChunk(current));
      current = [];
      currentTokens = 0;
    }

    if (tokens > targetTokensPerCall) {
      splitLargeChapter(text, targetTokensPerCall).forEach((part, partIndex, parts) => {
        chunks.push({
          text: `${title} (part ${partIndex + 1} of ${parts.length})\n\n${part}`,
          chapterRange: `${index + 1}${parts.length > 1 ? `.${partIndex + 1}` : ""}`,
        });
      });
      return;
    }

    current.push({ index: index + 1, title, text });
    currentTokens += tokens;
  });

  if (current.length) chunks.push(formatChapterChunk(current));
  return chunks.length ? chunks : [{ text: "No manuscript text found.", chapterRange: "none" }];
}

function formatChapterChunk(chapters: Array<{ index: number; title: string; text: string }>) {
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  return {
    text: chapters.map((chapter) => chapter.text).join("\n\n"),
    chapterRange: first.index === last.index ? `${first.index}` : `${first.index}-${last.index}`,
  };
}

function splitLargeChapter(text: string, targetTokensPerCall: number) {
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const tokens = estimateTokens(paragraph);
    if (current.length && currentTokens + tokens > targetTokensPerCall) {
      parts.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(paragraph);
    currentTokens += tokens;
  }

  if (current.length) parts.push(current.join("\n\n"));
  return parts;
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function mergeBookBiblePartials(partials: unknown[]) {
  const objects = partials.filter((partial): partial is Record<string, unknown> => Boolean(partial && typeof partial === "object"));

  return {
    summary: objects.map((item) => item.summary).filter(Boolean).join("\n\n"),
    genre: firstString(objects, "genre"),
    targetAudience: firstString(objects, "targetAudience"),
    pointOfView: firstString(objects, "pointOfView"),
    tense: firstString(objects, "tense"),
    tone: joinUniqueStrings(objects, "tone"),
    authorialVoice: joinUniqueStrings(objects, "authorialVoice"),
    majorThemes: mergeArrays(objects, "majorThemes"),
    recurringMotifs: mergeArrays(objects, "recurringMotifs"),
    characters: mergeArrays(objects, "characters"),
    relationships: mergeArrays(objects, "relationships"),
    timeline: mergeArrays(objects, "timeline"),
    locations: mergeArrays(objects, "locations"),
    unresolvedPlotThreads: mergeArrays(objects, "unresolvedPlotThreads"),
    styleRules: mergeArrays(objects, "styleRules"),
    forbiddenChanges: mergeArrays(objects, "forbiddenChanges"),
  };
}

function firstString(objects: Array<Record<string, unknown>>, key: string) {
  return (
    objects
      .map((item) => item[key])
      .find((value): value is string => typeof value === "string" && Boolean(value.trim())) || ""
  );
}

function joinUniqueStrings(objects: Array<Record<string, unknown>>, key: string) {
  return Array.from(
    new Set(objects.map((item) => item[key]).filter((value): value is string => typeof value === "string" && Boolean(value.trim()))),
  ).join("\n");
}

function mergeArrays(objects: Array<Record<string, unknown>>, key: string) {
  const values = objects.flatMap((item) => (Array.isArray(item[key]) ? item[key] : []));
  const seen = new Set<string>();
  return values.filter((value) => {
    const signature = typeof value === "string" ? value.toLowerCase() : JSON.stringify(value).toLowerCase();
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
