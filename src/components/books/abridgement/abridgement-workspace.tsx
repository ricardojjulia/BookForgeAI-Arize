"use client";

import { useState } from "react";
import { Alert, Badge, Button, Group, NumberInput, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { GenerationProgressAlert } from "@/components/ai/generation-progress-alert";
import { fetchJson } from "@/lib/http/fetch-json";

type Plan = {
  id: string;
  target_reduction_percent: number;
  summary: string | null;
  created_at: string;
};

type Suggestion = {
  id: string;
  suggestion_type: string;
  title: string;
  rationale: string | null;
  estimated_word_savings: number | null;
  continuity_risk: string | null;
  status: string;
  chapters?: { chapter_number?: number | null; title?: string | null } | null;
  paragraphs?: { paragraph_number?: number | null } | null;
};

export function AbridgementWorkspace({ bookId, plan, suggestions }: { bookId: string; plan: Plan | null; suggestions: Suggestion[] }) {
  const router = useRouter();
  const [targetReduction, setTargetReduction] = useState<number | "">(25);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const approvedSavings = suggestions
    .filter((suggestion) => suggestion.status === "approved")
    .reduce((sum, suggestion) => sum + (suggestion.estimated_word_savings || 0), 0);

  async function generatePlan() {
    setLoading("plan");
    setMessage("");
    setError("");
    try {
      const result = await fetchJson<{ content?: { suggestions?: number } }>(
        `/api/books/${bookId}/abridgement/plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetReductionPercent: Number(targetReduction || 25) }),
        },
        "Generate abridgement plan",
      );
      setMessage(`Abridgement plan created with ${result.content?.suggestions || 0} suggestion(s).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate abridgement plan.");
    } finally {
      setLoading(null);
    }
  }

  async function updateSuggestion(id: string, status: "approved" | "rejected" | "pending") {
    setLoading(id);
    setError("");
    try {
      await fetchJson(
        `/api/abridgement/suggestions/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
        "Update abridgement suggestion",
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update suggestion.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <Stack>
      <Paper withBorder radius="md" p="xl" bg="white">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>Abridged Edition Plan</Title>
            <Text c="dimmed">
              Generate cut and merge suggestions. Nothing is removed unless you approve it, and approved cuts only affect abridged export mode.
            </Text>
          </div>
          <Badge color="grape" variant="light">
            Human approval required
          </Badge>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 3 }} mt="lg">
          <NumberInput
            label="Target reduction %"
            value={targetReduction}
            min={5}
            max={60}
            onChange={(value) => setTargetReduction(value === "" ? "" : Number(value || 25))}
          />
          <Paper withBorder radius="md" p="md" bg="#fbfaf8">
            <Text size="xs" c="dimmed">Latest plan</Text>
            <Text fw={900}>{plan ? `${plan.target_reduction_percent}% target` : "None yet"}</Text>
          </Paper>
          <Paper withBorder radius="md" p="md" bg="#fbfaf8">
            <Text size="xs" c="dimmed">Approved estimated savings</Text>
            <Text fw={900}><span suppressHydrationWarning>{approvedSavings.toLocaleString()}</span> words</Text>
          </Paper>
        </SimpleGrid>
        <Group mt="lg">
          <Button color="grape" loading={loading === "plan"} onClick={generatePlan}>
            Generate Abridgement Plan
          </Button>
        </Group>
        {message && <Alert color="green" mt="md">{message}</Alert>}
        {error && <Alert color="red" mt="md">{error}</Alert>}
        <GenerationProgressAlert
          active={loading === "plan"}
          message="Generating abridgement plan..."
          detail="typically takes 30-60 seconds"
          estimatedSeconds={40}
          color="grape"
        />
        {plan?.summary && <Alert color="blue" mt="md">{plan.summary}</Alert>}
      </Paper>

      <Paper withBorder radius="md" p="xl" bg="white">
        <Title order={2} mb="md">Suggestions</Title>
        {!suggestions.length ? (
          <Text c="dimmed">No abridgement suggestions yet.</Text>
        ) : (
          <Stack>
            {suggestions.map((suggestion) => (
              <Paper key={suggestion.id} withBorder radius="md" p="md" bg="#fbfaf8">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Group gap="xs">
                      <Badge color={typeColor(suggestion.suggestion_type)} variant="light">
                        {formatType(suggestion.suggestion_type)}
                      </Badge>
                      <Badge color={riskColor(suggestion.continuity_risk)} variant="light">
                        {suggestion.continuity_risk || "medium"} risk
                      </Badge>
                      <Badge color={statusColor(suggestion.status)}>
                        {suggestion.status}
                      </Badge>
                    </Group>
                    <Text fw={900} mt="xs">{suggestion.title}</Text>
                    <Text size="sm" c="dimmed">
                      Chapter {suggestion.chapters?.chapter_number || "?"}
                      {suggestion.paragraphs?.paragraph_number ? ` · paragraph ${suggestion.paragraphs.paragraph_number}` : ""}
                      {suggestion.estimated_word_savings ? ` · ~${suggestion.estimated_word_savings} words saved` : ""}
                    </Text>
                    {suggestion.rationale && <Text mt="xs">{suggestion.rationale}</Text>}
                  </div>
                  <Group>
                    <Button size="xs" color="green" variant="light" loading={loading === suggestion.id} onClick={() => updateSuggestion(suggestion.id, "approved")}>
                      Approve
                    </Button>
                    <Button size="xs" color="red" variant="light" loading={loading === suggestion.id} onClick={() => updateSuggestion(suggestion.id, "rejected")}>
                      Reject
                    </Button>
                    <Button size="xs" color="gray" variant="subtle" loading={loading === suggestion.id} onClick={() => updateSuggestion(suggestion.id, "pending")}>
                      Pending
                    </Button>
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

function formatType(type: string) {
  return type.replace(/_/g, " ");
}

function typeColor(type: string) {
  if (type.includes("cut")) return "red";
  if (type.includes("merge")) return "yellow";
  return "teal";
}

function riskColor(risk: string | null) {
  if (risk === "high") return "red";
  if (risk === "low") return "green";
  return "yellow";
}

function statusColor(status: string) {
  if (status === "approved") return "green";
  if (status === "rejected") return "red";
  return "gray";
}
