import { after, NextResponse } from "next/server";
import { z } from "zod";
import { buildJobProgress, createRevisionJobHeartbeat, extractJobProgress, getRevisionJobStatus, type AiJobProgress, updateRevisionJobProgress, waitWhileRevisionJobPaused } from "@/lib/ai/job-state";
import { buildCloudRewriteModelSelection, selectBestRewriteModel } from "@/lib/ai/rewrite-model-suitability";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { getLmStudioErrorMessage } from "@/lib/lmstudio/errors";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getDraftModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel } from "@/lib/lmstudio/orchestrator";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import { withBookForgeWorkflowSpan } from "@/lib/observability/workflow-span";
import { buildFullBookRewriteUnitPrompt } from "@/lib/prompts/builders";
import { buildRewriteContextPacket } from "@/lib/rewrite/context-packet";
import { applyRewritePlanDefaults } from "@/lib/rewrite/plan-defaults";
import { clampStrategySettings, getRewriteStrategy, rewriteStrategies } from "@/lib/rewrite/strategies";
import { getExistingRevisionState, shouldSkipParagraph, type ExistingRevisionRow } from "@/lib/rewrite/eligibility";
import { resolveRequestAuth } from "@/lib/ai/cron-auth";

// Up to CONCURRENCY (5) paragraphs run in parallel per request, each with up
// to 3 sequential completion attempts (see maxCompletionAttempts below) if
// earlier attempts come back empty -- worst-case wall time is bounded by the
// single slowest unit's retry chain, not 5x it, but that chain alone can run
// several minutes. The stale 55s value here predated the Vercel Pro upgrade
// and was missed in the sweep that fixed the same missing-maxDuration bug on
// generate-draft/critic/concept/architecture/etc -- found live: a real
// full-book rewrite job's heartbeat went stale on unit 1 of 25.
export const maxDuration = 400;
const REWRITE_UNIT_COMPLETION_TIMEOUT_MS = 120_000;

// Same low cost tier as the default rewrite model (deepseek/deepseek-v4-pro)
// but a different provider -- see the "Rewrite-pass alternate to DeepSeek V4
// Pro" entry in src/lib/ai/model-catalog.ts. Used as a same-cost retry
// target when the primary cloud model fails a rewrite completion, instead
// of just repeating the model that already failed.
const REWRITE_FALLBACK_MODEL = "google/gemini-2.5-flash";

const schema = z.object({
  jobId: z.string().uuid().optional(),
  serverManaged: z.boolean().optional(),
  maxUnits: z.number().int().positive().max(5000).optional(),
  campaignId: z.string().uuid().optional(),
  paragraphId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
  rewriteExistingDrafts: z.boolean().default(false),
  rewriteAccepted: z.boolean().default(false),
  // shouldSkipParagraph's <8-word threshold exists to avoid wasting calls on
  // title-echo fragments during a normal full-book pass — but that's exactly
  // the paragraph an "expand this near-empty chapter" repair is targeting.
  // Set true to bypass it for a deliberate, narrowly-targeted repair call.
  forceTinyParagraphs: z.boolean().default(false),
  retryJobId: z.string().uuid().optional(),
  // Set by a caller that already drives the chunk-by-chunk loop itself
  // (the auto-review orchestrator's callStage) so this route's own
  // self-chain below doesn't ALSO dispatch the next chunk -- both drivers
  // running at once would race the same chunk concurrently, exactly the
  // class of bug a real prior incident already burned this codebase on
  // (13 duplicate full_book_rewrite jobs in parallel for ~2 hours).
  externalDriver: z.boolean().optional(),
  // Set only by the resume-stale-chunked-jobs cron -- see resolveRequestAuth.
  actingUserId: z.string().uuid().optional(),
  distributeAcrossChapters: z.boolean().default(false),
  coverageMode: z.enum(["normal", "uncovered_chapter_sample"]).default("normal"),
  strategyId: z.enum([
    "conservative_polish",
    "humanized_literary",
    "clarity_readability",
    "downsize_abridge",
    "emotional_depth",
    "contemporary_view",
    "creative_enhancement",
    "custom",
  ]).default("humanized_literary"),
  strategySettings: z
    .object({
      voicePreservation: z.number().optional(),
      expansionLimitPercent: z.number().optional(),
      sentenceRhythm: z.number().optional(),
      literaryIntensity: z.number().optional(),
      readabilityTarget: z.string().optional(),
      theologicalEmphasis: z.number().optional(),
      continuityStrictness: z.number().optional(),
      targetReductionPercent: z.number().optional(),
    })
    .optional(),
  authorInstructions: z.string().max(3000).optional(),
});

type ChapterRow = {
  id: string;
  chapter_number: number;
  title: string | null;
  summary: string | null;
  exclude_from_rewrite?: boolean | null;
  section_type?: string | null;
};

type ParagraphRow = {
  id: string;
  chapter_id?: string;
  paragraph_number: number;
  original_text: string;
  accepted_text?: string | null;
  is_locked: boolean | null;
  scene_id: string | null;
};

type AcceptedRevisionContextRow = {
  paragraph_id: string | null;
  revised_text: string;
  revision_notes: string | null;
  continuity_warnings: unknown;
  created_at: string | null;
};

type LockedPassageContextRow = {
  paragraph_id: string | null;
  reason: string | null;
};

type RetryJobSettings = {
  progress?: {
    failedUnits?: Array<{ id?: string; type?: string }>;
  };
};

// Timeouts, dropped connections, DNS blips -- the kind of failure that says
// nothing about whether THIS paragraph is rewritable, just that the network
// hiccuped. Previously these weren't caught inside the completion loop at
// all: they threw straight past the empty-completion retry logic, got
// treated as a rejected Promise.allSettled result, and killed the entire
// chunk (hardError -> the whole request throws) instead of just costing
// this one paragraph a retry. A content-shaped failure (empty completion,
// clearly malformed output) is left alone here -- retrying an infrastructure
// blip is usually worth it; retrying the same bad output from the model
// usually isn't (that's what the fallback-model switch above already
// handles).
function isTechnologyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(connection error|connection.*(lost|closed|reset)|fetch failed|failed to fetch|econnreset|econnrefused|etimedout|headerstimeout|und_err_|socket hang up|network error|timeout|timed out|abort)/i.test(
    message,
  );
}

function getErrorMessage(error: unknown) {
  const lmStudioMessage = getLmStudioErrorMessage(error, "");
  if (lmStudioMessage) return lmStudioMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Rewrite execution failed.";
}

export async function POST(request: Request, context: { params: Promise<{ bookId: string }> }) {
  const startedAt = new Date().toISOString();

  try {
    const { bookId } = await context.params;
    const body = schema.parse(await readJsonBody(request));
    const { supabase, userId } = await resolveRequestAuth(request, body.actingUserId);
    if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const user = { id: userId };

    const [
      { data: book },
      { data: bible },
      { data: rewritePlan, error: planError },
      { data: continuityLedger },
      { data: chapters, error: chaptersError },
      { data: existingRevisions, error: existingError },
      { data: criticReports, error: criticReportsError },
      { data: acceptedRevisionRows, error: acceptedRevisionRowsError },
      { data: lockedPassageRows, error: lockedPassageRowsError },
    ] = await Promise.all([
      supabase.from("books").select("dialog_density").eq("id", bookId).single(),
      supabase.from("book_bibles").select("content,voice_profile").eq("book_id", bookId).maybeSingle(),
      supabase
        .from("coherence_reports")
        .select("content")
        .eq("book_id", bookId)
        .eq("report_type", "rewrite_plan")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("coherence_reports")
        .select("content,created_at")
        .eq("book_id", bookId)
        .eq("report_type", "continuity_ledger")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("chapters")
        .select("id,chapter_number,title,summary,section_type,exclude_from_rewrite")
        .eq("book_id", bookId)
        .order("chapter_number"),
      supabase
        .from("revision_versions")
        .select("paragraph_id,accepted,rejected,revision_job_id")
        .eq("book_id", bookId)
        .not("paragraph_id", "is", null),
      supabase
        .from("coherence_reports")
        .select("report_type,content,created_at")
        .eq("book_id", bookId)
        .like("report_type", "critic:%")
        .order("created_at", { ascending: false })
        .limit(14),
      supabase
        .from("revision_versions")
        .select("paragraph_id,revised_text,revision_notes,continuity_warnings,created_at")
        .eq("book_id", bookId)
        .eq("accepted", true)
        .not("paragraph_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("locked_passages")
        .select("paragraph_id,reason")
        .eq("book_id", bookId),
    ]);

    if (planError) throw planError;
    if (chaptersError) throw chaptersError;
    if (existingError) throw existingError;
    if (criticReportsError) throw criticReportsError;
    if (acceptedRevisionRowsError) throw acceptedRevisionRowsError;
    if (lockedPassageRowsError) throw lockedPassageRowsError;
    if (!rewritePlan?.content) {
      return NextResponse.json({ error: "Generate a Rewrite Architect plan before executing the rewrite." }, { status: 400 });
    }
    if (body.campaignId) {
      const { data: campaign, error: campaignError } = await supabase
        .from("rewrite_campaigns")
        .select("status")
        .eq("id", body.campaignId)
        .eq("book_id", bookId)
        .single();
      if (campaignError) throw campaignError;
      if (["paused", "cancelled", "completed"].includes(String(campaign.status || ""))) {
        return NextResponse.json({ error: `Rewrite campaign is ${campaign.status}. Resume or create a new campaign before running another batch.` }, { status: 400 });
      }
    }

    const normalizedRewritePlan = {
      ...applyRewritePlanDefaults(rewritePlan.content as Record<string, unknown>),
      latestContinuityLedger: continuityLedger?.content || null,
    };
    const settings = await getUserLmStudioSettings(user.id);
    const expectedCalls = body.maxUnits || Number(rewritePlan.content?.totalParagraphs || 12);
    const modelPlan = await selectAndPrepareActiveModel(settings, {
      task: "rewrite",
      candidates: getDraftModelCandidates(settings),
      expectedCalls,
      latencyPreference: settings.qualityProfile === "premium" ? "quality" : settings.qualityProfile === "fast" ? "fast" : "balanced",
      allowUnload: true,
      telemetry: { supabase, userId: user.id },
    });
    const { client, model, preparedModel, modelSelection, availableModels, telemetryContext } = modelPlan;
    const rewriteSelection =
      preparedModel.isCloud && settings.standardSettings
        ? buildCloudRewriteModelSelection(settings.standardSettings)
        : selectBestRewriteModel(availableModels, {
            qualityProfile: settings.qualityProfile,
            contextWindowTokens: settings.contextWindowTokens,
          });
    const selectedStrategy = getRewriteStrategy(body.strategyId);
    const rewriteStrategy = {
      ...selectedStrategy,
      settings: clampStrategySettings({
        ...selectedStrategy.settings,
        ...(body.strategySettings || {}),
      }),
      instructions:
        body.strategyId === "custom" && body.authorInstructions?.trim()
          ? [...rewriteStrategies.custom.instructions, body.authorInstructions.trim()]
          : selectedStrategy.instructions,
    };

    let jobId = body.jobId || "";
    let jobStatus = "running";
    // Continuation calls (same jobId, one per chunk -- see the single-chunk
    // execution below) carry the whole job's cumulative attempted/successful/
    // failed counts and its frozen totalUnits forward from here, so the
    // progress bar accumulates across chunks instead of resetting against a
    // shrinking denominator on every single chunk response.
    let priorProgress: AiJobProgress | null = null;

    if (jobId) {
      const { data: existingJob, error: existingJobError } = await supabase
        .from("revision_jobs")
        .select("id,status,settings")
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id)
        .single();
      if (existingJobError) throw existingJobError;
      if (!existingJob) return NextResponse.json({ error: "Rewrite job not found." }, { status: 404 });
      if (existingJob.status === "completed") return NextResponse.json({ ok: true, message: "Rewrite job already completed." });
      if (existingJob.status === "failed") return NextResponse.json({ ok: true, message: "Rewrite job already failed." });
      jobStatus = String(existingJob.status || "running");
      priorProgress = extractJobProgress(existingJob.settings);
    } else {
      // Guard against launching a second full-book rewrite while one is
      // already actively working through this book's paragraphs. Nothing
      // previously stopped this: each Auto-Review "resume" (or a duplicate
      // manual click) queued a brand-new job regardless of whether an
      // earlier one was still running, and once the self-timeout on the
      // orchestrator's dispatch call was fixed (jobs no longer silently
      // die after ~10 minutes), duplicates kept running indefinitely in
      // true parallel instead of dying off on their own. Found live: 13
      // concurrent full_book_rewrite jobs on the same book, all with fresh
      // heartbeats, all independently calling the model for roughly two
      // hours before being caught and cancelled.
      const { data: activeJob } = await supabase
        .from("revision_jobs")
        .select("id")
        .eq("book_id", bookId)
        .eq("mode", "full_book_rewrite")
        .in("status", ["running", "queued"])
        .limit(1)
        .maybeSingle();
      if (activeJob) {
        return NextResponse.json(
          {
            error: `A full-book rewrite is already in progress for this book (job ${activeJob.id}). Wait for it to finish, or cancel it from Jobs History, before starting another.`,
          },
          { status: 409 },
        );
      }

      const status = body.serverManaged ? "queued" : "running";
      const { data: job, error: jobError } = await supabase
        .from("revision_jobs")
        .insert({
          book_id: bookId,
          mode: "full_book_rewrite",
          status,
          settings: {
            model,
            preparedModel,
            modelSelection,
            campaignId: body.campaignId || null,
            chapterId: body.chapterId || null,
            rewriteModelSelection: rewriteSelection,
            maxUnits: body.maxUnits || null,
            rewriteExistingDrafts: body.rewriteExistingDrafts,
            rewriteAccepted: body.rewriteAccepted,
            distributeAcrossChapters: body.distributeAcrossChapters,
            strategyId: rewriteStrategy.id,
            strategyLabel: rewriteStrategy.label,
            strategySettings: rewriteStrategy.settings,
            authorInstructions: body.authorInstructions || null,
            unit: "paragraph",
            progress: buildJobProgress({
              taskName: "Full-book rewrite draft",
              currentUnit: "Planning eligible paragraphs",
              totalUnits: body.maxUnits || 0,
              attempted: 0,
              successful: 0,
              failed: 0,
              skipped: 0,
              startedAt,
              estimatedSecondsPerUnit: estimateSecondsPerRewriteUnit(model),
            }),
          },
          prompt_snapshot:
            "Full-book rewrite executor: paragraph units with Manuscript Blueprint, Rewrite Architect plan, materialized context packet, adjacent chapter summaries, accepted prior revisions, locked passages, Critic priorities, and local paragraph context.",
          created_by: user.id,
          started_at: status === "running" ? startedAt : null,
        })
        .select("id")
        .single();
      if (jobError) throw jobError;
      jobId = job.id;
      jobStatus = status;

      if (body.serverManaged) {
        return NextResponse.json({
          content: {
            jobId,
            revisionJobId: jobId,
            queued: true,
            totalUnits: body.maxUnits || expectedCalls,
          },
        });
      }
    }

    if (jobStatus !== "running") {
      const { error: resumeError } = await supabase
        .from("revision_jobs")
        .update({ status: "running", started_at: startedAt })
        .eq("id", jobId)
        .eq("book_id", bookId)
        .eq("created_by", user.id);
      if (resumeError) throw resumeError;
    }

    if (body.campaignId) {
      const { error: campaignStartError } = await supabase
        .from("rewrite_campaigns")
        .update({
          status: "running",
          last_revision_job_id: jobId,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.campaignId)
        .eq("book_id", bookId);
      if (campaignStartError) throw campaignStartError;
    }

    // Seeded from the job's prior chunk(s) when continuing (jobId passed in) so
    // these accumulate across the whole logical job -- see priorProgress above.
    let attempted = priorProgress?.attempted ?? 0;
    let rewritten = priorProgress?.successful ?? 0;
    let failed = priorProgress?.failed ?? 0;
    // Unlike attempted/rewritten/failed, skipped/skippedExistingDrafts/
    // skippedAccepted stay fresh-per-request: the eligibility loop below
    // always re-scans every chapter/paragraph in the book (never just this
    // chunk), so by construction they're already an accurate whole-book
    // snapshot at whatever moment they're computed -- no accumulation needed.
    let skipped = 0;
    let skippedExistingDrafts = 0;
    let skippedAccepted = 0;
    let skippedPreviouslyFailed = 0;
    let jobSettings: unknown = {
      model,
      rewriteModelSelection: rewriteSelection,
      maxUnits: body.maxUnits || null,
      campaignId: body.campaignId || null,
      chapterId: body.chapterId || null,
      rewriteExistingDrafts: body.rewriteExistingDrafts,
      rewriteAccepted: body.rewriteAccepted,
      distributeAcrossChapters: body.distributeAcrossChapters,
      coverageMode: body.coverageMode,
      strategyId: rewriteStrategy.id,
      strategyLabel: rewriteStrategy.label,
      strategySettings: rewriteStrategy.settings,
      authorInstructions: body.authorInstructions || null,
      unit: "paragraph",
    };
    const { pendingDraftParagraphIds, acceptedParagraphIds } = getExistingRevisionState(
      (existingRevisions || []) as ExistingRevisionRow[],
    );
    const anyRevisionParagraphIds = new Set(
      ((existingRevisions || []) as ExistingRevisionRow[]).map((revision) => revision.paragraph_id).filter(Boolean),
    );
    const currentJobDraftParagraphIds = new Set(
      ((existingRevisions || []) as ExistingRevisionRow[])
        .filter((revision) => revision.revision_job_id === jobId)
        .map((revision) => revision.paragraph_id)
        .filter(Boolean),
    );
    const retryParagraphIds = body.retryJobId ? await getRetryParagraphIds(supabase, body.retryJobId) : null;
    // Paragraphs that already exhausted their retry budget (see maxCompletionAttempts
    // below) earlier in THIS SAME job. Without this exclusion, a paragraph that's
    // deterministically failing (not just randomly flaky) gets re-selected by every
    // subsequent chunk call forever -- eligibility is re-derived from durable state
    // each time and a failed attempt leaves no revision row behind, so nothing else
    // would ever move it out of the pool. Seen live: a job capped at 25 units spent
    // most of its budget re-attempting the same stuck paragraph instead of covering
    // 25 different ones. A dedicated retry (body.retryJobId, see getRetryParagraphIds)
    // is the deliberate way to give an excluded paragraph another shot later.
    const priorFailedParagraphIds = new Set(
      (priorProgress?.failedUnits || [])
        .filter((unit) => unit.type === "paragraph" && unit.id)
        .map((unit) => String(unit.id)),
    );
    // Declared up here (not just before its Promise.allSettled use below) so
    // it's also available to roundRobinUnits' block size just below -- both
    // uses must agree on the same chunk size, see the comment on the
    // eligibleUnits computation for why.
    const CONCURRENCY = 5;
    const warnings: unknown[] = [];
    const eligibleByChapter: RewriteUnit[][] = [];

    for (const [chapterIndex, chapter] of ((chapters || []) as ChapterRow[]).entries()) {
      if (chapter.exclude_from_rewrite) {
        continue;
      }
      if (body.chapterId && chapter.id !== body.chapterId) {
        continue;
      }
      const { data: paragraphs, error: paragraphsError } = await supabase
        .from("paragraphs")
        .select("id,paragraph_number,original_text,accepted_text,is_locked,scene_id")
        .eq("chapter_id", chapter.id)
        .order("paragraph_number");
      if (paragraphsError) throw paragraphsError;

      const rows = (paragraphs || []) as ParagraphRow[];
      if (body.coverageMode === "uncovered_chapter_sample" && rows.some((paragraph) => anyRevisionParagraphIds.has(paragraph.id))) {
        continue;
      }
      const chapterUnits: RewriteUnit[] = [];
      for (const [paragraphIndex, paragraph] of rows.entries()) {
        if (body.paragraphId && paragraph.id !== body.paragraphId) {
          continue;
        }
        if (retryParagraphIds && !retryParagraphIds.has(paragraph.id)) {
          continue;
        }
        if (priorFailedParagraphIds.has(paragraph.id)) {
          skipped += 1;
          skippedPreviouslyFailed += 1;
          continue;
        }
        if (paragraph.is_locked || (!body.forceTinyParagraphs && shouldSkipParagraph(paragraph.original_text, chapter.title))) {
          skipped += 1;
          continue;
        }
        if (currentJobDraftParagraphIds.has(paragraph.id)) {
          skipped += 1;
          skippedExistingDrafts += 1;
          continue;
        }
        if (!body.rewriteExistingDrafts && pendingDraftParagraphIds.has(paragraph.id)) {
          skipped += 1;
          skippedExistingDrafts += 1;
          continue;
        }
        if (!body.rewriteAccepted && acceptedParagraphIds.has(paragraph.id)) {
          skipped += 1;
          skippedAccepted += 1;
          continue;
        }

        chapterUnits.push({ chapter, chapterIndex, paragraph, paragraphIndex, rows });
      }
      if (chapterUnits.length) eligibleByChapter.push(chapterUnits);
      if (body.paragraphId && chapterUnits.length > 0) break;
    }

    // body.maxUnits caps the WHOLE job's total scope, not this one request's
    // freshly-recomputed pool -- eligibility is re-derived from scratch on
    // every chunk call, so re-applying the raw maxUnits each time would keep
    // re-capping to (say) 12 units of an ever-refilling multi-hundred-unit
    // pool instead of ever converging on "12 units total, then done."
    // Subtracting what's already been attempted (seeded from priorProgress)
    // turns it into a remaining-budget cap instead.
    const maxUnitsRemaining = body.maxUnits ? Math.max(0, body.maxUnits - attempted) : undefined;
    // Chunks below never span two chapters (each chunk takes a leading run of
    // same-chapter units off the front of eligibleUnits, see CONCURRENCY) --
    // so interleaving here has to hand out whole CONCURRENCY-sized blocks per
    // chapter, not single paragraphs. A naive per-paragraph round robin
    // (chapter1[0], chapter2[0], chapter3[0], ...) puts a different chapter
    // at every array position, so the very first chunk-building step below
    // would immediately hit a chapter boundary and cap every chunk at size
    // 1 -- silently discarding the concurrency batch AND, because each
    // chapter's remaining units keep landing back at the front of the very
    // next chunk call's freshly-rederived pool, the job could spend its
    // entire maxUnits budget circling the first couple of chapters instead
    // of ever reaching the rest of the book. Found live: four separate
    // full-book rewrite runs against a 6-chapter book, all with
    // distributeAcrossChapters true, produced revision_versions rows in
    // chapter 1 only.
    const eligibleUnits = limitEligibleUnits(
      body.distributeAcrossChapters ? roundRobinUnits(eligibleByChapter, CONCURRENCY) : eligibleByChapter.flat(),
      maxUnitsRemaining,
    );
    // Frozen on whichever chunk call first sees this job -- eligibleUnits
    // shrinks on every later chunk call as prior work lands revision_versions
    // rows, so re-deriving totalUnits from it each time would make the
    // progress bar's denominator shrink mid-run instead of the numerator
    // climbing toward a stable target.
    const totalUnits = priorProgress?.totalUnits || eligibleUnits.length;
    jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
      taskName: "Full-book rewrite draft",
      currentUnit: eligibleUnits.length ? `Rewrite unit ${attempted + 1} of ${totalUnits}` : "No eligible units",
      totalUnits,
      attempted,
      successful: rewritten,
      failed,
      skipped,
      startedAt: priorProgress?.startedAt || startedAt,
      estimatedSecondsPerUnit: estimateSecondsPerRewriteUnit(model),
      message:
        skipped > 0
          ? `Skipped ${skipped} locked, title-only, existing-draft, accepted, or already-failed-this-job paragraph(s) before the run.`
          : null,
    });

    // Model calls (the network-bound, slow part) run CONCURRENCY-at-a-time within
    // each chunk via Promise.allSettled (CONCURRENCY declared earlier, see the
    // eligibleUnits computation above). Everything that touches shared state —
    // counters, the revision_versions insert, and the job's progress row — happens
    // afterward in a plain sequential loop over that chunk's settled results, so
    // there's never more than one writer touching jobSettings/failedUnitsLog at once.
    // Seeded from priorProgress (not []) so failures accumulate across the whole
    // job instead of each chunk overwriting the last one's failedUnits in the
    // persisted settings -- otherwise "Retry failed only" (see getRetryParagraphIds)
    // could only ever see the most recent chunk's failures.
    const failedUnitsLog: Array<{ id: string; type: "paragraph"; label: string; error: string }> = (
      priorProgress?.failedUnits || []
    ).filter((unit) => unit.type === "paragraph" && unit.id) as Array<{
      id: string;
      type: "paragraph";
      label: string;
      error: string;
    }>;
    let hardError: unknown = null;

    async function runUnit(unit: RewriteUnit) {
      const { chapter, chapterIndex, paragraph, paragraphIndex, rows } = unit;
      const contextPacket = buildRewriteContextPacket({
        manuscriptBlueprint: bible?.content,
        rewritePlan: normalizedRewritePlan,
        dialogDensity: book?.dialog_density,
        chapter,
        previousChapterSummary: ((chapters || []) as ChapterRow[])[chapterIndex - 1]?.summary,
        nextChapterSummary: ((chapters || []) as ChapterRow[])[chapterIndex + 1]?.summary,
        paragraph,
        rows,
        paragraphIndex,
        criticReports: (criticReports || []) as Array<{
          report_type: string;
          content: Record<string, unknown> | null;
          created_at?: string | null;
        }>,
        lockedPassages: (lockedPassageRows || []) as LockedPassageContextRow[],
        acceptedRevisions: (acceptedRevisionRows || []) as AcceptedRevisionContextRow[],
        continuityLedger: (continuityLedger?.content as Record<string, unknown> | null) || null,
      });
      const prompt = buildFullBookRewriteUnitPrompt({
        manuscriptBlueprint: bible?.content,
        rewritePlan: normalizedRewritePlan,
        contextPacket,
        chapterTitle: chapter.title || `Chapter ${chapter.chapter_number}`,
        chapterSummary: chapter.summary,
        previousChapterSummary: ((chapters || []) as ChapterRow[])[chapterIndex - 1]?.summary,
        nextChapterSummary: ((chapters || []) as ChapterRow[])[chapterIndex + 1]?.summary,
        previousParagraph: rows[paragraphIndex - 1]?.original_text,
        nextParagraph: rows[paragraphIndex + 1]?.original_text,
        rewriteStrategy,
        authorInstructions: body.authorInstructions,
        voiceProfile: (bible as { voice_profile?: unknown } | null)?.voice_profile,
        dialogDensity: book?.dialog_density,
        paragraphNumber: paragraph.paragraph_number,
        text: paragraph.original_text,
      });

      const maxCompletionAttempts = 3;
      // Separate, tighter budget than the general retry loop: a connection
      // blip is cheap to retry, but if it happens twice in a row on the
      // same paragraph, a third attempt is unlikely to behave differently
      // and this paragraph should just be skipped like any other failure
      // rather than eating the whole chunk's retry budget on network noise.
      const maxTechnologyFailureAttempts = 2;
      let parsed: unknown = null;
      let revisedText = "";
      let technologyFailureAttempts = 0;
      for (let completionAttempt = 1; completionAttempt <= maxCompletionAttempts; completionAttempt += 1) {
        // Retrying a failed cloud call against the SAME model wastes a full
        // generation attempt for very little chance of a different outcome
        // -- the failure mode (e.g. deepseek-v4-pro's empty-completion bug)
        // is usually correlated with that specific model, not the prompt.
        // Found live: 25.6% of a real day's rewrite calls came back
        // completely empty, most from a model repeating its own failure.
        // Switch to a different cloud model starting on the second attempt
        // instead of just repeating the first one.
        const useFallbackModel =
          completionAttempt > 1 && preparedModel.isCloud && REWRITE_FALLBACK_MODEL !== model;
        let completion;
        try {
          completion = await createManagedChatCompletion(
            client,
            preparedModel,
            {
              temperature: Math.min(settings.temperature, 0.55),
              top_p: settings.topP,
              max_tokens: 1800,
              messages: [{ role: "user", content: prompt }],
              ...(useFallbackModel ? { model: REWRITE_FALLBACK_MODEL } : {}),
            },
            undefined,
            telemetryContext
              ? {
                  ...telemetryContext,
                  attempt: completionAttempt,
                  retry: completionAttempt > 1,
                }
              : undefined,
            { timeoutMs: REWRITE_UNIT_COMPLETION_TIMEOUT_MS },
          );
        } catch (completionError) {
          if (!isTechnologyFailure(completionError)) throw completionError;
          technologyFailureAttempts += 1;
          if (technologyFailureAttempts >= maxTechnologyFailureAttempts || completionAttempt >= maxCompletionAttempts) {
            break;
          }
          continue;
        }
        parsed = parseRewriteResponse(completion.choices[0]?.message.content || "{}");
        revisedText = extractRevisedText(parsed);
        if (revisedText) break;
      }

      return {
        unit,
        parsed,
        revisedText,
        emptyCompletionAttempts: maxCompletionAttempts,
        technologyFailureAttempts,
      };
    }

    // Exactly one chapter-bounded batch (<=CONCURRENCY paragraphs) per request --
    // never the full eligibleUnits list -- so a single HTTP request can't run
    // long enough to hit Vercel's function timeout on a full-book pass. The
    // caller (runChunkedJob, src/lib/ai/run-chunked-job.ts) is responsible for
    // calling this route again with the same jobId while remainingUnits > 0;
    // eligibleUnits is re-derived fresh from durable state (revision_versions
    // rows) on every such call, so a completed paragraph never gets
    // reprocessed and there's no separate cursor to keep in sync.
    // TEMPORARY diagnostic instrumentation -- see the self_chain_scheduled
    // comment further down. Brackets the whole chunk-processing region so
    // wherever the process actually dies, the last logged checkpoint pins
    // it down. Remove once the real cause is confirmed and fixed.
    const logDiag = (eventType: string, note: string) =>
      supabase.from("model_call_events").insert({
        user_id: user.id,
        job_id: jobId,
        model: "n/a",
        task: "rewrite_self_chain",
        context_length: 0,
        outcome: "info",
        error_signature: note,
        event_type: eventType,
      });

    let chunkProcessedCount = 0;
    if (eligibleUnits.length > 0 && !hardError) {
      await logDiag("diag_chunk_block_entered", `eligibleUnits=${eligibleUnits.length}`);
      const pauseStatus = await waitWhileRevisionJobPaused(supabase, jobId);
      const currentStatus = pauseStatus === "cancelled" ? "cancelled" : await getRevisionJobStatus(supabase, jobId);

      if (currentStatus !== "cancelled") {
        // Never let a chunk span two chapters: chapters are rewritten strictly one
        // after another (chapter N fully finishes before N+1 starts) to preserve
        // paragraph-to-paragraph and chapter-to-chapter drift/consistency. Only
        // paragraphs within the same chapter are ever run concurrently.
        const chunk = [eligibleUnits[0]];
        while (
          chunk.length < CONCURRENCY &&
          chunk.length < eligibleUnits.length &&
          eligibleUnits[chunk.length].chapter.id === chunk[0].chapter.id
        ) {
          chunk.push(eligibleUnits[chunk.length]);
        }
        // Atomic claim: same class of race as generate-draft's chapter-status
        // claim (see that route's "Atomic claim" comment, and the migration
        // 202608280003_paragraph_rewrite_claim.sql). This route self-chains
        // via after() the instant a chunk finishes, AND the browser's own
        // runChunkedJob driver calls back in with the same jobId -- normally
        // harmless, but if the client's follow-up gets delayed (e.g. a mobile
        // tab backgrounded by a screen lock) it can land while the
        // self-chained request is still mid-flight. Unlike chapters,
        // paragraphs have no "planned" status to flip and no unique
        // constraint on revision_versions.paragraph_id, so a lost race here
        // wouldn't hard-fail the job the way it did for generate-draft -- it
        // would silently double-spend and insert two revision_versions rows
        // for the same paragraph. Claim each unit in the chunk before
        // generating; only the caller that flips the claim from null gets to
        // process it.
        const claimedChunk: RewriteUnit[] = [];
        for (const unit of chunk) {
          const { data: claimRows, error: claimError } = await supabase
            .from("paragraphs")
            .update({ rewrite_claim_job_id: jobId })
            .eq("id", unit.paragraph.id)
            .is("rewrite_claim_job_id", null)
            .select("id");
          if (claimError) throw claimError;
          if (claimRows && claimRows.length > 0) claimedChunk.push(unit);
        }
        chunkProcessedCount = claimedChunk.length;
        await logDiag("diag_chunk_built", `chunkSize=${chunk.length} claimed=${claimedChunk.length}`);

        const releaseClaim = (paragraphId: string) =>
          supabase.from("paragraphs").update({ rewrite_claim_job_id: null }).eq("id", paragraphId).eq("rewrite_claim_job_id", jobId);

        if (claimedChunk.length > 0) {
          const heartbeat = createRevisionJobHeartbeat(supabase, jobId, jobSettings, {
            currentUnit: `Rewrite units ${attempted + 1}-${attempted + claimedChunk.length} of ${totalUnits}`,
            totalUnits,
            attempted,
            successful: rewritten,
            failed,
            skipped,
          });
          const settled = await withBookForgeWorkflowSpan(
            {
              workflow: "rewrite",
              operation: "paragraph-chunk",
              unitCount: claimedChunk.length,
            },
            async (workflowSpan) => {
              workflowSpan.addEvent("rewrite.chunk.start", {
                "rewrite.unit_count": claimedChunk.length,
              });

              const results = await Promise.allSettled(
                claimedChunk.map((unit) => runUnit(unit)),
              );

              const fulfilled = results.filter(
                (result) => result.status === "fulfilled",
              ).length;

              workflowSpan.setAttributes({
                "bookforge.workflow.fulfilled_calls": fulfilled,
                "bookforge.workflow.rejected_calls":
                  results.length - fulfilled,
                "bookforge.rewrite.strategy": rewriteStrategy.id,
              });

              workflowSpan.addEvent("rewrite.chunk.complete", {
                "rewrite.fulfilled_calls": fulfilled,
                "rewrite.rejected_calls": results.length - fulfilled,
              });

              return results;
            },
          );
          heartbeat.stop();
          await logDiag("diag_settled_resolved", `results=${settled.length}`);

          for (const [chunkIndex, result] of settled.entries()) {
            const unit = claimedChunk[chunkIndex];
            const { chapter, paragraph } = unit;
            const unitLabel = `chapter ${chapter.chapter_number}, paragraph ${paragraph.paragraph_number}`;
            attempted += 1;

            if (result.status === "rejected") {
              failed += 1;
              const message = getErrorMessage(result.reason);
              failedUnitsLog.push({ id: paragraph.id, type: "paragraph", label: `Chapter ${chapter.chapter_number}, paragraph ${paragraph.paragraph_number}`, error: message });
              hardError = hardError || result.reason;
              jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
                currentUnit: `Failed at ${unitLabel}`,
                totalUnits,
                attempted,
                successful: rewritten,
                failed,
                skipped,
                message,
                failedUnits: failedUnitsLog,
              });
              await releaseClaim(paragraph.id);
              break;
            }

            const { parsed, revisedText, emptyCompletionAttempts, technologyFailureAttempts } = result.value;
            if (!revisedText) {
              failed += 1;
              const message =
                technologyFailureAttempts > 0
                  ? `Connection/timeout error after ${technologyFailureAttempts} attempt(s); paragraph left untouched.`
                  : `Model returned an empty completion after ${emptyCompletionAttempts} attempt(s); paragraph left untouched.`;
              failedUnitsLog.push({ id: paragraph.id, type: "paragraph", label: `Chapter ${chapter.chapter_number}, paragraph ${paragraph.paragraph_number}`, error: message });
              jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
                currentUnit: `Empty completion at ${unitLabel}`,
                totalUnits,
                attempted,
                successful: rewritten,
                failed,
                skipped,
                message,
                failedUnits: failedUnitsLog,
              });
              await releaseClaim(paragraph.id);
              continue;
            }

            const continuityWarnings = extractArray(parsed, "continuityWarnings");
            const { error: versionError } = await supabase.from("revision_versions").insert({
              revision_job_id: jobId,
              book_id: bookId,
              chapter_id: chapter.id,
              scene_id: paragraph.scene_id,
              paragraph_id: paragraph.id,
              original_text: paragraph.original_text,
              revised_text: revisedText,
              revision_notes: extractString(parsed, "revisionNotes") || "Full-book rewrite draft.",
              continuity_warnings: continuityWarnings,
            });
            if (versionError) {
              failed += 1;
              const message = getErrorMessage(versionError);
              failedUnitsLog.push({ id: paragraph.id, type: "paragraph", label: `Chapter ${chapter.chapter_number}, paragraph ${paragraph.paragraph_number}`, error: message });
              hardError = hardError || versionError;
              jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
                currentUnit: `Failed to save ${unitLabel}`,
                totalUnits,
                attempted,
                successful: rewritten,
                failed,
                skipped,
                message,
                failedUnits: failedUnitsLog,
              });
              await releaseClaim(paragraph.id);
              break;
            }

            rewritten += 1;
            warnings.push(...continuityWarnings);
            jobSettings = await updateRevisionJobProgress(supabase, jobId, jobSettings, {
              currentUnit: `Rewrite unit ${attempted} of ${totalUnits}`,
              totalUnits,
              attempted,
              successful: rewritten,
              failed,
              skipped,
              failedUnits: failedUnitsLog,
            });
            await releaseClaim(paragraph.id);
          }
        }
      }
    }

    await logDiag("diag_loop_completed", `hardError=${Boolean(hardError)} chunkProcessedCount=${chunkProcessedCount}`);

    if (hardError) throw hardError;

    const remainingUnits = Math.max(0, eligibleUnits.length - chunkProcessedCount);
    const statusAfterChunk = await getRevisionJobStatus(supabase, jobId);
    const isCancelledAfterChunk = statusAfterChunk === "cancelled";

    if (!isCancelledAfterChunk && remainingUnits > 0) {
      // More eligible work remains -- stop here rather than looping into
      // another chunk within this same request. The job stays "running".
      //
      // This used to leave dispatching the next chunk entirely up to the
      // caller -- fine when the orchestrator's own server-side loop is
      // driving it, but the manual Rewrite Architect flow drives this from
      // the BROWSER (runChunkedJob's client-side loop), so navigating away,
      // closing the tab, or the tab getting backgrounded/throttled just
      // silently stops all further progress. Found live: a real full-book
      // rewrite sat at "unit 1 of 25" for hours with no auto_review_jobs
      // row driving it at all. Self-chain a continuation here too, same
      // fire-and-forget pattern the auto-review orchestrator already uses,
      // so the server keeps making progress on its own regardless of
      // whether anyone's still watching. A still-open browser tab's own
      // call becomes redundant but harmless -- eligibility is re-derived
      // fresh from revision_versions every call, so whichever caller (this
      // self-chain or the browser) gets there first just does the work;
      // the other finds it already done and skips it.
      //
      // A bare un-awaited `void fetch(...)` here is NOT safe: Vercel is free
      // to freeze/tear down this function's execution the instant the
      // response below is sent, before that fetch's request even leaves the
      // machine. after() is the platform-supported way to guarantee this
      // keeps running post-response -- see the same fix applied to
      // generate-draft and the auto-review orchestrator's own
      // checkpoint continuations, which had this identical latent bug.
      //
      // chunkProcessedCount > 0 additionally gates this: if every unit in
      // this chunk lost its atomic claim above (see "Atomic claim" comment
      // on the claim loop), this call did no real work, and the paragraphs
      // it tried for still look eligible to it (no revision_versions row
      // exists yet) -- self-chaining again here would just lose the claim
      // again and spin in a tight loop for as long as the actual winner is
      // still generating. The response below still correctly reports
      // status "running" either way; only the extra self-chained request is
      // skipped, since the winner's own eventual self-chain and the
      // client's independent polling redrive already keep the job moving.
      if (!body.externalDriver && chunkProcessedCount > 0) {
        const cookie = request.headers.get("cookie") || "";
        const selfUrl = new URL(request.url);
        // TEMPORARY diagnostic instrumentation: this self-chain has silently
        // died twice now (bare void fetch, then after()) with zero trace in
        // Vercel logs or anywhere else queryable. Writing directly to
        // model_call_events (already has job_id/event_type/outcome) turns
        // the DB itself into a log so the next failure is diagnosable
        // without log access at all. Remove once the real cause is found.
        await supabase.from("model_call_events").insert({
          user_id: user.id,
          job_id: jobId,
          model: "n/a",
          task: "rewrite_self_chain",
          context_length: 0,
          outcome: "info",
          error_signature: `scheduled remainingUnits=${remainingUnits}`,
          event_type: "self_chain_scheduled",
        });
        after(async () => {
          try {
            const res = await fetch(selfUrl.toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json", cookie },
              body: JSON.stringify({ ...body, jobId }),
            });
            await supabase.from("model_call_events").insert({
              user_id: user.id,
              job_id: jobId,
              model: "n/a",
              task: "rewrite_self_chain",
              context_length: 0,
              outcome: res.ok ? "success" : "error",
              error_signature: `fetch resolved status=${res.status}`,
              event_type: "self_chain_fetch_resolved",
            });
          } catch (chainError) {
            await supabase.from("model_call_events").insert({
              user_id: user.id,
              job_id: jobId,
              model: "n/a",
              task: "rewrite_self_chain",
              context_length: 0,
              outcome: "error",
              error_signature: `fetch threw: ${getErrorMessage(chainError)}`,
              event_type: "self_chain_fetch_threw",
            });
          }
        });
      }

      return NextResponse.json({
        content: {
          revisionJobId: jobId,
          jobId,
          model,
          attempted,
          rewritten,
          failed,
          skipped,
          skippedExistingDrafts,
          skippedAccepted,
          skippedPreviouslyFailed,
          totalUnits,
          remainingUnits,
          status: "running",
        },
      });
    }

    const completedAt = new Date().toISOString();
    const finalStatus = isCancelledAfterChunk ? "cancelled" : statusAfterChunk;
    const completedStatus = finalStatus === "cancelled" ? "cancelled" : "completed";
    const { error: updateError } = await supabase
      .from("revision_jobs")
      .update({
        status: completedStatus,
        completed_at: completedAt,
        settings: {
          model,
          campaignId: body.campaignId || null,
          chapterId: body.chapterId || null,
          rewriteModelSelection: rewriteSelection,
          maxUnits: body.maxUnits || null,
          rewriteExistingDrafts: body.rewriteExistingDrafts,
          rewriteAccepted: body.rewriteAccepted,
          distributeAcrossChapters: body.distributeAcrossChapters,
          coverageMode: body.coverageMode,
          strategyId: rewriteStrategy.id,
          strategyLabel: rewriteStrategy.label,
          strategySettings: rewriteStrategy.settings,
          authorInstructions: body.authorInstructions || null,
          unit: "paragraph",
          attempted,
          rewritten,
          failed,
          skipped,
          skippedExistingDrafts,
          skippedAccepted,
          skippedPreviouslyFailed,
          retryJobId: body.retryJobId || null,
          warningCount: warnings.length,
          progress: buildJobProgress({
            taskName: "Full-book rewrite draft",
            currentUnit: completedStatus === "cancelled" ? "Cancelled" : "Complete",
            totalUnits,
            attempted,
            successful: rewritten,
            failed,
            skipped,
            failedUnits: failedUnitsLog,
            startedAt: priorProgress?.startedAt || startedAt,
            completedAt,
            estimatedSecondsPerUnit: estimateSecondsPerRewriteUnit(model),
            message:
              completedStatus === "cancelled"
                ? "The rewrite was cancelled. Saved revision versions remain available for review."
                : "Rewrite draft versions saved. Review, accept, reject, or rerun selected paragraphs.",
          }),
        },
      })
      .eq("id", jobId);
    if (updateError) throw updateError;

    if (body.campaignId) {
      const campaignStats = await getCampaignStats(supabase, bookId);
      const { data: campaign } = await supabase
        .from("rewrite_campaigns")
        .select("goal,batches_run")
        .eq("id", body.campaignId)
        .eq("book_id", bookId)
        .maybeSingle();
      const campaignComplete = campaign
        ? isCampaignComplete(String(campaign.goal || "full_coverage"), campaignStats)
        : false;
      const { error: campaignUpdateError } = await supabase
        .from("rewrite_campaigns")
        .update({
          status: completedStatus === "cancelled" ? "cancelled" : campaignComplete ? "completed" : "active",
          total_paragraphs: campaignStats.totalParagraphs,
          untouched_paragraphs: campaignStats.untouchedParagraphs,
          pending_draft_paragraphs: campaignStats.pendingDraftParagraphs,
          accepted_paragraphs: campaignStats.acceptedParagraphs,
          sampled_chapters: campaignStats.sampledChapters,
          fully_covered_chapters: campaignStats.fullyCoveredChapters,
          total_chapters: campaignStats.totalChapters,
          batches_run: Number(campaign?.batches_run || 0) + 1,
          last_revision_job_id: jobId,
          completed_at: campaignComplete || completedStatus === "cancelled" ? completedAt : null,
          updated_at: completedAt,
        })
        .eq("id", body.campaignId)
        .eq("book_id", bookId);
      if (campaignUpdateError) throw campaignUpdateError;
    }

    // Known limitation of the chunking refactor, flagged not hidden:
    // `warnings` only holds THIS final chunk's continuity warnings, not the
    // whole job's -- unlike attempted/rewritten/failed, warnings were never
    // persisted anywhere between chunks (only their count, via
    // `warningCount`), so there's nothing to seed them from here. A book
    // whose earlier chunks produced continuity warnings will undercount them
    // in this report. attempted/rewritten/failed/skipped counts above remain
    // fully accurate (cumulative), and this cap already existed pre-refactor
    // (`.slice(0, 100)`), so this narrows an existing imprecision rather than
    // introducing a new class of one.
    await supabase.from("coherence_reports").insert({
      book_id: bookId,
      report_type: "rewrite_execution",
      content: {
        revisionJobId: jobId,
        model,
        attempted,
        rewritten,
        failed,
        skipped,
        skippedExistingDrafts,
        skippedAccepted,
        skippedPreviouslyFailed,
        continuityWarnings: warnings.slice(0, 100),
        startedAt: priorProgress?.startedAt || startedAt,
        completedAt,
        nextStep: "Review revision versions, accept or reject changes, then rerun all BookForge Critic lenses.",
      },
    });

    return NextResponse.json({
      content: {
        revisionJobId: jobId,
        jobId,
        model,
        attempted,
        rewritten,
        failed,
        skipped,
        skippedExistingDrafts,
        skippedAccepted,
        skippedPreviouslyFailed,
        totalUnits,
        remainingUnits: 0,
        continuityWarningCount: warnings.length,
        status: completedStatus,
      },
    });
  } catch (error) {
    console.error("Rewrite execution failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

type RewriteUnit = {
  chapter: ChapterRow;
  chapterIndex: number;
  paragraph: ParagraphRow;
  paragraphIndex: number;
  rows: ParagraphRow[];
};

// Interleaves in blockSize-sized blocks per chapter, not single units --
// the chunk-building step downstream takes a leading run of same-chapter
// units off the front of this output and stops at the first chapter
// boundary, so a naive one-unit-per-chapter interleave (chapter1[0],
// chapter2[0], chapter3[0], ...) would put a different chapter at every
// array position and cap every chunk at size 1 regardless of CONCURRENCY.
// Pass CONCURRENCY as blockSize so each chapter contributes a full chunk's
// worth before rotating to the next chapter -- book-wide coverage still
// advances chapter by chapter across chunks, chunks still never span two
// chapters, and CONCURRENCY-at-a-time actually happens.
function roundRobinUnits(groups: RewriteUnit[][], blockSize: number) {
  const output: RewriteUnit[] = [];
  const cursors = new Array(groups.length).fill(0);
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const start = cursors[index];
      if (start >= group.length) continue;
      const end = Math.min(start + blockSize, group.length);
      output.push(...group.slice(start, end));
      cursors[index] = end;
      if (end < group.length) remaining = true;
    }
  }
  return output;
}

function limitEligibleUnits(units: RewriteUnit[], maxUnits?: number) {
  // maxUnits === 0 (whole job's budget already exhausted, see
  // maxUnitsRemaining above) must return an empty list, not the unbounded
  // one -- a `maxUnits ? ... : units` ternary would treat 0 as falsy and
  // silently ignore the cap.
  return maxUnits === undefined ? units : units.slice(0, maxUnits);
}

async function getRetryParagraphIds(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  jobId: string,
) {
  const { data, error } = await supabase.from("revision_jobs").select("settings").eq("id", jobId).single();
  if (error) throw error;
  const settings = data.settings as RetryJobSettings | null;
  const ids = (settings?.progress?.failedUnits || [])
    .filter((unit) => unit.type === "paragraph" && unit.id)
    .map((unit) => String(unit.id));
  return ids.length ? new Set(ids) : new Set<string>();
}

function estimateSecondsPerRewriteUnit(model: string) {
  const lower = model.toLowerCase();
  if (/(70b|72b)/.test(lower)) return 55;
  if (/(30b|32b|34b)/.test(lower)) return 32;
  if (/(14b|13b)/.test(lower)) return 20;
  if (/(7b|8b)/.test(lower)) return 12;
  return 24;
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function parseRewriteResponse(content: string) {
  return parseModelJsonOrFallback(content, (raw, parseError) => {
    // If the raw fallback text looks like an attempted (but broken or
    // truncated) JSON object -- rather than genuine free-form prose the
    // model wrote instead of JSON -- using it verbatim would leak literal
    // braces/partial field names into reader-facing manuscript text. A
    // model ignoring the JSON-wrapping instruction would never coincidentally
    // start its prose with a literal "{", so checking for a full
    // '"revisedText":' match is too narrow: a response truncated after only
    // a few characters (e.g. '{\n  "revised') still starts with "{" but
    // never reaches that far, and previously slipped through as "valid"
    // text. Treat ANY raw text starting with "{" as a failed attempt instead
    // so the caller's retry loop fires again (or the paragraph is correctly
    // logged as failed) rather than silently corrupting accepted text.
    const looksLikeBrokenJson = /^\s*\{/.test(raw);
    return {
      revisedText: looksLikeBrokenJson ? "" : raw,
      revisionNotes: `Model returned malformed JSON: ${parseError}`,
      continuityWarnings: [],
      ledgerUpdates: [],
      confidence: 0,
    };
  });
}

function extractRevisedText(parsed: unknown) {
  return parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).revisedText === "string"
    ? String((parsed as Record<string, unknown>).revisedText).trim()
    : "";
}

function extractString(parsed: unknown, key: string) {
  return parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[key] === "string"
    ? String((parsed as Record<string, unknown>)[key])
    : "";
}

function extractArray(parsed: unknown, key: string) {
  return parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)[key])
    ? ((parsed as Record<string, unknown>)[key] as unknown[])
    : [];
}

async function getCampaignStats(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  bookId: string,
) {
  const [
    { count: paragraphCount },
    { data: chapters, error: chaptersError },
    { data: paragraphs, error: paragraphsError },
    { data: pendingDrafts, error: pendingError },
    { data: acceptedDrafts, error: acceptedError },
    { data: revisionRows, error: revisionError },
  ] = await Promise.all([
    supabase.from("paragraphs").select("id", { count: "exact", head: true }).eq("book_id", bookId),
    supabase.from("chapters").select("id").eq("book_id", bookId),
    supabase.from("paragraphs").select("id,chapter_id").eq("book_id", bookId),
    supabase
      .from("revision_versions")
      .select("paragraph_id")
      .eq("book_id", bookId)
      .eq("accepted", false)
      .eq("rejected", false)
      .not("paragraph_id", "is", null),
    supabase
      .from("revision_versions")
      .select("paragraph_id")
      .eq("book_id", bookId)
      .eq("accepted", true)
      .not("paragraph_id", "is", null),
    supabase
      .from("revision_versions")
      .select("paragraph_id")
      .eq("book_id", bookId)
      .not("paragraph_id", "is", null),
  ]);
  if (chaptersError) throw chaptersError;
  if (paragraphsError) throw paragraphsError;
  if (pendingError) throw pendingError;
  if (acceptedError) throw acceptedError;
  if (revisionError) throw revisionError;

  const pendingDraftParagraphCount = new Set((pendingDrafts || []).map((row) => row.paragraph_id).filter(Boolean)).size;
  const acceptedParagraphCount = new Set((acceptedDrafts || []).map((row) => row.paragraph_id).filter(Boolean)).size;
  const paragraphIdsWithRevisions = new Set((revisionRows || []).map((row) => row.paragraph_id).filter(Boolean));
  const paragraphsByChapter = (paragraphs || []).reduce<Record<string, Array<{ id: string }>>>((groups, paragraph) => {
    groups[paragraph.chapter_id] ||= [];
    groups[paragraph.chapter_id].push(paragraph);
    return groups;
  }, {});
  const coverage = (chapters || []).map((chapter) => {
    const chapterParagraphs = paragraphsByChapter[chapter.id] || [];
    return {
      totalParagraphs: chapterParagraphs.length,
      rewrittenParagraphs: chapterParagraphs.filter((paragraph) => paragraphIdsWithRevisions.has(paragraph.id)).length,
    };
  });
  const totalChapters = coverage.filter((chapter) => chapter.totalParagraphs > 0).length;
  const sampledChapters = coverage.filter((chapter) => chapter.rewrittenParagraphs > 0).length;
  const fullyCoveredChapters = coverage.filter(
    (chapter) => chapter.totalParagraphs > 0 && chapter.rewrittenParagraphs >= chapter.totalParagraphs,
  ).length;
  const totalParagraphs = paragraphCount || 0;

  return {
    totalParagraphs,
    untouchedParagraphs: Math.max(0, totalParagraphs - pendingDraftParagraphCount - acceptedParagraphCount),
    pendingDraftParagraphs: pendingDraftParagraphCount,
    acceptedParagraphs: acceptedParagraphCount,
    sampledChapters,
    fullyCoveredChapters,
    totalChapters,
  };
}

function isCampaignComplete(goal: string, stats: Awaited<ReturnType<typeof getCampaignStats>>) {
  if (goal === "sample_all_chapters") {
    return stats.totalChapters > 0 && stats.sampledChapters >= stats.totalChapters;
  }
  if (goal === "full_coverage") {
    return stats.totalParagraphs > 0 && stats.untouchedParagraphs <= 0;
  }
  return false;
}
