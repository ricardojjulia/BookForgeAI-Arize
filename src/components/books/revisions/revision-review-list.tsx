"use client";

import { useState } from "react";
import { diffWords } from "diff";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  Paper,
  Select,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchJson } from "@/lib/http/fetch-json";

type RevisionVersion = {
  id: string;
  revisionJobId: string | null;
  paragraphId: string | null;
  isLocked: boolean;
  original_text: string;
  revised_text: string;
  revision_notes: string | null;
  accepted: boolean | null;
  rejected: boolean | null;
  created_at: string;
  continuity_warnings: unknown;
  chapterTitle: string;
  chapterNumber: number | null;
  paragraphNumber: number | null;
  jobMode: string;
  jobCreatedAt: string | null;
  reviewerId: string | null;
  reviewStatus: "unassigned" | "assigned" | "in_review" | "approved" | "changes_requested";
  reviewNotes: string | null;
  reviewUpdatedAt: string | null;
};

type ReviewFilter = "needs_review" | "accepted" | "rejected" | "all";

export function RevisionReviewList({
  bookId,
  versions,
  latestRewriteJobId,
  hasRewritePlan,
  latestRewriteJobStatus,
  initialJobFilter,
  reviewerOptions,
  currentUserId,
}: {
  bookId: string;
  versions: RevisionVersion[];
  latestRewriteJobId?: string | null;
  hasRewritePlan?: boolean;
  latestRewriteJobStatus?: string | null;
  initialJobFilter?: string | null;
  reviewerOptions: Array<{ value: string; label: string }>;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [batchLoadingKey, setBatchLoadingKey] = useState<string | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("needs_review");
  const [jobFilter, setJobFilter] = useState<string>(initialJobFilter || "all");
  const [latestOnly, setLatestOnly] = useState(true);
  const [openTextIds, setOpenTextIds] = useState<string[]>([]);
  const [reviewWorkflowLoadingId, setReviewWorkflowLoadingId] = useState<string | null>(null);

  async function updateRevision(versionId: string, action: "accept" | "reject") {
    setLoadingId(versionId);
    setMessage("");
    setError("");
    try {
      await fetchJson(
        `/api/revisions/${versionId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
        `${action === "accept" ? "Accept" : "Reject"} revision`,
      );
      setMessage(action === "accept" ? "Revision accepted." : "Revision rejected.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update revision.");
    } finally {
      setLoadingId(null);
    }
  }

  async function updateRevisionBatch(chapterLabel: string, versionsToUpdate: RevisionVersion[], action: "accept" | "reject") {
    const actionableVersions = versionsToUpdate.filter((version) => !version.accepted && !version.rejected);
    if (!actionableVersions.length) return;

    const verb = action === "accept" ? "accept" : "reject";
    const confirmed = window.confirm(
      `${verb.charAt(0).toUpperCase() + verb.slice(1)} ${actionableVersions.length} draft revision${
        actionableVersions.length === 1 ? "" : "s"
      } in ${chapterLabel}?`,
    );
    if (!confirmed) return;

    setBatchLoadingKey(`${action}:${chapterLabel}`);
    setMessage("");
    setError("");
    try {
      await fetchJson(
        "/api/revisions/batch",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            versionIds: actionableVersions.map((version) => version.id),
          }),
        },
        `${action === "accept" ? "Accept" : "Reject"} chapter revisions`,
      );
      setMessage(
        `${action === "accept" ? "Accepted" : "Rejected"} ${actionableVersions.length} draft revision${
          actionableVersions.length === 1 ? "" : "s"
        }.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update chapter revisions.");
    } finally {
      setBatchLoadingKey(null);
    }
  }

  async function rewriteAgain(version: RevisionVersion) {
    if (!version.paragraphId) {
      setError("This revision is not attached to a paragraph.");
      return;
    }
    const confirmed = window.confirm("Create a new rewrite draft for this paragraph? Existing revision history will be preserved.");
    if (!confirmed) return;

    setLoadingId(`rewrite:${version.id}`);
    setMessage("");
    setError("");
    const payload = {
      paragraphId: version.paragraphId,
      maxUnits: 1,
      rewriteExistingDrafts: true,
      rewriteAccepted: true,
    };
    try {
      const queued = await fetchJson<{ content?: { revisionJobId?: string } }>(
        `/api/books/${bookId}/rewrite-execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, serverManaged: true }),
        },
        "Queue paragraph rewrite",
      );
      const revisionJobId = queued.content?.revisionJobId;
      if (!revisionJobId) {
        throw new Error("Rewrite job was not created.");
      }

      setMessage("Paragraph rewrite queued.");

      void fetchJson<{ content?: { rewritten?: number; skipped?: number } }>(
        `/api/books/${bookId}/rewrite-execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, jobId: revisionJobId }),
        },
        "Rewrite paragraph again worker",
      )
        .then((result) => {
          setMessage(
            result.content?.rewritten
              ? "New paragraph rewrite draft created."
              : `No new draft was created.${result.content?.skipped ? ` Skipped ${result.content.skipped} unit(s).` : ""}`,
          );
          router.refresh();
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Unable to rewrite paragraph again.");
        })
        .finally(() => {
          setLoadingId(null);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rewrite paragraph again.");
      setLoadingId(null);
    }
  }

  async function runDriftCheck() {
    setDriftLoading(true);
    setMessage("");
    setError("");
    try {
      const result = await fetchJson<{ content?: { overallDriftRisk?: string; sampleCount?: number } }>(
        `/api/books/${bookId}/drift-check`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revisionJobId: jobFilter !== "all" ? jobFilter : latestRewriteJobId || undefined,
          }),
        },
        "Run rewrite drift check",
      );
      setMessage(
        `Drift check saved. Risk: ${result.content?.overallDriftRisk || "unknown"} · samples checked: ${
          result.content?.sampleCount || 0
        }.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to run drift check.");
    } finally {
      setDriftLoading(false);
    }
  }

  async function toggleLock(version: RevisionVersion) {
    if (!version.paragraphId) {
      setError("This revision is not attached to a paragraph.");
      return;
    }
    const reason = version.isLocked
      ? undefined
      : window.prompt("Why should this passage be protected from rewriting?", "Author wants this wording preserved.") || "";
    if (!version.isLocked && reason === "") return;

    setLoadingId(`lock:${version.id}`);
    setMessage("");
    setError("");
    try {
      await fetchJson(
        `/api/paragraphs/${version.paragraphId}/lock`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locked: !version.isLocked, reason }),
        },
        version.isLocked ? "Unlock passage" : "Lock passage",
      );
      setMessage(version.isLocked ? "Passage unlocked." : "Passage locked. Future rewrite batches will skip it.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update passage lock.");
    } finally {
      setLoadingId(null);
    }
  }

  async function updateReviewWorkflow(
    version: RevisionVersion,
    action: "assign" | "start" | "approve" | "request_changes" | "unassign",
    reviewerId?: string,
  ) {
    if (action === "assign" && !reviewerId) {
      setError("Choose a reviewer before assigning.");
      return;
    }

    setReviewWorkflowLoadingId(`${action}:${version.id}`);
    setMessage("");
    setError("");
    try {
      await fetchJson(
        `/api/revisions/${version.id}/review-workflow`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, reviewerId }),
        },
        "Update review assignment",
      );
      setMessage(
        action === "assign"
          ? "Reviewer assigned."
          : action === "start"
            ? "Review marked in progress."
            : action === "approve"
              ? "Review approved."
              : action === "request_changes"
                ? "Changes requested for this revision."
                : "Reviewer assignment cleared.",
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update reviewer workflow.");
    } finally {
      setReviewWorkflowLoadingId(null);
    }
  }

  const jobFilteredVersions = versions.filter((version) => jobFilter === "all" || version.revisionJobId === jobFilter);
  const latestFilteredVersions = latestOnly ? getLatestVersionPerParagraph(jobFilteredVersions) : jobFilteredVersions;
  const counts = latestFilteredVersions.reduce(
    (totals, version) => {
      if (version.accepted) {
        totals.accepted += 1;
      } else if (version.rejected) {
        totals.rejected += 1;
      } else {
        totals.needs_review += 1;
      }
      totals.all += 1;
      return totals;
    },
    { needs_review: 0, accepted: 0, rejected: 0, all: 0 },
  );

  const filteredVersions = latestFilteredVersions.filter((version) => {
    if (filter === "accepted") return Boolean(version.accepted);
    if (filter === "rejected") return Boolean(version.rejected);
    if (filter === "needs_review") return !version.accepted && !version.rejected;
    return true;
  });

  const groups = filteredVersions.reduce<Record<string, RevisionVersion[]>>((chapterGroups, version) => {
    const chapterLabel = `${version.chapterNumber ?? "?"}. ${version.chapterTitle}`;
    chapterGroups[chapterLabel] ||= [];
    chapterGroups[chapterLabel].push(version);
    return chapterGroups;
  }, {});

  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    const aNumber = Number.parseInt(a, 10);
    const bNumber = Number.parseInt(b, 10);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    return a.localeCompare(b);
  });

  const toggleText = (versionId: string) => {
    setOpenTextIds((current) =>
      current.includes(versionId) ? current.filter((id) => id !== versionId) : [...current, versionId],
    );
  };

  const jobOptions = [
    { label: "All runs", value: "all" },
    ...(latestRewriteJobId ? [{ label: "Latest run", value: latestRewriteJobId }] : []),
    ...getOlderJobOptions(versions, latestRewriteJobId),
  ];

  if (!versions.length) {
    return (
      <Paper withBorder radius="md" p="xl" bg="white">
        <Stack>
          <div>
            <Title order={2}>No draft revisions yet</Title>
            <Text c="dimmed" mt="xs">
              Draft revisions appear here only after you run an Execute Rewrite batch. Generating the Rewrite Architect
              plan creates the strategy, but it does not rewrite any manuscript text.
            </Text>
          </div>
          {hasRewritePlan ? (
            <Alert color="blue" variant="light">
              A rewrite plan is saved. Next step: open Rewrite Architect and run a small safe batch from Execute Rewrite
              or the Rewrite Campaign panel.
            </Alert>
          ) : (
            <Alert color="yellow" variant="light">
              No rewrite plan is saved yet. Generate the Rewrite Architect plan before creating draft revisions.
            </Alert>
          )}
          {latestRewriteJobStatus && (
            <Alert color={latestRewriteJobStatus === "completed" ? "yellow" : "red"} variant="light">
              Latest rewrite job status: {latestRewriteJobStatus}. No revision versions are attached to this book yet.
            </Alert>
          )}
          <Group>
            <Button component={Link} href={`/books/${bookId}/critic-quality`} color="grape">
              Open Rewrite Architect
            </Button>
            <Button component={Link} href={`/books/${bookId}`} variant="light" color="dark">
              Back to Book
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Stack>
      {message && <Alert color="green">{message}</Alert>}
      {error && <Alert color="red">{error}</Alert>}
      <Paper withBorder radius="md" p="lg" bg="white">
        <Group justify="space-between" align="center">
          <div>
            <Title order={2}>Review queue</Title>
            <Text c="dimmed" size="sm">
              Showing draft revisions that still need an author decision. Accepted and rejected history stays available
              in the filters.
            </Text>
          </div>
          <SegmentedControl
            value={filter}
            onChange={(value) => setFilter(value as ReviewFilter)}
            data={[
              { label: `Needs review (${counts.needs_review})`, value: "needs_review" },
              { label: `Accepted (${counts.accepted})`, value: "accepted" },
              { label: `Rejected (${counts.rejected})`, value: "rejected" },
              { label: `All (${counts.all})`, value: "all" },
            ]}
          />
        </Group>
        <Group mt="md" justify="space-between">
          <SegmentedControl value={jobFilter} onChange={setJobFilter} data={jobOptions} />
          <Group>
            <Checkbox
              checked={latestOnly}
              onChange={(event) => setLatestOnly(event.currentTarget.checked)}
              label="Latest draft per paragraph"
            />
            {jobFilter !== "all" && (
              <Text size="sm" c="dimmed">
                Showing one rewrite run. Switch to all runs to see full revision history.
              </Text>
            )}
            <Button size="xs" color="grape" variant="light" loading={driftLoading} disabled={!latestRewriteJobId} onClick={runDriftCheck}>
              Run Drift Check
            </Button>
          </Group>
        </Group>
      </Paper>

      {!filteredVersions.length ? (
        <Paper withBorder radius="md" p="xl" bg="white">
          <Title order={3}>Nothing in this view</Title>
          <Text c="dimmed" mt="xs">
            Change the filter to review accepted, rejected, or all revision history.
          </Text>
        </Paper>
      ) : (
        <Stack>
          <ReviewTriageSummary versions={filteredVersions} latestOnly={latestOnly} />
        <Accordion variant="separated" radius="md" defaultValue={sortedGroups[0]?.[0]}>
          {sortedGroups.map(([chapterLabel, chapterVersions]) => {
            const pendingInChapter = chapterVersions.filter((version) => !version.accepted && !version.rejected).length;
            return (
              <Accordion.Item key={chapterLabel} value={chapterLabel}>
                <Accordion.Control>
                  <Group justify="space-between" pr="md">
                    <div>
                      <Text fw={700}>{chapterLabel}</Text>
                      <Text size="sm" c="dimmed">
                        {chapterVersions.length} revision{chapterVersions.length === 1 ? "" : "s"}
                      </Text>
                    </div>
                    {pendingInChapter > 0 && (
                      <Badge color="yellow" variant="light">
                        {pendingInChapter} needs review
                      </Badge>
                    )}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    {pendingInChapter > 0 && (
                      <Paper withBorder radius="sm" p="sm" bg="#fffdf8">
                        <Group justify="space-between">
                          <Text size="sm" c="dimmed">
                            Apply one decision to all visible pending drafts in this chapter.
                          </Text>
                          <Group gap="xs">
                            <Button
                              size="xs"
                              color="green"
                              variant="light"
                              loading={batchLoadingKey === `accept:${chapterLabel}`}
                              onClick={() => updateRevisionBatch(chapterLabel, chapterVersions, "accept")}
                            >
                              Accept chapter
                            </Button>
                            <Button
                              size="xs"
                              color="red"
                              variant="outline"
                              loading={batchLoadingKey === `reject:${chapterLabel}`}
                              onClick={() => updateRevisionBatch(chapterLabel, chapterVersions, "reject")}
                            >
                              Reject chapter
                            </Button>
                          </Group>
                        </Group>
                      </Paper>
                    )}
                    {chapterVersions
                      .slice()
                      .sort((a, b) => (a.paragraphNumber ?? 0) - (b.paragraphNumber ?? 0))
                      .map((version) => {
                        const isOpen = openTextIds.includes(version.id);
                        return (
                          <Paper key={version.id} withBorder radius="md" p="lg" bg="white">
                            <Stack>
                              <Group justify="space-between" align="flex-start">
                                <div>
                                  <Group gap="xs">
                                    <Badge color="grape" variant="light">
                                      {version.jobMode.replace(/_/g, " ")}
                                    </Badge>
                                    <Badge
                                      color={version.accepted ? "green" : version.rejected ? "red" : "yellow"}
                                      variant="light"
                                    >
                                      {version.accepted ? "Accepted" : version.rejected ? "Rejected" : "Needs review"}
                                    </Badge>
                                    <Badge color={reviewStatusColor(version.reviewStatus)} variant="light">
                                      {reviewStatusLabel(version.reviewStatus)}
                                    </Badge>
                                    {version.isLocked && (
                                      <Badge color="gray" variant="light">
                                        Locked
                                      </Badge>
                                    )}
                                  </Group>
                                  <Title order={4} mt="xs">
                                    Paragraph {version.paragraphNumber || "unknown"}
                                  </Title>
                                  <Text c="dimmed" size="sm">
                                    <span suppressHydrationWarning>{new Date(version.created_at).toLocaleString()}</span>
                                  </Text>
                                </div>
                                <Group>
                                  <Select
                                    placeholder="Assign reviewer"
                                    data={reviewerOptions}
                                    value={version.reviewerId || null}
                                    onChange={(value) => {
                                      if (value) void updateReviewWorkflow(version, "assign", value);
                                    }}
                                    w={210}
                                  />
                                  {version.reviewerId && (
                                    <Button
                                      size="xs"
                                      variant="light"
                                      color="dark"
                                      loading={reviewWorkflowLoadingId === `unassign:${version.id}`}
                                      onClick={() => updateReviewWorkflow(version, "unassign")}
                                    >
                                      Unassign
                                    </Button>
                                  )}
                                  {(version.reviewStatus === "assigned" || version.reviewStatus === "changes_requested") &&
                                    (!version.reviewerId || version.reviewerId === currentUserId) && (
                                      <Button
                                        size="xs"
                                        variant="light"
                                        color="blue"
                                        loading={reviewWorkflowLoadingId === `start:${version.id}`}
                                        onClick={() => updateReviewWorkflow(version, "start")}
                                      >
                                        Start review
                                      </Button>
                                    )}
                                  {version.reviewStatus === "in_review" && (
                                    <>
                                      <Button
                                        size="xs"
                                        variant="light"
                                        color="green"
                                        loading={reviewWorkflowLoadingId === `approve:${version.id}`}
                                        onClick={() => updateReviewWorkflow(version, "approve")}
                                      >
                                        Approve review
                                      </Button>
                                      <Button
                                        size="xs"
                                        variant="outline"
                                        color="orange"
                                        loading={reviewWorkflowLoadingId === `request_changes:${version.id}`}
                                        onClick={() => updateReviewWorkflow(version, "request_changes")}
                                      >
                                        Request changes
                                      </Button>
                                    </>
                                  )}
                                  <Button variant="subtle" color="dark" onClick={() => toggleText(version.id)}>
                                    {isOpen ? "Hide text" : "Compare text"}
                                  </Button>
                                  <Button
                                    variant="light"
                                    color="grape"
                                    loading={loadingId === `rewrite:${version.id}`}
                                    onClick={() => rewriteAgain(version)}
                                  >
                                    Rewrite again
                                  </Button>
                                  <Button
                                    variant="light"
                                    color={version.isLocked ? "gray" : "dark"}
                                    loading={loadingId === `lock:${version.id}`}
                                    onClick={() => toggleLock(version)}
                                  >
                                    {version.isLocked ? "Unlock" : "Lock"}
                                  </Button>
                                  <Button
                                    color="green"
                                    variant="light"
                                    loading={loadingId === version.id}
                                    disabled={Boolean(version.accepted)}
                                    onClick={() => updateRevision(version.id, "accept")}
                                  >
                                    Accept
                                  </Button>
                                  <Button
                                    color="red"
                                    variant="outline"
                                    loading={loadingId === version.id}
                                    disabled={Boolean(version.rejected)}
                                    onClick={() => updateRevision(version.id, "reject")}
                                  >
                                    Reject
                                  </Button>
                                </Group>
                              </Group>

                              {version.revision_notes && (
                                <Text size="sm">
                                  <strong>Notes:</strong> {version.revision_notes}
                                </Text>
                              )}

                              {version.reviewNotes && (
                                <Text size="sm" c="dimmed">
                                  <strong>Review note:</strong> {version.reviewNotes}
                                </Text>
                              )}

                              {Array.isArray(version.continuity_warnings) &&
                                version.continuity_warnings.length > 0 && (
                                  <Alert color="yellow">
                                    <strong>Continuity warnings:</strong>{" "}
                                    {version.continuity_warnings.map(String).join(" ")}
                                  </Alert>
                                )}

                              <Collapse expanded={isOpen}>
                                <Stack>
                                  <DiffText original={version.original_text} revised={version.revised_text} />
                                  <SimpleGrid cols={{ base: 1, lg: 2 }}>
                                    <Textarea label="Original" value={version.original_text} readOnly autosize minRows={8} />
                                    <Textarea
                                      label="Rewritten draft"
                                      value={version.revised_text}
                                      readOnly
                                      autosize
                                      minRows={8}
                                    />
                                  </SimpleGrid>
                                </Stack>
                              </Collapse>
                            </Stack>
                          </Paper>
                        );
                      })}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
        </Stack>
      )}
    </Stack>
  );
}

function ReviewTriageSummary({ versions, latestOnly }: { versions: RevisionVersion[]; latestOnly: boolean }) {
  const byChapter = versions.reduce<Record<string, number>>((groups, version) => {
    const chapterLabel = `${version.chapterNumber ?? "?"}. ${version.chapterTitle}`;
    groups[chapterLabel] = (groups[chapterLabel] || 0) + 1;
    return groups;
  }, {});
  const largestChapter = Object.entries(byChapter).sort(([, a], [, b]) => b - a)[0];
  const pending = versions.filter((version) => !version.accepted && !version.rejected).length;
  const accepted = versions.filter((version) => version.accepted).length;
  const rejected = versions.filter((version) => version.rejected).length;

  return (
    <Paper withBorder radius="md" p="md" bg="#fffdf8">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={900}>Review triage</Text>
          <Text size="sm" c="dimmed">
            {latestOnly
              ? "Showing the newest draft for each paragraph, which keeps repeated rewrite attempts out of the default queue."
              : "Showing full revision history, including older attempts for the same paragraph."}
          </Text>
          {largestChapter && (
            <Text size="sm" c="dimmed">
              Heaviest chapter in this view: {largestChapter[0]} ({largestChapter[1]} draft{largestChapter[1] === 1 ? "" : "s"}).
            </Text>
          )}
        </div>
        <Group>
          <Badge color="yellow" variant="light">
            {pending} needs review
          </Badge>
          <Badge color="green" variant="light">
            {accepted} accepted
          </Badge>
          <Badge color="red" variant="light">
            {rejected} rejected
          </Badge>
        </Group>
      </Group>
    </Paper>
  );
}

function getLatestVersionPerParagraph(versions: RevisionVersion[]) {
  const latest = new Map<string, RevisionVersion>();
  const noParagraphVersions: RevisionVersion[] = [];

  for (const version of versions) {
    if (!version.paragraphId) {
      noParagraphVersions.push(version);
      continue;
    }
    const existing = latest.get(version.paragraphId);
    if (!existing || new Date(version.created_at).getTime() > new Date(existing.created_at).getTime()) {
      latest.set(version.paragraphId, version);
    }
  }

  return [...latest.values(), ...noParagraphVersions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

function getOlderJobOptions(versions: RevisionVersion[], latestRewriteJobId: string | null | undefined) {
  const seen = new Set<string>(latestRewriteJobId ? [latestRewriteJobId] : []);
  return versions.reduce<Array<{ label: string; value: string }>>((options, version) => {
    if (!version.revisionJobId || seen.has(version.revisionJobId)) return options;
    seen.add(version.revisionJobId);
    options.push({
      // ISO slice, not toLocaleDateString() -- this label is a plain string
      // (Select `data`), not a JSX node, so it can't be wrapped in
      // suppressHydrationWarning. A locale-formatted date here would still
      // differ between SSR (server default locale) and the initial client
      // render, the same hydration-mismatch class already fixed elsewhere
      // on this page.
      label: `Run ${options.length + 1}${version.jobCreatedAt ? ` · ${version.jobCreatedAt.slice(0, 10)}` : ""}`,
      value: version.revisionJobId,
    });
    return options;
  }, []);
}

function DiffText({ original, revised }: { original: string; revised: string }) {
  const parts = diffWords(original, revised);

  return (
    <Paper withBorder radius="md" p="md" bg="gray.0">
      <Group mb="xs">
        <Badge color="red" variant="light">
          removed
        </Badge>
        <Badge color="green" variant="light">
          added
        </Badge>
      </Group>
      <Text component="div" size="sm" style={{ lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
        {parts.map((part, index) => {
          if (part.removed) {
            return (
              <span key={index} style={{ background: "#ffe3e3", color: "#c92a2a", textDecoration: "line-through" }}>
                {part.value}
              </span>
            );
          }
          if (part.added) {
            return (
              <span key={index} style={{ background: "#d3f9d8", color: "#2b8a3e" }}>
                {part.value}
              </span>
            );
          }
          return <span key={index}>{part.value}</span>;
        })}
      </Text>
    </Paper>
  );
}

function reviewStatusLabel(status: RevisionVersion["reviewStatus"]) {
  if (status === "in_review") return "In review";
  if (status === "changes_requested") return "Changes requested";
  if (status === "approved") return "Review approved";
  if (status === "assigned") return "Assigned";
  return "Unassigned";
}

function reviewStatusColor(status: RevisionVersion["reviewStatus"]) {
  if (status === "in_review") return "blue";
  if (status === "changes_requested") return "orange";
  if (status === "approved") return "teal";
  if (status === "assigned") return "grape";
  return "gray";
}
