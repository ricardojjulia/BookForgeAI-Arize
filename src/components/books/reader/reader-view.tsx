"use client";

import { useEffect, useState } from "react";
import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Textarea, Title, Tooltip } from "@mantine/core";
import { IconCheck, IconMessage, IconArrowsExchange, IconPencil } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { fetchJson } from "@/lib/http/fetch-json";
import { versionFromDate } from "@/lib/creativewriter-ui/dashboard";
import { createClient } from "@/lib/supabase/client";

type Chapter = { id: string; chapter_number: number; title: string | null };
type Paragraph = {
  id: string;
  chapter_id: string;
  paragraph_number: number;
  original_text: string | null;
  accepted_text: string | null;
  current_text: string | null;
  updated_at: string | null;
};
type Annotation = { id: string; paragraph_id: string | null; note: string; resolved: boolean; created_at: string };

type Props = {
  bookId: string;
  chapters: Chapter[];
  paragraphs: Paragraph[];
  initialAnnotations: Annotation[];
  /** Set (e.g. from a manuscript search result) to scroll to and briefly highlight a paragraph. */
  highlightParagraphId?: string | null;
  role: "owner" | "editor" | "admin" | "viewer";
};

function paragraphDomId(paragraphId: string) {
  return `paragraph-${paragraphId}`;
}

export function ReaderView({ bookId, chapters, paragraphs: initialParagraphs, initialAnnotations, highlightParagraphId, role }: Props) {
  const canEdit = role !== "viewer";
  const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations);
  const [paragraphs, setParagraphs] = useState<Paragraph[]>(initialParagraphs);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState<string | null>(null);
  const [comparing, setComparing] = useState<Record<string, boolean>>({});
  const [reverting, setReverting] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Imperative (not React state) because scrollIntoView is already
  // imperative here, and the highlight is a transient visual effect on the
  // DOM node itself rather than something any other render logic needs to
  // read.
  useEffect(() => {
    if (!highlightParagraphId) return;
    const el = document.getElementById(paragraphDomId(highlightParagraphId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.backgroundColor = "#fff3bf";
    const timeoutId = window.setTimeout(() => {
      el.style.backgroundColor = "";
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [highlightParagraphId]);

  async function preferOriginal(paragraphId: string) {
    setReverting(paragraphId);
    try {
      await fetchJson(`/api/paragraphs/${paragraphId}/prefer-original`, { method: "PATCH" });
      setParagraphs((prev) => prev.map((p) => (p.id === paragraphId ? { ...p, accepted_text: null } : p)));
      setComparing((prev) => { const next = { ...prev }; delete next[paragraphId]; return next; });
    } finally {
      setReverting(null);
    }
  }

  async function saveEdit(paragraphId: string) {
    const paragraph = paragraphs.find((p) => p.id === paragraphId);
    const draftText = editDrafts[paragraphId];
    if (!paragraph || draftText === undefined) return;
    setSaving(paragraphId);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        notifications.show({ color: "red", title: "Save failed", message: "Authentication required." });
        return;
      }
      const baseVersion = versionFromDate(paragraph.updated_at);
      // Event-handler-only tie-break suffix, never read during render.
      // eslint-disable-next-line react-hooks/purity
      const idSuffix = `${paragraphId}-${Date.now()}`;
      const result = await fetchJson<{
        content?: { conflicts?: unknown[] };
        error?: string;
      }>("/api/creativewriter/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: {
            localProjectId: `cloud-${bookId}`,
            accountId: user.id,
            bookforgeBookId: bookId,
            linkedAt: new Date().toISOString(),
          },
          changes: [
            {
              id: `reader-edit-${idSuffix}`,
              projectId: `cloud-${bookId}`,
              entityType: "paragraph",
              entityId: paragraphId,
              operation: "update",
              payload: { currentText: draftText },
              baseVersion,
              localVersion: baseVersion + 1,
              idempotencyKey: `reader-edit-${idSuffix}`,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      }, "Save paragraph edit");

      if (result.content?.conflicts?.length) {
        notifications.show({
          color: "yellow",
          title: "Cloud changed first",
          message: "This paragraph changed elsewhere since you started editing. Refresh to see the latest version.",
        });
        return;
      }

      const now = new Date().toISOString();
      setParagraphs((prev) => prev.map((p) => (p.id === paragraphId ? { ...p, current_text: draftText, updated_at: now } : p)));
      setEditDrafts((prev) => { const next = { ...prev }; delete next[paragraphId]; return next; });
      notifications.show({ color: "green", title: "Saved", message: "Paragraph updated." });
    } catch (error) {
      notifications.show({ color: "red", title: "Save failed", message: error instanceof Error ? error.message : "Unable to save edit." });
    } finally {
      setSaving(null);
    }
  }

  const byParagraph = annotations.reduce<Record<string, Annotation[]>>((acc, a) => {
    const key = a.paragraph_id || "general";
    acc[key] = [...(acc[key] || []), a];
    return acc;
  }, {});

  const paragraphsByChapter = paragraphs.reduce<Record<string, Paragraph[]>>((acc, p) => {
    acc[p.chapter_id] = [...(acc[p.chapter_id] || []), p];
    return acc;
  }, {});

  async function postAnnotation(paragraphId: string) {
    const note = drafts[paragraphId]?.trim();
    if (!note) return;
    setPosting(paragraphId);
    try {
      const res = await fetchJson<{ annotation: Annotation }>(`/api/books/${bookId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphId, note }),
      });
      setAnnotations((prev) => [res.annotation, ...prev]);
      setDrafts((prev) => { const next = { ...prev }; delete next[paragraphId]; return next; });
    } finally {
      setPosting(null);
    }
  }

  async function resolve(annotationId: string) {
    await fetchJson(`/api/books/${bookId}/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    setAnnotations((prev) => prev.map((a) => a.id === annotationId ? { ...a, resolved: true } : a));
  }

  return (
    <Stack gap="xl">
      {chapters.map((chapter) => (
        <Stack key={chapter.id} gap="md">
          <Title order={2} mt="xl">
            Chapter {chapter.chapter_number}{chapter.title ? `: ${chapter.title}` : ""}
          </Title>
          {(paragraphsByChapter[chapter.id] || []).map((para) => {
            const text = para.current_text || para.accepted_text || para.original_text || "";
            const paraAnnotations = byParagraph[para.id] || [];
            const isAnnotating = para.id in drafts;
            const isEditing = para.id in editDrafts;
            const hasAlternateVersion = Boolean(para.accepted_text && para.accepted_text !== para.original_text);
            const isComparing = Boolean(comparing[para.id]);
            return (
              <Stack
                key={para.id}
                id={paragraphDomId(para.id)}
                gap="xs"
                p="xs"
                style={{ borderRadius: 6, transition: "background-color 0.4s ease" }}
              >
                <Group align="flex-start" wrap="nowrap" gap="xs">
                  {isEditing ? (
                    <Textarea
                      style={{ flex: 1 }}
                      value={editDrafts[para.id]}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setEditDrafts((prev) => ({ ...prev, [para.id]: value }));
                      }}
                      autosize
                      minRows={2}
                      autoFocus
                    />
                  ) : (
                    <Text style={{ flex: 1, lineHeight: 1.8 }}>{text}</Text>
                  )}
                  {!isEditing && canEdit && (
                    <Tooltip label="Edit this paragraph" withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="dark"
                        onClick={() => setEditDrafts((prev) => ({ ...prev, [para.id]: text }))}
                      >
                        <IconPencil size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {hasAlternateVersion && (
                    <Tooltip label={isComparing ? "Hide original" : "This paragraph was rewritten — compare with original"} withArrow>
                      <ActionIcon
                        size="sm"
                        variant={isComparing ? "filled" : "subtle"}
                        color="teal"
                        onClick={() => setComparing((prev) => ({ ...prev, [para.id]: !prev[para.id] }))}
                      >
                        <IconArrowsExchange size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip label={isAnnotating ? "Cancel note" : "Add a note on this paragraph"} withArrow>
                    <ActionIcon
                      size="sm"
                      variant={isAnnotating ? "filled" : "subtle"}
                      color="grape"
                      onClick={() => setDrafts((prev) =>
                        para.id in prev
                          ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== para.id))
                          : { ...prev, [para.id]: "" }
                      )}
                    >
                      <IconMessage size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>

                {isEditing && (
                  <Group gap="xs">
                    <Button
                      size="xs"
                      color="grape"
                      loading={saving === para.id}
                      onClick={() => saveEdit(para.id)}
                    >
                      Save
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      disabled={saving === para.id}
                      onClick={() => setEditDrafts((prev) => { const next = { ...prev }; delete next[para.id]; return next; })}
                    >
                      Cancel
                    </Button>
                  </Group>
                )}

                {isComparing && hasAlternateVersion && (
                  <Paper withBorder radius="sm" p="sm" bg="#f4faf9">
                    <Stack gap="xs">
                      <Badge size="xs" color="teal" variant="light" w="fit-content">
                        Original version
                      </Badge>
                      <Text size="sm" c="dimmed" style={{ lineHeight: 1.7 }}>
                        {para.original_text}
                      </Text>
                      {canEdit && (
                        <Button
                          size="xs"
                          variant="light"
                          color="teal"
                          loading={reverting === para.id}
                          onClick={() => preferOriginal(para.id)}
                        >
                          Prefer this version
                        </Button>
                      )}
                    </Stack>
                  </Paper>
                )}

                {isAnnotating && (
                  <Paper withBorder radius="sm" p="sm" bg="#f8f7ff">
                    <Stack gap="xs">
                      <Textarea
                        placeholder="Your note on this paragraph…"
                        value={drafts[para.id]}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          setDrafts((prev) => ({ ...prev, [para.id]: value }));
                        }}
                        autosize
                        minRows={2}
                        size="sm"
                      />
                      <Group gap="xs">
                        <Button size="xs" color="grape" loading={posting === para.id} onClick={() => postAnnotation(para.id)}>Add note</Button>
                        <Button size="xs" variant="subtle" color="gray" onClick={() => setDrafts((prev) => { const n = { ...prev }; delete n[para.id]; return n; })}>Cancel</Button>
                      </Group>
                    </Stack>
                  </Paper>
                )}

                {paraAnnotations.filter((a) => !a.resolved).map((a) => (
                  <Paper key={a.id} withBorder radius="sm" p="sm" bg="#fff9f0">
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Badge size="xs" color="orange" variant="light">Reader note</Badge>
                        <Text size="sm">{a.note}</Text>
                        <Text size="xs" c="dimmed"><span suppressHydrationWarning>{new Date(a.created_at).toLocaleString()}</span></Text>
                      </Stack>
                      {canEdit && (
                        <ActionIcon size="sm" variant="subtle" color="teal" onClick={() => resolve(a.id)} title="Mark resolved">
                          <IconCheck size={13} />
                        </ActionIcon>
                      )}
                    </Group>
                  </Paper>
                ))}
              </Stack>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}
