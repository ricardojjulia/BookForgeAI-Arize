"use client";

import { Alert, Badge, Stack, Table, Text } from "@mantine/core";

export type EstimationAccuracyRow = {
  task: string;
  jobCount: number;
  avgActualMs: number;
  avgEstimatedMs: number | null;
};

export type StaleIncidentRow = {
  id: string;
  task: string;
  duration_ms: number | null;
  error_signature: string | null;
  created_at: string;
};

function fmtSeconds(ms: number) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function ratioColor(ratio: number) {
  // Ratio = actual / estimated. Close to 1 is well-calibrated.
  if (ratio >= 0.7 && ratio <= 1.4) return "green";
  if (ratio >= 0.4 && ratio <= 2.5) return "yellow";
  return "red";
}

export function EstimationAccuracyTable({ rows }: { rows: EstimationAccuracyRow[] }) {
  if (!rows.length) {
    return (
      <Text c="dimmed" size="sm">
        No completed jobs with recorded estimates yet.
      </Text>
    );
  }

  return (
    <Table withTableBorder withColumnBorders striped fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Task</Table.Th>
          <Table.Th>Jobs</Table.Th>
          <Table.Th>Avg actual</Table.Th>
          <Table.Th>Avg estimated</Table.Th>
          <Table.Th>Accuracy</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => {
          const ratio = row.avgEstimatedMs ? row.avgActualMs / row.avgEstimatedMs : null;
          return (
            <Table.Tr key={row.task}>
              <Table.Td>{row.task}</Table.Td>
              <Table.Td>{row.jobCount}</Table.Td>
              <Table.Td>{fmtSeconds(row.avgActualMs)}</Table.Td>
              <Table.Td>{row.avgEstimatedMs ? fmtSeconds(row.avgEstimatedMs) : "no estimate recorded"}</Table.Td>
              <Table.Td>
                {ratio === null ? (
                  "—"
                ) : (
                  <Badge color={ratioColor(ratio)} variant="light" size="sm">
                    {ratio.toFixed(2)}x
                  </Badge>
                )}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

export function StaleIncidentsPanel({ incidents }: { incidents: StaleIncidentRow[] }) {
  if (!incidents.length) {
    return (
      <Alert color="green" variant="light">
        No stalled jobs detected — every job has either completed, failed normally, or is still actively heartbeating.
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      <Alert color="orange" variant="light">
        {incidents.length} job{incidents.length === 1 ? "" : "s"} auto-detected as stalled (no heartbeat for 10+ minutes) and
        automatically marked failed.
      </Alert>
      <Table withTableBorder withColumnBorders striped fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Task</Table.Th>
            <Table.Th>Stalled for</Table.Th>
            <Table.Th>Detected at</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {incidents.map((incident) => (
            <Table.Tr key={incident.id}>
              <Table.Td>{incident.task}</Table.Td>
              <Table.Td>{incident.duration_ms ? fmtSeconds(incident.duration_ms) : "unknown"}</Table.Td>
              <Table.Td>
                <span suppressHydrationWarning>{new Date(incident.created_at).toLocaleString()}</span>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
