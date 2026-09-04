"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { fetchJson } from "@/lib/http/fetch-json";
import { StewardActionModal } from "@/components/steward/action-modal";

type Book = {
  id: string;
  title: string;
  author_name: string | null;
  status: string | null;
  owner_id: string;
  ownerEmail: string | null;
  updated_at: string | null;
};

export function StewardBooksClient({
  initialBooks,
  initialOwnerId,
  initialOwnerEmail,
}: {
  initialBooks: Book[];
  initialOwnerId: string | null;
  initialOwnerEmail: string | null;
}) {
  const router = useRouter();
  const [books, setBooks] = useState<Book[]>(initialBooks);
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState(initialOwnerId);
  const [ownerEmail, setOwnerEmail] = useState(initialOwnerEmail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [transferTarget, setTransferTarget] = useState<Book | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  async function load(query: string, ownerFilter: string | null) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (query) params.set("search", query);
      if (ownerFilter) params.set("ownerId", ownerFilter);
      const result = await fetchJson<{ books: Book[] }>(
        `/api/steward/books${params.toString() ? `?${params.toString()}` : ""}`,
        {},
        "Load books",
      );
      setBooks(result.books);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load books.");
    } finally {
      setLoading(false);
    }
  }

  function clearOwnerFilter() {
    setOwnerId(null);
    setOwnerEmail(null);
    router.replace("/steward/books");
    void load(search, null);
  }

  function closeTransferModal() {
    setTransferTarget(null);
    setModalError(null);
  }

  async function confirmTransfer(newOwnerEmail: string) {
    if (!transferTarget) return;
    setModalLoading(true);
    setModalError(null);
    setError("");
    setMessage("");
    try {
      await fetchJson(
        `/api/steward/books/${transferTarget.id}/transfer`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newOwnerEmail }) },
        "Transfer book",
      );
      setMessage(`"${transferTarget.title}" transferred to ${newOwnerEmail}.`);
      setTransferTarget(null);
      await load(search, ownerId);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to transfer book.");
    } finally {
      setModalLoading(false);
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Opening a book here uses your Steward access to view/edit it like any admin-tier collaborator would — the same pages every owner uses.
      </Text>

      {ownerId && (
        <Alert color="grape" variant="light">
          <Group justify="space-between">
            <Text size="sm">Showing books owned by <strong>{ownerEmail || ownerId}</strong></Text>
            <Button size="xs" variant="subtle" color="dark" onClick={clearOwnerFilter}>Clear filter</Button>
          </Group>
        </Alert>
      )}

      <Group>
        <TextInput
          placeholder="Search by title"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void load(search, ownerId); }}
          style={{ flex: 1 }}
        />
        <Button variant="light" color="grape" loading={loading} onClick={() => load(search, ownerId)}>Search</Button>
      </Group>

      {error && <Alert color="red">{error}</Alert>}
      {message && <Alert color="green">{message}</Alert>}
      {!loading && !books.length && <Text c="dimmed">No books found.</Text>}

      <Stack gap="xs">
        {books.map((book) => (
          <Paper key={book.id} withBorder radius="md" p="md" component={Link} href={`/books/${book.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Group gap="xs">
                  <Text fw={700}>{book.title}</Text>
                  {book.status && <Badge color="grape" variant="light">{book.status}</Badge>}
                </Group>
                <Text size="xs" c="dimmed">
                  {book.author_name || "No author set"} · owner {book.ownerEmail || book.owner_id}
                  {book.updated_at ? (
                    <span suppressHydrationWarning> · updated {new Date(book.updated_at).toLocaleDateString()}</span>
                  ) : (
                    ""
                  )}
                </Text>
              </div>
              <Button
                size="xs"
                variant="light"
                color="dark"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setTransferTarget(book);
                }}
              >
                Transfer
              </Button>
            </Group>
          </Paper>
        ))}
      </Stack>

      {transferTarget && (
        <StewardActionModal
          opened
          title="Transfer book"
          message={`Transfer "${transferTarget.title}" to a different account.`}
          inputLabel="New owner's email"
          inputType="email"
          confirmLabel="Transfer"
          confirmColor="dark"
          loading={modalLoading}
          error={modalError}
          onCancel={closeTransferModal}
          onConfirm={confirmTransfer}
        />
      )}
    </Stack>
  );
}
