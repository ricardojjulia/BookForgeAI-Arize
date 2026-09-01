import type { SupabaseClient } from "@supabase/supabase-js";

export type AiJobProgress = {
  taskName: string;
  currentUnit: string;
  totalUnits: number;
  attempted: number;
  successful: number;
  failed: number;
  skipped: number;
  startedAt?: string | null;
  completedAt?: string | null;
  estimatedSecondsPerUnit?: number | null;
  lastHeartbeatAt?: string | null;
  message?: string | null;
  failedUnits?: AiJobFailedUnit[];
};

export type AiJobFailedUnit = {
  id: string;
  label: string;
  type: "paragraph" | "chapter" | "critic_lens" | "analysis_chunk";
  error: string;
};

export function buildJobProgress(input: Partial<AiJobProgress>): AiJobProgress {
  return {
    taskName: input.taskName || "AI task",
    currentUnit: input.currentUnit || "Queued",
    totalUnits: Math.max(0, input.totalUnits || 0),
    attempted: Math.max(0, input.attempted || 0),
    successful: Math.max(0, input.successful || 0),
    failed: Math.max(0, input.failed || 0),
    skipped: Math.max(0, input.skipped || 0),
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    estimatedSecondsPerUnit: input.estimatedSecondsPerUnit || null,
    lastHeartbeatAt: input.lastHeartbeatAt || null,
    message: input.message || null,
    failedUnits: Array.isArray(input.failedUnits) ? input.failedUnits : [],
  };
}

export function isStaleRunningJob(status: string | null, progress: AiJobProgress | null, staleAfterSeconds = 120) {
  if (status !== "running" || !progress?.lastHeartbeatAt) return false;
  return Date.now() - new Date(progress.lastHeartbeatAt).getTime() > staleAfterSeconds * 1000;
}

export type RevisionJobHeartbeat = {
  touch: (progress?: Partial<AiJobProgress>) => Promise<void>;
  stop: () => void;
};

export function createRevisionJobHeartbeat(
  supabase: SupabaseClient,
  jobId: string,
  settings: unknown,
  progress: Partial<AiJobProgress>,
  intervalMs = 30000,
): RevisionJobHeartbeat {
  let latestSettings = settings;
  // Must merge with the job's existing progress (taskName, startedAt, etc.)
  // here, not just build from the small per-tick patch passed in -- this
  // function is recreated fresh for every unit in a batch (see
  // generate-draft/route.ts's per-chapter loop), and the first background
  // tick 30s later used to silently reset taskName back to "AI task" and
  // startedAt to null, because the OLD code below merged
  // extractJobProgress(latestSettings) UNDER this value, letting it clobber
  // the real fields instead of only contributing the new patch fields.
  // Found live: the job's displayed task name and elapsed time flickered
  // between correct and reset every ~30s during a long chapter generation.
  let latestProgress = buildJobProgress({ ...extractJobProgress(settings), ...progress });
  let stopped = false;

  const touch = async (progressPatch: Partial<AiJobProgress> = {}) => {
    if (stopped) return;
    latestProgress = buildJobProgress({
      ...extractJobProgress(latestSettings),
      ...latestProgress,
      ...progressPatch,
      lastHeartbeatAt: new Date().toISOString(),
    });
    latestSettings = mergeJobSettings(latestSettings, latestProgress);
    const { error } = await supabase.from("revision_jobs").update({ settings: latestSettings }).eq("id", jobId);
    if (error) throw error;
  };

  const interval = setInterval(() => {
    void touch();
  }, intervalMs);
  if (typeof interval.unref === "function") interval.unref();

  return {
    touch,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export type RevisionJobVisibilitySummary = {
  total: number;
  active: number;
  running: number;
  queued: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
  staleRunning: number;
};

export function summarizeRevisionJobs(
  jobs: Array<{ status: string | null; settings: unknown }>,
): RevisionJobVisibilitySummary {
  const summary: RevisionJobVisibilitySummary = {
    total: 0,
    active: 0,
    running: 0,
    queued: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    staleRunning: 0,
  };

  for (const job of jobs) {
    summary.total += 1;
    const progress = extractJobProgress(job.settings);
    if (job.status === "running") {
      summary.running += 1;
      summary.active += 1;
      if (isStaleRunningJob(job.status, progress)) summary.staleRunning += 1;
    } else if (job.status === "queued") {
      summary.queued += 1;
      summary.active += 1;
    } else if (job.status === "paused") {
      summary.paused += 1;
      summary.active += 1;
    } else if (job.status === "completed") {
      summary.completed += 1;
    } else if (job.status === "failed") {
      summary.failed += 1;
    } else if (job.status === "cancelled") {
      summary.cancelled += 1;
    }
  }

  return summary;
}

type StaleHealJobRow = { id: string; mode: string; status: string | null; settings: unknown; created_at: string };

// Two distinct ways a job can go silently dead, both invisible to a user
// until they happen to look:
// (1) A dead server-side request leaves a job stuck at status="running"
//     forever -- its heartbeat just stops.
// (2) The "serverManaged: true" dispatch-then-poll pattern (queue the job,
//     then fire a second request that does the real work) never gets its
//     second request delivered -- e.g. a dropped connection between the
//     two calls -- leaving the job at status="queued" with no heartbeat to
//     even judge staleness by, since it never started. This is a genuinely
//     different failure mode from (1): isStaleRunningJob only ever looks at
//     status="running" jobs, so a job stuck in "queued" was invisible to
//     the original sweep even though it's just as dead. Found live: a
//     drift-check dispatch silently dropped and sat "queued" for 11+
//     minutes with zero heartbeat.
// This sweep runs opportunistically whenever the jobs list is fetched (no
// cron infrastructure required) and auto-fails anything stale well past
// the UI's own "possibly interrupted" display threshold, logging the
// incident for trust/reliability stats.
export async function detectAndHealStaleJobs(
  supabase: SupabaseClient,
  userId: string,
  jobs: StaleHealJobRow[],
  staleAfterSeconds = 600,
) {
  const healedJobIds: string[] = [];
  for (const job of jobs) {
    const progress = extractJobProgress(job.settings);
    const staleRunning = isStaleRunningJob(job.status, progress, staleAfterSeconds);
    const queuedAgeMs = job.status === "queued" ? Date.now() - new Date(job.created_at).getTime() : 0;
    const staleQueued = job.status === "queued" && queuedAgeMs > staleAfterSeconds * 1000;
    if (!staleRunning && !staleQueued) continue;

    const staleSinceMs = staleQueued
      ? queuedAgeMs
      : progress?.lastHeartbeatAt
        ? Date.now() - new Date(progress.lastHeartbeatAt).getTime()
        : null;
    const staleMinutes = staleSinceMs ? Math.round(staleSinceMs / 60000) : null;

    const { data: updated, error: updateError } = await supabase
      .from("revision_jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: staleQueued
          ? `Auto-detected as stalled: queued for over ${staleMinutes ?? "several"} minute(s) without ever starting. The dispatch request that was supposed to begin the real work likely never reached the server (e.g. a dropped connection).`
          : `Auto-detected as stalled: no heartbeat for over ${staleMinutes ?? "several"} minute(s). The server-side process likely died mid-run without reaching its own failure handler.`,
      })
      .eq("id", job.id)
      .eq("status", staleQueued ? "queued" : "running")
      .select("id");
    if (updateError || !updated?.length) continue;

    await supabase.from("model_call_events").insert({
      user_id: userId,
      job_id: job.id,
      model: "n/a",
      task: job.mode,
      context_length: 0,
      outcome: "error",
      error_signature: staleQueued ? "job_queued_never_started" : "job_stale_auto_detected",
      duration_ms: staleSinceMs,
      event_type: "job_stale_detected",
    });
    healedJobIds.push(job.id);
  }
  return healedJobIds;
}

type StaleHealAutoReviewJobRow = {
  id: string;
  book_id: string;
  mode: string;
  status: string | null;
  current_stage: string | null;
  log: Array<Record<string, unknown>> | null;
  created_at: string;
};

// auto_review_jobs has no revision_jobs-style heartbeat/progress column, so
// it needs its own stale-detection logic rather than reusing
// detectAndHealStaleJobs above. Found live: a full_review job for a real
// book sat at status="running" for 17+ hours with zero stages_completed and
// a completely empty log -- the worker launch request that was supposed to
// start real work never reached the server, and nothing ever corrected the
// status. Runs wherever a user's auto_review_jobs list is fetched (the
// Analytics page, the wizard's own status poll) the same way the
// revision_jobs sweep runs wherever /jobs is polled.
//
// Critical: current_stage/log only advance when a STAGE finishes, not while
// one is in progress -- a legitimate multi-hour rewrite_execute pass looks
// identical, from the log alone, to a genuinely dead job. Found live within
// minutes of shipping the first version of this function: it marked an
// actively-progressing rewrite (fresh revision_jobs heartbeat, climbing
// attempted count) as stalled after 10 minutes simply because the stage
// hadn't finished yet. Must check the underlying revision_jobs heartbeat
// before ever declaring a "running" auto-review job dead.
export async function detectAndHealStaleAutoReviewJobs(
  supabase: SupabaseClient,
  userId: string,
  jobs: StaleHealAutoReviewJobRow[],
  staleAfterSeconds = 600,
) {
  const healedJobIds: string[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const log = job.log || [];
    const lastEntry = log.length ? (log[log.length - 1] as { ts?: string }) : null;
    const referenceTime = lastEntry?.ts ? new Date(lastEntry.ts).getTime() : new Date(job.created_at).getTime();
    const staleMs = Date.now() - referenceTime;
    if (staleMs <= staleAfterSeconds * 1000) continue;

    const { data: activeUnderlyingJobs } = await supabase
      .from("revision_jobs")
      .select("settings")
      .eq("book_id", job.book_id)
      .eq("status", "running");
    const stillAlive = (activeUnderlyingJobs || []).some((row) => {
      const heartbeatAt = (row.settings as { progress?: { lastHeartbeatAt?: string } } | null)?.progress?.lastHeartbeatAt;
      if (!heartbeatAt) return false;
      return Date.now() - new Date(heartbeatAt).getTime() < staleAfterSeconds * 1000;
    });
    if (stillAlive) continue;

    const staleMinutes = Math.round(staleMs / 60000);
    const neverStarted = log.length === 0;

    const { data: updated, error: updateError } = await supabase
      .from("auto_review_jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error: neverStarted
          ? `Auto-detected as stalled: created ${staleMinutes} minute(s) ago but never actually started (no stages completed, no log activity). The worker launch request likely never reached the server.`
          : `Auto-detected as stalled: no activity for over ${staleMinutes} minute(s) since the last completed stage ("${job.current_stage}"). Resume from Auto-Review Wizard to continue from the next stage.`,
      })
      .eq("id", job.id)
      .eq("status", "running")
      .select("id");
    if (updateError || !updated?.length) continue;

    await supabase.from("model_call_events").insert({
      user_id: userId,
      job_id: job.id,
      model: "n/a",
      task: job.mode,
      context_length: 0,
      outcome: "error",
      error_signature: neverStarted ? "auto_review_never_started" : "auto_review_stale_auto_detected",
      duration_ms: staleMs,
      event_type: "job_stale_detected",
    });
    healedJobIds.push(job.id);
  }
  return healedJobIds;
}

type CompletionSummaryJobRow = {
  id: string;
  mode: string;
  status: string | null;
  settings: unknown;
  started_at: string | null;
  completed_at: string | null;
};

// Logs estimated-vs-actual duration once per terminal job, so estimation
// accuracy (the "estimatedSecondsPerUnit"/"estimatedTotalSeconds" shown in
// the AI Task Preflight modal) can eventually be measured and improved from
// real outcomes instead of the static formula it's computed from today.
export async function logJobCompletionSummaries(supabase: SupabaseClient, userId: string, jobs: CompletionSummaryJobRow[]) {
  const terminalJobs = jobs.filter((job) => job.status === "completed" || job.status === "failed");
  if (!terminalJobs.length) return;

  const { data: existing } = await supabase
    .from("model_call_events")
    .select("job_id")
    .eq("event_type", "job_completed_summary")
    .in(
      "job_id",
      terminalJobs.map((job) => job.id),
    );
  const alreadyLogged = new Set((existing || []).map((row) => row.job_id));

  const rowsToInsert = [];
  for (const job of terminalJobs) {
    if (alreadyLogged.has(job.id) || !job.started_at || !job.completed_at) continue;
    const progress = extractJobProgress(job.settings);
    const actualDurationMs = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
    const estimatedDurationMs =
      progress?.estimatedSecondsPerUnit && progress.totalUnits
        ? progress.estimatedSecondsPerUnit * progress.totalUnits * 1000
        : null;
    rowsToInsert.push({
      user_id: userId,
      job_id: job.id,
      model: "n/a",
      task: job.mode,
      context_length: 0,
      outcome: job.status === "completed" ? "success" : "error",
      duration_ms: actualDurationMs,
      estimated_duration_ms: estimatedDurationMs,
      event_type: "job_completed_summary",
    });
  }
  if (rowsToInsert.length) {
    await supabase.from("model_call_events").insert(rowsToInsert);
  }
}

// A real rewrite pass is usually many small revision_jobs rows (the UI caps
// "Execute Rewrite" at ~25 paragraphs per click), so the single
// most-recently-*created* job of a given mode can easily be a trailing
// batch that found zero remaining eligible paragraphs -- a legitimate,
// expected outcome once coverage is complete, not an error. Anything that
// wants "the job that did the most recent real work" (e.g. drift-check
// sampling) should look at what actually produced output, not job-row
// recency, or it silently has nothing to work with even though real work
// just happened moments earlier.
export async function getLatestJobIdWithRevisions(supabase: SupabaseClient, bookId: string) {
  const { data, error } = await supabase
    .from("revision_versions")
    .select("revision_job_id")
    .eq("book_id", bookId)
    .not("revision_job_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.revision_job_id as string | undefined) || null;
}

export function mergeJobSettings(settings: unknown, progress: AiJobProgress) {
  const base = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  return {
    ...base,
    progress,
  };
}

export function extractJobProgress(settings: unknown): AiJobProgress | null {
  if (!settings || typeof settings !== "object" || !("progress" in settings)) return null;
  const progress = (settings as { progress?: unknown }).progress;
  if (!progress || typeof progress !== "object") return null;
  const row = progress as Partial<AiJobProgress>;
  return buildJobProgress(row);
}

type JobProgressDisplayInput = Pick<AiJobProgress, "totalUnits" | "attempted" | "successful" | "failed">;

export function getJobProgressDisplay(progress: JobProgressDisplayInput | null, status?: string | null) {
  if (!progress) {
    return {
      completed: 0,
      total: 1,
      percent: 0,
    };
  }

  const processed = Math.max(progress.attempted, progress.successful + progress.failed);
  const total = Math.max(progress.totalUnits || processed || 0, 1);
  const completed = status === "completed" ? total : Math.min(total, processed);

  return {
    completed,
    total,
    percent: Math.min(100, Math.round((completed / total) * 100)),
  };
}

export async function updateRevisionJobProgress(
  supabase: SupabaseClient,
  jobId: string,
  settings: unknown,
  progress: Partial<AiJobProgress>,
) {
  // A caller can pass a stale/empty settings object (e.g. a variable that
  // never got reassigned after a prior update, or a fresh continuation that
  // hasn't loaded the job yet) -- merging progress on top of that silently
  // regresses or blanks out real fields (label text, failedUnits, etc.)
  // instead of layering onto the job's actual current state. If the passed
  // settings carry no usable progress, re-fetch the real current row first.
  let baseSettings = settings;
  if (!extractJobProgress(baseSettings)) {
    const { data } = await supabase.from("revision_jobs").select("settings").eq("id", jobId).maybeSingle();
    baseSettings = data?.settings || baseSettings;
  }

  const nextProgress = buildJobProgress({
    ...extractJobProgress(baseSettings),
    ...progress,
    lastHeartbeatAt: new Date().toISOString(),
  });
  const nextSettings = mergeJobSettings(baseSettings, nextProgress);
  const { error } = await supabase.from("revision_jobs").update({ settings: nextSettings }).eq("id", jobId);
  if (error) throw error;
  return nextSettings;
}

export async function getRevisionJobStatus(supabase: SupabaseClient, jobId: string) {
  const { data, error } = await supabase.from("revision_jobs").select("status").eq("id", jobId).single();
  if (error) throw error;
  return String(data.status || "");
}

export async function waitWhileRevisionJobPaused(supabase: SupabaseClient, jobId: string) {
  let status = await getRevisionJobStatus(supabase, jobId);
  while (status === "paused") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    status = await getRevisionJobStatus(supabase, jobId);
  }
  return status;
}
