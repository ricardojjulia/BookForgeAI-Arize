"use client";

import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/http/fetch-json";
import classes from "./publishing-lab-workspace.module.css";

type PublishingLabBundle = {
  judges: Array<{
    judgeId: string;
    provider: string;
    model: string;
    score: number | null;
    verdict: string;
  }>;
  consensus: {
    publicationReadinessScore: number | null;
    verdict: string;
    readerImpact: string;
    strengths: string[];
    concerns: string[];
    actionableFixes: string[];
    consensusNotes: string;
  };
  assets: {
    description: string;
    dedication: string;
    frontMatter: string;
    backMatter: string;
    authorBiography: string;
  };
  covers: Array<{
    version: number;
    styleName: string;
    subtitle: string;
    blurb: string;
    svg: string;
    imageUrl?: string | null;
    imageProvider?: string | null;
  }>;
  generatedAt: string;
};

type PublishingLabHistoryItem = {
  id: string;
  created_at: string;
  content: PublishingLabBundle;
};

export function PublishingLabWorkspace({
  bookId,
  initialBundle,
  initialHistory,
  eligible,
}: {
  bookId: string;
  initialBundle: PublishingLabBundle | null;
  initialHistory: PublishingLabHistoryItem[];
  eligible: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [savingAssets, setSavingAssets] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [error, setError] = useState("");
  const [bundle, setBundle] = useState<PublishingLabBundle | null>(initialBundle);
  const [history, setHistory] = useState<PublishingLabHistoryItem[]>(initialHistory);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(initialHistory[0]?.id || null);

  const scoreColor = useMemo(() => {
    const score = bundle?.consensus.publicationReadinessScore;
    if (typeof score !== "number") return "gray";
    if (score >= 85) return "green";
    if (score >= 70) return "teal";
    if (score >= 55) return "yellow";
    return "red";
  }, [bundle?.consensus.publicationReadinessScore]);

  async function runPublishingLab() {
    setLoading(true);
    setError("");
    setSaveMessage("");
    try {
      const queued = await fetchJson<{ content?: { jobId?: string } }>(
        `/api/books/${bookId}/publishing-lab`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "run", serverManaged: true }),
        },
        "Queue Publishing Lab run",
      );
      const jobId = queued.content?.jobId;
      if (!jobId) throw new Error("Publishing Lab queue handoff failed.");

      const response = await fetchJson<{ content: PublishingLabBundle; reportId?: string | null; createdAt?: string | null }>(
        `/api/books/${bookId}/publishing-lab`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "run", jobId }),
        },
        "Publishing Lab worker",
      );
      setBundle(response.content);
      if (response.reportId && response.createdAt) {
        const nextItem = {
          id: response.reportId,
          created_at: response.createdAt,
          content: response.content,
        };
        setHistory((current) => [nextItem, ...current.filter((item) => item.id !== nextItem.id)].slice(0, 12));
        setSelectedReportId(nextItem.id);
      }
      router.refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Publishing Lab failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveAssetsToMatter() {
    if (!selectedReportId) return;
    setSavingAssets(true);
    setError("");
    setSaveMessage("");
    try {
      const response = await fetchJson<{ savedSections: number }>(
        `/api/books/${bookId}/publishing-lab`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "save_assets", reportId: selectedReportId }),
        },
        "Save Publishing Lab assets",
      );
      setSaveMessage(`Saved ${response.savedSections} section(s) into Front / Back Matter.`);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save assets.");
    } finally {
      setSavingAssets(false);
    }
  }

  function selectHistoryItem(item: PublishingLabHistoryItem) {
    setSelectedReportId(item.id);
    setBundle(item.content);
    setSaveMessage("");
    setError("");
  }

  return (
    <Stack>
      <Paper withBorder radius="md" p="xl" bg="white">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>Ultimate Critic + Publishing Assets</Title>
            <Text c="dimmed" size="sm">
              Separate post-finish gateway. This run produces a candid consensus critique plus packaging assets and three cover versions.
            </Text>
          </div>
          <Button color="grape" loading={loading} disabled={!eligible} onClick={runPublishingLab}>
            {bundle ? "Re-run Publishing Lab" : "Run Publishing Lab"}
          </Button>
        </Group>
        {!eligible && (
          <Alert color="yellow" mt="md">
            This gateway unlocks only after the book is marked as finished.
          </Alert>
        )}
        {error && (
          <Alert color="red" mt="md">
            {error}
          </Alert>
        )}
        {saveMessage && (
          <Alert color="green" mt="md">
            {saveMessage}
          </Alert>
        )}
      </Paper>

      <Paper withBorder radius="md" p="xl" bg="white">
        <Group justify="space-between" mb="sm" align="flex-start">
          <div>
            <Title order={3}>Run History</Title>
            <Text size="sm" c="dimmed">Open any prior run or save the selected run assets into matter sections.</Text>
          </div>
          <Group>
            <Button
              variant="light"
              color="teal"
              disabled={!selectedReportId || !bundle}
              loading={savingAssets}
              onClick={saveAssetsToMatter}
            >
              Save Assets to Matter Sections
            </Button>
          </Group>
        </Group>

        {!history.length ? (
          <Text c="dimmed">No Publishing Lab runs yet.</Text>
        ) : (
          <Stack gap="xs">
            {history.map((item) => {
              const score = item.content.consensus.publicationReadinessScore;
              const hasRenderedCovers = item.content.covers.some((cover) => Boolean(cover.imageUrl));
              const selected = item.id === selectedReportId;
              return (
                <Card
                  key={item.id}
                  withBorder
                  radius="md"
                  p="sm"
                  bg={selected ? "#f4f8ff" : "#fbfaf8"}
                  className={classes.historyCard}
                  onClick={() => selectHistoryItem(item)}
                >
                  <Group justify="space-between" align="center">
                    <Group gap="xs">
                      <Badge color={selected ? "blue" : "gray"} variant="light">
                        {selected ? "Selected" : "History"}
                      </Badge>
                      <Badge color={hasRenderedCovers ? "teal" : "gray"} variant="light">
                        {hasRenderedCovers ? "Real cover images" : "SVG fallback"}
                      </Badge>
                      <Text size="sm"><span suppressHydrationWarning>{new Date(item.created_at).toLocaleString()}</span></Text>
                    </Group>
                    <Badge color={typeof score === "number" ? (score >= 75 ? "green" : score >= 60 ? "yellow" : "red") : "gray"} variant="light">
                      Score {score ?? "--"}
                    </Badge>
                  </Group>
                </Card>
              );
            })}
          </Stack>
        )}
      </Paper>

      {!bundle ? (
        <Alert color="grape">No Publishing Lab report yet. Run it to generate critique consensus and publishing assets.</Alert>
      ) : (
        <>
          <Paper withBorder radius="md" p="xl" bg="white">
            <Group justify="space-between" mb="md" align="flex-start">
              <div>
                <Title order={3}>Consensus Critique</Title>
                <Text c="dimmed" size="sm">{bundle.consensus.consensusNotes}</Text>
              </div>
              <Badge color={scoreColor} size="lg" variant="light">
                Score {bundle.consensus.publicationReadinessScore ?? "--"}
              </Badge>
            </Group>

            <Stack>
              <Text fw={700}>Verdict</Text>
              <Text>{bundle.consensus.verdict || "No verdict."}</Text>
              <Text fw={700}>Reader Impact</Text>
              <Text>{bundle.consensus.readerImpact || "No reader impact notes."}</Text>
            </Stack>

            <SimpleGrid cols={{ base: 1, md: 3 }} mt="md">
              <ListCard title="Strengths" items={bundle.consensus.strengths} />
              <ListCard title="Concerns" items={bundle.consensus.concerns} />
              <ListCard title="Actionable Fixes" items={bundle.consensus.actionableFixes} />
            </SimpleGrid>

            <Group gap="xs" mt="md">
              {bundle.judges.map((judge) => (
                <Badge key={`${judge.judgeId}-${judge.model}`} color="grape" variant="light">
                  {judge.provider}:{judge.model} {typeof judge.score === "number" ? `(${judge.score})` : ""}
                </Badge>
              ))}
            </Group>
          </Paper>

          <Paper withBorder radius="md" p="xl" bg="white">
            <Title order={3} mb="md">Generated Assets</Title>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <AssetCard title="Book Description" content={bundle.assets.description} />
              <AssetCard title="Dedication" content={bundle.assets.dedication} />
              <AssetCard title="Front Matter" content={bundle.assets.frontMatter} />
              <AssetCard title="Back Matter" content={bundle.assets.backMatter} />
              <AssetCard title="Author Biography" content={bundle.assets.authorBiography} />
            </SimpleGrid>
          </Paper>

          <Paper withBorder radius="md" p="xl" bg="white">
            <Title order={3} mb="md">Cover Versions</Title>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              {bundle.covers.map((cover) => (
                <Card key={cover.version} withBorder radius="md" p="sm" bg="#faf9f7">
                  <Stack>
                    {cover.imageUrl ? (
                      <Image
                        src={cover.imageUrl}
                        alt={`Cover version ${cover.version}: ${cover.styleName}`}
                        width={1024}
                        height={1536}
                        className={classes.coverImage}
                        unoptimized
                      />
                    ) : (
                      <Image
                        src={`data:image/svg+xml;utf8,${encodeURIComponent(cover.svg)}`}
                        alt={`Cover version ${cover.version}: ${cover.styleName}`}
                        width={1600}
                        height={2560}
                        className={classes.coverImage}
                        unoptimized
                      />
                    )}
                    <Text fw={700}>Version {cover.version}: {cover.styleName}</Text>
                    <Text size="sm" c="dimmed">{cover.subtitle}</Text>
                    <Text size="sm">{cover.blurb}</Text>
                    {cover.imageProvider && (
                      <Badge size="xs" color="teal" variant="light">Rendered via {cover.imageProvider}</Badge>
                    )}
                  </Stack>
                </Card>
              ))}
            </SimpleGrid>
          </Paper>
        </>
      )}
    </Stack>
  );
}

function ListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <Card withBorder radius="md" p="md" bg="#fbfaf8">
      <Text fw={800} mb="xs">{title}</Text>
      {!items.length ? <Text size="sm" c="dimmed">No items.</Text> : (
        <Stack gap={6}>
          {items.slice(0, 8).map((item, index) => (
            <Text size="sm" key={`${title}-${index}`}>• {item}</Text>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function AssetCard({ title, content }: { title: string; content: string }) {
  return (
    <Card withBorder radius="md" p="md" bg="#fbfaf8">
      <Text fw={800} mb="xs">{title}</Text>
      <Text size="sm" className={classes.assetContent}>{content || "No content returned."}</Text>
    </Card>
  );
}
