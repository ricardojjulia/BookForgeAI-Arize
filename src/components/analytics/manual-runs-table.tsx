"use client";

import { Badge, Table, Text } from "@mantine/core";

export type ManualRunRow = {
  id: string;
  book_title: string;
  mode: string;
  status: string;
  durationMs: number | null;
  progress: { attempted?: number; successful?: number; failed?: number; totalUnits?: number } | null;
  createdAt: string;
};

function fmtDuration(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function statusColor(status: string) {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "grape";
  if (status === "cancelled") return "gray";
  return "yellow";
}

const modeLabel: Record<string, string> = {
  full_book_rewrite: "Execute Rewrite",
  bookforge_critic_batch: "BookForge Critic",
  bookforge_critic: "Critic (single lens)",
  manuscript_blueprint: "Manuscript Blueprint",
  rewrite_plan: "Rewrite Architect Plan",
  rewrite_drift_check: "Drift Check",
  creation_draft_generation: "Generate Draft",
  chapter_summaries: "Chapter Summaries",
  auto_revision: "Auto Revision",
};

export function ManualRunsTable({ runs }: { runs: ManualRunRow[] }) {
  if (!runs.length) {
    return (
      <Text c="dimmed" size="sm">
        No manual workflow runs yet.
      </Text>
    );
  }

  return (
    <Table withTableBorder withColumnBorders striped fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Book</Table.Th>
          <Table.Th>Action</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Duration</Table.Th>
          <Table.Th>Units</Table.Th>
          <Table.Th>Created</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {runs.slice(0, 40).map((run) => (
          <Table.Tr key={run.id}>
            <Table.Td>{run.book_title}</Table.Td>
            <Table.Td>{modeLabel[run.mode] ?? run.mode}</Table.Td>
            <Table.Td>
              <Badge color={statusColor(run.status)} variant="light" size="sm">
                {run.status}
              </Badge>
            </Table.Td>
            <Table.Td>{fmtDuration(run.durationMs)}</Table.Td>
            <Table.Td>
              {run.progress?.totalUnits
                ? `${run.progress.successful ?? 0}/${run.progress.totalUnits} ok${run.progress.failed ? `, ${run.progress.failed} failed` : ""}`
                : "—"}
            </Table.Td>
            <Table.Td>
              <span suppressHydrationWarning>{new Date(run.createdAt).toLocaleString()}</span>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
