"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, Anchor, Badge, Button, Collapse, Group, Paper, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { fetchJson } from "@/lib/http/fetch-json";
import { StewardActionModal } from "@/components/steward/action-modal";

type Account = {
  id: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  bannedUntil: string | null;
  deletionStatus: "pending" | "ready_for_purge" | null;
  purgeAfter: string | null;
  platformRole: string | null;
  bookCount: number;
};

type PendingAction =
  | { type: "purge"; accountId: string; email: string | null }
  | { type: "startDeletion"; accountId: string; email: string | null }
  | { type: "forceDelete"; accountId: string; email: string | null }
  | { type: "toggleRole"; accountId: string; email: string | null; grant: boolean };

export function StewardAccountsClient({ initialAccounts, currentUserId }: { initialAccounts: Account[]; currentUserId: string }) {
  const [accounts, setAccounts] = useState<Account[]>(initialAccounts);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creating, setCreating] = useState(false);

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  async function load(query: string) {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson<{ accounts: Account[] }>(
        `/api/steward/accounts${query ? `?search=${encodeURIComponent(query)}` : ""}`,
        {},
        "Load accounts",
      );
      setAccounts(result.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load accounts.");
    } finally {
      setLoading(false);
    }
  }

  async function createAccount() {
    setCreating(true);
    setError("");
    setMessage("");
    try {
      await fetchJson(
        "/api/steward/accounts/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: newEmail, password: newPassword, displayName: newDisplayName || undefined }),
        },
        "Create account",
      );
      setMessage(`Account created for ${newEmail}.`);
      setNewEmail("");
      setNewPassword("");
      setNewDisplayName("");
      setShowCreate(false);
      await load(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create account.");
    } finally {
      setCreating(false);
    }
  }

  async function restore(accountId: string) {
    setActionLoading(accountId);
    setError("");
    setMessage("");
    try {
      await fetchJson(`/api/steward/accounts/${accountId}/restore`, { method: "POST" }, "Restore account");
      setMessage("Account restored — sign-in re-enabled.");
      await load(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore account.");
    } finally {
      setActionLoading(null);
    }
  }

  async function resetCredits(accountId: string) {
    setActionLoading(accountId);
    setError("");
    setMessage("");
    try {
      const result = await fetchJson<{ ok: boolean; balanceUsdMicros: number }>(
        `/api/steward/accounts/${accountId}/reset-credits`,
        { method: "POST" },
        "Reset AI credits",
      );
      setMessage(`AI credits reset to $${(result.balanceUsdMicros / 1_000_000).toFixed(2)}.`);
      await load(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset AI credits.");
    } finally {
      setActionLoading(null);
    }
  }

  async function extend(accountId: string) {
    setActionLoading(accountId);
    setError("");
    setMessage("");
    try {
      await fetchJson(
        `/api/steward/accounts/${accountId}/extend`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extendByDays: 14 }) },
        "Extend retention window",
      );
      setMessage("Retention window extended by 14 days.");
      await load(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to extend retention window.");
    } finally {
      setActionLoading(null);
    }
  }

  function closeModal() {
    setPendingAction(null);
    setModalError(null);
  }

  async function confirmPendingAction() {
    if (!pendingAction) return;
    setModalLoading(true);
    setModalError(null);
    setActionLoading(pendingAction.accountId);
    setError("");
    setMessage("");
    try {
      if (pendingAction.type === "purge") {
        await fetchJson(`/api/steward/accounts/${pendingAction.accountId}/purge`, { method: "POST" }, "Purge account");
        setMessage("Account permanently deleted.");
      } else if (pendingAction.type === "startDeletion") {
        await fetchJson(`/api/steward/accounts/${pendingAction.accountId}/delete`, { method: "POST" }, "Start account deletion");
        setMessage("Deletion started — sign-in blocked, recoverable for 30 days.");
      } else if (pendingAction.type === "forceDelete") {
        await fetchJson(`/api/steward/accounts/${pendingAction.accountId}/force-delete`, { method: "POST" }, "Force-delete account");
        setMessage("Account permanently deleted.");
      } else if (pendingAction.type === "toggleRole") {
        await fetchJson(
          `/api/steward/accounts/${pendingAction.accountId}/role`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platformRole: pendingAction.grant ? "steward" : null }) },
          "Change Steward role",
        );
        setMessage(pendingAction.grant ? "Steward access granted." : "Steward access revoked.");
      }
      setPendingAction(null);
      await load(search);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setModalLoading(false);
      setActionLoading(null);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group style={{ flex: 1 }}>
          <TextInput
            placeholder="Search by email"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void load(search); }}
            style={{ flex: 1 }}
          />
          <Button variant="light" color="grape" loading={loading} onClick={() => load(search)}>Search</Button>
        </Group>
        <Button variant="light" color="teal" onClick={() => setShowCreate((current) => !current)}>
          {showCreate ? "Cancel" : "Create account"}
        </Button>
      </Group>

      <Collapse expanded={showCreate}>
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <TextInput label="Email" value={newEmail} onChange={(event) => setNewEmail(event.currentTarget.value)} />
            <PasswordInput label="Password" description="At least 8 characters" value={newPassword} onChange={(event) => setNewPassword(event.currentTarget.value)} />
            <TextInput label="Display name (optional)" value={newDisplayName} onChange={(event) => setNewDisplayName(event.currentTarget.value)} />
            <Button color="teal" loading={creating} disabled={!newEmail || newPassword.length < 8} onClick={createAccount} style={{ alignSelf: "flex-start" }}>
              Create account
            </Button>
          </Stack>
        </Paper>
      </Collapse>

      {error && <Alert color="red">{error}</Alert>}
      {message && <Alert color="green">{message}</Alert>}

      {!loading && !accounts.length && <Text c="dimmed">No accounts found.</Text>}

      <Stack gap="xs">
        {accounts.map((account) => {
          const isSelf = account.id === currentUserId;
          return (
            <Paper key={account.id} withBorder radius="md" p="md">
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <div>
                  <Group gap="xs">
                    <Text fw={700}>{account.email || account.id}</Text>
                    {account.platformRole === "steward" && <Badge color="grape" variant="light">Steward</Badge>}
                    {account.bannedUntil && <Badge color="red" variant="light">Banned until {new Date(account.bannedUntil).toLocaleDateString()}</Badge>}
                    {account.deletionStatus === "pending" && <Badge color="yellow" variant="light">Pending deletion</Badge>}
                    {account.deletionStatus === "ready_for_purge" && <Badge color="red">Ready for purge</Badge>}
                  </Group>
                  <Text size="xs" c="dimmed">
                    Joined {account.createdAt ? new Date(account.createdAt).toLocaleDateString() : "unknown"}
                    {account.lastSignInAt ? ` · last sign-in ${new Date(account.lastSignInAt).toLocaleDateString()}` : ""}
                    {account.purgeAfter ? ` · purge scheduled ${new Date(account.purgeAfter).toLocaleDateString()}` : ""}
                    {" · "}
                    {account.bookCount > 0 ? (
                      <Anchor component={Link} href={`/steward/books?ownerId=${account.id}`} size="xs">
                        {account.bookCount} book{account.bookCount === 1 ? "" : "s"}
                      </Anchor>
                    ) : (
                      "0 books"
                    )}
                  </Text>
                </div>
                <Group gap="xs">
                  {account.deletionStatus && (
                    <>
                      <Button size="xs" color="teal" variant="light" loading={actionLoading === account.id} onClick={() => restore(account.id)}>
                        Restore
                      </Button>
                      <Button size="xs" color="dark" variant="light" loading={actionLoading === account.id} onClick={() => extend(account.id)}>
                        Extend 14 days
                      </Button>
                      {account.deletionStatus === "ready_for_purge" && (
                        <Button
                          size="xs"
                          color="red"
                          loading={actionLoading === account.id}
                          onClick={() => setPendingAction({ type: "purge", accountId: account.id, email: account.email })}
                        >
                          Purge now
                        </Button>
                      )}
                    </>
                  )}
                  {!account.deletionStatus && (
                    <Button
                      size="xs"
                      color="yellow"
                      variant="light"
                      loading={actionLoading === account.id}
                      onClick={() => setPendingAction({ type: "startDeletion", accountId: account.id, email: account.email })}
                    >
                      Start deletion
                    </Button>
                  )}
                  <Button
                    size="xs"
                    color="teal"
                    variant="light"
                    loading={actionLoading === account.id}
                    onClick={() => resetCredits(account.id)}
                  >
                    Reset AI credits
                  </Button>
                  {!isSelf && (
                    <Button
                      size="xs"
                      color="grape"
                      variant="light"
                      loading={actionLoading === account.id}
                      onClick={() => setPendingAction({ type: "toggleRole", accountId: account.id, email: account.email, grant: account.platformRole !== "steward" })}
                    >
                      {account.platformRole === "steward" ? "Revoke Steward" : "Grant Steward"}
                    </Button>
                  )}
                  {!isSelf && (
                    <Button
                      size="xs"
                      color="red"
                      variant="outline"
                      loading={actionLoading === account.id}
                      onClick={() => setPendingAction({ type: "forceDelete", accountId: account.id, email: account.email })}
                    >
                      Force delete
                    </Button>
                  )}
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>

      {pendingAction && (
        <StewardActionModal
          opened
          loading={modalLoading}
          error={modalError}
          onCancel={closeModal}
          onConfirm={confirmPendingAction}
          {...pendingActionModalProps(pendingAction)}
        />
      )}
    </Stack>
  );
}

function pendingActionModalProps(action: PendingAction): {
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor?: string;
  requireTypedConfirmation?: string;
} {
  const label = action.email || action.accountId;
  switch (action.type) {
    case "purge":
      return {
        title: "Purge account",
        message: `Permanently delete ${label} and everything they own? This cannot be undone.`,
        confirmLabel: "Purge now",
      };
    case "startDeletion":
      return {
        title: "Start account deletion",
        message: `Start the 30-day deletion process for ${label}? This blocks their sign-in immediately.`,
        confirmLabel: "Start deletion",
        confirmColor: "yellow",
      };
    case "forceDelete":
      return {
        title: "Force delete account",
        message: `This immediately and permanently deletes ${label} and everything they own, skipping the 30-day recovery window. This cannot be undone.`,
        confirmLabel: "Force delete",
        requireTypedConfirmation: "DELETE",
      };
    case "toggleRole":
      return {
        title: action.grant ? "Grant Steward access" : "Revoke Steward access",
        message: action.grant
          ? `Grant Steward access to ${label}? They will be able to view/manage any book and other accounts.`
          : `Revoke Steward access from ${label}?`,
        confirmLabel: action.grant ? "Grant access" : "Revoke access",
        confirmColor: "grape",
      };
  }
}
