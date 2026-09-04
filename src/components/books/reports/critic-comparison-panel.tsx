"use client";

import { useState } from "react";
import { Alert, Badge, Button, Group, Paper, Progress, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { criticLenses } from "@/lib/critic/prompts";
import { buildCriticComparisons } from "@/lib/critic/comparison";
import { fetchJson } from "@/lib/http/fetch-json";
import { mergeMetadataSnapshotBody } from "@/lib/book-metadata/selection";

type CriticReport = {
  id: string;
  report_type: string;
  created_at: string;
  content: Record<string, unknown> | null;
};

type CriticComparisonPanelProps = {
  bookId: string;
  reports: CriticReport[];
  acceptedParagraphs: number;
  totalParagraphs: number;
};

export function CriticComparisonPanel({
  bookId,
  reports,
  acceptedParagraphs,
  totalParagraphs,
}: CriticComparisonPanelProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const comparisons = buildCriticComparisons(reports);
  const regressions = comparisons.filter((item) => typeof item.delta === "number" && item.delta < 0);
  const priorityRegressions = regressions.filter((item) =>
    ["continuity", "prose_quality", "contemporary_view", "character_depth"].includes(item.lens),
  );
  const acceptedPercent = totalParagraphs ? Math.round((acceptedParagraphs / totalParagraphs) * 100) : 0;
  const readyForPostRewrite = totalParagraphs > 0 && acceptedPercent >= 80;

  async function runPostRewriteCritic() {
    setLoading(true);
    setMessage("");
    setError("");
    try {
      const result = await fetchJson<{ content?: { completed?: number } }>(
        `/api/books/${bookId}/critic/all`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mergeMetadataSnapshotBody({ stage: "post_rewrite" })),
        },
        "Run post-rewrite Critic",
      );
      setMessage(`Post-rewrite Critic completed ${result.content?.completed || 0} lens evaluation(s).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to run post-rewrite Critic.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Paper withBorder radius="md" p="xl" bg="white" mt="xl">
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>Before / After Critic</Title>
            <Text c="dimmed">
              Compare baseline Critic scores with post-rewrite scores after accepted revisions are in place.
            </Text>
          </div>
          <Button color="grape" loading={loading} onClick={runPostRewriteCritic}>
            Run Post-Rewrite Critic
          </Button>
        </Group>

        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={700}>
              Accepted rewrite coverage
            </Text>
            <Text size="sm" c="dimmed">
              <span suppressHydrationWarning>{acceptedParagraphs.toLocaleString()}</span> /{" "}
              <span suppressHydrationWarning>{totalParagraphs.toLocaleString()}</span> paragraphs
            </Text>
          </Group>
          <Progress value={acceptedPercent} color={readyForPostRewrite ? "green" : "yellow"} />
          {!readyForPostRewrite && (
            <Text size="sm" c="dimmed" mt={4}>
              You can run this now, but comparison is most useful after most rewritten paragraphs are accepted.
            </Text>
          )}
        </div>

        {message && <Alert color="green">{message}</Alert>}
        {error && <Alert color="red">{error}</Alert>}
        {priorityRegressions.length > 0 && (
          <Alert color="red" title="Priority regression detected">
            Post-rewrite scores dropped in{" "}
            {priorityRegressions.map((item) => `${criticLenses[item.lens].label} (${item.delta})`).join(", ")}. Review
            drift reports and rerun targeted paragraphs before final export.
          </Alert>
        )}
        {regressions.length > priorityRegressions.length && (
          <Alert color="yellow" title="Score drop detected">
            Some post-rewrite Critic scores are lower than baseline. Use the comparison cards to identify which lens needs
            another pass.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {comparisons.map((item) => (
            <Paper key={item.lens} withBorder radius="md" p="md" bg="#fbfaf8">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text fw={800}>{criticLenses[item.lens].label}</Text>
                  {typeof item.delta === "number" ? (
                    <Badge color={item.delta >= 0 ? "green" : "red"} variant="light">
                      {item.delta >= 0 ? "+" : ""}
                      {item.delta}
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      pending
                    </Badge>
                  )}
                </Group>
                <Group grow>
                  <ScoreBlock label="Before" score={item.before} />
                  <ScoreBlock label="After" score={item.after} />
                </Group>
                {typeof item.delta === "number" && item.delta < 0 && (
                  <Text size="sm" c="red">
                    Suggested action: rerun affected paragraphs or revise the Rewrite Architect plan for this lens.
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function ScoreBlock({ label, score }: { label: string; score: number | null }) {
  return (
    <Paper withBorder radius="sm" p="sm" bg="white">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Title order={3}>{typeof score === "number" ? score : "--"}</Title>
    </Paper>
  );
}
