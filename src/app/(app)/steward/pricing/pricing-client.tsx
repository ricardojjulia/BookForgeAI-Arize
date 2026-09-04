"use client";

import { Badge, Group, Paper, Table, Text, Title } from "@mantine/core";
import type { StewardPricingAdjustment, StewardPricingTier } from "@/lib/subscription/pricing-overview";

function fmtUsdFromCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtUsdFromMicros(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function statusColor(status: string) {
  if (status === "applied") return "green";
  if (status === "blocked") return "red";
  if (status === "proposed") return "yellow";
  return "gray";
}

function fieldLabel(field: string) {
  if (field === "credit_cap") return "Credit cap";
  if (field === "model_allowlist") return "Model allowlist";
  if (field === "subscription_price") return "Subscription price";
  return field;
}

export function TiersTable({ tiers }: { tiers: StewardPricingTier[] }) {
  return (
    <Paper withBorder p="md">
      <Title order={3} mb="sm">
        Tiers
      </Title>
      {tiers.length === 0 ? (
        <Text c="dimmed" size="sm">No tiers configured.</Text>
      ) : (
        <Table.ScrollContainer minWidth={720}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tier</Table.Th>
                <Table.Th>Price / mo</Table.Th>
                <Table.Th>Credit cap</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Model allowlist</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tiers.map((tier) => (
                <Table.Tr key={tier.id}>
                  <Table.Td>{tier.displayName}</Table.Td>
                  <Table.Td>{fmtUsdFromCents(tier.monthlyPriceUsdCents)}</Table.Td>
                  <Table.Td>{fmtUsdFromMicros(tier.monthlyCreditCapUsdMicros)}</Table.Td>
                  <Table.Td>
                    <Badge color={tier.isActive ? "green" : "gray"} variant="light" size="sm">
                      {tier.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {tier.models.map((m) => (
                        <Badge key={`${m.model}-${m.task}`} variant="outline" size="xs" color="grape">
                          {m.model}
                          {m.task !== "*" ? ` (${m.task})` : ""}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Paper>
  );
}

export function AdjustmentLogTable({ adjustments }: { adjustments: StewardPricingAdjustment[] }) {
  return (
    <Paper withBorder p="md">
      <Title order={3} mb="sm">
        Margin-tuning adjustment log
      </Title>
      {adjustments.length === 0 ? (
        <Text c="dimmed" size="sm">No tuning runs recorded yet.</Text>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Tier</Table.Th>
                <Table.Th>Field</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Old → New</Table.Th>
                <Table.Th>Effective</Table.Th>
                <Table.Th>Trigger metric</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {adjustments.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <span suppressHydrationWarning>{new Date(row.createdAt).toLocaleString()}</span>
                  </Table.Td>
                  <Table.Td>{row.tierId}</Table.Td>
                  <Table.Td>{fieldLabel(row.field)}</Table.Td>
                  <Table.Td>
                    <Badge color={statusColor(row.status)} variant="light" size="sm">
                      {row.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {row.oldValue ?? "—"} → {row.newValue ?? "—"}
                  </Table.Td>
                  <Table.Td>
                    <span suppressHydrationWarning>{new Date(row.effectiveAt).toLocaleString()}</span>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap", maxWidth: 320 }}>
                      {JSON.stringify(row.triggerMetric)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Paper>
  );
}
