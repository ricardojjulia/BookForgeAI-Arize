"use client";

/**
 * RunsTable
 *
 * Interactive analytics table for auto-review runs. Handles expand/collapse
 * of per-run detail panels — stage timing breakdowns, critic score progression,
 * and book stats. All data is passed as props from the server component so no
 * additional fetches are needed after initial page load.
 *
 * Layout:
 *   Summary card row (clickable) → expands RunDetailPanel below
 *   RunDetailPanel:
 *     ├── Book stats (chapters, paragraphs, estimated words, model)
 *     ├── Stage timing bars (durationMs as % of total, sorted slowest-first)
 *     └── Score progression table (baseline → after each cycle, per lens)
 */

import { useState } from "react";
import {
  Badge,
  Box,
  Grid,
  Group,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconClock, IconBook, IconRobot } from "@tabler/icons-react";
import type { RunRecord, StageDuration, ScoreSnapshot } from "@/app/api/analytics/route";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format milliseconds as "Xm Ys" or "Xs". */
function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Rough word-count estimate: average literary paragraph ≈ 65 words. */
function estimateWords(paragraphs: number): string {
  return (paragraphs * 65).toLocaleString();
}

/** ISO date string → short locale date. */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Converts a raw stage ID into a human-readable label. */
function fmtStage(stageId: string): string {
  const map: Record<string, string> = {
    analyze: "Analyze & Blueprint",
    summarize: "Summarize Chapters",
    rewrite_plan: "Rewrite Plan",
    rewrite_execute: "Execute Rewrite",
    auto_accept: "Auto-Accept Drafts",
    drift_check: "Drift Check",
    critics_check: "Quality Gate",
    export: "Export",
    mark_finished: "Mark Finished",
  };
  if (map[stageId]) return map[stageId];
  if (stageId.startsWith("critic_baseline:")) return `Baseline · ${stageId.split(":")[1].replace(/_/g, " ")}`;
  if (stageId.startsWith("critic_post:")) return `Post · ${stageId.split(":")[1].replace(/_/g, " ")}`;
  return stageId;
}

const MODE_LABELS: Record<string, string> = {
  full_review: "Full Review",
  make_shorter: "Make Shorter",
  make_longer: "Make Longer",
};
const MODE_COLORS: Record<string, string> = {
  full_review: "grape",
  make_shorter: "teal",
  make_longer: "blue",
};
const STATUS_COLORS: Record<string, string> = {
  completed: "green",
  failed: "red",
  running: "yellow",
  cancelled: "gray",
};

/** Score badge: green ≥ 70, yellow 50–69, red < 50. */
function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <Text size="xs" c="dimmed">—</Text>;
  return (
    <Badge size="xs" color={score >= 70 ? "green" : score >= 50 ? "yellow" : "red"} variant="light">
      {score}
    </Badge>
  );
}

// ── Critic lens display names ─────────────────────────────────────────────────

const CRITIC_LENSES = [
  "story_structure",
  "prose_quality",
  "continuity",
  "character_depth",
  "market_fit",
  "contemporary_view",
  "revision_priorities",
] as const;

const CRITIC_LABELS: Record<string, string> = {
  story_structure: "Story Structure",
  prose_quality: "Prose Quality",
  continuity: "Continuity",
  character_depth: "Character Depth",
  market_fit: "Market Fit",
  contemporary_view: "Contemporary View",
  revision_priorities: "Revision Priorities",
};

// ── Stage timing breakdown ────────────────────────────────────────────────────

function StageTiming({ durations }: { durations: StageDuration[] }) {
  if (durations.length === 0) {
    return <Text size="sm" c="dimmed">No timing data recorded (run predates telemetry).</Text>;
  }

  // Aggregate durations across iterations — for re-runs, sum all occurrences
  const aggregated = new Map<string, number>();
  for (const d of durations) {
    aggregated.set(d.stage, (aggregated.get(d.stage) ?? 0) + d.durationMs);
  }

  const sorted = Array.from(aggregated.entries())
    .map(([stage, ms]) => ({ stage, ms }))
    .sort((a, b) => b.ms - a.ms);

  const total = sorted.reduce((sum, s) => sum + s.ms, 0);

  return (
    <Stack gap={6}>
      {sorted.map(({ stage, ms }) => (
        <Group key={stage} gap="xs" wrap="nowrap">
          <Text size="xs" style={{ width: 200, flexShrink: 0 }} lineClamp={1} c="dimmed">
            {fmtStage(stage)}
          </Text>
          <Progress
            value={total > 0 ? (ms / total) * 100 : 0}
            size="sm"
            radius="xl"
            style={{ flex: 1 }}
            color="grape"
          />
          <Text size="xs" c="dimmed" style={{ width: 52, textAlign: "right", flexShrink: 0 }}>
            {fmtDuration(ms)}
          </Text>
        </Group>
      ))}
      <Text size="xs" c="dimmed" mt={4}>Total tracked: {fmtDuration(total)}</Text>
    </Stack>
  );
}

// ── Score progression table ───────────────────────────────────────────────────

function ScoreProgression({ snapshots }: { snapshots: ScoreSnapshot[] }) {
  if (snapshots.length === 0) {
    return <Text size="sm" c="dimmed">No score data recorded (run predates telemetry).</Text>;
  }

  // Find the baseline snapshot (first entry that has baselineScores)
  const baseline = snapshots.find((s) => s.baselineScores);

  return (
    <Table withColumnBorders fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Critic Lens</Table.Th>
          {baseline && <Table.Th>Baseline</Table.Th>}
          {snapshots.map((snap, i) => (
            <Table.Th key={i}>After Cycle {snap.iteration + 1}</Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {CRITIC_LENSES.map((lens) => (
          <Table.Tr key={lens}>
            <Table.Td>{CRITIC_LABELS[lens]}</Table.Td>
            {baseline && (
              <Table.Td><ScoreBadge score={baseline.baselineScores?.[lens]} /></Table.Td>
            )}
            {snapshots.map((snap, i) => (
              <Table.Td key={i}><ScoreBadge score={snap.scores?.[lens]} /></Table.Td>
            ))}
          </Table.Tr>
        ))}
        <Table.Tr fw={600}>
          <Table.Td>Average</Table.Td>
          {baseline && (
            <Table.Td>
              <ScoreBadge score={
                (() => {
                  const vals = Object.values(baseline.baselineScores ?? {}).filter((v): v is number => v !== null);
                  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
                })()
              } />
            </Table.Td>
          )}
          {snapshots.map((snap, i) => (
            <Table.Td key={i}><ScoreBadge score={snap.avgScore} /></Table.Td>
          ))}
        </Table.Tr>
      </Table.Tbody>
    </Table>
  );
}

// ── Run detail panel ──────────────────────────────────────────────────────────

function RunDetailPanel({ run }: { run: RunRecord }) {
  return (
    <Paper withBorder p="md" ml="lg" bg="var(--mantine-color-gray-0)" radius="md">
      <Grid gap="xl">
        {/* Left column: book stats + model */}
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Stack gap="xs">
            <Group gap="xs">
              <ThemeIcon size="sm" color="grape" variant="light"><IconBook size={12} /></ThemeIcon>
              <Text size="sm" fw={600}>Manuscript at Run Start</Text>
            </Group>
            <Text size="sm">{run.book_stats.chapters} chapters</Text>
            <Text size="sm"><span suppressHydrationWarning>{run.book_stats.paragraphs.toLocaleString()}</span> paragraphs</Text>
            <Text size="sm" c="dimmed">≈ <span suppressHydrationWarning>{estimateWords(run.book_stats.paragraphs)}</span> words (estimated)</Text>

            {run.model && (
              <>
                <Group gap="xs" mt="xs">
                  <ThemeIcon size="sm" color="indigo" variant="light"><IconRobot size={12} /></ThemeIcon>
                  <Text size="sm" fw={600}>Model</Text>
                </Group>
                <Text size="sm" c="dimmed" style={{ wordBreak: "break-all" }}>{run.model}</Text>
              </>
            )}

            {run.error && (
              <Box mt="xs">
                <Text size="xs" fw={600} c="red">Error</Text>
                <Text size="xs" c="red">{run.error}</Text>
              </Box>
            )}
          </Stack>
        </Grid.Col>

        {/* Right column: stage timings */}
        <Grid.Col span={{ base: 12, sm: 8 }}>
          <Group gap="xs" mb="xs">
            <ThemeIcon size="sm" color="grape" variant="light"><IconClock size={12} /></ThemeIcon>
            <Text size="sm" fw={600}>Stage Timings</Text>
          </Group>
          <StageTiming durations={run.stageDurations} />
        </Grid.Col>
      </Grid>

      {/* Score progression — full width below */}
      {run.scoreSnapshots.length > 0 && (
        <Box mt="lg">
          <Text size="sm" fw={600} mb="xs">Critic Score Progression</Text>
          <ScoreProgression snapshots={run.scoreSnapshots} />
        </Box>
      )}
    </Paper>
  );
}

// ── Main table component ──────────────────────────────────────────────────────

export function RunsTable({ runs }: { runs: RunRecord[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <Paper withBorder p="xl" radius="md" ta="center">
        <Text c="dimmed">No runs yet. Start the Auto-Review Wizard on any book to see analytics here.</Text>
      </Paper>
    );
  }

  return (
    <Stack gap="sm">
      {runs.map((run) => {
        const isExpanded = expandedId === run.id;
        return (
          <div key={run.id}>
            {/* Summary row — click to expand detail */}
            <Paper
              withBorder
              p="md"
              radius="md"
              style={{ cursor: "pointer" }}
              onClick={() => setExpandedId(isExpanded ? null : run.id)}
            >
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                  <ThemeIcon size="sm" color="gray" variant="subtle">
                    {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  </ThemeIcon>
                  <Badge color={MODE_COLORS[run.mode] ?? "gray"} variant="light" size="sm">
                    {MODE_LABELS[run.mode] ?? run.mode}
                  </Badge>
                  <Text fw={600} size="sm" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
                    {run.book_title}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    <span suppressHydrationWarning>{fmtDate(run.created_at)}</span>
                  </Text>
                </Group>

                <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Badge color={STATUS_COLORS[run.status] ?? "gray"} variant="dot" size="sm">
                    {run.status}
                  </Badge>
                  <Text size="xs" c="dimmed" style={{ width: 52, textAlign: "right" }}>
                    {fmtDuration(run.durationMs)}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ width: 52, textAlign: "right" }}>
                    {run.iteration + 1} cycle{run.iteration !== 0 ? "s" : ""}
                  </Text>
                  <Box style={{ width: 36, textAlign: "right" }}>
                    {run.avgScore !== null
                      ? <ScoreBadge score={run.avgScore} />
                      : <Text size="xs" c="dimmed">—</Text>}
                  </Box>
                  <Text size="xs" c="dimmed" style={{ width: 64, textAlign: "right" }}>
                    <span suppressHydrationWarning>{run.book_stats.paragraphs.toLocaleString()}</span> ¶
                  </Text>
                </Group>
              </Group>
            </Paper>

            {/* Expandable detail panel */}
            {isExpanded && <RunDetailPanel run={run} />}
          </div>
        );
      })}
    </Stack>
  );
}
