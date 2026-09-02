import { estimateAiCallPlan } from "@/lib/ai/call-planner";
import { buildCriticPrompt } from "@/lib/critic/prompts";
import { extractCriticScore } from "@/lib/critic/score";
import { summarizeCriticContent } from "@/lib/critic/summary";
import { computeDialogueRatio } from "@/lib/dialogue-density";
import { createManagedChatCompletion } from "@/lib/lmstudio/client";
import { parseModelJsonOrFallback } from "@/lib/lmstudio/json";
import { getReasoningModelCandidates } from "@/lib/lmstudio/model-selection";
import { selectAndPrepareActiveModel } from "@/lib/lmstudio/orchestrator";
import { getUserLmStudioSettings } from "@/lib/lmstudio/settings";
import type { CriticLens } from "@/lib/types";

type SupabaseClient = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

type CriticStage = "baseline" | "post_rewrite";

type ChapterRow = {
  id: string;
  title: string | null;
  summary: string | null;
};

type ParagraphRow = {
  chapter_id: string;
  paragraph_number: number;
  original_text: string;
  accepted_text: string | null;
};

export type CriticRunContext = {
  title: string;
  bookBible: unknown;
  chapterRows: ChapterRow[];
  acceptedRevisionContext?: Array<{
    title: string;
    acceptedTextSample: string;
    acceptedParagraphs: number;
    totalParagraphs: number;
  }>;
  sceneCount: number;
  paragraphCount: number;
  dialogueMetrics: {
    perChapter: Array<{ title: string; ratio: number; wordCount: number }>;
    overallRatio: number;
  };
  targetDialogDensity: string | null;
};

type CriticModelExecution = {
  settings: Awaited<ReturnType<typeof getUserLmStudioSettings>>;
  modelPlan: Awaited<ReturnType<typeof selectAndPrepareActiveModel>>;
};

const DEFAULT_CLOUD_CRITIC_TIMEOUT_MS = 140_000;
// Local execution needs a longer default than cloud: critic/all dispatches
// every lens concurrently (see that route), and a local LM Studio instance
// doesn't truly parallelize -- multiple simultaneous large-context critic
// generations queue/contend for the same GPU, so a lens near the back of
// that queue can still be legitimately waiting when the 140s cloud-tuned
// budget would already have expired it. Confirmed live: 4 of 8 lenses in one
// batch failed at exactly ~140.0s (model_call_events duration_ms 140013-
// 140021) while the other 4 succeeded in 98-124s -- a real queueing effect,
// not a connection/abort bug. See also critic/all's own concurrency cap,
// which reduces how much queuing this has to absorb in the first place.
const DEFAULT_LOCAL_CRITIC_TIMEOUT_MS = 300_000;

function getCriticTimeoutMs(isCloud: boolean) {
  const raw = process.env.BOOKFORGE_CRITIC_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return isCloud ? DEFAULT_CLOUD_CRITIC_TIMEOUT_MS : DEFAULT_LOCAL_CRITIC_TIMEOUT_MS;
}

export async function preloadCriticRunContext(input: {
  supabase: SupabaseClient;
  bookId: string;
  stage: CriticStage;
}): Promise<CriticRunContext> {
  const [
    { data: book, error: bookError },
    { data: bible },
    { data: chapters, error: chaptersError },
    { data: paragraphsForContext },
    { count: scenes },
    { count: paragraphs },
  ] = await Promise.all([
    input.supabase.from("books").select("title,dialog_density").eq("id", input.bookId).single(),
    input.supabase.from("book_bibles").select("content").eq("book_id", input.bookId).maybeSingle(),
    input.supabase.from("chapters").select("id,title,summary").eq("book_id", input.bookId).order("chapter_number"),
    input.supabase
      .from("paragraphs")
      .select("chapter_id,paragraph_number,original_text,accepted_text")
      .eq("book_id", input.bookId)
      .order("paragraph_number"),
    input.supabase.from("scenes").select("id", { count: "exact", head: true }).eq("book_id", input.bookId),
    input.supabase.from("paragraphs").select("id", { count: "exact", head: true }).eq("book_id", input.bookId),
  ]);

  if (bookError) throw bookError;
  if (chaptersError) throw chaptersError;

  const chapterRows = (chapters || []) as ChapterRow[];
  const paragraphRows = (paragraphsForContext || []) as ParagraphRow[];

  return {
    title: book.title,
    bookBible: bible?.content,
    chapterRows,
    acceptedRevisionContext:
      input.stage === "post_rewrite" ? buildAcceptedRevisionContext(chapterRows, paragraphRows) : undefined,
    sceneCount: scenes || 0,
    paragraphCount: paragraphs || 0,
    dialogueMetrics: computeDialogueMetrics(chapterRows, paragraphRows),
    targetDialogDensity: book.dialog_density || null,
  };
}

export async function preloadCriticModelExecution(supabase: SupabaseClient, userId: string): Promise<CriticModelExecution> {
  const settings = await getUserLmStudioSettings(userId);
  const modelPlan = await selectAndPrepareActiveModel(settings, {
    task: "critic",
    candidates: getReasoningModelCandidates(settings),
    expectedCalls: 1,
    latencyPreference: settings.qualityProfile === "fast" ? "fast" : "quality",
    telemetry: { supabase, userId },
  });
  return { settings, modelPlan };
}

export async function runCriticLens(input: {
  supabase: SupabaseClient;
  bookId: string;
  userId: string;
  lens: CriticLens;
  stage?: CriticStage;
  preloadedContext?: CriticRunContext;
  modelExecution?: CriticModelExecution;
  /**
   * Only meaningful when stage is "post_rewrite". Also saves this same
   * evaluation as a critic:{lens} baseline row so it seeds the *next*
   * rewrite plan instead of being a dead end (see plan-prompt.ts).
   */
  alsoRefreshBaseline?: boolean;
}) {
  const stage = input.stage || "baseline";
  const context =
    input.preloadedContext ||
    (await preloadCriticRunContext({
      supabase: input.supabase,
      bookId: input.bookId,
      stage,
    }));
  const modelExecution = input.modelExecution || (await preloadCriticModelExecution(input.supabase, input.userId));
  const { settings, modelPlan } = modelExecution;
  const { client, model, preparedModel, modelSelection, telemetryContext } = modelPlan;
  const chapterRows = context.chapterRows;
  const plan = estimateAiCallPlan({
    task: "critic",
    selectedModel: model,
    qualityProfile: settings.qualityProfile,
    contextWindowTokens: preparedModel.runtimeLimits.configuredContextTokens,
    maxOutputTokens: preparedModel.runtimeLimits.maxOutputTokens,
    chapterCount: chapterRows.length,
    sceneCount: context.sceneCount,
    paragraphCount: context.paragraphCount,
  });

  const prompt = buildCriticPrompt({
    title: context.title,
    bookBible: context.bookBible,
    chapterSummaries: chapterRows.map((chapter) => ({
      title: chapter.title || "Untitled chapter",
      summary: chapter.summary,
    })),
    acceptedRevisionContext: stage === "post_rewrite" ? context.acceptedRevisionContext : undefined,
    rewriteStage: stage,
    lens: input.lens,
    promptCharBudget: preparedModel.runtimeLimits.promptCharBudget,
    dialogueMetrics: context.dialogueMetrics,
    targetDialogDensity: context.targetDialogDensity,
  });

  // Up to 2 attempts: deepseek-v4-pro (the default cloud critic model) has a
  // documented ~17% empty-completion rate under this exact workload (see
  // project_openrouter_stress_test memory). A single attempt with no retry
  // meant an empty completion defaulted straight to the literal "{}" below,
  // which parses as valid JSON -- so the report silently "succeeded" with
  // every field empty and score: null, and the UI showed the misleading
  // "ANALYZED, NO SCORE" state instead of a clear failure to retry. Mirrors
  // the same fix already applied to rewrite-execute's per-paragraph loop.
  const criticFallbackModel = "google/gemini-2.5-flash";
  const maxCompletionAttempts = 2;
  let rawContent = "";
  for (let attempt = 1; attempt <= maxCompletionAttempts; attempt += 1) {
    const useFallbackModel = attempt > 1 && preparedModel.isCloud && criticFallbackModel !== model;
    const completion = await createManagedChatCompletion(
      client,
      preparedModel,
      {
        temperature: 0.3,
        top_p: settings.topP,
        messages: [{ role: "user", content: prompt }],
        ...(useFallbackModel ? { model: criticFallbackModel } : {}),
      },
      undefined,
      telemetryContext,
      // Default CLOUD_PROVIDER_TIMEOUT_MS (45s) undersold a single critic
      // lens: a real production stall traced back to this call hitting a
      // platform-level kill (no maxDuration on the calling route) before the
      // SDK timeout, network error, or anything else ever got a chance to
      // throw a catchable error -- the job just sat "running" with a stale
      // heartbeat until the 10-minute stale-job sweep force-failed it. A
      // Starter-tier account runs every task (including critic, originally
      // budgeted around a faster model) on deepseek-v4-pro, live-measured at
      // ~39 tokens/sec through OpenRouter's current routing -- the default
      // 4,096-token cloud budget alone can need ~105s. See maxDuration on the
      // calling route(s) for the matching platform-level budget.
      { timeoutMs: getCriticTimeoutMs(Boolean(preparedModel.isCloud)) },
    );
    rawContent = (completion.choices[0]?.message.content || "").trim();
    if (rawContent) break;
  }

  // Still empty after every attempt -- say so honestly instead of parsing
  // the placeholder "{}" into a report that looks like a real (if scoreless)
  // analysis. Distinct from a genuine parse failure (raw text that isn't
  // valid JSON), which still goes through parseModelJsonOrFallback below.
  const parsed = rawContent
    ? parseModelJsonOrFallback(rawContent, (raw, parseError) => ({
        score: null,
        executiveSummary: raw,
        strengths: [],
        risks: [],
        highestLeverageFixes: [],
        chapterNotes: [],
        continuityFlags: [],
        voiceAndStyleNotes: [],
        marketPositioning: [],
        nextRevisionPlan: [],
        parseWarning: parseError,
        rawModelResponse: raw,
      }))
    : {
        score: null,
        executiveSummary: `The AI model returned an empty response after ${maxCompletionAttempts} attempt(s). This is a known model-side issue, not a problem with your manuscript -- rerun this lens to try again.`,
        strengths: [],
        risks: [],
        highestLeverageFixes: [],
        chapterNotes: [],
        continuityFlags: [],
        voiceAndStyleNotes: [],
        marketPositioning: [],
        nextRevisionPlan: [],
        emptyCompletionAttempts: maxCompletionAttempts,
      };
  const parsedContent =
    typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : { executiveSummary: String(parsed) };
  const numericScore = extractCriticScore(parsedContent);
  const executiveSummary = summarizeCriticContent(parsedContent);
  const normalized = normalizeCriticReportContent(parsedContent);
  const content = {
    ...normalized,
    ...(parsedContent.score && typeof parsedContent.score === "object" && !normalized.scoreBreakdown
      ? { scoreBreakdown: parsedContent.score }
      : {}),
    executiveSummary,
    score: numericScore,
    rewriteStage: stage,
    aiCallPlan: {
      ...plan,
      expectedCalls: 1,
      actualCalls: 1,
      lmStudioRuntimeLimits: preparedModel.runtimeLimits,
      lmStudioWarnings: preparedModel.warnings,
      modelSelection,
    },
  };

  const { error: reportError } = await input.supabase.from("coherence_reports").insert({
    book_id: input.bookId,
    report_type: stage === "post_rewrite" ? `critic_post:${input.lens}` : `critic:${input.lens}`,
    content,
  });
  if (reportError) throw reportError;

  if (stage === "post_rewrite" && input.alsoRefreshBaseline) {
    const { error: baselineError } = await input.supabase.from("coherence_reports").insert({
      book_id: input.bookId,
      report_type: `critic:${input.lens}`,
      content,
    });
    if (baselineError) throw baselineError;
  }

  return content;
}

function normalizeCriticReportContent(content: Record<string, unknown>) {
  const normalized = { ...content };

  // Canonical summary key used by UI cards.
  if (!stringValue(normalized.executiveSummary)) {
    normalized.executiveSummary =
      stringValue(normalized.summary) ||
      stringValue(normalized.overview) ||
      stringValue(normalized.assessment) ||
      stringValue(normalized.finalVerdict) ||
      stringValue(normalized.conclusion) ||
      "";
  }

  normalized.strengths = toArray(normalized.strengths);
  normalized.risks = toArray(normalized.risks);
  normalized.chapterNotes = toArray(normalized.chapterNotes);
  normalized.continuityFlags = toArray(normalized.continuityFlags);
  normalized.voiceAndStyleNotes = toArray(normalized.voiceAndStyleNotes);
  normalized.marketPositioning = toArray(normalized.marketPositioning);
  normalized.nextRevisionPlan = toArray(normalized.nextRevisionPlan);

  // Fixes can arrive under several equivalent keys.
  const highestLeverageFixes =
    toArray(normalized.highestLeverageFixes).length
      ? toArray(normalized.highestLeverageFixes)
      : toArray(normalized.keyFixes).length
        ? toArray(normalized.keyFixes)
        : toArray(normalized.priorityFixes);
  normalized.highestLeverageFixes = highestLeverageFixes;

  const recommendedFixes =
    toArray(normalized.recommendedFixes).length
      ? toArray(normalized.recommendedFixes)
      : toArray(normalized.suggestedFixes).length
        ? toArray(normalized.suggestedFixes)
        : toArray(normalized.actionItems);
  normalized.recommendedFixes = recommendedFixes;

  // Finding-oriented aliases used by some models.
  normalized.findings = toArray(normalized.findings).length
    ? toArray(normalized.findings)
    : toArray(normalized.keyFindings).length
      ? toArray(normalized.keyFindings)
      : toArray(normalized.observations).length
        ? toArray(normalized.observations)
        : toArray(normalized.issues);
  normalized.observations = toArray(normalized.observations);
  normalized.issues = toArray(normalized.issues);
  normalized.keyFindings = toArray(normalized.keyFindings);

  return normalized;
}

function toArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "object") return [value as Record<string, unknown>];
  return [String(value)];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function buildAcceptedRevisionContext(chapters: ChapterRow[], paragraphs: ParagraphRow[]) {
  const paragraphsByChapter = paragraphs.reduce<Record<string, ParagraphRow[]>>((groups, paragraph) => {
    groups[paragraph.chapter_id] ||= [];
    groups[paragraph.chapter_id].push(paragraph);
    return groups;
  }, {});

  const totalBudget = 14000;
  const perChapterLimit = Math.max(300, Math.min(1200, Math.floor(totalBudget / Math.max(1, chapters.length))));

  return chapters.map((chapter) => {
    const chapterParagraphs = (paragraphsByChapter[chapter.id] || []).sort((a, b) => a.paragraph_number - b.paragraph_number);
    const acceptedParagraphs = chapterParagraphs.filter((paragraph) => paragraph.accepted_text);
    const acceptedSnippet = acceptedParagraphs.map((paragraph) => paragraph.accepted_text || paragraph.original_text).join("\n\n");
    const narrativeSnippet = chapterParagraphs
      .map((paragraph) => paragraph.accepted_text || paragraph.original_text)
      .join("\n\n");
    const prioritized = `${acceptedSnippet}\n\n${narrativeSnippet}`.trim();
    const sample = prioritized.slice(0, perChapterLimit);

    return {
      title: chapter.title || "Untitled chapter",
      acceptedTextSample: sample,
      acceptedParagraphs: acceptedParagraphs.length,
      totalParagraphs: chapterParagraphs.length,
    };
  });
}

function computeDialogueMetrics(chapters: ChapterRow[], paragraphs: ParagraphRow[]) {
  const paragraphsByChapter = paragraphs.reduce<Record<string, ParagraphRow[]>>((groups, paragraph) => {
    groups[paragraph.chapter_id] ||= [];
    groups[paragraph.chapter_id].push(paragraph);
    return groups;
  }, {});

  let totalDialogueWords = 0;
  let totalWords = 0;

  const perChapter = chapters.map((chapter) => {
    const chapterParagraphs = paragraphsByChapter[chapter.id] || [];
    const text = chapterParagraphs.map((paragraph) => paragraph.accepted_text || paragraph.original_text).join("\n\n");
    const { dialogueWords, totalWords: chapterWordCount, ratio } = computeDialogueRatio(text);
    totalDialogueWords += dialogueWords;
    totalWords += chapterWordCount;
    return { title: chapter.title || "Untitled chapter", ratio, wordCount: chapterWordCount };
  });

  return {
    perChapter,
    overallRatio: totalWords > 0 ? totalDialogueWords / totalWords : 0,
  };
}
