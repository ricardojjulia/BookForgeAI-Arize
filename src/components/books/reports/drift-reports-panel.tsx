"use client";

import { Accordion, Badge, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";

type DriftReport = {
  id: string;
  report_type: string;
  created_at: string;
  content: Record<string, unknown> | null;
};

const driftFields = [
  ["voiceDrift", "Voice drift"],
  ["factDrift", "Fact drift"],
  ["timelineDrift", "Timeline drift"],
  ["characterDrift", "Character drift"],
  ["motifDrift", "Motif drift"],
  ["contemporaryViewDrift", "Contemporary View drift"],
  ["overExpansionWarnings", "Over-expansion warnings"],
  ["recommendedActions", "Recommended actions"],
] as const;

export function DriftReportsPanel({ reports }: { reports: DriftReport[] }) {
  const driftReports = reports.filter((report) => report.report_type === "rewrite_drift_check");
  const latest = driftReports[0]?.content || null;
  const risk = stringValue(latest?.overallDriftRisk) || "not checked";

  return (
    <Paper withBorder radius="md" p="xl" bg="white" mt="xl">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Rewrite Drift Reports</Title>
          <Text c="dimmed">Checks whether rewrite drafts are drifting from voice, facts, timeline, characters, motifs, or worldview.</Text>
        </div>
        <Badge color={riskColor(risk)} variant="light">
          {risk}
        </Badge>
      </Group>

      {!driftReports.length ? (
        <Text c="dimmed">No drift checks yet. Run one from Revision Review after a rewrite batch.</Text>
      ) : (
        <Accordion variant="separated" defaultValue={driftReports[0].id}>
          {driftReports.slice(0, 8).map((report) => {
            const content = report.content || {};
            const reportRisk = stringValue(content.overallDriftRisk) || "unknown";
            return (
              <Accordion.Item key={report.id} value={report.id}>
                <Accordion.Control>
                  <Group justify="space-between" pr="md">
                    <Stack gap={2}>
                      <Group gap="xs">
                        <Badge color={riskColor(reportRisk)} variant="light">
                          {reportRisk}
                        </Badge>
                        <Text fw={700}>Rewrite drift check</Text>
                      </Group>
                      <Text size="sm" c="dimmed">
                        <span suppressHydrationWarning>{new Date(report.created_at).toLocaleString()}</span>
                      </Text>
                    </Stack>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <Text>{stringValue(content.summary) || "No summary returned."}</Text>
                    <SimpleGrid cols={{ base: 1, md: 2 }}>
                      {driftFields.map(([key, label]) => (
                        <DriftItems key={key} title={label} items={arrayItems(content[key])} />
                      ))}
                    </SimpleGrid>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
    </Paper>
  );
}

function DriftItems({ title, items }: { title: string; items: unknown[] }) {
  return (
    <Paper withBorder radius="md" p="md" bg="#fbfaf8">
      <Text fw={800} mb="xs">
        {title}
      </Text>
      {!items.length ? (
        <Text size="sm" c="dimmed">
          None returned.
        </Text>
      ) : (
        <Stack gap="xs">
          {items.slice(0, 6).map((item, index) => (
            <Text key={`${title}-${index}`} size="sm">
              {readableItem(item)}
            </Text>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function readableItem(item: unknown) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item);
  const record = item as Record<string, unknown>;
  return (
    stringValue(record.description) ||
    stringValue(record.issue) ||
    stringValue(record.warning) ||
    stringValue(record.recommendation) ||
    JSON.stringify(record)
  );
}

function arrayItems(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function riskColor(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("critical") || normalized.includes("high")) return "red";
  if (normalized.includes("medium")) return "yellow";
  if (normalized.includes("low")) return "green";
  return "gray";
}
