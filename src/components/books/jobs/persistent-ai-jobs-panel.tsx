"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Modal, Paper, Progress, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { getJobProgressDisplay } from "@/lib/ai/job-state";
import { fetchJson } from "@/lib/http/fetch-json";
import { useAdaptivePolling } from "@/lib/hooks/use-adaptive-polling";
import { isInsufficientCreditsMessage } from "@/lib/subscription/enforcement";
import { InsufficientCreditsAlert } from "@/components/ai/insufficient-credits-alert";

const ACTIVE_POLL_MS = 4000;
const IDLE_POLL_MS = 30000;
// Distinct from the data-poll interval above: that only re-fetches this
// panel's own job list client-side, it never re-runs the Studio page's
// server component -- which is where resumeStaleChunkedJobs (the stuck-job
// backstop) actually lives. Without this, a user who leaves the tab open
// and idle without ever navigating would never trigger a resume attempt at
// all -- only reloads/navigations re-run server components.
const SERVER_REFRESH_MS = 60000;

type PersistedAiJob = {
  id: string;
  mode: string;
  status: string | null;
  settings?: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  isStale?: boolean;
  progress: {
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
    failedUnits?: Array<{ id: string; label: string; type: string; error: string }>;
  } | null;
};

type JobsResponse = {
  content?: {
    jobs: PersistedAiJob[];
    transient?: boolean;
  };
};

export function PersistentAiJobsPanel({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<PersistedAiJob[]>([]);
  const [error, setError] = useState("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const previousStatuses = useRef(new Map<string, string | null>());
  const refreshedCompletedJobs = useRef(new Set<string>());
  const activeJob = useMemo(
    () => jobs.find((job) => ["running", "paused", "queued"].includes(job.status || "")) || null,
    [jobs],
  );
  const latestFinishedJob = useMemo(
    () => jobs.find((job) => !["running", "paused", "queued"].includes(job.status || "")) || null,
    [jobs],
  );

  useEffect(() => {
    if (!activeJob) return;
    const interval = window.setInterval(() => router.refresh(), SERVER_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [activeJob, router]);

  const loadJobs = useCallback(async () => {
    try {
      const result = await fetchJson<JobsResponse>(`/api/books/${bookId}/jobs`, { cache: "no-store" }, "Load AI jobs");
      if (result.content?.transient) {
        // A transient backend hiccup (see isTransientJsonParseError server-side)
        // reports an empty job list with 200 OK rather than throwing -- treating
        // that as ground truth would flash "No persistent AI jobs" over a
        // genuinely running job and hide its Cancel button. Keep showing the
        // last known jobs and let the next poll retry.
        return jobs.some((job) => ["running", "paused", "queued"].includes(job.status || ""));
      }
      const nextJobs = result.content?.jobs || [];
      const hasActiveJobs = nextJobs.some((job) => ["running", "paused", "queued"].includes(job.status || ""));
      const shouldRefresh = nextJobs.some((job) => {
        const previous = previousStatuses.current.get(job.id);
        const newlyCompleted = previous && previous !== "completed" && job.status === "completed";
        return newlyCompleted && !refreshedCompletedJobs.current.has(job.id);
      });

      nextJobs.forEach((job) => previousStatuses.current.set(job.id, job.status));
      setJobs(nextJobs);
      if (shouldRefresh) {
        nextJobs
          .filter((job) => job.status === "completed")
          .forEach((job) => refreshedCompletedJobs.current.add(job.id));
        router.refresh();
      }
      setError("");
      return hasActiveJobs;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load persistent AI jobs.");
      // Back off when polling fails to avoid hammering the jobs endpoint.
      return false;
    }
  }, [bookId, router, jobs]);

  async function controlJob(jobId: string, action: "pause" | "resume" | "cancel" | "mark_failed") {
    setLoadingAction(`${action}:${jobId}`);
    try {
      await fetchJson(
        `/api/jobs/${jobId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
        `${action} job`,
      );
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update job.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function retryFailed(job: PersistedAiJob) {
    const failedUnits = job.progress?.failedUnits || [];
    if (!failedUnits.length) return;
    const endpoint = retryEndpoint(bookId, job);
    if (!endpoint) {
      setError("Retry failed units is not available for this job type yet.");
      return;
    }
    setLoadingAction(`retry:${job.id}`);
    try {
      if (supportsServerManagedHandoff(endpoint.path)) {
        const queued = await fetchJson<{ content?: { jobId?: string; revisionJobId?: string } }>(
          endpoint.path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...endpoint.body, serverManaged: true }),
          },
          "Queue retry failed units",
        );
        const handoffJobId = queued.content?.jobId || queued.content?.revisionJobId;
        if (handoffJobId) {
          void fetchJson(
            endpoint.path,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...endpoint.body, jobId: handoffJobId }),
            },
            "Retry failed units worker",
          ).then(() => loadJobs()).catch(() => {
            // best effort; poller will surface failure state
          });
        }
      } else {
        await fetchJson(
          endpoint.path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(endpoint.body),
          },
          "Retry failed units",
        );
      }
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to retry failed units.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function resumeInterrupted(job: PersistedAiJob) {
    const endpoint = replacementEndpoint(bookId, job);
    if (!endpoint) {
      setError("Resume is not available for this job type yet.");
      return;
    }
    setLoadingAction(`resume-interrupted:${job.id}`);
    try {
      if (supportsServerManagedHandoff(endpoint.path)) {
        const queued = await fetchJson<{ content?: { jobId?: string; revisionJobId?: string } }>(
          endpoint.path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...endpoint.body, serverManaged: true }),
          },
          "Queue interrupted replacement",
        );
        const handoffJobId = queued.content?.jobId || queued.content?.revisionJobId;
        if (handoffJobId) {
          void fetchJson(
            endpoint.path,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...endpoint.body, jobId: handoffJobId }),
            },
            "Resume interrupted worker",
          ).then(() => loadJobs()).catch(() => {
            // best effort; poller will surface failure state
          });
        }
      } else {
        await fetchJson(
          endpoint.path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(endpoint.body),
          },
          "Resume interrupted job",
        );
      }
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resume interrupted job.");
    } finally {
      setLoadingAction(null);
    }
  }

  useAdaptivePolling(loadJobs, {
    activeIntervalMs: ACTIVE_POLL_MS,
    idleIntervalMs: IDLE_POLL_MS,
    pauseWhenHidden: true,
    coordinatorKey: `book-jobs:${bookId}`,
  });

  return (
    <Paper id="persistent-ai-jobs" withBorder radius="md" p="xl" bg="#fbfaf8" style={{ scrollMarginTop: 24 }}>
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Persistent AI Jobs</Title>
            <Text c="dimmed" size="sm">
              Durable progress for long AI jobs. Refreshing the page will keep the latest saved counts.
            </Text>
            <Button component="a" href={`/books/${bookId}/jobs`} size="xs" variant="subtle" color="grape" mt="xs">
              Open Jobs History
            </Button>
          </div>
          <Badge color={activeJob ? statusColor(activeJob.status) : "gray"} variant="light">
            {activeJob?.status || "idle"}
          </Badge>
        </Group>

        {error && <Alert color="red">{error}</Alert>}

        {activeJob ? (
          <JobCard
            job={activeJob}
            loadingAction={loadingAction}
            onPause={() => controlJob(activeJob.id, "pause")}
            onResume={() => controlJob(activeJob.id, "resume")}
            onCancel={() => controlJob(activeJob.id, "cancel")}
            onMarkFailed={() => controlJob(activeJob.id, "mark_failed")}
            onRetryFailed={() => retryFailed(activeJob)}
            onResumeInterrupted={() => resumeInterrupted(activeJob)}
          />
        ) : latestFinishedJob ? (
          <Alert color="gray" variant="light" title="No active persistent AI jobs">
            Last job: {latestFinishedJob.progress?.taskName || humanizeMode(latestFinishedJob.mode)} ({latestFinishedJob.status || "unknown"}).
          </Alert>
        ) : (
          <Alert color="gray" variant="light">
            No persistent AI jobs have been created for this book yet.
          </Alert>
        )}

        {jobs.length > 1 && activeJob && (
          <Stack gap="xs">
            <Text fw={800} size="sm">
              Recent jobs
            </Text>
            {jobs.slice(1, 6).map((job) => (
              <Group key={job.id} justify="space-between">
                <Text size="sm">
                  {humanizeMode(job.mode)} · {new Date(job.created_at).toLocaleString()}
                </Text>
                <Badge color={statusColor(job.status)} variant="light">
                  {job.status || "unknown"}
                </Badge>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

function JobCard({
  job,
  loadingAction,
  onPause,
  onResume,
  onCancel,
  onMarkFailed,
  onRetryFailed,
  onResumeInterrupted,
}: {
  job: PersistedAiJob;
  loadingAction: string | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onMarkFailed: () => void;
  onRetryFailed: () => void;
  onResumeInterrupted: () => void;
}) {
  const progress = job.progress;
  const { completed, total, percent } = getJobProgressDisplay(progress, job.status);
  const eta = getEta(job);
  const stale = Boolean(job.isStale);
  const failedUnits = progress?.failedUnits || [];
  // Cancelling used to fire the instant the button was tapped, no
  // confirmation at all -- a real risk on mobile, where a layout shift
  // right after a page reload/unlock can land a stray tap on a button that
  // was in a different spot a moment ago. Found live 2026-08-28: a user
  // reported a healthy, still-running job "cancelled" itself after they
  // refreshed on their phone -- the job's own record showed it actually
  // completed fine, but an unguarded one-tap Cancel sitting right next to
  // an alarming "possibly interrupted" banner (see below) is exactly the
  // kind of thing that produces that impression, confirmed or not.
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  return (
    <Paper withBorder radius="md" p="lg" bg="white">
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={900}>{progress?.taskName || humanizeMode(job.mode)}</Text>
            <Text c="dimmed" size="sm">
              {progress?.currentUnit || "Waiting for progress update"}
            </Text>
          </div>
          <Badge color={stale ? "orange" : statusColor(job.status)}>
            {stale ? "possibly interrupted" : job.status || "unknown"}
          </Badge>
        </Group>

        <Progress value={percent} color="grape" radius="xl" size="lg" />

        <SimpleGrid cols={{ base: 2, md: 5 }}>
          <Metric label="Progress" value={`${completed}/${total}`} />
          <Metric label="Successful" value={progress?.successful || 0} />
          <Metric label="Skipped" value={progress?.skipped || 0} />
          <Metric label="Failed" value={progress?.failed || 0} />
          <Metric label="ETA" value={eta} />
        </SimpleGrid>

        {progress?.message && <Alert color="blue" variant="light">{progress.message}</Alert>}
        {stale && (
          <Alert color="orange" variant="light">
            No progress update in a couple of minutes -- a single unit can legitimately take that long. The system
            automatically retries a job that&apos;s genuinely stuck, so this usually clears on its own within a few
            minutes with no action needed. If it&apos;s still showing this after 10+ minutes, it&apos;s safe to mark it
            failed or cancel it.
          </Alert>
        )}
        {failedUnits.length > 0 && (
          <Alert color="red" variant="light">
            <Text fw={800} size="sm">
              Failed units
            </Text>
            {failedUnits.slice(0, 3).map((unit) => (
              <Text key={`${unit.type}:${unit.id}`} size="sm">
                {unit.label}: {unit.error}
              </Text>
            ))}
          </Alert>
        )}
        {job.error_message && isInsufficientCreditsMessage(job.error_message) ? (
          <InsufficientCreditsAlert message={job.error_message} />
        ) : (
          job.error_message && <Alert color="red">{job.error_message}</Alert>
        )}

        <Group>
          <Button
            variant="light"
            color="yellow"
            disabled={job.status !== "running"}
            loading={loadingAction === `pause:${job.id}`}
            onClick={onPause}
          >
            Pause
          </Button>
          <Button
            variant="light"
            color="green"
            disabled={job.status !== "paused"}
            loading={loadingAction === `resume:${job.id}`}
            onClick={onResume}
          >
            Resume
          </Button>
          <Button
            variant="outline"
            color="red"
            disabled={!["running", "paused", "queued"].includes(job.status || "")}
            loading={loadingAction === `cancel:${job.id}`}
            onClick={() => setConfirmCancelOpen(true)}
          >
            Cancel
          </Button>
          <Modal opened={confirmCancelOpen} onClose={() => setConfirmCancelOpen(false)} title="Cancel this job?" centered>
            <Stack>
              <Text size="sm">
                {stale
                  ? "This hasn't reported progress in a couple of minutes, but it may still be working -- cancelling now stops it for good, including any progress on the unit it's currently working on."
                  : "This job is actively running. Cancelling stops it for good, including any progress on the unit it's currently working on -- you'd need to start a new run to pick up where it left off."}
              </Text>
              <Group justify="flex-end">
                <Button variant="subtle" color="dark" onClick={() => setConfirmCancelOpen(false)}>
                  Keep it running
                </Button>
                <Button
                  color="red"
                  loading={loadingAction === `cancel:${job.id}`}
                  onClick={() => {
                    setConfirmCancelOpen(false);
                    onCancel();
                  }}
                >
                  Cancel job
                </Button>
              </Group>
            </Stack>
          </Modal>
          <Button
            variant="outline"
            color="orange"
            disabled={!stale}
            loading={loadingAction === `mark_failed:${job.id}`}
            onClick={onMarkFailed}
          >
            Mark failed
          </Button>
          <Button
            variant="light"
            color="orange"
            disabled={!stale}
            loading={loadingAction === `resume-interrupted:${job.id}`}
            onClick={onResumeInterrupted}
          >
            Resume replacement run
          </Button>
          <Button
            variant="light"
            color="grape"
            disabled={!failedUnits.length}
            loading={loadingAction === `retry:${job.id}`}
            onClick={onRetryFailed}
          >
            Retry failed only
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function retryEndpoint(bookId: string, job: PersistedAiJob) {
  if (job.mode === "full_book_rewrite") {
    return { path: `/api/books/${bookId}/rewrite-execute`, body: { retryJobId: job.id } };
  }
  if (job.mode === "chapter_summaries") {
    return { path: `/api/books/${bookId}/chapters/summarize`, body: { retryJobId: job.id } };
  }
  if (job.mode === "bookforge_critic" || job.mode === "bookforge_critic_batch") {
    const lens = job.progress?.failedUnits?.find((unit) => unit.type === "critic_lens")?.id;
    if (lens) return { path: `/api/books/${bookId}/critic`, body: { lens, stage: stringSetting(job.settings, "stage") || "baseline" } };
  }
  if (job.mode === "manuscript_blueprint") {
    return { path: `/api/books/${bookId}/analyze`, body: { retryJobId: job.id } };
  }
  return null;
}

function replacementEndpoint(bookId: string, job: PersistedAiJob) {
  if (job.mode === "full_book_rewrite") return { path: `/api/books/${bookId}/rewrite-execute`, body: {} };
  if (job.mode === "rewrite_plan") return { path: `/api/books/${bookId}/rewrite-plan`, body: {} };
  if (job.mode === "rewrite_drift_check") return { path: `/api/books/${bookId}/drift-check`, body: {} };
  if (job.mode === "auto_revision") {
    return {
      path: `/api/books/${bookId}/auto-revision`,
      body: {
        action: "run",
        trustProfile: stringSetting(job.settings, "trustProfile") || "full_trust",
        maxDecisions: numberSetting(job.settings, "maxDecisions") || 5000,
      },
    };
  }
  if (job.mode === "voice_capture") {
    const chapterIds = stringArraySetting(job.settings, "chapterIds");
    if (chapterIds.length) return { path: `/api/books/${bookId}/voice-capture`, body: { chapterIds } };
  }
  if (job.mode === "chapter_summaries") return { path: `/api/books/${bookId}/chapters/summarize`, body: {} };
  if (job.mode === "manuscript_blueprint") return { path: `/api/books/${bookId}/analyze`, body: {} };
  if (job.mode === "publishing_lab") return { path: `/api/books/${bookId}/publishing-lab`, body: { action: "run" } };
  if (job.mode === "bookforge_critic_batch") {
    return { path: `/api/books/${bookId}/critic/all`, body: { stage: stringSetting(job.settings, "stage") || "post_rewrite" } };
  }
  if (job.mode === "bookforge_critic") {
    const lens = stringSetting(job.settings, "lens");
    if (lens) return { path: `/api/books/${bookId}/critic`, body: { lens, stage: stringSetting(job.settings, "stage") || "baseline" } };
  }
  return null;
}

function supportsServerManagedHandoff(path: string) {
  return (
    path.includes("/rewrite-execute") ||
    path.includes("/rewrite-plan") ||
    path.includes("/drift-check") ||
    path.includes("/auto-revision") ||
    path.includes("/voice-capture") ||
    path.includes("/chapters/summarize") ||
    path.endsWith("/analyze") ||
    path.includes("/critic") ||
    path.includes("/publishing-lab")
  );
}

function stringArraySetting(settings: Record<string, unknown> | null | undefined, key: string) {
  const value = settings?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function numberSetting(settings: Record<string, unknown> | null | undefined, key: string) {
  const value = settings?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringSetting(settings: Record<string, unknown> | null | undefined, key: string) {
  const value = settings?.[key];
  return typeof value === "string" ? value : "";
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="md" p="sm" bg="gray.0">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={900}>{value}</Text>
    </Paper>
  );
}

function getEta(job: PersistedAiJob) {
  const progress = job.progress;
  if (!progress || job.status !== "running" || !progress.startedAt) return "—";
  const completed = Math.max(progress.attempted, progress.successful + progress.failed);
  if (completed < 2) return "learning";
  const elapsed = (Date.now() - new Date(progress.startedAt).getTime()) / 1000;
  const secondsPerUnit = elapsed / completed;
  const remaining = Math.max(0, progress.totalUnits - completed);
  return formatDuration(Math.ceil(remaining * secondsPerUnit));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function statusColor(status: string | null) {
  if (status === "completed") return "green";
  if (status === "running") return "grape";
  if (status === "paused") return "yellow";
  if (status === "failed" || status === "cancelled") return "red";
  return "gray";
}

function humanizeMode(mode: string) {
  return mode.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
