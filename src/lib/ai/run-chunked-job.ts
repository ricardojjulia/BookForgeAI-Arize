import { fetchJson } from "@/lib/http/fetch-json";

export type ChunkedJobResult = {
  status?: string;
  remainingUnits?: number;
  remainingChapters?: number;
  [key: string]: unknown;
};

// Safety cap against a runaway loop if a route ever stops reporting a
// decreasing remaining count -- not expected to ever be hit in practice
// (rewrite-execute/generate-draft process a handful of units per chunk).
const MAX_CHUNK_CALLS = 2000;

/**
 * Drives any route that implements the "single bounded chunk per request,
 * same jobId reused across calls, remainingUnits/remainingChapters signals
 * more work" pattern (rewrite-execute, generate-draft). Replaces three
 * independently-reimplemented queue-then-poll loops (AutoReviewRunner's
 * external batch loop around rewrite-execute, FocusedRewritePanel's
 * runServerManagedStep, and this app's server-side auto-review/process
 * stage loop) with one shared driver.
 *
 * Unlike runServerManagedJob (src/lib/rewrite/run-server-managed-job.ts),
 * which fires the "run" request without awaiting it and separately polls
 * `/jobs` for a job that can legitimately take hours in a single call, each
 * "run" call here is expected to return quickly -- bounded by the route's
 * own `maxDuration` -- so this simply awaits each chunk directly in
 * sequence. It never fires the next chunk before the previous one's
 * response lands: rewrite-execute's own code comment documents a real
 * incident where duplicate concurrent jobs for the same book ran in true
 * parallel for ~2 hours before being caught, and firing chunk requests
 * out of order for the same jobId would risk a similar class of bug.
 */
export async function runChunkedJob(
  path: string,
  body: Record<string, unknown>,
  label: string,
  onProgress?: (result: ChunkedJobResult) => void,
): Promise<ChunkedJobResult> {
  const queued = await fetchJson<{ content?: { jobId?: string } }>(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, serverManaged: true }) },
    `${label} (queue)`,
  );
  const jobId = queued.content?.jobId;
  if (!jobId) throw new Error(`${label} did not return a job id.`);

  for (let call = 0; call < MAX_CHUNK_CALLS; call += 1) {
    const response = await fetchJson<{ content?: ChunkedJobResult; ok?: boolean; message?: string }>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, jobId, externalDriver: true }),
      },
      `${label} (chunk ${call + 1})`,
    );

    // A jobId that already refers to a completed/failed job short-circuits
    // with `{ ok, message }` instead of a `content` payload (both routes do
    // this) -- treat "already completed" as done, "already failed" as an error.
    if (!response.content) {
      if (response.ok) return { status: "completed" };
      throw new Error(response.message || `${label} failed.`);
    }

    onProgress?.(response.content);

    if (response.content.status === "failed") throw new Error(`${label} failed.`);
    if (response.content.status === "cancelled") throw new Error(`${label} was cancelled.`);

    const remaining = response.content.remainingUnits ?? response.content.remainingChapters ?? 0;
    if (response.content.status === "completed" || remaining <= 0) return response.content;
  }

  throw new Error(`${label} did not finish within ${MAX_CHUNK_CALLS} chunk calls.`);
}
