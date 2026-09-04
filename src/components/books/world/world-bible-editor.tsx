"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Group, Tabs, Text } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { EntityList } from "@/components/books/world/entity-list";
import { GenerationProgressAlert } from "@/components/ai/generation-progress-alert";
import { fetchJson } from "@/lib/http/fetch-json";

type Chapter = { id: string; chapter_number: number; title: string | null };

type Props = {
  bookId: string;
  seriesId: string | null;
  sharedEntityLinkIds: Record<string, string>;
  initialCharacters: Record<string, unknown>[];
  initialLocations: Record<string, unknown>[];
  initialThemes: Record<string, unknown>[];
  initialMotifs: Record<string, unknown>[];
  initialTimeline: Record<string, unknown>[];
  chapters: Chapter[];
  discoveryStatus: string;
  discoveryProcessed: boolean;
  discoveryProcessedAt: string | null;
};

type QueueResponse = { content?: { jobId?: string } };

function linksForType(sharedEntityLinkIds: Record<string, string>, entityType: string): Record<string, string> {
  const prefix = `${entityType}:`;
  return Object.fromEntries(
    Object.entries(sharedEntityLinkIds)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, linkId]) => [key.slice(prefix.length), linkId]),
  );
}

export function WorldBibleEditor({
  bookId,
  seriesId,
  sharedEntityLinkIds,
  initialCharacters,
  initialLocations,
  initialThemes,
  initialMotifs,
  initialTimeline,
  chapters,
  discoveryStatus,
  discoveryProcessed,
  discoveryProcessedAt,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<string | null>("characters");
  const [discovering, setDiscovering] = useState(false);
  const [message, setMessage] = useState<{ color: "green" | "red" | "blue"; text: string } | null>(null);

  async function discoverWithAi() {
    setDiscovering(true);
    setMessage(null);
    try {
      const queued = await fetchJson<QueueResponse>(
        `/api/books/${bookId}/analyze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serverManaged: true, discoverWorldBible: true }),
        },
        "Queue World Bible discovery",
      );
      const jobId = queued.content?.jobId;
      if (!jobId) throw new Error("World Bible discovery job was not created.");

      setMessage({ color: "blue", text: "Discovery is running. You can follow it in Jobs History." });
      void fetchJson(
        `/api/books/${bookId}/analyze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, discoverWorldBible: true }),
        },
        "Discover World Bible with AI",
      )
        .then(() => {
          setMessage({ color: "green", text: "World Bible discovery completed." });
          router.refresh();
        })
        .catch((error) => {
          setMessage({ color: "red", text: error instanceof Error ? error.message : "World Bible discovery failed." });
        })
        .finally(() => setDiscovering(false));
    } catch (error) {
      setMessage({ color: "red", text: error instanceof Error ? error.message : "World Bible discovery failed." });
      setDiscovering(false);
    }
  }

  return (
    <>
      <Group justify="space-between" align="center" mb="lg">
        <div>
          <Group gap="xs">
            <Text fw={700}>Manuscript discovery</Text>
            <Badge color={discoveryStatus === "completed" ? "green" : discoveryStatus === "failed" ? "red" : "gray"}>
              {discoveryStatus.replaceAll("_", " ")}
            </Badge>
          </Group>
          {discoveryProcessed && discoveryProcessedAt && (
            <Text size="xs" c="dimmed">Last processed <span suppressHydrationWarning>{new Date(discoveryProcessedAt).toLocaleString()}</span></Text>
          )}
        </div>
        <Button leftSection={<IconSparkles size={16} />} loading={discovering} onClick={discoverWithAi}>
          Discover with AI
        </Button>
      </Group>
      {message && <Alert color={message.color} mb="lg" onClose={() => setMessage(null)} withCloseButton>{message.text}</Alert>}
      <GenerationProgressAlert
        active={discovering}
        message="Discovering characters, locations, themes, and motifs across the manuscript..."
        detail="a full book typically takes 1-2 minutes"
        estimatedSeconds={75}
      />
      <Tabs value={tab} onChange={setTab}>
      <Tabs.List mb="xl">
        <Tabs.Tab value="characters">Characters ({initialCharacters.length})</Tabs.Tab>
        <Tabs.Tab value="locations">Locations ({initialLocations.length})</Tabs.Tab>
        <Tabs.Tab value="themes">Themes ({initialThemes.length})</Tabs.Tab>
        <Tabs.Tab value="motifs">Motifs ({initialMotifs.length})</Tabs.Tab>
        <Tabs.Tab value="timeline">Timeline ({initialTimeline.length})</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="characters">
        <EntityList
          key={`characters-${initialCharacters.length}`}
          bookId={bookId}
          entityType="characters"
          initial={initialCharacters}
          seriesId={seriesId}
          sharedLinkIds={linksForType(sharedEntityLinkIds, "characters")}
          fields={[
            { key: "name", label: "Name", required: true },
            { key: "role", label: "Role / Function" },
            { key: "description", label: "Description", multiline: true },
            { key: "arc_notes", label: "Arc notes", multiline: true },
            { key: "voice_notes", label: "Voice / speech style", multiline: true },
            { key: "relationship_notes", label: "Relationships", multiline: true },
          ]}
          displayName={(item) => String(item.name || "Unnamed")}
          displaySub={(item) => String(item.role || "")}
        />
      </Tabs.Panel>

      <Tabs.Panel value="locations">
        <EntityList
          key={`locations-${initialLocations.length}`}
          bookId={bookId}
          entityType="locations"
          initial={initialLocations}
          seriesId={seriesId}
          sharedLinkIds={linksForType(sharedEntityLinkIds, "locations")}
          fields={[
            { key: "name", label: "Name", required: true },
            { key: "description", label: "Description", multiline: true },
          ]}
          displayName={(item) => String(item.name || "Unnamed")}
        />
      </Tabs.Panel>

      <Tabs.Panel value="themes">
        <EntityList
          key={`themes-${initialThemes.length}`}
          bookId={bookId}
          entityType="themes"
          initial={initialThemes}
          seriesId={seriesId}
          sharedLinkIds={linksForType(sharedEntityLinkIds, "themes")}
          fields={[
            { key: "name", label: "Theme", required: true },
            { key: "description", label: "Notes", multiline: true },
          ]}
          displayName={(item) => String(item.name || "Unnamed")}
        />
      </Tabs.Panel>

      <Tabs.Panel value="motifs">
        <EntityList
          key={`motifs-${initialMotifs.length}`}
          bookId={bookId}
          entityType="motifs"
          initial={initialMotifs}
          seriesId={seriesId}
          sharedLinkIds={linksForType(sharedEntityLinkIds, "motifs")}
          fields={[
            { key: "name", label: "Motif", required: true },
            { key: "description", label: "Description", multiline: true },
          ]}
          displayName={(item) => String(item.name || "Unnamed")}
        />
      </Tabs.Panel>

      <Tabs.Panel value="timeline">
        <EntityList
          key={`timeline-${initialTimeline.length}`}
          bookId={bookId}
          entityType="timeline"
          initial={initialTimeline}
          fields={[
            { key: "note", label: "Event / note", required: true, multiline: true },
            { key: "sequence_order", label: "Order (number)", type: "number" },
          ]}
          displayName={(item) => String(item.note || "").slice(0, 80)}
          chapters={chapters}
        />
      </Tabs.Panel>
      </Tabs>
    </>
  );
}
