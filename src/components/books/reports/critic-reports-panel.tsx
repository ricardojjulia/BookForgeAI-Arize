"use client";

import { useMemo, useState } from "react";
import { IconInfoCircle } from "@tabler/icons-react";
import { Accordion, ActionIcon, Badge, Button, Group, JsonInput, Pagination, Paper, Select, SimpleGrid, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useRouter } from "next/navigation";
import { isCriticPostReportType, isCriticReportType } from "@/lib/critic/progress";
import { extractCriticScore } from "@/lib/critic/score";
import { CRITIC_SUMMARY_FALLBACK, summarizeCriticContent } from "@/lib/critic/summary";

type CriticReport = {
  id: string;
  report_type: string;
  created_at: string;
  content: Record<string, unknown> | null;
};

const REPORTS_PER_PAGE = 12;

// critic_batch/critic_post_batch are rollup records of a full-lens run
// (which lenses ran, their scores, failures) -- not a single lens's
// narrative, so they have no "readable findings" to summarize and no
// single lens to recheck. The run itself is already tracked properly in
// Jobs History and Analytics; showing it here just produces a confusing
// "did not include readable findings... recheck this lens" entry for
// something that was never a lens report in the first place.
const BATCH_REPORT_TYPES = new Set(["critic_batch", "critic_post_batch"]);

export function CriticReportsPanel({ bookId, reports }: { bookId: string; reports: CriticReport[] }) {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("all");
  const displayableReports = useMemo(
    () => reports.filter((report) => !BATCH_REPORT_TYPES.has(report.report_type)),
    [reports],
  );
  const reportTypeOptions = useMemo(() => getReportTypeOptions(displayableReports), [displayableReports]);
  const filteredReports = useMemo(() => filterReports(displayableReports, filter), [displayableReports, filter]);
  const totalPages = Math.max(1, Math.ceil(filteredReports.length / REPORTS_PER_PAGE));
  const visibleReports = filteredReports.slice((page - 1) * REPORTS_PER_PAGE, page * REPORTS_PER_PAGE);

  function updateFilter(value: string | null) {
    setFilter(value || "all");
    setPage(1);
  }

  return (
    <Paper id="critic-reports" withBorder radius="md" p="xl" bg="white" mt="xl" style={{ scrollMarginTop: 24 }}>
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Title order={2}>Saved Critic Reports</Title>
          <Text c="dimmed">BookForge Critic saves reports here for review and comparison.</Text>
        </div>
        <Group gap="xs">
          <Badge color="grape" variant="light">
            {filteredReports.length}/{displayableReports.length}
          </Badge>
          {totalPages > 1 && (
            <Badge color="gray" variant="light">
              Page {page} of {totalPages}
            </Badge>
          )}
        </Group>
      </Group>

      {!displayableReports.length ? (
        <Text c="dimmed">No critic reports yet. Run BookForge Critic to create one.</Text>
      ) : (
        <Stack>
          <Select
            label="Report filter"
            value={filter}
            onChange={updateFilter}
            data={reportTypeOptions}
            allowDeselect={false}
            maw={360}
          />
          {visibleReports.length ? (
            <Accordion variant="separated">
              {visibleReports.map((report) => {
                const content = report.content || {};
                const score = extractCriticScore(content);
                const summary = summarizeCriticContent(content);
                const isFallbackSummary = summary === CRITIC_SUMMARY_FALLBACK;
                return (
                  <Accordion.Item key={report.id} value={report.id}>
                    <Accordion.Control>
                      <Group justify="space-between" pr="md">
                        <Stack gap={2}>
                          <Group gap="xs">
                            <Badge color="grape" variant="light">
                              {formatReportType(report.report_type)}
                            </Badge>
                            {typeof score === "number" && <Badge color="teal">Score {score}</Badge>}
                          </Group>
                          <Text size="sm" c="dimmed">
                            <span suppressHydrationWarning>{new Date(report.created_at).toLocaleString()}</span>
                          </Text>
                        </Stack>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack>
                        <Group gap={6} align="center" wrap="nowrap">
                          <Text style={{ flex: 1 }}>{summary}</Text>
                          {isFallbackSummary && (
                            <Tooltip
                              label="This can happen when the model returns a score but skips structured findings or returns an unexpected JSON shape. Recheck usually regenerates a full narrative."
                              multiline
                              w={320}
                              withArrow
                            >
                              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Why this can happen">
                                <IconInfoCircle size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                        {isCriticReportType(report.report_type) && (
                          <Group>
                            <RecheckCriticButton bookId={bookId} reportType={report.report_type} />
                          </Group>
                        )}
                        <FindingsToggle content={content} />
                        <FullJsonToggle content={content} />
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                );
              })}
            </Accordion>
          ) : (
            <Text c="dimmed">No reports match this filter.</Text>
          )}
          {totalPages > 1 && <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />}
        </Stack>
      )}
    </Paper>
  );
}

function RecheckCriticButton({ bookId, reportType }: { bookId: string; reportType: string }) {
  const router = useRouter();
  const [loading, { open, close }] = useDisclosure(false);
  const isPostRewrite = isCriticPostReportType(reportType);
  const lens = reportType.replace(/^critic_post:/, "").replace(/^critic:/, "");
  const stage = isPostRewrite ? "post_rewrite" : "baseline";

  async function recheck() {
    open();
    try {
      const queuedResponse = await fetch(`/api/books/${bookId}/critic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lens, stage, serverManaged: true }),
      });
      const queuedResult = await queuedResponse.json();
      if (!queuedResponse.ok) throw new Error(queuedResult.error || "Unable to queue critic recheck.");

      const jobId = queuedResult?.content?.jobId;
      if (!jobId) throw new Error("Critic recheck queue handoff failed.");

      const response = await fetch(`/api/books/${bookId}/critic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lens, stage, jobId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to recheck report.");
      router.refresh();
    } finally {
      close();
    }
  }

  return (
    <Button variant="light" color="grape" size="xs" loading={loading} onClick={recheck}>
      Recheck this lens
    </Button>
  );
}

function FindingsToggle({ content }: { content: Record<string, unknown> }) {
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <div>
      <Button variant="subtle" color="grape" size="xs" onClick={toggle}>
        {opened ? "Hide readable findings" : "Show readable findings"}
      </Button>
      {opened && (
        <Stack mt="sm">
          <ReportCards title="Key findings" items={arrayItems(content.findings)} />
          <ReportCards title="Observations" items={arrayItems(content.observations)} />
          <ReportCards title="Issues" items={arrayItems(content.issues)} />
          <ReportCards title="Highest-leverage fixes" items={arrayItems(content.highestLeverageFixes)} />
          <ReportCards title="Recommended fixes" items={arrayItems(content.recommendedFixes)} />
          <ReportCards title="Risks" items={arrayItems(content.risks)} />
          <ReportCards title="Strengths" items={arrayItems(content.strengths)} />
        </Stack>
      )}
    </div>
  );
}

function formatReportType(type: string) {
  return type.replace(/^critic:/, "").replace(/_/g, " ");
}

function getReportTypeOptions(reports: CriticReport[]) {
  const typeOptions = Array.from(new Set(reports.map((report) => report.report_type))).map((type) => ({
    value: `type:${type}`,
    label: formatReportType(type),
  }));

  return [
    { value: "all", label: "All reports" },
    { value: "critic", label: "Critic reports" },
    { value: "rewrite", label: "Rewrite activity" },
    { value: "continuity", label: "Continuity ledger" },
    ...typeOptions,
  ];
}

function filterReports(reports: CriticReport[], filter: string) {
  if (filter === "critic") return reports.filter((report) => isCriticReportType(report.report_type));
  if (filter === "rewrite") return reports.filter((report) => report.report_type.startsWith("rewrite"));
  if (filter === "continuity") return reports.filter((report) => report.report_type === "continuity_ledger");
  if (filter.startsWith("type:")) {
    const type = filter.slice("type:".length);
    return reports.filter((report) => report.report_type === type);
  }
  return reports;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8);
}

function ReportCards({ title, items }: { title: string; items: unknown[] }) {
  if (!items.length) return null;
  return (
    <div>
      <Text fw={700} mb={4}>
        {title}
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {items.map((item, index) => (
          <ReadableReportItem key={readableKey(item, index)} item={item} />
        ))}
      </SimpleGrid>
    </div>
  );
}

function ReadableReportItem({ item }: { item: unknown }) {
  if (!item || typeof item !== "object") {
    return (
      <Paper withBorder radius="sm" p="md" bg="#fbfaf8">
        <Text size="sm">{String(item)}</Text>
      </Paper>
    );
  }

  const record = item as Record<string, unknown>;
  const title = stringValue(record.fix) || stringValue(record.title) || stringValue(record.issueType) || "Recommendation";
  const recommendation = stringValue(record.recommendation) || stringValue(record.suggestedFix) || stringValue(record.description);

  return (
    <Paper withBorder radius="sm" p="md" bg="#fbfaf8">
      <Stack gap="xs">
        <Group gap="xs">
          {stringValue(record.impact) && (
            <Badge color={impactColor(stringValue(record.impact))} variant="light">
              Impact: {stringValue(record.impact)}
            </Badge>
          )}
          {stringValue(record.effort) && (
            <Badge color="gray" variant="light">
              Effort: {stringValue(record.effort)}
            </Badge>
          )}
          {stringValue(record.severity) && (
            <Badge color={impactColor(stringValue(record.severity))} variant="light">
              {stringValue(record.severity)}
            </Badge>
          )}
        </Group>
        <Text fw={800}>{title}</Text>
        {recommendation && (
          <Text size="sm" c="dimmed">
            {recommendation}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function FullJsonToggle({ content }: { content: Record<string, unknown> }) {
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <div>
      <Button variant="subtle" color="dark" size="xs" onClick={toggle}>
        {opened ? "Hide full JSON" : "Show full JSON"}
      </Button>
      {opened && (
        <JsonInput
          label="Full report JSON"
          value={JSON.stringify(content, null, 2)}
          autosize
          minRows={8}
          readOnly
          mt="sm"
        />
      )}
    </div>
  );
}

function readableKey(item: unknown, index: number) {
  return `${index}-${typeof item === "string" ? item : JSON.stringify(item).slice(0, 80)}`;
}

function impactColor(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("critical") || normalized.includes("high")) return "red";
  if (normalized.includes("medium")) return "yellow";
  if (normalized.includes("low")) return "green";
  return "grape";
}
