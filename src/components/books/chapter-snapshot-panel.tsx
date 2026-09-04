"use client";

import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Alert, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { IconCamera, IconClockRecord, IconTrash } from "@tabler/icons-react";
import { fetchJson } from "@/lib/http/fetch-json";

type Snapshot = { id: string; chapter_id: string; name: string; created_at: string };
type ChapterOption = { id: string; chapter_number: number; title: string | null };

type Props = {
  bookId: string;
  chapters: ChapterOption[];
};

function labelForChapter(chapter: ChapterOption | undefined) {
  if (!chapter) return "";
  return `Ch. ${chapter.chapter_number}${chapter.title ? ` — ${chapter.title}` : ""}`;
}

export function ChapterSnapshotPanel({ bookId, chapters }: Props) {
  const [allSnapshots, setAllSnapshots] = useState<Snapshot[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(chapters[0]?.id ?? null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<Snapshot | null>(null);

  useEffect(() => {
    fetchJson<{ snapshots: Snapshot[] }>(`/api/books/${bookId}/snapshots`)
      .then((d) => setAllSnapshots(d.snapshots))
      .catch(() => {});
  }, [bookId]);

  const snapshots = useMemo(
    () => allSnapshots.filter((s) => s.chapter_id === selectedChapterId),
    [allSnapshots, selectedChapterId],
  );

  const chapterLabel = labelForChapter(chapters.find((c) => c.id === selectedChapterId));

  async function takeSnapshot() {
    if (!name.trim() || !selectedChapterId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<{ snapshot: Snapshot }>(`/api/books/${bookId}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterId: selectedChapterId, name: name.trim() }),
      });
      setAllSnapshots((prev) => [res.snapshot, ...prev]);
      setName("");
      setSuccess("Snapshot saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed.");
    } finally {
      setLoading(false);
    }
  }

  async function restore(snapshot: Snapshot) {
    setRestoring(snapshot.id);
    setError(null);
    try {
      const res = await fetchJson<{ restoredCount: number }>(`/api/books/${bookId}/snapshots/${snapshot.id}`, { method: "POST" });
      setSuccess(`Restored ${res.restoredCount} paragraphs from "${snapshot.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setRestoring(null);
      setConfirmRestore(null);
    }
  }

  async function remove(snapshotId: string) {
    setRestoring(snapshotId);
    try {
      await fetchJson(`/api/books/${bookId}/snapshots/${snapshotId}`, { method: "DELETE" });
      setAllSnapshots((prev) => prev.filter((s) => s.id !== snapshotId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setRestoring(null);
    }
  }

  if (!chapters.length) return null;

  return (
    <Paper withBorder radius="md" p="md" bg="#fafafa">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <div>
            <Title order={5}>Chapter Snapshots</Title>
            <Text size="xs" c="dimmed">Checkpoint the current accepted text before a major rewrite. Restore in one click if things go wrong.</Text>
          </div>
          <Select
            label="Chapter"
            value={selectedChapterId}
            onChange={setSelectedChapterId}
            allowDeselect={false}
            data={chapters.map((c) => ({ value: c.id, label: labelForChapter(c) }))}
            size="sm"
            w={260}
          />
        </Group>

        <Group gap="xs" align="flex-end">
          <TextInput
            placeholder="Snapshot name (e.g. before-humanize-pass)"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            size="sm"
            style={{ flex: 1 }}
          />
          <Button
            size="sm"
            color="grape"
            leftSection={<IconCamera size={14} />}
            loading={loading}
            disabled={!name.trim()}
            onClick={takeSnapshot}
          >
            Save snapshot
          </Button>
        </Group>

        {error && <Alert color="red" variant="light" onClose={() => setError(null)} withCloseButton>{error}</Alert>}
        {success && <Alert color="teal" variant="light" onClose={() => setSuccess(null)} withCloseButton>{success}</Alert>}

        {snapshots.length === 0 && <Text size="sm" c="dimmed">No snapshots yet for {chapterLabel || "this chapter"}.</Text>}

        {snapshots.map((s) => (
          <Paper key={s.id} withBorder radius="sm" p="sm">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="sm" fw={500}>{s.name}</Text>
                <Badge size="xs" variant="light" color="gray">
                  <span suppressHydrationWarning>{new Date(s.created_at).toLocaleString()}</span>
                </Badge>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  variant="light"
                  color="orange"
                  leftSection={<IconClockRecord size={13} />}
                  loading={restoring === s.id}
                  onClick={() => setConfirmRestore(s)}
                >
                  Restore
                </Button>
                <ActionIcon size="sm" variant="subtle" color="red" loading={restoring === s.id} onClick={() => remove(s.id)}>
                  <IconTrash size={13} />
                </ActionIcon>
              </Group>
            </Group>
          </Paper>
        ))}
      </Stack>

      <Modal opened={Boolean(confirmRestore)} onClose={() => setConfirmRestore(null)} title="Restore snapshot" centered>
        <Stack gap="md">
          <Text size="sm">
            Restore &ldquo;{confirmRestore?.name}&rdquo;? This will overwrite accepted text for all paragraphs in {chapterLabel}.
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setConfirmRestore(null)}>
              Cancel
            </Button>
            <Button
              color="orange"
              loading={Boolean(confirmRestore && restoring === confirmRestore.id)}
              onClick={() => confirmRestore && restore(confirmRestore)}
            >
              Restore
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
