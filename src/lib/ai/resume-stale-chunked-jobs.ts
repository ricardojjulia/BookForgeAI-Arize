import { after } from "next/server";
import type { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// Found live: a real chunk's normal cadence is 20-40s between heartbeats, so
// 90s should have been generous margin -- but a real Studio page load landed
// at exactly 85s stale and skipped the resume by 5 seconds, costing a full
// extra page-load cycle before the next chance to catch it. Lowered to give
// real margin against this class of near-miss.
export const STALE_AFTER_MS = 45_000;

export type ChunkedJobRow = {
  id: string;
  book_id: string;
  mode: string;
  status: string;
  settings: Record<string, unknown> | null;
  created_by?: string | null;
};

export function chunkedJobPath(mode: string, bookId: string): string {
  return mode === "full_book_rewrite" ? `/api/books/${bookId}/rewrite-execute` : `/api/books/${bookId}/generate-draft`;
}

export function lastHeartbeatMs(settings: Record<string, unknown> | null): number | null {
  const progress = settings?.progress as { lastHeartbeatAt?: string } | undefined;
  if (!progress?.lastHeartbeatAt) return null;
  const parsed = Date.parse(progress.lastHeartbeatAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isStaleChunkedJob(job: Pick<ChunkedJobRow, "settings">, now = Date.now()): boolean {
  const heartbeatMs = lastHeartbeatMs(job.settings);
  return heartbeatMs !== null && now - heartbeatMs >= STALE_AFTER_MS;
}

// Double the 4 real stalls this session's stress-testing actually produced,
// plus buffer -- a resume just continues an already-started job rather than
// restarting it, so raising this doesn't multiply cost, but a job that
// still can't get past one more chunk after 10 real attempts has a
// structural problem worth a human looking at, not another automatic retry.
export const MAX_RESUME_ATTEMPTS = 10;

/**
 * Gate every resume through this before dispatching -- both backstops call
 * it so a chronically-stalling job (the same failure on every attempt, not
 * the ordinary "self-chain silently didn't fire this once" case) eventually
 * gets marked genuinely failed with a clear reason instead of being retried
 * forever. Never touches a job that isn't already status="running" -- see
 * that filter in both callers -- so this can only ever cap RETRIES of a
 * stuck-but-still-running job, never override or retry something that
 * already concluded "failed" for a real reason.
 */
export async function checkAndRecordResumeAttempt(
  supabase: SupabaseClient,
  job: ChunkedJobRow,
): Promise<"resume" | "ceiling_reached"> {
  const settings = job.settings || {};
  const attempts = typeof settings.resumeAttempts === "number" ? settings.resumeAttempts : 0;

  if (attempts >= MAX_RESUME_ATTEMPTS) {
    await supabase
      .from("revision_jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: `Auto-resume gave up after ${MAX_RESUME_ATTEMPTS} attempts -- the server-side process kept dying before completing another chunk. This needs investigation rather than another automatic retry.`,
      })
      .eq("id", job.id)
      .eq("status", "running");
    return "ceiling_reached";
  }

  await supabase
    .from("revision_jobs")
    .update({ settings: { ...settings, resumeAttempts: attempts + 1 } })
    .eq("id", job.id);
  return "resume";
}

/**
 * Reconstructs the original run-call body for a chunked job from its own
 * persisted settings -- both routes already store everything a resume needs
 * (rewrite-execute: strategyId/strategySettings/maxUnits/etc; generate-draft
 * just needs its jobId). Shared by both callers of this module (the
 * per-book Studio-page backstop and the platform-wide cron) so the two
 * never drift on what a "resume" actually sends.
 */
export function buildResumeBody(job: Pick<ChunkedJobRow, "id" | "mode" | "settings">): Record<string, unknown> {
  const settings = job.settings || {};
  if (job.mode === "full_book_rewrite") {
    return {
      jobId: job.id,
      // Uncapped jobs (e.g. "Rewrite this chapter") store maxUnits as null
      // (see `body.maxUnits || null` at the route's job-settings writes) --
      // every other nullable field here already normalizes null to
      // undefined so the resumed request matches what a fresh, uncapped
      // request looks like. maxUnits was missing that, so every automated
      // resume of an uncapped job sent a literal `maxUnits: null`, which
      // the route's Zod schema (number().optional(), not nullable) rejects
      // outright -- silently failing on every single cron/backstop resume
      // attempt for exactly the jobs most likely to need one (multi-chunk,
      // no explicit cap). Found live: a job stuck at 25/47 units, cron
      // resuming it every 2 minutes for 13+ minutes, every attempt dying on
      // this same ZodError before ever reaching the actual rewrite logic.
      maxUnits: settings.maxUnits ?? undefined,
      campaignId: settings.campaignId ?? undefined,
      // Chapter-scoped rewrites (e.g. Guidance's "Run rewrite" on a
      // chapter-specific suggestion) must stay scoped on resume too --
      // omitting this silently widened a stalled chapter-only job back out
      // to the whole book the moment a backstop resumed it.
      chapterId: settings.chapterId ?? undefined,
      rewriteExistingDrafts: settings.rewriteExistingDrafts,
      rewriteAccepted: settings.rewriteAccepted,
      distributeAcrossChapters: settings.distributeAcrossChapters,
      coverageMode: settings.coverageMode,
      strategyId: settings.strategyId,
      strategySettings: settings.strategySettings,
      authorInstructions: settings.authorInstructions ?? undefined,
    };
  }
  return { jobId: job.id };
}

/**
 * rewrite-execute and generate-draft each process one bounded chunk per
 * request and rely on a self-chained continuation (see after() in both
 * routes) to keep going -- proven live to work most of the time but not
 * reliably: a real production run self-chained cleanly 8 times in a row,
 * then a continuation silently never fired (no error, no timeout log,
 * nothing queryable anywhere) and the job just sat "running" with a frozen
 * heartbeat until the unrelated 10-minute stale sweep force-failed it.
 *
 * This is the per-book backstop: opportunistically re-dispatch any chunked
 * job whose heartbeat has gone stale using the CURRENT authenticated page
 * request's own cookie. Runs wherever a user loads a page for this book.
 * See src/app/api/internal/resume-stale-chunked-jobs/route.ts for the
 * platform-wide cron backstop that catches this even when nobody's looking
 * at the app at all.
 */
export async function resumeStaleChunkedJobs(
  supabase: SupabaseClient,
  bookId: string,
  cookie: string,
  baseUrl: URL,
): Promise<string[]> {
  const { data: jobs } = await supabase
    .from("revision_jobs")
    .select("id,book_id,mode,status,settings")
    .eq("book_id", bookId)
    .eq("status", "running")
    .in("mode", ["full_book_rewrite", "creation_draft_generation"]);

  const resumed: string[] = [];
  for (const job of (jobs || []) as ChunkedJobRow[]) {
    if (!isStaleChunkedJob(job)) continue;
    if ((await checkAndRecordResumeAttempt(supabase, job)) === "ceiling_reached") continue;

    const target = new URL(chunkedJobPath(job.mode, bookId), baseUrl).toString();
    const requestBody = JSON.stringify(buildResumeBody(job));
    // after() rather than a bare void fetch() -- proven live this session
    // that the bare pattern is NOT safe (Vercel can freeze a function's
    // execution right after its response is sent). after() isn't provably
    // 100% reliable either, which is exactly why this exists as an
    // independent, repeated backstop (and why the cron backstop exists on
    // top of THIS one) rather than a single point of trust.
    after(() =>
      fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: requestBody,
      }).catch(() => {}),
    );
    resumed.push(job.id);
  }
  return resumed;
}
