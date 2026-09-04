"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { fetchJson } from "@/lib/http/fetch-json";

type WorkflowNotification = {
  id: string;
  event_type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

export function WorkflowNotificationsPanel({
  bookId,
  notifications,
}: {
  bookId: string;
  notifications: WorkflowNotification[];
}) {
  const [items, setItems] = useState(notifications);
  const [loading, setLoading] = useState(false);
  const unreadIds = useMemo(() => items.filter((n) => !n.read_at).map((n) => n.id), [items]);

  async function markRead(notificationIds: string[]) {
    if (!notificationIds.length) return;
    setLoading(true);
    try {
      await fetchJson(
        `/api/books/${bookId}/notifications`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notificationIds }),
        },
        "Mark notifications read",
      );
      const now = new Date().toISOString();
      setItems((current) =>
        current.map((notification) =>
          notificationIds.includes(notification.id)
            ? {
                ...notification,
                read_at: notification.read_at || now,
              }
            : notification,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  if (!items.length) {
    return (
      <Paper withBorder radius="md" p="lg" bg="white" mt="xl">
        <Title order={3}>Workflow notifications</Title>
        <Text c="dimmed" size="sm" mt="xs">
          No collaborator workflow notifications yet.
        </Text>
      </Paper>
    );
  }

  return (
    <Paper withBorder radius="md" p="lg" bg="white" mt="xl">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Workflow notifications</Title>
          <Group>
            <Badge color="grape" variant="light">
              {unreadIds.length} unread
            </Badge>
            <Button
              size="xs"
              variant="light"
              color="dark"
              loading={loading}
              disabled={!unreadIds.length}
              onClick={() => markRead(unreadIds)}
            >
              Mark all read
            </Button>
          </Group>
        </Group>
        <Stack gap="xs">
          {items.map((notification) => (
            <Paper key={notification.id} withBorder radius="sm" p="sm" bg={notification.read_at ? "white" : "#fff8f3"}>
              <Group justify="space-between" align="flex-start">
                <div>
                  <Text fw={700}>{notification.title}</Text>
                  <Text size="sm" c="dimmed">
                    {notification.body}
                  </Text>
                </div>
                <Badge color={notification.read_at ? "gray" : "orange"} variant="light">
                  {notification.read_at ? "read" : "new"}
                </Badge>
              </Group>
              {!notification.read_at && (
                <Group mt="xs">
                  <Button size="xs" variant="subtle" color="dark" loading={loading} onClick={() => markRead([notification.id])}>
                    Mark read
                  </Button>
                </Group>
              )}
              <Text size="xs" c="dimmed" mt={6}>
                <span suppressHydrationWarning>{new Date(notification.created_at).toLocaleString()}</span>
              </Text>
            </Paper>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}
