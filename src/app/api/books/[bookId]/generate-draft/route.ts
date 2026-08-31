import { revalidatePath } from "next/cache";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { buildCreationDraftChapterPrompt } from "@/lib/creation/draft-prompt";
import { createRevisionJobHeartbeat, extractJobProgress, mergeJobSettings, type AiJobProgress, updateRevisionJobProgress } from "@/lib/ai/job-state";
import { resolveRequestAuth } from "@/lib/ai/cron-auth";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getDraftModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel } from "@/lib/lmstudio/orchestrator";
import { validateLongFormOutput } from "@/lib/ai/model-performance";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { WORDS_PER_PAGE } from "@/lib/manuscript/page-estimate";
import { repairCommonMojibake } from "@/lib/text/repair-mojibake";

type ArchitectureChapter = {
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
  partTitle?: string;
};

// Single chapter per request, up to 12,000 output tokens of real prose --
// at the ~39 tokens/sec measured for deepseek-v4-pro through OpenRouter
// (see src/lib/critic/run.ts), generation alone can take 5+ minutes before
// any network/queueing overhead. The stale 55s value here predates the
// Vercel Pro upgrade and was missed in the sweep that fixed the same
// missing-maxDuration bug on critic/concept/architecture/etc -- found live
// when a real chapter-draft job died silently mid-run and got force-failed
// by the 10-minute stale-heartbeat sweep with no real error ever thrown.
export const maxDuration = 780;
const CHAPTER_COMPLETION_TIMEOUT_MS = 760_000;
const CHAPTER_CLAIM_STALE_MS = 900_000;
// Same fallback used by rewrite-execute's per-paragraph retry (that file's
// REWRITE_FALLBACK_MODEL) -- retrying a failed cloud call against the exact
// same model wastes a full generation attempt for very little chance of a
// different outcome, since the failure mode is usually correlated with that
// specific model rather than the prompt.
const DRAFT_FALLBACK_MODEL = "google/gemini-2.5-flash";

const sceneBreakPattern = /^\s{0,3}(\*\s*\*\s*\*|#{3,}|-{3,}|_{3,})\s*$/m;

const schema = z.object({
  jobId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  chapterId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
  // Set only by the resume-stale-chunked-jobs cron -- see resolveRequestAuth.
  actingUserId: z.string().uuid().optional(),
});

function getErrorMessage(error: unknown, context: { model?: string; task?: string; modelSource?: string; configuredModels?: string[] } = {}) {
  const lmStudioMessage = getLmStudioErrorMessage(error, "", context);
  if (lmStudioMessage) return lmStudioMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Draft generation failed.";
}

export async function POST(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await params;
    const body = schema.parse(await request.json().catch(() => ({})));
    const requestedLimit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? body.limit
        : Number.POSITIVE_INFINITY;
    // Known limitation, flagged not hidden: unlike rewrite-execute's maxUnits
    // (which subtracts cumulative `attempted` to turn it into a true
    // whole-job remaining-budget cap), `limit` here is not corrected the same
    // way -- doing so would require resolving the job's prior progress before
    // plannedChapters is first computed, which currently happens earlier
    // (this endpoint's model-selection/job-creation setup depends on
    // plannedChapters.length). In practice this only matters if a caller
    // passes a finite `limit` intending "stop after N chapters total, across
    // every chunk call" for a single logical job -- no current caller does
    // that (the "Generate Planned Draft" button now drives full continuation
    // via runChunkedJob without a limit), but a future finite-limit caller
    // would generate more chapters than requested rather than stopping short.
    const limit = Math.max(1, Math.min(200, requestedLimit));

    const { supabase, userId } = await resolveRequestAuth(request, body.actingUserId);
    if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const user = { id: userId };

    const { data: book, error: bookError } = await supabase
      .from("books")
      .select("id,title,genre,target_audience,dialog_density,owner_id")
      .eq("id", bookId)
      .single();
    if (bookError) throw bookError;

    const { data: creationProject, error: creationError } = await supabase
      .from("creation_projects")
      .select("*")
      .eq("created_book_id", bookId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (creationError) throw creationError;

    if (!creationProject) {
      return NextResponse.json(
        { error: "This book was not created from a BookForge Creator architecture." },
        { status: 400 },
      );
    }

    const { data: plans, error: plansError } = await supabase
      .from("creation_plan_versions")
      .select("version_type,content,created_at,accepted")
      .eq("creation_project_id", creationProject.id)
      .in("version_type", ["concept", "architecture"])
      .order("created_at", { ascending: false });
    if (plansError) throw plansError;

    const concept = plans?.find((plan) => plan.version_type === "concept" && plan.accepted)?.content || {};
    const architecture = plans?.find((plan) => plan.version_type === "architecture" && plan.accepted)?.content;
    if (!architecture) {
      return NextResponse.json({ error: "No accepted architecture found for this generated book." }, { status: 400 });
    }

    const architectureChapters = flattenArchitectureChapters(architecture);
    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("id,chapter_number,title,summary,status,original_text,updated_at")
      .eq("book_id", bookId)
      .order("chapter_number");
    if (chaptersError) throw chaptersError;

    const chapterRows = (chapters || []) as Array<{
      id: string;
      chapter_number: number;
      title: string | null;
      summary: string | null;
      status: string | null;
      original_text: string | null;
      updated_at: string | null;
    }>;
    const staleGeneratingChapterIds = chapterRows
      .filter((chapter) => isStaleGeneratingChapter(chapter.status, chapter.updated_at))
      .map((chapter) => chapter.id);

    if (staleGeneratingChapterIds.length) {
      const releasedAt = new Date().toISOString();
      const { error: releaseError } = await supabase
        .from("chapters")
        .update({ status: "planned", updated_at: releasedAt })
        .in("id", staleGeneratingChapterIds)
        .eq("book_id", bookId)
        .eq("status", "generating");
      if (releaseError) throw releaseError;

      for (const chapter of chapterRows) {
        if (staleGeneratingChapterIds.includes(chapter.id)) {
          chapter.status = "planned";
          chapter.updated_at = releasedAt;
        }
      }
    }

    const plannedChapters = chapterRows
      .filter((chapter) => chapter.status === "planned" || isPlaceholderText(chapter.original_text || ""))
      .filter((chapter) => !body.chapterId || chapter.id === body.chapterId)
      .slice(0, limit);

    if (!plannedChapters.length) {
      return NextResponse.json({
        content: {
          generated: 0,
          remainingChapters: 0,
          status: "completed",
          message: "No planned chapter shells need draft generation.",
        },
      });
    }

    const settings = await getUserLmStudioSettings(user.id);
    const modelPlan = await selectAndPrepareActiveModel(settings, {
      task: "rewrite",
      candidates: getDraftModelCandidates(settings),
      expectedCalls: plannedChapters.length,
      latencyPreference: settings.qualityProfile === "premium" ? "quality" : settings.qualityProfile === "fast" ? "fast" : "balanced",
      allowUnload: plannedChapters.length >= 3,
      telemetry: { supabase, userId: user.id },
    });
    const { client, model, preparedModel, modelSelection, telemetryContext } = modelPlan;
    const runtimeWordCeiling = estimateModelWordCeiling(preparedModel.runtimeLimits.maxOutputTokens);
    const generated: Array<{ chapterNumber: number; title: string | null; paragraphCount: number }> = [];
    let jobId = body.jobId || "";
    // Continuation calls (same jobId, one per chapter -- see the single-chapter
    // execution below) carry the whole job's cumulative successful count and
    // its frozen totalUnits forward from here, mirroring rewrite-execute's
    // priorProgress handling.
    let priorProgress: AiJobProgress | null = null;

    const initialJobSettings = mergeJobSettings(
      {
        limit,
        model,
        modelSource: modelSelection.source,
        configuredModelFallbackOrder: modelSelection.configuredModels,
        availableModels: modelSelection.availableModels,
        usedLoadedFallback: modelSelection.usedLoadedFallback,
        generationKind: "planned_chapter_draft",
      },
      {
        taskName: "Creation Draft Generation",
        currentUnit: "Starting…",
        totalUnits: plannedChapters.length,
        attempted: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      },
    );

    let currentJobSettings: unknown = initialJobSettings;

    if (jobId) {
      const { data: existingJob, error: existingJobError } = await supabase
        .from("revision_jobs")
        .select("id,status,settings")
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id)
        .single();
      if (existingJobError) throw existingJobError;
      if (!existingJob) return NextResponse.json({ error: "Draft job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Draft job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Draft job already failed." });
      currentJobSettings = existingJob.settings || initialJobSettings;
      priorProgress = extractJobProgress(existingJob.settings);
    } else {
      // Guard against launching a second draft-generation run for this book
      // while one is already actively working through planned chapters --
      // mirrors rewrite-execute's identical guard (added there after a real
      // incident: 13 concurrent full_book_rewrite jobs on one book, running
      // in true parallel for ~2 hours before being caught). Only checked here
      // (no jobId): a continuation call always supplies the existing jobId
      // and is exempt, same as rewrite-execute.
      const { data: activeJob } = await supabase
        .from("revision_jobs")
        .select("id")
        .eq("book_id", bookId)
        .eq("mode", "creation_draft_generation")
        .in("status", ["running", "queued"])
        .limit(1)
        .maybeSingle();
      if (activeJob) {
        return NextResponse.json(
          {
            error: `A draft generation run is already in progress for this book (job ${activeJob.id}). Wait for it to finish, or cancel it from Jobs History, before starting another.`,
          },
          { status: 409 },
        );
      }

      const { data: job, error: jobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: "creation_draft_generation",
          status: "running",
          settings: initialJobSettings,
          created_by: user.id,
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (jobError) throw jobError;
      jobId = job.id;

      if (body.serverManaged) {
        return NextResponse.json({ content: { jobId, queued: true, totalUnits: plannedChapters.length } });
      }
    }
    // Frozen on whichever chunk call first sees this job -- plannedChapters
    // shrinks on every later call as prior chapters flip from "planned" to
    // "draft", so re-deriving totalUnits from it each time would make the
    // progress bar's denominator shrink mid-run instead of the numerator
    // climbing toward a stable target.
    const totalUnits = priorProgress?.totalUnits || plannedChapters.length;
    let successCount = priorProgress?.successful ?? 0;

    try {
      // Exactly one chapter per request -- never the full plannedChapters
      // list -- so a single HTTP request can't run long enough to hit
      // Vercel's function timeout generating a whole book's worth of
      // chapters. The caller (runChunkedJob) calls this route again with the
      // same jobId while remainingChapters > 0; plannedChapters is re-derived
      // fresh from durable state (chapters.status) on every such call, so an
      // already-drafted chapter never gets regenerated.
      for (const chapter of plannedChapters.slice(0, 1)) {
        const chapterLabel = `Chapter ${chapter.chapter_number}${chapter.title ? `: ${chapter.title}` : ""}`;
        currentJobSettings = await updateRevisionJobProgress(supabase, jobId, currentJobSettings, {
          currentUnit: chapterLabel,
          attempted: successCount,
          successful: successCount,
          totalUnits,
        });
        const heartbeat = createRevisionJobHeartbeat(supabase, jobId, currentJobSettings, {
          currentUnit: chapterLabel,
          attempted: successCount,
          successful: successCount,
          totalUnits,
        });

        // Atomic claim: this route self-chains via after() the instant a
        // chapter finishes, AND the browser's own runChunkedJob driver calls
        // back in with the same jobId once it sees a response -- normally
        // the second arrival is harmless (finds the chapter already
        // "draft"). But if the client's own follow-up call gets delayed
        // (e.g. a mobile tab backgrounded/throttled by a screen lock, then
        // resuming and firing its queued call right as the self-chained
        // request is also mid-flight), both can pass the plannedChapters
        // "planned" check before either has flipped this chapter's status --
        // a real race, confirmed live via prod logs 2026-08-27: two POSTs
        // ~100-500ms apart both generating the same chapter concurrently,
        // degrading both completions until "too little text" hard-failed
        // the job. This conditional update is the actual lock: only the
        // caller that flips planned -> generating gets to proceed.
        const { data: claimedChapterRows, error: claimError } = await supabase
          .from("chapters")
          .update({ status: "generating", updated_at: new Date().toISOString() })
          .eq("id", chapter.id)
          .eq("status", "planned")
          .select("id");
        if (claimError) throw claimError;
        if (!claimedChapterRows || claimedChapterRows.length === 0) {
          heartbeat.stop();
          continue;
        }

        try {
          const architectureChapter =
            architectureChapters.find((item) => item.chapterNumber === chapter.chapter_number) || {
              chapterNumber: chapter.chapter_number,
              title: chapter.title || `Chapter ${chapter.chapter_number}`,
              purpose: chapter.summary || "",
            };
          const chapterForPrompt = constrainChapterTargetsForRuntime(architectureChapter, runtimeWordCeiling);
          const previousChapter = architectureChapters.find((item) => item.chapterNumber === chapter.chapter_number - 1);
          const nextChapter = architectureChapters.find((item) => item.chapterNumber === chapter.chapter_number + 1);
          const prompt = buildCreationDraftChapterPrompt({
            workingTitle: creationProject.working_title || book.title,
            genre: creationProject.genre || book.genre || "Unspecified",
            targetAudience: creationProject.target_audience || book.target_audience || "Unspecified",
            language: creationProject.language || "English",
            targetPages: Number(creationProject.target_pages || 120),
            tone: creationProject.tone || "",
            boundaries: creationProject.boundaries || "",
            dialogDensity: creationProject.dialog_density || book.dialog_density || "normal",
            concept,
            architecture,
            chapter: chapterForPrompt,
            previousChapterSummary: summarizeArchitectureChapter(previousChapter),
            nextChapterSummary: summarizeArchitectureChapter(nextChapter),
            promptCharBudget: preparedModel.runtimeLimits.promptCharBudget,
          });

          const minimumWordFloor = computeChapterWordFloor(
            chapterForPrompt,
            Number(creationProject.target_pages || 120),
            Math.max(1, architectureChapters.length),
            runtimeWordCeiling,
          );

          // Retry loop: this call used to fire exactly once and hard-fail the
          // WHOLE job (every chapter, not just this one) the instant a
          // single completion came back short -- unlike rewrite-execute,
          // which retries a flaky paragraph up to 3 times and switches
          // models on later attempts. Reproduced live 2026-08-28 against a
          // local model with zero concurrency involved: a single, ordinary
          // sequential call returned a truncated-but-substantial completion
          // (real prose in the raw response, but cut off before valid JSON
          // closed, so parseChapterCompletion's broken-JSON guard correctly
          // treated it as empty) -- the same "0 words despite real content
          // in the snippet" signature as the original prod incident, with no
          // race in sight. A single flaky completion is common enough
          // (~17-26% empty/truncated rates measured elsewhere in this
          // codebase for cloud models) that it shouldn't be allowed to kill
          // an entire multi-chapter job on the first miss.
          const maxChapterAttempts = 3;
          let parsed: ReturnType<typeof parseChapterCompletion> | undefined;
          let chapterText = "";
          let lastRawContent = "";
          let lastWordCount = 0;
          let lastCompletionError: unknown = null;

          for (let chapterAttempt = 1; chapterAttempt <= maxChapterAttempts; chapterAttempt += 1) {
            const useFallbackModel = chapterAttempt > 1 && preparedModel.isCloud && DRAFT_FALLBACK_MODEL !== model;
            let completion;
            try {
              completion = await createManagedChatCompletion(
                client,
                preparedModel,
                {
                  temperature: Math.min(Math.max(settings.temperature, 0.45), 0.8),
                  top_p: settings.topP,
                  max_tokens: Math.min(Math.max(settings.maxOutputTokens, 6000), 12000),
                  messages: [{ role: "user", content: prompt }],
                  ...(useFallbackModel ? { model: DRAFT_FALLBACK_MODEL } : {}),
                },
                (content) => validateLongFormOutput(parseChapterCompletion(content, chapter.title || "").chapterText, { minimumWordFloor }),
                telemetryContext,
                { timeoutMs: CHAPTER_COMPLETION_TIMEOUT_MS },
              );
            } catch (completionError) {
              lastCompletionError = completionError;
              continue;
            }

            const rawContent = completion.choices[0]?.message.content || "";
            const parsedAttempt = parseChapterCompletion(rawContent, chapter.title || "");
            const wordCount = parsedAttempt.chapterText.split(/\s+/).filter(Boolean).length;
            lastRawContent = rawContent;
            lastWordCount = wordCount;
            lastCompletionError = null;
            if (wordCount >= minimumWordFloor) {
              parsed = parsedAttempt;
              chapterText = parsedAttempt.chapterText;
              break;
            }
          }

          if (!parsed) {
            if (lastCompletionError && !lastRawContent) {
              throw new Error(
                `Chapter ${chapter.chapter_number}: ${chapter.title || "Untitled"}: ${getErrorMessage(lastCompletionError, {
                  model,
                  task: "Generate Planned Draft",
                  modelSource: modelSelection.source,
                  configuredModels: modelSelection.configuredModels,
                })}`,
              );
            }
            const snippet = lastRawContent.slice(0, 300).replace(/\n/g, " ");
            throw new Error(
              `Chapter ${chapter.chapter_number} generation returned too little text after ${maxChapterAttempts} attempt(s) (${lastWordCount} words, expected at least ${minimumWordFloor}). Raw response snippet: "${snippet}"`,
            );
          }

          await supabase.from("paragraphs").delete().eq("chapter_id", chapter.id);
          await supabase.from("scenes").delete().eq("chapter_id", chapter.id);

          const { error: chapterUpdateError } = await supabase
            .from("chapters")
            .update({
              original_text: chapterText,
              current_text: chapterText,
              summary: String(parsed.chapterSummary || chapter.summary || architectureChapter.purpose || ""),
              status: "draft",
              updated_at: new Date().toISOString(),
            })
            .eq("id", chapter.id);
          if (chapterUpdateError) throw chapterUpdateError;

          const scenes = splitChapterIntoScenes(chapterText);
          let paragraphCount = 0;
          for (const scene of scenes) {
            const { data: sceneRow, error: sceneError } = await supabase
              .from("scenes")
              .insert({
                book_id: bookId,
                chapter_id: chapter.id,
                scene_number: scene.sceneNumber,
                original_text: scene.text,
                current_text: scene.text,
                status: "draft",
              })
              .select("id")
              .single();
            if (sceneError) throw sceneError;

            const paragraphRows = scene.paragraphs.map((paragraph) => ({
              book_id: bookId,
              chapter_id: chapter.id,
              scene_id: sceneRow.id,
              paragraph_number: paragraph.paragraphNumber,
              original_text: paragraph.text,
              current_text: paragraph.text,
            }));
            paragraphCount += paragraphRows.length;
            if (paragraphRows.length) {
              const { error: paragraphError } = await supabase.from("paragraphs").insert(paragraphRows);
              if (paragraphError) throw paragraphError;
            }
          }

          await supabase.from("coherence_reports").insert({
            book_id: bookId,
            chapter_id: chapter.id,
            report_type: "creation_draft_generation",
            content: {
              chapterNumber: chapter.chapter_number,
              model,
              promptSnapshot: prompt,
              continuityNotes: parsed.continuityNotes || [],
              generationNotes: parsed.generationNotes || [],
            },
          });

          successCount++;
          generated.push({
            chapterNumber: chapter.chapter_number,
            title: chapter.title,
            paragraphCount,
          });
        } catch (chapterError) {
          // Release the claim so a later retry (new job launch, or another
          // backstop) can pick this chapter back up -- original_text still
          // holds the placeholder, so plannedChapters' isPlaceholderText
          // fallback keeps finding it regardless of this status flip, but
          // the atomic-claim check above only matches status === "planned".
          // Without this, a chapter whose generation failed would stay
          // stuck at "generating" forever and never be claimable again.
          await supabase
            .from("chapters")
            .update({ status: "planned", updated_at: new Date().toISOString() })
            .eq("id", chapter.id)
            .eq("status", "generating");
          throw chapterError;
        } finally {
          heartbeat.stop();
        }
      }

      // Recomputed from a fresh read at the top of THIS request, so this
      // already reflects true current DB state -- chapters drafted by any
      // earlier chunk call are no longer "planned" by the time this query ran.
      const remainingChapters = Math.max(
        0,
        chapterRows.filter((chapter) => chapter.status === "planned" || chapter.status === "generating").length -
          generated.length,
      );
      const isJobDone = remainingChapters === 0;
      const nowIso = new Date().toISOString();
      currentJobSettings = await updateRevisionJobProgress(supabase, jobId, currentJobSettings, {
        currentUnit: `${successCount} chapter${successCount === 1 ? "" : "s"} generated`,
        attempted: successCount,
        successful: successCount,
        totalUnits,
        completedAt: isJobDone ? nowIso : undefined,
      });
      await supabase
        .from("revision_jobs")
        .update({
          status: isJobDone ? "completed" : "running",
          completed_at: isJobDone ? nowIso : null,
          settings: mergeJobSettings(currentJobSettings, {
            taskName: "Creation Draft Generation",
            currentUnit: `${successCount} chapter${successCount === 1 ? "" : "s"} generated`,
            totalUnits,
            attempted: successCount,
            successful: successCount,
            failed: 0,
            skipped: 0,
            completedAt: isJobDone ? nowIso : null,
          }),
        })
        .eq("id", jobId);

      await supabase
        .from("creation_projects")
        .update({
          status: remainingChapters > 0 ? "generating" : "created",
          updated_at: new Date().toISOString(),
          metadata: {
            ...(typeof creationProject.metadata === "object" && creationProject.metadata ? creationProject.metadata : {}),
            lastDraftGenerationAt: new Date().toISOString(),
            generatedChapterCount: ((chapters || []).length - remainingChapters),
          },
        })
        .eq("id", creationProject.id);

      await supabase
        .from("books")
        .update({
          status: remainingChapters > 0 ? "generating" : "created",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookId)
        .in("status", ["planned", "draft", "generating"]);

      revalidatePath(`/books/${bookId}`);

      // This route only ever drafts one chapter per call and relies on the
      // caller (the browser's runChunkedJob, via book-actions.tsx's "Write
      // Your Chapters" button) to call it again while remainingChapters > 0
      // -- so navigating away, closing the tab, or the tab getting
      // backgrounded/throttled silently stops all further drafting. Same
      // bug and same fix as rewrite-execute: self-chain a continuation so
      // the server keeps making progress regardless of whether anyone's
      // still watching. A still-open tab's own next call becomes redundant
      // but harmless -- it just finds this chapter already drafted.
      //
      // A bare un-awaited `void fetch(...)` here is NOT safe: Vercel is free
      // to freeze/tear down this function's execution the instant the
      // response below is sent, before that fetch's request even leaves the
      // machine. after() is the platform-supported way to guarantee this
      // keeps running post-response.
      //
      // generated.length > 0 gates this: a call that lost the atomic claim
      // above (see "Atomic claim" comment) did no work, and the chapter it
      // tried for still looks eligible to it (original_text still holds the
      // placeholder) -- without this gate it would self-chain again
      // immediately, lose the claim again, and repeat in a tight loop for
      // as long as the actual winner is still generating. The winner's own
      // eventual self-chain (once it finishes) and the client's independent
      // polling redrive both already keep the job moving, so a losing call
      // doesn't need to also schedule a continuation.
      if (!isJobDone && generated.length > 0) {
        const cookie = request.headers.get("cookie") || "";
        const selfUrl = new URL(request.url).toString();
        after(() =>
          fetch(selfUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({ ...body, jobId }),
          }).catch(() => {}),
        );
      }

      return NextResponse.json({
        content: {
          jobId,
          generated: generated.length,
          // successCount is cumulative across every chunk call for this job
          // (seeded from priorProgress) -- generated.length is only this
          // chunk's count (always 0 or 1 now), which callers can't use to
          // show real across-chunk progress.
          totalGenerated: successCount,
          totalUnits,
          remainingChapters,
          chapters: generated,
          status: isJobDone ? "completed" : "running",
        },
      });
    } catch (error) {
      await supabase
        .from("revision_jobs")
        .update({
          status: "failed",
          error_message: getErrorMessage(error, {
            model,
            task: "Generate Planned Draft",
            modelSource: modelSelection.source,
            configuredModels: modelSelection.configuredModels,
          }),
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
      throw error;
    }
  } catch (error) {
    console.error("Creation draft generation failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

function flattenArchitectureChapters(architecture: unknown): ArchitectureChapter[] {
  if (!architecture || typeof architecture !== "object") return [];
  const parts = Array.isArray((architecture as { parts?: unknown }).parts)
    ? ((architecture as { parts: unknown[] }).parts)
    : [];
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const partTitle = typeof (part as { title?: unknown }).title === "string" ? (part as { title: string }).title : "";
      const chapters = Array.isArray((part as { chapters?: unknown }).chapters)
        ? (part as { chapters: unknown[] }).chapters
        : [];
      return chapters.map((chapter) => ({
        ...((chapter && typeof chapter === "object" ? chapter : {}) as ArchitectureChapter),
        partTitle,
      }));
    })
    .map((chapter, index) => ({
      ...chapter,
      chapterNumber: Number(chapter.chapterNumber || index + 1),
    }));
}

function summarizeArchitectureChapter(chapter?: ArchitectureChapter) {
  if (!chapter) return "";
  return [
    chapter.title ? `Title: ${chapter.title}` : "",
    chapter.purpose ? `Purpose: ${chapter.purpose}` : "",
    chapter.emotionalMovement ? `Emotional movement: ${chapter.emotionalMovement}` : "",
    chapter.continuityNotes?.length ? `Continuity notes: ${JSON.stringify(chapter.continuityNotes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isPlaceholderText(text: string) {
  return /Draft text has not been generated yet\. This planned chapter shell was created from BookForge Creator architecture\./i.test(
    text,
  );
}

function isStaleGeneratingChapter(status: string | null, updatedAt: string | null) {
  if (status !== "generating" || !updatedAt) return false;
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > CHAPTER_CLAIM_STALE_MS;
}

function parseChapterCompletion(rawContent: string, title: string) {
  const parsed = parseModelJsonOrFallback(rawContent, (raw) => {
    // If the raw fallback text looks like an attempted (but broken or
    // truncated) JSON object -- rather than genuine free-form prose the
    // model wrote instead of JSON -- using it verbatim stores the literal
    // JSON wrapper (braces, "chapterText": prefix, escaped \n sequences
    // instead of real paragraph breaks) as the chapter's actual manuscript
    // text. The whole chapter then lands in a single giant paragraph (no
    // real blank-line breaks exist inside an escaped JSON string), long
    // enough to sail past the word-count floor below despite being
    // completely wrong. See the matching fix in rewrite-execute's
    // parseRewriteResponse for the same failure mode at paragraph scale.
    const looksLikeBrokenJson = /^\s*\{/.test(raw);
    return {
      chapterText: looksLikeBrokenJson ? "" : raw,
      chapterSummary: "",
      continuityNotes: [],
      generationNotes: looksLikeBrokenJson
        ? ["Model returned malformed/truncated JSON; treated as empty so the word-count floor below forces a retry."]
        : ["The model returned prose instead of JSON; BookForge preserved it as chapter text."],
    };
  }) as {
    chapterText?: unknown;
    chapter_text?: unknown;
    text?: unknown;
    content?: unknown;
    chapterSummary?: unknown;
    continuityNotes?: unknown;
    generationNotes?: unknown;
  };
  const rawChapterText = String(parsed.chapterText || parsed.chapter_text || parsed.text || parsed.content || "");
  return {
    chapterText: cleanGeneratedChapterText(rawChapterText, title),
    chapterSummary: parsed.chapterSummary,
    continuityNotes: parsed.continuityNotes,
    generationNotes: parsed.generationNotes,
  };
}

function cleanGeneratedChapterText(text: string, title: string) {
  const cleaned = repairCommonMojibake(
    text
    .replace(/^```(?:json|markdown|text)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim(),
  );
  if (!title) return cleaned;
  const lines = cleaned.split("\n");
  const first = lines[0]?.trim().replace(/^#+\s*/, "");
  if (first && first.toLowerCase() === title.trim().toLowerCase()) {
    return lines.slice(1).join("\n").trim();
  }
  return cleaned;
}

function splitChapterIntoScenes(text: string) {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of text.split("\n")) {
    if (sceneBreakPattern.test(line)) {
      const sceneText = current.join("\n").trim();
      if (sceneText) chunks.push(sceneText);
      current = [];
    } else {
      current.push(line);
    }
  }

  const finalScene = current.join("\n").trim();
  if (finalScene) chunks.push(finalScene);

  const sceneTexts = chunks.length ? chunks : [text.trim()];
  return sceneTexts.map((sceneText, sceneIndex) => ({
    sceneNumber: sceneIndex + 1,
    text: sceneText,
    paragraphs: splitSceneParagraphs(sceneText),
  }));
}

function splitSceneParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, paragraphIndex) => ({
      paragraphNumber: paragraphIndex + 1,
      text: paragraph,
    }));
}

function estimateModelWordCeiling(maxOutputTokens: number) {
  const safeTokens = Math.max(700, Math.floor(maxOutputTokens * 0.86));
  return Math.max(500, Math.floor(safeTokens * 0.72));
}

function constrainChapterTargetsForRuntime(chapter: ArchitectureChapter, runtimeWordCeiling: number): ArchitectureChapter {
  const targetWords = Number(chapter.targetWords || 0);
  if (!Number.isFinite(targetWords) || targetWords <= 0) return chapter;
  const cappedTarget = Math.min(targetWords, Math.max(600, Math.floor(runtimeWordCeiling * 0.95)));
  if (cappedTarget === targetWords) return chapter;
  return {
    ...chapter,
    targetWords: cappedTarget,
    targetPages: Math.max(1, Math.round(cappedTarget / WORDS_PER_PAGE)),
  };
}

function computeChapterWordFloor(
  chapter: ArchitectureChapter,
  targetPages: number,
  chapterCount: number,
  runtimeWordCeiling?: number,
) {
  const explicitWords = Number(chapter.targetWords || 0);
  const explicitPages = Number(chapter.targetPages || 0);
  let derivedTargetWords =
    (explicitWords > 0 ? explicitWords : 0) ||
    (explicitPages > 0 ? explicitPages * WORDS_PER_PAGE : 0) ||
    ((Math.max(20, targetPages) * WORDS_PER_PAGE) / Math.max(1, chapterCount));

  if (runtimeWordCeiling && Number.isFinite(runtimeWordCeiling)) {
    derivedTargetWords = Math.min(derivedTargetWords, Math.max(600, Math.floor(runtimeWordCeiling * 0.95)));
  }

  return Math.max(450, Math.round(derivedTargetWords * 0.65));
}
