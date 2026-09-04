"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Group, Menu, Modal, Stack, Text, TextInput } from "@mantine/core";
import { createClient } from "@/lib/supabase/client";
import { getBookAuthorDisplay } from "@/lib/books/status";

type Book = {
  id: string;
  title: string;
  author_name: string | null;
  genre: string | null;
  status: string | null;
  updated_at: string;
};

type FinishedExport = { exportId: string; format: string } | undefined;

const STATUS_STYLES: Record<"FINISHED" | "EXPORTED" | "DRAFT", string> = {
  FINISHED: "oklch(0.6 0.13 165)",
  EXPORTED: "oklch(0.6 0.1 250)",
  DRAFT: "oklch(0.65 0.13 70)",
};

function classifyStatus(status: string | null): "FINISHED" | "EXPORTED" | "DRAFT" {
  if (status === "finished") return "FINISHED";
  if (status === "exported") return "EXPORTED";
  return "DRAFT";
}

export function BookRow({ book, finishedExport }: { book: Book; finishedExport: FinishedExport }) {
  const router = useRouter();
  const [deleteOpened, setDeleteOpened] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const statusLabel = classifyStatus(book.status);
  const statusColor = STATUS_STYLES[statusLabel];
  const showPublishingLab = statusLabel === "FINISHED";
  const primaryLabel = finishedExport ? `Download ${finishedExport.format.toUpperCase()}` : "Continue Editing";
  const primaryHref = finishedExport ? `/api/books/${book.id}/exports/${finishedExport.exportId}/download` : `/books/${book.id}`;
  const canDelete = confirmation.trim() === book.title.trim();

  async function deleteBook() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("books").delete().eq("id", book.id);
      if (error) throw error;
      setDeleteOpened(false);
      setConfirmation("");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to delete book.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 4px", borderBottom: "1px solid oklch(0.93 0.003 90)", position: "relative" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: statusColor, width: 64, flexShrink: 0 }}>{statusLabel}</span>
      <span style={{ width: 6, alignSelf: "stretch", borderRadius: 3, background: statusColor, flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "oklch(0.2 0.005 90)" }}>{book.title}</span>
          <span style={{ fontSize: 11, color: "oklch(0.6 0.005 90)" }}>· {book.genre || "Manuscript"}</span>
        </div>
        <div style={{ fontSize: 13, color: "oklch(0.6 0.005 90)", marginTop: 3 }}>
          {getBookAuthorDisplay(book)} · Updated <span suppressHydrationWarning>{new Date(book.updated_at).toLocaleDateString()}</span>
        </div>
      </div>

      <Button
        component="a"
        href={primaryHref}
        {...(finishedExport ? { target: "_blank", rel: "noreferrer" } : {})}
        color="grape"
        style={{ width: 150, flexShrink: 0 }}
      >
        {primaryLabel}
      </Button>

      <Menu shadow="md" width={150} position="bottom-end">
        <Menu.Target>
          <Button variant="outline" color="dark" px={0} style={{ width: 34, height: 34, flexShrink: 0, fontSize: 16, fontWeight: 700 }}>
            ⋯
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {showPublishingLab && (
            <Menu.Item component="a" href={`/books/${book.id}/publishing-lab`}>
              Publishing Lab
            </Menu.Item>
          )}
          <Menu.Item color="red" onClick={() => setDeleteOpened(true)}>
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={deleteOpened} onClose={() => setDeleteOpened(false)} title="Delete book" centered>
        <Stack>
          <Text>
            This will permanently delete <strong>{book.title}</strong> and its chapters, scenes, paragraphs, Manuscript Blueprint,
            reports, and saved inputs.
          </Text>
          <Alert color="red">Original manuscript records for this book will be removed from the local database.</Alert>
          {deleteError && <Alert color="red">{deleteError}</Alert>}
          <TextInput
            label={`Type "${book.title}" to confirm`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="subtle" color="dark" onClick={() => setDeleteOpened(false)}>
              Cancel
            </Button>
            <Button color="red" loading={deleting} disabled={!canDelete} onClick={deleteBook}>
              Delete Book
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
